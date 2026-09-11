import { BaseTask, type TaskController, type TaskResult } from './base';
import type { TaskContext } from '../execute/context';
import { MainState } from '../engine/state';
import { MouseMoveBehavior, LeftClickBehavior, ScrollBehavior, SleepBehavior } from '../behavior';
import { MousePositionManager } from '../engine/mouse-position-manager';
import { HumanScroller } from '../engine/human-scroller';
import { DwellTimeSampler } from '../engine/dwell-time';
import { DEFAULT_BEHAVIOR_CONFIG } from '../engine/config';
import { findProfileEntryHandle } from '../../utils/bilibili-dom';

/** 逛目标 UP 主页任务的输入：由人格/调度器（决策层）在执行时提供 */
export interface BrowseProfileInput {
  /** 目标 UP 的名字（主参数：用于搜索/匹配入口） */
  upName: string;
  /** 目标 UP 的 UID（可选：用于精确链接/URL 匹配） */
  uid?: string;
  /** 拟人滚动浏览的屏数（人格决定），默认 2 */
  browseDepth?: number;
}

/**
 * 逛目标 UP 主页任务：以 **UP 名字** 为主参数，从当前页进入目标 UP 主页并拟人浏览。
 *
 * - preCheck：验证执行环境可用（有 page/browser）。
 * - execute：
 *   1. 若已在目标 UP 主页（space.bilibili.com/{uid}，按名字匹配标题）→ 直接浏览
 *   2. 否则在当前页找目标 UP 主页入口（优先按 upName 文本匹配，其次按 uid 链接）
 *   3. 找不到入口 → 返回 `{ needSearch: true, upName }`，由生成器拿到结果后
 *      生成搜索任务（搜索目标 UP 名 → 再次进入 UP 主页）
 *   4. 找到入口 → 点击 → 捕获新标签页（UP 主页 target=_blank）→ 拟人滚动浏览
 */
export class BrowseProfileTask extends BaseTask {
  constructor(private input: BrowseProfileInput) {
    super('BrowseProfile');
  }

