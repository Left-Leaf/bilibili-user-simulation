/**
 * SimulationKernel：全局静态单一实例「内核类」。
 *
 * 对外只暴露六类能力：
 *   1. 生命周期：`initialize()`（选择浏览器启动方式等）/ `destroy()`（清除初始化信息、关闭浏览器、释放内存）
 *   2. 人格配置：`loadPersona()`（运行态热替换）/ `listPersonas()`
 *   3. 模拟行为：`startSimulation()` / `stopSimulation()`（控制任务生成器与执行器；**无暂停态**）
 *   4. 动态获取：`startFetch()`（打开动态页并监听更新）/ `stopFetch()`（取消监听并关闭标签页）
 *   5. 动态监听器：`createDynamicListener(cb)` → 订阅器（`cancel()` 取消订阅）
 *   6. 登录：`login()` / `logout()`（扫码二维码除打印到控制台外，可按 `onQrcode` 回调对外输出）
 *   （另有 `followUp()` 主动关注 UP，独立于任务流）
 *
 * ```ts
 * import { kernel } from 'bilibili-user-simulation';
 *
 * await kernel.initialize({ headless: true, personaId: 'ak-night-worker' }); // ① 初始化
 * const sub = kernel.createDynamicListener((items, kind) => {});             // ② 订阅动态
 * // 扫码二维码对外输出（可选）：initialize({ …, onQrcode }) 或 login({ onQrcode })
 * await kernel.startFetch();        // ③ 打开动态获取
 * await kernel.startSimulation();   // ④ 打开模拟行为
 * ...
 * sub.cancel();
 * await kernel.stopSimulation();
 * await kernel.stopFetch();
 * await kernel.destroy();           // ⑤ 销毁
 * ```
 *
 * 语义要点：
 * - `initialize()` 只做「开浏览器 + 确保登录」，不启动任何功能（登录态有效时自动跳过扫码）；
 * - `startSimulation()/stopSimulation()` 与 `startFetch()/stopFetch()` **互不影响**，可任意组合；
 * - 模拟行为只有「从零启动」与「彻底结束」两种状态，**没有暂停**；
 * - `stopSimulation()` 阻塞生成器 + 请求持续式任务收尾，等最后一个任务跑完后关闭不再需要的页面
 *   （蹲饼未开 → 页面全关；蹲饼开着 → 只留蹲饼用的动态页）；
 * - `stopFetch()` 取消监听并关闭动态页标签，并**返回本次蹲饼的最终基线**（秒时间戳），
 *   宿主应保存它并在下次 `startFetch({ baselineTs })` 传回；
 * - 进程内只有一份蹲饼状态（passive-fetch 模块级单例）与一份浏览器会话，天然与内核单例对应。
 */
import path from 'node:path';
import { createContext, type TaskContext } from '../action/execute/context.js';
import { OpenBrowserBehavior, NavigateBehavior } from '../action/behavior/navigation.js';
import { LoginTask } from '../action/task/login.js';
import { LogoutTask } from '../action/task/logout.js';
import { TaskExecutor } from '../action/execute/executor.js';
import { PersonaDrivenGenerator, type GeneratorControl } from '../action/generate/persona-generator.js';
import { DEFAULT_PERSONA_DIR, listPersonas as scanPersonaDir, loadPersona, loadPersonaFromFile, type PersonaEntry } from '../persona/loader.js';
import type { PersonaConfig } from '../persona/types.js';
import {
  ensureDynamicPage,
  findDynamicPage,
  getFetchBaseline,
  setDynamicListener,
  setFetchBaseline,
  setFetchEnabled,
  waitForFetchIdle,
  waitForInitialFetch,
} from '../business/passive-fetch.js';
import type { BiliDynamicItem, DynamicListener, InitialFetchOutcome } from '../business/passive-fetch.js';
import { EXCLUSIVE_TASKS, fetchCoordinator } from '../business/fetch-coordinator.js';
import { setLoginQrHandler } from '../business/login-qr.js';
import type { LoginQrHandler, LoginQrPayload } from '../business/login-qr.js';
import { followUpOnPage, type FollowUpResult, type FollowUpTarget } from '../business/follow-up.js';
import { isVideoPageUrl } from '../utils/bilibili-dom.js';
import { installPageRuntimeShim } from '../utils/page-runtime.js';
import { packagePath } from '../utils/paths.js';
import type { Browser, Page } from 'puppeteer-core';

/** 默认浏览器用户数据目录（持久化登录态；与独立启动入口一致） */
const USER_DATA_DIR = packagePath('puppeteer-browser', 'data');

