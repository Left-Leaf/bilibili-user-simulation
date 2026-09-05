import type { TaskContext } from '../execute/context';
import { fetchCoordinator, isSustainedTask } from '../../business/fetch-coordinator';

/** 行为执行结果 */
export interface BehaviorResult {
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

/**
 * 行为（Behavior）：模拟真人的基本动作单元（原子）。
 *
 * 与任务（Task）的划分：
 * - 行为 = 原子动作单元：一次只做一件事（移动鼠标 / 点击 / 滚动 / 停留 /
 *   观看 / 扫码 / 搜索 / 关闭标签页 / 关闭浏览器 ...）
 * - 任务 = 明确目的的行为集合：由 TaskExecutor 调度执行，内部组合多个行为达成目的
 *
 * 行为操作的对象是 TaskContext（内含 page / browser），与任务一致。
 */
export interface Behavior {
  readonly name: string;
  execute(context: TaskContext): Promise<BehaviorResult>;
}

/** 行为基类：提供 name 与结果构造辅助 */
export abstract class BaseBehavior implements Behavior {
  readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  abstract execute(context: TaskContext): Promise<BehaviorResult>;

  /**
   * 持续式任务（浏览/观看）执行页面操作前，若被动蹲饼正在暂停（蹲饼进行中）则等待其完成，
   * 避免与蹲饼的前台切换/点击/滚动并发（后台滚动不触发加载、后台点击不可靠、鼠标轨迹冲突）。
   * 触发式任务不受影响（蹲饼对触发式是「等待完成」，不会与它并发）。
   */
  protected async awaitReadyIfSustained(): Promise<void> {
    if (fetchCoordinator.paused && isSustainedTask(fetchCoordinator.currentTaskName)) {
      await fetchCoordinator.waitIfPaused();
    }
  }

  protected ok(data?: Record<string, unknown>): BehaviorResult {
    return { success: true, data };
  }

  protected fail(error: string): BehaviorResult {
    return { success: false, error };
  }

  protected sleep(ms: number): Promise<void> {
    // 真实等待（无时间加速）
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
