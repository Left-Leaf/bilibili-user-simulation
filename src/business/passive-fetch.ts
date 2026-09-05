/**
 * 被动蹲饼（动态页监听，业务层）。
 *
 * 设计：不再主动去目标 UP 主页蹲饼（旧 fetch-slot 坑位已删除），改为「被动蹲饼」——
 * 保持浏览器内始终存在一个动态页（t.bilibili.com），并监听该页内部发起的动态流接口请求
 * （web-dynamic/v1/feed/all 初始加载 与 /feed/all/update 轮询更新），从响应 JSON 中提取动态数据。
 * 动态页在后台照常轮询，无需人工介入，也不占任务坑位。
 *
 * 数据出口：拦截到的动态**不保留**——
 * - 配置了外发接口（`setFetchReportConfig` 且 enable=true）→ 每次拦截到一批就 POST 给外部项目；
 * - 未配置外发接口 → 提炼基本信息（作者/时间/文案）追加写入本地文档 `logs/fetched-dynamics.md`。
 * 内存 `collected` 仅作运行期观察（status 展示）。
 *
 * 使用（bilibili-user-simulation 集成）：
 * - 每轮浏览器打开后调用一次 `ensureDynamicPage(ctx)`：打开/复用动态页并挂监听；
 * - 周期调用 `ensureDynamicPage(ctx)`（后台监视器）保持「始终存在」；
 * - 启动时 `setFetchReportConfig({ enable, url, batchSize })` 注册外发接口。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Browser, Page, ElementHandle, HTTPResponse } from 'puppeteer-core';
import type { TaskContext } from '../action/execute/context';
import { fetchCoordinator, TRIGGER_TASKS, SUSTAINED_TASKS } from './fetch-coordinator';
import { startFetchRecording, stopFetchRecording, type FetchRecording } from './record-fetch-video';
import { HumanMouse } from '../action/engine/human-mouse';
import { packagePath } from '../utils/paths';

/** 被动蹲到的一条动态 */
export interface FetchedDynamic {
  /** 动态 id（字符串） */
  dynId: string;
  /** 发布者 UP 名 */
  author: string;
  /** 发布者 uid */
  uid: string;
  /** 动态文案（截断到 200 字） */
  text: string;
  /** 发布时间（接口返回的秒时间戳，缺失为 0） */
  pubTs: number;
  /** 发布时间文本（接口返回的 pub_time 字符串，如 "2023-11-15 12:00:00"，缺失为空串） */
  pubTimeText: string;
  /** 动态类型（DYNAMIC_TYPE_* / MAJOR_TYPE_*，缺失为空串） */
  type: string;
  /** 抓到时刻（本地毫秒） */
  fetchedAt: number;
}

/** 动态流接口前缀（初始 feed/all 与轮询 feed/all/update 共用） */
const FEED_API_PREFIX = 'https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/all';

/** 外发接口配置：拦截到的动态 POST 给外部项目处理 */
export interface FetchReportConfig {
  /** 是否启用外发 */
  enable: boolean;
  /** 外部接口地址（POST JSON；请求体见 deliverToExternal） */
  url: string;
  /** 单次请求最多条数（超过则分拆多个请求发送），默认 50 */
  batchSize: number;
}

/** 当前外发配置（默认关闭） */
let reportConfig: FetchReportConfig = { enable: false, url: '', batchSize: 50 };

/**
 * 动态监听回调：主项目以「模块」方式接入时注册，模块内部每次捕获到一批动态即回调。
 * kind: 'INIT' 初始加载 / 'UPDATE' 轮询更新。注册后动态交给监听器（不再自动外发/落盘）。
 */
export type DynamicListener = (dynamics: FetchedDynamic[], kind: 'INIT' | 'UPDATE') => void;

let dynamicListener: DynamicListener | null = null;

/** 注册动态监听（模块接入方在启动引擎前调用）；传 null 取消，回到内置外发/落盘出口 */
export function setDynamicListener(listener: DynamicListener | null): void {
  dynamicListener = listener;
}

/** 未配置外发接口时动态落盘的本地文档（logs/ 已被 .gitignore 忽略，不会上传） */
const LOCAL_DOC_PATH = packagePath('logs', 'fetched-dynamics.md');

/** 注册外发接口配置（bilibili-user-simulation / watch-persona 启动时从 config-app.json5 读取后调用） */
export function setFetchReportConfig(cfg: FetchReportConfig): void {
  reportConfig = {
    enable: cfg.enable === true && !!cfg.url,
    url: cfg.url ?? '',
    batchSize: Number.isFinite(cfg.batchSize) && cfg.batchSize > 0 ? Math.floor(cfg.batchSize) : 50,
  };
  if (reportConfig.enable) {
    logDyn(`📤 接口配置：启用 | url=${reportConfig.url} | batch_size=${reportConfig.batchSize} | 数据出口=POST 外部项目`);
  } else {
    logDyn(`📄 接口配置：未启用（未配置 fetch_report）| 数据出口=写入本地文档 ${LOCAL_DOC_PATH}`);
  }
}

/**
 * 把拦截到的一批动态 POST 到外部接口（外部项目处理）。
 * 请求体：
 * { source: 'bilibili_dynamic', kind: 'INIT'|'UPDATE', captured_at: 毫秒, count, items: FetchedDynamic[] }
 */
async function deliverToExternal(dynamics: FetchedDynamic[], kind: 'INIT' | 'UPDATE'): Promise<void> {
  if (!reportConfig.enable || !reportConfig.url || dynamics.length === 0) {
    return;
  }
  const url = reportConfig.url;
  // 分拆：单次请求不超过 batchSize 条
  const batches: FetchedDynamic[][] = [];
  for (let i = 0; i < dynamics.length; i += reportConfig.batchSize) {
    batches.push(dynamics.slice(i, i + reportConfig.batchSize));
  }
  for (const batch of batches) {
    const body = {
      source: 'bilibili_dynamic',
      kind,
      captured_at: Date.now(),
      count: batch.length,
      items: batch,
    };
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        warnDyn(`📤 外发失败: HTTP ${resp.status}（${url}）`);
      } else {
        logDyn(`📤 已外发 ${batch.length} 条动态 → ${url}（${kind}）`);
      }
    } catch (err) {
      warnDyn(`📤 外发失败: ${(err as Error).message}（${url}）`);
    }
  }
}

