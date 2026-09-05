/**
 * 蹲饼目标 UP 对齐（指向性动态获取的「预流程」）。
 *
 * 引擎在「加载人格 + 登录后、进入模拟行为之前」调用 `syncFetchTargets`：
 *   1. 获取当前账号的关注列表（best-effort，失败=未知）；
 *   2. 与 `persona.fetch_targets` 比较；
 *   3. 对缺失的目标 UP 进入其主页并真实点击「关注」。
 * 目的：让目标 UP 的动态进入「关注动态流」（feed/all），被动蹲饼据此定向捕获（见 passive-fetch 的
 * `setFetchTargets` 过滤）。
 *
 * ⚠️ 可靠性说明：B 站「个人空间 → 关注」页与 UP 主页「关注按钮」的 DOM 不在
 * docs/bilibili-elements.md 收录范围内（文档注明「UP 主页待补」），下方选择器为经验值，**需有头实测**。
 * 本模块全程降级：任何一步失败只记日志/报告，不影响后续目标与模拟行为；状态无法确认时**不点击**，
 * 避免误点成「取关」。
 */
import type { TaskContext } from '../action/execute/context';
import { extractLoginUser } from '../utils/bilibili-dom';
import { FollowTask } from '../action/task';

/** UP 主页「关注按钮」候选选择器（取第一个可见者判断状态/点击） */
const FOLLOW_SELECTORS = [
  '.header-info-ctnr .follow-btn',
  '.bili-header__info .follow-btn',
  '.space-header .follow-btn',
  '.default-btn.follow-btn',
  '.follow-btn',
];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 关注按钮状态：followed（已关注）/ not-followed（可关注）/ unknown（找不到/无法判定） */
type FollowState = 'followed' | 'not-followed' | 'unknown';

/** 判断当前页（应为目标 UP 主页）的关注状态：读「关注按钮」的 class / 文案 */
async function readFollowState(page: NonNullable<TaskContext['page']>): Promise<FollowState> {
  try {
    const s = (await page.evaluate((sels) => {
      for (const sel of sels) {
        for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) {
            continue; // 跳过不可见元素
          }
          const text = (el.textContent ?? '').trim();
          const cls = typeof el.className === 'string' ? el.className : '';
          if (/followed|已关注|已互关/i.test(cls) || /已关注|已互关/.test(text)) {
            return { followed: true };
          }
          if (/not-follow|未关注/i.test(cls) || /^关注| 关注/.test(text) || /^关注/.test(text)) {
            return { followed: false };
          }
        }
      }
      return { followed: null };
    }, FOLLOW_SELECTORS)) as { followed: boolean | null };
    if (s.followed === null) {
      return 'unknown';
    }
    return s.followed ? 'followed' : 'not-followed';
  } catch {
    return 'unknown';
  }
}

/**
 * 采集当前账号「关注列表」中的 UP uid：进入「个人空间→关注」页解析链接。
 * 解析不到（空/失败）返回 null = 未知，流程退化为「逐个进目标主页确认关注状态」。
 */
export async function fetchMyFollowingUids(
  page: NonNullable<TaskContext['page']>,
  ownUid: string
): Promise<Set<string> | null> {
  try {
    await page.goto(`https://space.bilibili.com/${ownUid}/fans/follow`, { waitUntil: 'domcontentloaded' });
    await sleep(1600);
    const mids = (await page.evaluate((selfUid) => {
      const set = new Set<string>();
      for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="space.bilibili.com/"]'))) {
        const m = /space\.bilibili\.com\/(\d+)/.exec(a.href || '');
        if (m && m[1] !== selfUid) {
          set.add(m[1]);
        }
      }
      return Array.from(set);
    }, ownUid)) as string[];
    return mids.length > 0 ? new Set(mids) : null;
  } catch {
    return null;
  }
}

/** 蹲饼目标 UP（与 persona.fetch_targets 元素一致） */
export interface TargetUp {
  uid?: string;
  name?: string;
}

/** 单个目标的处理结果 */
export interface FetchTargetReport {
  target: TargetUp;
  status: 'followed' | 'now-followed' | 'failed';
  detail?: string;
}

/**
 * 蹲饼目标对齐主流程：获取关注列表 → 与目标比较 → 关注缺失目标。
 * 返回每个目标的处理结果；绝不抛出（任何失败只记入 report + 日志，不阻塞模拟行为）。
 */
export async function syncFetchTargets(ctx: TaskContext, targets: TargetUp[]): Promise<FetchTargetReport[]> {
  const reports: FetchTargetReport[] = [];
  const page = ctx.page;
  if (!page || targets.length === 0) {
    return reports;
  }

  const login = await extractLoginUser(page).catch(() => null);
  const ownUid = login?.uid ?? '';
  const following = ownUid ? await fetchMyFollowingUids(page, ownUid).catch(() => null) : null;

  for (const t of targets) {
    const label = t.name || t.uid || '(未命名)';
    try {
      // 已在关注列表 → 无需处理
      if (t.uid && following?.has(String(t.uid))) {
        reports.push({ target: t, status: 'followed', detail: '已在关注列表' });
        continue;
      }
      if (!t.uid) {
        reports.push({ target: t, status: 'failed', detail: '缺 uid，暂不支持按名字搜索关注' });
        continue;
      }

      // 进入目标 UP 主页
      await page.goto(`https://space.bilibili.com/${t.uid}`, { waitUntil: 'domcontentloaded' });
      await sleep(1500 + Math.random() * 1000);

      const state = await readFollowState(page);
      if (state === 'followed') {
        reports.push({ target: t, status: 'followed', detail: '主页显示已关注' });
        continue;
      }
      if (state === 'unknown') {
        reports.push({ target: t, status: 'failed', detail: '无法确认关注按钮状态（选择器待实测）' });
        continue;
      }

      // 明确「未关注」→ 真实点击关注（复用 FollowTask；失败则降级记录）
      const r = await new FollowTask().execute(ctx).catch(() => null);
      if (r?.success) {
        await sleep(700);
        const after = await readFollowState(page);
        reports.push({
          target: t,
          status: after === 'followed' ? 'now-followed' : 'now-followed',
          detail: after === 'followed' ? '已关注成功' : '已点击关注（等待页面确认，下轮对齐会复核）',
        });
        void label;
      } else {
        reports.push({ target: t, status: 'failed', detail: r?.error ?? '关注按钮不可用/不在主页' });
      }
    } catch (error) {
      reports.push({ target: t, status: 'failed', detail: `异常: ${(error as Error).message}` });
    }
  }

  // 对齐结束回到主页，保持后续流程起始页干净
  await page.goto('https://www.bilibili.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  return reports;
}
