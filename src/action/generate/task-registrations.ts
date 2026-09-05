import { registerTask, type GenerationContext } from './task-registry';
import { MainState } from '../engine/state';
import { BrowseHomeTask } from '../task/browse-home';
import { BrowseDynamicTask } from '../task/browse-dynamic';
import { BrowseProfileTask } from '../task/browse-profile';
import { SearchTask } from '../task/search';
import { DirectSearchDecider } from '../task/search-decider';
import { OpenVideoTask } from '../task/open-video';
import type { VideoEntry, ProfileEntry } from '../../utils/bilibili-dom';
import { WatchVideoTask } from '../task/watch-video';
import { LikeTask } from '../task/like';
import { TripleTask } from '../task/triple';
import { CommentTask } from '../task/comment';
import { FollowTask } from '../task/follow';
import { CloseVideoTask } from '../task/close-video';
import { RestTask } from '../task/rest';
import { LoginTask } from '../task/login';
import { LogoutTask } from '../task/logout';
import { restProbability, onlineMinutesAt } from '../../sim/rest-decision';
import { inSleep, willingnessAt, hourOf } from '../../persona/circadian';

/** 从 persona 兴趣里抽一个搜索词 */
function pickKeyword(ctx: GenerationContext): string {
  const kws = ctx.persona.interests?.keywords ?? [];
  return kws.length > 0 ? kws[Math.floor(Math.random() * kws.length)] : '原神';
}

/** R4 范围采样 */
function sampleRange(r: [number, number]): number {
  return r[0] + Math.random() * (r[1] - r[0]);
}

/** R6 疲劳调制：越累互动概率越低 */
const fatigueScale = (ctx: GenerationContext): number => 0.3 + 0.7 * ctx.fatigue;

/** PersonaBehaviorConfig 中 number 类型的键（like/coin/comment 等互动概率；排除 [number,number] 等） */
type NumberKeys<T> = { [K in keyof T]: T[K] extends number ? K : never }[keyof T];

/** persona 行为概率字段（仅 number 型互动概率） */
const behaviorProb =
  (key: NumberKeys<NonNullable<GenerationContext['persona']['behavior']>>) =>
  (ctx: GenerationContext): number =>
    (ctx.persona.behavior?.[key] as number | undefined) ?? 0;

/** 是否在目标状态（当前状态 ∈ 允许状态） */
const inState = (ctx: GenerationContext, ...states: MainState[]): number => (states.includes(ctx.currentState) ? 1 : 0);

/**
 * BrowseProfile 目标抉择 + 概率（同 OpenVideo：先统计入口 → 抉择目标 → 算概率）：
 * - 目标：所有用户入口等概率竞争（随机选一个）；
 * - 概率：无目标 → 0；有目标按状态基础（USER_PROFILE 主导、SEARCH 次之、其它低概率）。
 */
function decideBrowseProfile(ctx: GenerationContext): { target: ProfileEntry | null; probability: number } {
  const entries = ctx.pageFeatures?.profileEntries ?? [];
  // 目标抉择：所有用户入口等概率竞争（随机选一个）
  const target = entries.length > 0 ? entries[Math.floor(Math.random() * entries.length)] : null;
  if (!target) {
    return { target: null, probability: 0 };
  }

  // 状态相关基础概率（有目标入口才可能生成）
  let base: number;
  if (ctx.currentState === MainState.USER_PROFILE) base = 0.9;
  else if (ctx.currentState === MainState.SEARCH_RESULT) base = 0.6;
  else if (ctx.currentState === MainState.DYNAMIC_FEED) base = 0.1;
  else if (ctx.currentState === MainState.HOME_FEED) base = 0.05;
  else base = 0;
  return { target, probability: base };
}

/**
 * 注册全部任务。
 * 每个任务概率函数的思路：
 * - 流程性任务（OpenVideo→WatchVideo、needSearch→Search、离开视频→CloseVideo）条件满足时概率=1（必然）；
 * - 普通任务按当前状态 + persona 参数给基础概率，再乘各种调制。
 */
