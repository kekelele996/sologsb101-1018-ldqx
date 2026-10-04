/**
 * 打磨工位状态管理（Zustand）
 * 打磨工位的底稿：只管「打磨推光记录 + 磨料目数」，记录挂到具体道次（coatId）名下。
 * 与髹涂工序台（coatStore）各留各的底稿、互不改对方那份：
 * - 本 store 只写 polishes 表，不碰 coats；
 * - 髹涂工序台推道次时只读本 store 的记录对牌。
 * 事后补记只补 coatId 归属（按 bodyId+seq），不回退已罩漆道次；补不上的单列待认领。
 */
import { create } from 'zustand';
import { db, createId, withDbRetry } from '@/utils/db';
import { attachCoatIdBySeq, selectUnclaimedPolishes } from '@/utils/polish';
import type { Coat } from '@/types/coat';
import type { Polish, PolishDraft } from '@/types/polish';
// 彻底不依赖 coatStore（连动态 import 也不写），避免形成 coatStore ↔ polishStore 循环依赖，
// 导致 zustand 类型推断退化为 any。需要道次数据时由调用方以参数传入（见 backfillCoatIds）。

interface BackfillResult {
  /** 补挂出道次归属的条数 */
  attached: number;
  /** 仍挂不上、待认领的条数 */
  unclaimed: number;
}

interface PolishStoreState {
  polishes: Polish[];
  loading: boolean;
  ready: boolean;
  error: string;
  loadPolishes: () => Promise<void>;
  polishesOfBody: (bodyId: string) => Polish[];
  createPolish: (draft: PolishDraft) => Promise<Polish>;
  updatePolish: (id: string, patch: Partial<Polish>) => Promise<void>;
  removePolish: (id: string) => Promise<void>;
  /** 事后补记：给缺少 coatId 的旧记录按 bodyId+seq 补道次归属，不回退道次状态 */
  backfillCoatIds: (coats: Coat[]) => Promise<BackfillResult>;
  /** 工位认领：把一条待认领记录挂到指定道次名下 */
  claimPolish: (polishId: string, coatId: string) => Promise<void>;
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
      polishes.sort((a, b) => (a.bodyId === b.bodyId ? a.seq - b.seq : a.bodyId.localeCompare(b.bodyId)));
      set({ polishes, loading: false, ready: true, error: '' });
    } catch (error) {
      set({ loading: false, ready: true, error: error instanceof Error ? error.message : '打磨记录读取失败' });
    }
  },

  polishesOfBody(bodyId) {
    return get()
      .polishes.filter((polish) => polish.bodyId === bodyId)
      .sort((a, b) => (a.seq === b.seq ? a.grit - b.grit : a.seq - b.seq));
  },

  async createPolish(draft) {
    const now = Date.now();
    const row: Polish = { ...draft, id: createId('polish'), createdAt: now, updatedAt: now };
    // 打磨工位只写自己的底稿；失败只按本侧重试
    await withDbRetry(() => db.polishes.put(row), 3, '打磨记录写入');
    await get().loadPolishes();
    return row;
  },

  async updatePolish(id, patch) {
    await withDbRetry(
      () => db.polishes.update(id, { ...patch, updatedAt: Date.now() } as never),
      3,
      '打磨记录更新',
    );
    await get().loadPolishes();
  },

  async removePolish(id) {
    await withDbRetry(() => db.polishes.delete(id), 3, '打磨记录删除');
    await get().loadPolishes();
  },

  async backfillCoatIds(coats) {
    // 道次由调用方传入（只读髹涂工序台底稿来对序号归属），绝不回写道次状态。
    const targets = get().polishes.filter((polish) => polish.coatId == null);
    if (targets.length === 0) return { attached: 0, unclaimed: 0 };
    const updated = targets.map((polish) => attachCoatIdBySeq(polish, coats));
    const attached = updated.filter((polish, index) => polish.coatId != null && targets[index]?.coatId == null).length;
    await withDbRetry(() => db.polishes.bulkPut(updated), 3, '打磨记录补记');
    await get().loadPolishes();
    const unclaimed = updated.filter((polish) => polish.coatId == null).length;
    return { attached, unclaimed };
  },

  async claimPolish(polishId, coatId) {
    await withDbRetry(
      () => db.polishes.update(polishId, { coatId, updatedAt: Date.now() } as never),
      3,
      '打磨记录认领',
    );
    await get().loadPolishes();
  },
}));

/** 待认领打磨记录：挂不到任何道次名下（供打磨工位单列） */
export function selectUnclaimed(polishes: Polish[], coats: Coat[]): Polish[] {
  return selectUnclaimedPolishes(polishes, coats);
}
