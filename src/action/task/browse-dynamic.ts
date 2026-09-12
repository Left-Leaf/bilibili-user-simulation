import { BaseTask, type TaskController, type TaskResult } from './base';
import type { TaskContext } from '../execute/context';
import { MainState } from '../engine/state';
import { ScrollBehavior } from '../behavior';
import { MousePositionManager } from '../engine/mouse-position-manager';
import { HumanScroller } from '../engine/human-scroller';
import { DwellTimeSampler } from '../engine/dwell-time';
import { DEFAULT_BEHAVIOR_CONFIG } from '../engine/config';
import { extractLoginUser, isDynamicPageUrl } from '../../utils/bilibili-dom';

/** 浏览动态页任务的输入：由人格（决策层）在执行时提供 */
export interface BrowseDynamicInput {
  /** 拟人滚动浏览的屏数（人格决定），默认 2 */
  browseDepth?: number;
}

/**
 * 浏览动态页任务（持续性）：拟人滚动浏览**当前所在的**动态页。
 *
 * 与「打开动态页」（OpenDynamicTask，触发式）分离：
 * - 打开动态页：找入口 → 点击 → 把 `context.page` 切到动态页（一次性）
 * - 浏览动态页：本任务，只在「已就位的动态页」上做停留与滚动，流程与 BrowseHome / BrowseProfile 同构
 *
 * - preCheck：当前页面必须是动态页（t.bilibili.com）；**不负责进入**
 * - execute：持续性任务 → 返回控制器；先停留看一眼（不超过 ~4.5s），
 *   再按 `browseDepth` 滚动浏览，最后拟人回滚到顶部；落点 `MainState.DYNAMIC_FEED`
 */
export class BrowseDynamicTask extends BaseTask {
  constructor(private input: BrowseDynamicInput = {}) {
    super('BrowseDynamic');
  }

  /** preCheck：当前页面必须是动态页 */
  async preCheck(context: TaskContext): Promise<boolean> {
    const page = context.page;
    if (!page) {
      return false;
    }
    try {
      return isDynamicPageUrl(page.url());
    } catch {
      return false;
    }
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

  /** 中断处理（由 controller.abort() 调用） */
  async onInterrupt(): Promise<void> {
    this.log('⚡ 收到中断（蹲饼让位 / 停止模拟），结束浏览动态页');
  }

  /** 任务主体：只「做事 + 记录数据 + 声明落点」，不生成状态 */
  private async run(context: TaskContext, ctrl: TaskController): Promise<void> {
    const page = context.page!;

    try {
      // 本次动态页浏览的总停留时长（任务一开始就确定，随日志打印）
      const totalDwellMs = new DwellTimeSampler(DEFAULT_BEHAVIOR_CONFIG.behavior.dwellTime).sample('dynamic_feed');
      this.log(`📄 浏览动态页 ${(totalDwellMs / 1000).toFixed(1)}s…`);

      // 进入后初看：用总停留的一部分（真人先看一眼再开始刷），不超过 ~4.5s
      const initialLookMs = Math.min(totalDwellMs * 0.35, 4500);
      this.log(`👀 先停留浏览 ${(initialLookMs / 1000).toFixed(1)}s…`);
      if (!(await ctrl.dwell(initialLookMs))) {
        this.finishWith(
          { success: true, data: { url: page.url(), interrupted: true } },
          MainState.DYNAMIC_FEED
        );
        return;
      }

      // 行为：拟人滚动浏览动态流，剩余停留时长分摊到每屏（总时长 = 开始时确定的值）
      const depth = this.input.browseDepth ?? 2;
      const perScreenMs = Math.max(0, (totalDwellMs - initialLookMs) / depth);
      const { mousePos, distance } = await MousePositionManager.instance.browseScrollParams(page);
      for (let i = 0; i < depth; i++) {
        await new ScrollBehavior(mousePos, distance, undefined, () => ctrl.aborted).execute(context);
        this.log(`👀 停留浏览 ${(perScreenMs / 1000).toFixed(1)}s…`);
        if (!(await ctrl.dwell(perScreenMs))) {
          this.finishWith(
            { success: true, data: { url: page.url(), interrupted: true, browseDepth: depth } },
            MainState.DYNAMIC_FEED
          );
          return;
        }
        // 屏间小停顿：用 ctrl.dwell（可中断）而非 SleepBehavior（不可中断窗口）
        if (i < depth - 1 && !(await ctrl.dwell(800 + Math.random() * 1000))) {
          this.finishWith(
            { success: true, data: { url: page.url(), interrupted: true, browseDepth: depth } },
            MainState.DYNAMIC_FEED
          );
          return;
        }
      }

      // 日志：登录用户（动态列表不再打印，动态数据由被动蹲饼统一采集）
      const user = await extractLoginUser(page);
      this.log(user ? `👤 登录用户: ${user.name || '(无名)'} (uid ${user.uid || '?'})` : '👤 未检测到登录用户');
      this.log(`🕑 浏览动态页：滚动 ${depth} 屏（URL: ${page.url().slice(0, 60)}）`);

      // 拟人回滚到顶部（真人逛完动态会自然滚回顶部/初始位置）
      await new HumanScroller().scrollBackToTop(page, () => ctrl.aborted).catch(() => {});

      // 执行阶段结束：记录数据 + 声明落点（后一个状态由 onEnd 生成）
      this.finishWith(
        { success: true, data: { url: page.url(), browseDepth: depth } },
        MainState.DYNAMIC_FEED
      );
    } catch (error) {
      this.finishWith({ success: false, error: `浏览动态页失败: ${(error as Error).message}` });
    } finally {
      ctrl.finish(); // 任务主体结束 → 结束异步进程（执行器随后调用 ③ 结束处理）
    }
  }
}
