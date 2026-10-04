/**
 * 髹涂道次状态管理（Zustand）—— 髹涂工序台底稿
 * 维护道次顺序与状态推进，支持拖拽重排落库重编号、批量改漆种与状态。
 * 只写 coats 表（本侧写失败只按本侧重试）；推道次前只读打磨底稿做挂名/目数核验，
 * 绝不回写 polishes 表。核验不过则停在「待打磨」。
 */
import { create } from 'zustand';
import { db, createId } from '@/utils/db';
import { sideWriteWithRetry } from '@/utils/sideRetry';
import { checkPolishGate, type PolishGateResult } from '@/utils/polishGate';
import type { Coat, CoatDraft, CoatState, PaintType } from '@/types/coat';
import { nextCoatState } from '@/types/coat';
import { suggestIntervalHours, suggestPaintType } from '@/utils/humidity';
import type { Polish } from '@/types/polish';
import { useBodyStore } from './bodyStore';

const SIDE_LABEL = '髹涂工序台';

/** 推道次结果：passed=false 时表示停在原状态（待打磨） */
export type AdvanceOutcome =
  | { moved: true; from: CoatState; to: CoatState; message: string; gate?: PolishGateResult }
  | { moved: false; message: string; gate?: PolishGateResult };

export interface PaintSuggestion {
  paintType: PaintType;
  intervalHours: number;
  sourceCode: string;
  sourceColor: string;
}

export interface BatchAdvanceStat {
  updated: number;
  blocked: number;
  blockedMessages: string[];
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
  batchUpdate: (ids: string[], patch: Partial<Coat>) => Promise<BatchAdvanceStat>;
  /** 推道次：待打磨 → 已完成前对挂名打磨记录与目数，过不了停在待打磨 */
  advanceState: (id: string) => Promise<AdvanceOutcome>;
  markRecheck: (bodyId: string, recheck: boolean) => Promise<void>;
  reorderCoats: (bodyId: string, orderedIds: string[]) => Promise<void>;
  nextSeq: (bodyId: string) => number;
  /** 同器型自动带出上次漆种与间隔建议 */
  suggestForBody: (bodyId: string) => PaintSuggestion;
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
    await sideWriteWithRetry(SIDE_LABEL, () => db.coats.put(row));
    await get().loadCoats();
    return row;
  },

  async updateCoat(id, patch) {
    await sideWriteWithRetry(SIDE_LABEL, () =>
      db.coats.update(id, { ...patch, updatedAt: Date.now() } as never),
    );
    await get().loadCoats();
  },

  async removeCoat(id) {
    const target = get().coats.find((coat) => coat.id === id);
    await sideWriteWithRetry(SIDE_LABEL, async () => {
      await db.coats.delete(id);
      if (target) {
        // 删除后按序重编号，保持 seq 连续
        const rest = get()
          .coats.filter((coat) => coat.bodyId === target.bodyId && coat.id !== id)
          .sort((a, b) => a.seq - b.seq)
          .map((coat, index) => ({ ...coat, seq: index + 1, updatedAt: Date.now() }));
        if (rest.length > 0) await db.coats.bulkPut(rest);
      }
    });
    await get().loadCoats();
  },

  async batchUpdate(ids, patch) {
    const stat: BatchAdvanceStat = { updated: 0, blocked: 0, blockedMessages: [] };
    if (ids.length === 0) return stat;

    // 批量改状态到「已完成」同样要过打磨挂名/目数核验；处于待打磨却过不了的留在待打磨
    if (patch.state === 'done') {
      const polishes = await db.polishes.toArray();
      const now = Date.now();
      const allowed: Coat[] = [];
      get()
        .coats.filter((coat) => ids.includes(coat.id))
        .forEach((coat) => {
          if (coat.state === 'done') {
            allowed.push({ ...coat, ...patch, updatedAt: now });
            return;
          }
          if (coat.state === 'toPolish') {
            const gate = checkPolishGate(coat, get().coatsOfBody(coat.bodyId), polishes);
            if (!gate.passed) {
              stat.blocked += 1;
              stat.blockedMessages.push(gate.message);
              return;
            }
          }
          allowed.push({ ...coat, ...patch, updatedAt: now });
        });
      if (allowed.length > 0) {
        await sideWriteWithRetry(SIDE_LABEL, () => db.coats.bulkPut(allowed));
      }
      stat.updated = allowed.length;
      await get().loadCoats();
      return stat;
    }

    const now = Date.now();
    const rows = get()
      .coats.filter((coat) => ids.includes(coat.id))
      .map((coat) => ({ ...coat, ...patch, updatedAt: now }));
    await sideWriteWithRetry(SIDE_LABEL, () => db.coats.bulkPut(rows));
    stat.updated = rows.length;
    await get().loadCoats();
    return stat;
  },

  async advanceState(id) {
    const coat = get().coats.find((item) => item.id === id);
    if (!coat) return { moved: false, message: '未找到该道次' };
    const next = nextCoatState(coat.state);
    if (next === coat.state) return { moved: false, message: '该道次已是最终状态' };

    // 只在「待打磨 → 已完成」这一步对挂名打磨记录：目数必须比上一道更细
    if (coat.state === 'toPolish' && next === 'done') {
      const polishes: Polish[] = await db.polishes.toArray();
      const gate = checkPolishGate(coat, get().coatsOfBody(coat.bodyId), polishes);
      if (!gate.passed) {
        // 对不上就停在待打磨：本侧不写，更不动打磨底稿
        return { moved: false, message: gate.message, gate };
      }
      await get().updateCoat(id, { state: 'done' });
      return { moved: true, from: coat.state, to: 'done', message: gate.message, gate };
    }

    await get().updateCoat(id, { state: next });
    return { moved: true, from: coat.state, to: next, message: `第 ${coat.seq} 道已推进` };
  },

  async markRecheck(bodyId, recheck) {
    const affected = get().coats.filter((coat) => coat.bodyId === bodyId && coat.state !== 'done');
    if (affected.length === 0) return;
    const now = Date.now();
    await sideWriteWithRetry(SIDE_LABEL, () =>
      db.coats.bulkPut(affected.map((coat) => ({ ...coat, needRecheck: recheck, updatedAt: now }))),
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
    await sideWriteWithRetry(SIDE_LABEL, () => db.coats.bulkPut(rows));
    await get().loadCoats();
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