/** 提炼动态基本信息（作者/时间/文案）追加写入本地文档（未配置外发接口时的兜底出口） */
function appendDynamicsToLocalDoc(dynamics: FetchedDynamic[], kind: 'INIT' | 'UPDATE'): void {
  try {
    const lines: string[] = [];
    const now = new Date().toLocaleString('zh-CN', { hour12: false });
    lines.push(`\n## ${now}｜${kind === 'INIT' ? '初始加载' : '轮询更新'}｜${dynamics.length} 条`);
    for (const d of dynamics) {
      // 时间：优先准确时间戳（绝对时间），pub_ts 缺失才退回接口相对文本
      const time = d.pubTs > 0 ? formatAbsTime(d.pubTs) : d.pubTimeText || '（未知）';
      lines.push(`- 作者：${d.author || d.uid || '匿名'}`);
      lines.push(`  时间：${time}`);
      lines.push(`  内容：${d.text || '（无文案）'}`);
      lines.push('');
    }
    fs.mkdirSync(path.dirname(LOCAL_DOC_PATH), { recursive: true });
    // 顶部写入：新抓到的动态放在文档最前面（最新在最上），旧内容顺延到下方
    const newBlock = lines.join('\n').trimStart();
    const existing = fs.existsSync(LOCAL_DOC_PATH) ? fs.readFileSync(LOCAL_DOC_PATH, 'utf-8').trimStart() : '';
    fs.writeFileSync(LOCAL_DOC_PATH, existing ? `${newBlock}\n\n${existing}` : newBlock, 'utf-8');
    logDyn(`📄 动态已写入本地文档 ${LOCAL_DOC_PATH}`);
  } catch (err) {
    warnDyn(`📄 写入本地文档失败: ${(err as Error).message}`);
  }
}

/** 数据出口统一入口 + 蹲饼信息打印：每次蹲到动态都打印作者/时间/内容（控制台与日志文件双写） */
function deliverDynamics(dynamics: FetchedDynamic[], kind: 'INIT' | 'UPDATE'): void {
  if (dynamics.length === 0) {
    return;
  }
  if (sessionActive) {
    sessionDelivered = true; // 本次蹲饼获取期间取到新动态（供「刷新后仍未取到」的二次尝试判断）
  }
  // 蹲饼信息：本次蹲到的动态摘要（作者/时间/内容）
  logDyn(`🥞 蹲到动态 ${dynamics.length} 条（${kind === 'INIT' ? '初始加载' : '轮询更新'}）`);
  for (const d of dynamics.slice(0, 10)) {
    // 时间：优先准确时间戳（绝对时间），pub_ts 缺失才退回接口相对文本
    const time = d.pubTs > 0 ? formatAbsTime(d.pubTs) : d.pubTimeText || '（未知）';
    console.log(`   - ${d.author || d.uid || '匿名'} [${time}]: ${(d.text || '（无文案）').slice(0, 60)}`);
  }
  if (dynamics.length > 10) {
    console.log(`   … 其余 ${dynamics.length - 10} 条省略`);
  }
  // 数据出口：
  // - 模块接入方注册了动态监听（setDynamicListener / 引擎 onDynamics）→ 交给监听器（外发/落盘由主项目决定）
  // - 否则（example 独立运行）：配置了外发接口 → POST 外部项目；未配置 → 提炼基本信息写本地文档
  if (dynamicListener) {
    dynamicListener(dynamics, kind);
    return;
  }
  if (reportConfig.enable) {
    void deliverToExternal(dynamics, kind);
  } else {
    appendDynamicsToLocalDoc(dynamics, kind);
  }
}

/** 已收集的动态（内存存储，进程内有效；展示时倒序 = 最新在前） */
const collected: FetchedDynamic[] = [];
const MAX_COLLECTED = 1000;

/** 已挂监听的页面（幂等，防重复挂载；页面销毁后由 WeakSet 自动回收） */
const attached = new WeakSet<object>();

/**
 * 上次已获取最新动态（统一的增量基线，持久化单个值跨重启，永不膨胀）。
 * 记录 dynId + pubTs（发布时间）：
 * - dynId 用于精确匹配（基线未删除时）
 * - pubTs 用于「越界式」判断（基线被删除时，靠时间判断是否已翻过基线）：
 *   每次获取新动态一直加载（滚动补全）到「出现不晚于基线发布时间」的批次为止，
 *   基线之后（更新）的是真正新增，基线及之前（更旧）的是已抓过的不重复写。
 */
const LAST_FETCHED_PATH = packagePath('data', 'last-fetched-dynamic.json');

