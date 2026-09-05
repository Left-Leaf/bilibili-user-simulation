import { BaseTask, TaskResult, TaskStatus } from './base';
import type { TaskContext } from '../execute/context';
import { MainState } from '../engine/state';
import { OpenBrowserBehavior, NavigateBehavior, MouseMoveBehavior, LeftClickBehavior, ScanQrBehavior, SleepBehavior } from '../behavior';
import { MousePositionManager } from '../engine/mouse-position-manager';

const LOGIN_ENTRY_SELECTORS = [
  '.header-login-entry', // 右上角登录入口
  '.login-entry',
  'a[href*="login"]',
  'a[href*="passport"]',
  'a[href*="account"]',
  '[class*="login"]',
];

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

/** 登录任务选项 */
export interface LoginTaskOptions {
  /** 无头模式（服务器上 true，本地调试 false） */
  headless?: boolean;
  /** 浏览器用户数据目录（登录信息存储位置） */
  userDataDir?: string;
  /** 登录等待超时（毫秒），默认 3 分钟 */
  loginTimeoutMs?: number;
}

/**
 * 登录任务：明确目的「完成登录」的行为集合。
 *
 * 流程 = 之前登录测试的完整流程，全部由行为单元组合而成：
 *   1. 打开浏览器（OpenBrowserBehavior）
 *   2. 打开 B 站主页（NavigateBehavior）
 *   3. 已登录检测 → 跳过（保留登录态）
 *   4. 鼠标移动到登录入口（MouseMoveBehavior）
 *   5. 点击登录入口（LeftClickBehavior）
 *   6. 获取登录二维码并打印到终端（ScanQrBehavior）
 *   7. 等待扫码登录（成功或超时）
 */
export class LoginTask extends BaseTask {
  constructor(private options: LoginTaskOptions = {}) {
    super('Login');
  }

  async preCheck(_context: TaskContext): Promise<boolean> {
    return true;
  }

  async execute(context: TaskContext): Promise<TaskResult> {
    // userDataDir/headless 优先取 context.state（persona-engine 正式运行注入），否则用构造 options
    const userDataDir = this.options.userDataDir ?? (context.state.get('loginUserDataDir') as string | undefined);
    const headless = this.options.headless ?? (context.state.get('loginHeadless') as boolean | undefined) ?? false;
    const { loginTimeoutMs = 180000 } = this.options;
    const steps: TaskResult[] = [];
    try {
      // 行为1：打开浏览器（若未打开）
      if (!context.browser) {
        const open = await new OpenBrowserBehavior({
          headless,
          args: ['--lang=zh-CN,und', '--window-size=1920,1080', '--window-position=0,0', '--disable-dev-shm-usage', '--no-sandbox'],
          defaultViewport: headless ? { width: 1920, height: 1080 } : null,
          userDataDir,
        }).execute(context);
        steps.push(open);
        if (!open.success) {
          throw new Error(open.error);
        }
      }

      // 行为2：打开 B 站主页
      const nav = await new NavigateBehavior('https://www.bilibili.com').execute(context);
      steps.push(nav);
      if (!nav.success) {
        throw new Error(nav.error);
      }

      // 行为3：已登录检测 → 跳过（登录态持久化，下次直接跳过）
      if (context.page && (await isLoggedInOnPage(context.page))) {
        this.log('✅ 已经登录，跳过登录流程');
        this.setState(context, 'alreadyLoggedIn', true);
        return this.finalizeResult(TaskStatus.SUCCESS, { loginMethod: 'skipped' }, MainState.LOGGED_IN);
      }

      // 解析登录入口坐标（含可见性遍历/落点/滚动；深层懒加载兜底）
      const entrySelector = LOGIN_ENTRY_SELECTORS.join(', ');
      const resolved = await MousePositionManager.instance.resolveTarget(context.page!, entrySelector);
      if (!resolved.point && !resolved.alreadyClicked) {
        throw new Error('未找到登录入口');
      }
      if (!resolved.alreadyClicked) {
        // 行为4：鼠标移动到登录入口
        await this.randomDelay(500, 1000);
        const mv = await new MouseMoveBehavior(resolved.point!).execute(context);
        steps.push(mv);
        if (!mv.success) {
          throw new Error(mv.error);
        }

        // 行为5：点击登录入口（打开登录弹窗）
        const cl = await new LeftClickBehavior(resolved.point!).execute(context);
        steps.push(cl);
        if (!cl.success) {
          throw new Error(cl.error);
        }
      }
      await new SleepBehavior(1500 + Math.random() * 1000).execute(context);

      // 行为6：获取登录二维码并打印到终端
      const scan = await new ScanQrBehavior(30000).execute(context);
      steps.push(scan);

      // 行为7：等待扫码登录（成功或超时）
      this.log('⏳ 等待扫码登录…');
      const page = context.page!;
      const startTime = Date.now();
      while (Date.now() - startTime < loginTimeoutMs) {
        await this.sleep(2000);

        if (page.isClosed()) {
          return this.finalizeResult(TaskStatus.INTERRUPTED, undefined, undefined, undefined, 'browser closed by user');
        }

        if (await isLoggedInOnPage(page)) {
          this.log('✅ 登录成功！');

          const userInfo = await page
            .evaluate(() => {
              const avatarWrap = document.querySelector('.header-avatar-wrap') as HTMLElement | null;
              if (!avatarWrap) return null;
              const link = avatarWrap.querySelector('a');
              const href = link?.getAttribute('href') || '';
              const uidMatch = href.match(/space\.bilibili\.com\/(\d+)/);
              return {
                uid: uidMatch ? uidMatch[1] : null,
                avatarUrl: avatarWrap.querySelector('img')?.getAttribute('src'),
              };
            })
            .catch(() => null);

          this.setState(context, 'isLoggedIn', true);
          this.setState(context, 'userInfo', userInfo);

          return this.finalizeResult(TaskStatus.SUCCESS, { loginMethod: 'qrcode', userInfo, steps: steps.length }, MainState.LOGGED_IN);
        }
      }

      return this.finalizeResult(TaskStatus.FAILURE, undefined, undefined, '登录超时，请在 3 分钟内扫码');
    } catch (error) {
      return this.finalizeResult(TaskStatus.FAILURE, undefined, undefined, `登录失败: ${(error as Error).message}`);
    }
  }
}
