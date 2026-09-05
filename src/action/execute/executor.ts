import { TaskStatus, type Task, type TaskResult } from '../task/base';
import type { TaskGenerator } from '../generate/generator';
import { TaskEvent } from './context';
import type { TaskContext } from './context';
import { fetchCoordinator } from '../../business/fetch-coordinator';

/** 统一时间戳格式（任务边界日志用） */
const fmtClock = (): string => new Date().toLocaleTimeString('zh-CN', { hour12: false });

/** 执行结果 */
export interface ExecutionResult {
  success: boolean;
  totalTasks: number;
  successCount: number;
  failedCount: number;
  duration: number;
  logs: TaskEvent[];
  context: TaskContext;
}

/** 执行器选项 */
export interface ExecutorOptions {
  maxTasks?: number;
  verbose?: boolean;
  stopOnError?: boolean;
}

/** 任务执行器：循环调用生成器并执行任务，直到终止 */
export class TaskExecutor {
  private generator: TaskGenerator;
  private context: TaskContext;
  private options: Required<ExecutorOptions>;

  constructor(generator: TaskGenerator, context: TaskContext, options: ExecutorOptions = {}) {
    this.generator = generator;
    this.context = context;
    this.options = {
      maxTasks: options.maxTasks ?? 1000,
      verbose: options.verbose ?? true,
      stopOnError: options.stopOnError ?? false,
    };
  }

  /** 执行上线任务流：动态生成并运行任务，直到生成器返回 null 或达到终止条件 */
  async execute(): Promise<ExecutionResult> {
    const startTime = Date.now();
    let taskCount = 0;
    let successCount = 0;
    let failedCount = 0;

    if (this.options.verbose) {
      console.log('🚀 开始执行上线任务流');
    }

    try {
      while (taskCount < this.options.maxTasks) {
        // 执行器不判断暂停：暂停（被动蹲饼协调 / 登录前）由生成器 next 侧处理，这里只负责接收并执行任务
        if (this.context.terminated) {
          if (this.options.verbose) {
            console.log(`🛑 上线任务流已终止: ${this.context.terminationReason ?? 'unknown reason'}`);
          }
          break;
        }

        const task = await this.generator.next(this.context);

        if (!task) {
          if (this.options.verbose) {
            console.log('✅ 上线任务流结束（生成器返回 null）');
          }
          break;
        }

        taskCount++;

        const canExecute = await this.preCheck(task);
        if (!canExecute) {
          console.log(`[${fmtClock()}] [${task.name}] ⏭️ 跳过（前置检查失败）`);
          if (this.options.verbose) {
            console.log(`⏭️  跳过任务: ${task.name} (前置检查失败)`);
          }
          // 记录前置检查失败事件：让生成器感知（如 WatchVideo 当前页不是视频页 → 可安排关闭重试）
          const skipped = new TaskEvent(task.id, task.name, Date.now(), this.context.currentState);
          skipped.duration = 0;
          skipped.success = false;
          skipped.status = 'skipped';
          skipped.error = '前置检查失败';
          skipped.metadata = { precheckFailed: true };
          this.context.logs.push(skipped);
          continue;
        }

        const log = await this.executeTask(task);
        // 任务结束：通知协调器当前无任务执行中（供被动蹲饼「等任务完成」策略判断）
        fetchCoordinator.currentTaskName = 'IDLE';

        // 退出登录后立即停止生成新任务：Logout 成功（isLoggedIn=false）→ 结束本次上线
        if (this.context.state.get('isLoggedIn') === false) {
          if (this.options.verbose) {
            console.log('🚪 已退出登录，停止生成新任务');
          }
          break;
        }

        if (log.status === TaskStatus.SUCCESS) {
          successCount++;
        } else if (log.status === TaskStatus.SKIPPED) {
          continue;
        } else if (log.status === TaskStatus.INTERRUPTED || log.status === TaskStatus.TERMINATED) {
          failedCount++;
          break;
        } else {
          failedCount++;
          if (this.options.stopOnError) {
            if (this.options.verbose) {
              console.log('🛑 遇到错误，停止执行');
            }
            break;
          }
        }

        this.updateFatigue();

        if (this.shouldTerminate()) {
          if (this.options.verbose) {
            console.log('🛑 达到终止条件，提前结束');
          }
          break;
        }
      }

      if (taskCount >= this.options.maxTasks) {
        if (this.options.verbose) {
          console.log('⚠️  达到最大任务数限制');
        }
      }
    } catch (error) {
      console.error('❌ 执行出错:', error);
    }

    const duration = Date.now() - startTime;

    if (this.options.verbose) {
      console.log(`\n📊 执行统计:`);
      console.log(`   总任务数: ${taskCount}`);
      console.log(`   成功: ${successCount}`);
      console.log(`   失败: ${failedCount}`);
      console.log(`   总时长: ${(duration / 1000).toFixed(1)}s`);
    }

    return {
      success: failedCount === 0,
      totalTasks: taskCount,
      successCount,
      failedCount,
      duration,
      logs: this.context.logs,
      context: this.context,
    };
  }

