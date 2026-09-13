/**
 * 被动蹲饼（动态页监听，业务层）。
 *
 * 设计：不再主动去目标 UP 主页蹲饼（旧 fetch-slot 坑位已删除），改为「被动蹲饼」——
 * 保持浏览器内始终存在一个动态页（t.bilibili.com），并监听该页内部发起的动态流接口请求
 * （web-dynamic/v1/feed/all 初始加载 与 /feed/all/update 轮询更新），从响应 JSON 中提取动态数据。
 * 动态页在后台照常轮询，无需人工介入，也不占任务坑位。
 *
 * 数据出口：拦截到的动态**原样透传、不做任何筛选**——
 * - 输出为 B 站接口 `data.items[]` 的**原始动态对象**（未裁剪/未改名），内含 UP 信息
 *   （`modules.module_author`：UP 的 uid / 名称 / 头像，见 `dynAuthor()`）；
 * - **筛选（按 UP / 关键词 / 类型…）完全由外部调用方决定**，蹲饼只保证「原始 + 含 UP 信息」；
 * - 出口 = 注册的动态监听回调（`setDynamicListener()` / 内核 `createDynamicListener()`）。
 *
 * 增量范围（**基线 = 启动参数，不落盘**）：保证「基线之后的动态不缺失」——
 * - 宿主在 `startFetch({ baselineTs })` 传入基线（秒时间戳）；缺省 = 当前时间（= 只投递开启之后新产生的动态）；
 * - **pubTs 严格晚于基线** 且没见过的动态都会被投递；
 * - 单次响应只返回一页（约 20 条），若本批**没翻过基线**（全在基线之后）说明中间还有未加载的 → 
 *   **强制滚动补全**直到翻过基线或滚动到底；
 * - 滚动到底仍未到达基线 → 本次补全**失败**，基线重置为「本次已获取的最新」（该缺口已超出动态页可加载范围）。
 *
 * 使用（bilibili-user-simulation 集成）：
 * - 每轮浏览器打开后调用一次 `ensureDynamicPage(ctx)`：打开/复用动态页并挂监听；
 * - 周期调用 `ensureDynamicPage(ctx)`（后台监视器）保持「始终存在」。
 */
import type { Browser, Page, ElementHandle, HTTPResponse } from 'puppeteer-core';
import type { TaskContext } from '../action/execute/context';
import { EXCLUSIVE_TASKS, fetchCoordinator, SUSTAINED_TASKS, TRIGGER_TASKS } from './fetch-coordinator';
import { isDynamicPageUrl } from '../utils/bilibili-dom';
import { HumanMouse } from '../action/engine/human-mouse';
import { HumanScroller } from '../action/engine/human-scroller';
import { installPageRuntimeShim } from '../utils/page-runtime';
import { clipText, sanitizeLoneSurrogates } from '../utils/text';

/**
 * B 站动态流接口返回的**单条动态**（原样，字段与接口一致，不做任何裁剪/改名）。
 *
 * 出口数据 = 原始 `items` 数组，宿主可直接按 B 站字段使用（`id_str` / `type` / `basic` /
 * `modules.module_author` / `modules.module_dynamic.major` / `modules.module_stat` / `orig` …）。
 * 类型故意保持宽松（索引签名）：B 站加字段不影响解析与透传。
 */
export interface BiliDynamicItem {
  /** 动态 id（字符串） */
  id_str?: string;
  /** 动态类型：DYNAMIC_TYPE_WORD / DRAW / AV / FORWARD / LIVE_RCMD / … */
  type?: string;
  visible?: boolean;
  /** 基础信息：rid_str / comment_id_str / jump_url / is_only_fans … */
  basic?: Record<string, unknown>;
  /** 模块集合：module_author / module_dynamic / module_stat / module_more / … */
  modules?: {
    module_author?: Record<string, unknown>;
    module_dynamic?: Record<string, unknown>;
    module_stat?: Record<string, unknown>;
    [key: string]: unknown;
  };
  /** 转发的原动态（结构与本类型相同；非转发为 null） */
  orig?: BiliDynamicItem | null;
  /** 其余字段原样保留 */
  [key: string]: unknown;
}

/** 取动态 id（`id_str`，缺失回退 `id`）—— 仅用于增量基线与去重，不改动原始数据 */
export function dynId(item: BiliDynamicItem | null | undefined): string {
  if (!item) {
    return '';
  }
  const s = item.id_str;
  if (typeof s === 'string' && s) {
    return s;
  }
  const n = item.id;
  return n === undefined || n === null ? '' : String(n);
}

/** 取动态作者：`module_author.mid`（接口为 number）与 `name` */
export function dynAuthor(item: BiliDynamicItem | null | undefined): { uid: string; name: string } {
  const author = (item?.modules?.module_author ?? {}) as Record<string, unknown>;
  const mid = author.mid;
  return {
    uid: mid === undefined || mid === null ? '' : String(mid),
    name: typeof author.name === 'string' ? author.name : '',
  };
}

/** 取发布时间（秒时间戳；`module_author.pub_ts` 接口为字符串，缺失为 0） */
export function dynPubTs(item: BiliDynamicItem | null | undefined): number {
  const author = (item?.modules?.module_author ?? {}) as Record<string, unknown>;
  return toSecTimestamp(author.pub_ts);
}

/**
 * 取发布时间的**相对文本**（`module_author.pub_time`）：接口返回的是相对时间，
 * 如「18分钟前」「昨天」「09-10」—— 需要绝对时间请用 `dynPubTs()`。
 */
export function dynPubTimeText(item: BiliDynamicItem | null | undefined): string {
  const author = (item?.modules?.module_author ?? {}) as Record<string, unknown>;
  return typeof author.pub_time === 'string' ? author.pub_time : '';
}

/**
 * 取动态正文文本（**仅供日志 / 本地文档等可读输出**；出口数据仍是原始 item）。
 * 优先级：`module_dynamic.desc.text` → `major.opus.summary.text`（新版图文，desc 常为 null）
 * → `major.archive.title`（视频）→ `major.draw.items.length`（旧版图文计数）→ `[转发] 原动态` → `[TYPE]`。
 */
