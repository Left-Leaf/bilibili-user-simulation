import { BaseTask, type TaskController } from './base';
import type { TaskContext } from '../execute/context';
import { MainState } from '../engine/state';
import { ScrollBehavior, SleepBehavior, LeftClickBehavior } from '../behavior';
import { MousePositionManager } from '../engine/mouse-position-manager';
import { HumanScroller } from '../engine/human-scroller';
import { DwellTimeSampler } from '../engine/dwell-time';
import { DEFAULT_BEHAVIOR_CONFIG } from '../engine/config';
import { extractLoginUser, collectVideoEntries, isHomePageUrl } from '../../utils/bilibili-dom';

/** 一次刷新最多收集多少个视频（DOM 收集，不耗请求） */
const CANDIDATE_LIMIT = 40;

/** 刷新输出的单个视频条目（仅 DOM 轻量信息，不含分区/标签） */
export interface VideoItem {
  title: string;
  href: string;
  bvid: string;
  /** 播放时长（mm:ss，来自 .bili-video-card__stats__duration；直播卡片没有） */
  duration?: string;
  author: string;
  authorUid: string;
}

/** 刷首页推荐流任务的输入：由人格（决策层）在执行时提供 */
export interface BrowseHomeInput {
  /** 拟人滚动浏览的屏数（人格决定），默认 2 */
  browseDepth?: number;
}

/**
 * 刷首页推荐流任务（持续性）：在**当前所在的**主页上刷新并浏览推荐流。
 *
 * 与「打开主页」（OpenHomeTask，触发式）分离：
 * - 打开主页：复用/新开主页标签并把 `context.page` 切过去（一次性）
 * - 浏览主页：本任务，只在「已就位的主页」上刷新与滚动，与 BrowseDynamic / BrowseProfile 同构
 *
 * - preCheck：当前页面必须是主页（`bilibili.com` 根路径）；**不负责进入**
 * - execute：持续性任务 → 返回控制器；点击「换一换」拉新推荐 → 先停留一眼 →
 *   按 `browseDepth` 滚动浏览 → 收集可见视频 → 拟人回滚到顶部；落点 `MainState.HOME_FEED`
 * - 结果 `data.videos` 交给任务生成器作为「当前状态」的一个环节，由生成器推演下一个任务
 */
export class BrowseHomeTask extends BaseTask {
  constructor(private input: BrowseHomeInput = {}) {
    super('BrowseHome');
  }

  /** preCheck：当前页面必须是主页 */
  async preCheck(context: TaskContext): Promise<boolean> {
    const page = context.page;
    if (!page || !context.browser) {
      return false;
    }
    return isHomePageUrl(page.url());
  }

  /**
   * ② 执行：持续性任务 → 返回控制器。
   * 异步进程只表示「是否结束」；数据结果与落点写入任务状态，由 ③ 结束函数（onEnd）读取并生成后一个状态。
   */
  async execute(context: TaskContext): Promise<TaskController> {
    const ctrl = this.createController(context);
    void this.run(context, ctrl); // 任务主体后台执行
    return ctrl;
  }

  /** 中断处理（由 controller.abort() 调用）：主体通过 `ctrl.dwell()===false` 感知并提前收尾 */
  async onInterrupt(): Promise<void> {
    this.log('⚡ 收到中断（蹲饼让位 / 停止模拟），结束浏览主页');
  }

