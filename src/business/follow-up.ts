/**
 * 主动关注 UP —— 独立于模拟任务流的一次性操作。
 *
 * 与「蹲饼目标对齐」（`target-sync.ts`，会在**主操作页**上导航、因此只能在启动阶段调用）不同，
 * 本模块的写操作全部发生在**调用方提供的独立页面**上：
 * - 内核 `followUp()` 会新开一个**临时标签页**完成关注，结束后立即关闭；
 * - 全程不改动主操作页（`ctx.page`）、不中断正在执行的任务、不进入任务队列（生成器与执行器都不参与）。
 */
import { createContext } from '../action/execute/context';
import { FollowTask } from '../action/task';
import { readFollowState } from './target-sync';
import type { Page } from 'puppeteer-core';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 关注目标 */
export interface FollowUpTarget {
  /** UP 的 uid（纯数字，必填） */
  uid: string;
  /** UP 名（可选，仅用于日志/展示） */
  name?: string;
}

/** 关注结果 */
export interface FollowUpResult {
  target: FollowUpTarget;
  /** followed=本来就是已关注；now-followed=本次点击了关注；failed=失败 */
  status: 'followed' | 'now-followed' | 'failed';
  /** 说明（成功/失败原因） */
  detail?: string;
}

/**
 * 在指定页面上关注某个 UP（幂等：已关注直接返回，不会重复点击）。
 *
 * @param page  执行本次操作的页面（内核传入临时标签页；宿主也可传入自己的页面）
 * @param target 关注目标（`uid` 必填）
 */
export async function followUpOnPage(page: Page, target: FollowUpTarget): Promise<FollowUpResult> {
  try {
    await page.goto(`https://space.bilibili.com/${target.uid}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await sleep(1500 + Math.random() * 1200);

    const before = await readFollowState(page);
    if (before === 'followed') {
      return { target, status: 'followed', detail: '已在关注列表（无需操作）' };
    }
    if (before === 'unknown') {
      return { target, status: 'failed', detail: '无法确认关注按钮状态（页面未就绪或选择器失效）' };
    }

    // 明确「未关注」→ 真实点击（复用 FollowTask，跑在临时上下文里，主上下文不受影响）
    const ok = await clickFollowOnPage(page);
    if (!ok) {
      return { target, status: 'failed', detail: '关注按钮点击失败（可能不在主页或按钮不可用）' };
    }
    await sleep(700);
    const after = await readFollowState(page);
    return {
      target,
      status: 'now-followed',
      detail: after === 'followed' ? '已关注成功' : '已点击关注（等待页面确认，可在关注列表复核）',
    };
  } catch (error) {
    return { target, status: 'failed', detail: `异常: ${(error as Error).message}` };
  }
}

/**
 * 在给定页面上执行一次「关注」点击。
 * 构造**临时 TaskContext**（只借用 browser + page），因此主上下文（ctx.page / 任务进度）完全不受影响。
 */
async function clickFollowOnPage(page: Page): Promise<boolean> {
  const tempCtx = createContext(page.browser(), 'FOLLOW_UP');
  tempCtx.page = page;
  const result = await new FollowTask().execute(tempCtx).catch(() => null);
  return !!result?.success;
}
