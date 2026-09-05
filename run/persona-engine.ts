/**
 * 人格引擎正式运行核心（有头/无头共用）。
 *
 * 正式运行的语义（用户要求）：
 * 1. **真实时间**：无任何时间模拟/加速，事件与等待均按真实耗时（Date.now）。
 * 2. **无时间限制**：sessionDurationMs/maxTasks 设为极大值，生成器只在
 *    BROWSER_CLOSED（真人下线）时结束一轮。
 * 3. **一直持续运行**：上线（打开浏览器并确认登录）→ 任务流 → 下线（关闭浏览器或
 *    退出登录）→ 按 persona 的 offline_minutes 采样离线间隔休息 → 重新上线，
 *    无限循环直到进程被手动终止（Ctrl+C）。
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createContext, type TaskContext } from '../src/action/execute/context.js';
import { OpenBrowserBehavior, NavigateBehavior } from '../src/action/behavior/navigation.js';
import { LoginTask } from '../src/action/task/login.js';
import { LogoutTask } from '../src/action/task/logout.js';
import { setMouseTrailVisible } from '../src/action/behavior/mouse.js';
import { TaskExecutor } from '../src/action/execute/executor.js';
import { loadPersona, loadPersonaFromFile } from '../src/persona/loader.js';
import { PersonaDrivenGenerator, type GeneratorControl } from '../src/action/generate/persona-generator.js';
import {
  ensureDynamicPage,
  getCollectedDynamics,
  getDynamicCount,
  setDynamicListener,
  setFetchReportConfig,
  setFetchTargets,
  waitForInitialFetch,
} from '../src/business/passive-fetch.js';
import type { DynamicListener } from '../src/business/passive-fetch.js';
import type { PersonaConfig } from '../src/persona/types.js';
import { syncFetchTargets } from '../src/business/target-sync.js';
import { loadFetchReportConfig } from './fetch-report-config.js';
import { loadFetchRecordingConfig, setFetchRecordingByCommand } from './fetch-recording-config.js';
import { isFetchRecordingEnabled } from '../src/business/record-fetch-video.js';
import { installLogWriter } from './log-writer.js';
import { isVideoPageUrl } from '../src/utils/bilibili-dom.js';
import { packagePath } from '../src/utils/paths.js';
import type { Browser, Page, Target } from 'puppeteer-core';

const USER_DATA_DIR = packagePath('puppeteer-browser', 'data');

/** 只保留一个 B 站主页标签（关闭其它全部标签），供登录失效等待 / 退出登录后保持浏览器 */
async function keepOnlyHomePage(browser: Browser | null | undefined): Promise<void> {
  if (!browser || !browser.isConnected()) {
    return;
  }
  const pages = await browser.pages().catch(() => [] as Page[]);
  // 找一个真正的 B 站主页标签（根路径首页）
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
  // 无主页标签 → 新开一个并导航到主页
  if (!home) {
    try {
      home = await browser.newPage();
      await home.goto('https://www.bilibili.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
    } catch {
      /* 忽略新开失败 */
    }
  }
  // 关闭除主页外的全部标签页
  for (const p of pages) {
    if (p === home || p.isClosed()) {
      continue;
    }
    await p.close().catch(() => {});
  }
  await home?.bringToFront().catch(() => {});
}

// 正式运行：日志落盘（stdout + logs/persona-YYYYMMDD.log 滚动双写）
const logFile = installLogWriter({ dir: packagePath('logs'), prefix: 'persona' }).file;

// ===== 全局异常捕获：崩溃也完整记录（区分正常退出 vs 意外崩溃）=====
const logLine = (level: string, msg: string): void => {
  try {
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] [${level}] ${msg}\n`);
  } catch {
    /* 日志失败不影响运行 */
  }
};
process.on('uncaughtException', (err) => {
  logLine('ERROR', `💥 未捕获异常: ${err.stack ?? err.message}`);
  console.error(`💥 未捕获异常（已记录日志）: ${err.message}\n${err.stack ?? ''}`);
});
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  logLine('ERROR', `💥 未处理的 Promise 拒绝: ${msg}`);
  console.error(`💥 未处理的 Promise 拒绝（已记录日志）: ${msg}`);
});
process.on('exit', (code) => {
  logLine('EXIT', `进程退出，code=${code}${code === 0 ? '（正常）' : '（异常）'}`);
});

/**
 * 标签页监听：记录标签页新增/关闭/导航（URL 变化）。
 * - 只监听 page 类型（真实标签页），忽略 service worker / browser 等后台 target；
 * - 导航用 Map 按 target 去重：URL 未变化（SPA 内部刷新/标题变化）不刷屏；
 * - 关闭浏览器前应先 detach()，避免关闭瞬间批量打印「标签页关闭」噪音。
 */
async function attachTabMonitor(browser: Browser): Promise<() => void> {
  const fmtClock = (t: number): string => new Date(t).toLocaleTimeString('zh-CN', { hour12: false });
  const fmt = (u: string): string => (u ? (u.length > 90 ? u.slice(0, 90) + '…' : u) : '(about:blank)');
  const lastUrl = new Map<unknown, string>();

  // 初始标签页快照（打开浏览器时已存在的页面）
  try {
    for (const p of await browser.pages()) {
      const u = p.url();
      lastUrl.set(p, u);
      console.log(`   📑 初始标签页 [${fmtClock(Date.now())}]: ${fmt(u)}`);
    }
  } catch {
    /* 忽略 */
  }

  const onCreated = (target: Target): void => {
    try {
      if (target.type() !== 'page') return;
      lastUrl.set(target, target.url());
      console.log(`   📑 标签页新增 [${fmtClock(Date.now())}]: ${fmt(target.url())}`);
    } catch {
      /* 忽略 */
    }
  };
  const onDestroyed = (target: Target): void => {
    try {
      if (target.type() !== 'page') return;
      lastUrl.delete(target);
      console.log(`   🗑️ 标签页关闭 [${fmtClock(Date.now())}]: ${fmt(target.url())}`);
    } catch {
      /* 忽略 */
    }
  };
  const onChanged = (target: Target): void => {
    try {
      if (target.type() !== 'page') return;
      const url = target.url();
      if (lastUrl.get(target) === url) return; // URL 未变 → 忽略
      lastUrl.set(target, url);
      console.log(`   🔄 标签页导航 [${fmtClock(Date.now())}]: ${fmt(url)}`);
    } catch {
      /* 忽略 */
    }
  };

  browser.on('targetcreated', onCreated);
  browser.on('targetdestroyed', onDestroyed);
  browser.on('targetchanged', onChanged);

  return () => {
    browser.off('targetcreated', onCreated);
    browser.off('targetdestroyed', onDestroyed);
    browser.off('targetchanged', onChanged);
  };
}

/** R4 范围采样 */
const sampleRange = ([min, max]: [number, number]): number => min + Math.random() * (max - min);

const sleepReal = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface PersonaRunOptions {
  /** 有头(true) / 无头(false) */
  headless: boolean;
  /** 有头观察时开启鼠标轨迹可视化 */
  mouseTrail?: boolean;
  /** 详细输出每个任务动作（有头观察用） */
  verbose?: boolean;
  /** 人格来源①：包内 data/personas/{personaId}.json（默认 ak-night-worker） */
  personaId?: string;
  /** 人格来源②：外部人格配置文件绝对路径（主项目以模块方式接入时指明） */
  personaFile?: string;
  /** 人格来源③：直接传入人格对象（优先级最高） */
  persona?: PersonaConfig;
  /** 动态监听：主项目以模块方式接入时注册，模块内部每次捕获到动态即回调（kind: 'INIT'|'UPDATE'）。
   *  注册后动态不再走 config-app 外发/本地文档（由主项目决定出口）。 */
  onDynamics?: DynamicListener;
}

/** 按选项解析人格：对象 > 文件 > 包内 id */
function resolvePersona(opts: PersonaRunOptions): PersonaConfig {
  if (opts.persona) {
    return opts.persona;
  }
  if (opts.personaFile) {
    return loadPersonaFromFile(opts.personaFile);
  }
  return loadPersona(opts.personaId ?? 'ak-night-worker');
}

export async function runPersonaEngine(opts: PersonaRunOptions): Promise<void> {
  // 正式运行：真实时间（无任何时间模拟/加速）
  if (opts.mouseTrail) {
    setMouseTrailVisible(true);
  }

  // 动态出口二选一：
  // - 模块模式：主项目注册 onDynamics → 捕获的动态直接交给监听器（不再读 config-app 外发/落盘）
  // - example 模式：未注册 → 读 config-app.json5 决定「外发接口 / 本地文档落盘」
  const moduleMode = typeof opts.onDynamics === 'function';
  setDynamicListener(opts.onDynamics ?? null);
  if (!moduleMode) {
    setFetchReportConfig(loadFetchReportConfig());
  }

  // 被动蹲饼录屏开关（从 config-app.json5 读取，默认关闭）
  loadFetchRecordingConfig();

  console.log(`🟢 启动信息: PID=${process.pid} | Node=${process.version} | ${new Date().toLocaleString('zh-CN', { hour12: false })}`);

  // === 运行时控制：登录失效停止 / 强制登录 / 强制退出登录 ===
  const control: GeneratorControl = { stopped: false, forceLogin: false, forceLogout: false };
  // 登录失效/未登录/退出登录时保持打开的浏览器上下文（只留 B 站主页，等 login 复用）
  let keptCtx: TaskContext | null = null;
  let currentCtx: TaskContext | null = null;
  let gen: PersonaDrivenGenerator | null = null; // 当前轮生成器（status 指令读取其状态）

  // stdin 指令监听（login：强制下一个任务为登录 / reload：热重启重载人格）
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on('line', (line) => {
    const cmd = line.trim().toLowerCase();
    if (cmd === 'login') {
      control.forceLogin = true;
      control.stopped = false; // 若在等待重登，login 即恢复
      console.log('📱 收到 login 指令：下一个任务将强制登录（请在浏览器扫码）。');
    } else if (cmd === 'logout') {
      // 直接退出当前账号（不经生成器）：中断当前任务流，收尾时由执行器直接执行登出任务
      control.forceLogout = true;
      control.stopped = true; // 中断生成器 → 当前上线任务流结束，进入收尾执行登出
      console.log('🚪 收到 logout 指令：正在退出当前账号（当前任务完成后执行登出）。');
    } else if (cmd === 'reload') {
      // 热重启：结束当前上线周期，重载人格配置后直接重新上线（跳过下线休息）
      control.reloadRequested = true;
      control.stopped = false;
      console.log('♻️ 收到 reload 指令：正在热重启（结束当前上线周期 → 重载人格配置 → 重新上线）…');
    } else if (cmd === 'status') {
      // 打印当前状态信息（页面/状态/标签/任务/登录态/生成器/控制）
      void printStatus();
    } else if (cmd === 'online') {
      // 强制上线：强制结束当前休息（RestTask）/ 下线休息倒计时，立即开始上线
      control.forceOnline = true;
      if (currentCtx?.state) {
        currentCtx.state.set('forceOnline', true);
      }
      console.log('🚀 收到 online 指令：正在强制结束休息，立即上线…');
    } else if (cmd === 'record' || cmd === 'record on' || cmd === 'record off') {
      // 蹲饼视频录制开关：更新内存开关并写回 run/config-app.json5（重启后仍生效）
      if (cmd === 'record on') {
        setFetchRecordingByCommand(true);
        console.log('🎬 录屏已开启：下一次蹲饼触发时将录制画面到 logs/screencast/');
      } else if (cmd === 'record off') {
        setFetchRecordingByCommand(false);
        console.log('🎬 录屏已关闭');
      } else {
        console.log(`🎬 当前录屏状态：${isFetchRecordingEnabled() ? '开启' : '关闭'}`);
      }
    } else if (cmd === 'help') {
      console.log(
        '可用指令: login（强制登录）/ logout（退出登录）/ reload（热重启重载人格）/ online（强制上线）/ record on|off（开关蹲饼录屏）/ status（打印当前状态）/ help'
      );
    } else if (cmd.trim()) {
      console.log(`未知指令: ${cmd}。可用: login / logout / reload / online / record on|off / status / help`);
    }
  });
  rl.on('SIGINT', async () => {
    console.log('\n👋 收到 Ctrl+C，正在优雅关闭浏览器…');
    // 先关闭浏览器再退出，避免 puppeteer 的 Chrome 成为孤儿进程
    // （进程退出后 Chrome 仍会锁住 puppeteer-browser/data，导致下次启动失败）
    const b = currentCtx?.browser;
    if (b && b.isConnected()) {
      await b.close().catch(() => {});
    }
    console.log('✅ 浏览器已关闭，退出');
    process.exit(0);
  });

  // 被动蹲饼监视器：每 60s 确保动态页始终存在（复用/新开 + 挂监听），获取动态流数据。
  // 当前活动页是视频页时跳过（避免新开标签打扰观看）；其余情况动态页已在就绪则无动作。
  const passiveFetchWatcher = setInterval(async () => {
    const ctx = currentCtx;
    if (control.stopped) {
      return; // 登录失效/等待重登时不打开动态页（浏览器只留 B 站主页）
    }
    if (!ctx?.browser || !ctx?.page || ctx.page.isClosed()) {
      return; // 下线/浏览器关闭时不处理
    }
    if (isVideoPageUrl(ctx.page.url())) {
      return; // 视频消费中不打扰
    }
    const dynPage = await ensureDynamicPage(ctx).catch(() => null);
    if (dynPage && ctx.page && !ctx.page.isClosed() && ctx.page !== dynPage) {
      // 新开动态页标签后把主操作页切回前台（动态页作为后台常驻，真人视角仍是当前浏览页）
      await ctx.page.bringToFront().catch(() => {});
    }
  }, 60_000);

  let persona = resolvePersona(opts);
  let circadian = persona.circadian;
  /** 蹲饼目标已对齐的人格 id（每个 persona 每次登录后只对齐一次，避免每轮上线都去核实关注） */
  let targetsSyncedFor: string | null = null;
  // 指向性动态获取：把 persona.fetch_targets 注入 passive-fetch（非空时只捕获这些 UP 的动态）
  setFetchTargets(persona.fetch_targets ?? []);

  /** 热重启：重新加载人格配置（reload 指令触发），更新运行变量 */
  const reloadPersona = (): void => {
    persona = resolvePersona(opts);
    circadian = persona.circadian;
    targetsSyncedFor = null; // 人格变了 → 蹲饼目标需重新对齐
    setFetchTargets(persona.fetch_targets ?? []);
    console.log(`♻️ 已重载人格配置: ${persona.meta.name} - ${persona.meta.description}`);
  };

  console.log(`\n${opts.headless ? '🤖 人格引擎无头运行' : '🎬 人格引擎有头运行'}`);
  console.log(`   人格: ${persona.meta.name} - ${persona.meta.description}`);
  console.log(`   模式: ${opts.headless ? '无头（后台）' : '有头（真实浏览器窗口）'} | 时间: 真实时间（无加速）`);
  console.log(`   持续: 一直运行，下线（关闭浏览器/退出登录）后按离线间隔自动重新上线，Ctrl+C 终止`);
  console.log(`   登录态: ${USER_DATA_DIR}\n`);
  if (!opts.headless) {
    console.log('   ⏳ 即将打开真实浏览器窗口（关窗口或 Ctrl+C 可终止）\n');
    await sleepReal(2500);
  }
  console.log(`   📝 日志落盘: ${logFile}\n`);

  // ===== 跨上线周期累计统计（跑一天后能一眼看到整体情况）=====
  const SUMMARY_INTERVAL_MS = 60 * 60 * 1000; // 每小时累计快照
  const fmtClock = (t: number): string => new Date(t).toLocaleTimeString('zh-CN', { hour12: false });
  const acc = {
    onlineCount: 0, // 上线次数（打开浏览器并确认登录即算一次上线）
    totalTasks: 0,
    successCount: 0,
    failedCount: 0,
    taskHistogram: {} as Record<string, number>,
    onlineMs: 0,
    offlineMs: 0,
    startedAt: Date.now(),
    lastSummaryAt: Date.now(),
  };
  const printSummary = (why: string): void => {
    const successRate = acc.totalTasks ? ((acc.successCount / acc.totalTasks) * 100).toFixed(1) : '-';
    const taskEntries = Object.entries(acc.taskHistogram).sort((a, b) => b[1] - a[1]);
    console.log(`\n────────── 累计统计（${why}）──────────`);
    console.log(`  运行时长: ${((Date.now() - acc.startedAt) / 3600_000).toFixed(2)}h | 上线: ${acc.onlineCount}`);
    console.log(`  任务: ${acc.totalTasks} | 成功: ${acc.successCount} | 失败: ${acc.failedCount} | 成功率: ${successRate}%`);
    console.log(`  在线: ${(acc.onlineMs / 60000).toFixed(0)}min | 休息: ${(acc.offlineMs / 60000).toFixed(0)}min`);
    if (taskEntries.length) {
      console.log('  任务直方图: ' + taskEntries.map(([k, v]) => `${k}=${v}`).join(' '));
    }
    console.log('──────────────────────────────────────\n');
  };

  let onlineCount = 0; // 上线次数（上线 = 打开浏览器并确认登录）

  /** 打印当前状态信息（status 指令）：页面/状态/标签/上一任务/登录态/生成器/控制 */
  async function printStatus(): Promise<void> {
    const fmtT = (t: number): string => new Date(t).toLocaleTimeString('zh-CN', { hour12: false });
    const fmtUrl = (u: string): string => (u ? (u.length > 80 ? u.slice(0, 80) + '…' : u) : '(about:blank)');
    console.log(`\n────────── 状态快照 [${fmtT(Date.now())}] ──────────`);
    console.log(
      `  人格: ${persona.meta.name} | 运行: 上线 #${onlineCount} | 累计任务 ${acc.totalTasks}（成功 ${acc.successCount} / 失败 ${acc.failedCount}）`
    );
    const g = gen;
    if (g) {
      const s = g.getStatusInfo();
      console.log(`  生成器: 主状态 ${s.currentState} | 已生成任务 ${s.taskCount} | 在线开始 ${fmtT(s.onlineStartAt)}`);
      console.log(
        `          连刷推荐 ${s.recommendationCount} 个 | searchCloseBias ${s.searchCloseBias.toFixed(2)} | 重试视频 ${s.retryWatchVideo}`
      );
    }
    const ctx = currentCtx;
    if (ctx?.page && !ctx.page.isClosed()) {
      const url = ctx.page.url();
      const pages = ctx.browser ? await ctx.browser.pages().catch(() => [] as NonNullable<TaskContext['page']>[]) : [];
      const videoTabs = pages.filter((p) => isVideoPageUrl(p.url())).length;
      console.log(`  页面: ${fmtUrl(url)}${isVideoPageUrl(url) ? '（视频页）' : ''}`);
      console.log(`  标签页: ${pages.length} 个（视频页 ${videoTabs} 个） | 主状态: ${ctx.currentState}`);
      const lastLog = ctx.logs[ctx.logs.length - 1];
      if (lastLog) {
        console.log(
          `  上一任务: ${lastLog.taskName} ${lastLog.success ? '✅' : '❌'} 耗时 ${((lastLog.duration ?? 0) / 1000).toFixed(1)}s`
        );
      }
      const hasLogin = await ctx.page
        .cookies('https://www.bilibili.com')
        .then((cs) => cs.some((c) => c.name === 'SESSDATA' && c.value))
        .catch(() => false);
      console.log(`  登录态: ${hasLogin ? '有效' : '❌ 失效'}`);
    } else {
      console.log('  页面: 无（浏览器未打开 / 下线中）');
    }
    const dynCount = getDynamicCount();
    const recent = getCollectedDynamics().slice(0, 5);
    console.log(`  被动蹲饼: 已抓动态 ${dynCount} 条${dynCount > 0 ? `（最新 ${recent.length} 条）：` : '（尚无，等待动态页轮询）'}`);
    for (const d of recent) {
      const t = d.pubTimeText || (d.pubTs > 0 ? new Date(d.pubTs * 1000).toLocaleString('zh-CN', { hour12: false }) : '?');
      console.log(`    · ${d.author || d.uid || '?'} [${t}]: ${(d.text || '(无文案)').slice(0, 40)}`);
    }
    console.log(
      `  控制: stopped=${control.stopped} | forceLogin=${control.forceLogin} | reload=${!!control.reloadRequested} | forceOnline=${!!control.forceOnline}`
    );
    console.log('──────────────────────────────────────\n');
  }

  while (true) {
    // 热重启请求：重载人格配置后直接重新上线（下线处已跳过休息）
    if (control.reloadRequested) {
      control.reloadRequested = false;
      reloadPersona();
      console.log('♻️ 热重启完成，重新上线…');
    }

    // 未登录/登录失效 → 等待用户输入 login 登录（浏览器保持打开，只留 B 站主页）
    if (control.stopped) {
      if (keptCtx?.browser && keptCtx.browser.isConnected()) {
        await keepOnlyHomePage(keptCtx.browser).catch(() => {});
      }
      console.error('🔒 未登录或登录失效，任务未开始/已暂停。浏览器保持打开（仅 B 站主页），请扫码后输入 login 指令登录…');
      while (control.stopped) {
        await sleepReal(1000);
      }
      console.log('🔓 收到 login，开始登录（复用已打开的浏览器）。');
    }

    // 本次上线真实开始时间（用于统计本次上线时长）
    const onlineStart = Date.now();
    // 本轮标签页监听（新增/关闭/导航），关浏览器前解除
    let detachTab: (() => void) | null = null;

    // 登录失效后复用保持的浏览器，或新开浏览器（复用持久化登录态）
    let ctx: TaskContext;
    if (keptCtx && keptCtx.browser && keptCtx.browser.isConnected()) {
      ctx = keptCtx;
      keptCtx = null;
      await new NavigateBehavior('https://www.bilibili.com/').execute(ctx).catch(() => {});
      console.log('♻️ 复用已打开的浏览器，进入主页:', ctx.page!.url().slice(0, 80));
    } else {
      ctx = createContext(null, 'INIT');
      try {
        await new OpenBrowserBehavior({
          headless: opts.headless,
          userDataDir: USER_DATA_DIR,
          args: [
            '--disable-background-timer-throttling', // 后台标签定时器不节流（动态页在后台时 update 轮询照常）
            '--disable-backgrounding-occluded-windows', // 窗口被遮挡/标签在后台时不暂停页面渲染
            '--disable-renderer-backgrounding', // 渲染进程不后台化（后台标签 JS 持续执行，点按钮能触发 feed/all）
          ],
        }).execute(ctx);
      } catch (error) {
        console.error(`❌ 打开浏览器失败: ${(error as Error).message}`);
        console.error('   可能原因：puppeteer-browser/data 被其他进程占用。30 秒后重试…');
        await sleepReal(30_000);
        continue;
      }
      if (!ctx.page) {
        console.error('❌ 浏览器打开但未获得页面，30 秒后重试…');
        await sleepReal(30_000);
        continue;
      }
      await new NavigateBehavior('https://www.bilibili.com/').execute(ctx).catch(() => {});
      console.log('📄 已进入主页:', ctx.page!.url().slice(0, 80));
    }

    // 登录态检查（httpOnly SESSDATA 需用 puppeteer cookie API）
    const hasLogin = ctx.page
      ? await ctx.page
          .cookies('https://www.bilibili.com')
          .then((cs) => cs.some((c) => c.name === 'SESSDATA' && c.value))
          .catch(() => false)
      : false;
    // 注入 LoginTask 所需配置（提前：登录流程 LoginTask 需要）
    ctx.state.set('loginUserDataDir', USER_DATA_DIR);
    ctx.state.set('loginHeadless', opts.headless);
    currentCtx = ctx;

    // 标签页变化监听（新增/关闭/导航）
    if (ctx.browser) {
      detachTab = await attachTabMonitor(ctx.browser).catch(() => null);
    }

    // 生成器 + 执行器：登录/登出等流程任务不经生成器，直接发给执行器 runTask
    gen = new PersonaDrivenGenerator(persona, {
      maxTasks: 1_000_000, // 仅防死循环，实际由 BROWSER_CLOSED 决定
      sessionDurationMs: Number.MAX_SAFE_INTEGER, // 无时长上限
      now: () => Date.now(),
    });
    gen.setControl(control); // 注入运行时控制（登录失效停止 / 热重启）
    const executor = new TaskExecutor(gen, ctx, {
      verbose: !!opts.verbose,
      stopOnError: false,
    });

    // 未登录：登录流程（login 触发）或保持等待——此时尚未「上线」（须打开浏览器并确认登录）
    if (!hasLogin) {
      if (control.forceLogin) {
        // login 指令触发的登录流程：直接执行登录任务（不经生成器）
        control.forceLogin = false;
        console.log('📱 执行登录任务（扫码登录）…');
        await executor.runTask(new LoginTask());
        if (ctx.state.get('isLoggedIn') !== true) {
          control.stopped = true; // 登录未完成 → 保持浏览器等待，重新 login
          console.error('❌ 登录未完成（未检测到登录态），请重新输入 login 指令登录。');
        }
      } else {
        // 非 login 触发：未登录不算上线，保持浏览器只留主页，回顶部等待 login
        control.stopped = true;
      }
      if (control.stopped) {
        await keepOnlyHomePage(ctx.browser).catch(() => {});
        keptCtx = ctx;
        currentCtx = ctx;
        continue; // 回 while 顶部：由统一等待提示告知用户（不打印「上线」头）
      }
      // 登录流程刚成功（isLoggedIn=true）→ 落入下方会话
    }

    // 到这里：浏览器已打开且确认登录 → 判定「上线」，打印上线头
    onlineCount += 1;
    console.log(`\n========== 上线 #${onlineCount} ========== ⏰ ${fmtClock(Date.now())}`);

    // 被动蹲饼：登录成功后才打开动态页并开始获取
    const loggedIn = hasLogin || ctx.state.get('isLoggedIn') === true;

    // 蹲饼目标对齐（每个 persona 一次）：登录后先获取当前关注 UP，与 persona.fetch_targets 比较，
    // 关注缺失的目标 UP；该流程结束后才进入模拟行为（其动态随后进入关注流被定向捕获）。
    const targets = persona.fetch_targets ?? [];
    if (loggedIn && targets.length > 0 && targetsSyncedFor !== persona.id) {
      console.log(`[${fmtClock(Date.now())}] [蹲饼目标] 🎯 开始对齐目标 UP（共 ${targets.length} 个）…`);
      const reports = await syncFetchTargets(ctx, targets).catch(() => []);
      for (const r of reports) {
        const tag = r.status === 'followed' ? '✅ 已关注' : r.status === 'now-followed' ? '➕ 新关注' : '⚠️ 失败';
        const who = r.target.name || r.target.uid || '(未命名)';
        console.log(`[蹲饼目标]   ${tag} ${who}${r.detail ? '｜' + r.detail : ''}`);
      }
      targetsSyncedFor = persona.id;
      console.log(`[${fmtClock(Date.now())}] [蹲饼目标] ✅ 目标 UP 对齐完成，开始进入模拟行为流程`);
    }

    const dynPage = loggedIn ? await ensureDynamicPage(ctx).catch(() => null) : null;
    if (dynPage) {
      console.log(`[${fmtClock(Date.now())}] [被动蹲饼] 🥞 就绪：动态页 ${dynPage.url().slice(0, 50)}（监听动态流接口获取动态数据）`);
      // 新开动态页标签时把主操作页切回前台（动态页作为后台常驻标签）
      if (ctx.page && !ctx.page.isClosed() && ctx.page !== dynPage) {
        await ctx.page.bringToFront().catch(() => {});
      }
      // 初次动态页获取：等首次 feed/all 获取流程结束（含滚动补全完成）后再启动任务生成与执行
      const ready = await waitForInitialFetch(dynPage, 25_000).catch(() => false);
      if (ready) {
        console.log(`[${fmtClock(Date.now())}] [被动蹲饼] ✅ 初次获取完成，开始启动任务生成与执行`);
      } else {
        console.warn(`[${fmtClock(Date.now())}] [被动蹲饼] ⚠️ 初次获取未在预期内完成（继续启动任务流，被动蹲饼后台照常）`);
      }
    } else if (loggedIn) {
      console.warn(`[${fmtClock(Date.now())}] [被动蹲饼] ⚠️ 未能打开动态页（后续由后台监视器持续重试）`);
    }

    let result;
    if (!control.stopped) {
      gen.setPaused(false); // 登录后生成器才开始生成任务
      try {
        result = await executor.execute();
      } catch (error) {
        console.error(`❌ 执行出错: ${(error as Error).message}`);
        result = {
          success: false,
          totalTasks: ctx.logs.length,
          successCount: 0,
          failedCount: 0,
          duration: 0,
          logs: ctx.logs,
          context: ctx,
        };
      }
    } else {
      result = { success: true, totalTasks: 0, successCount: 0, failedCount: 0, duration: 0, logs: ctx.logs, context: ctx };
    }

    // 解除标签页监听（避免关闭瞬间批量打印「标签页关闭」）
    detachTab?.();

    // logout 指令：登出任务不经生成器，直接发给执行器执行（关闭全部标签 → 仅 B 站主页 → 退出登录）
    if (control.forceLogout) {
      control.forceLogout = false;
      console.log('🚪 执行登出任务（关闭全部标签 → 仅 B 站主页 → 退出登录）…');
      const logoutLog = await executor.runTask(new LogoutTask()).catch(() => null);
      if (logoutLog?.success) {
        console.log('✅ 已退出登录');
      } else {
        console.warn('⚠️ 登出任务未成功完成（可重新输入 logout 指令重试）。');
      }
    }

    // 退出登录后停止任务生成：Logout 成功（isLoggedIn=false）→ 判定「下线（退出登录）」→ 立即置 stopped
    if (ctx.state.get('isLoggedIn') === false && !control.stopped) {
      control.stopped = true;
      console.log('🔚 本轮下线（已退出登录），浏览器保持打开（仅 B 站主页），请扫码后输入 login 指令重新登录。');
    }

    // 登录失效 / 未登录 / 退出登录 → 不关浏览器，只保留一个 B 站主页，保持打开等待 login 复用
    if (control.stopped) {
      await keepOnlyHomePage(ctx.browser).catch(() => {});
      keptCtx = ctx;
      currentCtx = ctx; // 保留引用：登录态/被动蹲饼监视器基于保持的浏览器继续运行
      continue; // 回 while 顶部：由统一等待提示告知用户（避免重复日志）
    }

    // 正常下线：关浏览器
    await ctx.browser?.close().catch(() => {});
    currentCtx = null;
    console.log('🔚 本轮下线（浏览器已关闭）');

    // 热重启：本次上线因 reload 结束 → 跳过下线休息，直接重新上线（while 顶部重载配置）
    if (control.reloadRequested) {
      acc.onlineCount += 1;
      acc.totalTasks += result.totalTasks;
      acc.successCount += result.successCount;
      acc.failedCount += result.failedCount;
      acc.onlineMs += Date.now() - onlineStart;
      console.log('   ♻️ 收到 reload：跳过下线休息，热重启重新上线…');
      continue;
    }

    // 本轮结果摘要
    console.log(`   任务: ${result.totalTasks} | 成功: ${result.successCount} | 失败: ${result.failedCount}`);
    const failed = result.logs.filter((l) => !l.success).slice(0, 5);
    for (const l of failed) {
      console.log(`   ⚠️ 失败 [${l.state}] ${l.taskName}: ${(l.error ?? '').slice(0, 80)}`);
    }

    // ===== 累计统计（跨上线周期）=====
    acc.onlineCount += 1;
    acc.totalTasks += result.totalTasks;
    acc.successCount += result.successCount;
    acc.failedCount += result.failedCount;
    for (const l of result.logs) {
      acc.taskHistogram[l.taskName] = (acc.taskHistogram[l.taskName] ?? 0) + 1;
    }
    acc.onlineMs += Date.now() - onlineStart;
    if (Date.now() - acc.lastSummaryAt >= SUMMARY_INTERVAL_MS) {
      acc.lastSummaryAt = Date.now();
      printSummary(`运行 ${((Date.now() - acc.startedAt) / 3600_000).toFixed(1)}h`);
    }

    // 下线休息：若本轮最后一任务是「长休息」（RestTask 已关闭浏览器下线）→ 离线时长 = 该任务 durationMs；
    // 否则按 persona 离线时长采样。到点重开下一轮（一直持续运行）。
    const lastLog = result.logs[result.logs.length - 1];
    const lastMeta = lastLog?.metadata as Record<string, unknown> | undefined;
    const longRestMs =
      lastLog?.taskName === 'Rest' && lastMeta?.longRest === true && typeof lastMeta?.durationMs === 'number'
        ? (lastMeta.durationMs as number)
        : 0;
    const offlineRange: [number, number] = circadian?.offline_minutes ?? [5, 120];
    const offlineMs = longRestMs > 0 ? longRestMs : sampleRange(offlineRange) * 60_000;
    acc.offlineMs += offlineMs;
    const wakeAt = Date.now() + offlineMs;
    console.log(
      `💤 [${fmtClock(Date.now())}] ${longRestMs > 0 ? '长休息' : '下线休息'} ${(offlineMs / 60_000).toFixed(1)} 分钟后再次上线（约 ${fmtClock(wakeAt)} 醒来）…`
    );
    // 下线休息倒计时：长休息（≥10min）5 分钟一次，短休息 1 分钟一次。
    // 休息中收到 reload 指令 → 提前结束休息，立即热重启（while 顶部重载配置）。
    const offlineTickMs = offlineMs >= 10 * 60_000 ? 5 * 60_000 : 60_000;
    let offlineElapsed = 0;
    while (offlineElapsed < offlineMs) {
      if (control.reloadRequested) {
        console.log('   ♻️ 休息中收到 reload，提前结束休息，热重启重开…');
        break;
      }
      if (control.forceOnline) {
        control.forceOnline = false;
        console.log('   🚀 休息中收到 online，提前结束休息，立即上线…');
        break;
      }
      const step = Math.min(offlineTickMs, offlineMs - offlineElapsed);
      await sleepReal(step);
      offlineElapsed += step;
      const remainMin = Math.max(0, (offlineMs - offlineElapsed) / 60_000);
      console.log(`   ⏳ [${fmtClock(Date.now())}] 距再次上线还差 ${remainMin.toFixed(1)} 分钟（约 ${fmtClock(wakeAt)} 醒来）`);
    }
    if (!control.reloadRequested) {
      console.log(`☀️ [${fmtClock(Date.now())}] 休息结束，重新上线`);
    }
  }
}