/** 读取上次已获取最新动态（文件不存在/解析失败返回空基线） */
function loadLastFetched(): { dynId: string; pubTs: number } {
  try {
    const raw = fs.readFileSync(LAST_FETCHED_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as { dynId?: unknown; pubTs?: unknown };
    return {
      dynId: typeof parsed.dynId === 'string' ? parsed.dynId : '',
      pubTs: typeof parsed.pubTs === 'number' && Number.isFinite(parsed.pubTs) ? parsed.pubTs : 0,
    };
  } catch {
    return { dynId: '', pubTs: 0 };
  }
}

/** 保存上次已获取最新动态 */
function saveLastFetched(dynId: string, pubTs: number): void {
  try {
    fs.mkdirSync(path.dirname(LAST_FETCHED_PATH), { recursive: true });
    fs.writeFileSync(LAST_FETCHED_PATH, JSON.stringify({ dynId, pubTs, at: Date.now() }), 'utf-8');
  } catch {
    /* 忽略 */
  }
}

/** 上次已获取最新动态（增量基线） */
const lastFetched = loadLastFetched();
let lastFetchedDynId = lastFetched.dynId;
let lastFetchedPubTs = lastFetched.pubTs;
/** 本次增量获取的全局最新（第一页最新），滚动补全完成后提交为基线 */
let sessionLatest: { dynId: string; pubTs: number } | null = null;
/** 本次滚动补全要追的旧基线发布时间（触发补全时固定，防止补全过程中基线变化） */
let catchUpBoundaryPubTs = 0;

/** 增量补全状态：idle=无补全；catching-up=正在滚动加载剩余新动态（直到越过已获取基线） */
let syncState: 'idle' | 'catching-up' = 'idle';
/** 滚动补全最大段数（防死循环） */
const MAX_CATCHUP_SCROLL = 50;

/** 是否动态页 URL（t.bilibili.com） */
export function isDynamicPageUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === 't.bilibili.com' || u.hostname.endsWith('.t.bilibili.com');
  } catch {
    return false;
  }
}

/** 在浏览器现有标签页中找动态页（可排除某页，如当前活动页） */
export async function findDynamicPage(browser: Browser, exclude?: Page): Promise<Page | null> {
  try {
    const pages = await browser.pages();
    return pages.find((p) => p !== exclude && isDynamicPageUrl(p.url())) ?? null;
  } catch {
    return null;
  }
}

/** 兼容 number / string 的秒时间戳（B 站接口 pub_ts 常为字符串）；毫秒自动转秒；非法返回 0 */
function toSecTimestamp(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v > 1e12 ? Math.floor(v / 1000) : v;
  }
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) {
    const n = Number(v);
    return n > 1e12 ? Math.floor(n / 1000) : n;
  }
  return 0;
}

/** 秒时间戳 → 本地绝对时间文本（如 2026/8/11 12:09:42） */
const formatAbsTime = (sec: number): string => new Date(sec * 1000).toLocaleString('zh-CN', { hour12: false });

/**
 * 取本批**最新**的一条（pubTs 最大）——增量基线必须是最新那条，不依赖列表排列方向。
 * 兜底：pubTs 全部缺失时退回到列表第一条（B 站 feed/all 实际为从新到旧、第一条即最新）。
 */
function latestOf(dynamics: FetchedDynamic[]): FetchedDynamic | undefined {
  if (dynamics.length === 0) {
    return undefined;
  }
  let latest = dynamics[0];
  for (const d of dynamics) {
    if (d.pubTs > latest.pubTs) {
      latest = d;
    }
  }
  return latest;
}

/** 从动态流接口响应 JSON 中提取动态列表（解析失败返回 []） */
export function extractDynamicsFromPayload(payload: unknown): FetchedDynamic[] {
  const out: FetchedDynamic[] = [];
  try {
    const root = payload as { code?: number; data?: { items?: unknown[] } };
    if (root?.code !== 0 || !Array.isArray(root.data?.items)) {
      return out;
    }
    for (const raw of root.data!.items!) {
      const item = (raw ?? {}) as Record<string, unknown>;
      const modules = (item.modules ?? {}) as Record<string, unknown>;
      const author = (modules.module_author ?? {}) as Record<string, unknown>;
      const dyn = (modules.module_dynamic ?? {}) as Record<string, unknown>;
      const desc = (dyn.desc ?? {}) as Record<string, unknown>;
      // 动态文案：desc.text 优先；视频动态 desc.text 常为空 → 兜底取视频标题/图文信息
      let text = typeof desc.text === 'string' ? desc.text.trim() : '';
      if (!text) {
        const major = (dyn.major ?? {}) as Record<string, unknown>;
        const archive = (major.archive ?? {}) as Record<string, unknown>;
        if (typeof archive.title === 'string' && archive.title) {
          text = `[视频] ${archive.title}`;
        } else {
          const draw = (major.draw ?? {}) as Record<string, unknown>;
          const drawCount = Array.isArray(draw.items) ? draw.items.length : 0;
          text = drawCount > 0 ? `[图文] 共 ${drawCount} 张图` : `[${String(item.type ?? '动态').replace('DYNAMIC_TYPE_', '')}]`;
        }
      }
      out.push({
        dynId: typeof item.id_str === 'string' ? item.id_str : String(item.id ?? ''),
        author: typeof author.name === 'string' ? author.name : '',
        uid: author.mid === undefined || author.mid === null ? '' : String(author.mid),
        text: text.slice(0, 200),
        pubTs: toSecTimestamp(author.pub_ts),
        pubTimeText: typeof author.pub_time === 'string' ? author.pub_time : '',
        type: typeof item.type === 'string' ? item.type : '',
        fetchedAt: Date.now(),
      });
    }
  } catch {
    /* 解析失败忽略 */
  }
  return out;
}

/** 「有新动态，点击查看」按钮选择器（外层容器 + 内层文本 div） */
const NOTIF_SELECTOR = '.bili-dyn-list__notification .bili-dyn-list-notification, .bili-dyn-list__notification';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 带超时的 Promise：后台标签页的 CDP 调用（page.$ / evaluate / boundingBox / mouse 事件）可能挂起，
 *  超时返回 null 让流程继续——避免被动蹲饼的 CDP 写操作在后台标签挂起导致卡死。 */
const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | null> => Promise.race([p.catch(() => null), sleep(ms).then(() => null)]);

/** 与任务日志一致格式的被动蹲饼日志：`[HH:mm:ss] [被动蹲饼] …`（统一时间戳 + 标签） */
const logDyn = (...args: unknown[]): void => {
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`[${t}] [被动蹲饼] ${args.map((a) => String(a)).join(' ')}`);
};
const warnDyn = (...args: unknown[]): void => {
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.warn(`[${t}] [被动蹲饼] ${args.map((a) => String(a)).join(' ')}`);
};

