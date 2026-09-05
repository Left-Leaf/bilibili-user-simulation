import type { Page, ElementHandle } from 'puppeteer-core';
import ghostModule, { type GhostCursor } from 'ghost-cursor';
import type { HumanBehaviorConfig } from './config';
import { DEFAULT_BEHAVIOR_CONFIG } from './config';
import { MousePositionManager } from './mouse-position-manager';

// ghost-cursor 的类型基于 puppeteer（与 puppeteer-core 的 Page/ElementHandle 存在 #private 差异，运行时等价）。
// 兼容双环境：Node ESM 下 default=模块导出；jest(CommonJS) 下 __importDefault 包成 { default }。
type Vector = { x: number; y: number };
const ghost = ((ghostModule as unknown as { default?: typeof ghostModule })?.default ?? ghostModule) as unknown as typeof ghostModule;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const sampleRange = ([min, max]: [number, number]): number => min + Math.random() * (max - min);

// 真实鼠标位置由 MousePositionManager 单例统一记录（跨 HumanMouse 实例 / 任务共享）。
// 行为（MouseMove/LeftClick 等）每次 new HumanMouse，新 ghost-cursor 实例 location 初始 {0,0}
// （左上角）——若每次用 cursor.getLocation() 作移动起点会从左上角开始（不符合真人）。
// 由管理器记录上次移动终点，使鼠标在屏幕上连续移动。

/** 是否启用鼠标轨迹可视化（全局开关，测试时有头观察用） */
let showMouseTrail = false;

/** 启用/禁用鼠标轨迹可视化（注入跟随鼠标的圆圈，当前页立即生效） */
export function setMouseTrailVisible(enabled: boolean): void {
  showMouseTrail = enabled;
}

/** 向当前页注入鼠标轨迹可视化（立即生效，无需新导航） */
async function injectMouseTrail(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      if (document.querySelector('p-mouse-pointer')) {
        return; // 已注入
      }
      const box = document.createElement('p-mouse-pointer');
      const style = document.createElement('style');
      style.innerHTML = `
        p-mouse-pointer {
          pointer-events: none; position: absolute; top: 0; left: 0; z-index: 100000;
          width: 20px; height: 20px; background: rgba(255, 80, 0, .55);
          border: 2px solid #fff; border-radius: 10px; box-sizing: border-box;
          margin: -10px 0 0 -10px; transition: background .15s;
        }
        p-mouse-pointer.down { background: rgba(255, 0, 0, .9); }
      `;
      document.head.appendChild(style);
      document.body.appendChild(box);
      const move = (e: MouseEvent) => {
        box.style.left = `${e.pageX}px`;
        box.style.top = `${e.pageY}px`;
        box.classList.toggle('down', e.buttons > 0);
      };
      document.addEventListener('mousemove', move, true);
      document.addEventListener('mousedown', () => box.classList.add('down'), true);
      document.addEventListener('mouseup', () => box.classList.remove('down'), true);
      (window as unknown as { __removeMouseTrail?: () => void }).__removeMouseTrail = () => {
        document.removeEventListener('mousemove', move, true);
        box.remove();
        style.remove();
      };
    })
    .catch(() => {});
}

/**
 * 拟人鼠标（封装 ghost-cursor）：贝塞尔移动 + 发呆漫游 + 点错 + 双击。
 * 对应 DESIGN 6.4.1。
 */
export class HumanMouse {
  private cursor: GhostCursor;
  private config: HumanBehaviorConfig;
  private page: Page;

