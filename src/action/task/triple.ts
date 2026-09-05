import { BaseTask, TaskResult } from './base';
import type { TaskContext } from '../execute/context';
import { MainState } from '../engine/state';
import { MouseMoveBehavior, LeftClickBehavior, SleepBehavior } from '../behavior';
import { MousePositionManager } from '../engine/mouse-position-manager';
import { isVideoPageUrl } from '../../utils/bilibili-dom';

/**
 * 三连任务：明确目的「点赞 + 投币 + 收藏」的行为集合。
 * 行为组合：对三个按钮依次执行 拟人移动 → 左键单击，按钮缺失则跳过该步。
 */
export class TripleTask extends BaseTask {
  constructor(
    private likeSelector: string = '.video-like, .video-like-btn, .like',
    private coinSelector: string = '.video-coin, .coin, .video-toolbar-item-vote',
    private collectSelector: string = '.video-fav, .collect, .video-toolbar-item-fav'
  ) {
    super('Triple');
  }

  async preCheck(context: TaskContext): Promise<boolean> {
    if (!context.page) {
      return false;
    }
    // 三连（点赞/投币/收藏）只在视频页有意义：非视频页（如动态页也有赞按钮）绝不执行
    if (!isVideoPageUrl(context.page.url())) {
      return false;
    }
    // 只有当前页有「点赞/投币/收藏」任一按钮才执行（否则跳过）
    for (const sel of [this.likeSelector, this.coinSelector, this.collectSelector]) {
      const btn = await context.page.$(sel).catch(() => null);
      if (btn) {
        return true;
      }
    }
    return false;
  }

  async execute(context: TaskContext): Promise<TaskResult> {
    const page = context.page!;
    const actions = [
      { name: '点赞', selector: this.likeSelector },
      { name: '投币', selector: this.coinSelector },
      { name: '收藏', selector: this.collectSelector },
    ];

    let done = 0;
    const results: string[] = [];
    try {
      for (const act of actions) {
        const btn = await page.$(act.selector).catch(() => null);
        if (!btn) {
          results.push(`${act.name}:跳过`);
          this.log(`📋 ${act.name}：按钮不存在，跳过`);
          continue;
        }

        // 组合行为：解析坐标 + 拟人移动 + 左键单击
        const resolved = await MousePositionManager.instance.resolveTarget(page, act.selector);
        if (!resolved.point && !resolved.alreadyClicked) {
          results.push(`${act.name}:找不到目标`);
          continue;
        }
        // 已由管理器兜底点击（深层懒加载无法定位）→ 视为成功
        if (resolved.alreadyClicked) {
          done += 1;
          results.push(`${act.name}:成功(兜底)`);
          this.log(`✅ ${act.name} 成功（兜底点击）`);
          await new SleepBehavior(500 + Math.random() * 800).execute(context);
          continue;
        }
        const mv = await new MouseMoveBehavior(resolved.point!).execute(context);
        if (!mv.success) {
          results.push(`${act.name}:移动失败`);
          continue;
        }
        const cl = await new LeftClickBehavior(resolved.point!).execute(context);
        if (cl.success) {
          done += 1;
          results.push(`${act.name}:成功`);
          this.log(`✅ ${act.name} 成功`);
          // 拟人间隔（真人逐个操作，中间有停顿）
          await new SleepBehavior(500 + Math.random() * 800).execute(context);
        } else {
          results.push(`${act.name}:点击失败`);
        }
      }

      if (done === 0) {
        return { success: false, error: `三连失败：${results.join(', ')}` };
      }
      return {
        success: true,
        data: { done, total: actions.length, results },
        nextState: MainState.CONTENT_CONSUMING,
      };
    } catch (error) {
      return { success: false, error: `三连失败: ${(error as Error).message}`, data: { results } };
    }
  }
}
