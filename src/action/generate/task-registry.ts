import type { Task } from '../task/base';
import { MainState } from '../engine/state';
import type { PersonaConfig } from '../../persona/types';
import type { VideoEntry, ProfileEntry } from '../../utils/bilibili-dom';
import type { TaskContext } from '../execute/context';

/**
 * 当前页面能力特征：任务概率的统一入口 gate（生成器决策前实时检测）。
 * 原则（用户要求）：打开视频/搜索/打开动态页等操作，只要当前页面有对应入口
 * （视频入口/搜索框/动态入口），无论当前状态是什么，都应该有概率执行；
 * 无入口则概率为 0。CloseVideo 额外要求标签列表里有视频页。
 */
export interface PageFeatures {
  /** 当前页是否有视频入口（视频卡片 / 右侧推荐流等） */
  hasVideoEntry: boolean;
  /** 当前页是否有搜索框 */
  hasSearchBox: boolean;
  /** 当前页是否有动态入口 */
  hasDynamicEntry: boolean;
  /** 当前活动页是否为视频页（/video/BV）——互动/连刷的目标页前提（防视频标签在后台时误判） */
  isVideoPage: boolean;
  /** 当前页是否有「关注」按钮（UP 主页且未关注）——Follow 任务的前置条件 */
  hasFollowButton: boolean;
  /** 浏览器标签列表里是否有视频页 */
  hasVideoTab: boolean;
  /** 视频页标签数量（关闭视频页概率的依据：视频越多越可能清理） */
  videoTabCount: number;
  /** 浏览器总标签页数量（多余标签清理的依据） */
  tabCount: number;
  /** 当前页统计到的全部 UP 主页入口（BrowseProfile 抉择目标用，同 OpenVideo 的 collectVideoEntries） */
  profileEntries: ProfileEntry[];
}

/** 页面能力检测器（默认真实 DOM 检测；测试可注入模拟，避免假 page 检测不到入口） */
export type PageFeatureDetector = (context: TaskContext) => Promise<PageFeatures>;

/**
 * 任务注册表（通用化马尔科夫链）：
 * 项目启动时注册全部支持的任务，每个任务提供一个「根据生成器状态计算概率」的函数，
 * 生成器遍历注册表，按概率加权随机选出下一个任务。
 *
 * 与旧 TASK_MAP（状态→候选表+权重）的区别：
 * - 每个任务自注册 + 自算概率（基于当前状态/上一任务/上线时长等）
 * - 生成器全量比较所有任务概率，加权采样（流程性任务条件满足时概率=1，必然选中）
 */

