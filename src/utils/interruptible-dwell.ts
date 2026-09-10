import { fetchCoordinator } from '../business/fetch-coordinator';

/**
 * 可中断停留：分片等待并检查「让位信号」。用于浏览类长任务（BrowseDynamic/BrowseHome/BrowseProfile）。
 *
 * 两类让位信号（互相独立）：
 * - `interruptRequested`：被动蹲饼触发补全，需要立即让位切到动态页；
 * - `stopRequested`：内核 `sim off` 请求停止模拟行为，持续式任务在检查点提前结束并收尾。
 *
 * 停留被拆成小分片（400ms），每片检查一次，被中断返回 false。
 *
 * @param ms 总停留时长（毫秒）
 * @returns false = 被中断（调用方应提前结束任务并收尾）；true = 正常停留完成
 */
export async function interruptibleDwell(ms: number): Promise<boolean> {
  const CHUNK = 400;
  let remain = ms;
  while (remain > 0) {
    if (shouldYield()) {
      return false;
    }
    const step = Math.min(CHUNK, remain);
    await new Promise((r) => setTimeout(r, step));
    remain -= step;
  }
  return !shouldYield();
}

/** 是否需要让位：蹲饼中断 或 内核停止请求 */
function shouldYield(): boolean {
  return fetchCoordinator.interruptRequested || fetchCoordinator.stopRequested;
}
