import type { Task } from '../task/base';
import type { TaskContext } from '../execute/context';

export interface TaskGenerator {
  next(context: TaskContext): Promise<Task | null>;
  reset(): void;
  hasNext(context: TaskContext): Promise<boolean>;
}
