import type { PersonaBehaviorConfig, PersonaConfig, PersonaErrorRateConfig } from './types';

/**
 * 基础状态转移矩阵（常识先验，对应 DESIGN 6.1.1/6.1.4）。
 * 行 = 当前状态，列 = 下一状态，顺序与 MAIN_STATES 一致：
 * LOGGED_IN / HOME_FEED / DYNAMIC_FEED / CONTENT_CONSUMING / SEARCH_RESULT / USER_PROFILE / BROWSER_CLOSED
 *
 * 来自 DESIGN 6.1.1 的录制数据 + 对 B 站产品的常识补充。
 * 注意：此矩阵不含人格偏置，是"常人"基线。人格通过 state_transition_bias 乘性调制它。
 */
// BROWSER_CLOSED 列权重已整体下调（约减半，降低自动下线频率）：真人关浏览器下线应低频发生，
// 下线主要由 RestTask 长休息承载（见 rest.ts / persona-generator 状态采样→生成长休息任务）。
// CONTENT_CONSUMING 的 0.3 → 0.15（原归一化后 ~46% 触发下线，过高）。
export const BASE_MATRIX: number[][] = [
  //            LOGIN   HOME    DYN    CONTENT  SEARCH  PROFILE  CLOSED
  [0.0, 0.45, 0.25, 0.15, 0.05, 0.05, 0.03], // LOGGED_IN（登录后进入各页面）
  [0.0, 0.0, 0.15, 0.45, 0.1, 0.05, 0.08], // HOME_FEED
  [0.0, 0.2, 0.0, 0.4, 0.05, 0.15, 0.03], // DYNAMIC_FEED
  [0.0, 0.2, 0.05, 0.0, 0.0, 0.1, 0.15], // CONTENT_CONSUMING
  [0.0, 0.1, 0.0, 0.55, 0.0, 0.0, 0.1], // SEARCH_RESULT
  [0.0, 0.1, 0.25, 0.3, 0.0, 0.0, 0.06], // USER_PROFILE
  [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0], // BROWSER_CLOSED（吸收态）
];

/** 默认状态转移偏置：全部 1.0（= 不调制，即"常人"） */
export const DEFAULT_STATE_BIAS = {};

/** 默认上线起点分布：主要从首页开始 */
export const DEFAULT_INITIAL_STATE_DIST: Record<string, number> = {
  home_feed: 0.6,
  dynamic_feed: 0.25,
  logged_in: 0.15,
};

/** 默认行为参数（对应 DESIGN 3.2 behavior） */
export const DEFAULT_BEHAVIOR: PersonaBehaviorConfig = {
  dwell_time: {
    home_feed: [15, 10],
    dynamic_feed: [25, 15],
    content_consuming: [180, 200],
    search_result: [8, 5],
    user_profile: [20, 15],
    video_playing: [180, 200],
    live_room: [300, 400],
    article_reading: [120, 100],
    comment_section: [15, 12],
  },
  scroll_speed_px_per_sec: [200, 800],
  scroll_pause_prob: 0.3,
  scroll_back_prob: 0.08,
  like_prob: 0.12,
  coin_prob: 0.04,
  collect_prob: 0.06,
  comment_prob: 0.02,
  share_prob: 0.01,
  follow_prob: 0.06,
  binge_watch_tendency: 0.7,
  video_watch_ratio: [0.3, 0.9],
  early_exit_prob: 0.3,
};

/** 默认错误倾向（对应 DESIGN 3.2 error_rate） */
export const DEFAULT_ERROR_RATE: PersonaErrorRateConfig = {
  misclick_prob: 0.01,
  typo_prob: 0.005,
  premature_close_prob: 0.03,
  double_click_prob: 0.02,
  back_button_prob: 0.03,
  idle_wander_prob: 0.05,
  idle_wander_duration_ms: [500, 4000],
  skip_interaction_prob: 0.1,
};

/**
 * 深度合并：合并嵌套对象（用于 persona 覆盖默认值）。
 * - 数组整体替换（不逐元素合并）
 * - 普通对象递归合并
 * - undefined 字段保留 base
 */
export function deepMerge<T>(base: T, override?: Partial<T>): T {
  if (override === undefined) {
    return base;
  }
  if (Array.isArray(base)) {
    return (override as unknown as T) ?? base;
  }
  if (typeof base === 'object' && base !== null) {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const key of Object.keys(override as Record<string, unknown>)) {
      const bv = (base as Record<string, unknown>)[key];
      const ov = (override as Record<string, unknown>)[key];
      if (ov === undefined) {
        continue;
      }
      if (bv !== null && typeof bv === 'object' && !Array.isArray(bv) && ov !== null && typeof ov === 'object' && !Array.isArray(ov)) {
        out[key] = deepMerge(bv, ov as Record<string, unknown>);
      } else {
        out[key] = ov;
      }
    }
    return out as T;
  }
  return (override as unknown as T) ?? base;
}

/** 创建"常人"默认人格（全偏置 1.0 + 默认参数） */
export function createDefaultPersona(id = 'default'): PersonaConfig {
  return {
    id,
    meta: {
      name: '默认人格',
      description: '全默认参数的普通人',
      age: 25,
      occupation: '普通用户',
      gender: 'male',
      bio: '',
    },
    state_transition_bias: { ...DEFAULT_STATE_BIAS },
    initial_state_dist: { ...DEFAULT_INITIAL_STATE_DIST },
    interests: { keywords: [], up_uid_affinity: [], category_bias: {} },
    behavior: structuredClone(DEFAULT_BEHAVIOR),
    error_rate: structuredClone(DEFAULT_ERROR_RATE),
  };
}

/** 合并用户 persona（默认值兜底 + 深层合并） */
export function normalizePersona(raw: Partial<PersonaConfig>): PersonaConfig {
  const base = createDefaultPersona(raw.id);
  return deepMerge(base, raw);
}
