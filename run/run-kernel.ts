/**
 * 内核（SimulationKernel）启动入口：初始化 → 订阅动态 → 打开两大功能 → 持续运行直到 Ctrl+C。
 *
 *   ① await kernel.initialize()            打开浏览器（waitForLogin:false，不阻塞等扫码）
 *   ①′ await kernel.login({ onQrcode })    未登录时等扫码；二维码除终端打印外也回调给宿主
 *   ② kernel.createDynamicListener(cb)     订阅动态更新（返回订阅器）
 *   ③ await kernel.startFetch({ baselineTs? })  打开动态获取（蹲饼）
 *   ④ kernel.startSimulation()             打开模拟行为
 *   ⑤ Ctrl+C → stopFetch() → destroy()     关闭蹲饼（取回基线）并退出
 *
 * baselineTs = 增量基线（**秒**时间戳）：基线之后的动态都会获取并投递（不缺失，单批不够时强制滚动补全）；
 *   缺省 = 当前时间（只投递开启之后新产生的动态）。宿主应持久化 `stopFetch()` 的返回值，下次传回即可无缝续接。
 *
 * 用法（cwd = 本包根）：
 *   npm run start                          # 默认人格（包内 data/personas/ak-night-worker.json）
 *   npm run start -- <personaId>            # 指定人格（personaId = 人格目录下的文件名）
 *   npm run start -- <personaId> <目录>      # 指定人格目录（如主项目自己的 data/personas）
 *   npm run start -- <personaId> <目录> <baselineTs>   # 指定增量基线（上次 stopFetch() 的返回值）
 *
 * 内核对外能力：initialize / destroy、loadPersona / listPersonas、startSimulation / stopSimulation、
 * startFetch / stopFetch、createDynamicListener、login / logout，另有 followUp（主动关注 UP）。
 */
import path from 'node:path';
import { SimulationKernel } from '../src/kernel/kernel.js';

/** personaId = 人格目录下的文件名（不含 .json） */
const personaId = process.argv[2] ?? 'ak-night-worker';
/** 人格目录（主项目自己的 data/personas；省略则用包内 data/personas） */
const personaDir = process.argv[3] ? path.resolve(process.argv[3]) : undefined;
/** 增量基线（秒时间戳；命令行第 4 个参数；省略 = 当前时间） */
const baselineTs = process.argv[4] ? Number(process.argv[4]) : undefined;
const kernel = SimulationKernel.getInstance();

const fmtTime = (): string => new Date().toLocaleTimeString('zh-CN', { hour12: false });

console.log(`\n🧠 内核启动 | ${new Date().toLocaleString('zh-CN', { hour12: false })}`);
console.log(`   人格目录: ${personaDir ?? '(包内 data/personas)'} | personaId: ${personaId}`);
console.log(
  `   增量基线: ${baselineTs ? new Date(baselineTs * 1000).toLocaleString('zh-CN', { hour12: false }) : '(未指定 → 当前时间，只投递开启后新产生的动态)'}`
);
console.log('   流程: initialize() → login() → startFetch() → startSimulation()\n');

// ① 初始化：只打开浏览器，不启动任何功能
//    这里显式 waitForLogin: false —— initialize() 内置的登录等待只会把二维码打印到控制台；
//    要把二维码交给宿主自己渲染，就在下一步显式 login({ onQrcode })
await kernel.initialize({
  headless: true,
  personaId,
  personaDir, // 主项目自己的人格目录（personaId = 该目录下的文件名）
  waitForLogin: false,
});

// ①′ 登录：未登录时阻塞等扫码（已登录则立即返回，不打印不回调）
//    二维码对外输出：无头模式下除终端打印外，也回调到这里（宿主可自行渲染）
await kernel.login({
  onQrcode: (qr) => {
    const kind = qr.imageBase64 ? `图片 ${Math.round(qr.imageBase64.length / 1024)}KB` : '链接';
    console.log(
      `[${fmtTime()}] [内核] 收到登录二维码（${kind}）${qr.url ? `｜链接 ${qr.url.slice(0, 60)}` : ''}`
    );
  },
});

// 可选：列出该人格目录下所有可用人格（文件名即 personaId）
const available = kernel.listPersonas();
console.log(`[内核] 可用人格: ${available.map((p) => p.id).join(', ') || '(无)'}`);

// ② 订阅动态更新（订阅器类似 Flutter StreamSubscription，cancel() 取消订阅）
const subscription = kernel.createDynamicListener((dynamics, kind) => {
  console.log(`[${fmtTime()}] [内核] 捕获动态 ${dynamics.length} 条（${kind}）`);
});

// ②′ 进程级探针：长时间跑必须能区分「代码挂掉」与「被外部强杀」——
//    - 静默退出（日志里什么都没有）= 进程被外部强杀（taskkill/SIGKILL），不会触发 exit/uncaught 事件；
//    - 日志里打出「进程退出，code=…」= Node 自身退出（unhandledRejection / 显式 exit）；
//    - 默认 Node≥15 会把未处理拒绝当致命错误直接结束进程（exit 1 且日志骤停），所以这里先打出来。
process.on('unhandledRejection', (reason) => {
  console.error(`[${fmtTime()}] [内核] ⚠️ 未处理的 Promise 拒绝:`, reason);
});
process.on('uncaughtException', (err) => {
  console.error(`[${fmtTime()}] [内核] ⚠️ 未捕获异常:`, err);
});
process.on('exit', (code) => {
  console.error(`[${fmtTime()}] [内核] ⛔ 进程退出，exit code = ${code}`);
});

// ③ Ctrl+C 优雅退出：销毁内核并结束进程
let quitting = false;
const quit = async (): Promise<void> => {
  if (quitting) {
    return;
  }
  quitting = true;
  subscription.cancel();
  // 关闭蹲饼并取回最终基线（宿主应持久化它，下次 startFetch({ baselineTs }) 传回即可无缝续接）
  const baseline = await kernel.stopFetch().catch(() => 0);
  console.log(`[${fmtTime()}] [内核] 本次蹲饼最终基线：${baseline}（保存它，下次启动传入即可不缺失）`);
  await kernel.destroy().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', () => void quit());
process.on('SIGTERM', () => {
  console.error(`[${fmtTime()}] [内核] ⛔ 收到 SIGTERM，即将退出`);
  void quit();
});

// ④ 打开动态获取 → ⑤ 打开模拟行为
await kernel.startFetch({ baselineTs });
// 初次获取期间可能已通过 Ctrl+C 退出（shutdown 已执行）→ 不再启动模拟行为，避免竞态报错
if (!quitting) {
  await kernel.startSimulation();
  console.log(`\n[${fmtTime()}] ✅ 蹲饼 + 模拟行为均已开启（Ctrl+C 退出）。\n`);
}