/**
 * update 接口只提示「有 N 条新动态」（update_num>0），不返回数据；
 * 需点击页面上的「有新动态，点击查看」按钮，触发动态流重新加载才能真正获取。
 * 这里：等按钮出现 → **真实鼠标点击**（B 站按钮需真实鼠标事件，JS click 无效）→
 * 随后触发的 feed/all 响应会被同一监听器捕获并外发。
 *
 * 设计原则（用户要求）：项目**不定义轮询时间**，只由页面自身的请求驱动——
 * 本函数由「update 响应 update_num>0」触发；找不到按钮就快速返回，
 * 重试完全依赖 B 站页面自己 ~30s 一次的 update 轮询（下轮响应再触发）。
 * 这里唯一的等待是「等按钮渲染」的功能性等待（≤8s），不是轮询定时器。
 */
/** 点击「有新动态」按钮后的时间窗（诊断用：识别点击触发的 feed/all 是否含增量） */
let justClickedUntil = 0;
/** 最近一次点击是否未取到增量（供 runFetchSession 刷新动态页兜底） */
let lastClickMissed = false;
/** 本次蹲饼获取流程是否已刷新过（区分「点击后未发现」与「刷新后未发现」提示） */
let refreshedThisFetch = false;

/** 若页面在后台则临时切到前台，返回原前台页（操作完需恢复）；页面本在前台返回 null */
async function bringToFrontIfHidden(page: Page): Promise<Page | null> {
  const hidden = await withTimeout(
    page.evaluate(() => document.visibilityState === 'hidden'),
    3000
  ).catch(() => null);
  if (hidden !== true) {
    return null;
  }
  const pages = ((await withTimeout(page.browser().pages(), 3000)) as Page[] | null) ?? [];
  let prevFront: Page | null = null;
  for (const p of pages) {
    if (p === page) {
      continue;
    }
    const vis = await withTimeout(
      p.evaluate(() => document.visibilityState),
      3000
    ).catch(() => 'hidden');
    if (vis === 'visible') {
      prevFront = p;
      break;
    }
  }
  await page.bringToFront().catch(() => {});
  await sleep(250);
  return prevFront;
}

/**
 * 滚动补全：上次最新饼之后还有未加载的新动态（单批只返回前 20 条）→ 向下起伏滚动
 * 触发加载下一页（后台滚动不触发 IntersectionObserver，故切回动态页前台），
 * 直到某批响应覆盖「上次最新饼」（监听器把 syncState 置 idle）或达到最大段数。
 *
 * 按当前任务分类协调（避免与任务冲突）：
 * - 触发式（Like/Triple/Search/Follow/Comment/CloseVideo/OpenVideo 短任务）：等待任务完成后再滚动补全
 * - 持续式（BrowseHome/BrowseDynamic/BrowseProfile/WatchVideo/Rest 长任务）：暂停任务流，直接切动态页前台滚动 → 返回原前台页
 * 补全滚动期间需阻塞任务流：若调用方（runFetchSession 入口）已暂停则复用；独立补全（初始加载/滚动响应）时自己暂停。
 */
async function startCatchUpScroll(page: Page): Promise<void> {
  const task = fetchCoordinator.currentTaskName;
  const ownPause = !fetchCoordinator.paused; // 已在暂停中（runFetchSession 入口已 pause）则不重复，避免提前解除
  if (ownPause) {
    fetchCoordinator.pause();
  }
  try {
    // 触发式：先等当前任务完成（pause 已拦住新任务启动）→ 切动态页前台滚动 → 返回原标签
    if (TRIGGER_TASKS.has(task)) {
      await waitTaskIdle(20_000);
    }
    // 持续式及默认：暂停任务流（ownPause 已处理）→ 切动态页前台滚动 → 回原前台页
    const prevFront = await bringToFrontIfHidden(page).catch(() => null);
    await humanScrollCatchUp(page);
    if (prevFront) {
      await prevFront.bringToFront().catch(() => {});
    }
  } finally {
    if (ownPause) {
      fetchCoordinator.resume();
    }
  }
}

/** 等当前任务完成（executor 在任务结束时把 currentTaskName 置 'IDLE'） */
async function waitTaskIdle(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = fetchCoordinator.currentTaskName;
    if (t === 'IDLE' || t === '') {
      return;
    }
    await sleep(300);
  }
}

/**
 * 起伏式慢速滚动（模拟真人，避免跳屏风控）：缓慢向下滚动并偶尔轻微回滚，
 * 直到补全完成（syncState 回 idle）或达到最大段数。
 */
async function humanScrollCatchUp(page: Page): Promise<void> {
  const viewH = page.viewport()?.height ?? 800;
  for (let i = 0; i < MAX_CATCHUP_SCROLL; i++) {
    if (syncState !== 'catching-up') {
      break; // 已覆盖上次最新饼 → 完成
    }
    // 缓慢向下滚一段（~1/5 视口），smooth 平滑、不跳屏
    const dy = Math.round(viewH * (0.15 + Math.random() * 0.08));
    await withTimeout(
      page.evaluate((d) => window.scrollBy({ top: d, behavior: 'smooth' }), dy),
      3000
    ).catch(() => {});
    await sleep(500 + Math.random() * 500);
    // 真人浏览起伏：偶尔轻微回滚
    if (Math.random() < 0.2) {
      const back = Math.round(viewH * (0.03 + Math.random() * 0.03));
      await withTimeout(
        page.evaluate((d) => window.scrollBy({ top: -d, behavior: 'smooth' }), back),
        3000
      ).catch(() => {});
      await sleep(300 + Math.random() * 300);
    }
  }
  if (syncState === 'catching-up') {
    // 滚动达到上限仍未覆盖（可能已到底或接口异常）→ 停止本轮补全，避免卡死
    syncState = 'idle';
    catchUpBoundaryPubTs = 0; // 清理残留边界，防止污染后续增量判断
    sessionLatest = null;
    warnDyn('⚠️ 滚动补全达到上限仍未覆盖上次最新饼（可能已无更多或加载异常），暂停本轮');
  }
}

