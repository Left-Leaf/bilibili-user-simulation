import type { Page } from 'puppeteer-core';
import type { HumanBehaviorConfig } from './config';
import { DEFAULT_BEHAVIOR_CONFIG } from './config';
import { MousePositionManager, type Point } from './mouse-position-manager';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** CDP 超时保护：ghost-cursor 式永久挂起的兜底（wheel 响应丢失时 resolve false，调用方继续） */
function withTimeout<T>(p: Promise<T>, timeoutMs = 3000): Promise<boolean> {
  return Promise.race([p.then(() => true).catch(() => true), sleep(timeoutMs).then(() => false)]);
}

/**
 * 拟人滚动：用**真实鼠标滚轮事件**（page.mouse.wheel）滚动，浏览器原生处理，
 * 无 scrollTop 直改的抖动；初始爆发 + 惯性衰减 + 滚动中停顿细看 + 回滚重看。
 * 对应 DESIGN 6.4.2。
 * 所有 wheel 调用带 CDP 超时保护（防响应丢失永久挂起卡死任务）。
 */
export class HumanScroller {
  private config: HumanBehaviorConfig;

  constructor(config: HumanBehaviorConfig = DEFAULT_BEHAVIOR_CONFIG) {
    this.config = config;
  }

  /**
   * 拟人滚动：给定「滚轮触发的鼠标位置」与「滚动距离」，用真实鼠标滚轮事件
   * （page.mouse.wheel）滚动，浏览器原生处理，无 scrollTop 直改的抖动。
   *
   * - mousePos：先把鼠标移到该位置（滚轮触发点）。调用方负责传安全位置
   *   （如页面左边缘，远离右侧合集/推荐等局部滚动容器），避免滚轮滚到错误容器。
   * - distance：实际滚动距离（像素，正=向下，负=向上）。
   *
   * 初始爆发（前 40% 距离）+ 惯性衰减（剩余 60%，逐步减小 deltaY）+
   * 滚动中停顿细看 + 回滚重看。对应 DESIGN 6.4.2。
   * 所有 wheel 调用带 CDP 超时保护（防响应丢失永久挂起卡死任务）。
   */
  async humanScroll(page: Page, mousePos: Point, distance: number): Promise<void> {
    // 先把鼠标移到传入位置（滚轮触发点，多步插值非瞬移），并同步到管理器（供下次移动作起点）
    await page.mouse.move(mousePos.x, mousePos.y, { steps: 12 }).catch(() => {});
    MousePositionManager.instance.setPosition(mousePos);

    const behavior = this.config.behavior;
    const sign = Math.sign(distance) || 1;
    const absTotal = Math.abs(distance);

    // 初始爆发（前 40% 距离，多个滚轮事件，间隔短）
    const burstDist = absTotal * 0.4;
    await this.wheelBurst(page, burstDist * sign);

    // 惯性衰减：剩余 60% 距离，逐步减小每次滚轮 deltaY
    let remaining = absTotal * 0.6;
    let velocity = 80 + Math.random() * 40; // 初始步长 px
    const minStep = 8;

    // 整体时长上限（CDP 挂起/页面卡死时兜底，避免任务永久卡住）
    const scrollDeadline = Date.now() + 15000;
    while (remaining > minStep && velocity > minStep && Date.now() < scrollDeadline) {
      const deltaY = Math.min(velocity, remaining) * sign;
      await withTimeout(page.mouse.wheel({ deltaY }));
      remaining -= Math.abs(deltaY);
      velocity *= 0.85 + Math.random() * 0.08; // 摩擦衰减
      await sleep(18 + Math.random() * 22);

      // 滚动中可能停下细看
      if (Math.random() < behavior.scrollPauseProb / 60) {
        const pauseMs = 500 + Math.random() * 3000;
        await sleep(pauseMs);
        velocity *= 1.4; // 重新开始会稍快一些
      }

      // 可能回滚重看
      if (Math.random() < behavior.scrollBackProb / 120) {
        await withTimeout(page.mouse.wheel({ deltaY: -(50 + Math.random() * 150) * sign }));
        await sleep(400 + Math.random() * 1200);
      }
    }
  }

