/**
 * SimulationKernel：全局静态单一实例「内核类」。
 *
 * 设计目标：把原来耦合在 `run/persona-engine.ts` 一个大 while 循环里的两件事**独立化**——
 *   1. 模拟行为（养号任务流）：PersonaDrivenGenerator + TaskExecutor
 *   2. 被动蹲饼（动态流捕获）：dynamic page + response 监听
 * 由本内核统一持有浏览器会话与资源，上层按需**独立开关**任意一个功能。
 *
 * 使用流程（三步）：
 * ```ts
 * import { SimulationKernel } from 'bilibili-user-simulation';
 *
 * const kernel = SimulationKernel.getInstance();   // 全局唯一实例
 * await kernel.initialize({ headless: true });     // ① 打开浏览器并登录
 * await kernel.startFetch();                       // ② 打开蹲饼（可独立开/关）
 * await kernel.startSimulation();                  // ② 打开模拟行为（可独立开/关）
 * ...
 * await kernel.stopSimulation();                   // 只关模拟行为，蹲饼继续跑
 * await kernel.stopFetch();                        // 只关蹲饼，浏览器保持
 * await kernel.shutdown();                         // 全部关闭 + 关浏览器
 * ```
 *
 * 指令控制（可选）：把「打开 / 关闭功能」变成可下发的指令，便于终端、IPC、HTTP、定时任务统一控制。
 * ```ts
 * kernel.attachConsole();                          // stdin 通道：终端输入 sim off / fetch on / status / help
 * await kernel.executeCommand('sim off');          // 任意通道：直接下发指令字符串，拿回 { ok, output }
 * kernel.registerCommand('quit', { ... });         // 扩展自定义指令
 * ```
 *
 * 语义要点：
 * - `initialize()` 只做「开浏览器 + 确保登录」，不启动任何功能（登录态有效时自动跳过扫码）；
 * - `startSimulation()/stopSimulation()` 与 `startFetch()/stopFetch()` **互不影响**，可任意组合；
 * - `stopSimulation()` 阻塞生成器 + 请求持续式任务收尾，等最后一个任务跑完后关闭不再需要的页面
 *   （蹲饼未开 → 页面全关；蹲饼开着 → 只留蹲饼用的动态页）；没有暂停态，只有「从零打开 / 彻底结束」；
 * - `stopFetch()` 默认只停止「解析/投递/触发」，页面与增量基线保留，重新开启不会重复投递历史动态；
 * - 进程内只有一份蹲饼状态（passive-fetch 模块级单例）与一份浏览器会话，天然与内核单例对应。
 */
import path from 'node:path';
import readline from 'node:readline';
import { createContext, type TaskContext } from '../action/execute/context.js';
import { OpenBrowserBehavior, NavigateBehavior } from '../action/behavior/navigation.js';
import { LoginTask } from '../action/task/login.js';
import { TaskExecutor } from '../action/execute/executor.js';
import { PersonaDrivenGenerator, type GeneratorControl } from '../action/generate/persona-generator.js';
import { DEFAULT_PERSONA_DIR, listPersonas as scanPersonaDir, loadPersona, loadPersonaFromFile, type PersonaEntry } from '../persona/loader.js';
import type { PersonaConfig } from '../persona/types.js';
import {
  ensureDynamicPage,
  findDynamicPage,
  getCollectedDynamics,
  getDynamicCount,
  setDynamicListener,
  setFetchEnabled,
  setFetchReportConfig,
  setFetchTargets,
  waitForInitialFetch,
} from '../business/passive-fetch.js';
import type { BiliDynamicItem, DynamicListener, FetchReportConfig } from '../business/passive-fetch.js';
import { fetchCoordinator } from '../business/fetch-coordinator.js';
import { syncFetchTargets } from '../business/target-sync.js';
import { followUpOnPage, type FollowUpResult, type FollowUpTarget } from '../business/follow-up.js';
import { isVideoPageUrl } from '../utils/bilibili-dom.js';
import { packagePath } from '../utils/paths.js';
import type { Browser, Page } from 'puppeteer-core';
import { registerBuiltinCommands, type KernelCommand, type KernelCommandContext, type KernelCommandResult } from './commands.js';

/** 指令控制台选项（stdin 通道） */
export interface KernelConsoleOptions {
  /** 输入流（默认 process.stdin） */
  input?: NodeJS.ReadableStream;
  /** 输出流（默认 process.stdout） */
  output?: NodeJS.WritableStream;
  /** Ctrl+C 回调（默认仅卸载控制台，不退出进程；退出语义交给宿主决定） */
  onInterrupt?: () => void;
}

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