/** 等「有新动态」按钮出现并真实点击（后台/前台均可——配合禁后台节流参数后台点击可触发 feed/all） */
async function clickNotifyButton(page: Page): Promise<void> {
  let handle: ElementHandle<Element> | null = null;
  for (let i = 0; i < 16; i++) {
    handle = (await withTimeout(page.$(NOTIF_SELECTOR), 3000)) as ElementHandle<Element> | null;
    if (handle) {
      break;
    }
    if (i % 4 === 0) {
      await withTimeout(
        page.evaluate(() => window.scrollTo(0, 0)),
        3000
      ).catch(() => {}); // 滚动回顶部帮助按钮渲染
    }
    await sleep(500);
  }
  if (!handle) {
    warnDyn('📤 update 提示有新动态，但按钮未出现（重试由下轮 update 响应驱动）');
    return;
  }
  // 真实鼠标点击：先滚动到视口中心，再取中心坐标用 page.mouse 点击（触发完整鼠标事件链）
  await withTimeout(
    handle.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' })),
    3000
  ).catch(() => {});
  await sleep(300);
  const box = (await withTimeout(handle.boundingBox(), 3000)) as { x: number; y: number; width: number; height: number } | null;
  if (!box) {
    warnDyn('📤 「有新动态」按钮不可见，无法点击（重试由下轮 update 响应驱动）');
    return;
  }
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  // 真实拟人移动：贝塞尔逐步移动到按钮（含小概率漫游），停顿后再点击
  const mouse = new HumanMouse(page);
  await withTimeout(mouse.visibleMoveTo({ x, y }), 3000).catch(() => {});
  await sleep(120 + Math.random() * 180);
  await withTimeout(page.mouse.click(x, y), 3000).catch(() => {});
  logDyn(`🖱️ 检测到新动态提示，已真实鼠标点击按钮 (${Math.round(x)},${Math.round(y)})，等待获取…`);
  // 标记点击后的时间窗：后续 feed/all 响应若仍无新动态，说明点击未取到增量（诊断用）
  justClickedUntil = Date.now() + 5000;
}

/** 被动蹲饼获取是否进行中（防重入） */
let sessionActive = false;
/** 本次蹲饼获取期间是否已取到新动态（deliverDynamics 置位；runFetchSession 开头/finally 重置） */
let sessionDelivered = false;
// 任务分类（触发式/持续式）常量与判断见 fetch-coordinator：TRIGGER_TASKS / SUSTAINED_TASKS / isSustainedTask

/** 停止录屏并提示保存位置（幂等） */
async function finishRecording(rec: FetchRecording | null): Promise<void> {
  if (!rec) {
    return;
  }
  const out = await stopFetchRecording(rec);
  if (out) {
    logDyn(`🎬 录屏已保存：${out}（${rec.frames.length} 帧）`);
  }
}

/** 点击后未取到增量 → 刷新动态页兜底（触发完整初始 feed/all，已收录的动态会被增量检测补收）。录屏会覆盖刷新画面。 */
async function retryByRefresh(page: Page): Promise<void> {
  if (!lastClickMissed) {
    return;
  }
  lastClickMissed = false;
  refreshedThisFetch = true;
  // 开新时间窗：刷新后的 feed/all 若仍未取到，会走「刷新后未发现」提示
  justClickedUntil = Date.now() + 5000;
  logDyn('🔄 点击未取到增量，刷新动态页兜底');
  await withTimeout(page.reload({ waitUntil: 'domcontentloaded' }), 30_000).catch(() => {});
}

/**
 * 刷新兜底后仍未取到新动态 → 二次尝试：先恢复任务流，等待 1 分钟后重新阻塞并再次刷新动态页。
 * 用于处理「收录延迟」——首次刷新时后端尚未把新动态排入 feed，稍等再刷可命中；
 * 已取到增量（sessionDelivered）时直接跳过。
 *
 * 等待期间**不阻塞任务流**：先 resume 恢复生成/执行，让 60 秒不浪费（任务继续跑）；
 * 到点二次刷新前再 pause 重新阻塞，避免刷新动作与任务流并发冲突。
 */
async function retryRefreshAfterMinute(page: Page): Promise<void> {
  if (sessionDelivered) {
    return; // 本次蹲饼已取到新动态
  }
  // 等待期间先恢复任务流（runFetchSession finally 还会 resume，幂等无副作用）
  fetchCoordinator.resume();
  logDyn('⏳ 刷新后仍未取到新动态，先恢复任务流，等待 60 秒后再次刷新…');
  await sleep(60_000);
  if (sessionDelivered) {
    logDyn('✅ 等待期间已取到新动态（任务流继续），取消二次刷新');
    return;
  }
  // 到点：重新阻塞任务流，再做二次刷新
  fetchCoordinator.pause();
  refreshedThisFetch = true;
  // 开新时间窗：二次刷新后的 feed/all 若仍未取到，会走「刷新后未发现」提示
  justClickedUntil = Date.now() + 5000;
  logDyn('🔄 等待 60 秒后再次刷新动态页（二次尝试获取 update 增量）');
  await withTimeout(page.reload({ waitUntil: 'domcontentloaded' }), 30_000).catch(() => {});
  await sleep(1500); // 等刷新后的 feed/all 响应处理（取到则 deliver，未取到提示「刷新后未发现」）
  // 二次刷新仍未取到 → 第三层兜底：关闭动态页重新打开（排除页面状态异常；新页初始加载走增量检测/滚动补全重新拉取）
  if (!sessionDelivered) {
    await reopenDynamicPage(page);
  }
}

