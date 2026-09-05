import type { Browser, Page } from 'puppeteer-core';

/**
 * 任务执行上下文
 */
export interface TaskContext {
  /** 浏览器实例 */
  browser: Browser | null;

  /** 当前页面 */
  page: Page | null;

  /** 当前状态（用于状态机决策） */
  currentState: string;

  /** 是否已被中断/终止 */
  terminated: boolean;

  /** 中断/终止原因 */
  terminationReason?: string;

  /** 共享状态存储 */
  state: Map<string, unknown>;

  /** 上线目标（可选） */
  goal?: SessionGoal;

  /** 上线开始时间 */
  startTime: number;

  /** 疲劳度 (0-1) */
  fatigueLevel: number;

  /** 执行事件流（每次执行任务产生一个 TaskEvent） */
  logs: TaskEvent[];

  /** 元数据 */
  metadata: Record<string, unknown>;
}

/** 上线目标 */
export interface SessionGoal {
  type: string;
  duration?: number;
  taskCount?: number;
  metadata?: Record<string, unknown>;
}

/**
 * 任务执行事件：执行器执行任务时产生的记录。
 *
 * 任务本身没有时间概念；时间由**执行时产生的事件**记录：
 *  - taskName：任务是什么
 *  - startTime：任务发生（开始）的时间
 *  - duration：任务持续的时长
 *  - endTime：任务结束时间（getter，由 startTime + duration 推导）
 *
 * 真实执行器与模拟执行器都产生本事件。
 */
export class TaskEvent {
  readonly taskId: string;
  readonly taskName: string;
  readonly startTime: number;
  /** 任务完成后的状态 */
  state: string;
  /** 任务持续的时长（ms） */
  duration: number;
  status?: 'success' | 'failure' | 'skipped' | 'interrupted' | 'terminated';
  success: boolean;
  error?: string;
  metadata?: Record<string, unknown>;

  constructor(taskId: string, taskName: string, startTime: number, state: string) {
    this.taskId = taskId;
    this.taskName = taskName;
    this.startTime = startTime;
    this.state = state;
    this.duration = 0;
    this.success = false;
  }

  /** 任务结束时间：由开始时间 + 持续时间推导 */
  get endTime(): number {
    return this.startTime + this.duration;
  }
}

/** 创建默认上下文 */
export function createContext(browser: Browser | null = null, initialState: string = 'INIT', goal?: SessionGoal): TaskContext {
  return {
    browser,
    page: null,
    currentState: initialState,
    terminated: false,
    terminationReason: undefined,
    state: new Map(),
    goal,
    startTime: Date.now(),
    fatigueLevel: 0,
    logs: [],
    metadata: {},
  };
}

export function terminateContext(context: TaskContext | null | undefined, reason: string): TaskContext | null {
  if (!context) {
    return null;
  }

  context.terminated = true;
  context.terminationReason = reason;
  context.currentState = 'TERMINATED';
  return context;
}
