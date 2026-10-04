/**
 * 工位侧写入重试（sideRetry）
 * 打磨工位与髹涂工序台各自保留底稿、互不改对方那份。
 * 因此一次写入失败后，只允许针对「本侧自己的表」重试：
 * - 不跨表补偿（髹涂侧失败绝不回写/重试打磨表，反之亦然）；
 * - 不触碰对侧数据；
 * - 超过次数仍失败则把错误抛给调用方，由本侧界面提示重办。
 */

/** 默认重试次数（含首次共 3 次） */
const DEFAULT_RETRY_TIMES = 3;
/** 重试间隔基数（毫秒），逐次退避 */
const RETRY_BASE_DELAY_MS = 120;

export interface SideRetryOptions {
  /** 最大尝试次数（含首次），最小为 1 */
  times?: number;
  /** 重试前回调，可用于在界面上提示「本侧重试中」 */
  onRetry?: (attempt: number, error: unknown) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 仅对本侧写操作做有限次重试。
 * @param label 工位侧名称，仅用于错误文案（如「打磨工位」「髹涂工序台」）
 * @param task 本侧写入动作（只能写本侧表）
 */
export async function sideWriteWithRetry<T>(
  label: string,
  task: () => Promise<T>,
  options: SideRetryOptions = {},
): Promise<T> {
  const times = Math.max(options.times ?? DEFAULT_RETRY_TIMES, 1);
  let lastError: unknown;
  for (let attempt = 1; attempt <= times; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (attempt >= times) break;
      options.onRetry?.(attempt, error);
      await sleep(RETRY_BASE_DELAY_MS * attempt);
    }
  }
  const reason = lastError instanceof Error ? lastError.message : '本侧写入失败';
  throw new Error(`${label}写入失败，已按本侧重试 ${times} 次仍未成功：${reason}`);
}
