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
 *   npm run start:kernel                 # 默认人格 ak-night-worker
 *   npm run start:kernel -- <人格id>      # 指定包内人格
 *
 * 功能开关全部由**内核指令**驱动（终端输入，回车执行；也可由宿主代码 / IPC 下发）：
 *   sim on | sim off                                   模拟行为：从零打开 / 彻底结束
 *   fetch on | fetch off [close]                       蹲饼开关
 *   login                                              确保登录（未登录则扫码）
 *   status | dynamics [n] | help                       状态 / 动态 / 指令列表
 *   quit                                               关闭内核并退出（等同 Ctrl+C）
 *
 * `sim off` 的停止流程：阻塞生成器（不再生成下一个任务）→ 持续式任务收到停止请求后提前收尾
 * （非持续式短任务等它自然做完）→ 执行器跑完最后一个任务后，关闭不再需要的页面
 * （蹲饼未开 → 页面全关；蹲饼开着 → 只留蹲饼用的动态页）。
 *
 * 指令不是本演示特有，而是内核能力：
 *   kernel.attachConsole()              挂 stdin 指令通道（本文件用法）
 *   await kernel.executeCommand(...)    任意通道下发指令（IPC / HTTP / 宿主代码）
 *   kernel.registerCommand(...)         扩展自定义指令
 */
import { SimulationKernel } from '../src/kernel/kernel.js';
import { loadFetchReportConfig } from './fetch-report-config.js';
import { loadFetchRecordingConfig } from './fetch-recording-config.js';

const personaId = process.argv[2] ?? 'ak-night-worker';
const kernel = SimulationKernel.getInstance();

const fmtTime = (): string => new Date().toLocaleTimeString('zh-CN', { hour12: false });

// 动态出口沿用独立启动入口的配置（config-app.json5：外发接口 / 本地文档落盘）
const reportConfig = loadFetchReportConfig();
loadFetchRecordingConfig();

console.log(`\n🧠 内核演示启动 | 人格: ${personaId} | ${new Date().toLocaleString('zh-CN', { hour12: false })}`);
console.log('   流程: initialize() → startFetch() → startSimulation()\n');

// ① 初始化：打开浏览器并登录（不启动任何功能）
await kernel.initialize({
  headless: true,
  personaId,
  fetchReport: reportConfig,
  onDynamics: (dynamics, kind) => {
    // 也可不传 onDynamics：动态会走 fetchReport 配置的出口（外发接口 / 本地文档）
    console.log(`[${fmtTime()}] [内核演示] 捕获动态 ${dynamics.length} 条（${kind}）`);
  },
});

// ② 打开蹲饼（独立）
await kernel.startFetch();

// ③ 打开模拟行为（独立）
await kernel.startSimulation();

console.log(`\n[${fmtTime()}] ✅ 蹲饼 + 模拟行为均已开启（可用指令独立开关）。输入 help 查看全部指令。\n`);

// ④ 注册自定义指令（示例）：quit —— 关闭内核并退出进程
kernel.registerCommand('quit', {
  description: '关闭内核并退出进程',
  usage: 'quit',
  handler: () => {
    setTimeout(() => void quit(), 0); // 先让指令输出打印，再执行关闭
    return '👋 正在关闭内核…';
  },
});

// ⑤ 挂载 stdin 指令控制台：终端输入 sim off / fetch on / status 等即控制功能开关
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