/**
 * 第三层兜底：二次刷新后仍未取到新动态 → 关闭动态页重新打开。
 * 用于排除「动态页页面状态异常」类问题（页面 JS 卡死 / feed 流断掉 / 点击刷新未真正生效）：
 * 关闭旧动态页 → 新开一个动态页标签并重新挂接口监听 → 新页初始 feed/all 加载走统一增量检测
 * （有基线时含滚动补全追基线），尝试重新拉取 update 提示的增量。
 * 新页作为后续动态页常驻（监听器随新页生效，后续 update 由新页触发 runFetchSession）。
 */
async function reopenDynamicPage(page: Page): Promise<void> {
  const browser = page.browser();
  logDyn('🔁 二次刷新仍未取到，关闭动态页重新打开（重置页面状态）…');
  await page.close().catch(() => {});
  try {
    const newPage = await browser.newPage();
    attachDynamicFeedListener(newPage); // 立即挂监听，新页初始加载即可走增量检测
    await withTimeout(newPage.goto('https://t.bilibili.com/', { waitUntil: 'domcontentloaded' }), 30_000).catch(() => {});
    if (!isDynamicPageUrl(newPage.url())) {
      await newPage.close().catch(() => {});
      warnDyn('⚠️ 重开动态页失败（未进入动态页），本次兜底无效');
      return;
    }
    // 等新页初始 feed/all 响应处理（取到增量提前结束；最长 20s）
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !sessionDelivered) {
      await sleep(500);
    }
    if (sessionDelivered) {
      logDyn('✅ 重开动态页后获取到新动态');
    } else {
      warnDyn('⚠️ 重开动态页后仍未取到新动态（可能收录延迟 / B 站接口异常，等下次 update 再试）');
    }
  } catch (err) {
    warnDyn(`⚠️ 重开动态页异常: ${(err as Error).message}`);
  }
}

/**
 * 被动蹲饼获取流程：update 提示有更新时，根据**当前正在执行的任务**分类处理（触发式等待完成 / 持续式暂停），
 * 避免与任务冲突。**入口即暂停任务流**——生成器 next 检查 paused，不再生成新任务：
 * - BrowseDynamic（持续式 + 冲突最大）：直接中断结束当前任务 → 回滚顶部 → 点击 → 等补全 → 刷新兜底
 * - 持续式（BrowseHome/BrowseProfile/WatchVideo/Rest 长任务）：暂停任务流 → 切动态页前台 → 点击 → 等 feed/all → 刷新兜底
 * - 触发式（Like/Triple/Search/Follow/Comment/CloseVideo/OpenVideo 短任务）：等待当前任务完成 → 切动态页前台 → 点击
 * - Login 不会触发被动蹲饼（登录是打开浏览器→主页→登录→动态页的前置流程之一，动态页监听未就绪）
 */
async function runFetchSession(page: Page, updateNum: number): Promise<void> {
  if (sessionActive) {
    return; // 上一次蹲饼获取进行中，忽略
  }
  sessionActive = true;
  sessionDelivered = false; // 本次蹲饼尚未取到新动态
  const task = fetchCoordinator.currentTaskName;
  logDyn(`🎯 被动蹲饼触发（当前任务: ${task || '无'}，update ${updateNum} 条）`);
  // 监听到 update 即暂停任务流：生成器 next 检查 paused，不再生成新任务。
  // 触发式任务等待完成即可；持续式任务暂停即可。
  fetchCoordinator.pause();
  // 若上次滚动补全仍在进行（syncState='catching-up'），先等它完成再处理本次蹲饼，
  // 避免补全与本次点击/增量判断并发共享 syncState/catchUpBoundaryPubTs/sessionLatest 造成冲突
  // （补全由初始加载/无边界响应异步触发，不受 sessionActive 保护）
  if (syncState === 'catching-up') {
    logDyn('⏳ 上次滚动补全仍在进行，等待完成…');
    const catchUpDeadline = Date.now() + 35_000;
    while (Date.now() < catchUpDeadline && syncState === 'catching-up') {
      await sleep(300);
    }
    if (syncState === 'catching-up') {
      // 补全超时仍未完成（可能滚动卡住）→ 强制结束补全并清理状态，避免阻塞本次蹲饼
      syncState = 'idle';
      catchUpBoundaryPubTs = 0;
      sessionLatest = null;
      warnDyn('⚠️ 等待滚动补全超时，强制结束补全');
    }
  }
  // 录屏：记录本次获取完整流程（切前台→点击→feed/all 重载→增量判断），用于回放定位获取不到的问题
  const rec = await startFetchRecording(page);
  if (rec) {
    logDyn('🎬 开始录屏记录本次获取流程');
  }
  try {
    if (task === 'BrowseDynamic') {
      // 持续式 + 冲突最大（都在动态页）：直接中断结束当前任务 → 回滚顶部 → 点击 → 等补全 → 刷新兜底
      fetchCoordinator.requestInterrupt();
      try {
        await sleep(600); // 给 BrowseDynamic 停留循环响应中断
        await withTimeout(
          page.evaluate(() => window.scrollTo(0, 0)),
          3000
        ).catch(() => {});
        await clickNotifyButton(page); // 动态页已在前台，直接点击
        // 等点击触发的 feed/all 响应处理 + 滚动补全完成（syncState 回 idle）后再恢复任务流
        const afterClick = Date.now();
        await waitCatchUpDone(afterClick);
        // 点击后未取到增量 → 刷新动态页兜底（动态页仍在前台，录屏覆盖刷新画面）
        await retryByRefresh(page);
        await sleep(1500); // 等刷新后的初始 feed/all 响应处理（取到则 deliver，未取到提示「刷新后未发现」）
        // 刷新后仍未取到 → 等 1 分钟再次刷新（任务流保持阻塞），处理收录延迟
        await retryRefreshAfterMinute(page);
        // 停录：动态页仍在前台，已覆盖点击+刷新（含二次刷新）全流程
        await finishRecording(rec);
      } finally {
        fetchCoordinator.clearInterrupt();
      }
      logDyn('✅ 被动蹲饼（BrowseDynamic 场景）完成，恢复任务流');
    } else if (SUSTAINED_TASKS.has(task)) {
      // 持续式（浏览主页/UP 主页/观看视频/短休息）：暂停任务流（入口已暂停）→ 切动态页前台 → 点击 → 等 feed/all → 刷新兜底
      const prevFront = await bringToFrontIfHidden(page).catch(() => null);
      // 录屏期：保持动态页前台，让点击后的 feed/all 重载可被录到（后台标签 screencast 不出帧）
      try {
        await clickNotifyButton(page);
        await sleep(2500); // 等点击后 feed/all 异步响应处理（WARN/fresh 判断），期间动态页保持前台
        await retryByRefresh(page);
        await sleep(1500); // 等刷新后的初始 feed/all 响应处理（取到则 deliver，未取到提示「刷新后未发现」）
        await retryRefreshAfterMinute(page);
        await finishRecording(rec);
      } finally {
        if (prevFront) {
          void prevFront.bringToFront().catch(() => {});
        }
      }
    } else {
      // 触发式（Like/Triple/Search/Follow/Comment/CloseVideo/OpenVideo 短任务）：等待当前任务完成（pause 已拦住新任务）→ 切动态页前台点击
      await waitTaskIdle(20_000);
      const prevFront = await bringToFrontIfHidden(page).catch(() => null);
      try {
        await clickNotifyButton(page);
        await sleep(2500);
        await retryByRefresh(page);
        await sleep(1500);
        await retryRefreshAfterMinute(page);
        await finishRecording(rec);
      } finally {
        if (prevFront) {
          void prevFront.bringToFront().catch(() => {});
        }
      }
    }
  } finally {
    fetchCoordinator.clearInterrupt();
    fetchCoordinator.resume(); // 恢复任务流（生成器可继续生成下一个任务）
    sessionActive = false;
    sessionDelivered = false; // 本次获取流程结束，重置「已取到」标记
    refreshedThisFetch = false; // 本次获取流程结束，重置刷新标记
    // 兜底停录（上面异常提前退出时），幂等不重复
    void finishRecording(rec).catch(() => {});
  }
}