export function dynText(item: BiliDynamicItem | null | undefined, maxLen = 200): string {
  const dyn = (item?.modules?.module_dynamic ?? {}) as Record<string, unknown>;
  const desc = (dyn.desc ?? {}) as Record<string, unknown>;
  let text = typeof desc.text === 'string' ? desc.text.trim() : '';
  const major = (dyn.major ?? {}) as Record<string, unknown>;
  if (!text) {
    const opus = (major.opus ?? {}) as Record<string, unknown>;
    const summary = (opus.summary ?? {}) as Record<string, unknown>;
    if (typeof summary.text === 'string' && summary.text.trim()) {
      text = summary.text.trim();
    }
  }
  if (!text) {
    const archive = (major.archive ?? {}) as Record<string, unknown>;
    if (typeof archive.title === 'string' && archive.title) {
      text = `[视频] ${archive.title}`;
    }
  }
  if (!text) {
    const draw = (major.draw ?? {}) as Record<string, unknown>;
    const drawCount = Array.isArray(draw.items) ? draw.items.length : 0;
    if (drawCount > 0) {
      text = `[图文] 共 ${drawCount} 张图`;
    }
  }
  if (!text && item?.orig) {
    text = `[转发] ${dynText(item.orig, 120)}`;
  }
  if (!text) {
    text = `[${String(item?.type ?? '动态').replace('DYNAMIC_TYPE_', '')}]`;
  }
  return clipText(text, maxLen); // 按完整字符截断：不会把 emoji 劈成孤立代理字符
}

/** 动态流接口前缀（初始 feed/all 与轮询 feed/all/update 共用） */
const FEED_API_PREFIX = 'https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/all';

/**
 * 动态监听回调：主项目以「模块」方式接入时注册，模块内部每次捕获到一批动态即回调。
 *
 * `items` 为**B 站原始动态对象数组**（与接口 `data.items[]` 一致，未做裁剪、**未做任何筛选**）：
 * 一次回调可能包含**任意多个关注 UP** 的动态（包含系统类账号），筛选（只关心某些 UP 等）由监听方自行处理。
 * UP 信息在 `item.modules.module_author`（可用 `dynAuthor(item)` 取 `{ uid, name }`）。
 *
 * `kind` 的含义 = **本次 `startFetch` 以来的第几批**：
 * - `'INIT'`：本次 `startFetch` 的**首次投递**（只有一次）；
 * - `'UPDATE'`：其余全部（点击获取 / 刷新 / 滚动补全 / 重开页拉回的增量）。
 *
 * ⚠️ 两种 kind 都是**增量**（只含 `baselineTs` 之后、且没投递过的动态），
 * 不是「全量快照」；宿主应当**追加**，不要按 `'INIT'` 重建列表。
 */
export type DynamicListener = (items: BiliDynamicItem[], kind: 'INIT' | 'UPDATE') => void;

let dynamicListener: DynamicListener | null = null;

/**
 * 本次 `startFetch` 以来是否已投递过（决定 `kind`：首次投递 = `'INIT'`，其余 = `'UPDATE'`）。
 * 每次 `setFetchBaseline()`（= 内核 `startFetch`）重置。
 */
let deliveredSinceStart = false;

/** 注册动态监听（模块接入方在启动引擎前调用）；传 null 取消 */
export function setDynamicListener(listener: DynamicListener | null): void {
  dynamicListener = listener;
}

/** 数据出口统一入口 + 蹲饼信息打印：每次蹲到动态都打印作者/时间/内容（控制台与日志文件双写） */
function deliverDynamics(items: BiliDynamicItem[], kind: 'INIT' | 'UPDATE'): void {
  if (items.length === 0) {
    return;
  }
  if (sessionActive) {
    sessionDelivered = true; // 本次蹲饼获取期间取到新动态（供「刷新后仍未取到」的二次尝试判断）
  }
  // 蹲饼信息：本次蹲到的动态摘要（仅日志展示；出口数据为 B 站原始 item）
  logDyn(`🥞 蹲到新动态 ${items.length} 条（${kind === 'INIT' ? '首屏' : '增量'}）`);
  for (const item of items.slice(0, 10)) {
    const { uid, name } = dynAuthor(item);
    const ts = dynPubTs(item);
    const time = ts > 0 ? formatAbsTime(ts) : dynPubTimeText(item) || '（未知）';
    // 作者名来自 B 站接口（可能自带孤立代理字符）→ 清洗；正文按完整字符截断
    console.log(
      `   - ${sanitizeLoneSurrogates(name) || uid || '匿名'} [${time}]: ${clipText(dynText(item) || '（无文案）', 60)}`
    );
  }
  if (items.length > 10) {
    console.log(`   … 其余 ${items.length - 10} 条省略`);
  }
  // 数据出口：交给注册的动态监听器（setDynamicListener / 内核 createDynamicListener）
  dynamicListener?.(items, kind);
}

/** 已见过的动态 id（**进程内去重**用；不保存原始数据）——判断「是否新增」的唯一依据 */
const seenIds = new Set<string>();
/** 已见 id 的插入顺序（配合 seenIds 做容量上限的先进先出淘汰，避免集合无限增长） */
const seenOrder: string[] = [];
const MAX_SEEN = 2000;

/** 登记「已见过的动态 id」（初始加载与每次投递后都要登记） */
function remember(items: BiliDynamicItem[]): void {
  for (const item of items) {
    const id = dynId(item);
    if (id && !seenIds.has(id)) {
      seenIds.add(id);
      seenOrder.push(id);
    }
  }
  while (seenOrder.length > MAX_SEEN) {
    const oldest = seenOrder.shift();
    if (oldest !== undefined) {
      seenIds.delete(oldest);
    }
  }
}

/**
 * 记录一批响应里的两个关键信息：
 * - 全局最新时间戳（`newestFetchedPubTs`）：补全失败时把基线重置为它；
 * - 当前已加载列表里**最旧**的那条（`bottomLoadedId` / `bottomLoadedPubTs`）：滚动补全用它判断
 *   「这一滚有没有加载出更旧的内容」（没变 = 到底了）。
 */
