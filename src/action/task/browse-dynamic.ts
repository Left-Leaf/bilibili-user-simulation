import { BaseTask, TaskResult } from './base';
import type { TaskContext } from '../execute/context';
import { MainState } from '../engine/state';
import { MouseMoveBehavior, LeftClickBehavior, ScrollBehavior, SleepBehavior } from '../behavior';
import { MousePositionManager } from '../engine/mouse-position-manager';
import { HumanScroller } from '../engine/human-scroller';
import { DwellTimeSampler } from '../engine/dwell-time';
import { DEFAULT_BEHAVIOR_CONFIG } from '../engine/config';
import { fetchCoordinator } from '../../business/fetch-coordinator';
import { extractLoginUser, findDynamicEntryHandle } from '../../utils/bilibili-dom';

/** 浏览动态页任务的输入：由人格（决策层）在执行时提供 */
export interface BrowseDynamicInput {
  /** 拟人滚动浏览的屏数（人格决定），默认 2 */
  browseDepth?: number;
}

/**
 * 浏览动态页任务：从当前页的「动态」入口进入动态页并拟人滚动浏览。
 *
 * - preCheck：检测当前页是否有动态入口（right-entry__outside / 指向 t.bilibili.com 的链接）
 * - execute：鼠标移动到动态入口 → 点击进入（动态入口 target=_blank，结果开在新标签页，
 *   捕获并切换 context.page 到动态页）→ 拟人滚动浏览 → 输出动态页 URL
 */
export class BrowseDynamicTask extends BaseTask {
  constructor(private input: BrowseDynamicInput = {}) {
    super('BrowseDynamic');
  }

  private isDynamicPage(url: string): boolean {
    try {
      const u = new URL(url);
      return u.hostname === 't.bilibili.com' || u.hostname.endsWith('.t.bilibili.com');
    } catch {
      return false;
    }
  }

  /** preCheck：检测当前页是否有可见的动态入口 */
  async preCheck(context: TaskContext): Promise<boolean> {
    const page = context.page;
    if (!page) {
      return false;
    }
    try {
      // 已在动态页也视为具备前置条件
      if (this.isDynamicPage(page.url())) {
        return true;
      }
      const entry = await findDynamicEntryHandle(page);
      return !!entry;
    } catch {
      return false;
    }
  }

