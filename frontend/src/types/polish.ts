/**
 * 打磨推光（Polish）数据模型
 * 打磨工位的底稿：按「道次」登记磨料目数与手法时长，挂到具体道次（coatId）名下。
 * 髹涂工序台推道次前必须对上本道名下的打磨记录，且目数比上一道更细，否则停在待打磨。
 */

/** 手法：水砂 / 推光 / 揩清 */
export type PolishMethod = 'water' | 'burnish' | 'wipe';

export interface Polish {
  id: string;
  /** 所属胎体 id */
  bodyId: string;
  /**
   * 挂在名下的髹涂道次 id（打磨工位对牌用）。
   * 旧数据可能缺失，升级时按 bodyId+seq 补归属；补不上的保持空，由工位单列待认领。
   */
  coatId?: string | null;
  /** 关联的髹涂道次序号（旧数据的主要依据，升级后仍保留以便核对） */
  seq: number;
  /** 磨料目数，如 400 / 800 / 1500 / 2000 */
  grit: number;
  /** 手法 */
  method: PolishMethod;
  /** 耗时（分钟） */
  durationMin: number;
  /** 操作人 */
  operator: string;
  createdAt: number;
  updatedAt: number;
}

export type PolishDraft = Omit<Polish, 'id' | 'createdAt' | 'updatedAt'>;

export const POLISH_METHOD_LABEL: Record<PolishMethod, string> = {
  water: '水砂',
  burnish: '推光',
  wipe: '揩清',
};

export const POLISH_METHOD_COLOR: Record<PolishMethod, string> = {
  water: '#3a6ea5',
  burnish: '#c9963c',
  wipe: '#2f6f4f',
};

export const POLISH_METHOD_OPTIONS: ReadonlyArray<{ value: PolishMethod; label: string }> = [
  { value: 'water', label: '水砂' },
  { value: 'burnish', label: '推光' },
  { value: 'wipe', label: '揩清' },
];

/** 标准目数序列：按道次生成打磨序列时使用 */
export const GRIT_SEQUENCE: readonly number[] = [320, 600, 1000, 1500, 2000];

/** 按道次序号给出建议目数 */
export function suggestGrit(seq: number): number {
  const index = Math.min(Math.max(seq, 1), GRIT_SEQUENCE.length) - 1;
  return GRIT_SEQUENCE[index] ?? 1000;
}

/** 新建打磨记录草稿：必须挂到具体道次（coatId）名下，seq 由道次带出 */
export function createEmptyPolishDraft(bodyId: string, coatId: string, seq: number): PolishDraft {
  return {
    bodyId,
    coatId,
    seq,
    grit: suggestGrit(seq),
    method: 'water',
    durationMin: 30,
    operator: '',
  };
}
