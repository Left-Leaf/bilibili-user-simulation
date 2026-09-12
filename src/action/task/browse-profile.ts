import { BaseTask, type TaskController } from './base';
import type { TaskContext } from '../execute/context';
import { MainState } from '../engine/state';
import { ScrollBehavior } from '../behavior';
import { MousePositionManager } from '../engine/mouse-position-manager';
import { HumanScroller } from '../engine/human-scroller';
import { DwellTimeSampler } from '../engine/dwell-time';
import { DEFAULT_BEHAVIOR_CONFIG } from '../engine/config';
import { isUserPageUrl } from '../../utils/bilibili-dom';

/** 浏览 UP 主页任务的输入（upName/uid 仅用于日志展示，浏览本身不依赖具体目标） */
export interface BrowseProfileInput {
  /** 目标 UP 的名字（可选，仅日志展示） */
  upName?: string;
  /** 目标 UP 的 UID（可选，仅日志展示） */
  uid?: string;
  /** 拟人滚动浏览的屏数（人格决定），默认 2 */
  browseDepth?: number;
}

/**
 * 浏览 UP 主页任务（持续性）：拟人滚动浏览**当前所在的** UP 主页。
 *
 * 与「打开 UP 主页」（OpenProfileTask，触发式）分离：
 * - 打开 UP 主页：找目标入口 → 点击 → 把 `context.page` 切到 UP 主页（一次性）
 * - 浏览 UP 主页：本任务，只在「已就位的用户页」上做停留与滚动
 *   （与 BrowseHome / BrowseDynamic 同构）
 *
 * - preCheck：当前页面必须是用户页（`space.bilibili.com`）；**不负责进入**
 * - execute：持续性任务 → 返回控制器；先停留（`user_profile` 采样时长）→
 *   按 `browseDepth` 滚动浏览 → 拟人回滚到顶部；落点 `MainState.USER_PROFILE`
 */
export class BrowseProfileTask extends BaseTask {
  constructor(private input: BrowseProfileInput = {}) {
    super('BrowseProfile');
  }

  /** preCheck：当前页面必须是用户页（UP 主页） */
  async preCheck(context: TaskContext): Promise<boolean> {
    const page = context.page;
    if (!page || !context.browser) {
      return false;
    }
    return isUserPageUrl(page.url());
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
    this.log('⚡ 收到中断（蹲饼让位 / 停止模拟），结束浏览 UP 主页');
  }

  /** 任务主体：只「做事 + 记录数据 + 声明落点」，不生成状态 */
  private async run(context: TaskContext, ctrl: TaskController): Promise<void> {
    const page = context.page!;

    try {
      // 先停留几秒（真人打开页面先看一眼再开始逛）；可被被动蹲饼中断
      this.log(`👀 浏览 UP 主页，先停留浏览 ${(2 + Math.random() * 3).toFixed(1)}s…`);
      const initialDwell =
        new DwellTimeSampler(DEFAULT_BEHAVIOR_CONFIG.behavior.dwellTime).sample('user_profile') + 1500 + Math.random() * 1500;
      if (!(await ctrl.dwell(initialDwell))) {
        this.finishWith(
          { success: true, data: { interrupted: true, upName: this.input.upName, uid: this.input.uid } },
          MainState.USER_PROFILE
        );
        return;
      }

      // 行为：拟人滚动浏览 UP 主页（滚动参数：左边缘安全鼠标位 + 一屏距离）
      const depth = this.input.browseDepth ?? 2;
      const { mousePos, distance } = await MousePositionManager.instance.browseScrollParams(page);
      for (let i = 0; i < depth; i++) {
        await new ScrollBehavior(mousePos, distance, undefined, () => ctrl.aborted).execute(context);
        const screenDwell = new DwellTimeSampler(DEFAULT_BEHAVIOR_CONFIG.behavior.dwellTime).sample('user_profile');
        if (!(await ctrl.dwell(screenDwell))) {
          this.finishWith(
            {
              success: true,
              data: { interrupted: true, upName: this.input.upName, uid: this.input.uid, browseDepth: depth },
            },
            MainState.USER_PROFILE
          );
          return;
        }
        // 屏间小停顿：用 ctrl.dwell（可中断）而非 SleepBehavior（不可中断窗口）
        if (i < depth - 1 && !(await ctrl.dwell(800 + Math.random() * 1000))) {
          this.finishWith(
            {
              success: true,
              data: { interrupted: true, upName: this.input.upName, uid: this.input.uid, browseDepth: depth },
            },
            MainState.USER_PROFILE
          );
          return;
        }
      }

      this.log(`🏠 浏览 UP 主页：${page.url().slice(0, 60)}（滚动 ${depth} 屏）`);

      // 拟人回滚到顶部（真人逛完 UP 主页会自然滚回顶部/初始位置）
      await new HumanScroller().scrollBackToTop(page, () => ctrl.aborted).catch(() => {});

      // 执行阶段结束：记录数据 + 声明落点（后一个状态由 onEnd 生成）
      this.finishWith(
        {
          success: true,
          data: { url: page.url(), upName: this.input.upName, uid: this.input.uid, browseDepth: depth },
        },
        MainState.USER_PROFILE
      );
    } catch (error) {
      this.finishWith({ success: false, error: `浏览 UP 主页失败: ${(error as Error).message}` });
    } finally {
      ctrl.finish(); // 任务主体结束 → 结束异步进程（执行器随后调用 ③ 结束处理）
    }
  }
}
