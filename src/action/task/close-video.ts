import { BaseTask, TaskResult } from './base';
import type { TaskContext } from '../execute/context';
import { MainState } from '../engine/state';
import { CloseTabBehavior } from '../behavior';
import { isDynamicPageUrl } from '../../business/passive-fetch';
import { isVideoPageUrl } from '../../utils/bilibili-dom';

/**
 * 关闭标签页任务：非必然事件，由生成器按「当前标签页集合 + 当前页类型」给概率触发。
 *
 * 关闭目标选择（符合真人）：
 * - 有视频页：优先关当前视频页（若当前是视频页）；否则从视频页中随机选一个关
 * - 无视频页但标签过多（>3）：关掉一个非当前的多余标签（真人会清理多余页面）
 * - 无可关标签：空操作跳过
 *
 * - 关闭后若浏览器还有其他标签 → 激活一个非视频标签
 * - 仅剩一个标签 → 直接导航回主页（不关窗口）
 * - 无非视频标签 → 新开主页
 */
export class CloseVideoTask extends BaseTask {
  constructor() {
    super('CloseVideo');
  }

  async preCheck(context: TaskContext): Promise<boolean> {
    // 有页面才需要关闭；没有页面（已关）则无需执行
    return !!(context.page && context.browser);
  }

  async execute(context: TaskContext): Promise<TaskResult> {
    const browser = context.browser;
    const page = context.page;
    try {
      const pages = (await browser!.pages().catch(() => [] as NonNullable<TaskContext['page']>[])) as NonNullable<TaskContext['page']>[];
      const curUrl = page?.url() ?? '';
      const isCurVideo = isVideoPageUrl(curUrl);
      const videoPages = pages.filter((p) => isVideoPageUrl(p.url()));

      // 决定关闭目标标签页
      let target: NonNullable<TaskContext['page']> | null = null;
      if (videoPages.length > 0) {
        // 视频页清理：优先关当前页（若当前是视频页）；否则从视频页中选一个（真人会关掉某个视频）
        if (isCurVideo) {
          target = page!;
        } else {
          const candidates = videoPages.filter((p) => p !== page);
          if (candidates.length > 0) {
            target = candidates[Math.floor(Math.random() * candidates.length)];
          }
        }
      } else if (pages.length > 3) {
        // 无视频页但标签过多：关掉一个非当前的多余标签（真人会清理多余页面）
        // 被动蹲饼的动态页（t.bilibili.com）是常驻监听页，排除，避免被当作多余标签关闭
        const candidates = pages.filter((p) => p !== page && !isDynamicPageUrl(p.url()));
        if (candidates.length > 0) {
          target = candidates[Math.floor(Math.random() * candidates.length)];
        }
      }

      if (!target) {
        this.log(`⏭️ 无可关标签页（视频页 ${videoPages.length} 个 / 总标签 ${pages.length} 个），跳过`);
        const next = curUrl.includes('t.bilibili.com')
          ? MainState.DYNAMIC_FEED
          : curUrl.includes('search.bilibili.com')
            ? MainState.SEARCH_RESULT
            : curUrl.includes('space.bilibili.com')
              ? MainState.USER_PROFILE
              : isVideoPageUrl(curUrl)
                ? MainState.CONTENT_CONSUMING
                : MainState.HOME_FEED;
        return {
          success: true,
          data: { closed: false, reason: 'nothing_to_close', url: curUrl },
          nextState: next,
        };
      }

      // 目标不是当前页 → 先激活它（CloseTabBehavior 关闭当前激活标签）
      if (target !== page) {
        await target.bringToFront().catch(() => {});
        context.page = target;
      }
      const targetUrl = context.page!.url();
      this.log(
        `🚪 关闭标签页: ${targetUrl.slice(0, 60)}${videoPages.length > 0 ? `（视频页 ${videoPages.length} 个）` : '（多余标签清理）'}`
      );

      // 仅剩一个标签：关闭会关掉整个浏览器窗口 → 导航回主页（真人「看完返回首页」观感）
      if (pages.length <= 1) {
        await page!.goto('https://www.bilibili.com', { waitUntil: 'domcontentloaded' });
        this.log('🏠 仅剩一个标签，直接导航回主页');
        return {
          success: true,
          data: { closed: false, returnedTo: page!.url() },
          nextState: MainState.HOME_FEED,
        };
      }

      // 关闭目标标签页
      const ct = await new CloseTabBehavior().execute(context);
      if (!ct.success && context.page) {
        throw new Error(ct.error);
      }

      // 激活一个非视频标签（避免仍在视频环境）；没有则新开主页
      const remain = (await browser!.pages().catch(() => [] as NonNullable<TaskContext['page']>[])) as NonNullable<TaskContext['page']>[];
      const nonVideo = remain.find((p) => !isVideoPageUrl(p.url()));
      if (nonVideo) {
        await nonVideo.bringToFront().catch(() => {});
        context.page = nonVideo;
        this.log(`📑 回到非视频标签: ${nonVideo.url().slice(0, 60)}（剩余 ${remain.length} 个标签）`);
        return {
          success: true,
          data: { closed: true, returnedTo: nonVideo.url() },
          nextState: MainState.HOME_FEED,
        };
      }

      // 没有非视频标签 → 新开主页（避免残留视频标签）
      const newPage = await browser!.newPage();
      await newPage.goto('https://www.bilibili.com', { waitUntil: 'domcontentloaded' });
      context.page = newPage;
      this.log('🆕 无非视频标签，新开主页');
      return {
        success: true,
        data: { closed: true, returnedTo: newPage.url() },
        nextState: MainState.HOME_FEED,
      };
    } catch (error) {
      return {
        success: false,
        error: `关闭标签页失败: ${(error as Error).message}`,
      };
    }
  }
}
