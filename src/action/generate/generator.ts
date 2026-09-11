import type { Task } from '../task/base';
import type { TaskContext } from '../execute/context';

export interface TaskGenerator {
  next(context: TaskContext): Promise<Task | null>;
  /**
   * 重置生成器（任务流「从零打开」）。
   * 传入 context 时，同步把 `context.currentState` 校正为重置后的初始主状态，
   * 避免下一次上线沿用上次会话遗留的「前一个状态」。
   */
  reset(context?: TaskContext): void;
  hasNext(context: TaskContext): Promise<boolean>;
}
