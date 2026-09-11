import { BaseTask, type TaskController, type TaskResult } from './base';
import type { TaskContext } from '../execute/context';
import { MainState } from '../engine/state';
import { CloseBrowserBehavior } from '../behavior';

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

  /**
   * ② 执行：持续性任务 → 返回控制器。
   * 异步进程只表示「是否结束」；数据结果与落点写入任务状态，由 ③ 结束函数（onEnd）读取并生成后一个状态。
   */
  async execute(context: TaskContext): Promise<TaskController> {
    const ctrl = this.createController(context);
    void this.run(context, ctrl);
    return ctrl;
  }

  /** 中断处理（由 controller.abort() 调用）：休息任务在此收尾（强制上线 / 停止模拟） */
  async onInterrupt(): Promise<void> {
    this.log('⚡ 收到中断（强制上线 / 停止模拟），结束休息并收尾');
  }

  /** 任务主体：只「做事 + 记录数据 + 声明落点」，不生成状态 */
  private async run(context: TaskContext, ctrl: TaskController): Promise<void> {
    const { durationMs } = this.input;
    const threshold = this.input.closeBrowserAfterMs ?? 10 * 60 * 1000; // 默认 10 分钟
    // 任务一开始就根据休息时长决定：长休息 = 关闭浏览器下线；短休息 = 停止活动（浏览器保持打开）
    const isLong = durationMs > threshold;
    // 标记「当前正在休息」：内核在开启蹲饼前会据此中断正在进行的**长休息**（见 kernel.startFetch）
    context.state.set('currentRest', { isLong, durationMs, startedAt: Date.now() });

    try {
      // 内核模式（context.state.preventBrowserClose=true）：内核没有「关浏览器 → 离线等待 → 重新上线」的编排，
      // 因此长休息降级为「停止活动」（浏览器保持打开），避免任务关掉浏览器后内核失去会话
      const keepBrowserOpen = context.state.get('preventBrowserClose') === true;

      // ===== 长休息：立即关闭浏览器下线（离线等待由 bilibili-user-simulation 用 durationMs 执行）=====
      if (isLong && !keepBrowserOpen) {
        this.log(
          `🍽️ 长休息：${(durationMs / 1000).toFixed(0)}s（判定用户离开，立即关闭浏览器下线，${(durationMs / 60000).toFixed(1)} 分钟后重新上线）`
        );
        const cb = await new CloseBrowserBehavior().execute(context);
        if (!cb.success) {
          throw new Error(cb.error);
        }
        this.finishWith(
          { success: true, data: { durationMs, closedBrowser: true, longRest: true, threshold } },
          MainState.BROWSER_CLOSED
        );
        return;
      }

      // ===== 短休息：停止活动（浏览器保持打开、上线继续），期间可被「强制上线」指令中断 =====
      this.log(
        `${isLong ? '🍽️ 长休息（内核模式：保持浏览器打开）' : '🍽️ 短休息'}：${(durationMs / 1000).toFixed(0)}s（停止活动）`
      );
      const FORCE_ONLINE_CHECK_MS = 5000; // 强制上线检查间隔（响应延迟 ≤5s）
      const totalSec = durationMs / 1000;
      let elapsed = 0;
      let nextPrintAt = 60 * 1000;
      while (elapsed < durationMs) {
        // 中断（内核 sim off 停止请求 / 开启蹲饼前中断长休息）：在此检查点收尾结束
        if (ctrl.aborted) {
          this.finishWith({ success: true, data: { durationMs, interrupted: true, closedBrowser: false, elapsed } });
          return;
        }
        // 强制上线：立即结束短休息、不关浏览器、继续上线
        if (context.state.get('forceOnline') === true) {
          context.state.set('forceOnline', false);
          this.log(`🚀 收到强制上线指令，提前结束休息（已休息 ${(elapsed / 1000).toFixed(0)}s），立即上线`);
          this.finishWith(
            { success: true, data: { durationMs, interrupted: true, closedBrowser: false, elapsed } },
            // 回首页继续：否则生成器内部状态会滞留在 BROWSER_CLOSED，导致任务流被判定「已下线」而结束
            MainState.HOME_FEED
          );
          return;
        }
        const step = Math.min(FORCE_ONLINE_CHECK_MS, durationMs - elapsed);
        // 分片等待：可被中断 / 可暂停
        if (!(await ctrl.dwell(step))) {
          this.finishWith({ success: true, data: { durationMs, interrupted: true, closedBrowser: false, elapsed } });
          return;
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
      // 执行阶段结束：记录数据（后一个状态沿用前一个）
      this.finishWith({ success: true, data: { durationMs, closedBrowser: false, longRest: false, threshold } });
    } catch (error) {
      this.finishWith({ success: false, error: `休息任务失败: ${(error as Error).message}`, data: { durationMs } });
    } finally {
      context.state.delete('currentRest'); // 休息结束：清除标记
      ctrl.finish(); // 任务主体结束 → 结束异步进程（执行器随后调用 ③ 结束处理）
    }
  }
}