export function registerAllTasks(): void {
  // ===== 登录（运行时 login 指令 / 登录失效重登时强制）=====
  // 仅在 ctx.forceLogin 时为必然（概率=1），否则不参与正常任务流（概率=0）。
  // userDataDir/headless 由 LoginTask.execute 从 context.state 读取（bilibili-user-simulation 注入）。
  registerTask({
    name: 'Login',
    probability: (ctx) => (ctx.forceLogin ? 1 : 0),
    create: () => new LoginTask(),
  });

  // ===== 退出登录（运行时 logout 指令触发）=====
  // 仅在 ctx.forceLogout 时为必然（概率=1），否则不参与正常任务流（概率=0）。
  registerTask({
    name: 'Logout',
    probability: (ctx) => (ctx.forceLogout ? 1 : 0),
    create: () => new LogoutTask(),
  });

  // ===== 浏览类 =====
  // 非必然任务：概率 <1（占主导但不等于 1）
  registerTask({
    name: 'BrowseHome',
    probability: (ctx) => inState(ctx, MainState.HOME_FEED, MainState.LOGGED_IN) * 0.9,
    create: (ctx) => new BrowseHomeTask({ browseDepth: Math.ceil(sampleRange([1, 3])) }),
  });

  registerTask({
    name: 'BrowseDynamic',
    probability: (ctx) => {
      // 统一入口 gate：当前页面必须有动态入口，才有概率进动态页（无论状态）
      if (!ctx.pageFeatures?.hasDynamicEntry) {
        return 0;
      }
      // 有动态入口时的真人概率：已在动态页浏览主导；其它页偶尔进动态
      return ctx.currentState === MainState.DYNAMIC_FEED ? 0.9 : 0.15;
    },
    create: (ctx) => new BrowseDynamicTask({ browseDepth: 1 }),
  });

  /** BrowseProfile 目标抉择状态：probability 阶段抉择目标，create 阶段消费后清空 */
  const browseProfileDecision: { target: ProfileEntry | null } = { target: null };

  registerTask({
    name: 'BrowseProfile',
    probability: (ctx) => {
      const d = decideBrowseProfile(ctx);
      browseProfileDecision.target = d.target;
      return d.probability;
    },
    create: () => {
      const target = browseProfileDecision.target;
      browseProfileDecision.target = null;
      if (!target) {
        // 概率=0 理论上不会被选；兜底避免 create 返回异常
        return new BrowseProfileTask({ upName: '明日方舟', browseDepth: 1 });
      }
      return new BrowseProfileTask({ upName: target.name, uid: target.uid, browseDepth: 1 });
    },
  });

  // ===== 搜索类 =====
  // 流程性：BrowseProfile 返回 needSearch → Search 必然（概率=1）；否则仅 SEARCH_RESULT 态可选
  registerTask({
    name: 'Search',
    probability: (ctx) => {
      // 必然：逛 UP 主页找不到入口 → 搜索跟进
      if (ctx.lastTaskName === 'BrowseProfile' && ctx.needSearch === true) {
        return 1;
      }
      // 统一入口 gate：当前页面必须有搜索框，才有概率搜索（无论状态）
      if (!ctx.pageFeatures?.hasSearchBox) {
        return 0;
      }
      // 有搜索框时的真人概率：
      // - 搜索结果页可再搜（较高）；
      // - 视频页内极低（真人很少在视频页内搜索，更倾向看完/切走，搜索一般从非视频页发起）；
      // - 其它页偶尔搜（低）
      if (ctx.currentState === MainState.SEARCH_RESULT) {
        return 0.4;
      }
      if (ctx.pageFeatures?.isVideoPage) {
        return 0.01;
      }
      return 0.1;
    },
    create: (ctx) => {
      return new SearchTask({ keyword: pickKeyword(ctx), decider: new DirectSearchDecider() });
    },
  });

  // ===== 内容消费类 =====
  // OpenVideo 概率计算器：基于生成器状态（尤其 recommendations）抉择目标视频并算概率。
  // 推荐列表内每个视频先算各自吸引力，互相争夺「实际打开」资格（加权抉择出一个目标）；
  // 抉择后的总概率（至少点一个推荐）再与 WatchVideo / CloseVideo 的外部概率公平比较。
  function decideOpenVideo(ctx: GenerationContext): { target: VideoEntry | null; probability: number } {
    // 重试流程：已关闭错误页 → 重新打开视频（必然）
    if (ctx.retryWatchVideo && ctx.lastTaskName === 'CloseVideo' && ctx.lastSuccess) {
      return { target: null, probability: 1 };
    }
    // 统一入口 gate：当前页面必须有视频入口（视频卡片/右侧推荐流），无论状态才有概率打开视频
    if (!ctx.pageFeatures?.hasVideoEntry) {
      return { target: null, probability: 0 };
    }
    const recs = ctx.recommendations ?? [];
    const binge = ctx.persona.behavior?.binge_watch_tendency ?? 0.5;
    // 视频页连刷（必须在视频页且有右侧推荐流）：推荐列表内各视频抉择目标。
    // isVideoPage 防止「视频标签在后台、当前活动页非视频页」时用旧推荐流连刷（会 preCheck 失败空转）
    if (recs.length > 0 && ctx.pageFeatures?.isVideoPage) {
      // 每个推荐视频的吸引力（0~1）：随机为主（真人不会按固定顺序点），可扩展时长/热度/兴趣匹配
      const scores = recs.map(() => 0.3 + Math.random() * 0.5); // 0.3~0.8
      // 总概率 = 1 - ∏(1 - s_i)：推荐越多、吸引力越高 → 越可能点开下一个
      const atLeastOne = 1 - scores.reduce((acc, s) => acc * (1 - s), 1);
      // 连刷概率与「上一任务观看完整度」绑定（打开后尽量真看，看完后才有连刷动机）：
      // - 上一个任务是 WatchVideo：看得越久（watchedRatio 高 = 沉浸看完）→ 连刷概率越高（满足感驱动）
      // - 刚打开视频（lastTask=OpenVideo，还没看）→ 连刷压到很低（先看，看完再考虑连刷）
      let bingeBase = 0.3 + 0.5 * binge;
      if (typeof ctx.watchedRatio === 'number') {
        bingeBase *= 0.1 + 0.9 * ctx.watchedRatio; // 看完→×1.0，秒退→×0.1
      } else if (ctx.lastTaskName === 'OpenVideo' && ctx.lastSuccess) {
        bingeBase = 0.05;
      }
      const probability = Math.min(0.55, atLeastOne * bingeBase);
      // 按吸引力加权抉择「实际打开」的目标视频（互相抢夺资格，只有一个被真正打开）
      const total = scores.reduce((a, b) => a + b, 0);
      let r = Math.random() * total;
      let target = recs[recs.length - 1];
      for (let i = 0; i < recs.length; i++) {
        r -= scores[i];
        if (r <= 0) {
          target = recs[i];
          break;
        }
      }
      return { target, probability };
    }
    // 首次打开（当前页有视频入口，如主页/搜索/动态）：真人以浏览为主，打开视频是内容消费选项（低-中概率）
    return { target: null, probability: Math.min(0.5, 0.15 + 0.35 * binge) };
  }

  /** OpenVideo 抉择状态：probability 阶段写入目标视频，create 阶段消费后清空 */
  const openVideoDecision: { target: VideoEntry | null } = { target: null };

  registerTask({
    name: 'OpenVideo',
    probability: (ctx) => {
      const d = decideOpenVideo(ctx);
      openVideoDecision.target = d.target;
      return d.probability;
    },
    create: () => {
      // 消费 probability 阶段抉择出的目标视频（来自推荐流；null = 任务内从当前页收集抉择）
      const target = openVideoDecision.target;
      openVideoDecision.target = null;
      return new OpenVideoTask({ target: target ?? undefined });
    },
  });

  // OpenVideo 成功后 → 观看当前视频（尽量真看：0.85 主导；「看完后连刷」由 OpenVideo 连刷概率随观看完整度承接）
  registerTask({
    name: 'WatchVideo',
    probability: (ctx) => (ctx.lastTaskName === 'OpenVideo' && ctx.lastSuccess ? 0.85 : 0),
    create: (ctx) => {
      // 生成器决定「初步计划观看时长」：真看视频的一定比例（短视频看大部分），但不超过 20 分钟（防长视频失控）。
      // WatchVideo 进入后会按播放器「剩余播放时间」再修正（计划 > 剩余 → 修正为剩余播放时间）。
      const videoDurSec = ctx.videoDuration ?? 0;
      const ratioUpper = ctx.persona.behavior?.video_watch_ratio?.[1] ?? 0.9;
      const plannedMs = videoDurSec > 0 ? videoDurSec * ratioUpper * 1000 : 3 * 60 * 1000;
      const durationMs = Math.min(20 * 60 * 1000, Math.max(60_000, plannedMs));
      const fullscreen = Math.random() < 0.3;
      return new WatchVideoTask({
        videoDuration: ctx.videoDuration ?? 0,
        durationMs,
        fullscreen,
        earlyExitProb: ctx.persona.behavior?.early_exit_prob,
      });
    },
  });

  // 互动类（内容消费状态下按人格概率穿插）
  // 前提：必须在目标视频页（当前活动页是视频页 isVideoPage）——与 CloseVideo 的目标页标准一致。
  // 不能用 hasVideoTab（只表示标签列表有视频页，视频可能在后台，当前页非视频页时仍会空转被选又 preCheck 跳过）。
  registerTask({
    name: 'Like',
    probability: (ctx) =>
      inState(ctx, MainState.CONTENT_CONSUMING) *
      (ctx.pageFeatures?.isVideoPage ? 1 : 0) *
      behaviorProb('like_prob')(ctx) *
      fatigueScale(ctx),
    create: () => new LikeTask(),
  });

  registerTask({
    name: 'Triple',
    probability: (ctx) =>
      inState(ctx, MainState.CONTENT_CONSUMING) *
      (ctx.pageFeatures?.isVideoPage ? 1 : 0) *
      behaviorProb('coin_prob')(ctx) *
      fatigueScale(ctx),
    create: () => new TripleTask(),
  });

  registerTask({
    name: 'Comment',
    probability: (ctx) =>
      inState(ctx, MainState.CONTENT_CONSUMING) *
      (ctx.pageFeatures?.isVideoPage ? 1 : 0) *
      behaviorProb('comment_prob')(ctx) *
      fatigueScale(ctx),
    create: () => new CommentTask(),
  });

  // ===== UP 主页互动 =====
  registerTask({
    name: 'Follow',
    // 前置条件：当前页存在「关注」按钮（UP 主页且未关注）。即使预测状态是 user_profile，
    // 实际页面无关注按钮也不选（避免被选中后 preCheck 失败跳过、浪费采样）
    // 概率权重用独立字段 follow_prob（不共用 like_prob）
    probability: (ctx) => (ctx.pageFeatures?.hasFollowButton ? behaviorProb('follow_prob')(ctx) * 0.5 : 0),
    create: () => new FollowTask(),
  });

  // ===== 关闭标签页（非必然：概率由「当前标签页集合 + 当前页类型」决定，符合真人）=====
  registerTask({
    name: 'CloseVideo',
    probability: (ctx) => {
      // 流程保障：OpenVideo 打开失败后的重试流程（先关错误页再重开）——错误恢复必须保障，保持必然
      if (ctx.retryWatchVideo) {
        return 1;
      }
      // 秒关流程：WatchVideo 秒关（快速关闭视频）→ 关掉当前视频标签页，避免视频残留继续播放——必然
      if (ctx.quickCloseVideo) {
        return 1;
      }
      const videoTabs = ctx.pageFeatures?.videoTabCount ?? 0;
      const tabCount = ctx.pageFeatures?.tabCount ?? 0;
      // 从视频页进入搜索页后的「关掉前一个视频页」偏置（一次性，未生成则逐轮衰减）：
      // 真人从视频页搜索跳走时（搜索 window.open 新标签，旧视频页残留），通常会把前一个视频页关掉
      // → CloseVideo 概率大幅升高。偏置越高越接近必然（上限 0.95，非必然）。
      const searchBias = ctx.searchCloseBias ?? 0;
      if (searchBias > 0 && videoTabs > 0) {
        return Math.min(0.95, 0.4 + searchBias * 0.6);
      }
      // 有视频页：真人不会每个视频都关（看完可能直接跳走留着），也不会从不清理 → 给非必然概率
      if (videoTabs > 0) {
        // 离开视频消费（看完/不再看）：较高概率清理（真人看完通常想关掉）
        if (ctx.leavingVideoState) {
          return Math.min(0.85, 0.7 + videoTabs * 0.05);
        }
        // 视频消费中：小概率随手关（视频越多越可能想清理）
        if (ctx.currentState === MainState.CONTENT_CONSUMING) {
          return Math.min(0.6, 0.2 + videoTabs * 0.06);
        }
        // 其它状态有视频页残留：偶尔清理
        return Math.min(0.4, 0.15 + videoTabs * 0.05);
      }
      // 无视频页但标签过多：偶尔关掉多余标签（真人不会无限堆标签）
      if (tabCount > 3) {
        return 0.12;
      }
      return 0;
    },
    create: () => new CloseVideoTask(),
  });

  // ===== 休息 =====
  // 休息决策（统一公式 rest-decision）：意愿 + 已上线时长 + 刚完成任务类型。
  // 触发概率已随作息意愿调控：高峰意愿高 → 休息概率低（想继续刷）；低谷/睡眠 → 休息概率高。
  registerTask({
    name: 'Rest',
    probability: (ctx) => {
      if (!ctx.onlineStartAt || !ctx.now) {
        return 0;
      }
      // 当前时刻意愿（从 circadian 双峰曲线推算）
      const hour = hourOf(ctx.now());
      const will = ctx.persona.circadian ? willingnessAt(hour, ctx.persona.circadian) : 0.5;
      const elapsedMs = ctx.now() - ctx.onlineStartAt;
      const expectedMs =
        (ctx.persona.circadian?.online_minutes ? onlineMinutesAt(will, ctx.persona.circadian.online_minutes) : 45) * 60_000;
      return restProbability(will, elapsedMs, expectedMs, ctx.lastTaskName);
    },
    create: (ctx) => {
      // 休息形态（长休息概率 + 时长）随作息时间调控，而非固定概率：
      // - 睡眠段（sleep_time 内）：一旦休息即必然长休息（下线睡觉），时长较长（60~180min，睡到自然醒）
      // - 非睡眠段：长休息概率随意愿降低而升高（高峰意愿高 → 几乎不关浏览器，继续刷；低谷 → 更可能离开）
      // - 短休息时长随意愿：意愿越高休息越短（快节奏），越低越久
      const nowMs = ctx.now ? ctx.now() : Date.now();
      const hour = hourOf(nowMs);
      const circ = ctx.persona.circadian;
      const will = circ ? willingnessAt(hour, circ) : 0.5;
      const sleeping = circ ? inSleep(hour, circ) : false;
      const longRestProb = sleeping ? 1 : 0.4 * (1 - will); // 非睡眠：意愿 0→0.4，意愿 1→0
      const longRest = Math.random() < longRestProb;
      const restMs = longRest
        ? sleeping
          ? (60 + Math.random() * 120) * 60_000 // 睡眠段长休息：60~180min 下线睡觉
          : (30 + Math.random() * 100 * (1 - will)) * 60_000 // 非睡眠长休息：30~130min，意愿越低越久
        : (1 + Math.random() * 7 * (1 - will * 0.5)) * 60_000; // 短休息：1~8min，意愿越高越短
      return new RestTask({ durationMs: restMs, closeBrowserAfterMs: 10 * 60_000 });
    },
  });
}
