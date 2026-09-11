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

/**
 * 持续性任务控制器：由持续性任务的 `execute()` 返回，执行器持有。
 *
 * 职责（统一执行模型）：
 * - 执行器用 `done` 等待「任务是否结束」—— **不携带结果**；
 * - 执行器 / 外部用 `abort()` 请求中断 —— 本质是**调用任务的「中断处理函数」并结束异步进程**；
 * - 任务主体用 `dwell()` / `waitIfPaused()` 实现「可中断 / 可暂停」的分片等待；
 * - 任务主体正常收尾时调用 `finish()` 结束异步进程。
 */
export interface TaskController {
  /** 异步进程：仅表示「任务是否结束」（不代表结果） */
  readonly done: Promise<void>;
  /** 是否已被中止 */
  readonly aborted: boolean;
  /** 是否处于暂停 */
  readonly paused: boolean;
  /** 暂停任务（任务在检查点等待，不消耗进度） */
  pause(): void;
  /** 恢复任务 */
  resume(): void;
  /** 中止任务：调用任务的「中断处理」→ 结束异步进程 */
  abort(): Promise<void>;
  /** 任务侧：可中断 / 可暂停的分片等待；`false` = 已被中断（调用方应尽快收尾） */
  dwell(ms: number): Promise<boolean>;
  /** 任务侧：暂停期间挂起（直到 resume 或 abort） */
  waitIfPaused(): Promise<void>;
  /** 任务侧：任务主体结束（正常收尾）时调用，结束异步进程 */
  finish(): void;
}

/** `execute()` 的返回值：一次性任务 = 结果；持续性任务 = 控制器 */
export type TaskExecution = TaskResult | TaskController;

/** 判断 `execute()` 的返回值是否为持续性任务控制器 */
export function isTaskController(value: unknown): value is TaskController {
  const v = value as TaskController | null | undefined;
  return (
    !!v &&
    typeof v === 'object' &&
    typeof v.abort === 'function' &&
    typeof v.finish === 'function' &&
    typeof v.done?.then === 'function'
  );
}

/**
 * 统一任务接口（执行器固定按 **开始处理 → 执行 → 结束处理** 三段调用）：
 *
 * ```text
 * preCheck()                // 前置检查（不通过则跳过）
 *   ↓
 * onStart(context)          // ① 开始处理：载入「前一个状态」（固定调用，无操作也要为空实现）
 *   ↓
 * execute(context)          // ② 执行：只做事，不生成状态
 *   ├─ 一次性任务：返回 TaskResult      → 直接进入 ③
 *   └─ 持续性任务：返回 TaskController  → 执行器 await done 后再进入 ③
 *   ↓
 * onEnd(context)            // ③ 结束处理：生成「后一个状态」（固定调用）
 * ```
 *
 * 状态流转是**强制流程**（每个任务都必须遵守）：
 * - **前一个状态**由「开始函数」载入：从 `context.currentState`（上一任务 onEnd 生成并写入）读取；
 * - **后一个状态**由「结束函数」生成：写在返回结果的 `TaskResult.nextState` 上，执行器据此更新 `context.currentState`；
 * - 执行阶段（`execute`）只负责「做事 + 产出数据」，不决定状态；
 * - 若结束函数未声明后一个状态，则默认沿用前一个状态（状态机不变）。
 *
 * 持续性任务被中止（`controller.abort()`）时：先调 `onInterrupt(context)`，再结束 `done`；
 * 执行器等到 `done` 结束后才调用 `onEnd`。持续性任务的结果存在任务状态里，在 ③ 阶段读取。
 */
export interface Task {
  readonly id: string;
  readonly name: string;
  readonly category?: 'navigation' | 'behavior' | 'generation' | 'execution';

  /** 前置检查：不通过则跳过本任务 */
  preCheck(context: TaskContext): Promise<boolean>;

  /** ① 开始处理（固定调用）：载入「前一个状态」 */
  onStart(context: TaskContext): Promise<void> | void;

  /** ② 执行：一次性任务返回结果；持续性任务返回控制器（都不生成状态） */
  execute(context: TaskContext): Promise<TaskExecution>;

  /**
   * ③ 结束处理（固定调用）：生成「后一个状态」。
   * `outcome` 为执行阶段产物（一次性任务的返回值 / 持续性任务记录的最终结果），供生成最终结果使用；
   * 返回值可覆盖执行阶段的产物。
   */
  onEnd(context: TaskContext, outcome?: TaskResult): Promise<TaskResult | void> | TaskResult | void;

  /** 中断处理（仅持续性任务需要；由 controller.abort() 调用） */
  onInterrupt?(context: TaskContext): Promise<void> | void;

  /** 持续性任务的结果（存在任务状态内；执行器在 ③ 之后读取作兜底） */
  getResult?(): TaskResult | null;

  getMetadata?(): Record<string, unknown>;
}