/** 内核初始化选项 */
export interface KernelInitializeOptions {
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
  /** 无头模式（默认 true） */
  headless?: boolean;
  /** 浏览器用户数据目录（默认 包根/puppeteer-browser/data） */
  userDataDir?: string;
  /** 额外 Chrome 启动参数（追加在内置参数之后） */
  browserArgs?: string[];
  /** 动态监听回调：注册后捕获的动态交给回调（不再自动外发/落盘） */
  onDynamics?: DynamicListener | null;
  /** 动态外发配置（不传则沿用被动蹲饼默认出口：写本地文档） */
  fetchReport?: FetchReportConfig;
  /** 未登录时是否阻塞等待扫码登录（默认 true） */
  waitForLogin?: boolean;
  /** 登录未完成时的自动重试间隔（默认 4000ms） */
  loginRetryIntervalMs?: number;
  /** 浏览器打开失败的重试间隔（默认 30000ms；设 0 = 不重试直接抛错） */
  openBrowserRetryIntervalMs?: number;
  /** 详细输出（任务级日志，默认 false） */
  verbose?: boolean;
}

/** 打开蹲饼的选项 */
export interface KernelFetchOptions {
  /** 是否先对齐 `persona.fetch_targets` 目标 UP（默认 true；每个内核实例只对齐一次） */
  syncTargets?: boolean;
  /** 初次获取等待上限（默认 25000ms；超时不阻塞，守护继续重试） */
  initialTimeoutMs?: number;
  /** 动态页守护间隔（默认 60000ms；动态页丢失/被切走时自动补开） */
  watchdogIntervalMs?: number;
}

