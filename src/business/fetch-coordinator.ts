/**
 * 被动蹲饼与任务流之间的协调器（单例）。
 *
 * 被动蹲饼（后台动态页监听）的写操作（点击「有新动态」按钮、滚动补全）需要与任务执行器协调：
 * - **当前任务感知**：需要知道「当前正在执行什么任务」，据此决定处理策略
 *   （BrowseDynamic→中断 + 前台操作；WatchVideo→后台点击 + 需补全时切前台；OpenVideo/CloseVideo→等任务完成再补全）
 * - **阻塞任务流**：被动蹲饼滚动补全期间暂停生成/执行下一个任务，避免任务切换页面/改标签干扰
 * - **中断当前任务**：BrowseDynamic 是长停留任务，触发蹲饼时直接打断
 *
 * 集成点：
 * - TaskExecutor：任务开始/结束更新 `currentTaskName`（执行器本身不判断暂停，只负责接收并执行）
 * - PersonaDrivenGenerator：next() 检查 `paused`（登录前暂停）+ `fetchCoordinator.paused`（蹲饼协调）→ 暂停时不生成新任务
 * - 行为层 awaitReadyIfSustained：持续式任务在暂停期间由任务自身等待（任务自身处理暂停）
 * - BrowseDynamicTask：停留循环检查 `interruptRequested`，被中断时提前结束
 * - passive-fetch：`runFetchSession` 按 `currentTaskName` 分派处理策略
 */
export const fetchCoordinator = {
  /** 当前正在执行的任务名（executor 更新；'IDLE' 表示无任务执行中） */
  currentTaskName: 'IDLE' as string,
  /** 暂停标志：为 true 时 executor 在任务边界等待，不生成/执行下一个任务（在监听 update 时设置，生成器不会再生成新任务） */
  paused: false,
  /** 中断当前任务请求（BrowseDynamic 停留循环检测到后提前结束） */
  interruptRequested: false,

  /** executor 每个任务边界调用：暂停期间阻塞，直到 resume */
  async waitIfPaused(): Promise<void> {
    while (fetchCoordinator.paused) {
      await new Promise((r) => setTimeout(r, 200));
    }
  },

  /** 暂停任务流（监听 update 时设置：executor 完成当前任务后不会生成新任务） */
  pause(): void {
    fetchCoordinator.paused = true;
  },

  /** 恢复任务流 */
  resume(): void {
    fetchCoordinator.paused = false;
  },

  /** 请求中断当前任务（BrowseDynamic 检测到后提前结束） */
  requestInterrupt(): void {
    fetchCoordinator.interruptRequested = true;
  },

  /** 清除中断请求 */
  clearInterrupt(): void {
    fetchCoordinator.interruptRequested = false;
  },
};

/** 触发式任务（短任务）：蹲饼/补全时等待其完成 */
export const TRIGGER_TASKS = new Set(['Like', 'Triple', 'Search', 'Follow', 'Comment', 'CloseVideo', 'OpenVideo']);
/** 持续式任务（浏览/观看/休息长任务，BrowseDynamic 单独处理）：蹲饼时暂停任务流即可，不等待完成 */
export const SUSTAINED_TASKS = new Set(['BrowseHome', 'BrowseProfile', 'WatchVideo', 'Rest']);

/** 判断某任务是否为持续式任务（浏览/观看长任务） */
export function isSustainedTask(task: string | undefined | null): boolean {
  return !!task && SUSTAINED_TASKS.has(task);
}
