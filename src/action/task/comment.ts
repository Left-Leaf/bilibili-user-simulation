import { BaseTask, TaskResult } from './base';
import type { TaskContext } from '../execute/context';
import { MainState } from '../engine/state';
import { LeftClickBehavior, TypeBehavior, KeyPressBehavior, ScrollBehavior, SleepBehavior } from '../behavior';
import { MousePositionManager } from '../engine/mouse-position-manager';
import { extractVideoPageInfo, extractComments, isVideoPageUrl } from '../../utils/bilibili-dom';

/** 拟人评论语料池（通用短句） */
const COMMENT_POOL = [
  '这个视频讲得真清楚，学到了',
  '支持一下，内容不错',
  '很有意思，收藏了慢慢看',
  '路过支持一下',
  '看完觉得很有收获',
  '这个思路很受启发',
  '已经三连了，支持',
  '分享给朋友了，很有用',
];

/** 评论输入框选择器（B 站评论区需要滚动到评论区才渲染输入框） */
const BOX_SELECTOR = '.reply-box-textarea, textarea, .comment-input, .reply-content, .reply-box textarea, textarea.reply-box-textarea';

/**
 * 评论任务：明确目的「给当前视频发一条评论」的行为集合。
 * 行为组合：滚动到评论区 → 左键点击输入框聚焦 → 输入文字 → 按 Enter 提交。
 */
export class CommentTask extends BaseTask {
  constructor(
    private text?: string,
    private boxSelector: string = BOX_SELECTOR
  ) {
    super('Comment');
  }

  /** 滚动到评论区并查找输入框（最多滚动几次） */
  private async findCommentBox(context: TaskContext): Promise<NonNullable<TaskContext['page']> | null> {
    const page = context.page;
    if (!page) {
      return null;
    }
    // 先直接找
    const direct = await page.$(this.boxSelector).catch(() => null);
    if (direct) {
      return page;
    }
    // 滚动到评论区（视频页评论区在底部，通常滚动 1~2 屏后出现）
    for (let i = 0; i < 3; i++) {
      const { mousePos, distance } = await MousePositionManager.instance.browseScrollParams(page);
      await new ScrollBehavior(mousePos, distance).execute(context);
      await this.sleep(800 + Math.random() * 600);
      const box = await page.$(this.boxSelector).catch(() => null);
      if (box) {
        return page;
      }
    }
    return null;
  }

  async preCheck(context: TaskContext): Promise<boolean> {
    // 评论只在视频页有意义：非视频页（如动态页也有评论框）绝不执行
    if (!context.page || !isVideoPageUrl(context.page.url())) {
      return false;
    }
    // 滚动到评论区后能找到输入框才执行（否则跳过）
    const found = await this.findCommentBox(context);
    return !!found;
  }

  async execute(context: TaskContext): Promise<TaskResult> {
    const page = context.page!;
    const steps: TaskResult[] = [];
    try {
      // 评论前：记录当前视频信息（标题 / UP），确认上下文
      const info = await extractVideoPageInfo(page).catch(() => null);
      if (info?.title) {
        this.log(`📹 评论视频: 「${info.title.slice(0, 24)}」${info.upName ? `｜UP: ${info.upName}` : ''}`);
      }

      // 确保已滚动到评论区（preCheck 可能已滚过，execute 再确认一次）
      await this.findCommentBox(context);
      const box = await page.$(this.boxSelector).catch(() => null);
      if (!box) {
        return { success: false, error: '未找到评论输入框（评论区未加载或已折叠）' };
      }

      const text = this.text ?? COMMENT_POOL[Math.floor(Math.random() * COMMENT_POOL.length)];

      // 行为1：解析坐标 + 点击输入框聚焦
      const resolved = await MousePositionManager.instance.resolveTarget(page, this.boxSelector);
      if (!resolved.point && !resolved.alreadyClicked) {
        throw new Error('找不到评论输入框');
      }
      if (!resolved.alreadyClicked) {
        const cl = await new LeftClickBehavior(resolved.point!).execute(context);
        steps.push(cl);
        if (!cl.success) {
          throw new Error(cl.error);
        }
      }

      // 行为2：输入文字
      const ty = await new TypeBehavior(text).execute(context);
      steps.push(ty);
      if (!ty.success) {
        throw new Error(ty.error);
      }

      // 行为3：按 Enter 提交
      const kp = await new KeyPressBehavior('Enter').execute(context);
      steps.push(kp);
      if (!kp.success) {
        throw new Error(kp.error);
      }

      this.log(`💬 评论：${text}`);

      // 评论后：用 extractComments（穿透 Shadow DOM）验证评论是否发出。
      // 评论区异步加载，等待片刻再查；新评论可能未即时渲染（审核/缓存），尽力验证不判失败。
      await new SleepBehavior(1500 + Math.random() * 1500).execute(context);
      let verified = false;
      const comments = await extractComments(page, 20).catch(() => null);
      if (comments?.comments?.length) {
        const key = text.trim().slice(0, 8);
        const hit = key ? comments.comments.find((c) => c.text && c.text.includes(key)) : undefined;
        if (hit) {
          verified = true;
          this.log(`✅ 评论已发出: 「${hit.text.slice(0, 20)}」（${hit.author || '?'} ${hit.pubdate || '?'}）`);
        }
      }
      if (!verified) {
        this.log('⚠️ 未在前 20 条评论中找到刚发的评论（可能仍在加载或未成功发出）');
      }

      return { success: true, data: { text, verified, steps: steps.length }, nextState: MainState.CONTENT_CONSUMING };
    } catch (error) {
      return { success: false, error: `评论失败: ${(error as Error).message}`, data: { steps: steps.length } };
    }
  }
}
