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

/** 按矩阵从当前状态采样下一状态 */
export function sampleNextState(matrix: number[][], from: MainState): MainState {
  const row = matrix[mainStateIndex(from)];
  if (!row) {
    return MainState.HOME_FEED;
  }
  let r = Math.random();
  for (let i = 0; i < row.length; i++) {
    r -= row[i];
    if (r <= 0) {
      return MAIN_STATES[i];
    }
  }
  return MAIN_STATES[row.length - 1];
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
