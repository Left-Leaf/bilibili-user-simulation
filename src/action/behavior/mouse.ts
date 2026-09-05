import type { Page } from 'puppeteer-core';
import type { TaskContext } from '../execute/context';
import { HumanMouse, setMouseTrailVisible } from '../engine/human-mouse';
import { DEFAULT_BEHAVIOR_CONFIG } from '../engine/config';
import type { HumanBehaviorConfig } from '../engine/config';
import { BaseBehavior, type BehaviorResult } from './types';
import type { Point } from '../engine/mouse-position-manager';

// 复用导出：启用/禁用鼠标轨迹可视化（有头观察用）
export { setMouseTrailVisible };
// 坐标类型由 MousePositionManager 统一管理（行为只接收纯坐标）
export type { Point };

/**
 * 鼠标物理动作（基本动作单元）。
 *
 * 本文件只包含鼠标自身的物理操作：移动 / 左键单击 / 右键单击 / 双击 / 长按 / 悬停。
 *
 * **输入统一为纯视口坐标（Point）**：目标（selector / ElementHandle）→ 坐标的解析
 * （含可见性遍历、多行文本落点 getClientRects、scrollIntoView 滚动重试、深层懒加载
 * handle.click 兜底）由 MousePositionManager 完成，在任务层解析好后传入。
 * 行为层不再关心 DOM 定位，只做拟人物理动作。
 */

/** 鼠标移动（纯移动，原子） */
export class MouseMoveBehavior extends BaseBehavior {
  constructor(
    private point: Point,
    private config: HumanBehaviorConfig = DEFAULT_BEHAVIOR_CONFIG
  ) {
    super('MouseMove');
  }

  async execute(context: TaskContext): Promise<BehaviorResult> {
    await this.awaitReadyIfSustained();
    const page = context.page;
    if (!page) {
      return this.fail('页面未打开');
    }
    try {
      const mouse = new HumanMouse(page, this.config);
      await mouse.visibleMoveTo(this.point);
      return this.ok({ x: this.point.x, y: this.point.y });
    } catch (error) {
      return this.fail(`鼠标移动失败: ${(error as Error).message}`);
    }
  }
}

/** 左键单击（原子） */
export class LeftClickBehavior extends BaseBehavior {
  constructor(
    private point: Point,
    private config: HumanBehaviorConfig = DEFAULT_BEHAVIOR_CONFIG
  ) {
    super('LeftClick');
  }

  async execute(context: TaskContext): Promise<BehaviorResult> {
    await this.awaitReadyIfSustained();
    const page = context.page;
    if (!page) {
      return this.fail('页面未打开');
    }
    try {
      const mouse = new HumanMouse(page, this.config);
      // 点击前 hover 停顿：真人移到目标上会先停一下再点（也留时间给页面 hover 绑定/卡片展开）
      await mouse.visibleMoveTo(this.point);
      await new Promise((r) => setTimeout(r, 120 + Math.random() * 280));
      await page.mouse.click(this.point.x, this.point.y);
      return this.ok({ x: this.point.x, y: this.point.y });
    } catch (error) {
      return this.fail(`左键点击失败: ${(error as Error).message}`);
    }
  }
}

/** 右键单击（原子） */
export class RightClickBehavior extends BaseBehavior {
  constructor(private point: Point) {
    super('RightClick');
  }

  async execute(context: TaskContext): Promise<BehaviorResult> {
    await this.awaitReadyIfSustained();
    const page = context.page;
    if (!page) {
      return this.fail('页面未打开');
    }
    try {
      const mouse = new HumanMouse(page);
      await mouse.visibleMoveTo(this.point);
      await page.mouse.click(this.point.x, this.point.y, { button: 'right' });
      return this.ok({ x: this.point.x, y: this.point.y });
    } catch (error) {
      return this.fail(`右键点击失败: ${(error as Error).message}`);
    }
  }
}

/** 双击（原子） */
export class DoubleClickBehavior extends BaseBehavior {
  constructor(private point: Point) {
    super('DoubleClick');
  }

  async execute(context: TaskContext): Promise<BehaviorResult> {
    await this.awaitReadyIfSustained();
    const page = context.page;
    if (!page) {
      return this.fail('页面未打开');
    }
    try {
      const mouse = new HumanMouse(page);
      await mouse.visibleMoveTo(this.point);
      await page.mouse.click(this.point.x, this.point.y, { clickCount: 2, delay: 80 + Math.random() * 120 });
      return this.ok({ x: this.point.x, y: this.point.y });
    } catch (error) {
      return this.fail(`双击失败: ${(error as Error).message}`);
    }
  }
}

/** 长按（原子：按下-保持-松开） */
export class PressHoldBehavior extends BaseBehavior {
  constructor(
    private point: Point,
    private holdMs = 600
  ) {
    super('PressHold');
  }

  async execute(context: TaskContext): Promise<BehaviorResult> {
    await this.awaitReadyIfSustained();
    const page = context.page;
    if (!page) {
      return this.fail('页面未打开');
    }
    try {
      const mouse = new HumanMouse(page);
      await mouse.visibleMoveTo(this.point);
      await page.mouse.down();
      await this.sleep(this.holdMs);
      await page.mouse.up();
      return this.ok({ holdMs: this.holdMs });
    } catch (error) {
      return this.fail(`长按失败: ${(error as Error).message}`);
    }
  }
}

/** 悬停（原子：移动到位并停住，不点击） */
export class HoverBehavior extends BaseBehavior {
  constructor(
    private point: Point,
    private config: HumanBehaviorConfig = DEFAULT_BEHAVIOR_CONFIG,
    private dwellMs = 800 + Math.random() * 1500
  ) {
    super('Hover');
  }

  async execute(context: TaskContext): Promise<BehaviorResult> {
    await this.awaitReadyIfSustained();
    const page = context.page;
    if (!page) {
      return this.fail('页面未打开');
    }
    try {
      const mouse = new HumanMouse(page, this.config);
      await mouse.visibleMoveTo(this.point);
      await this.sleep(this.dwellMs);
      return this.ok({ dwellMs: this.dwellMs });
    } catch (error) {
      return this.fail(`悬停失败: ${(error as Error).message}`);
    }
  }
}
