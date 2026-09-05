import type { TaskContext } from '../execute/context';
import { HumanScroller } from '../engine/human-scroller';
import { DEFAULT_BEHAVIOR_CONFIG } from '../engine/config';
import type { HumanBehaviorConfig } from '../engine/config';
import type { Point } from '../engine/mouse-position-manager';
import { BaseBehavior, type BehaviorResult } from './types';

/**
 * 拟人滚动（原子行为：初始爆发 + 惯性衰减 + 停顿细看 + 回滚重看）。
 * 输入为纯参数：mousePos（先把鼠标移到该位置，滚轮触发点，避免滚到错误容器）
 * + distance（实际滚动距离，像素，正=向下，负=向上）。坐标/距离由任务层计算。
 */
export class ScrollBehavior extends BaseBehavior {
  constructor(
    private mousePos: Point,
    private distance: number,
    private config: HumanBehaviorConfig = DEFAULT_BEHAVIOR_CONFIG
  ) {
    super('Scroll');
  }

  async execute(context: TaskContext): Promise<BehaviorResult> {
    await this.awaitReadyIfSustained();
    const page = context.page;
    if (!page) {
      return this.fail('页面未打开');
    }
    try {
      await new HumanScroller(this.config).humanScroll(page, this.mousePos, this.distance);
      return this.ok({ mousePos: this.mousePos, distance: this.distance });
    } catch (error) {
      return this.fail(`滚动失败: ${(error as Error).message}`);
    }
  }
}

/** 一次性滚动到指定 Y 坐标（原子行为） */
export class ScrollToBehavior extends BaseBehavior {
  constructor(private y: number) {
    super('ScrollTo');
  }

  async execute(context: TaskContext): Promise<BehaviorResult> {
    await this.awaitReadyIfSustained();
    const page = context.page;
    if (!page) {
      return this.fail('页面未打开');
    }
    try {
      await new HumanScroller().scrollToPosition(page, this.y);
      return this.ok({ y: this.y });
    } catch (error) {
      return this.fail(`滚动到指定位置失败: ${(error as Error).message}`);
    }
  }
}
