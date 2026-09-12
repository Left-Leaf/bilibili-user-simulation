import { MAIN_STATES, MainState, mainStateIndex } from '../action/engine/state';
import { BASE_MATRIX, DEFAULT_STATE_BIAS } from './defaults';
import type { PersonaConfig } from './types';

/**
 * 人格驱动的状态转移矩阵合成。
 *
 * 核心假设：不同 persona 因 `state_transition_bias` 不同，会调制出不同的转移矩阵，
 * 从而在马尔科夫游走中**自发涌现**出不同的状态序列（这就是"目的/行为差异"的来源）。
 *
 * 合成公式：result[i][j] = BASE_MATRIX[i][j] × bias[from][to]（乘性，默认 1.0），随后每行归一化。
 */

/** 合成某 persona 的状态转移矩阵（返回概率矩阵，每行求和 ≈ 1） */
export function buildTransitionMatrix(persona: PersonaConfig): number[][] {
  const bias = persona.state_transition_bias ?? DEFAULT_STATE_BIAS;
  const n = MAIN_STATES.length;

  const scaled = BASE_MATRIX.map((row, i) => {
    const fromState = MAIN_STATES[i] as string;
    const fromBias = bias[fromState] ?? {};
    return row.map((prob, j) => {
      const toState = MAIN_STATES[j] as string;
      const factor = fromBias[toState] ?? 1.0;
      return prob * factor;
    });
  });

  // 每行归一化为概率分布（BROWSER_CLOSED 吸收态行保持 [.., 1]）
  return scaled.map((row) => {
    const total = row.reduce((a, b) => a + b, 0);
    if (total <= 0) {
      // 全零行（理论上不该出现）：均匀兜底
      return row.map(() => 1 / n);
    }
    return row.map((p) => p / total);
  });
}

/**
 * 按矩阵从当前状态采样下一状态。
 *
 * @param exclude 要从分布中**剔除**的状态（如蹲饼开启期间剔除 `BROWSER_CLOSED`/下线）：
 *   剔除后对剩余状态**重新归一化**，因此这些状态**根本不会被生成**。
 *   （旧做法是「先生成再当场改写」，会把该状态的概率质量整体塞给某个固定状态、扭曲分布，
 *   日志上也会误导成「跳过」。）
 *   若剔除后已无可选项（整行都被剔除，理论上不该出现）→ 退回 `HOME_FEED`。
 */
export function sampleNextState(matrix: number[][], from: MainState, exclude?: readonly MainState[]): MainState {
  const row = matrix[mainStateIndex(from)];
  if (!row) {
    return MainState.HOME_FEED;
  }
  const blocked = exclude && exclude.length > 0 ? new Set<MainState>(exclude) : null;
  let r = Math.random();
  if (blocked) {
    // 可选项权重总和（用于把随机数映射回未归一化的原权重）
    let total = 0;
    for (let i = 0; i < row.length; i++) {
      if (!blocked.has(MAIN_STATES[i])) {
        total += row[i];
      }
    }
    if (total <= 0) {
      return MainState.HOME_FEED; // 全部被剔除 → 无路可走，回首页
    }
    r *= total;
  }
  for (let i = 0; i < row.length; i++) {
    if (blocked?.has(MAIN_STATES[i])) {
      continue;
    }
    r -= row[i];
    if (r <= 0) {
      return MAIN_STATES[i];
    }
  }
  // 浮点误差兜底：返回最后一个未被剔除的状态
  for (let i = row.length - 1; i >= 0; i--) {
    if (!blocked?.has(MAIN_STATES[i])) {
      return MAIN_STATES[i];
    }
  }
  return MainState.HOME_FEED;
}

/** 按 persona 的初始状态分布采样上线起点 */
export function sampleInitialState(persona: PersonaConfig): MainState {
  const dist = persona.initial_state_dist ?? {};
  const entries = Object.entries(dist);
  const total = entries.reduce((a, [, p]) => a + p, 0);
  let r = Math.random() * (total > 0 ? total : 1);
  for (const [state, prob] of entries) {
    r -= prob;
    if (r <= 0) {
      return state as MainState;
    }
  }
  return MainState.HOME_FEED;
}

/** 输出矩阵的可读形式（调试用） */
export function formatMatrix(matrix: number[][]): string {
  const headers = MAIN_STATES.map((s) => s.slice(0, 4).padEnd(5));
  const lines = matrix.map((row, i) => {
    const from = MAIN_STATES[i].slice(0, 4).padEnd(5);
    const cells = row.map((p) => p.toFixed(2).padStart(6));
    return `${from}|${cells.join('')}`;
  });
  return `     ${headers.join('')}\n${lines.join('\n')}`;
}