  constructor(page: Page, config: HumanBehaviorConfig = DEFAULT_BEHAVIOR_CONFIG) {
    this.page = page;
    // 关键：ghost-cursor 初始 location 直接用共享真实位置（上次移动终点/视口中心近似），
    // 而非 {0,0}——否则新实例内部 location 从左上角开始，校准/漫游都会从左上角产生可见移动。
    // start 指定初始位置；不启用 performRandomMoves（后台持续漫游会与任务移动并发冲突），
    // 漫游在移动前按需用 toggleRandomMove 短暂触发（见 wanderAround，ghost-cursor 自带漫游）
    this.cursor = ghost.createCursor(page as never, MousePositionManager.instance.getPosition(), false);
    this.config = config;
    if (showMouseTrail) {
      // 立即注入鼠标轨迹可视化（跟随鼠标的圆圈 + 点击反馈）
      void injectMouseTrail(page).catch(() => {});
    }
    // 保险：确保 ghost-cursor 内部 location 与共享真实位置一致（通常已相等，不产生移动）
    void this.syncCursorLocation().catch(() => {});
  }

  /** 同步 ghost-cursor 内部 location 到共享真实位置（直接写 private location 字段，避免 moveTo 产生额外鼠标移动） */
  private async syncCursorLocation(): Promise<void> {
    const pos = MousePositionManager.instance.getPosition();
    const loc = this.cursor.getLocation();
    if (loc.x !== pos.x || loc.y !== pos.y) {
      // 直接写内部 location（绕过 moveTo：moveTo 会真实移动鼠标，可能触发页面 hover 浮层干扰后续点击）
      (this.cursor as unknown as { location: Vector }).location = pos;
    }
  }

  /** 底层 cursor（需要精细控制时使用） */
  get raw(): GhostCursor {
    return this.cursor;
  }

  getLocation(): Vector {
    // 返回真实鼠标位置（跨实例共享），而非 ghost-cursor 内部 location（新实例恒为 {0,0}）
    return MousePositionManager.instance.getPosition();
  }

  /**
   * 带超时保护的 Promise：ghost-cursor 在 headless 下可能因 CDP 响应丢失永久挂起，
   * 超时后 resolve false 让调用方走兜底（page.mouse 直接移动）。
   */
  private async withTimeout<T>(p: Promise<T>, timeoutMs = 3000): Promise<boolean> {
    return Promise.race([p.then(() => true).catch(() => true), sleep(timeoutMs).then(() => false)]);
  }

  /**
   * 拟人移动：自研二次贝塞尔逐步移动（不用 ghost-cursor 的 moveTo——其路径点通过 CDP 瞬间
   * dispatch，moveDelay 只作用于移动末尾，导致瞬移/跳断）。这里自己按贝塞尔弧线生成步进点，
   * 每步 page.mouse.move + 延迟，完全控制速度（丝滑、不跳断），并保留拟人弧线/变速。
   * 移动前小概率触发 ghost-cursor 自带漫游（真人鼠标闲逛后移向目标）。
   * 起点：直接取 MousePositionManager 共享真实位置（跨实例最后移动终点）——
   * 而不是 ghost-cursor 内部 location（新实例虽用共享位置初始化，但漫游/同步时序可能脱节）。
   */
  async visibleMoveTo(point: Vector): Promise<void> {
    // 起点 = 管理器共享真实位置（上次移动终点 / 首次视口中心近似），保证从鼠标最后位置开始
    let from = MousePositionManager.instance.getPosition();
    // 移动前小概率漫游（真人会闲逛/犹豫再移动）——用 ghost-cursor 自带漫游
    if (Math.random() < 0.15) {
      // 漫游前先把 ghost-cursor 内部位置同步到共享位置（漫游从正确起点开始，而非脱节位置）
      await this.syncCursorLocation();
      await this.wanderAround(400 + Math.random() * 900);
      // 漫游会移动真实鼠标：终点取 ghost-cursor 跟踪位置，并同步回共享位置（供下次移动起点）
      from = this.cursor.getLocation();
      MousePositionManager.instance.setPosition(from);
    }
    await this.moveBezier(from, point);
    MousePositionManager.instance.setPosition(point);
    // 同步 ghost-cursor 内部位置：直接写 location 字段（而非 cursor.moveTo——moveTo 会在贝塞尔移动后
    // 再产生一次真实鼠标移动，可能触发页面 hover 浮层（如「稍后再看」）覆盖目标，导致后续点击落空）
    (this.cursor as unknown as { location: Vector }).location = point;
  }

