import { BaseTask, type TaskResult } from './base';
import type { TaskContext } from '../execute/context';
import { MainState } from '../engine/state';
import { MouseMoveBehavior, LeftClickBehavior } from '../behavior';
import { MousePositionManager } from '../engine/mouse-position-manager';
import { findProfileEntryHandle, isUserPageUrl } from '../../utils/bilibili-dom';

/** 打开 UP 主页任务的输入：由人格/调度器（决策层）在执行时提供 */
export interface OpenProfileInput {
  /** 目标 UP 的名字（主参数：用于入口文本匹配） */
  upName: string;
  /** 目标 UP 的 UID（可选：用于精确链接/URL 匹配） */
  uid?: string;
}

/**
 * 打开 UP 主页任务（触发式 / 一次性）：从当前页进入目标 UP 主页。
 *
 * 与「浏览 UP 主页」（BrowseProfileTask，持续性）分离：
 * - 打开 = 一次性动作：找目标 UP 入口 → 点击 → 捕获新标签并把 `context.page` 切过去
 * - 浏览 = 持续性停留：由 BrowseProfileTask 在「已在用户页」的前提下承接
 *
 * - preCheck：当前页**不是**目标 UP 主页，且存在目标 UP 主页入口
 * - execute：解析入口坐标 → 鼠标移动 → 点击 → 轮询捕获 UP 主页（入口 `target=_blank`）
 *   - 入口在执行期消失（DOM 变化）→ 返回 `{ needSearch: true, upName }`，
 *     由生成器拿到结果后生成 Search 任务（搜索 UP 名 → 再进主页）
 * - 落点：`MainState.USER_PROFILE`
 */
export class OpenProfileTask extends BaseTask {
  constructor(private input: OpenProfileInput) {
    super('OpenProfile');
  }

  /** 是否为指定 UID 的 UP 主页（有 uid 时精确匹配；无 uid 时按标题含 upName 判断） */
  private isTargetProfile(url: string, title?: string): boolean {
    try {
      const u = new URL(url);
      if (!u.hostname.includes('space.bilibili.com')) {
        return false;
      }
      if (this.input.uid) {
        return u.pathname.startsWith(`/${this.input.uid}`);
      }
      // 无 uid：space 主页且标题包含 upName（宽松匹配）
      return !!title && title.includes(this.input.upName);
    } catch {
      return false;
    }
  }

  /** preCheck：当前页不是目标 UP 主页，且存在目标 UP 主页入口 */
  async preCheck(context: TaskContext): Promise<boolean> {
    const page = context.page;
    if (!page || !context.browser) {
      return false;
    }
    try {
      // 已在目标 UP 主页 → 「进入」已完成（浏览由 BrowseProfileTask 承接）
      const title = await page.title().catch(() => '');
      if (this.isTargetProfile(page.url(), title)) {
        return false;
      }
      const entry = await findProfileEntryHandle(page, { upName: this.input.upName, uid: this.input.uid });
      return !!entry;
    } catch {
      return false;
    }
  }

  /** ② 执行：一次性任务 → 直接返回结果（落点由 setNextState 声明） */
  async execute(context: TaskContext): Promise<TaskResult> {
    const page = context.page!;
    try {
      // 行为1/2：在当前页找目标 UP 主页入口（优先 upName 文本匹配，其次 uid 链接）→ 移动 → 点击
      const entryHandle = await findProfileEntryHandle(page, { upName: this.input.upName, uid: this.input.uid });
      if (!entryHandle) {
        // 入口消失（DOM 变化等）→ 交给生成器走「搜索 UP 名 → 再进主页」
        this.log(`⚠️ 当前页无目标 UP（${this.input.upName}）入口，返回 needSearch`);
        return {
          success: true,
          data: {
            entered: false,
            needSearch: true,
            upName: this.input.upName,
            uid: this.input.uid,
            reason: '当前页无目标 UP 主页入口',
          },
        };
      }

      // 解析入口坐标（含滚动/落点；深层懒加载兜底点击）
      const resolved = await MousePositionManager.instance.resolveTarget(page, entryHandle);
      if (!resolved.point && !resolved.alreadyClicked) {
        throw new Error('未找到可见的 UP 主页入口');
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

      // 行为3：等待 UP 主页（入口 target=_blank 打开新标签页，轮询捕获）
      const profilePage = await this.findProfilePage(context);
      if (profilePage && profilePage !== context.page) {
        context.page = profilePage;
        this.log(`📑 UP 主页（新标签页）: ${profilePage.url().slice(0, 60)}`);
      }

      const url = context.page!.url();
      if (!isUserPageUrl(url)) {
        throw new Error(`未进入 UP 主页（当前 ${url.slice(0, 60)}）`);
      }

      this.log(`📄 已打开 UP 主页（${this.input.upName || this.input.uid || '?'}）: ${url.slice(0, 60)}`);
      this.setNextState(MainState.USER_PROFILE);
      return {
        success: true,
        data: { entered: true, needSearch: false, upName: this.input.upName, uid: this.input.uid, url },
      };
    } catch (error) {
      return { success: false, error: `打开 UP 主页失败: ${(error as Error).message}` };
    }
  }

  /** 在所有标签页中查找目标 UP 主页（轮询最多 5 秒，等待新标签 URL 就绪） */
  private async findProfilePage(context: TaskContext): Promise<NonNullable<TaskContext['page']> | null> {
    const browser = context.browser;
    if (!browser) {
      return null;
    }
    for (let i = 0; i < 10; i++) {
      const pages = await browser.pages().catch(() => [] as NonNullable<TaskContext['page']>[]);
      for (const p of pages) {
        const title = await p.title().catch(() => '');
        if (this.isTargetProfile(p.url(), title)) {
          return p;
        }
      }
      await this.sleepReal(500);
    }
    return null;
  }
}
