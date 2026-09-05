/**
 * 休息决策公共模块：统一「任务后是否休息 / 休息多久」的逻辑。
 *
 * 供正式运行共用：注册表 Rest 任务的概率（task-registrations.ts）与
 * 长休息判定（RestTask）对「同一任务 + 同一状态」算出完全一致的休息概率。
 */

/** 采样 [min,max] 闭区间均匀随机 */
export function sampleRange(r: [number, number]): number {
  return r[0] + Math.random() * (r[1] - r[0]);
}

/**
 * 任务类型 → 休息倾向系数（乘性调制休息概率）。
 * 有些任务后直接休息符合人类行为（看完视频/刷完首页），
 * 有些任务后直接休息极不自然（刚打开视频/刚搜索），概率应特别低。
 */
export function restAffinity(taskName: string | undefined): number {
  switch (taskName) {
    // 自然：看完/刷完一类，休息很正常
    case 'WatchVideo':
    case 'BrowseHome':
    case 'BrowseDynamic':
    case 'BrowseProfile':
      return 1.0;
    // 较不自然：互动完一般会继续看
    case 'Like':
    case 'Triple':
    case 'Comment':
    case 'Follow':
      return 0.4;
    // 很不自然：动作未完成感强，休息概率特别低
    case 'OpenVideo':
    case 'Search':
    case 'CloseVideo':
      return 0.15;
    default:
      return 0.6;
  }
}

/**
 * 任务结束后的「是否休息」概率（统一决策）。
 * 结合当前意愿 + 已上线时长推算——上线越久越易休息（疲劳累积），
 * 意愿越高越能刷下去。返回 [0,1]，非必然严格 <1。
 *
 * @param will        当前时刻意愿 [0,1]
 * @param elapsedMs   本次在线段已持续时长
 * @param expectedMs  预期在线时长（persona online_minutes 的意愿调制值）
 * @param taskName    刚完成的任务名（restAffinity 调制）
 */
export function restProbability(will: number, elapsedMs: number, expectedMs: number, taskName?: string): number {
  const ratio = expectedMs > 0 ? elapsedMs / expectedMs : 1; // 已上线占预期时长的比例
  // 疲劳项：刚开始几乎不休息（<0.3 预期时长时 ~0.05），接近/超过预期时长时快速上升
  const fatigue = ratio < 0.3 ? 0.05 + ratio * 0.2 : 0.11 + 0.65 * Math.min(1, (ratio - 0.3) / 0.7);
  // 意愿项：意愿越高越不想休息（意愿 1 → 疲劳×0.5）
  const willFactor = 0.5 + 0.5 * (1 - will);
  return Math.min(0.8, fatigue * willFactor * restAffinity(taskName));
}

/**
 * 意愿感知的在线时长（分钟）：作为「预期在线时长」参考——不硬性截止，
 * 而是用休息概率随已上线时长累积来替代。
 */
export function onlineMinutesAt(will: number, r: [number, number]): number {
  const base = sampleRange(r);
  // 意愿 0 → 0.25×base（最短）；意愿 1 → 1.15×base（最长）
  return base * (0.25 + 0.9 * will);
}

/**
 * 意愿感知的离线时长（分钟）：
 * 高峰时离线更短（很快又上线），低谷时离线更久（休息更久）。
 */
export function offlineMinutesAt(will: number, r: [number, number]): number {
  const base = sampleRange(r);
  // 意愿 0 → 1.5×base（最长）；意愿 1 → 0.4×base（最短）
  return base * (1.5 - 1.1 * will);
}
