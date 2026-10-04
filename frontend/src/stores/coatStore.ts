/**
 * 髹涂道次状态管理（Zustand）
 * 髹涂工序台的底稿：维护道次顺序与状态推进，支持拖拽重排落库重编号、批量改漆种与状态。
 * 与打磨工位（polishStore）各留各的底稿、互不改对方那份：
 * - 本 store 只写 coats 表，不碰 polishes；
 * - 推道次前只读打磨工位的记录对牌：本道名下必须挂有打磨记录，且目数比上一道更细，
 *   对不上就停在待打磨（toPolish），绝不罩漆推进。
 */
import { create } from 'zustand';
import { db, createId, withDbRetry } from '@/utils/db';
import { evaluateCoatGate } from '@/utils/polish';
import type { Coat, CoatDraft, CoatState, PaintType } from '@/types/coat';
import { nextCoatState } from '@/types/coat';
import { suggestIntervalHours, suggestPaintType } from '@/utils/humidity';
import { useBodyStore } from './bodyStore';
import { usePolishStore } from './polishStore';

export interface PaintSuggestion {
  paintType: PaintType;
  intervalHours: number;
  sourceCode: string;
  sourceColor: string;
}

/** 推道次结果：对牌未通过时 blocked=true 并给出停在待打磨的原因 */
export interface AdvanceResult {
  blocked: boolean;
  reason: string;
}

interface CoatStoreState {
  coats: Coat[];
  loading: boolean;
  ready: boolean;
  error: string;
  loadCoats: () => Promise<void>;
  coatsOfBody: (bodyId: string) => Coat[];
  createCoat: (draft: CoatDraft) => Promise<Coat>;
  updateCoat: (id: string, patch: Partial<Coat>) => Promise<void>;
  removeCoat: (id: string) => Promise<void>;
  batchUpdate: (ids: string[], patch: Partial<Coat>) => Promise<void>;
  advanceState: (id: string) => Promise<AdvanceResult>;
  markRecheck: (bodyId: string, recheck: boolean) => Promise<void>;
  reorderCoats: (bodyId: string, orderedIds: string[]) => Promise<void>;
  nextSeq: (bodyId: string) => number;
  /** 同器型自动带出上次漆种与间隔建议 */
  suggestForBody: (bodyId: string) => PaintSuggestion;
  /** 只读对牌：某道当前是否满足「已挂打磨记录且目数比上一道更细」 */
  coatGate: (coatId: string) => { ok: boolean; reason: string };
}

