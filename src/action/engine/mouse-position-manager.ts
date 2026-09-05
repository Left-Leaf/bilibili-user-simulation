import type { Page, ElementHandle } from 'puppeteer-core';

/** 视口坐标 */
export interface Point {
  x: number;
  y: number;
}

/** 可解析成坐标的目标：选择器（可能多候选逗号分隔）或元素句柄 */
export type MouseTarget = string | ElementHandle;

/** 目标解析结果 */
export interface MouseResolveResult {
  /** 视口坐标；null 表示无法定位（且未兜底点击） */
  point: Point | null;
  /** true = 已由管理器直接兜底点击完成（深层懒加载无法定位时），调用方无需再触发点击行为 */
  alreadyClicked: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 鼠标位置管理器（单例）。
 *
 * 集中管理两类职责（对应 DESIGN「行为拟人」的鼠标部分）：
 *
 * 1. 鼠标位置记录：当前真实鼠标位置跨 HumanMouse 实例 / 任务共享。
 *    行为（MouseMove/LeftClick 等）每次 new HumanMouse，ghost-cursor 内部
 *    location 初始为 {0,0}——若每次用其作移动起点会从左上角开始（不拟人）。
 *    改为管理器统一记录上次移动终点，使鼠标在屏幕上连续移动。
 *
 * 2. 点击 / 移动目标的位置计算：把目标（selector / ElementHandle）解析成
 *    视口坐标。行为层只接收**纯坐标**，不做目标解析；坐标计算统一在这里：
 *    - selector：多候选逗号分隔时遍历取第一个**可见**元素（避免首个匹配是隐藏元素），
 *      取 boundingBox 中心
 *    - ElementHandle：取 getClientRects() 第一个可见文本块中心（与 puppeteer
 *      clickablePoint 一致——多行文本外接矩形中心可能落在行间空隙/文字外，点到
 *      空白处 B 站不响应导航）；若在视口外 scrollIntoView 滚动重试最多 3 次；
 *      仍无法获得视口内落点（深层懒加载区）→ 直接 handle.click() 兜底。
 */
export class MousePositionManager {
  private static _instance: MousePositionManager | null = null;

  /** 当前真实鼠标位置（默认视口中心近似） */
  private lastPos: Point = { x: 960, y: 540 };

  private constructor() {}

  /** 单例入口 */
  static get instance(): MousePositionManager {
    if (!MousePositionManager._instance) {
      MousePositionManager._instance = new MousePositionManager();
    }
    return MousePositionManager._instance;
  }

  /** 当前真实鼠标位置（副本） */
  getPosition(): Point {
    return { ...this.lastPos };
  }

  /** 记录鼠标新位置（移动到位后调用） */
  setPosition(p: Point): void {
    this.lastPos = { ...p };
  }

  /**
   * 解析目标为视口坐标（供移动 / 点击）。
   * - selector：遍历匹配取第一个可见 boundingBox 中心
   * - ElementHandle：getClientRects 首块中心 + scrollIntoView 滚动重试（最多 3 次）；
   *   仍无法获得视口内落点 → 内部直接 handle.click() 兜底（alreadyClicked=true）
   */
  async resolveTarget(page: Page, target: MouseTarget): Promise<MouseResolveResult> {
    if (typeof target === 'string') {
      return this.resolveSelector(page, target);
    }
    return this.resolveHandlePoint(page, target);
  }

