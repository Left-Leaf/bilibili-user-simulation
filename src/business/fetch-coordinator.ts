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
 * - TaskExecutor：任务开始/结束更新 `currentTaskName`；持续性任务执行期间登记 `currentController`，结束后注销
 * - PersonaDrivenGenerator：next() 检查 `paused`（登录前暂停）+ `fetchCoordinator.paused`（蹲饼协调）→ 暂停时不生成新任务
 * - 行为层 awaitReadyIfSustained：持续式任务在暂停期间由任务自身等待
 * - 持续性任务（BrowseHome/BrowseProfile/BrowseDynamic/WatchVideo/Rest）：`execute()` 返回 TaskController，
 *   通过 `controller.dwell()/aborted` 实现可中断、可暂停的分片等待；被 `abortCurrentTask()` 中断时先走 `onInterrupt()`
 * - passive-fetch：`runFetchSession` 按 `currentTaskName` 分派处理策略，需要让位时 `abortCurrentTask()`
 */
import type { TaskController } from '../action/task/base';
export const fetchCoordinator = {
  /** 当前正在执行的任务名（executor 更新；'IDLE' 表示无任务执行中） */
  currentTaskName: 'IDLE' as string,
  /**
   * 当前**持续性任务**的控制器（executor 在持续性任务执行期间登记）；无则为 null。
   * 蹲饼让位 / 内核停止模拟均通过 `abortCurrentTask()` → `controller.abort()` 请求中断。
   */
  currentController: null as TaskController | null,
  /** 暂停标志：为 true 时生成器不再生成新任务（蹲饼监听 update 时设置） */
  paused: false,
  /**
   * 蹲饼开启期间置 true：任务生成侧据此把「长休息」权重置 0。
   * 长休息会关闭浏览器 / 长时间停止活动，会使蹲饼失效；由内核 startFetch()/stopFetch() 维护。
   */
  longRestDisabled: false,

  /** executor 每个任务边界调用：暂停期间阻塞，直到 resume */
  async waitIfPaused(): Promise<void> {
    while (fetchCoordinator.paused) {
      await new Promise((r) => setTimeout(r, 200));
    }
  },

  /** 暂停任务流（不再生成新任务） */
  pause(): void {
    fetchCoordinator.paused = true;
  },

  /** 恢复任务流 */
  resume(): void {
    fetchCoordinator.paused = false;
  },

  /**
   * 请求中断当前**持续性任务**（蹲饼让位 / 内核停止模拟）。
   * 本质：调用控制器 `abort()` → 任务的「中断处理」→ 结束异步进程。
   * 一次性短任务不可中断（等待其自然结束）。
   *
   * @returns 是否命中了可中断的持续性任务
   */
  async abortCurrentTask(): Promise<boolean> {
    const controller = fetchCoordinator.currentController;
    if (!controller) {
      return false;
    }
    await controller.abort();
    return true;
  },

  /** 开关「禁止长休息」（内核在蹲饼开启期间置 true，关闭后恢复） */
  setLongRestDisabled(disabled: boolean): void {
    fetchCoordinator.longRestDisabled = disabled;
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
