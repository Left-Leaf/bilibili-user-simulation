import { BaseTask, TaskResult } from './base';
import type { TaskContext } from '../execute/context';
import { MainState } from '../engine/state';
import { ScrollBehavior, SleepBehavior, LeftClickBehavior } from '../behavior';
import { MousePositionManager } from '../engine/mouse-position-manager';
import { HumanScroller } from '../engine/human-scroller';
import { DwellTimeSampler } from '../engine/dwell-time';
import { DEFAULT_BEHAVIOR_CONFIG } from '../engine/config';
import { interruptibleDwell } from '../../utils/interruptible-dwell';
import { extractLoginUser, collectVideoEntries } from '../../utils/bilibili-dom';

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
 * 刷首页推荐流任务：单次刷新并输出推荐流中的视频列表。
 *
 * - preCheck：保证当前在主页。不在主页时优先切换到已打开的主页标签页，没有则新开并导航。
 * - execute：点击主页「换一换」刷新按钮（非整页刷新）→ 拟人滚动浏览 → 收集可见视频 → 输出 videos。
 * - 结果交给任务生成器作为「当前状态」的一个环节，由生成器推演下一个任务。
 */
export class BrowseHomeTask extends BaseTask {
  constructor(private input: BrowseHomeInput = {}) {
    super('BrowseHome');
  }

  private isHome(url: string): boolean {
    try {
      const u = new URL(url);
      if (!u.hostname.includes('bilibili.com')) {
        return false;
      }
      return u.pathname === '/' || u.pathname === '/index.html';
    } catch {
      return false;
    }
  }

  /** preCheck：保证当前在主页（切已有主页标签 / 新开并导航） */
  async preCheck(context: TaskContext): Promise<boolean> {
    const page = context.page;
    const browser = context.browser;
    if (!browser) {
      return false;
    }
    try {
      if (page && this.isHome(page.url())) {
        return true;
      }

      const pages = await browser.pages();
      const homePage = pages.find((p) => {
        try {
          return this.isHome(p.url());
        } catch {
          return false;
        }
      });
      if (homePage) {
        await homePage.bringToFront().catch(() => {});
        context.page = homePage;
        console.log('   📑 切换到已打开的主页标签');
        return true;
      }

      const newPage = await browser.newPage();
      await newPage.goto('https://www.bilibili.com', { waitUntil: 'networkidle2' });
      context.page = newPage;
      console.log('   🆕 新开标签页打开主页');
      return true;
    } catch (error) {
      console.error(`[BrowseHome] preCheck 失败: ${(error as Error).message}`);
      return false;
    }
  }

  async execute(context: TaskContext): Promise<TaskResult> {
    const page = context.page!;
    try {
      // 刷新 = 点击主页「换一换」按钮重新拉取推荐流（而非整页刷新）
      await this.clickRefreshButton(context);

      const depth = this.input.browseDepth ?? 2;

      // 进入主页后先停留几秒（真人打开页面先看一眼再开始刷）；可被被动蹲饼中断
      this.log(`👀 进入主页，先停留浏览 ${(2 + Math.random() * 3).toFixed(1)}s…`);
      const initialDwell =
        new DwellTimeSampler(DEFAULT_BEHAVIOR_CONFIG.behavior.dwellTime).sample('home_feed') + 1500 + Math.random() * 1500;
      if (!(await interruptibleDwell(initialDwell))) {
        this.log('⚡ 被动蹲饼触发，中断浏览主页');
        return { success: true, data: { interrupted: true }, nextState: MainState.HOME_FEED };
      }

      // 拟人滚动浏览推荐流（滚动参数：左边缘安全鼠标位 + 一屏距离，由管理器计算）
      const { mousePos, distance } = await MousePositionManager.instance.browseScrollParams(page);
      for (let i = 0; i < depth; i++) {
        await new ScrollBehavior(mousePos, distance).execute(context);
        const screenDwell = new DwellTimeSampler(DEFAULT_BEHAVIOR_CONFIG.behavior.dwellTime).sample('home_feed');
        if (!(await interruptibleDwell(screenDwell))) {
          this.log('⚡ 被动蹲饼触发，中断浏览主页');
          return {
            success: true,
            data: { interrupted: true, browseDepth: depth },
            nextState: MainState.HOME_FEED,
          };
        }
        if (i < depth - 1) {
          await new SleepBehavior(800 + Math.random() * 1000).execute(context);
        }
      }

      // 收集可见视频（DOM）
      const videos = await this.collectVideos(page);

      // 日志：登录用户（视频列表不再打印）
      const user = await extractLoginUser(page);
      this.log(user ? `👤 登录用户: ${user.name || '(无名)'} (uid ${user.uid || '?'})` : '👤 未检测到登录用户');
      this.log(`✔ 刷首页推荐流完成（滚动 ${depth} 屏，收集 ${videos.length} 个视频）`);

      // 拟人回滚到顶部（真人刷完首页会自然滚回顶部/初始位置）
      await new HumanScroller().scrollBackToTop(page).catch(() => {});

      return {
        success: true,
        data: { videos, count: videos.length },
        nextState: MainState.HOME_FEED,
      };
    } catch (error) {
      return {
        success: false,
        error: `Browse home failed: ${(error as Error).message}`,
      };
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
