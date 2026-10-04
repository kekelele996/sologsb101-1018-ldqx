/**
 * 打磨工位状态管理（Zustand）—— 打磨工位底稿
 * 只管打磨推光记录与磨料目数，只写 polishes 表；
 * 读 coats 仅用于判断记录能否挂到「待打磨」道次名下，绝不回写 coats。
 * 已罩漆（已完成）的道次不接收补记挂名；补不上的记录单列「待认领」。
 * 本侧写失败后由 sideWriteWithRetry 只按本侧重试。
 */
import { create } from 'zustand';
import { db, createId } from '@/utils/db';
import { sideWriteWithRetry } from '@/utils/sideRetry';
import type { Coat } from '@/types/coat';
import type { Polish, PolishClaimState, PolishDraft } from '@/types/polish';
import { canLinkCoatState } from '@/types/polish';
import { useCoatStore } from './coatStore';

const SIDE_LABEL = '打磨工位';

export interface ClaimDecision {
  claimState: PolishClaimState;
  /** 挂名被拒时的原因（待认领原因），已挂道次时为空串 */
  reason: string;
}

interface PolishStoreState {
  polishes: Polish[];
  loading: boolean;
  ready: boolean;
  error: string;
  loadPolishes: () => Promise<void>;
  polishesOfBody: (bodyId: string) => Polish[];
  /** 全部胎体里挂不上道次的记录，工位单列待认领 */
  unclaimed: () => Polish[];
  /** 某胎体的待认领记录 */
  unclaimedOfBody: (bodyId: string) => Polish[];
  nextPolishSeq: (bodyId: string) => number;
  /** 按胎体 + 目标道次判定挂名归属（纯读 coats） */
  classifyLink: (bodyId: string, coatSeq: number | null) => ClaimDecision;
  createPolish: (draft: PolishDraft) => Promise<Polish>;
  updatePolish: (id: string, patch: Partial<PolishDraft>) => Promise<void>;
  removePolish: (id: string) => Promise<void>;
  /** 待认领记录挂到某「待打磨」道次名下；只改打磨底稿 */
  claimPolish: (id: string, coatSeq: number) => Promise<void>;
  /** 为某胎体所有「待打磨且尚无挂名记录」的道次铺排打磨记录 */
  generateForBody: (bodyId: string) => Promise<{ created: number; skipped: number }>;
}