export const useCoatStore = create<CoatStoreState>((set, get) => ({
  coats: [],
  loading: false,
  ready: false,
  error: '',

  async loadCoats() {
    set({ loading: true });
    try {
      const coats = await db.coats.toArray();
      coats.sort((a, b) => (a.bodyId === b.bodyId ? a.seq - b.seq : a.bodyId.localeCompare(b.bodyId)));
      set({ coats, loading: false, ready: true, error: '' });
    } catch (error) {
      set({ loading: false, ready: true, error: error instanceof Error ? error.message : '道次读取失败' });
    }
  },

  coatsOfBody(bodyId) {
    return get()
      .coats.filter((coat) => coat.bodyId === bodyId)
      .sort((a, b) => a.seq - b.seq);
  },

  async createCoat(draft) {
    const now = Date.now();
    const row: Coat = { ...draft, id: createId('coat'), createdAt: now, updatedAt: now };
    // 髹涂工序台只写自己的底稿；失败只按本侧重试
    await withDbRetry(() => db.coats.put(row), 3, '道次写入');
    await get().loadCoats();
    return row;
  },

  async updateCoat(id, patch) {
    await withDbRetry(
      () => db.coats.update(id, { ...patch, updatedAt: Date.now() } as never),
      3,
      '道次更新',
    );
    await get().loadCoats();
  },

  async removeCoat(id) {
    const target = get().coats.find((coat) => coat.id === id);
    await withDbRetry(() => db.coats.delete(id), 3, '道次删除');
    if (target) {
      // 删除后按序重编号，保持 seq 连续
      const rest = get()
        .coats.filter((coat) => coat.bodyId === target.bodyId && coat.id !== id)
        .sort((a, b) => a.seq - b.seq)
        .map((coat, index) => ({ ...coat, seq: index + 1, updatedAt: Date.now() }));
      if (rest.length > 0) await withDbRetry(() => db.coats.bulkPut(rest), 3, '道次重编号');
    }
    await get().loadCoats();
  },

  async batchUpdate(ids, patch) {
    if (ids.length === 0) return;
    const now = Date.now();
    const rows = get()
      .coats.filter((coat) => ids.includes(coat.id))
      .map((coat) => ({ ...coat, ...patch, updatedAt: now }));
    await withDbRetry(() => db.coats.bulkPut(rows), 3, '道次批量更新');
    await get().loadCoats();
  },

  async advanceState(id) {
    const coat = get().coats.find((item) => item.id === id);
    if (!coat) return { blocked: true, reason: '未找到道次' };
    const next = nextCoatState(coat.state);
    if (next === coat.state) return { blocked: false, reason: '' };
    // 推到「已完成」前必须对上打磨工位的对牌：
    // 本道名下挂有打磨记录且目数比上一道更细，否则停在待打磨，不罩漆推进。
    if (next === 'done') {
      const gate = evaluateCoatGate(coat, get().coats, usePolishStore.getState().polishes);
      if (!gate.ok) {
        if (coat.state !== 'toPolish') {
          await get().updateCoat(id, { state: 'toPolish' });
        }
        return { blocked: true, reason: gate.reason };
      }
    }
    await get().updateCoat(id, { state: next });
    return { blocked: false, reason: '' };
  },

  async markRecheck(bodyId, recheck) {
    const affected = get().coats.filter((coat) => coat.bodyId === bodyId && coat.state !== 'done');
    if (affected.length === 0) return;
    const now = Date.now();
    await withDbRetry(
      () => db.coats.bulkPut(affected.map((coat) => ({ ...coat, needRecheck: recheck, updatedAt: now }))),
      3,
      '道次复检标记',
    );
    await get().loadCoats();
  },

  async reorderCoats(bodyId, orderedIds) {
    const indexOf = new Map(orderedIds.map((id, index) => [id, index]));
    const rows = get()
      .coats.filter((coat) => coat.bodyId === bodyId)
      .sort((a, b) => {
        const ai = indexOf.has(a.id) ? (indexOf.get(a.id) as number) : Number.MAX_SAFE_INTEGER;
        const bi = indexOf.has(b.id) ? (indexOf.get(b.id) as number) : Number.MAX_SAFE_INTEGER;
        return ai - bi;
      })
      .map((coat, index) => ({ ...coat, seq: index + 1, updatedAt: Date.now() }));
    await withDbRetry(() => db.coats.bulkPut(rows), 3, '道次重排');
    await get().loadCoats();
  },

  coatGate(coatId) {
    const coat = get().coats.find((item) => item.id === coatId);
    if (!coat) return { ok: false, reason: '未找到道次' };
    return evaluateCoatGate(coat, get().coats, usePolishStore.getState().polishes);
  },

  nextSeq(bodyId) {
    const list = get().coats.filter((coat) => coat.bodyId === bodyId);
    return list.length === 0 ? 1 : Math.max(...list.map((coat) => coat.seq)) + 1;
  },

  suggestForBody(bodyId) {
    const bodies = useBodyStore.getState().bodies;
    const current = bodies.find((body) => body.id === bodyId);
    const previousBody = bodies.find((body) => body.id !== bodyId && current !== undefined && body.shape === current.shape);
    const previousCoat = previousBody
      ? get()
          .coats.filter((coat) => coat.bodyId === previousBody.id)
          .sort((a, b) => a.seq - b.seq)
          .pop()
      : undefined;
    const paintType = suggestPaintType(get().nextSeq(bodyId), previousCoat?.paintType, current?.shape);
    return {
      paintType,
      intervalHours: suggestIntervalHours(paintType),
      sourceCode: previousBody?.code ?? '',
      sourceColor: previousCoat?.colorName ?? '',
    };
  },
}));

/** 道次派生选择器：按状态集合过滤 */
export function selectCoatsByStates(coats: Coat[], states: CoatState[]): Coat[] {
  if (states.length === 0) return coats;
  return coats.filter((coat) => states.includes(coat.state));
}
