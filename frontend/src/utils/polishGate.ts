/**
 * 髹涂工序台 —— 推道次前的打磨挂名校验（纯函数，只读）
 * 髹涂台把道次从「待打磨」推出（置为已完成、准备罩下一道）前，
 * 必须对得上挂在这道名下的打磨记录，且磨料目数要比上一道更细。
 * 对不上就停在「待打磨」。
 *
 * 该模块只读打磨工位底稿，绝不写 polishes 表。
 */
import type { Coat } from '@/types/coat';
import type { Polish } from '@/types/polish';

export type PolishGateReason =
  | 'ok'
  | 'not-to-polish'
  | 'no-polish'
  | 'no-previous-polish'
  | 'grit-not-finer';

export interface PolishGateResult {
  passed: boolean;
  reason: PolishGateReason;
  /** 给工序台看的话 */
  message: string;
  /** 本道挂名打磨记录（若有） */
  currentPolish?: Polish;
  /** 上一道挂名打磨记录（若有） */
  previousPolish?: Polish;
}

function fail(reason: PolishGateReason, message: string, extra?: Partial<PolishGateResult>): PolishGateResult {
  return { passed: false, reason, message, ...extra };
}

/**
 * 校验某道次能否从「待打磨」推出。
 * @param coat 待推进的道次
 * @param orderedCoats 同一胎体按 seq 升序的道次（用于找上一道）
 * @param polishes 打磨工位底稿（全部或该胎体范围均可）
 */
export function checkPolishGate(coat: Coat, orderedCoats: Coat[], polishes: Polish[]): PolishGateResult {
  if (coat.state !== 'toPolish') {
    return fail('not-to-polish', `第 ${coat.seq} 道不在「待打磨」，无需打磨核验`);
  }

  const linked = polishes.filter(
    (item) => item.bodyId === coat.bodyId && item.claimState === 'linked' && item.coatSeq === coat.seq,
  );
  // 一个道次名下可能有多条记录（逐次加细），取目数最高（最细）的一条做核验
  const current = linked.sort((a, b) => b.grit - a.grit)[0];
  if (!current) {
    return fail('no-polish', `第 ${coat.seq} 道名下没有挂名的打磨记录，停在待打磨`);
  }

  const previousCoat = orderedCoats.find((item) => item.seq === coat.seq - 1);
  if (previousCoat) {
    const previousLinked = polishes.filter(
      (item) =>
        item.bodyId === coat.bodyId && item.claimState === 'linked' && item.coatSeq === previousCoat.seq,
    );
    const previous = previousLinked.sort((a, b) => b.grit - a.grit)[0];
    if (!previous) {
      return fail('no-previous-polish', `第 ${previousCoat.seq} 道缺少挂名打磨记录，无法比对目数，停在待打磨`, {
        currentPolish: current,
      });
    }
    if (!(current.grit > previous.grit)) {
      return fail(
        'grit-not-finer',
        `第 ${coat.seq} 道目数 ${current.grit} 不比上一道 ${previous.grit} 更细，停在待打磨`,
        { currentPolish: current, previousPolish: previous },
      );
    }
    return { passed: true, reason: 'ok', message: `第 ${coat.seq} 道打磨核验通过（${previous.grit} → ${current.grit} 目）`, currentPolish: current, previousPolish: previous };
  }

  // 第一道：没有上一道可比，挂名记录存在即通过
  return { passed: true, reason: 'ok', message: `第 ${coat.seq} 道打磨核验通过（${current.grit} 目）`, currentPolish: current };
}
