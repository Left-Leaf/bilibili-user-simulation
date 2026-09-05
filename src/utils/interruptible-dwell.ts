import { fetchCoordinator } from '../business/fetch-coordinator';

/**
 * 可中断停留：分片等待并检查被动蹲饼的中断信号（interruptRequested）。
 * 用于浏览类长任务（BrowseDynamic/BrowseHome/BrowseProfile）——被动蹲饼触发补全时
 * 需要立即让位，把停留拆成小分片（400ms）每片检查一次，被中断返回 false。
 *
 * @param ms 总停留时长（毫秒）
 * @returns false = 被被动蹲饼中断（调用方应提前结束任务让位）；true = 正常停留完成
 */
export async function interruptibleDwell(ms: number): Promise<boolean> {
  const CHUNK = 400;
  let remain = ms;
  while (remain > 0) {
    if (fetchCoordinator.interruptRequested) {
      return false;
    }
    const step = Math.min(CHUNK, remain);
    await new Promise((r) => setTimeout(r, step));
    remain -= step;
  }
  return !fetchCoordinator.interruptRequested;
}
