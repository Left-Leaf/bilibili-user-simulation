import type { TaskGenerator } from './generator';
import type { Task } from '../task/base';
import type { TaskContext } from '../execute/context';

export class DeterministicGenerator implements TaskGenerator {
  private tasks: Task[];

  constructor(tasks: Task[]) {
    this.tasks = tasks;
  }

  reset(): void {
    // 确定性生成器不需要重置逻辑
  }

  async hasNext(): Promise<boolean> {
    return this.tasks.length > 0;
  }

  async next(): Promise<Task | null> {
    if (this.tasks.length === 0) return null;
    return this.tasks.shift() || null;
  }
}