/** 关闭蹲饼的选项 */
export interface KernelStopFetchOptions {
  /** 是否同时关闭动态页标签（默认 false：仅停止捕获，页面保留以便快速重开） */
  closePage?: boolean;
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

/** 内核状态快照 */
export interface KernelStatus {
  /** 是否已初始化（浏览器已打开） */
  initialized: boolean;
  /** 当前是否处于登录态 */
  loggedIn: boolean;
  /** 模拟行为是否运行中（只有「运行中 / 彻底结束」两种状态，无暂停态） */
  simulationRunning: boolean;
  /** 蹲饼是否运行中 */
  fetchRunning: boolean;
  /** 当前主操作页 URL */
  currentPageUrl: string;
  /** 累计任务事件数 */
  taskCount: number;
  /** 已捕获动态条数 */
  dynamicCount: number;
}

/** 按选项解析人格：对象 > 文件 > personaDir 下的 personaId（文件名即 id） */
function resolvePersona(opts: KernelInitializeOptions): PersonaConfig {
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

  /** 单例：禁止外部 new（构造时注册内置指令） */
  private constructor() {
    registerBuiltinCommands((name, command) => this.registerCommand(name, command));
  }

  // ===== 内部状态 =====
  private options: KernelInitializeOptions = {};
  private ctx: TaskContext | null = null;
  private persona: PersonaConfig | null = null;
  private generator: PersonaDrivenGenerator | null = null;
  private executor: TaskExecutor | null = null;
  private userDataDir = USER_DATA_DIR;
  private headless = true;

  /** 生成器运行时控制（内核模式下只用于「停止模拟行为」） */
  private control: GeneratorControl = { stopped: false, forceLogin: false };

  private initialized = false;
  private loggedIn = false;

  private simulationRunning = false;
  private simulationTask: Promise<void> | null = null;
  private stopSimulationTask: Promise<void> | null = null;
  private stoppingSimulation = false;

  /** 指令表（指令名 → 定义；支持 registerCommand 扩展） */
  private commands = new Map<string, KernelCommand>();
  /** stdin 控制台卸载函数（attachConsole 返回，shutdown 时自动摘除） */
  private consoleDetach: (() => void) | null = null;

  private fetchRunning = false;
  private fetchWatchdog: ReturnType<typeof setInterval> | null = null;
  private fetchTargetsSynced = false;

  // ===== 只读查询 =====

  /** 内核是否已初始化（浏览器已打开） */
  get isInitialized(): boolean {
    return this.initialized;
  }

  /** 模拟行为是否运行中 */
  get isSimulationRunning(): boolean {
    return this.simulationRunning;
  }

  /** 蹲饼是否运行中 */
  get isFetchRunning(): boolean {
    return this.fetchRunning;
  }

  /** 当前浏览器实例（未初始化时为 null） */
  get browser(): Browser | null {
    return this.ctx?.browser ?? null;
  }

  /** 当前主操作页（未初始化/已关闭时为 null） */
  get page(): Page | null {
    const p = this.ctx?.page;
    return p && !p.isClosed() ? p : null;
  }

  /** 当前人格配置（未初始化时为 null） */
  get currentPersona(): PersonaConfig | null {
    return this.persona;
  }

  /**
   * 列出当前人格目录下所有可用人格（**personaId = 文件名**）。
   * 目录取 `initialize({ personaDir })` 指定的值，未指定则为包内 `data/personas`。
   * 典型用法：宿主先 `listPersonas()` 拿到可选项，再用其中的 `id` 作为 `personaId` 启动。
   */
  listPersonas(): PersonaEntry[] {
    return scanPersonaDir(this.options.personaDir ?? DEFAULT_PERSONA_DIR);
  }

  /** 当前生效的人格目录（未指定则为包内 `data/personas`） */
  get personaDir(): string {
    return this.options.personaDir ?? DEFAULT_PERSONA_DIR;
  }

  /** 状态快照（日志/健康检查/status 指令用） */
  getStatus(): KernelStatus {
    return {
      initialized: this.initialized,
      loggedIn: this.loggedIn,
      simulationRunning: this.simulationRunning,
      fetchRunning: this.fetchRunning,
      currentPageUrl: this.page?.url() ?? '',
      taskCount: this.ctx?.logs.length ?? 0,
      dynamicCount: getDynamicCount(),
    };
  }

  /** 已捕获的动态（**B 站原始 item**，最新在前） */
  getDynamics(limit?: number): BiliDynamicItem[] {
    const all = getCollectedDynamics();
    return typeof limit === 'number' && limit > 0 ? all.slice(0, limit) : all;
  }

  // ===== ① 初始化：打开浏览器 + 登录 =====

  /**
   * 初始化内核：打开浏览器 → 进入 B 站主页 → 确保登录。
   *
   * - 幂等：已初始化且浏览器仍在连接时直接返回；
   * - 登录态有效（持久化 cookie）时自动跳过扫码；
   * - 登录态无效时打印二维码并阻塞等待扫码（`waitForLogin: false` 则不等待）；
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

    // 动态出口（与独立启动入口语义一致）：模块监听优先，其次外发配置
    setDynamicListener(options.onDynamics ?? null);
    if (options.fetchReport) {
      setFetchReportConfig(options.fetchReport);
    }
    setFetchTargets(this.persona.fetch_targets ?? []);

    this.log(`🚀 内核初始化：打开浏览器（headless=${this.headless}）…`);
    const ctx = await this.openBrowser();
    this.ctx = ctx;

    // 生成器 + 执行器（登录流程任务不经生成器，直接交给执行器 runTask）
    this.generator = new PersonaDrivenGenerator(this.persona, {
      maxTasks: 1_000_000, // 仅防死循环，实际由 stopSimulation / BROWSER_CLOSED 决定
      sessionDurationMs: Number.MAX_SAFE_INTEGER, // 无时长上限
      now: () => Date.now(),
    });
    this.generator.setControl(this.control);
    this.executor = new TaskExecutor(this.generator, ctx, {
      verbose: !!options.verbose,
      stopOnError: false,
      maxTasks: Number.MAX_SAFE_INTEGER, // 与生成器一致：任务流只由「停止模拟 / 浏览器关闭」结束
    });

    // 内核模式：内核没有「关浏览器 → 离线等待 → 重新上线」的编排，禁止任务关闭浏览器
    // （RestTask 长休息据此降级为「停止活动」，浏览器保持打开）
    ctx.state.set('preventBrowserClose', true);

    this.initialized = true;
    this.loggedIn = await this.ensureLoggedIn();

    this.log(
      this.loggedIn
        ? '✅ 内核初始化完成（浏览器已打开且已登录）。可调用 startFetch() / startSimulation() 打开对应功能'
        : '⚠️ 内核初始化完成，但当前未登录（waitForLogin=false 跳过等待）。登录态相关行为可能失效'
    );
    return this;
  }

  /**
   * 确保登录（未登录则执行登录任务并等待扫码）。
   * 与 `initialize()` 内置的登录等待一致，供随时手动调用（如登录态失效后，或 `waitForLogin: false` 初始化后补登录）。
   * @returns 是否已处于登录态
   */
  async login(): Promise<boolean> {
    this.assertInitialized();
    this.loggedIn = await this.ensureLoggedIn(true);
    return this.loggedIn;
  }

  // ===== ② 蹲饼：独立开关 =====

  /**
   * 打开蹲饼：对齐目标 UP（可选）→ 打开动态页并挂监听 → 等初次获取 → 启动守护。
   *
   * 重复调用幂等；返回是否成功打开动态页（false 时守护仍会持续重试）。
   */
  async startFetch(options: KernelFetchOptions = {}): Promise<boolean> {
    this.assertInitialized();
    if (this.fetchRunning) {
      this.log('ℹ️ 蹲饼已在运行，跳过重复开启');
      return true;
    }
    const ctx = this.ctx!;
    const targets = this.persona?.fetch_targets ?? [];
    setFetchTargets(targets);

    // 蹲饼前置：目标 UP 对齐（每个内核实例只做一次；失败降级不阻塞）
    if (options.syncTargets !== false && targets.length > 0 && !this.fetchTargetsSynced) {
      this.log(`🎯 [蹲饼目标] 开始对齐目标 UP（共 ${targets.length} 个）…`);
      const reports = await syncFetchTargets(ctx, targets).catch(() => []);
      for (const r of reports) {
        const tag = r.status === 'followed' ? '✅ 已关注' : r.status === 'now-followed' ? '➕ 新关注' : '⚠️ 失败';
        const label = `${r.name || '(未知 UP)'}（uid ${r.uid || '?'}）`;
        this.log(`🎯 [蹲饼目标] ${tag} ${label}${r.detail ? '｜' + r.detail : ''}`);
      }
      this.fetchTargetsSynced = true;
    }

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

    const dynPage = await ensureDynamicPage(ctx).catch(() => null);
    if (dynPage) {
      this.log(`🥞 蹲饼就绪：动态页 ${dynPage.url().slice(0, 60)}`);
      const ready = await waitForInitialFetch(dynPage, options.initialTimeoutMs ?? 25_000).catch(() => false);
      this.log(ready ? '🥞 蹲饼初次获取完成' : '🥞 蹲饼初次获取超时（后台照常，守护会继续重试）');
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
      void this.fetchWatchdogTick();
    }, interval);
    this.fetchWatchdog.unref?.();

    return !!dynPage;
  }