/** 点击后等待补全稳定（点击后 3s 起：若触发滚动补全则等其完成；否则视为已完成） */
async function waitCatchUpDone(afterClickAt: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (syncState !== 'catching-up' && Date.now() - afterClickAt > 3000) {
      return; // 未触发补全（已覆盖基线）或补全已完成
    }
    await sleep(500);
  }
}

/** 给动态页挂上动态流接口响应监听（幂等：同一页面只挂一次） */
export function attachDynamicFeedListener(page: Page): void {
  if (attached.has(page)) {
    return;
  }
  attached.add(page);
  page.on('response', (response) => {
    const url = response.url();
    if (!url.startsWith(FEED_API_PREFIX)) {
      return;
    }
    void (async () => {
      try {
        const payload = await response.json();
        const isUpdate = url.includes('/update');
        const data = (payload as { code?: number; data?: Record<string, unknown> })?.data ?? {};
        const updateNum = typeof data.update_num === 'number' ? data.update_num : 0;
        const dynamics = extractDynamicsFromPayload(payload);

        // update 接口只提示（update_num>0 但无 items）→ 点击「有新动态」按钮触发真实获取
        // （配合浏览器禁后台节流参数，动态页在后台时页面 JS 仍活跃，后台点击即可触发 feed/all 重载；
        //   不走直接调接口，避免机器人风控）
        if (isUpdate && updateNum > 0 && dynamics.length === 0) {
          logDyn(`🔔 update 提示 ${updateNum} 条新动态（接口未返回数据，需点击获取）`);
          void runFetchSession(page, updateNum);
          return;
        }
        // update 接口直接带 items（兼容情况）→ 与初始/轮询一致外发
        if (dynamics.length === 0) {
          return;
        }
        // ===== 统一增量检测（越界式单基线：上次已获取最新，持久化 dynId+pubTs 不膨胀）=====
        // 首次启动（无基线）：首批全量作为初始加载收下，建立基线（最新 dynId + pubTs），不触发滚动补全
        if (!lastFetchedDynId && !lastFetchedPubTs) {
          for (const d of dynamics) {
            collected.push(d);
          }
          while (collected.length > MAX_COLLECTED) {
            collected.shift();
          }
          const latest = latestOf(dynamics);
          lastFetchedDynId = latest?.dynId ?? '';
          lastFetchedPubTs = latest?.pubTs ?? 0;
          saveLastFetched(lastFetchedDynId, lastFetchedPubTs);
          deliverDynamics(dynamics, 'INIT');
          return;
        }

        // 越界式边界判断：本批出现「不晚于基线发布时间」的动态（pubTs <= 边界）→ 已翻过基线 → 增量完整。
        // 基线 dynId 被删除时，靠 pubTs 仍能判断边界（更旧的动态还在）；dynId 精确匹配作为额外兜底。
        const boundaryPubTs = catchUpBoundaryPubTs || lastFetchedPubTs;
        const hasBoundary = dynamics.some(
          (d) => (d.dynId !== '' && d.dynId === lastFetchedDynId) || (d.pubTs > 0 && boundaryPubTs > 0 && d.pubTs <= boundaryPubTs)
        );

        if (hasBoundary) {
          // 已越过基线 → 本批中比基线更新的（pubTs > 边界）才是本次新动态 → 增量完整
          const memSet = new Set(collected.map((d) => d.dynId));
          const fresh = dynamics.filter((d) => d.pubTs > boundaryPubTs && !memSet.has(d.dynId));
          if (fresh.length > 0) {
            for (const d of fresh) {
              collected.push(d);
            }
            while (collected.length > MAX_COLLECTED) {
              collected.shift();
            }
            deliverDynamics(fresh, isUpdate ? 'UPDATE' : 'INIT');
            lastClickMissed = false; // 本批取到增量，清除点击漏抓标记（防一次点击多次响应误刷新）
          } else if (Date.now() < justClickedUntil) {
            if (refreshedThisFetch) {
              warnDyn('⚠️ 刷新后 feed/all 仍未发现新动态（未取到 update 提示的增量）');
            } else {
              lastClickMissed = true;
              warnDyn('⚠️ 点击按钮后 feed/all 未发现新动态（未取到 update 提示的增量）');
            }
          }
          // 基线更新为本次全局最新（第一页最新；pubTs 取最大，不依赖顺序）
          const latest = sessionLatest || latestOf(dynamics);
          lastFetchedDynId = latest?.dynId ?? lastFetchedDynId;
          lastFetchedPubTs = latest?.pubTs ?? lastFetchedPubTs;
          saveLastFetched(lastFetchedDynId, lastFetchedPubTs);
          sessionLatest = null;
          catchUpBoundaryPubTs = 0;
          syncState = 'idle';
        } else {
          // 未越过基线 → 本批都在基线之后（都是新增或已在内存）→ 还没追到上次已获取最新，
          // 说明上次之后的新动态超过单批数量，还有未加载的 → 触发滚动补全
          const memSet = new Set(collected.map((d) => d.dynId));
          const fresh = dynamics.filter((d) => d.pubTs > boundaryPubTs && !memSet.has(d.dynId));
          if (fresh.length > 0) {
            for (const d of fresh) {
              collected.push(d);
            }
            while (collected.length > MAX_COLLECTED) {
              collected.shift();
            }
            deliverDynamics(fresh, isUpdate ? 'UPDATE' : 'INIT');
            lastClickMissed = false; // 本批取到增量，清除点击漏抓标记
          }
          // 记录本次全局最新（第一页最新），补全完成后提交为基线
          if (!sessionLatest) {
            const latest = latestOf(dynamics);
            sessionLatest = latest ? { dynId: latest.dynId, pubTs: latest.pubTs } : null;
          }
          // 固定滚动补全的追边界标（防止补全过程中基线变化导致无法终止）
          if (!catchUpBoundaryPubTs) {
            catchUpBoundaryPubTs = lastFetchedPubTs;
          }
          if (syncState !== 'catching-up') {
            logDyn(`🔁 本批未越过已抓基线（时间边界）→ 滚动加载补全`);
            syncState = 'catching-up';
            void startCatchUpScroll(page);
          }
        }
      } catch {
        /* JSON 解析失败忽略 */
      }
    })();
  });
}