  /** 任务主体：只「做事 + 记录数据 + 声明落点」，不生成状态 */
  private async run(context: TaskContext, ctrl: TaskController): Promise<void> {
    const page = context.page!;
    try {
      // 刷新 = 点击主页「换一换」按钮重新拉取推荐流（而非整页刷新）
      await this.clickRefreshButton(context);

      const depth = this.input.browseDepth ?? 2;

      // 先停留几秒（真人打开页面先看一眼再开始刷）；可被被动蹲饼中断
      this.log(`👀 浏览主页，先停留浏览 ${(2 + Math.random() * 3).toFixed(1)}s…`);
      const initialDwell =
        new DwellTimeSampler(DEFAULT_BEHAVIOR_CONFIG.behavior.dwellTime).sample('home_feed') + 1500 + Math.random() * 1500;
      if (!(await ctrl.dwell(initialDwell))) {
        this.finishWith({ success: true, data: { interrupted: true } }, MainState.HOME_FEED);
        return;
      }

      // 拟人滚动浏览推荐流（滚动参数：左边缘安全鼠标位 + 一屏距离，由管理器计算）
      const { mousePos, distance } = await MousePositionManager.instance.browseScrollParams(page);
      for (let i = 0; i < depth; i++) {
        await new ScrollBehavior(mousePos, distance, undefined, () => ctrl.aborted).execute(context);
        const screenDwell = new DwellTimeSampler(DEFAULT_BEHAVIOR_CONFIG.behavior.dwellTime).sample('home_feed');
        if (!(await ctrl.dwell(screenDwell))) {
          this.finishWith({ success: true, data: { interrupted: true, browseDepth: depth } }, MainState.HOME_FEED);
          return;
        }
        // 屏间小停顿：用 ctrl.dwell（可中断）而非 SleepBehavior（不可中断窗口）
        if (i < depth - 1 && !(await ctrl.dwell(800 + Math.random() * 1000))) {
          this.finishWith({ success: true, data: { interrupted: true, browseDepth: depth } }, MainState.HOME_FEED);
          return;
        }
      }

      // 收集可见视频（DOM）
      const videos = await this.collectVideos(page);

      // 日志：登录用户（视频列表不再打印）
      const user = await extractLoginUser(page);
      this.log(user ? `👤 登录用户: ${user.name || '(无名)'} (uid ${user.uid || '?'})` : '👤 未检测到登录用户');
      this.log(`✔ 刷首页推荐流完成（滚动 ${depth} 屏，收集 ${videos.length} 个视频）`);

      // 拟人回滚到顶部（真人刷完首页会自然滚回顶部/初始位置）
      await new HumanScroller().scrollBackToTop(page, () => ctrl.aborted).catch(() => {});

      // 执行阶段结束：记录数据 + 声明落点（后一个状态由 onEnd 生成）
      this.finishWith({ success: true, data: { videos, count: videos.length } }, MainState.HOME_FEED);
    } catch (error) {
      this.finishWith({ success: false, error: `Browse home failed: ${(error as Error).message}` });
    } finally {
      ctrl.finish(); // 任务主体结束 → 结束异步进程（执行器随后调用 ③ 结束处理）
    }
  }

  /**
   * 点击主页「换一换」刷新按钮，重新拉取推荐流。
   * 找不到按钮时直接进入浏览（仅滚动）。
   */
  private async clickRefreshButton(context: TaskContext): Promise<boolean> {
    const page = context.page;
    if (!page) {
      return false;
    }
    const refreshSelector = '.feed-roll-btn button, button.roll-btn, .roll-btn';
    const btn = await page.$(refreshSelector).catch(() => null);
    if (!btn) {
      console.log('   未找到主页刷新按钮，直接浏览');
      return false;
    }
    const resolved = await MousePositionManager.instance.resolveTarget(page, refreshSelector);
    if (!resolved.point && !resolved.alreadyClicked) {
      console.log('   未找到主页刷新按钮，直接浏览');
      return false;
    }
    if (!resolved.alreadyClicked) {
      const cl = await new LeftClickBehavior(resolved.point!).execute(context);
      if (!cl.success) {
        console.log('   点击主页刷新按钮失败');
        return false;
      }
    }
    console.log('   🔄 点击主页刷新按钮，拉取新推荐');
    await new SleepBehavior(1200 + Math.random() * 1500).execute(context);
    return true;
  }

  /** 从页面 DOM 收集可见的视频卡片（公共方法统一处理：按页面类型定位 + 排除直播/噪音） */
  private async collectVideos(page: NonNullable<TaskContext['page']>): Promise<VideoItem[]> {
    const entries = await collectVideoEntries(page, CANDIDATE_LIMIT);
    return entries.map((e) => ({
      title: e.title,
      href: e.href,
      bvid: e.bvid,
      duration: e.duration,
      author: e.author ?? '',
      authorUid: e.authorUid ?? '',
    }));
  }
}