  /** 是否为指定 UID 的 UP 主页（有 uid 时精确匹配；无 uid 时按标题含 upName 判断） */
  private isTargetProfile(url: string, title?: string): boolean {
    try {
      const u = new URL(url);
      const isSpace = u.hostname.includes('space.bilibili.com');
      if (!isSpace) {
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

  /** preCheck：验证执行环境可用（入口/搜索兜底都由生成器编排） */
  async preCheck(context: TaskContext): Promise<boolean> {
    return !!(context.page && context.browser);
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
    this.log('⚡ 收到中断（蹲饼让位 / 停止模拟），结束逛 UP 主页');
  }

  /** 任务主体：只「做事 + 记录数据 + 声明落点」，不生成状态 */
  private async run(context: TaskContext, ctrl: TaskController): Promise<void> {
    const page = context.page!;
    const steps: TaskResult[] = [];

    try {
      // 阶段1：已在目标 UP 主页 → 直接浏览
      const currentTitle = await page.title().catch(() => '');
      if (this.isTargetProfile(page.url(), currentTitle)) {
        console.log(`   ✅ 已在目标 UP 主页，直接浏览`);
      } else {
        // 阶段2：在当前页找目标 UP 主页入口（公共方法：优先 upName 文本匹配，其次 uid 链接）
        const entryHandle = await findProfileEntryHandle(page, {
          upName: this.input.upName,
          uid: this.input.uid,
        });

        // 阶段3：无入口 → 返回 needSearch，由生成器生成「搜索 UP 名 → 再进主页」
        if (!entryHandle) {
          this.log(`⚠️ 当前页无目标 UP（${this.input.upName}）入口，返回 needSearch`);
          this.finishWith({
            success: true,
            data: {
              entered: false,
              needSearch: true,
              upName: this.input.upName,
              uid: this.input.uid,
              reason: '当前页无目标 UP 主页入口',
            },
          });
          return;
        }
        // 解析 UP 主页入口坐标（含滚动/落点；深层懒加载兜底点击）
        const resolved = await MousePositionManager.instance.resolveTarget(page, entryHandle);
        if (!resolved.point && !resolved.alreadyClicked) {
          throw new Error('未找到可见的 UP 主页入口');
        }
        if (!resolved.alreadyClicked) {
          // 行为1：鼠标移动到 UP 主页入口
          const mv = await new MouseMoveBehavior(resolved.point!).execute(context);
          steps.push(mv);
          if (!mv.success) {
            throw new Error(mv.error);
          }

          // 行为2：点击 UP 主页入口
          const cl = await new LeftClickBehavior(resolved.point!).execute(context);
          steps.push(cl);
          if (!cl.success) {
            throw new Error(cl.error);
          }
        }

        // 行为3：等待进入 UP 主页（入口 target=_blank 打开新标签页，轮询捕获）
        const profilePage = await this.findProfilePage(context);
        if (profilePage) {
          context.page = profilePage;
          this.log(`📑 UP 主页（新标签页）: ${context.page!.url().slice(0, 60)}`);
        }
      }

      const nowUrl = context.page!.url();
      if (!nowUrl.includes('space.bilibili.com')) {
        throw new Error(`未进入 UP 主页（当前 ${nowUrl}）`);
      }

      // 进入 UP 主页后先停留几秒（真人打开页面先看一眼再开始逛）；可被被动蹲饼中断
      this.log(`👀 进入 ${this.input.upName} 主页，先停留浏览 ${(2 + Math.random() * 3).toFixed(1)}s…`);
      const initialDwell =
        new DwellTimeSampler(DEFAULT_BEHAVIOR_CONFIG.behavior.dwellTime).sample('user_profile') + 1500 + Math.random() * 1500;
      if (!(await ctrl.dwell(initialDwell))) {
        this.finishWith(
          { success: true, data: { interrupted: true, entered: true, upName: this.input.upName, steps: steps.length } },
          MainState.USER_PROFILE
        );
        return;
      }

      // 行为4：拟人滚动浏览 UP 主页（滚动参数：左边缘安全鼠标位 + 一屏距离）
      const depth = this.input.browseDepth ?? 2;
      const { mousePos, distance } = await MousePositionManager.instance.browseScrollParams(page);
      for (let i = 0; i < depth; i++) {
        await new ScrollBehavior(mousePos, distance).execute(context);
        const screenDwell = new DwellTimeSampler(DEFAULT_BEHAVIOR_CONFIG.behavior.dwellTime).sample('user_profile');
        if (!(await ctrl.dwell(screenDwell))) {
          this.finishWith(
            {
              success: true,
              data: { interrupted: true, entered: true, upName: this.input.upName, browseDepth: depth, steps: steps.length },
            },
            MainState.USER_PROFILE
          );
          return;
        }
        if (i < depth - 1) {
          await new SleepBehavior(800 + Math.random() * 1000).execute(context);
        }
      }

      this.log(`🏠 浏览目标 UP 主页（${this.input.upName}）：${nowUrl}（滚动 ${depth} 屏）`);

      // 拟人回滚到顶部（真人逛完 UP 主页会自然滚回顶部/初始位置）
      await new HumanScroller().scrollBackToTop(context.page!).catch(() => {});

      // 执行阶段结束：记录数据 + 声明落点（后一个状态由 onEnd 生成）
      this.finishWith(
        {
          success: true,
          data: {
            entered: true,
            needSearch: false,
            uid: this.input.uid,
            upName: this.input.upName,
            url: context.page!.url(),
            browseDepth: depth,
            steps: steps.length,
          },
        },
        MainState.USER_PROFILE
      );
    } catch (error) {
      this.finishWith({ success: false, error: `逛 UP 主页失败: ${(error as Error).message}`, data: { steps: steps.length } });
    } finally {
      ctrl.finish(); // 任务主体结束 → 结束异步进程（执行器随后调用 ③ 结束处理）
    }
  }

  /** 在所有标签页中查找 UP 主页（space.bilibili.com，目标 uid） */
  private async findProfilePage(context: TaskContext): Promise<NonNullable<TaskContext['page']> | null> {
    const browser = context.browser;
    if (!browser) {
      return null;
    }

    // 轮询最多 5 秒，等待 UP 主页标签页 URL 就绪（功能性等待，不走时间缩放）
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
