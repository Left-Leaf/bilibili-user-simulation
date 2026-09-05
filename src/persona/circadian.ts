import type { PersonaConfig } from './types';

/**
 * Circadian（作息）共享工具：双峰意愿曲线 + 睡眠判定 + 时刻换算。
 * 被生成器（休息决策）与模拟器（sim:week）共同使用。
 */

/** chronotype 预设：两个活跃高峰的均值/强度（DESIGN 4.2） */
export const CHRONOTYPE_PRESETS: Record<string, { mu1: number; alpha1: number; mu2: number; alpha2: number }> = {
  morning_lark: { mu1: 9, alpha1: 1.0, mu2: 15, alpha2: 0.3 },
  afternoon_peak: { mu1: 11, alpha1: 0.6, mu2: 16, alpha2: 1.0 },
  night_owl: { mu1: 14, alpha1: 0.3, mu2: 23, alpha2: 1.0 },
  reversed: { mu1: 2, alpha1: 1.0, mu2: 5, alpha2: 0.5 },
};

/** 双峰意愿：某小时的活跃强度 [0,1]（睡眠段强制 0） */
export function willingnessAt(hour: number, c: NonNullable<PersonaConfig['circadian']>): number {
  const [sleepStart, sleepEnd] = c.sleep_time ?? [2, 9];
  if (sleepStart < sleepEnd && hour >= sleepStart && hour < sleepEnd) {
    return 0;
  }
  if (sleepStart > sleepEnd && (hour >= sleepStart || hour < sleepEnd)) {
    return 0;
  }

  const p = CHRONOTYPE_PRESETS[c.chronotype ?? 'night_owl'];
  const sigma = c.peak_width_hours ?? 3.0;
  const g = (h: number, mu: number) => Math.exp(-((h - mu) ** 2) / (2 * sigma * sigma));
  return p.alpha1 * g(hour, p.mu1) + p.alpha2 * g(hour, p.mu2);
}

/** 该时刻是否处于睡眠段 */
export function inSleep(hour: number, c: NonNullable<PersonaConfig['circadian']>): boolean {
  const [sleepStart, sleepEnd] = c.sleep_time ?? [2, 9];
  if (sleepStart < sleepEnd) {
    return hour >= sleepStart && hour < sleepEnd;
  }
  return hour >= sleepStart || hour < sleepEnd;
}

/** 取绝对时间戳的小时（0~24，跨午夜可 >=24） */
export function hourOf(t: number): number {
  const DAY_MS = 24 * 60 * 60 * 1000;
  return ((t % DAY_MS) / 3600_000 + 24) % 24;
}