  /**
   * 直接执行单个任务（不经生成器）：供 bilibili-user-simulation 直接发「启动 / 登录 / 登出」等流程任务。
   * 执行器不判断暂停——任务自身的暂停由任务处理；这里只负责「接收并执行」。
   */
  async runTask(task: Task): Promise<TaskEvent> {
    const log = await this.executeTask(task);
    fetchCoordinator.currentTaskName = 'IDLE';
    return log;
  }

  private async preCheck(task: Task): Promise<boolean> {
    if (task.preCheck) {
      try {
        return await task.preCheck(this.context);
      } catch (error) {
        console.error(`前置检查异常: ${(error as Error).message}`);
        return false;
      }
    }
    return true;
  }

  private async executeTask(task: Task): Promise<TaskEvent> {
    // 通知协调器当前任务名（被动蹲饼据此分派处理策略）
    fetchCoordinator.currentTaskName = task.name;

    const realStart = Date.now();
    // 事件时间戳使用真实时间（无时间加速/模拟时钟）
    const eventStart = realStart;

    // 执行任务 → 产生一个执行事件：记录任务是什么 / 发生时间 / 持续时长 / 结束时间（getter）
    const log = new TaskEvent(task.id, task.name, eventStart, this.context.currentState);
    log.status = 'failure';

    console.log(`[${fmtClock()}] [${task.name}] ▶ 开始（状态 ${this.context.currentState}）`);
    if (this.options.verbose) {
      console.log(`\n📍 [任务 ${this.context.logs.length + 1}] ${task.name}`);
      console.log(`   状态: ${this.context.currentState}`);
    }

    try {
      const result = await task.execute(this.context);
      const normalized = this.normalizeResult(result);
      // 事件时长 = 真实耗时（无时间模拟/加速）
      const realEnd = Date.now();
      log.duration = realEnd - realStart;
      log.success = normalized.success;
      log.status = normalized.status;
      log.metadata = normalized.data;

      if (normalized.nextState) {
        this.context.currentState = normalized.nextState;
        if (this.options.verbose) {
          console.log(`   → 状态转移: ${normalized.nextState}`);
        }
      }

      if (normalized.status === TaskStatus.INTERRUPTED || normalized.status === TaskStatus.TERMINATED) {
        this.context.terminated = true;
        this.context.terminationReason = normalized.reason ?? normalized.error ?? 'task interrupted';
      }

      if (normalized.success) {
        console.log(`[${fmtClock()}] [${task.name}] ✅ 结束 (${(log.duration / 1000).toFixed(1)}s)`);
      } else if (normalized.status === TaskStatus.SKIPPED) {
        console.log(`[${fmtClock()}] [${task.name}] ⏭️ 跳过: ${normalized.reason ?? normalized.error ?? 'pre-check failed'}`);
      } else {
        console.log(`[${fmtClock()}] [${task.name}] ❌ 失败: ${normalized.error ?? normalized.reason ?? 'unknown error'}`);
        log.error = normalized.error ?? normalized.reason;
      }
    } catch (error) {
      const realEnd = Date.now();
      log.duration = realEnd - realStart;
      log.success = false;
      log.status = 'failure';
      log.error = (error as Error).message;
      console.log(`[${fmtClock()}] [${task.name}] ❌ 异常: ${log.error}`);
    }

    this.context.logs.push(log);
    return log;
  }

  private normalizeResult(result: TaskResult): TaskResult & { status: TaskStatus } {
    if (result.status) {
      return { ...result, status: result.status } as TaskResult & { status: TaskStatus };
    }

    if (result.interrupted || result.reason === 'browser closed by user') {
      return { ...result, status: TaskStatus.INTERRUPTED, success: false } as TaskResult & { status: TaskStatus };
    }

    if (result.success) {
      return { ...result, status: TaskStatus.SUCCESS } as TaskResult & { status: TaskStatus };
    }

    return { ...result, status: TaskStatus.FAILURE } as TaskResult & { status: TaskStatus };
  }

  private updateFatigue(): void {
    const elapsed = (Date.now() - this.context.startTime) / 1000 / 60;
    this.context.fatigueLevel = Math.min(elapsed / 60, 1.0);
  }

  private shouldTerminate(): boolean {
    if (this.context.goal?.duration) {
      const elapsed = (Date.now() - this.context.startTime) / 1000;
      if (elapsed >= this.context.goal.duration) {
        return true;
      }
    }

    if (this.context.goal?.taskCount) {
      if (this.context.logs.length >= this.context.goal.taskCount) {
        return true;
      }
    }

    if (this.context.currentState === 'EXIT' || this.context.currentState === 'TERMINATE') {
      return true;
    }

    return false;
  }
}
