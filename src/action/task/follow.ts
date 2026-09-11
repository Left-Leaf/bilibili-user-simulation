import { BaseTask, TaskResult } from './base';
import type { TaskContext } from '../execute/context';
import { MainState } from '../engine/state';
import { MouseMoveBehavior, LeftClickBehavior } from '../behavior';
import { MousePositionManager } from '../engine/mouse-position-manager';
import { extractUpProfileInfo } from '../../utils/bilibili-dom';

/**
 * 关注任务：明确目的「关注当前主页的 UP 主」的行为集合。
 * 行为组合：拟人移动鼠标到关注按钮 → 左键单击。
 */
export class FollowTask extends BaseTask {
  constructor(private selector: string = '.follow-btn, .attention, .header-info-ctnr .follow-btn') {
    super('Follow');
  }

  async preCheck(context: TaskContext): Promise<boolean> {
    if (!context.page) {
      return false;
    }
    // 只有当前页有「关注」按钮才执行（已关注/不在主页则跳过）
    const btn = await context.page.$(this.selector).catch(() => null);
    return !!btn;
  }

  async execute(context: TaskContext): Promise<TaskResult> {
    const page = context.page!;
    const steps: TaskResult[] = [];
    try {
      const btn = await page.$(this.selector).catch(() => null);
      if (!btn) {
        return { success: false, error: '未找到关注按钮（可能已关注或不在主页）' };
      }

      // 解析目标坐标（MousePositionManager 统一计算：可见性遍历/落点/滚动/兜底）
      const resolved = await MousePositionManager.instance.resolveTarget(page, this.selector);
      if (!resolved.point && !resolved.alreadyClicked) {
        throw new Error('找不到目标');
      }
      // 已由管理器兜底点击（深层懒加载无法定位）→ 跳过移动/点击
      if (!resolved.alreadyClicked) {
        // 行为1：拟人移动
        const mv = await new MouseMoveBehavior(resolved.point!).execute(context);
        steps.push(mv);
        if (!mv.success) {
          throw new Error(mv.error);
        }

        // 行为2：左键单击
        const cl = await new LeftClickBehavior(resolved.point!).execute(context);
        steps.push(cl);
        if (!cl.success) {
          throw new Error(cl.error);
        }
      }

      // 读取目标 UP 信息（uid/名称）作为关注结果的返回内容
      const profile = await extractUpProfileInfo(page).catch(() => null);
      const uid = profile?.uid ?? '';
      const name = profile?.name ?? '';

      this.log(`➕ 已关注: ${name || '(未知 UP)'}（uid ${uid || '?'}）`);
      this.setNextState(MainState.USER_PROFILE);
      return { success: true, data: { steps: steps.length, uid, name } };
    } catch (error) {
      return { success: false, error: `关注失败: ${(error as Error).message}`, data: { steps: steps.length } };
    }
  }
}
