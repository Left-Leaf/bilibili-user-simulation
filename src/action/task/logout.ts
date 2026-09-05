import { BaseTask, TaskResult, TaskStatus } from './base';
import type { TaskContext } from '../execute/context';
import { MainState } from '../engine/state';
import { MouseMoveBehavior, LeftClickBehavior, SleepBehavior, NavigateBehavior } from '../behavior';
import { MousePositionManager } from '../engine/mouse-position-manager';

/** 右上角头像入口（悬停展开头像抽屉；li.v-popover-wrap 外层 + 头像容器） */
const AVATAR_SELECTOR = 'li.v-popover-wrap.header-avatar-wrap, .header-avatar-wrap';

/** 头像抽屉里的「退出登录」按钮（悬停头像后抽屉才可见） */
const LOGOUT_SELECTOR = '.logout-item';

/** 在页面里判断是否已登录（有头像或登录 cookie） */
const isLoggedInOnPage = async (page: NonNullable<TaskContext['page']>): Promise<boolean> => {
  try {
    return await page.evaluate(() => {
      const hasAvatar = !!document.querySelector('.header-avatar-wrap');
      const hasLoginCookie = document.cookie.includes('DedeUserID') || document.cookie.includes('SESSDATA');
      return hasAvatar || hasLoginCookie;
    });
  } catch {
    return false;
  }
};

/** 退出登录按钮是否可见（抽屉已展开） */
const isLogoutItemVisible = async (page: NonNullable<TaskContext['page']>): Promise<boolean> => {
  try {
    return await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) {
        return false;
      }
      const r = el.getBoundingClientRect();
      const st = window.getComputedStyle(el);
      return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0;
    }, LOGOUT_SELECTOR);
  } catch {
    return false;
  }
};

/**
 * 退出登录任务（运行时 logout 指令触发）：明确目的「退出当前账号」。
 *
 * 流程（与真人一致）：
 *   1. 已登录检测 → 未登录直接跳过（保留未登录态）
 *   2. 鼠标移动到右上角头像（.header-avatar-wrap）→ 悬停展开头像抽屉（v-popover）
 *   3. 若悬停未展开 → 点击头像强制展开
 *   4. 点击抽屉里的「退出登录」（.logout-item）
 *   5. 等待确认已登出（SESSDATA cookie / 头像消失）
 *
 * 退出成功后 SESSDATA 被清除、isLoggedIn=false，执行器与 bilibili-user-simulation 检测到后
 * 立即停止任务生成，等用户输入 login 重新登录。
 */
export class LogoutTask extends BaseTask {
  constructor() {
    super('Logout');
  }

  async preCheck(_context: TaskContext): Promise<boolean> {
    return true;
  }

  async execute(context: TaskContext): Promise<TaskResult> {
    try {
      // 行为1：已登录检测 → 未登录无需退出
      if (!context.page || (await isLoggedInOnPage(context.page)) === false) {
        this.log('⚠️ 当前未登录，无需退出');
        this.setState(context, 'isLoggedIn', false);
        return this.finalizeResult(TaskStatus.SUCCESS, { logoutMethod: 'skipped' }, MainState.LOGGED_IN);
      }

      // 行为2：关闭全部标签页，只保留 B 站主页，然后在主页完成退出操作
      const allPages = context.browser ? await context.browser.pages().catch(() => []) : [];
      // 找一个真正的 B 站主页标签（根路径首页）
      let homePage: NonNullable<TaskContext['page']> | null = null;
      for (const p of allPages) {
        if (p.isClosed()) {
          continue;
        }
        const url = p.url() || '';
        if (/^https?:\/\/(www\.)?bilibili\.com\/?(\?.*)?$/.test(url)) {
          homePage = p;
          break;
        }
      }
      // 关闭除主页外的全部标签页
      for (const p of allPages) {
        if (p === homePage || p.isClosed()) {
          continue;
        }
        await p.close().catch(() => {});
      }
      // 无主页标签 → 把当前页导航为主页
      if (!homePage) {
        homePage = context.page ?? null;
        if (homePage && !homePage.isClosed()) {
          await new NavigateBehavior('https://www.bilibili.com/').execute(context).catch(() => {});
        }
      }
      if (!homePage || homePage.isClosed()) {
        throw new Error('无可用页面执行退出登录');
      }
      // 后续操作统一基于主页（行为单元读取 context.page）
      context.page = homePage;
      await homePage.bringToFront().catch(() => {});

      // 行为3：解析头像入口坐标（在主页）
      const avatar = await MousePositionManager.instance.resolveTarget(context.page, AVATAR_SELECTOR);
      if (!avatar.point && !avatar.alreadyClicked) {
        throw new Error('未找到头像入口');
      }

      // 行为4：鼠标移动到头像（悬停展开抽屉）
      if (!avatar.alreadyClicked) {
        await this.randomDelay(400, 800);
        const mv = await new MouseMoveBehavior(avatar.point!).execute(context);
        if (!mv.success) {
          throw new Error(mv.error);
        }
        // 悬停后等待抽屉展开
        await new SleepBehavior(600 + Math.random() * 400).execute(context);
      }

      // 行为5：悬停未展开 → 点击头像强制展开
      if (!(await isLogoutItemVisible(context.page))) {
        const cl = await new LeftClickBehavior(avatar.point!).execute(context);
        if (!cl.success) {
          throw new Error(cl.error);
        }
        await new SleepBehavior(600 + Math.random() * 400).execute(context);
      }

      // 行为6：点击「退出登录」
      const logoutBtn = await MousePositionManager.instance.resolveTarget(context.page, LOGOUT_SELECTOR);
      if (!logoutBtn.point && !logoutBtn.alreadyClicked) {
        throw new Error('未找到退出登录按钮');
      }
      if (!logoutBtn.alreadyClicked) {
        await this.randomDelay(300, 600);
        const cl = await new LeftClickBehavior(logoutBtn.point!).execute(context);
        if (!cl.success) {
          throw new Error(cl.error);
        }
      }

      // 行为7：等待登出生效后确认（SESSDATA cookie / 头像消失）
      await new SleepBehavior(1500 + Math.random() * 1000).execute(context);
      const stillLoggedIn = await isLoggedInOnPage(context.page);
      if (stillLoggedIn) {
        throw new Error('点击退出登录后仍未登出');
      }

      this.log('✅ 已退出登录（SESSDATA 已清除，任务生成已停止）');
      this.setState(context, 'isLoggedIn', false);
      return this.finalizeResult(TaskStatus.SUCCESS, { logoutMethod: 'ui' }, MainState.LOGGED_IN);
    } catch (error) {
      return this.finalizeResult(TaskStatus.FAILURE, undefined, undefined, `退出登录失败: ${(error as Error).message}`);
    }
  }
}