  /**
   * 关闭蹲饼：停止守护与动态解析/投递。
   * 默认保留动态页标签与增量基线（重新开启不会重复投递关闭期间的动态）。
   */
  async stopFetch(options: KernelStopFetchOptions = {}): Promise<void> {
    if (!this.fetchRunning) {
      return;
    }
    if (this.fetchWatchdog) {
      clearInterval(this.fetchWatchdog);
      this.fetchWatchdog = null;
    }
    setFetchEnabled(false);
    fetchCoordinator.resume(); // 若关闭瞬间正处于「蹲饼暂停任务流」，解开暂停
    fetchCoordinator.setLongRestDisabled(false); // 抳销「禁止长休息」：恢复人格原本的长休息概率

    if (options.closePage && this.ctx?.browser) {
      const dynPage = await findDynamicPage(this.ctx.browser, this.page ?? undefined).catch(() => null);
      await dynPage?.close().catch(() => {});
    }

    this.fetchRunning = false;
    this.log('🛑 蹲饼已关闭（监听保留、增量基线保留，可随时 startFetch() 重开）');
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
    const dynPage = await ensureDynamicPage(ctx).catch(() => null);
    if (dynPage && this.page && this.page !== dynPage) {
      await this.page.bringToFront().catch(() => {});
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
      if (holdTasks) {
        fetchCoordinator.resume();
      }
    }
  }

  // ===== ③ 模拟行为：独立开关 =====

