import type { TaskContext } from '../execute/context';
import { DwellTimeSampler } from '../engine/dwell-time';
import { DEFAULT_BEHAVIOR_CONFIG } from '../engine/config';
import type { HumanBehaviorConfig } from '../engine/config';
import { BaseBehavior, type BehaviorResult } from './types';

/** 停留（原子行为）：按状态采样停留时长并等待（模拟真人看完一段的停顿） */
export class DwellBehavior extends BaseBehavior {
  constructor(
    private stateKey: string,
    private config: HumanBehaviorConfig = DEFAULT_BEHAVIOR_CONFIG,
    /** 固定停留时长（毫秒）：调用方已采样并打印预告，跳过内部采样（保证预告与实际一致） */
    private fixedMs?: number
  ) {
    super('Dwell');
  }

  async execute(_context: TaskContext): Promise<BehaviorResult> {
    const ms = this.fixedMs ?? new DwellTimeSampler(this.config.behavior.dwellTime).sample(this.stateKey);
    await this.sleep(ms);
    return this.ok({ stateKey: this.stateKey, dwellMs: ms });
  }
}

/** 固定等待（原子行为） */
export class SleepBehavior extends BaseBehavior {
  constructor(private ms: number) {
    super('Sleep');
  }

  async execute(_context: TaskContext): Promise<BehaviorResult> {
    await this.sleep(this.ms);
    return this.ok({ ms: this.ms });
  }
}
