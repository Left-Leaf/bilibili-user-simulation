/**
 * 内核指令系统：把「打开 / 关闭内核功能」抽象成**可解析的指令**。
 *
 * 为什么独立于 stdin：指令的**解析与执行**（`kernel.executeCommand('sim off')`）与**通道**解耦，
 * 于是同一个指令表可以被多种通道复用：
 *   - 终端 stdin（内置 `kernel.attachConsole()`）
 *   - 宿主项目直接调用（`await kernel.executeCommand('fetch on')`）
 *   - IPC / HTTP / 消息队列 / 定时任务（拿指令字符串调 executeCommand 即可）
 *
 * 指令表可扩展：`kernel.registerCommand('my-cmd', { description, handler })`。
 *
 * 内置指令：
 *   sim on | sim off                                     模拟行为（任务流）从零打开 / 彻底结束
 *   fetch on | fetch off [close]                          蹲饼开关
 *   follow <uid> [no-hold]                                主动关注 UP（独立操作，不进任务流）
 *   login                                                 确保登录（未登录则扫码）
 *   status                                                状态快照
 *   dynamics [n]                                          查看最近捕获的动态
 *   help                                                  指令列表
 */
import type { SimulationKernel } from './kernel.js';
import { dynAuthor, dynPubTimeText, dynPubTs, dynText } from '../business/passive-fetch.js';

/** 指令执行上下文 */
export interface KernelCommandContext {
  /** 内核实例（单例） */
  kernel: SimulationKernel;
  /** 原始输入行（去首尾空白） */
  raw: string;
  /** 主指令之后的参数（按空白分词） */
  args: string[];
}

/** 指令执行结果 */
export interface KernelCommandResult {
  /** 是否执行成功（false 时 output 通常是用法/错误提示） */
  ok: boolean;
  /** 需要展示给用户的文本（可空：指令自身的业务日志已由内核打印） */
  output?: string;
}

/** 指令处理器：可返回字符串（等价 { ok: true, output }）、结果对象，或不返回 */
export type KernelCommandHandler = (
  ctx: KernelCommandContext
) => Promise<KernelCommandResult | string | void> | KernelCommandResult | string | void;

/** 一条指令的定义 */
export interface KernelCommand {
  /** 一句话说明（help 列表用） */
  description: string;
  /** 用法示例（help 列表用） */
  usage?: string;
  handler: KernelCommandHandler;
}

/** 状态快照文本（status 指令 / 上层日志复用） */
export function formatKernelStatus(kernel: SimulationKernel): string {
  const s = kernel.getStatus();
  const clock = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  return [
    `────────── 内核状态 [${clock}] ──────────`,
    `  初始化: ${s.initialized ? '✅ 已初始化' : '⏹ 未初始化'} | 登录态: ${s.loggedIn ? '有效' : '❌ 失效'}`,
    `  模拟行为: ${s.simulationRunning ? '▶ 运行中' : '⏹ 已结束'}`,
    `  蹲饼: ${s.fetchRunning ? '▶ 运行中' : '⏹ 已停止'} | 已捕获动态 ${s.dynamicCount} 条`,
    `  当前页面: ${s.currentPageUrl ? s.currentPageUrl.slice(0, 70) : '(无)'}`,
    `  累计任务事件: ${s.taskCount}`,
  ].join('\n');
}

/** 注册内核内置指令（由内核构造时调用；handler 通过 ctx.kernel 访问内核能力） */
export function registerBuiltinCommands(register: (name: string, command: KernelCommand) => void): void {
  register('sim', {
    description: '开关模拟行为（养号任务流）：on=从零打开，off=彻底结束',
    usage: 'sim on | sim off',
    handler: async ({ kernel, args }) => {
      const sub = (args[0] ?? '').toLowerCase();
      switch (sub) {
        case 'on':
          await kernel.startSimulation();
          return { ok: true };
        case 'off':
          await kernel.stopSimulation();
          return { ok: true };
        default:
          return { ok: false, output: '用法: sim on | sim off（模拟行为只有「从零打开」与「彻底结束」两种状态）' };
      }
    },
  });

  register('fetch', {
    description: '开关被动蹲饼（动态流捕获）',
    usage: 'fetch on | fetch off [close]',
    handler: async ({ kernel, args }) => {
      const sub = (args[0] ?? '').toLowerCase();
      switch (sub) {
        case 'on':
          await kernel.startFetch();
          return { ok: true };
        case 'off':
          // 默认保留动态页（重开更快）；带 close 则同时关闭动态页标签
          await kernel.stopFetch({ closePage: args.includes('close') });
          return { ok: true };
        default:
          return { ok: false, output: '用法: fetch on | fetch off [close]' };
      }
    },
  });

  register('follow', {
    description: '主动关注指定 UP（独立操作，不进入模拟任务流；已关注则幂等返回）',
    usage: 'follow <uid> [no-hold]',
    handler: async ({ kernel, args }) => {
      const uid = args[0];
      if (!uid) {
        return { ok: false, output: '用法: follow <uid>（UP 的 uid，纯数字；带 no-hold 则连「暂停生成新任务」也不做）' };
      }
      const r = await kernel.followUp(uid, { holdTasks: !args.includes('no-hold') });
      return { ok: r.status !== 'failed', output: `${r.status === 'failed' ? '❌' : '✅'} ${r.detail ?? r.status}` };
    },
  });

  register('login', {
    description: '确保登录（未登录则弹出二维码等待扫码）',
    usage: 'login',
    handler: async ({ kernel }) => {
      const ok = await kernel.login();
      return { ok, output: ok ? '🔓 登录态有效' : '🔒 仍未登录' };
    },
  });

  register('status', {
    description: '打印内核状态快照',
    usage: 'status',
    handler: ({ kernel }) => ({ ok: true, output: formatKernelStatus(kernel) }),
  });

  register('dynamics', {
    description: '查看最近捕获的动态',
    usage: 'dynamics [条数，默认 5]',
    handler: ({ kernel, args }) => {
      const limit = Number.parseInt(args[0] ?? '5', 10);
      const list = kernel.getDynamics(Number.isFinite(limit) && limit > 0 ? limit : 5);
      if (list.length === 0) {
        return { ok: true, output: '（暂无捕获的动态：蹲饼未开启或尚未有新动态）' };
      }
      const lines = list.map((item) => {
        const { uid, name } = dynAuthor(item);
        const ts = dynPubTs(item);
        const t = ts > 0 ? new Date(ts * 1000).toLocaleString('zh-CN', { hour12: false }) : dynPubTimeText(item) || '?';
        return `  · [${String(item.type ?? '')}] ${name || uid || '?'} [${t}]: ${(dynText(item) || '（无文案）').slice(0, 50)}`;
      });
      return { ok: true, output: `最近 ${list.length} 条动态：\n${lines.join('\n')}` };
    },
  });

  register('help', {
    description: '查看全部可用指令',
    usage: 'help',
    handler: ({ kernel }) => ({ ok: true, output: kernel.getCommandHelp() }),
  });
}
