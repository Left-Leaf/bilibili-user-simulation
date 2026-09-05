import type { TaskGenerator } from './generator';
import type { Task } from '../task/base';
import type { TaskContext } from '../execute/context';
import { OpenVideoTask } from '../task/open-video';
import { RestTask } from '../task/rest';
import { MainState, MAIN_STATES } from '../engine/state';
import { buildTransitionMatrix, sampleInitialState, sampleNextState } from '../../persona/transition';
import { hourOf, willingnessAt } from '../../persona/circadian';
import type { PersonaConfig } from '../../persona/types';
import type { VideoEntry, ProfileEntry } from '../../utils/bilibili-dom';
import { collectVideoEntries, collectProfileEntries, findDynamicEntryHandle, isVideoPageUrl } from '../../utils/bilibili-dom';
import { sampleTaskByProbability, type GenerationContext, type PageFeatures, type PageFeatureDetector } from './task-registry';
import { registerAllTasks } from './task-registrations';
import { fetchCoordinator } from '../../business/fetch-coordinator';
import { onlineMinutesAt } from '../../sim/rest-decision';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 是否为视频消费相关任务：OpenVideo/WatchVideo/Like/Triple/Comment 的 preCheck 都强制当前页为
 * /video/BV，执行成功即说明确实在视频页。用于判定「离开视频态」与 CloseVideo 秒退——
 * 避免状态机从别的状态采样进入 CONTENT_CONSUMING（从未真打开视频）时误触发 CloseVideo。
 */
function isVideoTask(name: string | undefined): boolean {
  return name === 'OpenVideo' || name === 'WatchVideo' || name === 'Like' || name === 'Triple' || name === 'Comment';
}

/**
 * 涌现式人格生成器：目的不驱动，而是由 persona 的 state_transition_bias 调制转移矩阵，
 * 在马尔科夫游走中自发涌现出状态序列；任务选择由「任务注册表」按概率加权采样。
 *
 * 流程：初始状态（persona.initial_state_dist）→ 矩阵采样下一状态 →
 *       构造生成上下文（含上一任务/上线时长等）→ 注册表按概率选任务。
 * 上线任务流结束条件：达到 BROWSER_CLOSED（下线），或达到 maxTasks / 上线时长上限。
 */
export interface PersonaDrivenGeneratorOptions {
  /** 最大任务数（防死循环） */
  maxTasks?: number;
  /** 上线时长上限（毫秒，默认 30 分钟） */
  sessionDurationMs?: number;
  /** 时钟源（默认 Date.now，可注入模拟时钟做时间加速测试） */
  now?: () => number;
  /** WatchVideo 前置检查失败后的最大重试次数（默认 3） */
  watchVideoRetryMax?: number;
  /** 页面能力检测器（默认真实 DOM 检测；测试可注入模拟，如假 page 场景） */
  pageFeatureDetector?: PageFeatureDetector;
}

/** 简单时钟接口（真实/模拟通用） */
export interface Clock {
  now(): number;
}

/**
 * 外部运行时控制（登录失效 / 强制登录 / 热重启）：由正式运行入口注入共享对象。
 * - stopped：停止生成（登录失效，等用户 login）
 * - forceLogin：下一个任务强制为登录任务（Login 概率=1），生成后由生成器清除
 * - forceLogout：下一个任务强制为退出登录任务（Logout 概率=1），生成后由生成器清除
 * - reloadRequested：热重启（重载人格配置），生成器返回 null 结束当前上线任务流，由入口重载后重新上线
 */
export interface GeneratorControl {
  stopped: boolean;
  forceLogin: boolean;
  forceLogout?: boolean;
  reloadRequested?: boolean;
  /** 强制上线：强制结束当前休息（RestTask）/下线休息倒计时，立即开始上线 */
  forceOnline?: boolean;
}