/** 生成上下文：供每个任务的概率函数读取（携带人格 + 上线状态） */
export interface GenerationContext {
  persona: PersonaConfig;
  /** 当前（目标）主状态 */
  currentState: MainState;
  /** 上线内任务进度 0~1 */
  elapsedRatio: number;
  /** 疲劳度 0~1 */
  fatigue: number;
  /** 当前页 URL（若有） */
  pageUrl?: string;
  /** 上一个已完成的任务名（流程性跟进用，如 OpenVideo→WatchVideo） */
  lastTaskName?: string;
  /** 上一个任务是否成功 */
  lastSuccess?: boolean;
  /** 上一个任务是否前置检查失败 */
  precheckFailed?: boolean;
  /** BrowseProfile 结果：未找到 UP 入口需搜索跟进 */
  needSearch?: boolean;
  /** OpenVideo 前置检查失败后需「关闭错误页 → 重开视频」的重试标志 */
  retryWatchVideo?: boolean;
  /** WatchVideo 秒关（快速关闭视频）→ 关掉当前视频标签页（CloseVideo 必然） */
  quickCloseVideo?: boolean;
  /** 离开视频态（当前在视频页且下一状态不是继续看）→ CloseVideo 必然 */
  leavingVideoState?: boolean;
  /**
   * 从视频页进入搜索页的「关闭前一个视频页」偏置（0~1）：
   * Search 成功（进入搜索页）且残留视频页标签时由生成器置高（~0.9），
   * 参与 CloseVideo 概率计算使其大幅升高；一次性——若本轮未成功生成
   * CloseVideo，生成器在后续轮次逐轮衰减该偏置（×0.5）。
   */
  searchCloseBias?: number;
  /** 上一个任务返回的视频时长（OpenVideo 结果，供 WatchVideo 用） */
  videoDuration?: number;
  /** 上一个 WatchVideo 的实际观看完整度（0~1 = 实际观看时长 / 视频总长；非 WatchVideo 后为 undefined）。
   *  用于「连刷概率与观看时长绑定」：看得越久（沉浸看完）→ 下一个连刷概率越高 */
  watchedRatio?: number;
  /** 当前视频页右侧推荐流（OpenVideo 返回；供「打开推荐视频」连刷选目标，离开视频页清空） */
  recommendations?: VideoEntry[];
  /** 当前页面能力特征（生成器决策前检测：视频入口/搜索框/动态入口/视频标签） */
  pageFeatures?: PageFeatures;
  /** 本次上线（在线段）开始时间戳（休息决策用） */
  onlineStartAt?: number;
  /** 强制下一个任务为登录（运行时 login 指令触发，Login 概率=1） */
  forceLogin?: boolean;
  /** 强制下一个任务为退出登录（运行时 logout 指令触发，Logout 概率=1） */
  forceLogout?: boolean;
  /** 时钟源（取当前时间） */
  now?: () => number;
}

/** 任务注册项：每个任务自注册 name + 概率函数 + 工厂 */
export interface TaskRegistration {
  /** 任务名（唯一，用于日志/跟进） */
  name: string;
  /**
   * 根据生成器状态计算该任务概率，必须归一化在 [0,1]：
   * - 0 = 绝不选
   * - (0,1) = 非必然（按权重参与加权随机采样），绝不能等于 1
   * - 1 = 必然（仅流程性跟进任务条件满足时使用，如 OpenVideo→WatchVideo）
   */
  probability: (ctx: GenerationContext) => number;
  /** 创建任务实例（可按 persona/状态带参数） */
  create: (ctx: GenerationContext) => Task;
}

/** 全部注册任务（项目启动时填充） */
const REGISTRY: TaskRegistration[] = [];

/** 注册一个任务（项目启动时调用，同名幂等不重复） */
export function registerTask(reg: TaskRegistration): void {
  if (REGISTRY.some((r) => r.name === reg.name)) {
    return;
  }
  REGISTRY.push(reg);
}

/** 获取全部注册任务 */
export function getRegistry(): readonly TaskRegistration[] {
  return REGISTRY;
}

/** 按概率加权随机采样下一个任务（通用马尔科夫链）：
 * - 概率归一化在 [0,1]（clamp 兜底）；
 * - 存在「必然」（p===1，流程性跟进）时直接选中；
 * - 否则对所有非 0 概率加权随机采样。
 */
export function sampleTaskByProbability(ctx: GenerationContext): Task | null {
  // 收集各任务概率，clamp 到 [0,1]（防御非法值）
  const candidates = REGISTRY;
  const entries = candidates.map((reg) => {
    const raw = reg.probability(ctx);
    const p = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
    return { reg, p };
  });

  // 必然任务（p === 1，仅流程性跟进）→ 直接选中
  const forced = entries.filter((e) => e.p === 1);
  if (forced.length > 0) {
    // 若多个必然任务（理论上不该同时），取第一个
    return forced[0].reg.create(ctx);
  }

  // 加权随机采样
  const total = entries.reduce((s, e) => s + e.p, 0);
  if (total <= 0) {
    return null;
  }
  let r = Math.random() * total;
  for (const e of entries) {
    r -= e.p;
    if (r <= 0) {
      return e.reg.create(ctx);
    }
  }
  // 兜底：最后一个有概率的任务
  const last = entries.filter((e) => e.p > 0);
  return last.length > 0 ? last[last.length - 1].reg.create(ctx) : null;
}