export const usePolishStore = create<PolishStoreState>((set, get) => ({
  polishes: [],
  loading: false,
  ready: false,
  error: '',

  async loadPolishes() {
    set({ loading: true });
    try {
      const polishes = await db.polishes.toArray();
      polishes.sort((a, b) =>
        a.bodyId === b.bodyId ? a.seq - b.seq : a.bodyId.localeCompare(b.bodyId),
      );
      set({ polishes, loading: false, ready: true, error: '' });
    } catch (error) {
      set({ loading: false, ready: true, error: error instanceof Error ? error.message : '打磨底稿读取失败' });
    }
  },

  polishesOfBody(bodyId) {
    return get()
      .polishes.filter((item) => item.bodyId === bodyId)
      .sort((a, b) => a.seq - b.seq);
  },

  unclaimed() {
    return get()
      .polishes.filter((item) => item.claimState === 'unclaimed')
      .sort((a, b) => a.updatedAt - b.updatedAt);
  },

  unclaimedOfBody(bodyId) {
    return get().unclaimed().filter((item) => item.bodyId === bodyId);
  },

  nextPolishSeq(bodyId) {
    const list = get().polishes.filter((item) => item.bodyId === bodyId);
    return list.length === 0 ? 1 : Math.max(...list.map((item) => item.seq)) + 1;
  },

  classifyLink(bodyId, coatSeq) {
    if (coatSeq === null) return { claimState: 'unclaimed', reason: '登记时未挂名道次' };
    const coat = useCoatStore
      .getState()
      .coats.find((item: Coat) => item.bodyId === bodyId && item.seq === coatSeq);
    if (!coat) return { claimState: 'unclaimed', reason: `没有第 ${coatSeq} 道道次` };
    if (coat.state === 'done') {
      return { claimState: 'unclaimed', reason: `第 ${coatSeq} 道已罩漆完成，不能退回补挂` };
    }
    if (!canLinkCoatState(coat.state)) {
      return { claimState: 'unclaimed', reason: `第 ${coatSeq} 道不在待打磨，暂不接收挂名` };
    }
    return { claimState: 'linked', reason: '' };
  },

  async createPolish(draft) {
    const decision = get().classifyLink(draft.bodyId, draft.coatSeq);
    const now = Date.now();
    const row: Polish = {
      ...draft,
      claimState: decision.claimState,
      seq: get().nextPolishSeq(draft.bodyId),
      id: createId('polish'),
      createdAt: now,
      updatedAt: now,
    };
    await sideWriteWithRetry(
      SIDE_LABEL,
      () => db.polishes.put(row),
    );
    await get().loadPolishes();
    return row;
  },

  async updatePolish(id, patch) {
    const existing = get().polishes.find((item) => item.id === id);
    if (!existing) return;
    const nextBodyId = patch.bodyId ?? existing.bodyId;
    const nextCoatSeq = patch.coatSeq !== undefined ? patch.coatSeq : existing.coatSeq;
    const decision = get().classifyLink(nextBodyId, nextCoatSeq);
    await sideWriteWithRetry(SIDE_LABEL, () =>
      db.polishes.update(id, {
        ...patch,
        claimState: decision.claimState,
        updatedAt: Date.now(),
      } as never),
    );
    await get().loadPolishes();
  },

  async removePolish(id) {
    // 删除打磨底稿绝不联动改动道次状态（不回退已罩漆的道次）
    await sideWriteWithRetry(SIDE_LABEL, () => db.polishes.delete(id));
    await get().loadPolishes();
  },

  async claimPolish(id, coatSeq) {
    const existing = get().polishes.find((item) => item.id === id);
    if (!existing) return;
    const decision = get().classifyLink(existing.bodyId, coatSeq);
    if (decision.claimState !== 'linked') {
      throw new Error(decision.reason || '该道次不接收挂名');
    }
    await sideWriteWithRetry(SIDE_LABEL, () =>
      db.polishes.update(id, { coatSeq, claimState: 'linked', updatedAt: Date.now() } as never),
    );
    await get().loadPolishes();
  },

  async generateForBody(bodyId) {
    const coats = useCoatStore
      .getState()
      .coats.filter((coat: Coat) => coat.bodyId === bodyId && coat.state === 'toPolish')
      .sort((a, b) => a.seq - b.seq);
    const existing = get().polishes.filter((item) => item.bodyId === bodyId && item.claimState === 'linked');
    let created = 0;
    let skipped = 0;
    const now = Date.now();
    const rows: Polish[] = [];
    let seq = get().nextPolishSeq(bodyId) - 1;
    coats.forEach((coat, index) => {
      if (existing.some((item) => item.coatSeq === coat.seq)) {
        skipped += 1;
        return;
      }
      seq += 1;
      created += 1;
      rows.push({
        id: createId('polish'),
        bodyId,
        seq,
        coatSeq: coat.seq,
        grit: [320, 600, 1000, 1500, 2000][Math.min(coat.seq - 1, 4)] ?? 1000,
        method: coat.seq >= 3 ? 'burnish' : 'water',
        durationMin: 30 + coat.seq * 5,
        operator: '',
        source: 'regular',
        claimState: 'linked',
        createdAt: now + index,
        updatedAt: now + index,
      });
    });
    if (rows.length > 0) {
      await sideWriteWithRetry(SIDE_LABEL, () => db.polishes.bulkPut(rows));
      await get().loadPolishes();
    }
    return { created, skipped };
  },
}));
