import { BaseTask, type TaskResult } from './base';
import type { TaskContext } from '../execute/context';
import { MainState } from '../engine/state';
import { isHomePageUrl } from '../../utils/bilibili-dom';

/**
 * 打开主页任务（触发式 / 一次性）：把 `context.page` 切到 B 站主页。
 *
 * 与「浏览主页」（BrowseHomeTask，持续性）分离：
 * - 打开 = 一次性动作：优先复用已打开的主页标签，没有则新开标签并导航到主页
 * - 浏览 = 持续性停留：由 BrowseHomeTask 在「已在主页」的前提下承接
 *
 * - preCheck：当前页**不是**主页，且浏览器可用
 * - execute：复用/新开主页标签 → `context.page = 主页` → 落点 `MainState.HOME_FEED`
 */
export class OpenHomeTask extends BaseTask {
  constructor() {
    super('OpenHome');
  }

  /** preCheck：当前页不是主页 */
  async preCheck(context: TaskContext): Promise<boolean> {
    const page = context.page;
    if (!page || !context.browser) {
      return false;
    }
    return !isHomePageUrl(page.url());
  }

  /** ② 执行：一次性任务 → 直接返回结果（落点由 setNextState 声明） */
  async execute(context: TaskContext): Promise<TaskResult> {
    const browser = context.browser!;
    try {
      // 优先复用已打开的主页标签（不新开标签）
      const pages = await browser.pages().catch(() => [] as NonNullable<TaskContext['page']>[]);
      const homePage = pages.find((p) => !p.isClosed() && isHomePageUrl(p.url()));
      if (homePage) {
        await homePage.bringToFront().catch(() => {});
        context.page = homePage;
        this.log(`📑 切换到已打开的主页标签: ${homePage.url().slice(0, 60)}`);
        this.setNextState(MainState.HOME_FEED);
        return { success: true, data: { url: homePage.url(), reusedTab: true } };
      }

      // 没有主页标签 → 新开标签并导航到主页
      const newPage = await browser.newPage();
      await newPage.goto('https://www.bilibili.com', { waitUntil: 'networkidle2' }).catch(() => {});
      context.page = newPage;

      const url = newPage.url();
      if (!isHomePageUrl(url)) {
        throw new Error(`新开标签页未进入主页（当前 ${url.slice(0, 60) || '(空)'}）`);
      }
      this.log(`🆕 新开标签页打开主页: ${url.slice(0, 60)}`);
      this.setNextState(MainState.HOME_FEED);
      return { success: true, data: { url, reusedTab: false } };
    } catch (error) {
      return { success: false, error: `打开主页失败: ${(error as Error).message}` };
    }
  }
}
