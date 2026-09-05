import { BaseTask, TaskResult } from './base';
import type { TaskContext } from '../execute/context';
import { MainState } from '../engine/state';
import { SleepBehavior, CloseBrowserBehavior } from '../behavior';

/** 休息/暂停任务的输入：由人格（决策层）在执行时提供 */
export interface RestTaskInput {
  /** 休息时长（毫秒），人格决定（如上厕所、喝水、吃饭） */
  durationMs: number;
  /**
   * 超过该时长判定「用户离开电脑」，视为长休息 → **任务一开始就立即关闭浏览器下线**
   * （默认 10 分钟）。例如：短休息（1-2 分钟）用户还在 → 不关；长休息（吃饭 30 分钟）→ 关浏览器。
   */
  closeBrowserAfterMs?: number;
}

/**
 * 休息任务：模拟用户在两次操作之间停止的时间（休息/吃饭/离开）。
 *
 * 任务**一开始**就根据休息时长决定类型：
 * - 长休息（durationMs > closeBrowserAfterMs）：判定用户离开 → **立即关闭浏览器下线**，
 *   返回 MainState.BROWSER_CLOSED（metadata.longRest=true）；离线等待由 bilibili-user-simulation
 *   用该任务 durationMs 执行，到点重开浏览器自动上线（期间蹲饼随之暂停）。
 * - 短休息（durationMs ≤ 阈值）：仅停止活动（浏览器保持打开、上线继续），
 *   期间可被「强制上线」指令提前结束。
 */
export class RestTask extends BaseTask {
  constructor(private input: RestTaskInput) {
    super('Rest');
  }

  /** 休息时长（毫秒）：供模拟层（sim:week）判断是否「长休息→下线」 */
  get restDurationMs(): number {
    return this.input.durationMs;
  }

  /** 长休息阈值（毫秒）：超过则判定用户离开并关闭浏览器 */
  get closeBrowserAfterMs(): number {
    return this.input.closeBrowserAfterMs ?? 10 * 60 * 1000;
  }

  /** preCheck：休息前浏览器需处于打开状态 */
  async preCheck(context: TaskContext): Promise<boolean> {
    return !!(context.browser && context.page);
  }

  async execute(context: TaskContext): Promise<TaskResult> {
    const { durationMs } = this.input;
    const threshold = this.input.closeBrowserAfterMs ?? 10 * 60 * 1000; // 默认 10 分钟

    try {
      // 任务一开始就根据休息时长决定：长休息 = 关闭浏览器下线；短休息 = 停止活动（浏览器保持打开）
      const isLong = durationMs > threshold;

      // ===== 长休息：立即关闭浏览器下线（离线等待由 bilibili-user-simulation 用 durationMs 执行）=====
      if (isLong) {
        this.log(
          `🍽️ 长休息：${(durationMs / 1000).toFixed(0)}s（判定用户离开，立即关闭浏览器下线，${(durationMs / 60000).toFixed(1)} 分钟后重新上线）`
        );
        const cb = await new CloseBrowserBehavior().execute(context);
        if (!cb.success) {
          throw new Error(cb.error);
        }
        return {
          success: true,
          data: { durationMs, closedBrowser: true, longRest: true, threshold },
          nextState: MainState.BROWSER_CLOSED,
        };
      }

      // ===== 短休息：停止活动（浏览器保持打开、上线继续），期间可被「强制上线」指令中断 =====
      this.log(`🍽️ 短休息：${(durationMs / 1000).toFixed(0)}s（停止活动，浏览器保持打开）`);
      const FORCE_ONLINE_CHECK_MS = 5000; // 强制上线检查间隔（响应延迟 ≤5s）
      const totalSec = durationMs / 1000;
      let elapsed = 0;
      let nextPrintAt = 60 * 1000;
      while (elapsed < durationMs) {
        // 强制上线：立即结束短休息、不关浏览器、继续上线
        if (context.state.get('forceOnline') === true) {
          context.state.set('forceOnline', false);
          this.log(`🚀 收到强制上线指令，提前结束短休息（已休息 ${(elapsed / 1000).toFixed(0)}s），立即上线`);
          return {
            success: true,
            data: { durationMs, interrupted: true, closedBrowser: false, elapsed },
          };
        }
        const step = Math.min(FORCE_ONLINE_CHECK_MS, durationMs - elapsed);
        const sl = await new SleepBehavior(step).execute(context);
        if (!sl.success) {
          throw new Error(sl.error);
        }
        elapsed += step;
        // 到达打印间隔才打印倒计时
        if (elapsed >= nextPrintAt || elapsed >= durationMs) {
          const remainSec = Math.max(0, (durationMs - elapsed) / 1000);
          this.log(
            `⏳ 短休息倒计时: 已休息 ${(elapsed / 1000).toFixed(0)}s / 共 ${totalSec.toFixed(0)}s（还剩 ${(remainSec / 60).toFixed(1)} 分钟）`
          );
          nextPrintAt += 60 * 1000;
        }
      }
      return {
        success: true,
        data: { durationMs, closedBrowser: false, longRest: false, threshold },
      };
    } catch (error) {
      return {
        success: false,
        error: `休息任务失败: ${(error as Error).message}`,
        data: { durationMs },
      };
    }
  }
}