  /** 一次性滚动到指定位置（供外部调用） */
  async scrollToPosition(page: Page, y: number): Promise<void> {
    // 确保滚轮事件作用在页面主体（而非局部滚动容器）
    await this.ensureWheelOnPage(page);
    // 用真实滚轮事件分步滚到目标（避免直改 scrollTop 抖动）
    const current = await page.evaluate(() => document.documentElement.scrollTop || window.scrollY || 0).catch(() => 0);
    const diff = y - current;
    const steps = Math.max(1, Math.round(Math.abs(diff) / 200));
    for (let i = 0; i < steps; i += 1) {
      await withTimeout(page.mouse.wheel({ deltaY: diff / steps }));
      await sleep(12 + Math.random() * 18);
    }
  }

  /**
   * 拟人向上滚动回页面顶部（真人浏览完往下看后，会自然滚回顶部/初始位置；
   * 视频页滚动看简介/评论区后，滚回视频位置继续观看）。
   * 同样用真实滚轮事件分步上滚，带中途停顿；到顶（scrollTop≈0）即停。
   */
  async scrollBackToTop(page: Page): Promise<void> {
    const behavior = this.config.behavior;
    // 确保滚轮事件作用在页面主体（而非局部滚动容器）
    await this.ensureWheelOnPage(page);
    // 当前滚动位置
    const current = await page.evaluate(() => document.documentElement.scrollTop || window.scrollY || 0).catch(() => 0);
    if (current < 20) {
      return; // 已在顶部附近，无需回滚
    }
    const deadline = Date.now() + 8000; // 回滚总时长上限（CDP 挂起/页面卡死兜底）
    while (Date.now() < deadline) {
      const top = await page.evaluate(() => document.documentElement.scrollTop || window.scrollY || 0).catch(() => 0);
      if (top < 20) {
        break; // 已回到顶部
      }
      // 向上滚动一屏内的量（避免一步回顶的机械感），带 CDP 超时保护
      const deltaY = -Math.min(600, top);
      await withTimeout(page.mouse.wheel({ deltaY }));
      await sleep(24 + Math.random() * 36);

      // 回滚中可能停顿（真人上滚偶尔停一下）
      if (Math.random() < behavior.scrollPauseProb / 60) {
        const pauseMs = 300 + Math.random() * 1200;
        await sleep(pauseMs);
      }
    }
  }

  /** 初始爆发滚动：连续真实滚轮事件 */
  private async wheelBurst(page: Page, totalDeltaY: number): Promise<void> {
    const steps = 6 + Math.floor(Math.random() * 6);
    const per = totalDeltaY / steps;
    for (let i = 0; i < steps; i += 1) {
      await withTimeout(page.mouse.wheel({ deltaY: per }));
      await sleep(20 + Math.random() * 30);
    }
  }

  /**
   * 确保滚轮事件作用在页面主体，而非局部滚动容器。
   *
   * 问题：视频页为合集（多 P）时，右侧有合集面板（`.video-pod` → `.video-pod__body`，
   * 内部 `.video-pod__list.section`，是独立滚动容器，overflow-y:auto）。滚轮事件的
   * 目标由**鼠标指针位置**决定——指针悬停在合集列表上时滚轮滚动合集而非整个页面；
   * 且页面垂直滚动时合集容器会随内容移动，可能在滚动中途进入指针区域，
   * 导致「滚着滚着突然开始滚合集」。
   *
   * 处理：**滚动前把鼠标固定在页面右边缘安全区**（`x = 视口宽 - 20`）。真人更倾向在
   * 右侧边缘滚动；且 B 站合集/推荐容器 x 至 ~1849，右边缘在其右侧——无论页面如何
   * 垂直滚动，指针所在的 x 位置都不会落在任何局部滚动容器上，滚轮始终作用于页面
   * 主体。移动后同步 MousePositionManager（保持鼠标位置连续，供下次移动作起点）。
   */
  private async ensureWheelOnPage(page: Page): Promise<void> {
    // 页面右边缘安全区（x = 视口宽 - 20，在右侧合集/推荐容器之外；y 取视口中部偏上）
    const target = await page
      .evaluate(() => ({ x: window.innerWidth - 20, y: Math.round(window.innerHeight * 0.4) }))
      .catch(() => ({ x: 1900, y: 400 }));
    // 多步插值移动（非瞬移），确保滚轮事件作用在页面主体后同步位置
    await page.mouse.move(target.x, target.y, { steps: 12 }).catch(() => {});
    MousePositionManager.instance.setPosition(target);
  }
}
