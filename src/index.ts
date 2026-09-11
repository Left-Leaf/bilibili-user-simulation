/**
 * bilibili-user-simulation 库入口（模块用法）：主项目 `import` 后调用启动。
 *
 * 两种用法：
 * 1) example 独立启动：`npm run start:headless` / `start:headed`（入口在 run/）。
 *    以包内 `data/personas` 默认人格运行，动态出口 = 读 `config-app.json5`（外发接口 / 本地文档）。
 * 2) 模块接入（本文件）：`import { runPersonaEngine } from 'bilibili-user-simulation'`，
 *    - 用 `personaFile`（或 `persona` 对象）指明人格配置文件；
 *    - 传 `onDynamics` 注册动态监听，接收模块内部捕获的动态（此时不再自动外发/落盘）。
 *
 * 例：
 *   await runPersonaEngine({
 *     headless: true,
 *     personaFile: '/path/to/my-persona.json',   // 指明人格配置文件
 *     onDynamics: (dynamics, kind) => console.log('捕获动态', kind, dynamics.length),
 *   });
 */

// 引擎启动（真实时间无限循环：开浏览器 → 登录 → 动态页 → 任务流 → 离线休息 → 重开）
export { runPersonaEngine } from '../run/persona-engine.js';
export type { PersonaRunOptions } from '../run/persona-engine.js';

// 动态监听（被动蹲饼捕获出口）——模块接入方也可直接 setDynamicListener
export { setDynamicListener } from './business/passive-fetch.js';
export type { DynamicListener, FetchedDynamic } from './business/passive-fetch.js';

// 人格加载（`personaId` = 人格目录下的**文件名**；主项目可用 personaDir 指向自己的 data/personas）
export { loadPersona, loadPersonaFromFile, listPersonas, DEFAULT_PERSONA_DIR } from './persona/loader.js';
export type { PersonaEntry } from './persona/loader.js';
export type { PersonaConfig } from './persona/types.js';

// ===== 内核（推荐用法）：全局静态单一实例，统一管理浏览器会话 + 独立开关两大功能 =====
// 用法：initialize()（开浏览器并登录）→ startSimulation()/stopSimulation()（模拟行为）
//       → startFetch()/stopFetch()（被动蹲饼）→ shutdown()
export { SimulationKernel, kernel } from './kernel/kernel.js';
export type {
  KernelInitializeOptions,
  KernelFetchOptions,
  KernelStopFetchOptions,
  KernelStatus,
  KernelConsoleOptions,
} from './kernel/kernel.js';

// 指令控制：registerCommand / executeCommand / attachConsole（stdin 通道）
export type { KernelCommand, KernelCommandContext, KernelCommandHandler, KernelCommandResult } from './kernel/commands.js';
export { formatKernelStatus } from './kernel/commands.js';

// 蹲饼底层开关（内核已封装；需要直接操作被动蹲饼时可用）
export { setFetchEnabled, isFetchEnabled } from './business/passive-fetch.js';