function trackBatch(dynamics: BiliDynamicItem[]): void {
  for (const item of dynamics) {
    const ts = dynPubTs(item);
    if (ts <= 0) {
      continue;
    }
    if (ts > newestFetchedPubTs) {
      newestFetchedPubTs = ts;
    }
    const id = dynId(item);
    if (id && ts < bottomLoadedPubTs) {
      bottomLoadedPubTs = ts;
      bottomLoadedId = id;
    }
  }
}

/** 已挂监听的页面（幂等，防重复挂载；页面销毁后由 WeakSet 自动回收） */
const attached = new WeakSet<object>();

/**
 * 蹲饼总开关（供内核独立开关「蹲饼」功能）。
 * - true（默认）：监听器正常解析 / 投递新增动态 / 触发点击获取；
 * - false：监听器保留但直接返回，不再解析/投递/触发（页面与已见集合保持不变，
 *   重新开启后从「没见过的动态」继续，不会重复投递已经投递过的动态）。
 */
let fetchEnabled = true;

/** 打开/关闭蹲饼（内核切换用；默认开启，保持各独立启动入口原有行为） */
export function setFetchEnabled(enabled: boolean): void {
  if (fetchEnabled === enabled) {
    return;
  }
  fetchEnabled = enabled;
  logDyn(enabled ? '🥞 蹲饼已开启' : '🥞 蹲饼已关闭（监听保留，不再解析/投递动态）');
}

/** 蹲饼当前是否开启 */
export function isFetchEnabled(): boolean {
  return fetchEnabled;
}

/**
 * 增量基线（秒时间戳）：**pubTs 严格晚于它的动态都必须获取并投递**（保证不缺失）。
 * 由宿主在 `kernel.startFetch({ baselineTs })` 传入（缺省 = 当前时间 = 只投递开启之后新产生的动态）；
 * **不落盘**——宿主自行持久化（可取已收到动态 `pub_ts` 的最大值，或 `stopFetch()` 的返回值）。
 *
 * 基线只在「确认已覆盖」时前进（某批响应里出现了不晚于基线的动态 → 说明基线之后的都已拿到），
 * 因此滚动补全过程中目标恒定、不会自我漂移。
 */
let baselinePubTs = 0;

/** 本次运行已获取到的最新动态时间戳（补全失败时把基线重置为它） */
let newestFetchedPubTs = 0;

/** 当前已加载列表里最旧的那条（id + pubTs）：滚动补全用它判断「还能不能加载出更旧的内容」 */
let bottomLoadedId = '';
let bottomLoadedPubTs = Number.MAX_SAFE_INTEGER;

/** 滚动补全状态：idle=无补全；catching-up=正在强制滚动补全到基线 */
let syncState: 'idle' | 'catching-up' = 'idle';
/**
 * 滚动补全函数是否还在运行（**比 syncState 更严格**）。
 * `syncState` 是「监听器翻过基线」那一刻就置 idle 的目标标志，但滚动循环要等本轮 sleep/滚轮
 * 结束后才在下一轮开头退出，`startCatchUpScroll` 还要做模拟状态恢复 + resume——
 * 所以「是否真正让出页面」必须以本标志为准，否则会「补全还在滚，模拟已经开始了」。
 */
let catchUpRunning = false;
/** 最近一次补全是否失败（滚动到底/滚动无效/超时/被中止 = 未到达基线） */
let catchUpFailed = false;

/** 滚动补全兜底时间上限（正常靠「已到底/已翻过基线」终止；时间跨度长时允许它一直往前拉） */
const CATCHUP_MAX_MS = 15 * 60_000;
/** 每段滚动后等页面加载下一页的时间 */
const CATCHUP_STEP_WAIT_MS = 1200;
/** 连续多少段「没加载出新内容且已在文档底部」判定为已滚动到底 */
const CATCHUP_BOTTOM_ROUNDS = 2;
/** 连续多少段「滚动位置完全没变化」判定为滚动无法生效 */
const CATCHUP_STUCK_ROUNDS = 3;

/**
 * 设置本次蹲饼的增量基线（内核 `startFetch` 调用；不传/非法 = 当前时间）。
 * 基线时间之后的动态都会被获取并投递（单批不够时会强制滚动补全）。
 */
export function setFetchBaseline(baselineTs?: number): void {
  const ts = toSecTimestamp(baselineTs);
  baselinePubTs = ts > 0 ? ts : Math.floor(Date.now() / 1000);
  newestFetchedPubTs = baselinePubTs;
  bottomLoadedId = '';
  bottomLoadedPubTs = Number.MAX_SAFE_INTEGER;
  catchUpFailed = false;
  deliveredSinceStart = false; // 新的蹲饼周期：下一次投递重新算作首屏（kind = 'INIT'）
  logDyn(`🥞 蹲饼基线：${formatAbsTime(baselinePubTs)}（之后的动态都会获取并投递）`);
}

/** 当前基线（秒时间戳；0 = 尚未设置）。宿主可持久化并在下次 `startFetch({ baselineTs })` 传回 */
export function getFetchBaseline(): number {
  return baselinePubTs;
}

/** 动态页 URL 判定（统一实现在 `utils/bilibili-dom`，此处 re-export 保持既有导入路径可用） */
export { isDynamicPageUrl };

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
 * 从动态流接口响应 JSON 中提取**原始动态列表**（与接口 `data.items[]` 一致，原样透传，
 * 不裁剪/不改名/不合成字段）。
 * 蹲饼采集**关注流全部 UP** 的动态；**不做任何筛选**（不按 UP / 关键词 / 类型过滤），
 * 筛选由外部调用方自行处理。想跟进新的 UP 用 `follow` 指令关注即可。
 * - `code !== 0` 或 `items` 非数组 → 返回 `[]`；
 * - 解析失败不抛错。
 */
