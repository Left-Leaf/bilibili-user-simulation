import { MainState, RuntimeState } from './state';
import type { DwellTimeConfig } from './config';
import { DEFAULT_BEHAVIOR_CONFIG } from './config';

/**
 * 从真实停留时间样本提取 10 个等距分位点（经验 CDF 查表）。
 * @param samples 某状态下所有停留时长（秒）
 */
export function buildDwellTimeCDF(samples: number[]): number[] {
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) {
    return [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  }
  return Array.from({ length: 10 }, (_, i) => sorted[Math.floor((i / 9) * (n - 1))]);
}

/** 从 CDF 分位点线性插值采样 */
export function sampleDwellTime(cdf: number[]): number {
  if (cdf.length === 0) {
    return 0;
  }
  if (cdf.length === 1) {
    return cdf[0];
  }
  const quantile = Math.random();
  const idx = quantile * (cdf.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const frac = idx - lo;
  return cdf[lo] * (1 - frac) + cdf[hi] * frac;
}

/** 采样正态分布（Box-Muller） */
export function gaussianRandom(): number {
  let u1 = 0;
  let u2 = 0;
  while (u1 === 0) u1 = Math.random();
  while (u2 === 0) u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * 停留时长采样器。
 * 有真实样本时用经验 CDF；否则用 Persona/配置里的 [均值, 标准差]（正态近似）。
 */
export class DwellTimeSampler {
  private cdfs = new Map<string, number[]>();
  private config: DwellTimeConfig;

  constructor(config: DwellTimeConfig = DEFAULT_BEHAVIOR_CONFIG.behavior.dwellTime) {
    this.config = config;
  }

  /** 注册某个状态的真实样本（秒） */
  registerSamples(stateKey: string, samples: number[]): void {
    this.cdfs.set(stateKey, buildDwellTimeCDF(samples));
  }

  /** 采样某个状态的停留时长（毫秒），可按疲劳系数衰减 */
  sample(stateKey: string, fatigue = 1): number {
    const cdf = this.cdfs.get(stateKey);
    if (cdf && cdf.some((v) => v > 0)) {
      return sampleDwellTime(cdf) * 1000 * fatigue;
    }

    const [avg, std] = this.config[stateKey] ?? [15, 10];
    const mu = Math.log(avg ** 2 / Math.sqrt(std ** 2 + avg ** 2));
    const sigma = Math.sqrt(Math.log(1 + std ** 2 / avg ** 2));
    const sampleSec = Math.exp(mu + sigma * gaussianRandom());
    // 对数正态长尾可能采样出极端值，限制在 [0.5s, max(3*avg, 60s)]
    const maxSec = Math.max(avg * 3, 60);
    const clampedSec = Math.min(Math.max(sampleSec, 0.5), maxSec);
    return clampedSec * 1000 * fatigue;
  }

  /** 按运行时状态采样（主状态 + 子状态） */
  sampleForState(state: RuntimeState, fatigue = 1): number {
    const key = state.main === MainState.CONTENT_CONSUMING && state.sub ? state.sub : state.main;
    return this.sample(key, fatigue);
  }
}