export class PersonaDrivenGenerator implements TaskGenerator {
  private matrix: number[][];
  private currentState: MainState;
  private startedAt: number;
  private taskCount = 0;
  private options: Required<PersonaDrivenGeneratorOptions>;
  private nowFn: () => number;
  /** WatchVideo 前置检查失败的连续重试计数 */
  private watchVideoRetryCount = 0;
  /** OpenVideo 前置失败后的重试流程标志（CloseVideo → OpenVideo 都走注册表必然） */
  private retryWatchVideo = false;
  /** 本次上线（在线段）的开始时间戳：休息决策用（上线越久越易休息） */
  private onlineStartAt: number;
  /** 当前视频页右侧推荐流（OpenVideo 返回；离开视频页清空，供「打开推荐视频」连刷决策） */
  private recommendations: VideoEntry[] = [];
  /**
   * 从视频页进入搜索页的「关闭前一个视频页」偏置（0~1）：
   * Search 成功（进入搜索页）且残留视频页标签时置高（~0.9），参与 CloseVideo 概率计算
   * 大幅升高其概率；一次性——选中 CloseVideo 则清零，否则逐轮 ×0.5 衰减。
   */
  private searchCloseBias = 0;
  /** 外部运行时控制（登录失效停止 / 强制登录），由正式运行入口注入 */
  private control?: GeneratorControl;
  /** 生成器暂停状态：启动时为 true（未登录不生成任务），登录成功后由入口 setPaused(false) 开始生成 */
  private paused = true;

  /** 设置生成器暂停/恢复（登录成功后恢复，开始生成任务） */
  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  constructor(
    private persona: PersonaConfig,
    options: PersonaDrivenGeneratorOptions = {}
  ) {
    this.matrix = buildTransitionMatrix(persona);
    this.currentState = sampleInitialState(persona);
    this.nowFn = options.now ?? Date.now;
    this.startedAt = this.nowFn();
    this.onlineStartAt = this.startedAt;
    this.options = {
      maxTasks: options.maxTasks ?? 50,
      sessionDurationMs: options.sessionDurationMs ?? 30 * 60 * 1000,
      now: this.nowFn,
      watchVideoRetryMax: options.watchVideoRetryMax ?? 3,
      pageFeatureDetector: options.pageFeatureDetector ?? ((ctx) => this.detectPageFeatures(ctx)),
    };
    registerAllTasks();
  }

  reset(): void {
    this.currentState = sampleInitialState(this.persona);
    this.startedAt = this.nowFn();
    this.taskCount = 0;
    this.matrix = buildTransitionMatrix(this.persona);
    this.watchVideoRetryCount = 0;
    this.retryWatchVideo = false;
    this.onlineStartAt = this.startedAt;
    this.recommendations = [];
    this.searchCloseBias = 0;
  }

  /** 注入外部运行时控制（登录失效 / 强制登录） */
  setControl(control: GeneratorControl): void {
    this.control = control;
  }

  /** 返回生成器内部当前模拟时间（供外部推进后查询） */
  get startedTime(): number {
    return this.startedAt;
  }

  /** 返回生成器内部状态快照（status 指令打印当前状态用） */
  getStatusInfo(): {
    currentState: MainState;
    taskCount: number;
    startedAt: number;
    onlineStartAt: number;
    retryWatchVideo: boolean;
    watchVideoRetryCount: number;
    searchCloseBias: number;
    recommendationCount: number;
  } {
    return {
      currentState: this.currentState,
      taskCount: this.taskCount,
      startedAt: this.startedAt,
      onlineStartAt: this.onlineStartAt,
      retryWatchVideo: this.retryWatchVideo,
      watchVideoRetryCount: this.watchVideoRetryCount,
      searchCloseBias: this.searchCloseBias,
      recommendationCount: this.recommendations.length,
    };
  }

