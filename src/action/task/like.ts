import { BaseTask, TaskResult } from './base';
import type { TaskContext } from '../execute/context';
import { MainState } from '../engine/state';
import { MouseMoveBehavior, LeftClickBehavior } from '../behavior';
import { MousePositionManager } from '../engine/mouse-position-manager';
import { bvFromUrl, isVideoPageUrl } from '../../utils/bilibili-dom';

/**
 * 点赞任务：明确目的「给当前视频点赞」的行为集合。
 * 行为组合：拟人移动鼠标到点赞按钮 → 左键单击。
 */
export class LikeTask extends BaseTask {
  constructor(private selector: string = '.video-like, .video-like-btn, .like') {
    super('Like');
  }

  async preCheck(context: TaskContext): Promise<boolean> {
    if (!context.page) {
      return false;
    }
    // 点赞只在视频页有意义：非视频页（如动态页也有赞按钮）绝不执行，避免误点动态赞
    if (!isVideoPageUrl(context.page.url())) {
      return false;
    }
    // 只有当前页有「点赞」按钮才执行（否则跳过，避免在错误页面失败）
    const btn = await context.page.$(this.selector).catch(() => null);
    return !!btn;
  }

  async execute(context: TaskContext): Promise<TaskResult> {
    const page = context.page!;
    const steps: TaskResult[] = [];
    try {
      const btn = await page.$(this.selector).catch(() => null);
      if (!btn) {
        return { success: false, error: '未找到点赞按钮' };
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

      this.log(`👍 已点赞: ${bvFromUrl(page.url()) || '无BV'}「${(await page.title().catch(() => '')).slice(0, 20)}」`);
      return { success: true, data: { steps: steps.length }, nextState: MainState.CONTENT_CONSUMING };
    } catch (error) {
      return { success: false, error: `点赞失败: ${(error as Error).message}`, data: { steps: steps.length } };
    }
  }
}
