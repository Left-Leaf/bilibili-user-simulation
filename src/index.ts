/**
 * bilibili-user-simulation 库入口。
 *
 * 推荐用法 = 内核（SimulationKernel）：对外只暴露六类能力——
 * 生命周期（initialize/destroy）、人格配置（loadPersona/listPersonas）、
 * 模拟行为（startSimulation/stopSimulation）、动态获取（startFetch/stopFetch）、
 * 动态监听器（createDynamicListener）、登录（login/logout）。
 *
 * ```ts
 * import { kernel } from 'bilibili-user-simulation';
 *
 * await kernel.initialize({ headless: true, personaId: 'ak-night-worker' });
 * const sub = kernel.createDynamicListener((items, kind) => {});
 * await kernel.startFetch();
 * await kernel.startSimulation();
 * // ...
 * sub.cancel();
 * await kernel.destroy();
 * ```
 *
 * 独立启动见 `run/run-kernel.ts`（`npm run start`）。
 */

// ===== 内核（推荐用法）：全局静态单一实例，统一持有浏览器会话 =====
export { SimulationKernel, kernel } from './kernel/kernel.js';
export type {
  KernelPersonaSource,
  KernelInitializeOptions,
  KernelFetchOptions,
  KernelFollowUpOptions,
  DynamicSubscription,
} from './kernel/kernel.js';

// 动态监听（被动蹲饼捕获出口）
export { setDynamicListener } from './business/passive-fetch.js';
export type { DynamicListener, BiliDynamicItem } from './business/passive-fetch.js';
// 原始动态字段读取辅助（出口数据是 B 站原始 item，这些只负责「便捷读取」，不改数据）
export { dynId, dynAuthor, dynPubTs, dynPubTimeText, dynText } from './business/passive-fetch.js';

// 人格加载（`personaId` = 人格目录下的**文件名**；主项目可用 personaDir 指向自己的 data/personas）
export { loadPersona, loadPersonaFromFile, listPersonas, DEFAULT_PERSONA_DIR } from './persona/loader.js';
export type { PersonaEntry } from './persona/loader.js';
export type { PersonaConfig } from './persona/types.js';

// 蹲饼底层开关（内核已封装；需要直接操作被动蹲饼时可用）
export { setFetchEnabled, isFetchEnabled } from './business/passive-fetch.js';

// 主动关注 UP（独立操作，不进入模拟任务流；内核已封装 kernel.followUp()）
export { followUpOnPage } from './business/follow-up.js';
export type { FollowUpResult, FollowUpTarget } from './business/follow-up.js';

// 页面运行时 shim（运行器兼容）：宿主自建页面并立即 page.evaluate 时先调用它，
// 避免 tsx / esbuild keepNames 注入的 __name 在页面里未定义导致回调报错
// （库内已由 OpenBrowserBehavior 自动覆盖所有自有页面）
export { installPageRuntimeShim, attachPageRuntimeShim } from './utils/page-runtime.js';