  /**
   * 是否接受本次「采样到 BROWSER_CLOSED」→ 真正下线（长休息关浏览器）。
   * 下线接受概率随**作息意愿 + 已上线时长**调控（替代固定概率，避免刚上线/高峰频繁下线）：
   * - 已上线占比 = 已上线时长 / 预期在线时长（online_minutes 意愿调制）：刚上线≈0 → 几乎不下线
   * - 意愿高（高峰，如 23 点 night_owl）→ (1-will)≈0 → 几乎不下线；意愿低（低谷/睡眠）→ 更可能下线
   * - 在线接近/超过预期在线时长 → 下线概率上升（该休息了）
   */
  private acceptOffline(): boolean {
    const hour = hourOf(this.nowFn());
    const circ = this.persona.circadian;
    const will = circ ? willingnessAt(hour, circ) : 0.5;
    const expectedMs = circ ? onlineMinutesAt(will, circ.online_minutes) * 60_000 : 45 * 60_000;
    const onlineRatio = Math.min(1, Math.max(0, (this.nowFn() - this.onlineStartAt) / expectedMs));
    const p = onlineRatio * (0.3 + 0.7 * (1 - will));
    return Math.random() < p;
  }

  /**
   * 检测当前页面能力特征（任务概率的统一入口 gate）。
   * 轻量 DOM 检测，不发起网络请求；失败一律 false（不影响决策）。
   */
  private async detectPageFeatures(context: TaskContext): Promise<PageFeatures> {
    const page = context.page;
    const browser = context.browser;
    let hasVideoEntry = false;
    let hasSearchBox = false;
    let hasDynamicEntry = false;
    let isVideoPage = false;
    let hasVideoTab = false;
    let videoTabCount = 0;
    let tabCount = 0;
    let profileEntries: ProfileEntry[] = [];
    let hasFollowButton = false;
    if (page) {
      // 当前活动页是否为视频页（普通视频或 bangumi 番剧/TV剧）——互动/连刷的目标页前提
      isVideoPage = isVideoPageUrl(page.url());
      // 视频入口：当前页有可见视频卡片/推荐流（按页面类型自动定位）
      hasVideoEntry = await collectVideoEntries(page, 1)
        .then((es) => es.length > 0)
        .catch(() => false);
      // 搜索框：顶部搜索栏多版本候选（取第一个**可见**的——搜索页 .nav-search-input 隐藏、.search-input-el 可见，
      // page.$ 会命中隐藏候选导致误判，故遍历取可见）
      hasSearchBox = await page
        .$$('.nav-search-input, .search-input-el, input[placeholder*="搜索"]')
        .then(async (handles) => {
          for (const h of handles) {
            const box = await h.boundingBox().catch(() => null);
            if (box && box.width > 0 && box.height > 0) {
              return true;
            }
          }
          return false;
        })
        .catch(() => false);
      // 动态入口：顶部导航「动态」
      hasDynamicEntry = !!(await findDynamicEntryHandle(page).catch(() => null));
      // UP 主页入口：统计当前页全部 space.bilibili.com 链接（BrowseProfile 抉择目标用）
      profileEntries = await collectProfileEntries(page).catch(() => []);
      // 关注按钮：UP 主页且未关注（Follow 前置条件，与 FollowTask 的 selector 一致）
      hasFollowButton = !!(await page.$('.follow-btn, .attention, .header-info-ctnr .follow-btn').catch(() => null));
    }
    // 标签页集合：视频页数量 + 总数量（关闭标签页概率的依据）
    if (browser) {
      const pages = await browser.pages().catch(() => [] as NonNullable<TaskContext['page']>[]);
      tabCount = pages.length;
      videoTabCount = pages.filter((p) => isVideoPageUrl(p.url())).length;
      hasVideoTab = videoTabCount > 0;
    }
    return {
      hasVideoEntry,
      hasSearchBox,
      hasDynamicEntry,
      isVideoPage,
      hasVideoTab,
      videoTabCount,
      tabCount,
      profileEntries,
      hasFollowButton,
    };
  }

  async hasNext(context: TaskContext): Promise<boolean> {
    if (this.currentState === MainState.BROWSER_CLOSED) {
      return false;
    }
    if (this.taskCount >= this.options.maxTasks) {
      return false;
    }
    const elapsed = this.nowFn() - this.startedAt;
    return elapsed < this.options.sessionDurationMs;
  }

