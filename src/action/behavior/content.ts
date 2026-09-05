import type { TaskContext } from '../execute/context';
import { BaseBehavior, type BehaviorResult } from './types';
import { MousePositionManager } from '../engine/mouse-position-manager';
import { HumanMouse } from '../engine/human-mouse';

/** 观看视频（原子行为）：确保进入视频页并观看一段时间 */
export class WatchBehavior extends BaseBehavior {
  constructor(
    private minDuration = 10000,
    private maxDuration = 60000
  ) {
    super('Watch');
  }

  async execute(context: TaskContext): Promise<BehaviorResult> {
    await this.awaitReadyIfSustained();
    const page = context.page;
    if (!page) {
      return this.fail('页面未打开');
    }
    try {
      // 若当前不在视频页，先找一个视频链接进入
      if (!page.url().includes('/video/')) {
        const links = await page
          .$$eval('a[href*="/video/"]', (list) => list.slice(0, 10).map((a) => (a as HTMLAnchorElement).href))
          .catch(() => [] as string[]);
        if (links.length === 0) {
          return this.fail('当前页面没有视频可观看');
        }
        await page.goto(links[Math.floor(Math.random() * links.length)], {
          waitUntil: 'domcontentloaded',
        });
        await this.sleep(1500 + Math.random() * 1500);
      }

      const title = await page.evaluate(() => document.title).catch(() => 'Unknown');
      const duration = this.minDuration + Math.random() * (this.maxDuration - this.minDuration);
      console.log(`   观看视频: ${title}（${(duration / 1000).toFixed(1)}s）`);

      // 观看期间偶尔滚动（看评论区/推荐）
      const checkInterval = 5000;
      const checks = Math.floor(duration / checkInterval);
      for (let i = 0; i < checks; i++) {
        await this.sleep(checkInterval);
        if (Math.random() < 0.3) {
          await page.evaluate(() => window.scrollBy({ top: 200 + Math.random() * 300, behavior: 'smooth' })).catch(() => {});
        }
      }
      const remaining = duration - checks * checkInterval;
      if (remaining > 0) {
        await this.sleep(remaining);
      }

      return this.ok({ title, duration });
    } catch (error) {
      return this.fail(`观看失败: ${(error as Error).message}`);
    }
  }
}

/** 搜索（原子行为）：进入 B 站搜索页并搜索关键词 */
export class SearchBehavior extends BaseBehavior {
  constructor(private keyword: string) {
    super('Search');
  }

  async execute(context: TaskContext): Promise<BehaviorResult> {
    const page = context.page;
    if (!page) {
      return this.fail('页面未打开');
    }
    try {
      await page.goto(`https://search.bilibili.com/all?keyword=${encodeURIComponent(this.keyword)}`, { waitUntil: 'domcontentloaded' });
      await this.sleep(1000 + Math.random() * 1500);
      return this.ok({ keyword: this.keyword });
    } catch (error) {
      return this.fail(`搜索失败: ${(error as Error).message}`);
    }
  }
}

/** 输入文字（原子行为，可先点击输入框） */
export class TypeBehavior extends BaseBehavior {
  constructor(
    private text: string,
    private selector?: string
  ) {
    super('Type');
  }

  async execute(context: TaskContext): Promise<BehaviorResult> {
    await this.awaitReadyIfSustained();
    const page = context.page;
    if (!page) {
      return this.fail('页面未打开');
    }
    try {
      if (this.selector) {
        // 点击输入框聚焦：先真实移动鼠标到输入框，停顿后再点击（不瞬移）
        const resolved = await MousePositionManager.instance
          .resolveTarget(page, this.selector)
          .catch(() => ({ point: null, alreadyClicked: false }));
        if (resolved.point) {
          const mouse = new HumanMouse(page);
          await mouse.visibleMoveTo(resolved.point);
          await new Promise((r) => setTimeout(r, 120 + Math.random() * 280));
          await page.mouse.click(resolved.point.x, resolved.point.y);
        }
        // resolved.alreadyClicked=true → resolveTarget 内部已 handle.click 兜底点击
      }
      await page.keyboard.type(this.text, { delay: 50 + Math.random() * 150 });
      return this.ok({ text: this.text });
    } catch (error) {
      return this.fail(`输入失败: ${(error as Error).message}`);
    }
  }
}

/** 按键（原子）：按下单个键（Enter / Escape / Tab / Ctrl+W / 方向键等） */
export class KeyPressBehavior extends BaseBehavior {
  constructor(
    private key: string,
    private count = 1
  ) {
    super('KeyPress');
  }

  async execute(context: TaskContext): Promise<BehaviorResult> {
    await this.awaitReadyIfSustained();
    const page = context.page;
    if (!page) {
      return this.fail('页面未打开');
    }
    try {
      for (let i = 0; i < this.count; i++) {
        await page.keyboard.press(this.key as never);
        await this.sleep(100 + Math.random() * 200);
      }
      return this.ok({ key: this.key, count: this.count });
    } catch (error) {
      return this.fail(`按键失败: ${(error as Error).message}`);
    }
  }
}
