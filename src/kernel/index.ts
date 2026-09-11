/**
 * 内核模块导出：全局静态单一实例 `SimulationKernel`。
 *
 * 详见 `kernel.ts` 顶部说明（初始化 → 独立开关蹲饼 / 模拟行为）。
 */
export { SimulationKernel, kernel } from './kernel.js';
export type {
  KernelInitializeOptions,
  KernelFetchOptions,
  KernelStopFetchOptions,
  KernelFollowUpOptions,
  KernelStatus,
  KernelConsoleOptions,
} from './kernel.js';

// 指令系统（扩展自定义指令时用到的类型与状态文本格式化）
export { registerBuiltinCommands, formatKernelStatus } from './commands.js';
export type {
  KernelCommand,
  KernelCommandContext,
  KernelCommandHandler,
  KernelCommandResult,
} from './commands.js';

// 人格目录工具（personaId = 文件名）
export { listPersonas, loadPersona, loadPersonaFromFile, DEFAULT_PERSONA_DIR } from '../persona/loader.js';
export type { PersonaEntry } from '../persona/loader.js';

// 蹲饼数据（出口 = B 站接口原始 items）
export { dynAuthor, dynId, dynPubTimeText, dynPubTs, dynText } from '../business/passive-fetch.js';
export type { BiliDynamicItem, DynamicListener } from '../business/passive-fetch.js';

// 主动关注 UP（独立操作，不进任务流）
export { followUpOnPage } from '../business/follow-up.js';
export type { FollowUpResult, FollowUpTarget } from '../business/follow-up.js';