  async next(context: TaskContext): Promise<Task | null> {
    // 外部控制：登录失效 → 停止生成（等用户 login 重登）；热重启 → 结束当前上线任务流（由入口重载重新上线）
    if (this.control?.stopped || this.control?.reloadRequested) {
      return null;
    }
    // 生成器暂停（登录前 paused / 被动蹲饼协调 fetchCoordinator.paused）→ 等待解除后再生成任务
    while (this.paused || fetchCoordinator.paused) {
      if (this.control?.stopped || this.control?.reloadRequested) {
        return null;
      }
      await sleep(200);
    }
    if (!(await this.hasNext(context))) {
      return null;
    }
    this.taskCount++;

    // 从 context.logs 提取上一任务结果（lastLog）
    const logs = context?.logs ?? [];
    const lastLog = logs[logs.length - 1];
    const lastMeta = lastLog?.metadata as Record<string, unknown> | undefined;
    const lastTaskName = lastLog?.taskName;
    const lastSuccess = lastLog?.success;

    // === 状态即时同步：计算下一个任务之前，先把生成器状态校准为执行器实际状态 ===
    // executor 执行任务后会更新 context.currentState 为任务返回的 nextState
    //（失败/跳过时不更新，保持上一个成功任务的状态）；生成器 this.currentState 是
    // 上一轮末尾设定的「目标状态」，可能与实际脱节（任务失败/跳过/实际返回不同状态时）。
    // 先同步为即时状态，保证后续采样与概率决策都基于最新实际状态。
    const actualState = context.currentState;
    if (MAIN_STATES.includes(actualState as MainState)) {
      this.currentState = actualState as MainState;
    }

    // Rest 完成后 → 视为新一次上线（重置上线开始时间）
    if (lastTaskName === 'Rest') {
      this.onlineStartAt = this.nowFn();
    }

    // OpenVideo 打开失败处理（区分两种失败，避免死循环）：
    // - preCheck 失败（当前页无视频入口）→ 不重试。页面根本没视频，重试必然再失败 → 之前因此死循环。
    // - execute 失败（点击后未进入视频页）→ 计数重试（CloseVideo 关错误页后重开），超阈值放弃。
    if (lastTaskName === 'OpenVideo' && lastMeta?.precheckFailed === true) {
      this.retryWatchVideo = false;
      this.watchVideoRetryCount = 0;
      this.recommendations = []; // 连刷目标已失效（当前不在视频页），清空避免反复尝试
      console.log('   ⚠️ OpenVideo preCheck 失败（当前页无视频入口），放弃本轮打开，不重试');
    } else if (lastTaskName === 'OpenVideo' && lastLog?.success === false) {
      if (this.watchVideoRetryCount < this.options.watchVideoRetryMax) {
        this.watchVideoRetryCount++;
        this.retryWatchVideo = true;
        console.log(`   🔄 OpenVideo 打开失败，关闭错误页重试（${this.watchVideoRetryCount}/${this.options.watchVideoRetryMax}）`);
      } else {
        console.log(`   ⚠️ OpenVideo 重试超阈值（${this.options.watchVideoRetryMax}），放弃观看`);
        this.watchVideoRetryCount = 0;
        this.retryWatchVideo = false;
      }
    }
    if (lastTaskName === 'OpenVideo' && lastLog?.success) {
      this.watchVideoRetryCount = 0;
      this.retryWatchVideo = false;
    }

    // 推荐流维护：OpenVideo 成功 → 更新为当前视频页右侧推荐流（供「打开推荐视频」连刷选目标）
    if (lastTaskName === 'OpenVideo' && lastLog?.success && Array.isArray(lastMeta?.recommendations)) {
      this.recommendations = lastMeta.recommendations as VideoEntry[];
    }

    // CloseVideo 执行后：视频页已关，清空推荐流（currentState 已由开头的统一同步校准到实际状态）
    if (lastTaskName === 'CloseVideo' && lastLog?.success) {
      this.recommendations = [];
    }

    // 上线内任务进度 + 疲劳（DESIGN 6.1.5：前 60% 正常，之后线性衰减到 50%）
    const elapsed = this.nowFn() - this.startedAt;
    const elapsedRatio = Math.min(1, elapsed / this.options.sessionDurationMs);
    const fatigue = elapsedRatio < 0.6 ? 1 : 1 - ((elapsedRatio - 0.6) / 0.4) * 0.5;

    // 采样下一主状态
    let nextState = sampleNextState(this.matrix, this.currentState);
    // 采到 BROWSER_CLOSED → 是否真正下线由「作息意愿 + 已上线时长」决定（acceptOffline，非固定概率）。
    // 不接受下线 → 重抽（最多 3 次仍命中则回首页继续，避免卡在吸收态）；接受 → 保留 BROWSER_CLOSED，
    // 由下方「生成长休息任务」分支执行下线。
    if (nextState === MainState.BROWSER_CLOSED && !this.acceptOffline()) {
      for (let i = 0; i < 3 && nextState === MainState.BROWSER_CLOSED; i++) {
        nextState = sampleNextState(this.matrix, this.currentState);
      }
      if (nextState === MainState.BROWSER_CLOSED) {
        nextState = MainState.HOME_FEED;
      }
    }

    // === 流程性状态覆盖（保证注册表中对应任务概率=1 被必然选中）===
    // OpenVideo 成功 → 锁定内容消费态（WatchVideo 必然）
    if (lastTaskName === 'OpenVideo' && lastSuccess) {
      nextState = MainState.CONTENT_CONSUMING;
    }
    // BrowseProfile 未找到入口 → 锁定搜索结果态（Search 必然）
    if (lastTaskName === 'BrowseProfile' && lastMeta?.needSearch === true) {
      nextState = MainState.SEARCH_RESULT;
    }
    // 重试流程：OpenVideo 前置失败 → 下一步先 CloseVideo（关错误页），回首页态
    if (this.retryWatchVideo && lastTaskName !== 'CloseVideo') {
      nextState = MainState.HOME_FEED;
    }
    // WatchVideo 秒关 → 快速关闭视频：回首页态，触发 CloseVideo 关掉视频标签页（避免视频残留继续播放）
    if (lastTaskName === 'WatchVideo' && lastSuccess && lastMeta?.quickClose === true) {
      nextState = MainState.HOME_FEED;
    }
    // WatchVideo 正常看完（非秒退）→ 保持内容消费态：看完一个视频的满足感驱动「连刷下一个推荐视频」。
    // 必须保持 content_consuming 才能连刷（leavingVideoState 会清空推荐流）；秒退则上面已回首页走 CloseVideo。
    if (lastTaskName === 'WatchVideo' && lastSuccess && lastMeta?.quickClose !== true) {
      nextState = MainState.CONTENT_CONSUMING;
    }

    // 离开视频态：仅当「上一任务确实在视频页消费过且成功」且下一状态不再继续看 → CloseVideo 必然。
    // 之前只凭状态名 CONTENT_CONSUMING 判断，会因矩阵从别的状态采样进入 CONTENT_CONSUMING
    // （从未打开过视频）而误触发——CloseVideo 逻辑上只应出现在 OpenVideo 之后。
    const leavingVideoState =
      isVideoTask(lastTaskName) &&
      lastSuccess === true &&
      this.currentState === MainState.CONTENT_CONSUMING &&
      nextState !== MainState.CONTENT_CONSUMING;
    if (leavingVideoState) {
      nextState = nextState === MainState.BROWSER_CLOSED ? MainState.HOME_FEED : nextState;
      this.recommendations = []; // 离开视频态，推荐流失效
    }

    // 采到 BROWSER_CLOSED 且未被流程性覆盖改写 → 生成一个「长休息」任务作为下线的表现形式：
    // 模拟真人「判定离开电脑 → 关闭浏览器下线」，由 RestTask 长休息执行 CloseBrowserBehavior
    // 关闭浏览器并返回 nextState=BROWSER_CLOSED；bilibili-user-simulation 据此用长休息时长做离线倒计时
    // （longRestMs 判定），统一「下线」语义，避免直接 return null 造成「莫名下线 + 离线时长重采样」。
    // 时长恒 > 10min 长休息阈值（沿用 Rest 注册表长休息区间 30~120min）。
    if (nextState === MainState.BROWSER_CLOSED) {
      this.currentState = nextState;
      console.log('   😴 状态采样到 BROWSER_CLOSED，生成长休息任务（关闭浏览器下线）');
      return new RestTask({ durationMs: (30 + Math.random() * 90) * 60_000 });
    }

    // 检测当前页面能力特征（任务概率统一 gate：入口可用性 + 视频标签）
    const pageFeatures = await this.options.pageFeatureDetector(context);

    // 从视频页触发搜索成功 → 进入搜索页：大幅升高「关闭前一个视频页」偏置（一次性）。
    // 真人从视频页搜索跳走时会顺手关掉前一个视频页标签（搜索 window.open 新标签，旧视频页残留）。
    // 未成功生成 CloseVideo 时由下方逐轮衰减（×0.5），避免偏置永久高悬。
    if (lastTaskName === 'Search' && lastSuccess && pageFeatures.hasVideoTab) {
      this.searchCloseBias = 0.9;
      console.log(`   🎯 进入搜索页（残留视频页），关闭前一个视频页偏置 0.9`);
    }

    // 构造生成上下文 → 注册表按概率选任务（通用马尔科夫链）
    const genCtx: GenerationContext = {
      persona: this.persona,
      currentState: nextState,
      fatigue,
      elapsedRatio,
      pageUrl: context.page?.url(),
      lastTaskName,
      lastSuccess,
      precheckFailed: lastMeta?.precheckFailed === true,
      needSearch: lastMeta?.needSearch === true,
      retryWatchVideo: this.retryWatchVideo,
      quickCloseVideo: lastTaskName === 'WatchVideo' && lastSuccess === true && lastMeta?.quickClose === true,
      leavingVideoState,
      videoDuration: typeof lastMeta?.videoDuration === 'number' ? lastMeta.videoDuration : undefined,
      // 上一个 WatchVideo 的实际观看完整度（供连刷概率绑定：看得越久越可能连刷下一个推荐视频）
      watchedRatio:
        lastTaskName === 'WatchVideo' &&
        lastSuccess === true &&
        typeof lastMeta?.durationMs === 'number' &&
        typeof lastMeta?.videoDuration === 'number' &&
        lastMeta.videoDuration > 0
          ? Math.min(1, lastMeta.durationMs / lastMeta.videoDuration)
          : undefined,
      recommendations: this.recommendations,
      searchCloseBias: this.searchCloseBias,
      pageFeatures,
      onlineStartAt: this.onlineStartAt,
      now: this.nowFn,
    };

    const task = sampleTaskByProbability(genCtx);
    if (!task) {
      // 该状态无可用任务 → 回退到首页再试
      nextState = MainState.HOME_FEED;
      this.currentState = nextState;
      return sampleTaskByProbability({ ...genCtx, currentState: MainState.HOME_FEED }) ?? null;
    }

    // 偏置生命周期：选中 CloseVideo → 使命完成清零；否则逐轮衰减（未成功生成关闭视频则逐渐降低）
    if (this.searchCloseBias > 0) {
      if (task.name === 'CloseVideo') {
        this.searchCloseBias = 0;
      } else {
        this.searchCloseBias *= 0.5;
      }
    }

    // 步骤 2/3：生成器定位目标视频元素，收集跳转链接 <a> + 基础信息并封装进 OpenVideo 任务
    //（供执行器步骤 4~7 据此确认跳转链接、定位坐标、滚动/关弹窗/聚焦校验/点击）
    // 纯逻辑模拟（sim:week）无真实 page 时跳过。
    if (task instanceof OpenVideoTask && context.page) {
      await task.prepareTargetInfo(context.page).catch(() => {});
    }

    this.currentState = nextState;
    return task;
  }
}