  /** 自研二次贝塞尔逐步移动：拟人弧线（控制点随机偏移）+ 真人速度（0.8~2 px/ms） */
  private async moveBezier(from: Vector, to: Vector): Promise<void> {
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    if (dist < 2) {
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
      await this.page.mouse.move(x, y).catch(() => {});
      await sleep(stepMs);
    }
  }

  /** 用 ghost-cursor 自带漫游（randomMove）：鼠标无目的移动一小段（真人闲逛），随后停止 */
  private async wanderAround(durationMs: number): Promise<void> {
    this.cursor.toggleRandomMove(true);
    await sleep(durationMs);
    this.cursor.toggleRandomMove(false);
    await sleep(120); // 等待漫游递归停止
  }

  /** 拟人化移动并点击（可能漫游/点错/双击） */
  async humanClick(page: Page, target: string | ElementHandle): Promise<void> {
    const err = this.config.errorRate;

    // 可能发呆漫游（5%）
    if (Math.random() < err.idleWanderProb) {
      await this.idleWander();
    }

    // 可能点错（1%）：点偏后按 Esc 修正
    const misclicked = await this.maybeMisclick(page, target);
    if (misclicked) {
      await sleep(300 + Math.random() * 800); // 反应延迟
    }

    const clicked = await this.withTimeout(
      this.cursor.click(target as never, {
        hesitate: 200 + Math.random() * 600,
        waitForClick: 50 + Math.random() * 150,
      })
    );
    if (!clicked) {
      // 兜底：用 page.mouse 直接点击目标中心
      try {
        const handle = typeof target === 'string' ? await this.page.$(target) : target;
        const box = await handle?.boundingBox();
        if (box) {
          await this.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        }
      } catch {
        /* 忽略兜底失败 */
      }
    }
    await sleep(50 + Math.random() * 150);

    // 可能手抖双击（2%）
    await this.maybeDoubleClick(target);
  }

  /** 发呆漫游：用 ghost-cursor 自带漫游（randomMove，页面随机点无目的移动），持续 config 指定时长 */
  async idleWander(): Promise<void> {
    const duration = sampleRange(this.config.errorRate.idleWanderDurationMs);
    await this.wanderAround(duration);
  }

  /** 点错：1% 概率点到目标附近偏移处，再按 Esc */
  private async maybeMisclick(page: Page, target: string | ElementHandle): Promise<boolean> {
    if (Math.random() > this.config.errorRate.misclickProb) {
      return false;
    }

    let box: Awaited<ReturnType<ElementHandle['boundingBox']>> | undefined;
    try {
      const handle = typeof target === 'string' ? await page.$(target) : target;
      box = await handle?.boundingBox();
    } catch {
      return false;
    }
    if (!box) {
      return false;
    }

    const wrongX = box.x + box.width * (0.2 + Math.random() * 1.3);
    const wrongY = box.y + box.height * (0.2 + Math.random() * 1.3);
    const done = await this.withTimeout(this.cursor.moveTo({ x: wrongX, y: wrongY }));
    if (!done) {
      await this.page.mouse.move(wrongX, wrongY).catch(() => {});
    }
    await this.withTimeout(this.cursor.click());

    // 反应 + 关闭弹窗/退回
    await page.keyboard.press('Escape').catch(() => {});
    return true;
  }

  /** 手抖双击：2% 概率在第一次点击后再点一次 */
  private async maybeDoubleClick(target: string | ElementHandle): Promise<void> {
    if (Math.random() >= this.config.errorRate.doubleClickProb) {
      return;
    }
    await sleep(50 + Math.random() * 150);
    await this.withTimeout(this.cursor.click(target as never));
  }
}
