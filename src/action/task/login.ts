import { BaseTask, TaskResult, TaskStatus } from './base';
import type { TaskContext } from '../execute/context';
import { MainState } from '../engine/state';
import { OpenBrowserBehavior, NavigateBehavior, MouseMoveBehavior, LeftClickBehavior, ScanQrBehavior, SleepBehavior } from '../behavior';
import { MousePositionManager } from '../engine/mouse-position-manager';
import { extractLoginQrInfo } from '../behavior/extract-login-qr';
import { convertQrToTerminalString } from '../../utils/terminal-qr';

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

  /** 等待登录弹窗二维码容器出现（扫码行为内部同款判定；供刷新后复用） */
  private async waitQrContainer(page: NonNullable<TaskContext['page']>, timeoutMs = 20000): Promise<void> {
    await page
      .waitForFunction(
        () => {
          const box = document.querySelector('.login-scan-box, .scan-box');
          if (!box) return false;
          if (box.querySelector('canvas')) return true;
          const img = box.querySelector('img');
          return !!img && /^data:image\//.test(img.currentSrc || img.getAttribute('src') || '');
        },
        { timeout: timeoutMs }
      )
      .catch(() => {});
  }

  /** 提取并打印二维码到终端；返回其指纹（内容串，用于比对是否过期/换码） */
  private async printQrCode(page: NonNullable<TaskContext['page']>): Promise<string | null> {
    const qi = await extractLoginQrInfo(page, 8000).catch(() => null);
    const fp = qi ? ('data' in qi ? String(qi.data) : 'url' in qi ? qi.url : null) : null;
    if (qi) {
      const qrText = await convertQrToTerminalString(qi).catch(() => null);
      if (qrText) {
        console.log('\n=== Bilibili 登录二维码 ===\n');
        console.log(qrText);
        console.log('\n请使用手机 Bilibili App 扫码登录。\n');
      } else {
        console.log('\n📱 请在浏览器窗口中扫描二维码完成登录\n');
      }
    }
    return fp;
  }

  /** 探测当前弹窗二维码状态：指纹 + 是否已过期（容器内无有效码且出现失效/刷新字样） */
  private async probeQr(page: NonNullable<TaskContext['page']>): Promise<{ fp: string; expired: boolean }> {
    try {
      return await page.evaluate(() => {
        const box = document.querySelector('.login-scan-box, .scan-box') as HTMLElement | null;
        if (!box) {
          return { fp: '', expired: false };
        }
        const imgs = Array.from(box.querySelectorAll<HTMLImageElement>('img'));
        const qrImg = imgs.find((i) => (i.currentSrc || i.getAttribute('src') || '').startsWith('data:image/'));
        const canvas = box.querySelector('canvas');
        let fp = '';
        if (qrImg) {
          const src = qrImg.currentSrc || qrImg.getAttribute('src') || '';
          fp = src.slice(0, 48) + ':' + src.length;
        } else if (canvas) {
          fp = 'canvas:' + canvas.width + 'x' + canvas.height;
        }
        const text = box.textContent ?? '';
        const expired = !qrImg && !canvas && /失效|过期|刷新|重新获取/.test(text);
        return { fp, expired };
      });
    } catch {
      return { fp: '', expired: false };
    }
  }

  /** 点击弹窗内「刷新二维码」入口（真实鼠标点击中心点）；找不到返回 false */
  private async clickQrRefresh(page: NonNullable<TaskContext['page']>): Promise<boolean> {
    try {
      const pt = (await page.evaluate(() => {
        const box = document.querySelector('.login-scan-box, .scan-box') as HTMLElement | null;
        const root: HTMLElement = box ?? document.body;
        const clickable = Array.from(root.querySelectorAll<HTMLElement>('div,span,a,button,p')).find((e) => {
          const t = (e.textContent ?? '').trim();
          if (!/刷新|重新获取|获取新二维码/.test(t)) return false;
          const r = e.getBoundingClientRect();
          return r.width > 2 && r.height > 2;
        });
        if (!clickable) return null;
        const r = clickable.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })) as { x: number; y: number } | null;
      if (!pt) return false;
      await page.mouse.move(pt.x, pt.y, { steps: 8 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 250));
      await page.mouse.click(pt.x, pt.y).catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  /** 兜底：容器内找不到刷新入口时，回主页重新点登录入口打开新弹窗 */
  private async reopenLoginPopup(context: TaskContext): Promise<void> {
    const page = context.page;
    if (!page) return;
    await new NavigateBehavior('https://www.bilibili.com').execute(context).catch(() => {});
    await new SleepBehavior(1200).execute(context).catch(() => {});
    const entrySelector = LOGIN_ENTRY_SELECTORS.join(', ');
    const resolved = await MousePositionManager.instance.resolveTarget(page, entrySelector).catch(() => null);
    if (resolved?.point && !resolved.alreadyClicked) {
      await new MouseMoveBehavior(resolved.point).execute(context).catch(() => {});
      await new LeftClickBehavior(resolved.point).execute(context).catch(() => {});
    }
    await this.waitQrContainer(page).catch(() => {});
  }

  async execute(context: TaskContext): Promise<TaskResult> {
    // userDataDir/headless 优先取 context.state（bilibili-user-simulation 正式运行注入），否则用构造 options
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

      // 行为7：等待扫码登录（成功或超时）；期间每 ~8s 监听二维码是否过期/换新，
      // 过期则自动刷新（点容器内刷新入口，兜底重开登录弹窗）并重新打印二维码、重置扫码时限
      this.log('⏳ 等待扫码登录…（二维码过期会自动刷新）');
      const page = context.page!;
      let deadline = Date.now() + loginTimeoutMs;
      let lastFp = await this.probeQr(page).then((s) => s.fp);
      let noQrStreak = 0;
      let lastProbeAt = Date.now();
      while (Date.now() < deadline) {
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

        // 二维码过期/换新探测（~8s 一次，避免过频）
        if (Date.now() - lastProbeAt >= 8000) {
          lastProbeAt = Date.now();
          const st = await this.probeQr(page).catch(() => ({ fp: '', expired: false }));
          if (st.fp && st.fp !== lastFp) {
            // 页面自动换新二维码（未显式过期）→ 直接重打
            lastFp = st.fp;
            noQrStreak = 0;
            this.log('📱 检测到二维码已更新，重新打印…');
            await this.printQrCode(page).catch(() => null);
            deadline = Date.now() + loginTimeoutMs;
          } else if (st.expired || (!st.fp && lastFp)) {
            noQrStreak += 1;
            if (noQrStreak >= 2) {
              // 连续两轮无有效二维码/显式过期 → 刷新并重新获取
              noQrStreak = 0;
              this.log('♻️ 二维码已过期，正在刷新并重新获取…');
              const clicked = await this.clickQrRefresh(page).catch(() => false);
              if (!clicked) {
                await this.reopenLoginPopup(context).catch(() => {});
              }
              await this.waitQrContainer(page).catch(() => {});
              const fp2 = await this.printQrCode(page).catch(() => null);
              if (fp2) {
                lastFp = fp2;
                deadline = Date.now() + loginTimeoutMs; // 新二维码重新给足扫码时间
                this.log('✅ 已刷新二维码，请重新扫码登录');
              }
            }
          } else {
            noQrStreak = 0; // 二维码仍有效
          }
        }
      }

      return this.finalizeResult(TaskStatus.FAILURE, undefined, undefined, '登录超时，请在 3 分钟内扫码');
    } catch (error) {
      return this.finalizeResult(TaskStatus.FAILURE, undefined, undefined, `登录失败: ${(error as Error).message}`);
    }
  }
}