export function extractDynamicsFromPayload(payload: unknown): BiliDynamicItem[] {
  try {
    const root = payload as { code?: number; data?: { items?: unknown } };
    if (root?.code !== 0 || !Array.isArray(root.data?.items)) {
      return [];
    }
    return (root.data!.items as unknown[]).filter((it): it is BiliDynamicItem => !!it && typeof it === 'object');
  } catch {
    return [];
  }
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
 * 随后触发的 feed/all 响应会被同一监听器捕获并投递。
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

/** 触发式任务的等待上限：超过则不再等（告警后直接操作页面，避免蹲饼被卡死） */
const TRIGGER_WAIT_MS = 20_000;

/**
 * 取得「页面独占权」——蹲饼与滚动补全在操作页面前必须先调用（统一策略）：
 *
 * 1. **触发式任务**（短、高度自闭）→ 等它**顺利完成**（上限 `TRIGGER_WAIT_MS`）；
 * 2. **持续式任务**（长、过程不稳定）→ 请求**提前中止**（`abortCurrentTask()` →
 *    任务在分片检查点收尾）并等它结束；
 * 3. **浏览器独占型任务**（登录/登出流程）→ **让出**本次机会（返回 false）。
 *
 * 未登记在任何一个清单里的任务按 ① 处理（并告警），保证「所有任务都有明确处理」。
 *
 * @returns 是否已取得独占权（false = 本次蹲饼/补全应放弃）
 */
async function acquirePageOwnership(task: string): Promise<boolean> {
  if (!task || task === 'IDLE') {
    return true; // 无任务在执行，页面空闲
  }
  if (EXCLUSIVE_TASKS.has(task)) {
    return false;
  }
  if (SUSTAINED_TASKS.has(task)) {
    const aborted = await fetchCoordinator.abortCurrentTask().catch(() => false);
    if (aborted) {
      logDyn(`⏹️ 已提前中止持续性任务（${task}），页面交给蹲饼`);
    }
    return true;
  }
  // 触发式（含未登记的短任务/流程性任务）：等它顺利完成
  if (!TRIGGER_TASKS.has(task)) {
    warnDyn(`⚠️ 未登记的任务类型（${task}），按触发式处理：等其完成`);
  }
  await waitTaskIdle(TRIGGER_WAIT_MS);
  return true;
}

/**
 * 第三类任务（登录/登出）是否已接管浏览器。
 *
 * 执行器在任务开始时写 `currentTaskName`，因此它一旦变为 `Login`/`Logout`，
 * 说明最高优先级任务已开始 —— 蹲饼必须**立刻让出浏览器**（不再切前台/点击/滚动/刷新）。
 */
const exclusiveTaskRunning = (): boolean => EXCLUSIVE_TASKS.has(fetchCoordinator.currentTaskName);

/**
 * 蹲饼会话/补全是否必须**立即中止**：
 * - 蹲饼已被关闭（`setFetchEnabled(false)`，如 stopFetch / 登出）；
 * - 第三类任务（登录/登出）已接管浏览器（最高优先级，强制中断其他任何操作）。
 *
 * 会话在会等人的检查点调用它，命中则立即收尾并**不再改动页面**。
 */
const shouldAbortFetch = (): boolean => !fetchEnabled || exclusiveTaskRunning();

/**
 * 「模拟状态」保护：会话开始前快照，会话结束（含异常）后恢复。
 *
 * 蹲饼会切前台、点按钮、刷新、必要时关页重开——都可能破坏模拟对页面的假设
 * （`context.page` 失效 / 前台被抢 / 滚动位置变化）。快照/恢复由内核提供
 * （`fetchCoordinator.snapshotSimulationState`）；未注册（无模拟运行）时直接执行。
 */
async function withSimulationStateRestore<T>(fn: () => Promise<T>): Promise<T> {
  const restore = (await fetchCoordinator.snapshotSimulationState?.().catch(() => null)) ?? null;
  try {
    return await fn();
  } finally {
    // 第三类任务（登录/登出）已接管浏览器 → 不再动页面，避免与它抢前台/滚动
    if (restore && !exclusiveTaskRunning()) {
      await restore().catch(() => undefined);
    }
  }
}

/** 读页面滚动位置与「是否已在文档底部」（滚动补全推进/到底判定用） */
async function readScrollMetrics(page: Page): Promise<{ y: number; atBottom: boolean }> {
  const m = (await withTimeout(
    page.evaluate(() => {
      const doc = document.documentElement;
      const y = window.scrollY || doc.scrollTop || 0;
      const h = Math.max(doc.scrollHeight, document.body ? document.body.scrollHeight : 0);
      const vh = window.innerHeight || 0;
      return { y, h, vh };
    }),
    3000
  ).catch(() => null)) as { y: number; h: number; vh: number } | null;
  if (!m) {
    return { y: 0, atBottom: false };
  }
  return { y: m.y, atBottom: m.vh > 0 && m.y + m.vh >= m.h - 50 };
}

/**
 * 滚动补全（强制）：本批响应未翻过基线 → 基线之后还有没加载到的动态 → 逼页面加载更旧的页。
 *
 * 与任务流的协调（与 runFetchSession 同一套策略）：
 * 1. 先 `acquirePageOwnership()`——触发式等其完成 / 持续式提前中止 / 登录登出让出本次机会；
 * 2. 补全前后 `withSimulationStateRestore()` 快照/恢复模拟状态。
 * 补全期间阻塞任务流：调用方（runFetchSession 入口）已暂停则复用，否则自己暂停并在结束时恢复。
 */
async function startCatchUpScroll(page: Page): Promise<void> {
  if (catchUpRunning) {
    return; // 已有补全在跑（防重入）
  }
  catchUpRunning = true;
  const task = fetchCoordinator.currentTaskName;
  const ownPause = !fetchCoordinator.paused; // 已在暂停中则不重复 pause，避免提前解除别人的阻塞
  if (ownPause) {
    fetchCoordinator.pause();
  }
  try {
    if (!(await acquirePageOwnership(task))) {
      syncState = 'idle';
      logDyn(`⏭️ 当前任务（${task}）独占浏览器，跳过本次滚动补全（基线保持，待下次继续）`);
      return;
    }
    if (shouldAbortFetch()) {
      syncState = 'idle';
      logDyn('⏭️ 蹲饼已关闭 / 登录登出接管浏览器，跳过本次滚动补全（基线保持，待下次继续）');
      return;
    }
    await withSimulationStateRestore(async () => {
      const prevFront = await bringToFrontIfHidden(page).catch(() => null); // 后台滚动不触发加载
      try {
        await humanScrollCatchUp(page);
      } finally {
        if (prevFront && !exclusiveTaskRunning()) {
          await prevFront.bringToFront().catch(() => {});
        }
      }
    });
  } finally {
    if (ownPause) {
      fetchCoordinator.resume();
    }
    catchUpRunning = false; // 恢复模拟状态 + resume 之后才算真正让出页面
    logDyn('🏁 滚动补全已收尾（页面与任务流已交还）');
  }
}

/**
 * 强制滚动直到基线位置（不设段数上限，允许它往前拉足够长时间）。
 *
 * 「滚动到底」判定（不靠固定段数）：每滚一段后同时看两个信号——
 * 1) 当前已加载列表里**最旧**的那条动态（`bottomLoadedId`）有没有变：变了 = 又加载出更旧的内容，继续拉；
 * 2) 页面是否**已在文档底部**（`scrollY + 视口 >= 文档高度`）。
 * 两者同时成立且连续多段无变化 → 判定已到底（动态页没有更多可加载）。
 *
 * 「滚动无效」判定：若连续多段 `scrollY` 完全没变，说明滚轮没作用到可滚动主体（**不是到底**）——
 * 这种情况不重置基线（否则会误丢数据），只报失败留给下次继续。
 *
 * 结果：翻过基线 = 成功（监听器已把 syncState 置 idle）；到底/超时 = 失败且基线重置为「本次已获取最新」；
 * 滚动无效/被中止 = 失败但基线保持不变。
 */
async function humanScrollCatchUp(page: Page): Promise<void> {
  const target = baselinePubTs;
  const viewH = page.viewport()?.height ?? 800;
  const deadline = Date.now() + CATCHUP_MAX_MS;
  const scroller = new HumanScroller();
  let bottomRounds = 0;
  let stuckRounds = 0;
  let reason: 'bottom' | 'stuck' | 'timeout' = 'timeout';

  while (syncState === 'catching-up' && Date.now() < deadline && !shouldAbortFetch()) {
    const before = await readScrollMetrics(page);
    const bottomBefore = bottomLoadedId;
    // 真实鼠标滚轮向下滚一段（分步、走页面主体，避开局部滚动容器）
    const segment = Math.round(viewH * (0.6 + Math.random() * 0.4));
    await scroller.scrollToPosition(page, before.y + segment).catch(() => {});
    await sleep(CATCHUP_STEP_WAIT_MS + Math.random() * 500); // 等页面加载下一页
    if (syncState !== 'catching-up') {
      return; // 本轮期间已翻过基线（监听器已收尾）→ 立刻停滚，不再多滚一段
    }

    if (bottomLoadedId !== bottomBefore) {
      bottomRounds = 0; // 又加载出更旧的内容 → 还能继续往前拉
      stuckRounds = 0;
      continue;
    }
    const after = await readScrollMetrics(page);
    if (after.y <= before.y + 10) {
      stuckRounds += 1; // 滚动位置没变 → 滚轮没作用到主体（不是到底）
      if (stuckRounds >= CATCHUP_STUCK_ROUNDS) {
        reason = 'stuck';
        break;
      }
      continue;
    }
    stuckRounds = 0;
    if (after.atBottom) {
      bottomRounds += 1;
      if (bottomRounds >= CATCHUP_BOTTOM_ROUNDS) {
        reason = 'bottom';
        break;
      }
    } else {
      bottomRounds = 0;
    }
  }

  if (syncState !== 'catching-up') {
    return; // 过程中某批翻过基线 → 成功（监听器已收尾）
  }
  syncState = 'idle';
  if (shouldAbortFetch()) {
    logDyn('⏭️ 滚动补全中止（蹲饼已关闭 / 登录登出接管浏览器），基线保持不变，下次继续');
    return;
  }
  if (Date.now() >= deadline) {
    reason = 'timeout';
  }
  catchUpFailed = true;
  if (reason === 'stuck') {
    warnDyn(
      `❌ 滚动补全失败（滚动无法生效）：连续 ${CATCHUP_STUCK_ROUNDS} 段滚动位置未变化，` +
        `基线保持 ${formatAbsTime(target)}，下次继续尝试`
    );
    return;
  }
  // 到底 / 超时：缺口已超出可加载范围 → 基线重置为最新已获取（可见范围内已全部投递）
  if (newestFetchedPubTs > baselinePubTs) {
    baselinePubTs = newestFetchedPubTs;
  }
  warnDyn(
    `❌ 滚动补全失败（${reason === 'bottom' ? '已滚动到底' : '超出时间上限'}）仍未到达基线 ${formatAbsTime(target)}` +
      `｜可见范围内动态已全部投递，基线重置为最新已获取：${formatAbsTime(baselinePubTs)}`
  );
}

/** 等正在进行的滚动补全**真正结束**（超时则强制收尾，避免两个补全争抢页面）
 *
 * 判定依据是 `catchUpRunning`（补全函数已退出、页面已让出）而不只是 `syncState`：
 * `syncState` 在「翻过基线」那一刻就被监听器置 idle，此时滚动循环可能还在本轮滚动中。
 * @returns true=补全已正常收尾（翻过基线/到底/滚动无效）；false=等待超时被强制结束 */
async function waitOngoingCatchUp(): Promise<boolean> {
  const busy = (): boolean => catchUpRunning || syncState === 'catching-up';
  if (!busy()) {
    return true;
  }
  logDyn('⏳ 滚动补全进行中，等它结束…');
  const deadline = Date.now() + CATCHUP_MAX_MS + 5_000;
  while (Date.now() < deadline && busy()) {
    await sleep(300);
  }
  if (busy()) {
    syncState = 'idle';
    warnDyn('⚠️ 等待滚动补全超时，强制结束本轮补全（基线保持，下次继续）');
    return false;
  }
  return true;
}

/** 点击后等补全稳定：点击后 3s 起，若已触发滚动补全则等它**真正结束**（翻过基线 / 到底 / 被中止） */
async function waitCatchUpDone(clickedAt: number): Promise<void> {
  const deadline = Date.now() + CATCHUP_MAX_MS + 5_000;
  while (Date.now() < deadline && !shouldAbortFetch()) {
    if (!catchUpRunning && syncState !== 'catching-up' && Date.now() - clickedAt > 3000) {
      return; // 未触发补全（已翻过基线）或补全已真正结束（页面已让出）
    }
    await sleep(500);
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

/**
 * 等待正在进行的蹲饼会话 / 滚动补全**真正让出页面**（幂等；无会话时立即返回）。
 *
 * 供内核在启动**最高优先级任务**（登录/登出）前调用：
 * 先 `setFetchEnabled(false)`（即 `kernel.stopFetch()`）让它不再继续，
 * 再等它真正让出浏览器，避免登录/登出与残留的蹲饼操作争抢前台与标签页。
 */
export async function waitForFetchIdle(timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && (sessionActive || catchUpRunning || syncState === 'catching-up')) {
    await sleep(200);
  }
}
// 任务分类（触发式/持续式/浏览器独占型）常量见 fetch-coordinator：TRIGGER_TASKS / SUSTAINED_TASKS /
// EXCLUSIVE_TASKS / isSustainedTask；取得页面独占权的统一入口见 acquirePageOwnership()

/** 点击后未取到增量 → 刷新动态页兜底（刷新会重新请求 feed/all，其中没见过的动态照常投递） */
async function retryByRefresh(page: Page): Promise<void> {
  if (!lastClickMissed) {
    return;
  }
  lastClickMissed = false;
  refreshedThisFetch = true;
  // 开新时间窗：刷新后的 feed/all 若仍未取到，会走「刷新后未发现」提示
  justClickedUntil = Date.now() + 5000;
  logDyn('🔄 点击后尚未出现 → 刷新动态页再试一次');
  await withTimeout(page.reload({ waitUntil: 'domcontentloaded' }), 30_000).catch(() => {});
}

/**
 * 刷新兜底后仍未取到新动态 → 二次尝试：先恢复任务流，等待 1 分钟后**重新取得页面独占权**再刷新。
 * 用于处理「收录延迟」——首次刷新时后端尚未把新动态排入 feed，稍等再刷可命中；
 * 已取到增量（sessionDelivered）时直接跳过。
 *
 * 等待期间**不阻塞任务流**：先 resume 恢复生成/执行，让 60 秒不浪费（任务继续跑）；
 * 到点后重新 `acquirePageOwnership()`（此时可能已在跑别的任务：触发式等完成 / 持续式提前中止 /
 * 登录登出让出本次机会），取得独占权后再刷新，避免刷新动作与任务流并发冲突。
 */
async function retryRefreshAfterMinute(page: Page): Promise<void> {
  if (sessionDelivered) {
    return; // 本次蹲饼已取到新动态
  }
  // 等待期间先恢复任务流（runFetchSession finally 还会 resume，幂等无副作用）
  fetchCoordinator.resume();
  logDyn('⏳ 仍未出现（收录延迟）：先恢复任务流，60 秒后重试｜基线未推进，该动态不会丢失');
  // 可中断等待：期间得新动态 → 提前结束；蹲饼被关闭 / 登录登出接管浏览器 → 立即放弃二次刷新
  const waitDeadline = Date.now() + 60_000;
  while (Date.now() < waitDeadline && !sessionDelivered && !shouldAbortFetch()) {
    await sleep(500);
  }
  if (sessionDelivered) {
    logDyn('✅ 等待期间已取到新动态（任务流继续），取消二次刷新');
    return;
  }
  if (shouldAbortFetch()) {
    logDyn('⏭️ 蹲饼已关闭 / 登录登出接管浏览器，取消二次刷新');
    return;
  }
  // 到点：重新阻塞任务流，并重新取得页面独占权（此时可能已有新任务在跑）
  fetchCoordinator.pause();
  const task = fetchCoordinator.currentTaskName;
  if (!(await acquirePageOwnership(task))) {
    logDyn(`⏭️ 当前任务（${task}）独占浏览器，取消二次刷新`);
    return;
  }
  refreshedThisFetch = true;
  // 开新时间窗：二次刷新后的 feed/all 若仍未取到，会走「刷新后未发现」提示
  justClickedUntil = Date.now() + 5000;
  logDyn('🔄 等待 60 秒后再次刷新动态页（二次尝试获取 update 增量）');
  await withTimeout(page.reload({ waitUntil: 'domcontentloaded' }), 30_000).catch(() => {});
  await sleep(1500); // 等刷新后的 feed/all 响应处理（取到则 deliver，未取到提示「刷新后未发现」）
  if (sessionDelivered) {
    logDyn('✅ 二次刷新取到增量（确认为后端收录延迟，最终未丢失）');
  }
  // 二次刷新仍未取到 → 第三层兜底：关闭动态页重新打开（排除页面状态异常；新页 feed/all 再拉一次）
  if (!sessionDelivered) {
    await reopenDynamicPage(page);
  }
}

/**
 * 第三层兜底：二次刷新后仍未取到新动态 → 关闭动态页重新打开。
 * 用于排除「动态页页面状态异常」类问题（页面 JS 卡死 / feed 流断掉 / 点击刷新未真正生效）：
 * 关闭旧动态页 → 新开一个动态页标签并重新挂接口监听 → 新页初始 feed/all 中
 * 没见过的动态照常投递，尝试重新拉取 update 提示的增量。
 * 新页作为后续动态页常驻（监听器随新页生效，后续 update 由新页触发 runFetchSession）。
 */
async function reopenDynamicPage(page: Page): Promise<void> {
  const browser = page.browser();
  logDyn('🔁 二次刷新仍未取到，关闭动态页重新打开（重置页面状态）…');
  await page.close().catch(() => {});
  try {
    const newPage = await browser.newPage();
    attachDynamicFeedListener(newPage); // 立即挂监听，新页初始 feed/all 即可按「没见过的=新增」投递
    await withTimeout(newPage.goto('https://t.bilibili.com/', { waitUntil: 'domcontentloaded' }), 30_000).catch(() => {});
    if (!isDynamicPageUrl(newPage.url())) {
      await newPage.close().catch(() => {});
      warnDyn('⚠️ 重开动态页失败（未进入动态页），本次兜底无效');
      return;
    }
    // 等新页初始 feed/all 响应处理（取到增量 / 触发强制补全则提前结束；最长 20s）
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !sessionDelivered && syncState !== 'catching-up') {
      await sleep(500);
    }
    // 新页初始 feed/all 未翻过基线时会触发强制滚动补全 → 等它结束（补全占用页面）
    await waitOngoingCatchUp();
    if (sessionDelivered) {
      logDyn('✅ 重开动态页后获取到新动态');
    } else {
      warnDyn('⚠️ 三层兜底后仍未取到新动态（收录延迟较长 / 接口异常，等下次 update 再试）｜基线未推进，之后仍会被取到');
    }
  } catch (err) {
    warnDyn(`⚠️ 重开动态页异常: ${(err as Error).message}`);
  }
}

/**
 * 被动蹲饼获取流程：update 提示有更新时，**先取得页面独占权，再操作页面**。
 *
 * 统一策略（按任务类别分派，不再有单任务专项分支）：
 * 1. 暂停任务流（生成器不再生成新任务）；
 * 2. 等上一次滚动补全结束（`syncState` 是模块级共享状态）；
 * 3. `acquirePageOwnership()`：
 *    - 触发式任务（短、高度自闭）→ **等它顺利完成**；
 *    - 持续式任务（长、过程不稳定）→ **提前中止**并等它收尾；
 *    - 登录/登出（`EXCLUSIVE_TASKS`）→ 让出，**本次蹲饼放弃**（等下次 update）；
 * 4. 快照模拟状态 → 切动态页前台 → 点击「有新动态」→ 等响应投递（必要时强制滚动补全到基线）→ 刷新兜底 →（60s 后）二次刷新；
 * 5. 恢复模拟状态（主操作页 / 前台 / 滚动位置）→ 恢复任务流。
 */
async function runFetchSession(page: Page, updateNum: number): Promise<void> {
  if (!fetchEnabled) {
    return; // 蹲饼已关闭：不再触发点击获取
  }
  if (sessionActive) {
    return; // 上一次蹲饼获取进行中，忽略
  }
  sessionActive = true;
  sessionDelivered = false; // 本次蹲饼尚未取到新动态
  const task = fetchCoordinator.currentTaskName;
  logDyn(`🎯 被动蹲饼触发（当前任务: ${task || '无'}，update ${updateNum} 条）`);
  // 入口即暂停任务流：生成器 next 检查 paused，不再生成新任务
  fetchCoordinator.pause();

  try {
    // 上一次滚动补全若还在进行，先等它结束（补全使用模块级共享状态且占用页面）
    await waitOngoingCatchUp();

    // 取得页面独占权（触发式等完成 / 持续式提前中止 / 登录登出让出本次机会）
    if (!(await acquirePageOwnership(task))) {
      logDyn(`⏭️ 当前任务（${task}）独占浏览器，本次蹲饼放弃（等下次 update）`);
      return;
    }
    if (shouldAbortFetch()) {
      logDyn('⏭️ 蹲饼已关闭 / 登录登出接管浏览器，本次蹲饼放弃');
      return;
    }

    // 独占页面后的完整获取流程；前后快照/恢复模拟状态（蹲饼会切前台/刷新/必要时关页重开）
    await withSimulationStateRestore(async () => {
      // 切动态页前台（后台不能可靠点击/滚动）
      const prevFront = await bringToFrontIfHidden(page).catch(() => null);
      try {
        await clickNotifyButton(page);
        // 等点击触发的 feed/all 响应处理；若本批未翻过基线（新增超过一页）则等强制补全结束
        await waitCatchUpDone(Date.now());
        if (shouldAbortFetch()) {
          return; // 登录登出已接管浏览器 → 不再继续操作页面
        }
        // 点击后未取到增量 → 刷新动态页兜底
        await retryByRefresh(page);
        await sleep(1500); // 等刷新后的 feed/all 响应处理（取到则 deliver，未取到提示「刷新后未发现」）
        if (shouldAbortFetch()) {
          return;
        }
        // 刷新后仍未取到 → 等 1 分钟再次刷新（任务流短暂恢复，到点重新取得独占权）
        await retryRefreshAfterMinute(page);
      } finally {
        // 未注册模拟状态快照器时的兜底：至少把原前台页还回去（登录登出接管时不动）
        if (prevFront && !exclusiveTaskRunning()) {
          void prevFront.bringToFront().catch(() => {});
        }
      }
    });
  } finally {
    // 本会话可能触发了滚动补全（如重开动态页后触发）→ 等它让出页面再恢复任务流
    await waitOngoingCatchUp();
    fetchCoordinator.resume(); // 恢复任务流（生成器可继续生成下一个任务）
    sessionActive = false;
    sessionDelivered = false; // 本次获取流程结束，重置「已取到」标记
    refreshedThisFetch = false; // 本次获取流程结束，重置刷新标记
  }
}

/** 给动态页挂上动态流接口响应监听（幂等：同一页面只挂一次） */
export function attachDynamicFeedListener(page: Page): void {
  if (attached.has(page)) {
    return;
  }
  attached.add(page);
  page.on('response', (response) => {
    if (!fetchEnabled) {
      return; // 蹲饼已关闭：监听保留但不解析/不投递/不触发（重开后沿用同一增量基线）
    }
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
          void runFetchSession(page, updateNum).catch((err: unknown) => {
            warnDyn(`⚠️ 蹲饼会话异常（已隔离，不影响宿主进程）: ${(err as Error)?.message ?? err}`);
          });
          return;
        }
        // update 接口直接带 items（兼容情况）→ 与初始/轮询一致投递
        if (dynamics.length === 0) {
          return;
        }
        // 记录本批信息：全局最新时间戳（补全失败时重置基线用）+ 最旧动态（到底判定用）
        trackBatch(dynamics);

        // ===== 增量投递：只投递「基线之后（pubTs > 基线）+ 没见过」的动态 =====
        const fresh = dynamics.filter((d) => {
          const id = dynId(d);
          const ts = dynPubTs(d);
          return ts > 0 && ts > baselinePubTs && (!id || !seenIds.has(id));
        });
        if (fresh.length > 0) {
          remember(fresh);
          // kind 由「本次 startFetch 是否已投递过」决定 —— **不能**用「响应来自 /update 接口」判断：
          // 本设计里 update 响应只带 update_num、从不带数据（带 items 时会在上面 return），
          // 真实增量全部来自「点击按钮 / 刷新 / 重开页」触发的 feed/all；
          // 按接口判断会把每一次增量误标成 'INIT'（实测 run-12 19:20:14、run-14 20:11:31）。
          deliverDynamics(fresh, deliveredSinceStart ? 'UPDATE' : 'INIT');
          deliveredSinceStart = true;
          lastClickMissed = false; // 本批取到增量，清除点击漏抓标记（防一次点击多次响应误刷新）
        } else if (Date.now() < justClickedUntil) {
          // 本批没取到新动态：仅对「刚点过按钮」的时间窗做诊断（避免一次点击多次响应时误报）。
          // ⚠️ 这通常**不是故障**：更新提示的动态刚发布（数秒前），B 站后端还没把它排进 feed
          //    （收录/排序延迟）→ 前台点击/刷新都看不到。但此时**基线不推进**，该动态之后仍满足
          //    「pubTs > 基线」，后续重试必能取到，不会丢失。
          if (refreshedThisFetch) {
            logDyn('ℹ️ 刷新后仍未出现（更新提示的动态可能刚发布，后端尚未排入 feed）');
          } else {
            lastClickMissed = true;
            logDyn('ℹ️ 点击后本次响应尚未出现该动态（多为刚发布的收录延迟）');
          }
        }

        // ===== 边界判定：本批是否已翻过基线（出现「不晚于基线」的动态 → 基线之后的都已拿到）=====
        const crossed = dynamics.some((d) => {
          const ts = dynPubTs(d);
          return ts > 0 && ts <= baselinePubTs;
        });
        if (crossed) {
          if (newestFetchedPubTs > baselinePubTs) {
            baselinePubTs = newestFetchedPubTs; // 推进基线：避免每轮都重新判边界/重复补全
            logDyn(`✅ 已覆盖基线（基线推进至 ${formatAbsTime(baselinePubTs)}）`);
          }
          syncState = 'idle'; // 若正在滚动补全 → 目标已达成，到此结束
          catchUpFailed = false;
          return;
        }
        // 本批全在基线之后 → 中间还有没加载到的（新增超过一页）→ 强制滚动补全到基线
        if (syncState !== 'catching-up') {
          logDyn('🔁 本批未翻过基线（中间还有未加载的动态）→ 强制滚动补全到基线…');
          syncState = 'catching-up';
          void startCatchUpScroll(page).catch((err: unknown) => {
            syncState = 'idle'; // 异常也要保证状态能收尾，否则后续会话会被卡住
            catchUpRunning = false;
            warnDyn(`⚠️ 滚动补全异常（已隔离，不影响宿主进程）: ${(err as Error)?.message ?? err}`);
          });
        }
      } catch {
        /* JSON 解析失败忽略 */
      }
    })();
  });
}

