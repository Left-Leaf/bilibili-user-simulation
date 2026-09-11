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
import { extractUpProfileInfo } from '../utils/bilibili-dom';
import type { Page } from 'puppeteer-core';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 关注目标 */
export interface FollowUpTarget {
  /** UP 的 uid（纯数字，必填） */
  uid: string;
}

/**
 * 关注结果（平铺：uid / name 即本次关注到的 UP 身份）。
 * `uid`、`name` 均为**从 UP 主页实际读取**到的信息，读取失败时 uid 回退为传入值、name 为空串。
 */
export interface FollowUpResult {
  /** 实际 UP uid（纯数字） */
  uid: string;
  /** 实际 UP 名称（未读取到为空串） */
  name: string;
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
  // 实际 UP 信息（导航到主页后读取）；未取到时 uid 回退到输入值
  let profile: { uid: string; name: string } | null = null;
  const info = (): { uid: string; name: string } => ({
    uid: profile?.uid || target.uid,
    name: profile?.name ?? '',
  });

  try {
    await page.goto(`https://space.bilibili.com/${target.uid}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await sleep(1500 + Math.random() * 1200);
    profile = await extractUpProfileInfo(page).catch(() => null);

    const before = await readFollowState(page);
    if (before === 'followed') {
      return { ...info(), status: 'followed', detail: '已在关注列表（无需操作）' };
    }
    if (before === 'unknown') {
      return { ...info(), status: 'failed', detail: '无法确认关注按钮状态（页面未就绪或选择器失效）' };
    }

    // 明确「未关注」→ 真实点击（复用 FollowTask，跑在临时上下文里，主上下文不受影响）
    const clicked = await clickFollowOnPage(page);
    if (!clicked.ok) {
      return { ...info(), status: 'failed', detail: '关注按钮点击失败（可能不在主页或按钮不可用）' };
    }
    // 点击后补齐主页信息（点击前后页面不变，这里只是兜底）
    profile = { uid: clicked.uid || profile?.uid || '', name: clicked.name || profile?.name || '' };
    await sleep(700);
    const after = await readFollowState(page);
    return {
      ...info(),
      status: 'now-followed',
      detail: after === 'followed' ? '已关注成功' : '已点击关注（等待页面确认，可在关注列表复核）',
    };
  } catch (error) {
    return { ...info(), status: 'failed', detail: `异常: ${(error as Error).message}` };
  }
}

/**
 * 在给定页面上执行一次「关注」点击，并返回主页读取到的 UP 信息。
 * 构造**临时 TaskContext**（只借用 browser + page），因此主上下文（ctx.page / 任务进度）完全不受影响。
 */
async function clickFollowOnPage(page: Page): Promise<{ ok: boolean; uid: string; name: string }> {
  const tempCtx = createContext(page.browser(), 'FOLLOW_UP');
  tempCtx.page = page;
  const result = await new FollowTask().execute(tempCtx).catch(() => null);
  const data = (result?.data ?? {}) as { uid?: string; name?: string };
  return { ok: !!result?.success, uid: data.uid ?? '', name: data.name ?? '' };
}
