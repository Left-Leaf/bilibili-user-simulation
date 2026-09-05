/**
 * 人格档案（Persona）类型定义。
 *
 * 设计理念（涌现模型）：人格不定义"会话目的"，而是定义**状态游走的倾向**——
 * `state_transition_bias` 决定"处于某状态时更倾向转到哪个状态"，行为序列由这些
 * 倾向在马尔科夫游走中**自发涌现**。
 */

/** 行为习惯参数（DESIGN 3.2 behavior，下划线命名） */
export interface PersonaBehaviorConfig {
  /** 页面停留时长分布 [均值, 标准差]（秒），键为状态名或用途名 */
  dwell_time: Record<string, [number, number]>;
  /** 滚动速度范围（px/s） */
  scroll_speed_px_per_sec: [number, number];
  /** 滚动中停下细看的概率 */
  scroll_pause_prob: number;
  /** 回滚重看的概率 */
  scroll_back_prob: number;
  /** 互动概率 */
  like_prob: number;
  coin_prob: number;
  collect_prob: number;
  comment_prob: number;
  share_prob: number;
  /** 关注 UP 概率（UP 主页互动，独立字段，不与点赞共用） */
  follow_prob: number;
  /** 连刷倾向（越大越容易从视频跳到推荐视频） */
  binge_watch_tendency: number;
  /** 视频观看比例 [min, max]（看了 30%~90% 后退出） */
  video_watch_ratio: [number, number];
  /** 10 秒内退出视频的概率 */
  early_exit_prob: number;
}

/** 错误倾向参数（DESIGN 3.2 error_rate，下划线命名） */
export interface PersonaErrorRateConfig {
  misclick_prob: number;
  typo_prob: number;
  premature_close_prob: number;
  double_click_prob: number;
  back_button_prob: number;
  idle_wander_prob: number;
  /** 漫游持续时间 [min, max] ms */
  idle_wander_duration_ms: [number, number];
  skip_interaction_prob: number;
}

/** 状态转移倾向：from 状态 → { to 状态: 乘性调制系数 }（稀疏，默认 1.0 = 常人） */
export type StateTransitionBias = Record<string, Partial<Record<string, number>>>;

/** 上线起点分布：状态名 → 概率 */
export type InitialStateDistribution = Record<string, number>;

/** 完整人格档案 */
export interface PersonaConfig {
  id: string;
  meta: {
    name: string;
    description: string;
    age: number;
    occupation: string;
    gender: 'male' | 'female';
    bio: string;
  };

  /** ★ 状态转移倾向（人格差异的根源）：乘性调制基础转移矩阵 */
  state_transition_bias: StateTransitionBias;

  /** ★ 上线起点倾向（替代"目的→入口状态"表） */
  initial_state_dist: InitialStateDistribution;

  /** 兴趣偏置（内容相关度，R5） */
  interests?: {
    keywords: string[];
    /** 关注的 UP 主（以名字为主，uid 可选用于精确定位主页链接） */
    up_uid_affinity: Array<{ uid?: string; name: string }>;
    category_bias: Record<string, number>; // key = B站 tname
  };

  /** 行为习惯（R1/R3/R4） */
  behavior?: PersonaBehaviorConfig;

  /** 错误倾向 */
  error_rate?: PersonaErrorRateConfig;

  /** 作息（连续时间轴模型，L3） */
  circadian?: {
    chronotype: 'morning_lark' | 'afternoon_peak' | 'night_owl' | 'reversed';
    peak_width_hours: number;
    /** 睡眠段（强制离线，[起, 止] 小时，支持跨午夜如 [2,9]） */
    sleep_time: [number, number];
    /** 单次在线的时长范围（分钟）：意愿高时倾向于持续在线 */
    online_minutes: [number, number];
    /** 两次在线之间的休息时长范围（分钟） */
    offline_minutes: [number, number];
  };
}
