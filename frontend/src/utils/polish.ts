/**
 * 打磨 ↔ 髹涂 对牌工具（纯函数）
 * 两个工位各自留着底稿、互不改对方那份：
 * - 打磨工位管「打磨记录 + 目数」，记录挂到具体道次（coatId）名下；
 * - 髹涂工序台管「道次 + 漆种」，推道次前只读打磨记录对牌，绝不写对方的表。
 * 对不上（本道无记录 / 目数未比上一道更细）就停在待打磨；
 * 旧数据升级时按 bodyId+seq 补道次归属，补不上的单列待认领，且不回退已罩漆道次。
 */
import type { Coat } from '@/types/coat';
import { suggestGrit, type Polish } from '@/types/polish';

/**
 * 挂在道次名下的打磨记录：
 * 优先按 coatId 精确匹配；旧数据没有 coatId 时退回 bodyId+seq 匹配。
 */
export function findPolishForCoat(polishes: Polish[], coat: Coat): Polish | undefined {
  return (
    polishes.find((polish) => polish.coatId != null && polish.coatId === coat.id) ??
    polishes.find((polish) => polish.coatId == null && polish.bodyId === coat.bodyId && polish.seq === coat.seq)
  );
}

/** 上一道（seq-1）挂在名下的打磨记录；seq=1 无上一道 */
export function findPreviousPolish(polishes: Polish[], coats: Coat[], coat: Coat): Polish | undefined {
  if (coat.seq <= 1) return undefined;
  const previousCoat = coats.find((item) => item.bodyId === coat.bodyId && item.seq === coat.seq - 1);
  return previousCoat ? findPolishForCoat(polishes, previousCoat) : undefined;
}

export interface CoatGateResult {
  ok: boolean;
  /** 未通过原因（ok 为 true 时为空串） */
  reason: string;
  /** 挂在本道名下的打磨记录（可能为空） */
  polish: Polish | undefined;
  /** 上一道打磨记录（seq=1 或缺失时为空） */
  previousPolish: Polish | undefined;
}

/**
 * 髹涂工序台推道次前的对牌规则：
 * 1. 本道名下必须挂有打磨记录；
 * 2. 目数必须比上一道更细（seq=1 无上一道，免比）。
 * 对不上就停在待打磨，不得罩漆推进。
 */
export function evaluateCoatGate(coat: Coat, coats: Coat[], polishes: Polish[]): CoatGateResult {
  const polish = findPolishForCoat(polishes, coat);
  const previousPolish = findPreviousPolish(polishes, coats, coat);
  if (!polish) {
    return {
      ok: false,
      reason: `第 ${coat.seq} 道名下还没有打磨记录，不能罩漆`,
      polish: undefined,
      previousPolish,
    };
  }
  if (previousPolish && polish.grit <= previousPolish.grit) {
    return {
      ok: false,
      reason: `第 ${coat.seq} 道目数 ${polish.grit} 目未比上一道 ${previousPolish.grit} 目更细`,
      polish,
      previousPolish,
    };
  }
  return { ok: true, reason: '', polish, previousPolish };
}

/** 打磨记录是否已挂到某个道次名下（coatId 能落到本胎体某道，或旧数据 bodyId+seq 能对上） */
export function isPolishClaimed(polish: Polish, coats: Coat[]): boolean {
  if (polish.coatId != null) return coats.some((coat) => coat.id === polish.coatId);
  return coats.some((coat) => coat.bodyId === polish.bodyId && coat.seq === polish.seq);
}

/**
 * 事后补记 / 旧数据升级：给缺少 coatId 的记录按 bodyId+seq 补道次归属。
 * 只补打磨记录的归属，绝不回退道次状态（已罩过漆的道次不退回）；
 * 对不上的保持 coatId 为空，由工位单列待认领。
 */
export function attachCoatIdBySeq(polish: Polish, coats: Coat[]): Polish {
  if (polish.coatId != null) return polish;
  const match = coats.find((coat) => coat.bodyId === polish.bodyId && coat.seq === polish.seq);
  return match ? { ...polish, coatId: match.id } : polish;
}

/** 待认领：挂不到任何道次名下的打磨记录 */
export function selectUnclaimedPolishes(polishes: Polish[], coats: Coat[]): Polish[] {
  return polishes.filter((polish) => !isPolishClaimed(polish, coats));
}

/**
 * 为某道生成建议目数：不低于标准序列，且必须比上一道目数更细（至少细 200 目），
 * 保证「按道次生成序列」铺出来的目数序列逐道变细。
 */
export function suggestFinerGrit(coat: Coat, coats: Coat[], polishes: Polish[]): number {
  const base = suggestGrit(coat.seq);
  if (coat.seq <= 1) return base;
  const previousCoat = coats.find((item) => item.bodyId === coat.bodyId && item.seq === coat.seq - 1);
  if (!previousCoat) return base;
  const previousPolish = findPolishForCoat(polishes, previousCoat);
  if (!previousPolish) return base;
  return Math.max(base, previousPolish.grit + 200);
}
