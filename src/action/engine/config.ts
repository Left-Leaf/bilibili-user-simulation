import { MainState } from './state';

/**
 * 动作引擎所需的行为配置（对应 DESIGN Persona.behavior / error_rate 的子集）。
 * 后续接入真实 Persona 层时，只需把 PersonaConfig 映射为 HumanBehaviorConfig。
 */

/** 页面停留时长分布（秒），键为 MainState 或用途名 */
export interface DwellTimeConfig {
  [key: string]: [number, number]; // [均值, 标准差]（秒）
}

/** 行为习惯参数 */
export interface BehaviorConfig {
  dwellTime: DwellTimeConfig;
  /** 滚动速度范围（px/s） */
  scrollSpeedRange: [number, number];
  /** 滚动中停下细看的概率 */
  scrollPauseProb: number;
  /** 回滚重看的概率 */
  scrollBackProb: number;
  /** 互动概率 */
  likeProb: number;
  coinProb: number;
  collectProb: number;
  commentProb: number;
  shareProb: number;
  /** 连刷倾向（越大越容易从视频跳到推荐视频） */
  bingeWatchTendency: number;
  /** 视频观看比例 [min, max]（看了 30%~90% 后退出） */
  videoWatchRatio: [number, number];
  /** 10 秒内退出视频的概率 */
  earlyExitProb: number;
}

/** 错误倾向参数 */
export interface ErrorRateConfig {
  misclickProb: number;
  typoProb: number;
  prematureCloseProb: number;
  doubleClickProb: number;
  backButtonProb: number;
  idleWanderProb: number;
  /** 漫游持续时间 [min, max] ms */
  idleWanderDurationMs: [number, number];
  skipInteractionProb: number;
}

/** 完整的行为配置 */
export interface HumanBehaviorConfig {
  behavior: BehaviorConfig;
  errorRate: ErrorRateConfig;
}

/** 默认行为配置（对应 DESIGN 3.2 中的示例值） */
export const DEFAULT_BEHAVIOR_CONFIG: HumanBehaviorConfig = {
  behavior: {
    dwellTime: {
      [MainState.HOME_FEED]: [15, 10],
      [MainState.DYNAMIC_FEED]: [25, 15],
      [MainState.CONTENT_CONSUMING]: [180, 200],
      [MainState.SEARCH_RESULT]: [8, 5],
      [MainState.USER_PROFILE]: [20, 15],
      video_playing: [180, 200],
      live_room: [300, 400],
      article_reading: [120, 100],
      comment_section: [15, 12],
    },
    scrollSpeedRange: [200, 800],
    scrollPauseProb: 0.3,
    scrollBackProb: 0.08,
    likeProb: 0.12,
    coinProb: 0.04,
    collectProb: 0.06,
    commentProb: 0.02,
    shareProb: 0.01,
    bingeWatchTendency: 0.7,
    videoWatchRatio: [0.3, 0.9],
    earlyExitProb: 0.3,
  },
  errorRate: {
    misclickProb: 0.01,
    typoProb: 0.005,
    prematureCloseProb: 0.03,
    doubleClickProb: 0.02,
    backButtonProb: 0.03,
    idleWanderProb: 0.05,
    idleWanderDurationMs: [500, 4000],
    skipInteractionProb: 0.1,
  },
};

/** 深度合并默认配置与用户配置（浅层即可，行为配置层级固定） */
export function mergeBehaviorConfig(defaults: HumanBehaviorConfig, override?: Partial<HumanBehaviorConfig>): HumanBehaviorConfig {
  if (!override) {
    return defaults;
  }
  return {
    behavior: { ...defaults.behavior, ...(override.behavior ?? {}) },
    errorRate: { ...defaults.errorRate, ...(override.errorRate ?? {}) },
  };
}