  /**
   * 生成一次「浏览滚动」的参数：**右边缘**安全鼠标位置（滚轮触发点）+ 一屏滚动距离
   * （像素，正=向下；视口高度 × 0.9~1.3，拟人随机）。
   *
   * 真人更倾向于在页面右侧边缘滚动（滚轮/滚动条习惯位置）。但右侧有合集/推荐
   * 等局部滚动容器（B 站合集面板 x 至 ~1849），故取 `x = 视口宽 - 20`（在其右侧），
   * 既符合真人习惯又避开局部滚动容器——无论页面如何垂直滚动，指针所在 x 位置
   * 都不会落在任何局部滚动容器上。
   */
  async browseScrollParams(page: Page): Promise<{ mousePos: Point; distance: number }> {
    const v = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight })).catch(() => ({ w: 1920, h: 800 }));
    return {
      mousePos: { x: v.w - 20, y: Math.round(v.h * 0.4) },
      distance: Math.round(v.h * (0.9 + Math.random() * 0.4)),
    };
  }

  /**
   * 解析「视频卡片封面图」的点击坐标：关闭悬浮弹窗 → 滚动封面图到视口中部 →
   * 在封面图 boundingBox 内**随机取点**（真人不会总点正中心；封面区域大、命中率高，
   * 且不会误点到同卡片的 UP 主页链接 space.bilibili.com）。
   * 悬浮弹窗已由 closeOverlays 关闭，故不存在右下角遮挡问题。
   */
  async resolveCoverClickPoint(page: Page, coverHandle: ElementHandle): Promise<Point | null> {
    // 关闭悬浮弹窗 + 在封面图范围内聚焦校验取点（封面区域大、命中率高）
    await this.closeOverlays(page);
    return this.resolveVerifiedClickPoint(page, coverHandle);
  }

  /** 选择器 → 第一个可见元素 boundingBox 中心 */
  private async resolveSelector(page: Page, selector: string): Promise<MouseResolveResult> {
    const handles = await page.$$(selector).catch(() => [] as ElementHandle[]);
    for (const handle of handles) {
      const box = await handle.boundingBox().catch(() => null);
      if (box && box.width > 0 && box.height > 0) {
        return { point: { x: box.x + box.width / 2, y: box.y + box.height / 2 }, alreadyClicked: false };
      }
    }
    return { point: null, alreadyClicked: false };
  }

  /**
   * ElementHandle → 可点击落点（视口坐标）。
   *
   * **先滚动到视口中部再取落点**：B 站视频页向下滚动时播放器会变成右下角悬浮窗
   * （`.bpx-player-mini-warp` 画中画）与右下角悬浮广告——若落点恰好落在右下角
   * （如 y≈900）会被遮挡导致点击无效（实测 y≈540 安全、y≈900 失败）。
   * 滚动到中部后落点位于安全区。
   *
   * 落点取第一个宽高 ≥1 的 clientRect 块中心（与 puppeteer clickablePoint 一致——
   * 多行文本外接矩形中心可能落在行间空隙/文字外，点到空白处 B 站不响应导航）；
   * 滚动后仍无法获得视口内落点（深层懒加载/重排）→ 重试最多 2 次；
   * 仍失败 → 兜底用 puppeteer 原生 handle.click（内部 scrollIntoViewIfNeeded +
   * clickablePoint，对深层懒加载区更健壮），返回 alreadyClicked=true。
   */
  /**
   * ElementHandle → 可点击落点（视口坐标）。
   *
   * 关闭悬浮弹窗后，用「聚焦校验 + 微调重试」机制定位：真实移动鼠标聚焦到目标上，
   * 等待 hover 稳定后校验该位置点击是否命中目标 <a> 且未被其子交互组件抢夺；
   * 未通过则在目标范围内小幅移动重试。仍无法获得有效落点 → 兜底 puppeteer
   * 原生 handle.click（内部 scrollIntoViewIfNeeded + clickablePoint）。
   */
  private async resolveHandlePoint(page: Page, handle: ElementHandle): Promise<MouseResolveResult> {
    // 先关闭页面上可能遮挡点击目标的悬浮弹窗（mini player 等），再定位目标
    await this.closeOverlays(page);
    // 聚焦校验取点（含滚动到视口中部 + hover 稳定 + 命中目标 <a> 校验 + 微调重试）
    const point = await this.resolveVerifiedClickPoint(page, handle);
    if (point) {
      return { point, alreadyClicked: false };
    }
    // 兜底：无法获得有效落点（深层懒加载/极端布局）→ puppeteer 原生点击
    await handle.click({ delay: 50 }).catch(() => {});
    return { point: null, alreadyClicked: true };
  }

  /**
   * 拟人移动：自研二次贝塞尔逐步移动（与 HumanMouse.visibleMoveTo 的贝塞尔一致），
   * 每步 page.mouse.move + 延迟，丝滑不瞬移；从共享真实位置（上次移动终点）移动到目标。
   * 用于浮层关闭 / 聚焦校验等「需要移动但不触发漫游」的场景（避免漫游干扰校验/拖慢）。
   */
  private async moveBezier(page: Page, to: Point): Promise<void> {
    const from = this.getPosition();
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    if (dist < 2) {
      this.setPosition(to);
      return;
    }
    const ctrl = {
      x: (from.x + to.x) / 2 + (Math.random() - 0.5) * dist * 0.4,
      y: (from.y + to.y) / 2 + (Math.random() - 0.5) * dist * 0.4,
    };
    // 每 ~12px 一步（限 12~70 步），保证轨迹平滑
    const steps = Math.max(12, Math.min(70, Math.round(dist / 12)));
    const speed = 0.8 + Math.random() * 1.2; // px/ms ≈ 800~2000 px/s
    const stepMs = Math.max(3, dist / steps / speed);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = (1 - t) ** 2 * from.x + 2 * (1 - t) * t * ctrl.x + t ** 2 * to.x;
      const y = (1 - t) ** 2 * from.y + 2 * (1 - t) * t * ctrl.y + t ** 2 * to.y;
      await page.mouse.move(x, y).catch(() => {});
      await sleep(stepMs);
    }
    this.setPosition(to);
  }

  /**
   * 解析并校验「点击跳转链接 <a>」的可点击点。
   *
   * 机制（用户要求）：
   * 1. 把目标滚动到视口中部，真实移动鼠标聚焦到目标上
   * 2. 等待一会（hover 稳定，让浮层/子交互组件出现）
   * 3. elementFromPoint 检查：鼠标位置是否命中目标 <a> 本身或其非交互内容，
   *    且未被其子元素中可能存在的交互组件（稍后再看、UP 链接等）抢夺交互
   * 4. 若未聚焦到 <a> 或被拦截 → 在目标元素范围内小幅度移动鼠标，等待后再检查
   * 5. 重复直到命中有效点（最多 6 次）；全失败返回 null（调用方兜底）
   */
  async resolveVerifiedClickPoint(page: Page, handle: ElementHandle): Promise<Point | null> {
    // 滚动目标到视口中部
    await handle.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' })).catch(() => {});
    await sleep(300 + Math.random() * 300);
    const box = await handle.boundingBox().catch(() => null);
    if (!box || box.width <= 0 || box.height <= 0) {
      return null;
    }

    const maxAttempts = 6;
    let x = box.x + box.width / 2;
    let y = box.y + box.height / 2;
    for (let i = 0; i < maxAttempts; i++) {
      // 真实移动鼠标聚焦到该点（拟人贝塞尔移动，非瞬移）
      await this.moveBezier(page, { x, y }).catch(() => {});
      // 等待 hover 稳定（让浮层/子组件出现）
      await sleep(300 + Math.random() * 250);
      // 检查该位置点击后是否命中目标 <a> 且未被其子交互组件影响
      const ok = await handle
        .evaluate(
          (a, pt) => {
            // 目标 <a>：handle 本身或最近祖先链接
            const targetA = a instanceof HTMLAnchorElement ? a : (a.closest('a') as HTMLAnchorElement | null);
            if (!targetA) {
              return false;
            }
            const el = document.elementFromPoint(pt.x, pt.y);
            if (!el) {
              return false;
            }
            // 命中元素的最近 a 必须是目标 a（排除其它链接 / 覆盖浮层 / UP 链接）
            const hitA = el.closest('a');
            if (hitA !== targetA) {
              return false;
            }
            // 排除交互按钮子组件（如「稍后再看」若为 button）
            if (el.tagName === 'BUTTON') {
              return false;
            }
            return true;
          },
          { x, y }
        )
        .catch(() => false);
      if (ok) {
        return { x, y };
      }
      // 未通过 → 在目标元素范围内小幅度移动鼠标（±30~70px，限制在 box 内）
      const jitter = 30 + Math.random() * 40;
      const angle = Math.random() * Math.PI * 2;
      x = Math.min(box.x + box.width - 8, Math.max(box.x + 8, x + Math.cos(angle) * jitter));
      y = Math.min(box.y + box.height - 8, Math.max(box.y + 8, y + Math.sin(angle) * jitter));
    }
    return null;
  }

  /**
   * 关闭页面上可能遮挡点击目标的悬浮弹窗（如 B 站 mini player 画中画窗）。
   * 逐个检测常见悬浮层并点击其关闭按钮（仅关可见的，避免误触页面其它元素）。
   */
  private async closeOverlays(page: Page): Promise<void> {
    const closeSelectors = [
      '.bpx-player-mini-close', // mini player（画中画）关闭按钮
      '.bili-dialog-m .bili-dialog-close, .bili-dialog-close', // B 站对话框
      '.van-popover__close', // van 弹层关闭
    ];
    for (const sel of closeSelectors) {
      const handle = await page.$(sel).catch(() => null);
      if (!handle) {
        continue;
      }
      const visible = await handle
        .evaluate((el) => {
          const s = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) !== 0 && r.width > 0 && r.height > 0;
        })
        .catch(() => false);
      if (!visible) {
        continue;
      }
      // 用真实鼠标点击关闭按钮（拟人）：先把鼠标真实移动到关闭按钮，停顿后再点击
      const box = await handle.boundingBox().catch(() => null);
      if (box) {
        const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        await this.moveBezier(page, center).catch(() => {});
        await sleep(120 + Math.random() * 180);
        await page.mouse.click(center.x, center.y).catch(() => {});
      } else {
        await handle.click().catch(() => {});
      }
      await sleep(250);
      break; // 关闭一个悬浮层即可（通常同时只有一个）
    }
  }
}