/**
 * 等待动态页首次 feed/all 获取流程结束（供启动流程：先完成初次获取，再启动任务生成与执行）。
 * - 等待动态页发出第一个 feed/all（非 update）响应（初始加载）；
 * - 若该响应触发了滚动补全（syncState='catching-up'），继续等到补全完成（回 idle）。
 * @returns true=初次获取完成；false=超时（调用方继续启动，被动蹲饼后台照常）
 */
export async function waitForInitialFetch(page: Page, timeoutMs = 25_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  // 等动态页第一个 feed/all（初始加载）响应到达
  const got = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      page.off('response', onResp);
      resolve(false);
    }, timeoutMs);
    const onResp = (response: HTTPResponse): void => {
      const url = response.url();
      if (!url.startsWith(FEED_API_PREFIX) || url.includes('/update')) {
        return;
      }
      clearTimeout(timer);
      page.off('response', onResp);
      resolve(true);
    };
    page.on('response', onResp);
  });
  if (!got) {
    return false;
  }
  // 给监听器建基线/判边界的时间；若触发滚动补全则等其完成
  await sleep(600);
  while (Date.now() < deadline && syncState === 'catching-up') {
    await sleep(500);
  }
  return true;
}

/**
 * 确保浏览器内存在一个动态页（被动蹲饼目标页）：
 * - 当前活动页已是动态页 → 直接用它（挂监听）；
 * - 其它标签已有动态页 → 复用（挂监听）；
 * - 无 → 新开一个动态页标签（t.bilibili.com）并挂监听（不改变 context.page）。
 * 返回动态页；打开失败返回 null。
 */
export async function ensureDynamicPage(context: TaskContext): Promise<Page | null> {
  const browser = context.browser;
  if (!browser) {
    return null;
  }
  // 当前活动页已是动态页 → 直接使用
  if (context.page && !context.page.isClosed() && isDynamicPageUrl(context.page.url())) {
    attachDynamicFeedListener(context.page);
    return context.page;
  }
  // 其它标签已有动态页 → 复用
  const existing = await findDynamicPage(browser, context.page ?? undefined);
  if (existing) {
    attachDynamicFeedListener(existing);
    return existing;
  }
  // 无 → 新开一个动态页标签（后台常驻；context.page 保持不变）
  try {
    const page = await browser.newPage();
    attachDynamicFeedListener(page);
    await page.goto('https://t.bilibili.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    // 校验确为动态页（防跳转/加载失败时堆积空白标签）；失败则关闭并返回 null 供下次重试
    if (!isDynamicPageUrl(page.url())) {
      await page.close().catch(() => {});
      return null;
    }
    return page;
  } catch {
    return null;
  }
}

/** 已收集的全部动态（最新在前） */
export function getCollectedDynamics(): FetchedDynamic[] {
  return [...collected].reverse();
}

/** 已收集动态条数 */
export function getDynamicCount(): number {
  return collected.length;
}
