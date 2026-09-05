import path from 'node:path';
import fs from 'node:fs';
import type { Task } from '../task/base';
import { LoginTask } from '../task/login';
import { DeterministicGenerator } from './deterministic';
import type { TaskGenerator } from './generator';
import { TaskExecutor } from '../execute/executor';
import type { ExecutionResult } from '../execute/executor';
import { createContext } from '../execute/context';
import { packagePath } from '../../utils/paths';

/** 登录流程选项 */
export interface LoginFlowOptions {
  /** 无头模式（服务器上 true，本地调试 false） */
  headless?: boolean;
  /** 登录超时（毫秒），默认 3 分钟 */
  loginTimeoutMs?: number;
  /** 浏览器用户数据目录（登录信息存储位置） */
  userDataDir?: string;
  /**
   * 结束后是否清理登录信息，默认 false。
   * 默认保留 cookie/profile，使登录态跨次运行持久化，下次已登录时自动跳过登录流程。
   */
  cleanup?: boolean;
}

const DEFAULT_USER_DATA_DIR = packagePath('puppeteer-browser', 'data');

/**
 * 登录任务链：单个 LoginTask（任务 = 行为集合）。
 * LoginTask 内部组合：打开浏览器 → 打开 B 站主页 → 鼠标移动/点击登录入口 →
 * 获取登录二维码 → 等待扫码登录；已登录则跳过。
 */
export function createLoginFlowChain(options: LoginFlowOptions = {}): Task[] {
  const { headless = false, loginTimeoutMs = 180000 } = options;

  return [
    new LoginTask({
      headless,
      userDataDir: options.userDataDir ?? DEFAULT_USER_DATA_DIR,
      loginTimeoutMs,
    }),
  ];
}

/** 生成固定的登录任务流（确定性生成器，可直接交给 TaskExecutor 执行） */
export function createLoginFlowGenerator(options: LoginFlowOptions = {}): TaskGenerator {
  return new DeterministicGenerator(createLoginFlowChain(options));
}

/** 清空浏览器登录数据（profile / cookie） */
export function cleanupLoginData(userDataDir = DEFAULT_USER_DATA_DIR): void {
  if (fs.existsSync(userDataDir)) {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.mkdirSync(userDataDir, { recursive: true });
  }
}

/**
 * 运行登录任务链：
 * 创建上下文 → 执行 LoginTask → 汇报结果 → 关闭浏览器。
 *
 * 默认**保留登录信息**（不清理 cookie/profile）：
 *  - 已登录（有登录 cookie / 头像）时，LoginTask 内部检测到后直接跳过登录流程；
 *  - 保留登录态，下次运行直接跳过登录。
 */
export async function runLoginFlow(options: LoginFlowOptions = {}): Promise<ExecutionResult> {
  const { cleanup = false, headless = false } = options;

  const context = createContext(null, 'INIT', { type: 'login' });
  const generator = createLoginFlowGenerator(options);
  const executor = new TaskExecutor(generator, context, { stopOnError: false });

  try {
    const result = await executor.execute();

    const alreadyLoggedIn = context.state.get('alreadyLoggedIn') === true;
    const loginTask = context.logs.find((log) => log.taskName === 'Login');
    let outcome: string;
    if (alreadyLoggedIn) {
      outcome = '✅ 已登录，跳过登录流程';
    } else if (loginTask?.success) {
      outcome = '✅ 登录成功';
    } else {
      outcome = '❌ 登录失败/超时';
    }

    console.log('\n========== 登录结果 ==========');
    console.log(`模式：${headless ? '无头模式 (headless)' : '正常模式 (headed)'}`);
    console.log(`结果：${outcome}`);
    console.log(`页面：${context.page?.url() ?? 'N/A'}`);
    console.log('==============================\n');

    return result;
  } finally {
    if (context.browser) {
      try {
        await context.browser.close();
      } catch {
        // 浏览器可能已被用户关闭，忽略关闭异常
      }
    }

    if (cleanup) {
      cleanupLoginData(options.userDataDir);
      console.log('浏览器已关闭，登录信息已清理。');
    } else {
      console.log('浏览器已关闭，登录信息已保留。');
    }
  }
}
