/**
 * 被动蹲饼与任务流之间的协调器（单例）。
 *
 * 蹲饼与模拟共用同一个浏览器，必须约定**页面独占权**。统一策略（按任务类别分派）：
 * 1. **触发式任务**（短、高度自闭）：等它**顺利完成**，再操作页面；
 * 2. **持续式任务**（长、过程不稳定）：请求**提前中止**（`abortCurrentTask()` → 任务在分片检查点收尾），
 *    等它结束后再操作页面；
 * 3. **浏览器独占型任务**（登录/登出流程）：不抢页面，蹲饼**放弃本次会话**（等下次 update）。
 *
 * 另外两点保障：
 * - **阻塞任务流**：会话期间 `pause()`，生成器不再生成新任务（`next()` 检查 `paused`）；
 * - **恢复模拟状态**：会话前后用 `snapshotSimulationState` 快照/恢复主操作页与前台
 *   （蹲饼会切前台、刷新、必要时关页重开，可能破坏模拟对页面的假设）。
 *
 * 集成点：
 * - TaskExecutor：任务开始/结束更新 `currentTaskName`；持续性任务执行期间登记 `currentController`，结束后注销
 * - PersonaDrivenGenerator：next() 检查 `paused`（登录前暂停）+ `fetchCoordinator.paused`（蹲饼协调）→ 暂停时不生成新任务
 * - 行为层 awaitReadyIfSustained：持续式任务在暂停期间由任务自身等待
 * - 持续性任务（BrowseHome/BrowseProfile/BrowseDynamic/WatchVideo/Rest）：`execute()` 返回 TaskController，
 *   通过 `controller.dwell()/aborted` 实现可中断、可暂停的分片等待；被 `abortCurrentTask()` 中断时先走 `onInterrupt()`
 * - 内核：注册 `snapshotSimulationState`（提供 ctx），使蹲饼会话结束后能恢复模拟状态
 * - passive-fetch：`acquirePageOwnership()` 统一按类别取得独占权，会话前后快照/恢复
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

  /**
   * 「僵尸主体」登记表：已**被强制结束**（未在宽限内收尾）的持续性任务控制器。
   *
   * 它们的 `done` 已 resolve（执行器已进入下一个任务），但**主体仍在后台跑**。
   * 这个集合存在的唯一目的：让「要动页面」的一方（页面清理 / 切换主操作页）
   * 知道页面还没安全 —— 主体真正退出后由 `trackZombieBody` 的监听自动注销。
   */
  zombieBodies: new Set<TaskController>(),

  /** 登记一个僵尸主体（executor 在发现主体未收尾时调用）；主体退出后自动注销 */
  trackZombieBody(controller: TaskController): void {
    fetchCoordinator.zombieBodies.add(controller);
    const drop = (): void => {
      fetchCoordinator.zombieBodies.delete(controller);
    };
    controller.bodyDone.then(drop).catch(drop);
  },

  /**
   * 等待所有僵尸主体真正退出（关页 / 换主操作页前调用）。
   * 主体退出后页面才能安全地被关闭或替换。
   *
   * @returns `true` = 已全部退出（页面安全）；`false` = 等待超时，仍有主体在跑
   */
  async waitZombieBodies(timeoutMs = 5000): Promise<boolean> {
    if (fetchCoordinator.zombieBodies.size === 0) {
      return true;
    }
    const bodies = [...fetchCoordinator.zombieBodies];
    const timeout = new Promise<boolean>((r) => {
      setTimeout(() => r(false), timeoutMs);
    });
    return Promise.race([Promise.all(bodies.map((c) => c.bodyDone)).then(() => true), timeout]);
  },

  /**
   * 模拟状态快照器（由内核注册，可选）。
   *
   * 蹲饼会话开始前调用一次拿到「恢复函数」，会话结束（含异常）后调用它，
   * 把浏览器恢复到模拟的状态（主操作页仍可用 + 前台切回主操作页 + 滚动位置还原）。
   * 未注册（无模拟运行 / 单独使用被动蹲饼）时不做恢复。
   */
  snapshotSimulationState: null as (() => Promise<() => Promise<void>>) | null,
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

/**
 * 触发式任务（短、高度自闭）：蹲饼**等它顺利完成**后再操作页面。
 * 仅作「已知短任务」的显式登记；判定以 SUSTAINED_TASKS / EXCLUSIVE_TASKS 为准，
 * 未登记在任何一个清单里的任务同样按「等待完成」处理（并告警）。
 */
export const TRIGGER_TASKS = new Set(['Like', 'Triple', 'Search', 'Follow', 'Comment', 'CloseVideo', 'OpenVideo', 'OpenDynamic', 'OpenHome', 'OpenProfile']);
/** 持续式任务（浏览/观看/休息长任务）：蹲饼请求**提前中止**，等它收尾后再操作页面 */
export const SUSTAINED_TASKS = new Set(['BrowseHome', 'BrowseDynamic', 'BrowseProfile', 'WatchVideo', 'Rest']);
/**
 * 浏览器独占型任务（登录/登出流程）：**不属于模拟任务流**，是内核直接经执行器 `runTask()` 调用的额外任务，
 * 最高优先级、强制中断其他任何操作。期间蹲饼不抢页面：已开始的会话立刻让出，新会话直接放弃（等下次 update）。
 */
export const EXCLUSIVE_TASKS = new Set(['Login', 'Logout']);

/** 判断某任务是否为持续式任务（浏览/观看长任务） */
export function isSustainedTask(task: string | undefined | null): boolean {
  return !!task && SUSTAINED_TASKS.has(task);
}
