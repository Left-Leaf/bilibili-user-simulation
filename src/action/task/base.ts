import type { TaskContext } from '../execute/context';

export enum TaskStatus {
  SUCCESS = 'success',
  FAILURE = 'failure',
  SKIPPED = 'skipped',
  INTERRUPTED = 'interrupted',
  TERMINATED = 'terminated',
}

/** 统一任务结果契约：每个任务必须明确返回成功/失败/跳过/中断/终止 */
export interface TaskResult {
  status?: TaskStatus;
  success: boolean;
  error?: string;
  data?: Record<string, unknown>;
  nextState?: string;
  reason?: string;
  interrupted?: boolean;
}

/** 统一任务接口 */
export interface Task {
  readonly id: string;
  readonly name: string;
  readonly category?: 'navigation' | 'behavior' | 'generation' | 'execution';
  preCheck(context: TaskContext): Promise<boolean>;
  execute(context: TaskContext): Promise<TaskResult>;
  getMetadata?(): Record<string, unknown>;
}

/** 抽象任务基类 */
export abstract class BaseTask implements Task {
  readonly id: string;
  readonly name: string;
  readonly category?: Task['category'];

  constructor(name: string, id?: string, category?: Task['category']) {
    this.name = name;
    this.id = id || `${name}_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    this.category = category;
  }

  abstract execute(context: TaskContext): Promise<TaskResult>;

  async preCheck(_context: TaskContext): Promise<boolean> {
    return true;
  }

  getMetadata(): Record<string, unknown> {
    return {};
  }

  protected sleep(ms: number): Promise<void> {
    // 真实等待（无时间加速，所有拟人等待按真实耗时执行）
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 真实等待（不走时间缩放）：用于**功能性等待**（页面加载、新标签页出现等），
   * 这些依赖真实网络/渲染，不能被时间加速压缩。轮询等待新标签页必须用它。
   */
  protected sleepReal(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  protected async randomDelay(minMs: number, maxMs: number): Promise<void> {
    const delay = minMs + Math.random() * (maxMs - minMs);
    await this.sleep(delay);
  }

  /**
   * 统一任务日志：带执行时间 + 任务名前缀，供各任务描述自己的目标/状态/参数。
   * 输出形如：`[12:30:05] [BrowseHome] 收集到 12 个视频`
   */
  protected log(...args: unknown[]): void {
    const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    console.log(`[${t}] [${this.name}] ${args.map((a) => String(a)).join(' ')}`);
  }

  protected getState<T>(context: TaskContext, key: string): T | undefined {
    return context.state.get(key) as T | undefined;
  }

  protected setState(context: TaskContext, key: string, value: unknown): void {
    context.state.set(key, value);
  }

  protected finalizeResult(
    status: TaskStatus,
    data?: Record<string, unknown>,
    nextState?: string,
    error?: string,
    reason?: string
  ): TaskResult {
    return {
      status,
      success: status === TaskStatus.SUCCESS,
      data,
      nextState,
      error,
      reason,
      interrupted: status === TaskStatus.INTERRUPTED || status === TaskStatus.TERMINATED,
    };
  }
}
