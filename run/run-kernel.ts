/**
 * 内核（SimulationKernel）用法演示：一条命令体验「初始化 → 独立开关两大功能」。
 *
 * 与 run-headless/headed（persona-engine：上线→任务流→下线→休息 全自动循环）不同，
 * 本入口把两个功能拆开、交给使用者按需开关：
 *   ① await kernel.initialize()      打开浏览器并登录（登录态有效则免扫码）
 *   ② kernel.startFetch()            打开蹲饼   ←→ kernel.stopFetch()   只关蹲饼
 *   ③ kernel.startSimulation()       打开模拟   ←→ kernel.stopSimulation() 只关模拟
 *   ④ kernel.shutdown()              全部关闭 + 退出浏览器
 *
 * 用法（cwd = 本包根）：
 *   npm run start:kernel                          # 默认人格（包内 data/personas/ak-night-worker.json）
 *   npm run start:kernel -- <personaId>            # 指定人格（personaId = 人格目录下的文件名）
 *   npm run start:kernel -- <personaId> <目录>      # 指定人格目录（如主项目自己的 data/personas）
 *
 * 功能开关全部由**内核指令**驱动（终端输入，回车执行；也可由宿主代码 / IPC 下发）：
 *   sim on | sim off                                   模拟行为：从零打开 / 彻底结束
 *   fetch on | fetch off [close]                       蹲饼开关
 *   login                                              确保登录（未登录则扫码）
 *   status | dynamics [n] | help                       状态 / 动态 / 指令列表
 *   quit                                               关闭内核并退出（等同 Ctrl+C）
 *
 * `sim off` 的停止流程：阻塞生成器（不再生成下一个任务）→ 通过控制器中止持续式任务
 * （`controller.abort()` → 任务的「中断处理」→ 等主体收尾；非持续式短任务等它自然做完）
 * → 执行器跑完最后一个任务后，关闭不再需要的页面
 * （蹲饼未开 → 页面全关；蹲饼开着 → 只留蹲饼用的动态页）。
 *
 * 指令不是本演示特有，而是内核能力：
 *   kernel.attachConsole()              挂 stdin 指令通道（本文件用法）
 *   await kernel.executeCommand(...)    任意通道下发指令（IPC / HTTP / 宿主代码）
 *   kernel.registerCommand(...)         扩展自定义指令
 */
import path from 'node:path';
import { SimulationKernel } from '../src/kernel/kernel.js';
import { loadFetchReportConfig } from './fetch-report-config.js';
import { loadFetchRecordingConfig } from './fetch-recording-config.js';

/** personaId = 人格目录下的文件名（不含 .json） */
const personaId = process.argv[2] ?? 'ak-night-worker';
/** 人格目录（主项目自己的 data/personas；省略则用包内 data/personas） */
const personaDir = process.argv[3] ? path.resolve(process.argv[3]) : undefined;
const kernel = SimulationKernel.getInstance();

const fmtTime = (): string => new Date().toLocaleTimeString('zh-CN', { hour12: false });

// 动态出口沿用独立启动入口的配置（config-app.json5：外发接口 / 本地文档落盘）
const reportConfig = loadFetchReportConfig();
loadFetchRecordingConfig();

console.log(`\n🧠 内核演示启动 | ${new Date().toLocaleString('zh-CN', { hour12: false })}`);
console.log(`   人格目录: ${personaDir ?? '(包内 data/personas)'} | personaId: ${personaId}`);
console.log('   流程: initialize() → startFetch() → startSimulation()\n');

// ① 初始化：打开浏览器并登录（不启动任何功能）
await kernel.initialize({
  headless: true,
  personaId,
  personaDir, // 主项目自己的人格目录（personaId = 该目录下的文件名）
  fetchReport: reportConfig,
  onDynamics: (dynamics, kind) => {
    // 也可不传 onDynamics：动态会走 fetchReport 配置的出口（外发接口 / 本地文档）
    console.log(`[${fmtTime()}] [内核演示] 捕获动态 ${dynamics.length} 条（${kind}）`);
  },
});

// 可选：列出该人格目录下所有可用人格（文件名即 personaId）
const available = kernel.listPersonas();
console.log(`[内核演示] 可用人格（${kernel.personaDir}）: ${available.map((p) => p.id).join(', ') || '(无)'}`);

// ② 注册自定义指令（示例）：quit —— 关闭内核并退出进程
kernel.registerCommand('quit', {
  description: '关闭内核并退出进程',
  usage: 'quit',
  handler: () => {
    setTimeout(() => void quit(), 0); // 先让指令输出打印，再执行关闭
    return '👋 正在关闭内核…';
  },
});

// ③ 挂载 stdin 指令控制台：终端输入 sim off / fetch on / follow <uid> / status 等即控制功能
//    尽早挂载：蹲饼「初次获取」可能耗时 20s+，期间也应能接收指令
kernel.attachConsole({ onInterrupt: () => void quit() });

let quitting = false;
const quit = async (): Promise<void> => {
  if (quitting) {
    return;
  }
  quitting = true;
  await kernel.shutdown().catch(() => {});
  process.exit(0);
};

// ④ 打开蹲饼（独立）→ ⑤ 打开模拟行为（独立）
await kernel.startFetch();
await kernel.startSimulation();

console.log(`\n[${fmtTime()}] ✅ 蹲饼 + 模拟行为均已开启（可用指令独立开关）。输入 help 查看全部指令。\n`);
