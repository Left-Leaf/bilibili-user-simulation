// 人格层（L4）：定义账号的"状态游走倾向"，直接调制生成器的马尔科夫游走。
export * from './types';
export { BASE_MATRIX, DEFAULT_STATE_BIAS, DEFAULT_INITIAL_STATE_DIST, deepMerge, createDefaultPersona, normalizePersona } from './defaults';
export { buildTransitionMatrix, sampleNextState, sampleInitialState, formatMatrix } from './transition';
export { loadPersona } from './loader';