  /**
   * 打开模拟行为：从零启动人格驱动的任务流（Markov 游走 → 任务生成 → 执行）。
   *
   * - 后台运行（本方法在任务流启动后立即返回）；用 `waitSimulation()` 可等待其结束；
   * - 与蹲饼相互独立：蹲饼运行时开模拟行为，两者通过 fetchCoordinator 自动协调；
   * - 重复调用幂等；每次都是「从零开始」（生成器状态机 reset）。
   */
  async startSimulation(): Promise<void> {
    this.assertInitialized();
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
    this.control.reloadRequested = false;
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

  /** 等待当前模拟行为结束（未运行则立即返回） */
  async waitSimulation(): Promise<void> {
    await this.simulationTask?.catch(() => {});
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
   */
  private async closeIdlePages(): Promise<void> {
    const ctx = this.ctx;
    const browser = ctx?.browser;
    if (!ctx || !browser || !browser.isConnected()) {
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

  // ===== ④ 指令控制：用指令打开 / 关闭功能 =====

  /**
   * 注册（或覆盖）一条指令，用于扩展内核的指令控制能力。
   *
   * @example
   * kernel.registerCommand('quit', {
   *   description: '关闭内核并退出进程',
   *   handler: async ({ kernel }) => { await kernel.shutdown(); process.exit(0); },
   * });
   */
  registerCommand(name: string, command: KernelCommand): this {
    const key = name.trim().toLowerCase();
    if (key) {
      this.commands.set(key, command);
    }
    return this;
  }

  /** 注销指令（返回是否存在） */
  unregisterCommand(name: string): boolean {
    return this.commands.delete(name.trim().toLowerCase());
  }

  /** 全部已注册指令名（排序） */
  listCommands(): string[] {
    return [...this.commands.keys()].sort();
  }

  /** 指令帮助文本（help 指令使用；宿主也可直接打印） */
  getCommandHelp(): string {
    const lines = [...this.commands.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, cmd]) => `  ${(cmd.usage ?? name).padEnd(48)} ${cmd.description}`);
    return ['可用指令：', ...lines].join('\n');
  }

  /**
   * 执行一条指令（指令系统的统一入口，**与通道无关**）。
   *
   * 通道可以是：stdin 控制台（attachConsole）/ 宿主代码直接调用 / IPC / HTTP / 定时任务等。
   * @returns `{ ok, output }`：ok=false 表示未知指令或执行出错，output 是需展示的文本（可空）
   */
  async executeCommand(line: string): Promise<KernelCommandResult> {
    const raw = line.trim();
    if (!raw) {
      return { ok: true };
    }
    const [name, ...args] = raw.split(/\s+/);
    const command = this.commands.get(name.toLowerCase());
    if (!command) {
      return { ok: false, output: `未知指令: ${name}（输入 help 查看可用指令）` };
    }
    const ctx: KernelCommandContext = { kernel: this, raw, args };
    try {
      const result = await command.handler(ctx);
      if (typeof result === 'string') {
        return { ok: true, output: result };
      }
      return result ?? { ok: true };
    } catch (error) {
      return { ok: false, output: `指令执行失败: ${(error as Error).message}` };
    }
  }

  /**
   * 挂载 stdin 指令控制台：终端里逐行输入指令（如 `sim off`、`fetch on`）即打开 / 关闭功能。
   *
   * 返回卸载函数；`shutdown()` 会自动卸载。Ctrl+C 默认只卸载控制台，退出语义由 `onInterrupt` 决定。
   */
  attachConsole(options: KernelConsoleOptions = {}): () => void {
    this.consoleDetach?.(); // 防重复挂载
    const input = options.input ?? process.stdin;
    const output = options.output ?? process.stdout;
    const rl = readline.createInterface({ input, output });
    const write = (text?: string): void => {
      if (text) {
        output.write(text.endsWith('\n') ? text : text + '\n');
      }
    };

    rl.on('line', (line) => {
      void (async () => {
        const result = await this.executeCommand(line);
        write(result.output);
      })();
    });
    rl.on('SIGINT', () => {
      if (options.onInterrupt) {
        options.onInterrupt();
      } else {
        detach();
      }
    });

    const detach = (): void => {
      this.consoleDetach = null;
      rl.close();
    };
    this.consoleDetach = detach;
    return detach;
  }

  // ===== ⑤ 关闭 =====

  /** 关闭内核：停止模拟行为与蹲饼 → 关闭浏览器 → 复位状态（可再次 initialize） */
  async shutdown(): Promise<void> {
    this.log('👋 内核关闭中…');
    this.consoleDetach?.(); // 摘除 stdin 指令控制台，避免进程退出时残留监听
    await this.stopSimulation().catch(() => {});
    await this.stopFetch({ closePage: true }).catch(() => {});

    const browser = this.ctx?.browser;
    if (browser && browser.isConnected()) {
      await browser.close().catch(() => {});
    }
    if (this.fetchWatchdog) {
      clearInterval(this.fetchWatchdog);
      this.fetchWatchdog = null;
    }

    this.ctx = null;
    this.generator = null;
    this.executor = null;
    this.persona = null;
    this.initialized = false;
    this.loggedIn = false;
    this.fetchRunning = false;
    this.simulationRunning = false;
    this.fetchTargetsSynced = false;
    this.log('✅ 内核已关闭（浏览器已退出）');
  }

  // ===== 内部工具 =====

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
      throw new Error('浏览器已断开：请先 await kernel.shutdown() 后重新 initialize()');
    }
  }

  private log(msg: string): void {
    console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] [内核] ${msg}`);
  }
}

/** 全局静态单一实例的直接引用（`import { kernel } from '...'`） */
export const kernel: SimulationKernel = SimulationKernel.getInstance();