  async execute(context: TaskContext): Promise<TaskResult> {
    const page = context.page!;
    const browser = context.browser;
    const steps: TaskResult[] = [];

    try {
      // 本次动态页浏览的总停留时长（任务一开始就确定，随进入日志打印）
      const totalDwellMs = new DwellTimeSampler(DEFAULT_BEHAVIOR_CONFIG.behavior.dwellTime).sample('dynamic_feed');

      // 若当前已在动态页，直接进入浏览阶段
      let enteredViaEntry = false;
      let reusedTab = false;
      if (!this.isDynamicPage(page.url())) {
        // 优先复用已存在的动态页标签（当前栈已有 t.bilibili.com → 直接前往，不新开标签）
        const existingDynamic = await this.findExistingDynamicPage(context);
        if (existingDynamic) {
          await existingDynamic.bringToFront().catch(() => {});
          context.page = existingDynamic;
          reusedTab = true;
          this.log(`📑 复用已有动态页标签: ${existingDynamic.url().slice(0, 60)}（停留 ${(totalDwellMs / 1000).toFixed(1)}s）`);
        } else {
          // 找可见的动态入口（顶部栏「动态」），用 handle 精确定位点击
          const entryHandle = await findDynamicEntryHandle(page);
          if (!entryHandle) {
            throw new Error('未找到可见的动态入口');
          }
          const entryHref = await entryHandle.evaluate((a) => ((a as HTMLAnchorElement).href ?? '').slice(0, 50)).catch(() => '?');
          this.log(`🎯 动态入口: ${entryHref}`);

          // 解析动态入口坐标（含滚动/落点；深层懒加载兜底点击）
          const resolved = await MousePositionManager.instance.resolveTarget(page, entryHandle);
          if (!resolved.point && !resolved.alreadyClicked) {
            throw new Error('未找到可见的动态入口');
          }
          if (!resolved.alreadyClicked) {
            // 行为1：鼠标移动到动态入口
            const mv = await new MouseMoveBehavior(resolved.point!).execute(context);
            steps.push(mv);
            if (!mv.success) {
              throw new Error(mv.error);
            }

            // 行为2：点击动态入口进入
            const cl = await new LeftClickBehavior(resolved.point!).execute(context);
            steps.push(cl);
            if (!cl.success) {
              throw new Error(cl.error);
            }
          }
          enteredViaEntry = true;

          // 行为3：等待动态页（可能 target=_blank 新标签，也可能当前页导航；轮询捕获）
          const dynamicPage = await this.findDynamicPage(context);
          if (dynamicPage && dynamicPage !== context.page) {
            context.page = dynamicPage;
            this.log(`📑 动态页（新标签页）: ${dynamicPage.url().slice(0, 60)}（停留 ${(totalDwellMs / 1000).toFixed(1)}s）`);
          } else if (this.isDynamicPage(context.page!.url())) {
            this.log(`📄 动态页（当前页导航）: ${context.page!.url().slice(0, 60)}（停留 ${(totalDwellMs / 1000).toFixed(1)}s）`);
          }
        }
      } else {
        // 已在动态页（未走入口分支）也打印停留时长
        this.log(`📄 已在动态页，停留浏览 ${(totalDwellMs / 1000).toFixed(1)}s…`);
      }

      const nowUrl = context.page!.url();
      if (!this.isDynamicPage(nowUrl)) {
        throw new Error(`点击动态入口后未进入动态页（当前 ${nowUrl}）`);
      }

      // 进入后初看：用总停留的一部分（真人先看一眼再开始刷），不超过 ~4.5s
      const initialLookMs = Math.min(totalDwellMs * 0.35, 4500);
      this.log(`👀 先停留浏览 ${(initialLookMs / 1000).toFixed(1)}s…`);
      if (!(await this.interruptibleDwell(context, initialLookMs))) {
        this.log('⚡ 被动蹲饼触发，中断浏览动态页');
        return {
          success: true,
          data: { url: context.page!.url(), interrupted: true, steps: steps.length },
          nextState: MainState.DYNAMIC_FEED,
        };
      }

      // 行为4：拟人滚动浏览动态流，剩余停留时长分摊到每屏（总时长 = 进入时确定的值）
      const depth = this.input.browseDepth ?? 2;
      const perScreenMs = Math.max(0, (totalDwellMs - initialLookMs) / depth);
      const { mousePos, distance } = await MousePositionManager.instance.browseScrollParams(page);
      for (let i = 0; i < depth; i++) {
        await new ScrollBehavior(mousePos, distance).execute(context);
        this.log(`👀 停留浏览 ${(perScreenMs / 1000).toFixed(1)}s…`);
        if (!(await this.interruptibleDwell(context, perScreenMs))) {
          this.log('⚡ 被动蹲饼触发，中断浏览动态页');
          return {
            success: true,
            data: { url: context.page!.url(), interrupted: true, browseDepth: depth, steps: steps.length },
            nextState: MainState.DYNAMIC_FEED,
          };
        }
        if (i < depth - 1) {
          await new SleepBehavior(800 + Math.random() * 1000).execute(context);
        }
      }

      // 日志：登录用户（动态列表不再打印，动态数据由被动蹲饼统一采集）
      const user = await extractLoginUser(context.page!);
      this.log(user ? `👤 登录用户: ${user.name || '(无名)'} (uid ${user.uid || '?'})` : '👤 未检测到登录用户');
      this.log(`🕑 浏览动态页：滚动 ${depth} 屏（URL: ${context.page!.url().slice(0, 60)}）`);

      // 拟人回滚到顶部（真人逛完动态会自然滚回顶部/初始位置）
      await new HumanScroller().scrollBackToTop(context.page!).catch(() => {});

      return {
        success: true,
        data: {
          url: context.page!.url(),
          browseDepth: depth,
          steps: steps.length,
          enteredViaEntry,
          reusedTab,
        },
        nextState: MainState.DYNAMIC_FEED,
      };
    } catch (error) {
      return {
        success: false,
        error: `浏览动态页失败: ${(error as Error).message}`,
        data: { steps: steps.length },
      };
    }
  }

  /** 可中断停留：分片等待并检查被动蹲饼中断信号；被中断返回 false（BrowseDynamic 提前结束让位） */
  private async interruptibleDwell(context: TaskContext, ms: number): Promise<boolean> {
    const CHUNK = 400;
    let remain = ms;
    while (remain > 0) {
      if (fetchCoordinator.interruptRequested) {
        return false;
      }
      const step = Math.min(CHUNK, remain);
      await this.sleepReal(step);
      remain -= step;
    }
    return !fetchCoordinator.interruptRequested;
  }

  /** 在所有标签页中查找动态页（t.bilibili.com，动态入口 target=_blank 打开新标签页） */
  private async findDynamicPage(context: TaskContext): Promise<NonNullable<TaskContext['page']> | null> {
    const browser = context.browser;
    if (!browser) {
      return null;
    }

    // 轮询最多 8 秒，等待动态页标签页 URL 就绪（功能性等待，不走时间缩放）
    for (let i = 0; i < 16; i++) {
      const pages = await browser.pages().catch(() => [] as NonNullable<TaskContext['page']>[]);
      for (const p of pages) {
        if (this.isDynamicPage(p.url())) {
          return p;
        }
      }
      await this.sleepReal(500);
    }
    return null;
  }

  /** 在现有标签页中查找已存在的动态页（复用，不新开标签；排除当前页） */
  private async findExistingDynamicPage(context: TaskContext): Promise<NonNullable<TaskContext['page']> | null> {
    const browser = context.browser;
    if (!browser) {
      return null;
    }
    const pages = await browser.pages().catch(() => [] as NonNullable<TaskContext['page']>[]);
    return pages.find((p) => p !== context.page && this.isDynamicPage(p.url())) ?? null;
  }
}
