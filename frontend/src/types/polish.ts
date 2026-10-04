/**
 * 打磨推光（Polish）数据模型 —— 打磨工位底稿
 * 只管打磨推光记录与磨料目数；每条记录可「挂」在某个髹涂道次名下。
 * 打磨工位绝不回写 coats 表：已罩漆（已完成）的道次不会因补记而退回。
 */

/** 手法：水砂 / 推光 / 揩清 */
export type PolishMethod = 'water' | 'burnish' | 'wipe';

/** 登记来源：常规（当场登记）/ 事后补记（工位事后补录，可能已罩漆） */
export type PolishSource = 'regular' | 'late';

/** 挂名状态：已挂道次 / 待认领（挂不到可接收道次，由打磨工位单列） */
export type PolishClaimState = 'linked' | 'unclaimed';

export interface Polish {
  id: string;
  /** 所属胎体编号（打磨底稿只按胎体编号组织） */
  bodyId: string;
  /** 工位内部序号：同一胎体内按登记顺序自增，与道次无关 */
  seq: number;
  /**
   * 挂在哪个髹涂道次名下（道次归属）。
   * null = 待认领（补记时没有可接收的道次，由打磨工位单列）。
   */
  coatSeq: number | null;
  /** 磨料目数，如 400 / 800 / 1500 / 2000；数字越大越细 */
  grit: number;
  /** 手法 */
  method: PolishMethod;
  /** 耗时（分钟） */
  durationMin: number;
  /** 操作人 */
  operator: string;
  /** 登记来源：常规登记 / 事后补记 */
  source: PolishSource;
  /** 挂名状态：已挂道次 / 待认领 */
  claimState: PolishClaimState;
  createdAt: number;
  updatedAt: number;
}

export type PolishDraft = Omit<Polish, 'id' | 'seq' | 'createdAt' | 'updatedAt'>;

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

export const POLISH_SOURCE_LABEL: Record<PolishSource, string> = {
  regular: '常规登记',
  late: '事后补记',
};

export const POLISH_CLAIM_STATE_LABEL: Record<PolishClaimState, string> = {
  linked: '已挂道次',
  unclaimed: '待认领',
};

/** 标准目数序列：按道次生成打磨序列时使用 */
export const GRIT_SEQUENCE: readonly number[] = [320, 600, 1000, 1500, 2000];

/** 按道次序号给出建议目数 */
export function suggestGrit(coatSeq: number): number {
  const index = Math.min(Math.max(coatSeq, 1), GRIT_SEQUENCE.length) - 1;
  return GRIT_SEQUENCE[index] ?? 1000;
}

/**
 * 判断一条（拟登记的）打磨记录能否挂到某道次名下。
 * 只有处于「待打磨」的道次接收挂名；已罩漆（已完成）的道次不再退回。
 * 纯函数，不改任何一侧数据。
 */
export function canLinkCoatState(coatState: string | undefined): boolean {
  return coatState === 'toPolish';
}

/** 新建常规打磨底稿的空表单（挂名道次由调用方按当前待打磨道次补齐） */
export function createEmptyPolishDraft(
  bodyId: string,
  coatSeq: number | null,
  source: PolishSource = 'regular',
): PolishDraft {
  return {
    bodyId,
    coatSeq,
    grit: coatSeq === null ? GRIT_SEQUENCE[0] ?? 320 : suggestGrit(coatSeq),
    method: 'water',
    durationMin: 30,
    operator: '',
    source,
    claimState: coatSeq === null ? 'unclaimed' : 'linked',
  };
}
