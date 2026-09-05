import type { Browser } from 'puppeteer-core';
import { stealthPuppeteer } from '../engine/stealth';
import type { TaskContext } from '../execute/context';
import { BaseBehavior, type BehaviorResult } from './types';

/** 打开浏览器（原子行为）：用 stealth puppeteer 消除自动化硬指纹（navigator.webdriver 等） */
export class OpenBrowserBehavior extends BaseBehavior {
  constructor(private options: Parameters<typeof stealthPuppeteer.launch>[0] = {}) {
    super('OpenBrowser');
  }

  async execute(context: TaskContext): Promise<BehaviorResult> {
    try {
      const browser = (await stealthPuppeteer.launch({
        headless: false,
        defaultViewport: { width: 1920, height: 1080 },
        ...this.options,
      })) as unknown as Browser;
      context.browser = browser;
      const pages = await browser.pages();
      context.page = pages.length > 0 ? pages[0] : await browser.newPage();
      return this.ok({ headless: this.options?.headless ?? false });
    } catch (error) {
      return this.fail(`打开浏览器失败: ${(error as Error).message}`);
    }
  }
}

/** 导航到指定 URL（原子行为） */
export class NavigateBehavior extends BaseBehavior {
  constructor(
    private url: string,
    private waitUntil: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2' = 'networkidle2',
    private timeout: number = 30000
  ) {
    super('Navigate');
  }

  async execute(context: TaskContext): Promise<BehaviorResult> {
    await this.awaitReadyIfSustained();
    const page = context.page;
    if (!page) {
      return this.fail('页面未打开');
    }
    try {
      await this.sleep(500 + Math.random() * 1000);
      await page.goto(this.url, { waitUntil: this.waitUntil, timeout: this.timeout });
      await this.sleep(500 + Math.random() * 1000);
      return this.ok({ url: page.url(), title: await page.title() });
    } catch (error) {
      return this.fail(`导航 ${this.url} 失败: ${(error as Error).message}`);
    }
  }
}

/** 后退（原子行为） */
export class BackBehavior extends BaseBehavior {
  constructor() {
    super('Back');
  }

  async execute(context: TaskContext): Promise<BehaviorResult> {
    await this.awaitReadyIfSustained();
    if (!context.page) {
      return this.fail('页面未打开');
    }
    try {
      await context.page.goBack({ waitUntil: 'domcontentloaded' });
      return this.ok();
    } catch (error) {
      return this.fail(`后退失败: ${(error as Error).message}`);
    }
  }
}

/** 刷新页面（原子行为） */
export class ReloadBehavior extends BaseBehavior {
  constructor() {
    super('Reload');
  }

  async execute(context: TaskContext): Promise<BehaviorResult> {
    await this.awaitReadyIfSustained();
    if (!context.page) {
      return this.fail('页面未打开');
    }
    try {
      await context.page.reload({ waitUntil: 'domcontentloaded' });
      return this.ok();
    } catch (error) {
      return this.fail(`刷新失败: ${(error as Error).message}`);
    }
  }
}

/** 关闭当前标签页（原子行为） */
export class CloseTabBehavior extends BaseBehavior {
  constructor() {
    super('CloseTab');
  }

  async execute(context: TaskContext): Promise<BehaviorResult> {
    await this.awaitReadyIfSustained();
    if (!context.page) {
      return this.fail('页面未打开');
    }
    try {
      await context.page.close();
      context.page = null;
      return this.ok();
    } catch (error) {
      return this.fail(`关闭标签页失败: ${(error as Error).message}`);
    }
  }
}

/** 关闭浏览器（原子行为） */
export class CloseBrowserBehavior extends BaseBehavior {
  constructor() {
    super('CloseBrowser');
  }

  async execute(context: TaskContext): Promise<BehaviorResult> {
    if (!context.browser) {
      return this.ok({ already: true });
    }
    try {
      await context.browser.close();
      context.browser = null;
      context.page = null;
      return this.ok();
    } catch (error) {
      return this.fail(`关闭浏览器失败: ${(error as Error).message}`);
    }
  }
}