/** 初始增量获取结果：ready=已覆盖基线；catchup-failed=滚动到底仍未到达基线；timeout=首屏响应超时 */
export type InitialFetchOutcome = 'ready' | 'catchup-failed' | 'timeout';

/**
 * 等待动态页首次 feed/all 响应到达，并等「初始增量获取」结束（供启动流程调用）。
 *
 * 首屏若未翻过基线 → 监听器已启动强制滚动补全，这里等它结束（翻过基线 / 到底 / 超时），
 * 因此本函数耗时可能较长（由 `CATCHUP_MAX_MS` 兜底）。
 */
export async function waitForInitialFetch(page: Page, timeoutMs = 25_000): Promise<InitialFetchOutcome> {
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
    return 'timeout';
  }
  await sleep(600); // 给监听器：登记本批 + 必要时启动滚动补全
  // 首屏未翻过基线 → 等强制补全结束（可能会拉很久）
  const settled = await waitOngoingCatchUp();
  if (!settled) {
    return 'timeout';
  }
  return catchUpFailed ? 'catchup-failed' : 'ready';
}

/**
 * 确保浏览器内**只有一张**动态页（被动蹲饼目标页），并把监听挂到它上面：
 * - 当前活动页已是动态页 → 用它；其余多余动态页关闭；
 * - 否则复用一个已有动态页；其余多余动态页关闭；
 * - 都没有 → 新开一个动态页标签并挂监听（不改变 context.page）。
 *
 * 「只保留一张」是硬约束：多张动态页会各自解析 feed/all、各自发起一次点击获取流程
 * （去重集合能挡住重复投递，但白花一次点击/刷新流程），并且都作为常驻标签占内存。
 *
 * 返回动态页；打开失败返回 null。
 */
export async function ensureDynamicPage(context: TaskContext): Promise<Page | null> {
  const browser = context.browser;
  if (!browser) {
    return null;
  }
  const openPages = (await browser.pages().catch(() => [] as Page[])).filter((p) => !p.isClosed());
  const dynamicPages = openPages.filter((p) => isDynamicPageUrl(p.url()));

  // 首选「当前活动页」（若它本身就是动态页）——保证模拟的当前页不被收敛掉；否则用找到的第一张
  const primary =
    (context.page && !context.page.isClosed() && isDynamicPageUrl(context.page.url()) ? context.page : null) ??
    dynamicPages[0] ??
    null;

  if (primary) {
    // 收敛：关闭多余的动态页（否则多页会各自触发一次点击获取流程）
    for (const extra of dynamicPages) {
      if (extra !== primary) {
        await extra.close().catch(() => {});
      }
    }
    attachDynamicFeedListener(primary);
    return primary;
  }

  // 无动态页 → 新开一个动态页标签（后台常驻；context.page 保持不变）
  try {
    const page = await browser.newPage();
    // 动态页长久驻留且后续大量 evaluate → 先注入运行时 shim（防 __name 未定义）
    await installPageRuntimeShim(page);
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