/** 持续性任务控制器工厂（供任务实现 `execute()` 时使用） */
export function createSustainedController(options: {
  /** 中断处理（`abort()` 时调用） */
  onInterrupt?: () => Promise<void> | void;
  /** 分片等待粒度（毫秒，默认 400） */
  chunkMs?: number;
  /** 中止后等待任务主体收尾的宽限时长（毫秒，默认 8000；超时则强断进程） */
  abortGraceMs?: number;
}): TaskController {
  const chunkMs = options.chunkMs ?? 400;
  const abortGraceMs = options.abortGraceMs ?? 8_000;
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });
  let paused = false;
  let aborted = false;
  let finished = false;

  const finish = (): void => {
    if (!finished) {
      finished = true;
      resolveDone();
    }
  };

  return {
    done,
    get aborted() {
      return aborted;
    },
    get paused() {
      return paused;
    },
    pause(): void {
      if (!finished) {
        paused = true;
      }
    },
    resume(): void {
      paused = false;
    },
    async abort(): Promise<void> {
      if (aborted) {
        // 已在中止流程中：等“异步进程结束”即可（幂等）
        await done;
        return;
      }
      if (finished) {
        return;
      }
      aborted = true;
      paused = false;
      try {
        await options.onInterrupt?.();
      } catch {
        /* 中断处理失败不阻塞任务结束 */
      }
      // 调用中断处理后，等任务主体在分片检查点完成收尾工作，再结束异步进程；
      // 主体超时未收尾（如卡在网络等待）→ 强断，避免阻塞执行器。
      const deadline = Date.now() + abortGraceMs;
      while (!finished && Date.now() < deadline) {
        await wait(50);
      }
      finish();
    },
    async dwell(ms: number): Promise<boolean> {
      let remain = ms;
      while (remain > 0) {
        if (aborted) {
          return false;
        }
        if (paused) {
          await wait(200);
          continue;
        }
        const step = Math.min(chunkMs, remain);
        await wait(step);
        remain -= step;
      }
      return !aborted;
    },
    async waitIfPaused(): Promise<void> {
      while (paused && !aborted) {
        await wait(200);
      }
    },
    finish,
  };
}

/** 抽象任务基类：提供三段式默认实现与持续性任务工具 */
export abstract class BaseTask implements Task {
  readonly id: string;
  readonly name: string;
  readonly category?: Task['category'];

  /** 任务最终结果（持续性任务在收尾时写入，供执行器在结束处理阶段读取） */
  protected result: TaskResult | null = null;

  /** 前一个状态（由 onStart 阶段从 context.currentState 载入） */
  protected prevState: string | null = null;

  /** 后一个状态（由 onEnd 阶段生成并返回；任务用 setNextState 声明落点） */
  protected nextState: string | null = null;

  constructor(name: string, id?: string, category?: Task['category']) {
    this.name = name;
    this.id = id || `${name}_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    this.category = category;
  }

  /** ② 执行（子类实现）：一次性任务返回 TaskResult；持续性任务返回 TaskController */
  abstract execute(context: TaskContext): Promise<TaskExecution>;

  async preCheck(_context: TaskContext): Promise<boolean> {
    return true;
  }

  /**
   * ① 开始处理：载入「前一个状态」（固定由执行器调用）。
   * 子类如覆盖此方法，必须调用 `super.onStart(context)`。
   */
  async onStart(context: TaskContext): Promise<void> {
    this.prevState = context.currentState;
    this.nextState = null;
    this.result = null;
  }

  /**
   * ③ 结束处理：生成「后一个状态」（固定由执行器调用）。
   * 默认把 `setNextState()` 声明的后一个状态合并进「执行结果」（持续性任务记录的结果优先，其次执行阶段产物）；
   * 未声明后一个状态则沿用前一个状态（状态机不变）。
   */
  async onEnd(context: TaskContext, outcome?: TaskResult): Promise<TaskResult | void> {
    const base = this.result ?? outcome;
    if (!base) {
      return;
    }
    return {
      ...base,
      nextState: this.nextState ?? base.nextState ?? this.prevState ?? context.currentState,
    };
  }

  /**
   * 任务侧：声明「本次执行后落到哪个主状态」（后一个状态）。
   * 执行阶段调用，实际由结束处理（onEnd）生成并交给执行器。
   */
  protected setNextState(state: string | null): void {
    this.nextState = state;
  }

  /**
   * 持续性任务收尾辅助：写入执行结果（数据），并声明后一个状态。
   * 由任务主体在收尾时调用；结果与状态最终由结束函数（onEnd）统一生成。
   */
  protected finishWith(result: TaskResult, nextState?: string | null): void {
    this.result = result;
    if (nextState !== undefined) {
      this.nextState = nextState;
    }
  }

  /** 中断处理：默认无操作（仅持续性任务需要覆盖；由 controller.abort() 调用） */
  async onInterrupt(_context: TaskContext): Promise<void> {
    /* 无操作 */
  }

  /** 持续性任务的结果（执行器在结束处理后读取，作为 onEnd 未返回结果时的兜底） */
  getResult(): TaskResult | null {
    return this.result;
  }

  /** 持续性任务：创建控制器（自动把 abort 绑定到本任务的 onInterrupt） */
  protected createController(context: TaskContext): TaskController {
    return createSustainedController({
      onInterrupt: () => this.onInterrupt(context),
    });
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

  /**
   * 构造「结束处理」前的执行结果（编排类任务用）。
   * 只负责状态码/数据/错误；**后一个状态请用 `setNextState()` 声明**，由 onEnd 统一生成。
   */
  protected finalizeResult(
    status: TaskStatus,
    data?: Record<string, unknown>,
    error?: string,
    reason?: string
  ): TaskResult {
    return {
      status,
      success: status === TaskStatus.SUCCESS,
      data,
      error,
      reason,
      interrupted: status === TaskStatus.INTERRUPTED || status === TaskStatus.TERMINATED,
    };
  }
}