/** 默认 Chrome 启动参数（后台标签不节流，保证动态页在后台仍能收到 update 轮询） */
const DEFAULT_BROWSER_ARGS = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 只保留一个 B 站主页标签（关闭其它全部标签），给登录流程一个干净页面 */
async function keepOnlyHomePage(browser: Browser | null | undefined): Promise<void> {
  if (!browser || !browser.isConnected()) {
    return;
  }
  const pages = await browser.pages().catch(() => [] as Page[]);
  let home: Page | null = null;
  for (const p of pages) {
    if (p.isClosed()) {
      continue;
    }
    const url = p.url() || '';
    if (/^https?:\/\/(www\.)?bilibili\.com\/?(\?.*)?$/.test(url)) {
      home = p;
      break;
    }
  }
  if (!home) {
    try {
      home = await browser.newPage();
      await home.goto('https://www.bilibili.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
    } catch {
      /* 忽略新开失败 */
    }
  }
  for (const p of pages) {
    if (p === home || p.isClosed()) {
      continue;
    }
    await p.close().catch(() => {});
  }
  await home?.bringToFront().catch(() => {});
}

/** 人格来源（优先级：`persona` 对象 > `personaFile` > `personaDir` / `personaId`） */
export interface KernelPersonaSource {
  /**
   * 人格目录：按 `{personaDir}/{personaId}.json` 查找（**personaId 即文件名**）。
   * 默认包内 `data/personas`；主项目接入时指向自己的目录（如 `<主项目>/data/personas`），
   * 之后直接传 `personaId` 即可。用 `listPersonas()` 可列出该目录下全部可用人格。
   */
  personaDir?: string;
  /** 人格来源①：`personaDir` 下的 `{personaId}.json`（默认目录为包内 data/personas，默认 id 为 ak-night-worker） */
  personaId?: string;
  /** 人格来源②：外部人格配置文件绝对路径 */
  personaFile?: string;
  /** 人格来源③：直接传入人格对象（优先级最高） */
  persona?: PersonaConfig;
}

/**
 * 登录相关选项（`login()` 与 `initialize()` 共用）：
 * 扫码二维码除打印到控制台外，还可通过回调交给宿主（如在自己的界面里渲染二维码）。
 */
export interface KernelLoginOptions {
  /**
   * 登录二维码回调（可选）：扫码阶段每发布一张二维码调用一次，与终端打印**并列**。
   *
   * - `qr.imageBase64` 可直接交给图片控件渲染；`qr.url` 是二维码实际表示的登录链接；
   * - **一次登录可能调用多次**（首次 + 二维码过期自动刷新后重打）→ 用 `qr.fingerprint` 判断是否换了新码；
   * - 回调抛错不影响登录流程（内核记一条警告后忽略）；
   * - 不传时不做任何额外转换（仅终端打印）。
   */
  onQrcode?: LoginQrHandler;
}

/** 内核初始化选项 */
export interface KernelInitializeOptions extends KernelPersonaSource, KernelLoginOptions {
  /** 无头模式（默认 true） */
  headless?: boolean;
  /** 浏览器用户数据目录（默认 包根/puppeteer-browser/data） */
  userDataDir?: string;
  /** 额外 Chrome 启动参数（追加在内置参数之后） */
  browserArgs?: string[];
  /** 未登录时是否阻塞等待扫码登录（默认 true） */
  waitForLogin?: boolean;
  /** 登录未完成时的自动重试间隔（默认 4000ms） */
  loginRetryIntervalMs?: number;
  /** 浏览器打开失败的重试间隔（默认 30000ms；设 0 = 不重试直接抛错） */
  openBrowserRetryIntervalMs?: number;
  /** 详细输出（任务级日志，默认 false） */
  verbose?: boolean;
}

/** 打开动态获取（蹲饼）的选项 */
export interface KernelFetchOptions {
  /**
   * 增量基线（**秒**时间戳）：该时间**之后**的动态都会获取并投递（不会缺失）。
   * 缺省 = 当前时间（只投递开启之后新产生的动态）。宿主应保存上次 `stopFetch()` 的返回值并传回。
   */
  baselineTs?: number;
  /** 首屏 feed/all 响应等待上限（默认 25000ms；超时不阻塞，守护继续重试） */
  initialTimeoutMs?: number;
  /** 动态页守护间隔（默认 60000ms；动态页丢失/被切走时自动补开） */
  watchdogIntervalMs?: number;
}

/** 主动关注 UP 的选项 */
export interface KernelFollowUpOptions {
  /**
   * 模拟行为运行中时，是否在关注期间暂停「生成新任务」（默认 **true**）。
   * - true：关注这几秒内不再派发新任务，避免恰好有「关闭视频标签 / 切换主操作页」的任务
   *   与本操作竞争标签页；**不会中断**正在执行的任务；
   * - false：完全不干预任务流（操作全在临时标签页上，正常情况下也不冲突）。
   */
  holdTasks?: boolean;
}

/** 动态订阅器（类似 Flutter `StreamSubscription`）：`cancel()` 取消订阅 */
export interface DynamicSubscription {
  /** 是否仍在订阅中 */
  readonly active: boolean;
  /** 取消订阅（幂等） */
  cancel(): void;
}

/** 按选项解析人格：对象 > 文件 > personaDir 下的 personaId（文件名即 id） */
function resolvePersona(opts: KernelPersonaSource): PersonaConfig {
  if (opts.persona) {
    return opts.persona;
  }
  if (opts.personaFile) {
    return loadPersonaFromFile(opts.personaFile);
  }
  return loadPersona(opts.personaId ?? 'ak-night-worker', opts.personaDir);
}

/**
 * 全局静态单一实例内核。
 *
 * - `SimulationKernel.getInstance()` / `SimulationKernel.instance`：取全局唯一实例；
 * - `kernel`（本模块导出的常量）：等价的直接引用，便于 `import { kernel }` 使用。
 */
export class SimulationKernel {
  private static singleton: SimulationKernel | null = null;

  /** 全局唯一实例（首次访问时创建） */
  static getInstance(): SimulationKernel {
    if (!SimulationKernel.singleton) {
      SimulationKernel.singleton = new SimulationKernel();
    }
    return SimulationKernel.singleton;
  }

  /** 全局唯一实例（getter 形式，等价 getInstance()） */
  static get instance(): SimulationKernel {
    return SimulationKernel.getInstance();
  }

  /** 单例：禁止外部 new */
  private constructor() {}

  // ===== 内部状态 =====
  private options: KernelInitializeOptions = {};
  private ctx: TaskContext | null = null;
  private persona: PersonaConfig | null = null;
  private generator: PersonaDrivenGenerator | null = null;
  private executor: TaskExecutor | null = null;
  private userDataDir = USER_DATA_DIR;
  private headless = true;

  /** 生成器运行时控制（内核模式下只用于「停止模拟行为」） */
  private control: GeneratorControl = { stopped: false };

  private initialized = false;
  private loggedIn = false;

  private simulationRunning = false;
  private simulationTask: Promise<void> | null = null;
  private stopSimulationTask: Promise<void> | null = null;
  private stoppingSimulation = false;

  private fetchRunning = false;
  private fetchWatchdog: ReturnType<typeof setInterval> | null = null;

  /** 动态监听订阅者（`createDynamicListener` 注册；捕获到的动态分发给它们） */
  private dynamicListeners = new Set<DynamicListener>();

  // ===== 内部只读（不对外暴露） =====

  /** 当前主操作页（未初始化 / 已关闭时为 null） */
  private get page(): Page | null {
    const p = this.ctx?.page;
    return p && !p.isClosed() ? p : null;
  }

  /** 当前生效的人格目录（未指定则为包内 `data/personas`） */
  private get personaDir(): string {
    return this.options.personaDir ?? DEFAULT_PERSONA_DIR;
  }

  /**
   * 列出当前人格目录下所有可用人格（**personaId = 文件名**）。
   * 目录取 `initialize({ personaDir })` / `loadPersona({ personaDir })` 指定的值，
   * 未指定则为包内 `data/personas`。
   */
  listPersonas(): PersonaEntry[] {
    return scanPersonaDir(this.options.personaDir ?? DEFAULT_PERSONA_DIR);
  }

  // ===== ① 初始化：打开浏览器 + 登录 =====

  /**
   * 初始化内核：打开浏览器 → 进入 B 站主页 → 确保登录。
   *
   * - 幂等：已初始化且浏览器仍在连接时直接返回；
   * - 登录态有效（持久化 cookie）时自动跳过扫码；
   * - 登录态无效时打印二维码并阻塞等待扫码（`waitForLogin: false` 则不等待）；
   *   二维码除终端打印外，也可通过 `options.onQrcode` 交给宿主（如自己渲染到界面上）；
   * - **不启动任何功能**：模拟行为与蹲饼都要再显式调用 start* 打开。
   */
  async initialize(options: KernelInitializeOptions = {}): Promise<this> {
    if (this.initialized && this.ctx?.browser?.isConnected()) {
      this.log('ℹ️ 内核已初始化（浏览器已打开），跳过重复初始化');
      return this;
    }

    this.options = { ...options };
    this.persona = resolvePersona(options);
    this.log(
      `🎭 人格: ${this.persona.meta.name}（id=${this.persona.id}）｜来源: ${
        options.persona
          ? '（直接传入对象）'
          : options.personaFile
            ? options.personaFile
            : `${this.personaDir}${path.sep}${this.persona.id}.json`
      }`
    );
    this.userDataDir = options.userDataDir ?? USER_DATA_DIR;
    this.headless = options.headless ?? true;

    this.log(`🚀 内核初始化：打开浏览器（headless=${this.headless}）…`);
    const ctx = await this.openBrowser();
    this.ctx = ctx;

    // 注册「模拟状态」快照器：蹲饼会话开始前快照、结束后恢复（见 passive-fetch 的会话流程）
    fetchCoordinator.snapshotSimulationState = () => this.snapshotForFetchSession();

    // 生成器 + 执行器（登录流程任务不经生成器，直接交给执行器 runTask）
    this.createGeneratorAndExecutor();

    // 内核模式：内核没有「关浏览器 → 离线等待 → 重新上线」的编排，禁止任务关闭浏览器
    // （RestTask 长休息据此降级为「停止活动」，浏览器保持打开）
    ctx.state.set('preventBrowserClose', true);

    this.initialized = true;
    // 未登录时阻塞等扫码 —— 二维码除终端打印外，也可通过 options.onQrcode 交给宿主渲染
    this.loggedIn = await this.withQrcodeHandler(options.onQrcode, () => this.ensureLoggedIn());

    this.log(
      this.loggedIn
        ? '✅ 内核初始化完成（浏览器已打开且已登录）。可调用 startFetch() / startSimulation() 打开对应功能'
        : '⚠️ 内核初始化完成，但当前未登录（waitForLogin=false 跳过等待）。登录态相关行为可能失效'
    );
    return this;
  }

  // ===== ② 人格配置：加载 / 运行态热替换 =====

  /**
   * 加载（或运行态热替换）人格配置。
   *
   * - 未初始化时可调用（仅记录人格，待 `initialize()` 生效）；
   * - **运行态热替换**：模拟正在运行时，让生成器立即改用新人格 ——
   *   后续任务按新人格决策，**不打断当前任务流、不碰页面、不重置状态机**；
   * - 省略的字段沿用上次的值（如只传 `personaId` 会复用之前的 `personaDir`）。
   * @returns 加载后的人格配置
   */
  async loadPersona(options: KernelPersonaSource = {}): Promise<PersonaConfig> {
    // 未显式指定人格来源 → 沿用上次的；否则 personId/personaDir 可单独覆盖
    const explicit = !!(options.persona || options.personaFile || options.personaId || options.personaDir);
    const source: KernelPersonaSource = explicit
      ? {
          personaDir: options.personaDir ?? this.options.personaDir,
          personaId: options.personaId,
          personaFile: options.personaFile,
          persona: options.persona,
        }
      : {
          personaDir: this.options.personaDir,
          personaId: this.options.personaId,
          personaFile: this.options.personaFile,
          persona: this.options.persona,
        };

    const persona = resolvePersona(source);
    this.persona = persona;
    this.options = { ...this.options, ...source };
    this.log(`🎭 人格已加载: ${persona.meta.name}（id=${persona.id}）`);

    // 运行态热替换：生成器立即改用新人格（重建转移矩阵）；未初始化时仅记录，待 initialize() 生效
    this.generator?.setPersona(persona);
    return persona;
  }

  /**
   * 确保登录（未登录则执行登录任务并等待扫码）。
   * 与 `initialize()` 内置的登录等待一致，供随时手动调用（如登录态失效后，或 `waitForLogin: false` 初始化后补登录）。
   *
   * 扫码二维码除打印到控制台外，也可通过 `options.onQrcode` 回调交给宿主
   * （一次登录可能回调多次，用 `qr.fingerprint` 判断是否换了新码）。
   *
   * @returns 是否已处于登录态
   */
  async login(options: KernelLoginOptions = {}): Promise<boolean> {
    this.assertInitialized();
    // 登录是最高优先级任务（额外任务，不走模拟循环）：**首先关闭蹲饼与模拟**，再执行登录
    // （stopFetch 内部会等在跑的蹲饼会话让出浏览器）
    await this.stopFetch().catch(() => {});
    await this.stopSimulation().catch(() => {});
    // 模拟停止后会清理页面（蹲饼已关则全关）→ 重建可用页，否则 ensureLoggedIn 因无页面直接返回 false
    await this.ensureUsablePage().catch(() => {});
    this.loggedIn = await this.withQrcodeHandler(options.onQrcode, () => this.ensureLoggedIn(true));
    return this.loggedIn;
  }

  /**
   * 退出登录：先中止模拟行为 → 执行登出任务 → 浏览器保持打开（等待 `login()` 重新扫码）。
   * @returns 是否已退出登录（本来未登录时返回 false）
   */
  async logout(): Promise<boolean> {
    this.assertInitialized();
    if (!this.loggedIn) {
      this.log('ℹ️ 当前未登录，无需退出');
      return false;
    }
    // 登出是最高优先级任务（额外任务，不走模拟循环）：**首先关闭蹲饼与模拟**，再执行登出
    // （stopFetch 内部会等在跑的蹲饼会话让出浏览器）
    await this.stopFetch().catch(() => {});
    await this.stopSimulation().catch(() => {});
    // 模拟停止后会清理页面（蹲饼已关则全关）→ 重建可用页供登出流程使用
    await this.ensureUsablePage().catch(() => {});
    await this.executor!.runTask(new LogoutTask()).catch((error) => {
      this.log(`⚠️ 退出登录任务执行失败: ${(error as Error).message}`);
    });

    const page = this.page;
    this.loggedIn = page ? await this.checkLogin(page).catch(() => this.loggedIn) : this.loggedIn;
    this.log(
      this.loggedIn
        ? '⚠️ 退出登录未完成（仍处于登录态）'
        : '🔒 已退出登录（浏览器保持打开，可调用 login() 重新登录）'
    );
    return !this.loggedIn;
  }

  // ===== ③ 动态获取：启动 / 关闭 =====

  /**
   * 打开蹲饼：设置基线 → 打开动态页并挂监听 → 等初始增量获取到基线 → 启动守护。
   *
   * 采集范围 = **关注流全部 UP**的动态（不读人格配置）；新增关注用 `followUp()`。
   * 采集语义 = **不缺失**：`baselineTs` 之后的动态会全部获取并投递；单批（约 20 条）不够时会
   * 强制滚动补全直到翻过基线；若滚动到底仍未到达基线，则返回 false 并把基线重置为最新已获取。
   *
   * 重复调用幂等（基线以首次为准）；返回是否「已覆盖基线」（false = 打开失败 / 补全未达基线 / 首屏超时）。
   */
  async startFetch(options: KernelFetchOptions = {}): Promise<boolean> {
    this.assertInitialized();
    this.assertLoggedIn('启用蹲饼');
    if (this.fetchRunning) {
      this.log('ℹ️ 蹲饼已在运行，跳过重复开启');
      return true;
    }
    const ctx = this.ctx!;
    setFetchEnabled(true);

    // 蹲饼开启期间**禁止长休息**：长休息会关闭浏览器 / 长时间停止活动，会使蹲饼失效；
    // 生成侧（Rest 注册表与 BROWSER_CLOSED 分支）据此把长休息权重置 0。
    fetchCoordinator.setLongRestDisabled(true);
    // 若此刻模拟正在「长休息」→ 先停止它，再开蹲饼，然后继续后续流程
    await this.stopOngoingLongRest();

    setFetchEnabled(true);
    // 立即置运行标志：后面的「打开动态页 + 等初次获取」可能耗时数十秒，
    // 期间其它指令（如 sim off 的页面清理）必须能感知到「蹲饼已开启，动态页要保留」。
    this.fetchRunning = true;

    // 主操作页可能已失效（如模拟刚结束时的页面清理）→ 重建，保证后续任务/蹲饼有可用页
    await this.ensureUsablePage().catch(() => {});

    // 本次蹲饼的增量基线：之后的动态都会获取并投递（不传 = 当前时间）
    setFetchBaseline(options.baselineTs);
    const dynPage = await ensureDynamicPage(ctx).catch(() => null);
    let outcome: InitialFetchOutcome = 'timeout';
    if (dynPage) {
      this.log(`🥞 蹲饼就绪：动态页 ${dynPage.url().slice(0, 60)}`);
      outcome = await waitForInitialFetch(dynPage, options.initialTimeoutMs ?? 25_000).catch(
        () => 'timeout' as InitialFetchOutcome
      );
      if (outcome === 'ready') {
        this.log('🥞 初始增量已覆盖基线（之后新动态照常投递）');
      } else if (outcome === 'catchup-failed') {
        this.log('❌ 初始增量未到达基线（已滚动到底）；可见范围内已全部投递，基线已重置为最新获取动态');
      } else {
        this.log('🥞 首屏响应等待超时（后台照常，守护会继续重试）');
      }
      if (this.page && this.page !== dynPage) {
        await this.page.bringToFront().catch(() => {}); // 动态页作为后台常驻标签
      }
    } else {
      this.log('⚠️ 蹲饼未能打开动态页（守护每 60s 重试）');
    }

    // 期间若已被 stopFetch() 关闭（指令可并发下发），则不再启动守护，避免状态互相覆盖
    if (!this.fetchRunning) {
      return false;
    }
    const interval = options.watchdogIntervalMs ?? 60_000;
    this.fetchWatchdog = setInterval(() => {
      void this.fetchWatchdogTick().catch(() => undefined);
    }, interval);
    this.fetchWatchdog.unref?.();

    // 打开成功但没覆盖到基线（到底/超时）→ 返回 false（蹲饼仍在运行，新动态照常投递）
    return !!dynPage && outcome === 'ready';
  }

  /**
   * 关闭动态获取：**关总开关 → 等正在进行的会话/补全让出浏览器 → 关守护与动态页标签**。
   *
   * `await stopFetch()` 返回即代表「蹲饼已完全停止、浏览器已让出」。
   * 仅关开关只是「通知」：`runFetchSession` / 滚动补全是监听器里 `void ...` 触发的游离异步任务，
   * 与 stopFetch 并无 await 关系，它们会在下一个检查点才退出；不等就直接关页/跑登录，
   * 会与它们的切前台/滚动/刷新/关页重开并发。
   *
   * @returns 本次蹲饼的最终基线（秒时间戳；0 = 本次未设置），宿主应保存并在下次 `startFetch` 传回
   */
  async stopFetch(): Promise<number> {
    // ① 无论是否处于「运行中」，都先把总开关关掉：监听器即使残留也不会再解析/投递/触发
    setFetchEnabled(false);
    fetchCoordinator.setLongRestDisabled(false); // 撤销「禁止长休息」：恢复人格原本的长休息概率
    if (this.fetchWatchdog) {
      clearInterval(this.fetchWatchdog);
      this.fetchWatchdog = null;
    }

    const wasRunning = this.fetchRunning;
    if (wasRunning) {
      fetchCoordinator.resume(); // 若关闭瞬间正处于「蹲饼暂停任务流」，解开暂停
      this.fetchRunning = false;
    }

    // ② 等在跑的会话 / 滚动补全让出浏览器（无会话时立即返回；超时兜底见 waitForFetchIdle）
    await waitForFetchIdle();
    if (!wasRunning) {
      return getFetchBaseline();
    }

    // ③ 关闭动态页标签（此时已无会话在使用它）
    if (this.ctx?.browser) {
      const dynPage = await findDynamicPage(this.ctx.browser, this.page ?? undefined).catch(() => null);
      await dynPage?.close().catch(() => {});
    }

    const baseline = getFetchBaseline();
    this.log(
      `🛑 动态获取已关闭｜最终基线：${baseline > 0 ? new Date(baseline * 1000).toLocaleString('zh-CN', { hour12: false }) : '（未设置）'}` +
        `｜下次 startFetch({ baselineTs }) 传回即可无缝续接（不传则从当前时间开始）`
    );
    return baseline;
  }

  /**
   * 若此刻正处于「长休息」中，先把它停掉（供 startFetch 调用）。
   *
   * 语义：模拟开着、蹲饼关着时进了长休息 → 此时开启蹲饼，必须先停止长休息，再开蹲饼。
   * 机制：`ctx.state.forceOnline` 让 RestTask 的等待循环提前结束（与「强制上线」指令同一机制；
   * 内核模式下属长休息已降级为「停止活动」，因此可被中断）。
   */
  private async stopOngoingLongRest(): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) {
      return;
    }
    const current = ctx.state.get('currentRest') as { isLong?: boolean } | undefined;
    if (!current?.isLong) {
      return; // 未在长休息（含未在休息）→ 无需处理
    }
    this.log('⏹️ 检测到正在长休息：先停止休息，再开启蹲饼…');
    ctx.state.set('forceOnline', true);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const cur = ctx.state.get('currentRest') as { isLong?: boolean } | undefined;
      if (!cur?.isLong) {
        break;
      }
      await sleep(300);
    }
    ctx.state.set('forceOnline', false);
    const still = ctx.state.get('currentRest') as { isLong?: boolean } | undefined;
    this.log(still?.isLong ? '⚠️ 长休息未能在时限内停止（继续开启蹲饼）' : '✅ 长休息已停止');
  }

  /** 动态页守护：动态页丢失/被切走时补开（视频页消费中不打扰） */
  private async fetchWatchdogTick(): Promise<void> {
    const ctx = this.ctx;
    if (!this.fetchRunning || !ctx?.browser || !this.page) {
      return;
    }
    if (isVideoPageUrl(this.page.url())) {
      return; // 视频消费中，不新开标签打扰观看
    }
    if (EXCLUSIVE_TASKS.has(fetchCoordinator.currentTaskName)) {
      return; // 登录/登出（最高优先级任务）期间不打扰
    }
    const dynPage = await ensureDynamicPage(ctx).catch(() => null);
    if (dynPage && this.page && this.page !== dynPage) {
      await this.page.bringToFront().catch(() => {});
    }
  }

  // ===== ⑤ 动态监听器 =====

  /**
   * 创建一个动态监听器：传入回调，返回**订阅器**（类似 Flutter `StreamSubscription`）。
   *
   * - 回调参数：`(items, kind)`——`items` 为 **B 站原始动态 item** 数组，
   *   `kind` 为 `'INIT'`（**本次 `startFetch` 的首次投递**，只有一次）或 `'UPDATE'`（其余全部：点击获取 / 刷新 / 滚动补全 / 重开页拉回的增量）。
   *   ⚠️ 两种 kind 都是**增量**（只含 `baselineTs` 之后、没投递过的动态，不是全量快照）→ 宿主应当**追加**，不要按 `'INIT'` 重建列表；
   * - 可在 `initialize()` 前后调用（订阅在 initialize 时统一接入蹲饼出口）；
   * - 取消订阅：`subscription.cancel()`（幂等）；`destroy()` 会清空全部订阅。
   */
  createDynamicListener(listener: DynamicListener): DynamicSubscription {
    let active = true;
    const wrapped: DynamicListener = (items, kind) => {
      if (active) {
        listener(items, kind);
      }
    };
    this.dynamicListeners.add(wrapped);
    this.syncDynamicListener();
    return {
      get active(): boolean {
        return active;
      },
      cancel: (): void => {
        if (!active) {
          return;
        }
        active = false;
        this.dynamicListeners.delete(wrapped);
        this.syncDynamicListener();
      },
    };
  }

  /**
   * 按当前订阅情况接入 / 摘除蹲饼出口（无订阅者时置空，避免空转发器占用出口）。
   */
  private syncDynamicListener(): void {
    setDynamicListener(
      this.dynamicListeners.size > 0 ? (items, kind) => this.dispatchDynamics(items, kind) : null
    );
  }

  /** 将捕获到的动态分发给全部订阅者（单个回调抛错不影响其它订阅） */
  private dispatchDynamics(items: BiliDynamicItem[], kind: 'INIT' | 'UPDATE'): void {
    for (const listener of [...this.dynamicListeners]) {
      try {
        listener(items, kind);
      } catch (error) {
        this.log(`⚠️ 动态监听回调出错: ${(error as Error).message}`);
      }
    }
  }

  // ===== 登录二维码输出（对外通道） =====

  /**
   * 在登录流程期间接入二维码回调（`login({ onQrcode })` / `initialize({ onQrcode })` 内部使用）。
   *
   * - 不传回调 → 直接执行（终端打印照常，不做多余转换）；
   * - 流程结束 / 抛异常 → `finally` 里自动摘除，不残留到下一次登录；
   * - 回调抛错 → 只记一条警告，**不影响登录流程**（回调与终端打印同处一次发布）。
   */
  private async withQrcodeHandler<T>(handler: LoginQrHandler | undefined, fn: () => Promise<T>): Promise<T> {
    if (!handler) {
      return fn();
    }
    setLoginQrHandler((qr) => {
      try {
        handler(qr);
      } catch (error) {
        this.log(`⚠️ 登录二维码回调出错: ${(error as Error).message}`);
      }
    });
    try {
      return await fn();
    } finally {
      setLoginQrHandler(null);
    }
  }

  // ===== 主动关注 UP（独立操作，不进入模拟任务流） =====

  /**
   * 主动关注某个 UP —— 一次性操作，**不进入任务队列**（生成器 / 执行器都不参与）。
   *
   * 对模拟任务的保证：
   * - 全部操作在**临时标签页**上完成、结束后立即关闭；从不改动主操作页（`ctx.page`）、不中断当前任务；
   * - 模拟行为运行中时，仅在这几秒内暂停「生成新任务」（`holdTasks`，默认开启）——
   *   防止恰好有「关闭视频标签 / 切换主操作页」的任务与本次操作竞争标签页；
   *   传 `holdTasks: false` 则完全不干预任务流；
   * - 幂等：已关注直接返回 `status: 'followed'`，不会重复点击。
   *
   * 返回值中的 `uid` / `name` 是从 UP 主页**实际读取**到的信息（读取失败时回退为传入值），
   * 可直接用于展示或后续定向蹲饼。
   *
   * @param target uid 字符串（纯数字）或 `{ uid }`
   */
  async followUp(target: string | FollowUpTarget, options: KernelFollowUpOptions = {}): Promise<FollowUpResult> {
    this.assertInitialized();
    const ctx = this.ctx!;
    const browser = ctx.browser;
    if (!browser || !browser.isConnected()) {
      throw new Error('浏览器已断开：请重新 initialize()');
    }
    const uid = (typeof target === 'string' ? target : String(target?.uid ?? '')).trim();
    if (!/^\d+$/.test(uid)) {
      return { uid, name: '', status: 'failed', detail: '需要 UP 的 uid（纯数字），例如 follow 161775300' };
    }

    // 仅在「模拟行为运行中」才需要协调；未运行时完全不干预
    const holdTasks = options.holdTasks !== false && this.simulationRunning;
    if (holdTasks) {
      fetchCoordinator.pause(); // 只暂停「生成新任务」，不中断正在执行的任务
    }

    const page = await browser.newPage().catch(() => null);
    if (!page) {
      if (holdTasks) {
        fetchCoordinator.resume();
      }
      return { uid, name: '', status: 'failed', detail: '无法打开临时标签页' };
    }
    // 新页面先注入运行时 shim（evaluate 回调里可能含 tsx/esbuild 注入的 __name）
    await installPageRuntimeShim(page);

    try {
      this.log(`➕ 主动关注 UP（uid=${uid}，临时标签页操作）…`);
      const result = await followUpOnPage(page, { uid });
      const label = `${result.name || '(未知 UP)'}（uid ${result.uid || uid}）`;
      this.log(
        result.status === 'failed'
          ? `❌ 关注失败：${label}｜${result.detail ?? '未知原因'}`
          : `✅ ${result.detail ?? '已关注'}｜UP: ${label}`
      );
      return result;
    } finally {
      await page.close().catch(() => {}); // 关闭临时标签页（主操作页与任务流不受影响）
      // 兜底：若主操作页恰好被任务切换到了这个临时页（已被我们关闭），恢复一个可用页面，
      // 避免后续任务因「页面已关闭」全部前置检查失败
      if (this.ctx && (!this.ctx.page || this.ctx.page.isClosed())) {
        const pages = (await browser.pages().catch(() => [] as Page[])).filter((p) => !p.isClosed());
        const fallback = pages[0] ?? (await browser.newPage().catch(() => null));
        if (fallback) {
          this.ctx.page = fallback;
          this.log(`🔧 主操作页已失效，已切换到: ${fallback.url().slice(0, 60) || '(新标签页)'}`);
        }
      }
      // 关注期间临时页被切到前台（保证渲染）→ 结束后把主操作页切回前台，
      // 避免正在运行的持续性任务在后台页上做滚动/点击（后台滚动不触发加载、点击不可靠）
      if (this.ctx?.page && !this.ctx.page.isClosed()) {
        await this.ctx.page.bringToFront().catch(() => {});
      }
      if (holdTasks) {
        fetchCoordinator.resume();
      }
    }
  }

  // ===== ④ 模拟行为：启动 / 中止 =====

  /**
   * 打开模拟行为：从零启动人格驱动的任务流（Markov 游走 → 任务生成 → 执行）。
   *
   * - 后台运行（本方法在任务流启动后立即返回）；
   * - 与蹲饼相互独立：蹲饼运行时开模拟行为，两者通过 fetchCoordinator 自动协调；
   * - 重复调用幂等；每次都是「从零开始」（生成器状态机 reset）；**没有暂停态**。
   */
  async startSimulation(): Promise<void> {
    this.assertInitialized();
    this.assertLoggedIn('启动模拟行为');
    if (this.simulationRunning) {
      this.log('ℹ️ 模拟行为已在运行，跳过重复开启');
      return;
    }
    const ctx = this.ctx!;

    await this.ensureUsablePage(); // 上次停止时页面可能已全部关闭 → 重建主操作页

    // 重置上一次运行留下的痕迹（模拟只有「从零打开」与「彻底结束」两种状态）
    ctx.terminated = false;
    ctx.terminationReason = undefined;
    this.control.stopped = false;
    this.generator!.reset(ctx);
    this.generator!.setPaused(false);
    fetchCoordinator.resume();

    this.stoppingSimulation = false;
    this.simulationRunning = true;
    this.log('🎭 模拟行为已开启');
    this.simulationTask = this.runSimulationLoop();
  }

  /**
   * 彻底结束模拟行为（只有这一种结束方式，没有暂停态）。
   *
   * 停止流程 — **不对执行器做任何中断处理**：
   * 1. **阻塞生成器**：置停止标志 → `generator.next()` 返回 null → 执行器不再生成下一个任务；
   * 2. **中止持续性任务**：`fetchCoordinator.abortCurrentTask()` → `controller.abort()`
   *    （调用任务的「中断处理」→ 等主体收尾）；非持续性任务（点赞 / 搜索 / 开关视频等短任务）不响应，等其自然做完；
   * 3. **等最后一个任务收尾完成**（含 ③ 结束处理 → 生成后一个状态）：执行器退出循环；
   * 4. **清理页面**：关闭不再需要的页面（蹲饼未开 → 全关；蹲饼开着 → 只留蹲饼用的动态页）。
   */
  async stopSimulation(): Promise<void> {
    // 并发守卫：重复调用复用同一次停止流程（避免重复清理 / 重复日志）
    if (this.stopSimulationTask) {
      await this.stopSimulationTask;
      return;
    }
    if (!this.simulationRunning) {
      return;
    }
    this.stoppingSimulation = true;
    this.log('🛑 正在停止模拟行为：阻塞生成器 → 等当前任务收尾…');

    // ① 阻塞生成器：不再生成下一个任务（执行器无需任何中断处理）
    this.control.stopped = true;
    // ② 持续式任务：通过控制器中止（abort → 任务中断处理 → 结束异步进程；浏览/观看/休息均在分片检查点收尾）
    await fetchCoordinator.abortCurrentTask();
    // 若此刻正被蹲饼暂停，先解开等待，保证任务能观察到中断并收尾
    fetchCoordinator.resume();

    this.stopSimulationTask = (async () => {
      // ③ 等执行器跑完最后一个任务
      await this.simulationTask?.catch(() => {});
      this.simulationTask = null;
      this.simulationRunning = false;
      this.control.stopped = false; // 复原，便于下次 startSimulation()
      // ④ 关闭不再需要的页面
      await this.closeIdlePages().catch(() => {});
      this.log('🛑 模拟行为已彻底结束（浏览器保持打开：可继续蹲饼，或从零重开模拟）');
    })();

    try {
      await this.stopSimulationTask;
    } finally {
      this.stopSimulationTask = null;
    }
  }

  /** 模拟行为执行循环：单次 execute()（生成器未停止时会一直生成任务） */
  private async runSimulationLoop(): Promise<void> {
    try {
      await this.executor!.execute();
    } catch (error) {
      this.log(`❌ 模拟行为执行出错: ${(error as Error).message}`);
    } finally {
      this.simulationRunning = false;
      if (!this.stoppingSimulation) {
        // 自然结束（生成器结束本次任务流）：同样清理不再需要的页面
        this.log('🎭 模拟行为已结束（生成器结束本次任务流）');
        await this.closeIdlePages().catch(() => {});
      }
    }
  }

  /**
   * 关闭不再需要的页面（模拟结束后调用）：
   * - 蹲饼**未**开启 → 关闭全部页面（浏览器保持打开，等待下次 startSimulation）；
   * - 蹲饼**已**开启 → 保留蹲饼需要的动态页，其余页面关闭；主操作页被关时重建一个主页页。
   *
   * 前提：**页面已安全**（无任务主体还在用它）。被强制结束的持续性任务主体可能仍在后台跑，
   * 先等它们真正退出（见 `fetchCoordinator.waitZombieBodies`）——否则一关页，
   * 主体的后续操作就会落到接回来的新页面上（实测：蹲饼让位 WatchVideo 后台主仍在动页面）。
   */
  private async closeIdlePages(): Promise<void> {
    const ctx = this.ctx;
    const browser = ctx?.browser;
    if (!ctx || !browser || !browser.isConnected()) {
      return;
    }
    // 等「僵尸主体」真正退出（有界等待：主体正常会在几秒内到达中断检查点）
    if (!(await fetchCoordinator.waitZombieBodies())) {
      // 仍有主体在跑 → **跳过本次清理**：保留页面比「在主体脚下关页」安全得多
      // （页面留着不影响功能：下次 stopSimulation / startSimulation 时会重新清理）
      this.log(
        `⚠️ 仍有 ${fetchCoordinator.zombieBodies.size} 个任务主体未退出（等待超时）：跳过本次页面清理，` +
          `避免在主体操作页面时关页（下次停止/启动模拟时会重新清理）`
      );
      return;
    }
    const pages = (await browser.pages().catch(() => [] as Page[])).filter((p) => !p.isClosed());

    // 蹲饼开启 → 保留动态页（蹲饼必须的页面）
    const keep = this.fetchRunning ? await findDynamicPage(browser).catch(() => null) : null;

    let closed = 0;
    for (const p of pages) {
      if (p === keep) {
        continue;
      }
      await p.close().catch(() => {});
      closed += 1;
    }

    // 主操作页已随页面一起关闭：
    // - 蹲饼开着 → 以保留的动态页作为当前页；
    // - 蹲饼未开 → 保持「无页面」状态（浏览器仍打开，下次 startSimulation 时由 ensureUsablePage 重建主页）。
    if (!ctx.page || ctx.page.isClosed()) {
      ctx.page = keep;
    }
    this.log(
      `🧹 已关闭 ${closed} 个页面（${this.fetchRunning ? '保留蹲饼动态页' : '蹲饼未开启 → 页面已全部关闭，浏览器保持打开'}）`
    );
  }

  /** 确保存在可用的主操作页（页面被全部关闭后重新打开主页） */
  private async ensureUsablePage(): Promise<void> {
    const ctx = this.ctx!;
    if (ctx.page && !ctx.page.isClosed()) {
      return;
    }
    const browser = ctx.browser;
    const pages = browser ? (await browser.pages().catch(() => [] as Page[])).filter((p) => !p.isClosed()) : [];
    const reuse = pages[0] ?? (browser ? await browser.newPage().catch(() => null) : null);
    if (!reuse) {
      throw new Error('无可用页面：浏览器已断开，请重新 initialize()');
    }
    await reuse.goto('https://www.bilibili.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
    ctx.page = reuse;
    this.log(`📄 已重建主操作页: ${reuse.url().slice(0, 60)}`);
  }

  /**
   * 蹲饼会话开始前的「模拟状态」快照：返回恢复函数，由蹲饼在会话结束（含异常）后调用。
   *
   * 蹲饼会切前台、点按钮、刷新、必要时关页重开——都可能破坏模拟对页面的假设。
   * 快照记录主操作页 URL 与滚动位置；恢复时：主操作页被关 → 接回一个可用页；切回前台；
   * URL 未变（未被蹲饼导航走）则还原会话前的滚动位置。
   */
  private async snapshotForFetchSession(): Promise<() => Promise<void>> {
    const ctx = this.ctx;
    if (!ctx) {
      return async () => {};
    }
    const mainPage = this.page; // ctx.page 且未关闭
    const mainUrl = mainPage?.url() ?? '';
    const scrollY = mainPage ? await mainPage.evaluate(() => window.scrollY).catch(() => null) : null;

    return async (): Promise<void> => {
      const c = this.ctx;
      if (!this.initialized || !c) {
        return;
      }
      let page = c.page;
      // ① 主操作页失效（蹲饼关页重开时可能发生）→ 接回一个可用页，
      //    否则后续任务会因「页面已关闭」全部前置检查失败而空转
      if (!page || page.isClosed()) {
        const browser = c.browser;
        const open = browser ? (await browser.pages().catch(() => [] as Page[])).filter((p) => !p.isClosed()) : [];
        page = open[0] ?? (browser ? await browser.newPage().catch(() => null) : null);
        if (!page) {
          return;
        }
        c.page = page;
        this.log(`🔧 蹲饼会话结束：主操作页已失效，已接回 ${page.url().slice(0, 60) || '(新标签页)'}`);
      }
      // ② 前台切回主操作页（蹲饼期间被切到了动态页）
      await page.bringToFront().catch(() => {});
      // ③ URL 未变（未被蹲饼导航走）→ 还原会话前的滚动位置
      if (scrollY !== null && mainUrl && page.url() === mainUrl) {
        await page.evaluate((y) => window.scrollTo(0, y), scrollY).catch(() => {});
      }
    };
  }

  // ===== ⑥ 销毁 =====

  /**
   * 销毁内核：停止模拟行为与动态获取 → 关闭浏览器 → 清除初始化信息与订阅。
   *
   * 调用后可再次 `initialize()`（等同全新启动）；未初始化时调用为无操作。
   */
  async destroy(): Promise<void> {
    this.log('👋 内核销毁中…');
    this.dynamicListeners.clear();
    this.syncDynamicListener();
    await this.stopSimulation().catch(() => {});
    await this.stopFetch().catch(() => {});

    const browser = this.ctx?.browser;
    if (browser && browser.isConnected()) {
      await browser.close().catch(() => {});
    }
    if (this.fetchWatchdog) {
      clearInterval(this.fetchWatchdog);
      this.fetchWatchdog = null;
    }

    // 清除初始化信息（下次 initialize() 等同全新启动）
    fetchCoordinator.snapshotSimulationState = null;
    this.options = {};
    this.ctx = null;
    this.generator = null;
    this.executor = null;
    this.persona = null;
    this.initialized = false;
    this.loggedIn = false;
    this.fetchRunning = false;
    this.simulationRunning = false;
    this.simulationTask = null;
    this.stopSimulationTask = null;
    this.stoppingSimulation = false;
    this.userDataDir = USER_DATA_DIR;
    this.headless = true;
    this.control = { stopped: false };
    this.log('✅ 内核已销毁（浏览器已退出，初始化信息已清除）');
  }

  // ===== 内部工具 =====

  /**
   * （重）建生成器与执行器：应用当前人格与浏览器上下文。
   * 初始化时调用一次；**运行态换人格不走这里**（走 `generator.setPersona()` 热替换，不重建、不打断任务流）。
   */
  private createGeneratorAndExecutor(): void {
    const ctx = this.ctx!;
    this.generator = new PersonaDrivenGenerator(this.persona!, {
      maxTasks: 1_000_000, // 仅防死循环，实际由 stopSimulation / BROWSER_CLOSED 决定
      sessionDurationMs: Number.MAX_SAFE_INTEGER, // 无时长上限
      now: () => Date.now(),
    });
    this.control = { stopped: false };
    this.generator.setControl(this.control);
    this.executor = new TaskExecutor(this.generator, ctx, {
      verbose: !!this.options.verbose,
      stopOnError: false,
      maxTasks: Number.MAX_SAFE_INTEGER, // 与生成器一致：任务流只由「停止模拟 / 浏览器关闭」结束
    });
  }

  /** 打开浏览器并进入主页（失败按配置重试） */
  private async openBrowser(): Promise<TaskContext> {
    const ctx = createContext(null, 'INIT');
    const retryMs = this.options.openBrowserRetryIntervalMs ?? 30_000;
    const args = [...DEFAULT_BROWSER_ARGS, ...(this.options.browserArgs ?? [])];

    for (;;) {
      await new OpenBrowserBehavior({
        headless: this.headless,
        userDataDir: this.userDataDir,
        args,
      })
        .execute(ctx)
        .catch(() => null);

      if (ctx.browser && ctx.page) {
        break;
      }
      if (retryMs <= 0) {
        throw new Error('打开浏览器失败（puppeteer-browser/data 可能被其它进程占用）');
      }
      this.log(`❌ 打开浏览器失败（userDataDir 可能被占用），${retryMs / 1000}s 后重试…`);
      await sleep(retryMs);
    }

    // 登录任务所需的运行参数
    ctx.state.set('loginUserDataDir', this.userDataDir);
    ctx.state.set('loginHeadless', this.headless);

    await new NavigateBehavior('https://www.bilibili.com/').execute(ctx).catch(() => {});
    this.log(`📄 已进入主页: ${(ctx.page?.url() ?? '').slice(0, 80)}`);
    return ctx;
  }

  /** 确保登录：已登录直接返回；否则执行登录任务并等待扫码（manual=true 时忽略 waitForLogin=false） */
  private async ensureLoggedIn(manual = false): Promise<boolean> {
    const ctx = this.ctx;
    if (!ctx?.page) {
      return false;
    }
    if (await this.checkLogin(ctx.page)) {
      ctx.state.set('isLoggedIn', true);
      this.log('🔓 检测到已登录（复用持久化登录态），无需扫码');
      return true;
    }
    if (!manual && this.options.waitForLogin === false) {
      this.log('🔒 未登录（waitForLogin=false，跳过登录等待）');
      return false;
    }

    const retryMs = this.options.loginRetryIntervalMs ?? 4000;
    let tries = 0;
    for (;;) {
      tries += 1;
      await keepOnlyHomePage(ctx.browser).catch(() => {});
      this.log(`📱 未登录：执行登录任务（第 ${tries} 次，请在浏览器中扫码）…`);
      await this.executor!.runTask(new LoginTask()).catch(() => null);

      if (ctx.state.get('isLoggedIn') === true || (await this.checkLogin(ctx.page))) {
        ctx.state.set('isLoggedIn', true);
        this.log('🔓 登录成功');
        return true;
      }
      this.log(`⏳ 未检测到登录（未扫码或超时），${retryMs / 1000}s 后自动重试（Ctrl+C 可退出）…`);
      await sleep(retryMs);
    }
  }

  /** 登录态检测（httpOnly SESSDATA 需用 puppeteer cookie API） */
  private async checkLogin(page: Page): Promise<boolean> {
    return page
      .cookies('https://www.bilibili.com')
      .then((cs) => cs.some((c) => c.name === 'SESSDATA' && c.value))
      .catch(() => false);
  }

  private assertInitialized(): void {
    if (!this.initialized || !this.ctx) {
      throw new Error('内核尚未初始化：请先 await kernel.initialize()');
    }
    if (!this.ctx.browser?.isConnected()) {
      throw new Error('浏览器已断开：请先 await kernel.destroy() 后重新 initialize()');
    }
  }

  /**
   * 断言已登录：**未登录时无法启用蹲饼 / 模拟**
   * （登录是最高优先级任务，见 fetch-coordinator 的 EXCLUSIVE_TASKS）。
   */
  private assertLoggedIn(action: string): void {
    if (!this.loggedIn) {
      throw new Error(`未登录：无法${action}。请先 await kernel.login() 完成扫码登录`);
    }
  }

  private log(msg: string): void {
    console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] [内核] ${msg}`);
  }
}

/** 全局静态单一实例的直接引用（`import { kernel } from '...'`） */
export const kernel: SimulationKernel = SimulationKernel.getInstance();
