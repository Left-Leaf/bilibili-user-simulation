import { BaseTask, type TaskResult } from './base';
import type { TaskContext } from '../execute/context';
import { MainState } from '../engine/state';
import { MouseMoveBehavior, LeftClickBehavior } from '../behavior';
import { MousePositionManager } from '../engine/mouse-position-manager';
import { findDynamicEntryHandle, isDynamicPageUrl } from '../../utils/bilibili-dom';
import { findDynamicPage } from '../../business/passive-fetch';

/**
 * 打开动态页任务（触发式 / 一次性）：从当前页的「动态」入口进入动态页（t.bilibili.com）。
 *
 * 与「浏览动态页」（BrowseDynamicTask，持续性）分离：
 * - 打开 = 一次性动作：找入口 → 点击 → 捕获新标签并把 `context.page` 切到动态页
 * - 浏览 = 持续性停留：由 BrowseDynamicTask 在「已在动态页」的前提下承接
 *
 * - preCheck：当前页**不是**动态页，且存在可见的动态页入口
 * - execute：解析入口坐标 → 鼠标移动 → 点击 → 轮询捕获动态页（入口 `target=_blank`）
 * - 落点：`MainState.DYNAMIC_FEED`
 */
export class OpenDynamicTask extends BaseTask {
  constructor() {
    super('OpenDynamic');
  }

  /** preCheck：当前页不是动态页，且存在可见的动态入口 */
  async preCheck(context: TaskContext): Promise<boolean> {
    const page = context.page;
    if (!page) {
      return false;
    }
    // 已在动态页 → 「进入」已完成，无需再打开（浏览由 BrowseDynamicTask 承接）
    if (isDynamicPageUrl(page.url())) {
      return false;
    }
    try {
      const entry = await findDynamicEntryHandle(page);
      return !!entry;
    } catch {
      return false;
    }
  }

  /** ② 执行：一次性任务 → 直接返回结果（不生成状态，落点由 setNextState 声明） */
  async execute(context: TaskContext): Promise<TaskResult> {
    const page = context.page!;
    const browser = context.browser;
    try {
      // ① 已有动态页（如蹲饼常驻的动态页）→ **直接复用**：切前台 + 接管为主操作页，不点入口开新标签。
      //    硬约束：浏览器内只能有一张 t.bilibili.com —— 多张页会各自解析 feed/all 并各自触发一次
      //    点击获取流程，造成重复点击/重复刷新。
      const existing = browser ? await findDynamicPage(browser, page).catch(() => null) : null;
      if (existing) {
        await existing.bringToFront().catch(() => {});
        context.page = existing;
        this.log(`📑 复用已有动态页标签: ${existing.url().slice(0, 60)}`);
        this.setNextState(MainState.DYNAMIC_FEED);
        return { success: true, data: { url: existing.url(), reused: true } };
      }

      // ② 没有动态页 → 点当前页的「动态」入口，开新标签进入
      const entryHandle = await findDynamicEntryHandle(page);
      if (!entryHandle) {
        throw new Error('未找到可见的动态入口');
      }
      const entryHref = await entryHandle
        .evaluate((a) => ((a as HTMLAnchorElement).href ?? '').slice(0, 50))
        .catch(() => '?');
      this.log(`🎯 动态入口: ${entryHref}`);

      // 解析入口坐标（含滚动/落点；深层懒加载兜底点击）
      const resolved = await MousePositionManager.instance.resolveTarget(page, entryHandle);
      if (!resolved.point && !resolved.alreadyClicked) {
        throw new Error('未找到可见的动态入口');
      }
      if (!resolved.alreadyClicked) {
        const mv = await new MouseMoveBehavior(resolved.point!).execute(context);
        if (!mv.success) {
          throw new Error(mv.error);
        }
        const cl = await new LeftClickBehavior(resolved.point!).execute(context);
        if (!cl.success) {
          throw new Error(cl.error);
        }
      }

      // 行为3：等待动态页（入口 target=_blank 开新标签，也可能当前页导航；轮询捕获）
      const dynamicPage = await this.pollForDynamicPage(context);
      if (dynamicPage && dynamicPage !== context.page) {
        context.page = dynamicPage;
        this.log(`📑 动态页（新标签页）: ${dynamicPage.url().slice(0, 60)}`);
      }

      const nowUrl = context.page!.url();
      if (!isDynamicPageUrl(nowUrl)) {
        throw new Error(`点击动态入口后未进入动态页（当前 ${nowUrl.slice(0, 60)}）`);
      }

      this.log(`📄 已打开动态页: ${nowUrl.slice(0, 60)}`);
      this.setNextState(MainState.DYNAMIC_FEED);
      return { success: true, data: { url: nowUrl, reused: false } };
    } catch (error) {
      return { success: false, error: `打开动态页失败: ${(error as Error).message}` };
    }
  }

  /** 点击入口后轮询等待动态页出现（最多 8 秒，等新标签 URL 就绪） */
  private async pollForDynamicPage(context: TaskContext): Promise<NonNullable<TaskContext['page']> | null> {
    const browser = context.browser;
    if (!browser) {
      return null;
    }
    for (let i = 0; i < 16; i++) {
      const pages = await browser.pages().catch(() => [] as NonNullable<TaskContext['page']>[]);
      for (const p of pages) {
        if (isDynamicPageUrl(p.url())) {
          return p;
        }
      }
      await this.sleepReal(500);
    }
    return null;
  }
}
