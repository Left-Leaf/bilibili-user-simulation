/**
 * B 站 DOM 提取工具：供各任务在日志中描述「当前页面状态」。
 * 只做轻量 DOM 读取，不发起网络请求；提取失败一律返回空（不影响任务执行）。
 */
import type { Page, ElementHandle } from 'puppeteer-core';

/** 登录用户信息（B 站右上角头像区 / cookie） */
export interface LoginUser {
  /** 昵称（可能为空，B 站未展开时只显示头像） */
  name: string;
  /** UID（从头像链接或 DedeUserID cookie 提取） */
  uid: string;
}

/**
 * 提取当前登录用户。已登录返回 { name, uid }，未登录返回 null。
 * 提取不到用户名时退化为仅 UID；两者都无 → null。
 */
export async function extractLoginUser(page: Page): Promise<LoginUser | null> {
  try {
    const info = await page.evaluate(() => {
      const pick = (sels: string[]): string => {
        for (const s of sels) {
          const el = document.querySelector<HTMLElement>(s);
          const t = el?.textContent?.trim();
          if (t) {
            return t;
          }
        }
        return '';
      };
      const uidFromHref = (href: string | undefined): string => href?.match(/space\.bilibili\.com\/(\d+)/)?.[1] ?? '';
      // 头像区链接 → UID
      const wrap = document.querySelector('.header-avatar-wrap, .header-info-avatar-wrap, .header-avatar, .bili-header__p-avatar');
      const href = wrap?.querySelector('a')?.getAttribute('href') ?? undefined;
      const uid = uidFromHref(href) || (document.cookie.match(/DedeUserID=(\d+)/)?.[1] ?? '');
      const name = pick([
        '.header-entry-username',
        '.header-nickname',
        '.header-profile-name',
        '.bili-header__p-username',
        '.header-info-name',
      ]);
      return { uid, name };
    });
    if (!info) {
      return null;
    }
    return info.uid || info.name ? { uid: info.uid ?? '', name: info.name ?? '' } : null;
  } catch {
    return null;
  }
}

/** 从 URL 提取 BV 号（如 /video/BV1xx...），无则返回空 */
export function bvFromUrl(url: string): string {
  return url.match(/\/video\/(BV\w+)/)?.[1] ?? '';
}

/**
 * 是否为 B 站「视频播放页」：
 * - 普通视频：/video/BV...（如 www.bilibili.com/video/BV1xx...）
 * - TV剧/番剧（bangumi 播放页）：/bangumi/play/ep...（单集）或 /bangumi/play/ss...（番剧）。
 *   ⚠️ bangumi 的特殊性：外部入口可能是正常 BV 链接，但点击进入后会 SPA 跳转到
 *   /bangumi/play/ep（如纪录片/影视剧），若不识别会被误判「未进入视频页」且关闭时残留。
 */
export function isVideoPageUrl(url: string): boolean {
  return /\/video\/BV\w+/.test(url) || /\/bangumi\/play\/(ep|ss)\d+/.test(url);
}

/** 是否为 B 站「动态页」（t.bilibili.com） */
export function isDynamicPageUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === 't.bilibili.com' || u.hostname.endsWith('.t.bilibili.com');
  } catch {
    return false;
  }
}

/**
 * 是否为 B 站「主页」（主站根路径 / 或 /index.html）。
 * 严格限定主站域名（bilibili.com / www.bilibili.com / m.bilibili.com），
 * 避免把 t.bilibili.com/（动态页）等子站根路径误判为主页。
 */
export function isHomePageUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname;
    if (host !== 'bilibili.com' && host !== 'www.bilibili.com' && host !== 'm.bilibili.com') {
      return false;
    }
    return u.pathname === '/' || u.pathname === '' || u.pathname === '/index.html';
  } catch {
    return false;
  }
}

/** 是否为 B 站「用户页」（UP 主页：space.bilibili.com/{uid}） */
export function isUserPageUrl(url: string): boolean {
  try {
    return new URL(url).hostname.includes('space.bilibili.com');
  } catch {
    return false;
  }
}

/** 入口类型：视频 / 直播 / 其他 */
export type EntryType = 'video' | 'live' | 'other';

/**
 * 判断一个入口 href 是视频还是直播，避免错误跳转（把直播当视频点开 / 点到直播）。
 *
 * 最大区别（决定性，只需看 URL）：
 *  - 视频入口含 /video/BV...（如 www.bilibili.com/video/BV1u1M26qED6）
 *  - 直播入口域名是 live.bilibili.com（如 live.bilibili.com/1921272912）
 *
 * 辅助 DOM 特征（视频卡片有 .bili-video-card__stats__duration 播放时长、直播卡片有「直播中」标记），
 * 但 URL 是最可靠最根本的区分，无需依赖 DOM 结构。
 */
export function classifyEntry(href: string): EntryType {
  if (/\/video\/BV\w+/.test(href)) {
    return 'video';
  }
  if (href.includes('live.bilibili.com')) {
    return 'live';
  }
  return 'other';
}

/** 是否为视频入口 */
export function isVideoEntry(href: string): boolean {
  return classifyEntry(href) === 'video';
}

/** 视频入口信息（跨页面统一：主页/搜索/动态） */
export interface VideoEntry {
  title: string;
  href: string;
  bvid: string;
  /** 播放时长（mm:ss，来自 .bili-video-card__stats__duration） */
  duration?: string;
  author?: string;
  authorUid?: string;
}

/**
 * 收集当前页所有「可见的视频入口」（按页面类型分别定位，供各任务统一使用）：
 * - 动态页（t.bilibili.com）：动态内嵌视频卡片 .bili-dyn-card-video / .bili-dyn-card-video__title
 * - 主页 / 搜索页：推荐流/搜索卡片 .bili-video-card__info--tit / .bili-video-card__title（辅以 title 属性/埋点）
 * 统一排除：直播入口（live.bilibili.com）、「稍后再看」按钮、封面等非标题噪音。
 * 只做轻量 DOM 读取，不发起网络请求；提取失败返回 []。
 */
export async function collectVideoEntries(page: Page, limit = 40): Promise<VideoEntry[]> {
  return page
    .evaluate((n) => {
      // 按页面类型分别定位（动态页 vs 主页/搜索）
      const isDynamicPage = location.hostname === 't.bilibili.com' || location.hostname.endsWith('.t.bilibili.com');
      // 中间内容区容器（按页面类型）
      const scopes = isDynamicPage
        ? Array.from(document.querySelectorAll('.bili-dyn-content, .bili-dyn-item__main'))
        : Array.from(document.querySelectorAll('main, .container, #app'));
      const root = scopes.find((s) => s.querySelector('a[href*="/video/BV"]')) ?? document;
      // 标题元素（按页面类型）：动态页标题在 .bili-dyn-card-video__title 子元素（a 自身是容器，不能算标题）；
      // 主页/搜索标题是 .bili-video-card__info--tit / .bili-video-card__title
      const titleBox = isDynamicPage ? '.bili-dyn-card-video__title' : '.bili-video-card__info--tit, .bili-video-card__title';

      const infoBox = isDynamicPage ? '.bili-dyn-item__main, .bili-dyn-card-video__info' : '.bili-video-card__info';
      // 同 bvid 可能有多个链接（封面图 a / 标题 a / 「稍后再看」按钮），按标题质量择优，保留 DOM 顺序
      const best = new Map<string, { score: number; seq: number; entry: VideoEntry }>();
      let seq = 0;
      const links = Array.from(root.querySelectorAll('a[href*="/video/BV"]'));
      for (const a of links) {
        const anchor = a as HTMLAnchorElement;
        const href = anchor.href || '';
        // 只接受视频入口（排除直播等）
        if (!/\/video\/BV\w+/.test(href)) {
          continue;
        }
        const bvid = href.match(/\/video\/(BV\w+)/)?.[1] || '';
        if (!bvid) {
          continue;
        }
        // 可见性
        const style = getComputedStyle(a);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
          continue;
        }
        // 视频页右侧推荐流卡片（.video-page-card-small）：标题在 a 内 p.title（title 属性在 p 上，不在 a 上）
        const rcmdCard = a.closest('.video-page-card-small');
        // 标题质量：title 属性 > 右侧推荐流标题 > 标题元素（自身/后代） > 信息区文本
        // 封面链接（包裹图片、无 title、非标题元素、不在信息区）→ 剔除，由标题链接收集
        const titleAttr = (anchor.getAttribute('title') || '').trim();
        const rcmdTitle = rcmdCard ? (a.querySelector('p.title')?.textContent ?? '').trim() : '';
        const hasTitleEl = a.matches(titleBox) || !!a.querySelector(titleBox);
        const inInfoBox = !!a.closest(infoBox);
        const isCover = !!a.querySelector('img, .bili-video-card__image') && !titleAttr && !rcmdTitle && !hasTitleEl && !inInfoBox;
        if (isCover) {
          continue; // 搜索页/主页封面图 a：非标题卡片噪音
        }
        // 标题文本：title 属性 > 右侧推荐流标题 > 标题元素文本 > 信息区文本
        let title = titleAttr || rcmdTitle;
        if (!title && hasTitleEl) {
          const titleEl = a.matches(titleBox) ? a : a.querySelector(titleBox);
          title = (titleEl?.textContent ?? '').trim();
        }
        if (!title && inInfoBox) {
          title = (anchor.textContent || '').trim();
        }
        if (!title) {
          continue; // 「稍后再看」按钮等无标题噪音
        }
        const score = titleAttr ? 3 : rcmdTitle ? 2 : hasTitleEl ? 2 : 1;
        const existing = best.get(bvid);
        if (existing && existing.score >= score) {
          continue; // 同 bvid 保留标题质量更高的链接
        }
        const firstSeq = existing?.seq ?? seq++;
        // 作者 / 时长（基于外层卡片，不依赖是封面还是标题链接）
        const parent = anchor.closest('.bili-video-card, .bili-dyn-card-video, .video-page-card-small');
        const dynItem = anchor.closest('.bili-dyn-item');
        const ownerLink = parent?.querySelector('a[href*="space.bilibili.com"]');
        const author =
          parent?.querySelector('.bili-video-card__info--author')?.textContent?.trim() ||
          parent?.querySelector('.upname .name')?.textContent?.trim() ||
          dynItem?.querySelector('.bili-dyn-item__name, .bili-dyn-title__text')?.textContent?.trim() ||
          '';
        // 时长（按场景）：视频页右侧推荐 .pic .duration；动态页 .duration-time；主页/搜索 .bili-video-card__stats__duration
        const duration = rcmdCard
          ? parent?.querySelector('.pic .duration')?.textContent?.trim() || ''
          : parent?.querySelector(isDynamicPage ? '.duration-time' : '.bili-video-card__stats__duration')?.textContent?.trim() || '';
        best.set(bvid, {
          score,
          seq: firstSeq,
          entry: {
            title,
            href,
            bvid,
            duration,
            author,
            authorUid: (ownerLink?.getAttribute('href') || '').match(/space\.bilibili\.com\/(\d+)/)?.[1] || '',
          },
        });
      }
      // 按 DOM 出现顺序取前 limit
      const out = Array.from(best.values())
        .sort((x, y) => x.seq - y.seq)
        .slice(0, n)
        .map((v) => v.entry);
      return out;
    }, limit)
    .catch(() => []);
}

/** 随机选一个可见视频入口（真人不会总点第一个） */
export async function pickVideoEntry(page: Page): Promise<VideoEntry | null> {
  const entries = await collectVideoEntries(page);
  return entries.length > 0 ? entries[Math.floor(Math.random() * entries.length)] : null;
}

/**
 * 按 bvid 精确定位「标题卡片」元素（供点击）。
 * 同一 bvid 可能有多个链接（如「稍后再看」按钮），须按页面类型排除非标题卡片。
 */
export async function findVideoEntryHandle(page: Page, bvid: string): Promise<ElementHandle<Element> | null> {
  const handles = (await page.$$(`a[href*="/video/${bvid}"]`).catch(() => [])) as ElementHandle<Element>[];
  for (const h of handles) {
    const info = await h
      .evaluate((a) => {
        // 按页面类型分别判断标题卡片
        const isDynamicPage = location.hostname === 't.bilibili.com' || location.hostname.endsWith('.t.bilibili.com');
        const titleBox = isDynamicPage ? '.bili-dyn-card-video__title' : '.bili-video-card__info--tit, .bili-video-card__title';
        const text = (a.textContent ?? '').trim();
        const style = getComputedStyle(a);
        const r = a.getBoundingClientRect();
        // 视频页右侧推荐流卡片：标题在 a 内 p.title（title 属性在 p 上，不在 a 上；无埋点）
        const rcmdCard = a.closest('.video-page-card-small');
        const rcmdTitle = rcmdCard ? (a.querySelector('p.title')?.textContent ?? '').trim() : '';
        // 标题卡片判定（按页面类型）：title 属性 ∨ 右侧推荐流标题 ∨ 标题元素(自身/后代) ∨ 信息区 ∨ 埋点；封面链接剔除
        const titleAttr = ((a as HTMLAnchorElement).getAttribute('title') ?? '').trim();
        const hasTitleEl = a.matches(titleBox) || !!a.querySelector(titleBox);
        const infoBox = isDynamicPage ? '.bili-dyn-item__main, .bili-dyn-card-video__info' : '.bili-video-card__info';
        const inInfoBox = !!a.closest(infoBox);
        const hasBiliTrack = !!a.getAttribute('data-spmid') || !!a.getAttribute('data-mod') || !!a.getAttribute('data-idx');
        const isCover = !!a.querySelector('img, .bili-video-card__image') && !titleAttr && !rcmdTitle && !hasTitleEl && !inInfoBox;
        return {
          text,
          isTitleCard: !isCover && (!!titleAttr || !!rcmdTitle || hasTitleEl || inInfoBox || hasBiliTrack),
          visible: style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && r.width > 0 && r.height > 0,
        };
      })
      .catch(() => null);
    if (info && info.visible && info.isTitleCard && info.text.length >= 2) {
      return h;
    }
  }
  return null;
}

/**
 * 找视频卡片的**封面图** handle（供点击）。
 * 封面区域大、命中率高，且不会误点到同卡片的 UP 主页入口（space.bilibili.com 链接）。
 * 从所有指向该 bvid 的链接中，取含「可见大图（宽≥80 高≥45）」的封面 img。
 */
export async function findVideoCoverHandle(page: Page, bvid: string): Promise<ElementHandle<Element> | null> {
  const handles = (await page.$$(`a[href*="/video/${bvid}"]`).catch(() => [])) as ElementHandle<Element>[];
  for (const h of handles) {
    const hasCover = await h
      .evaluate((a) => {
        const img = a.querySelector('img');
        if (!img) {
          return false;
        }
        const r = img.getBoundingClientRect();
        const s = getComputedStyle(img);
        return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) !== 0 && r.width >= 80 && r.height >= 45;
      })
      .catch(() => false);
    if (!hasCover) {
      continue;
    }
    const img = await h.$('img').catch(() => null);
    if (img) {
      return img;
    }
  }
  return null;
}

/** 毫秒级等待（本文件的工具都是纯 DOM/CDP 辅助，不引入外部依赖） */
const waitMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 播放器是否**铺满视口**（B 站「网页全屏」或原生全屏）。
 *
 * 判定用「播放器容器铺满视口」而不是 B 站会变的 class 名：铺满时右侧推荐栏虽然还在 DOM 里、
 * 坐标也能算出来，但被播放器盖住 → 对它点击会**落空**（实测：全屏观看之后的连刷 3/4 失败）。
 */
export async function isPlayerFullscreen(page: Page): Promise<boolean> {
  return page
    .evaluate(() => {
      if (document.fullscreenElement) {
        return true; // 原生全屏（按 f 触发）
      }
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      // ⚠️ 必须**逐个**判定：实测全屏时 `#bilibili-player` 尺寸不变（1354x818），
      //    只有 `.bpx-player-container` 铺满视口（1920x1080）——
      //    用 `querySelector('#bilibili-player, .bpx-player-container, ...')` 只会返回
      //    文档里第一个匹配的 `#bilibili-player` → 一旦没有 `fullscreenElement`（网页全屏）就会**漏判**。
      return ['#bilibili-player', '.bpx-player-container', '.bpx-player-primary-area'].some((sel) => {
        const r = document.querySelector(sel)?.getBoundingClientRect();
        return !!r && r.width >= vw * 0.95 && r.height >= vh * 0.9;
      });
    })
    .catch(() => false);
}

/**
 * 退出播放器全屏；返回是否已退出（本来就不在全屏也返回 true）。
 *
 * ⚠️ **绝不能「退完再按 f」**：`f` 是**切换键**，会刚退出又把全屏按回去。
 * （实测：旧实现每轮「`exitFullscreen()` → 按 f」→ 退出后立刻重新全屏 →
 *   两轮都复验为全屏 → 返回 false，并把播放器**留在全屏**里；
 *   随后 OpenVideo 连刷点击落在被盖住的推荐栏上 → 24s 后失败。）
 *
 * 正确顺序（实测校准）：
 * 1. **原生全屏**（`document.fullscreenElement` 有值）→ 只走标准 API `exitFullscreen()`，
 *    复验已退出就 **立即 return**（不再碰 `f`）；没退掉才进下一轮重试。
 * 2. **非原生**（网页全屏 / 未知铺满）→ B 站播放器**没有全屏按钮**（实测），只能按 `f`；
 *    按完必须复验：若被切成了原生全屏，下一轮走 ① 用标准 API 退掉。
 * 3. **后台标签**（页面已不可见）：Chrome 会在标签失活时自动解除全屏，且此时
 *    `exitFullscreen()` 会抛 `Document not active`（实测）→ 只需不动即可。
 */
export async function exitPlayerFullscreen(page: Page): Promise<boolean> {
  for (let round = 0; round < 2; round++) {
    if (!(await isPlayerFullscreen(page))) {
      return true;
    }
    // ① 原生全屏：标准 API 是唯一可靠手段（退成功就结束，**绝不**再按 f）
    const nativeExited = await page
      .evaluate(async () => {
        if (!document.fullscreenElement) {
          return false;
        }
        try {
          await document.exitFullscreen();
          return true;
        } catch {
          return false; // 如后台页：Document not active
        }
      })
      .catch(() => false);
    if (nativeExited) {
      await waitMs(600);
      if (!(await isPlayerFullscreen(page))) {
        return true;
      }
      continue; // 未退掉（极少见）→ 下一轮重试
    }

    // ② 非原生（网页全屏 / 未知铺满）：有退出按钮就点，否则按 f（唯一的切换手段）
    const btn = (await page.$(EXIT_FULLSCREEN_SELECTOR).catch(() => null)) as ElementHandle<Element> | null;
    if (btn) {
      await btn.click().catch(() => {});
    } else {
      await page.keyboard.press('f').catch(() => {});
    }
    await waitMs(600);
    if (!(await isPlayerFullscreen(page))) {
      return true;
    }
  }
  return !(await isPlayerFullscreen(page));
}

/** 「退出全屏」按钮选择器（B 站全屏时同一按钮类名带 -exit 后缀） */
const EXIT_FULLSCREEN_SELECTOR = '.bpx-player-ctrl-fullscreen-exit, .bpx-player-ctrl-web-fullscreen-exit';

/**
 * 收集目标视频在当前页的**所有跳转链接 <a> href**（供生成器定位阶段封装）。
 * 一个视频卡片可能有多个指向它的 <a>（封面/标题等），全部收集，执行期据此确认跳转链接。
 */
export async function collectVideoTargetLinks(page: Page, bvid: string): Promise<{ hrefs: string[] }> {
  const handles = (await page.$$(`a[href*="/video/${bvid}"]`).catch(() => [])) as ElementHandle<Element>[];
  const hrefs = new Set<string>();
  for (const h of handles) {
    const href = await h.evaluate((a) => (a as HTMLAnchorElement).href).catch(() => '');
    if (href) {
      hrefs.add(href);
    }
  }
  return { hrefs: [...hrefs] };
}

/**
 * 找当前页「可见」的动态入口（顶部导航「动态」，指向 t.bilibili.com）。
 * 精确校验 href 必须指向动态页域名（排除 account/space 等误匹配入口），返回可见入口 handle。
 */
export async function findDynamicEntryHandle(page: Page): Promise<ElementHandle<Element> | null> {
  const selector = 'a.right-entry__outside[href*="t.bilibili.com"], a[href*="//t.bilibili.com"], a[href*="https://t.bilibili.com"]';
  const handles = (await page.$$(selector).catch(() => [])) as ElementHandle<Element>[];
  for (const h of handles) {
    const visible = await h
      .evaluate((a) => {
        const style = getComputedStyle(a);
        const r = a.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && r.width > 0 && r.height > 0;
      })
      .catch(() => false);
    if (!visible) {
      continue;
    }
    const href = await h.evaluate((a) => (a as HTMLAnchorElement).href ?? '').catch(() => '');
    if (href.includes('t.bilibili.com') && !href.includes('account.')) {
      return h;
    }
  }
  return null;
}

/** UP 主页入口（space.bilibili.com/{uid} 链接） */
export interface ProfileEntry {
  /** UP 的 UID */
  uid: string;
  /** UP 名字（尽力提取：作者元素 / title / 文本） */
  name: string;
  /** 入口链接 */
  href: string;
}

/**
 * 统计当前页全部可见的 UP 主页入口（`a[href*="space.bilibili.com/"]`，按 uid 去重）。
 * 供 BrowseProfile 抉择目标（同 OpenVideo 的 collectVideoEntries 思路）。
 * 只做轻量 DOM 读取；提取失败返回 []。
 */
export async function collectProfileEntries(page: Page, limit = 20): Promise<ProfileEntry[]> {
  try {
    return await page.evaluate((n) => {
      const out: ProfileEntry[] = [];
      const seen = new Set<string>();
      const anchors = document.querySelectorAll('a[href*="space.bilibili.com/"]');
      for (const a of anchors) {
        const href = (a as HTMLAnchorElement).href;
        const uid = href.match(/space\.bilibili\.com\/(\d+)/)?.[1];
        if (!uid || seen.has(uid)) {
          continue;
        }
        seen.add(uid);
        const name =
          a.querySelector('.bili-video-card__info--author, .up-name')?.textContent?.trim() ||
          (a as HTMLAnchorElement).getAttribute('title')?.trim() ||
          (a as HTMLAnchorElement).textContent?.trim() ||
          '';
        out.push({ uid, name: name.slice(0, 40), href });
        if (out.length >= n) {
          break;
        }
      }
      return out;
    }, limit);
  } catch {
    return [];
  }
}

/**
 * 找当前页目标 UP 主页入口（space.bilibili.com）：
 * 1) 按 upName 匹配——优先搜索页视频卡片的作者入口 `.bili-video-card__info--owner`
 *   （作者名精确取自 `.bili-video-card__info--author`，避免 textContent 混入日期后缀），
 *   其次回退到任意 `space.bilibili.com` 链接文本匹配；
 * 2) 按 uid 精确匹配 `a[href*="space.bilibili.com/{uid}"]`。
 * 找不到返回 null（由生成器编排搜索兜底）。
 */
export async function findProfileEntryHandle(page: Page, opts: { upName?: string; uid?: string }): Promise<ElementHandle<Element> | null> {
  const name = (opts.upName ?? '').trim();
  const uid = (opts.uid ?? '').trim();

  // 1) 按 UP 名字匹配
  if (name) {
    // 1a) 搜索页视频卡片作者入口 .bili-video-card__info--owner（作者名在 .bili-video-card__info--author span）
    const ownerHandles = (await page.$$('a.bili-video-card__info--owner').catch(() => [])) as ElementHandle<Element>[];
    for (const h of ownerHandles) {
      const authorName = await h
        .evaluate((a) => (a.querySelector('.bili-video-card__info--author')?.textContent ?? '').trim())
        .catch(() => '');
      if (authorName && (authorName === name || authorName.includes(name))) {
        return h;
      }
    }
    // 1b) 回退：任意 space.bilibili.com 链接（UP 卡片 / 其它页面）
    const handles = (await page.$$('a[href*="space.bilibili.com"]').catch(() => [])) as ElementHandle<Element>[];
    for (const h of handles) {
      const info = await h
        .evaluate((a, n) => {
          const text = ((a as HTMLAnchorElement).textContent ?? '').trim();
          const title = (a as HTMLAnchorElement).getAttribute('title') ?? '';
          return text.includes(n) || title.includes(n);
        }, name)
        .catch(() => false);
      if (info) {
        return h;
      }
    }
  }

  // 2) 按 UID 精确匹配：a[href*="space.bilibili.com/{uid}"]
  if (uid) {
    const handle = await page.$(`a[href*="space.bilibili.com/${uid}"]`).catch(() => null);
    if (handle) {
      return handle as ElementHandle<Element>;
    }
  }
  return null;
}

/** 单条动态（动态页 t.bilibili.com 条目） */
export interface DynamicItem {
  author: string;
  text: string;
}

/**
 * 提取动态页（t.bilibili.com）当前可见的动态列表（前 limit 条）。
 * 选择器：.bili-dyn-item（单条）、作者名、正文。
 * 注意：正文只取「动态文案」（.bili-dyn-content__orig__desc .bili-rich-text__content），
 * 不能用 .bili-dyn-content 容器——容器内含视频卡片，textContent 会混入视频标题/时长。
 */
export async function extractDynamics(page: Page, limit = 10): Promise<DynamicItem[]> {
  try {
    return await page.evaluate((n) => {
      const out: DynamicItem[] = [];
      const items = document.querySelectorAll('.bili-dyn-item');
      for (const item of items) {
        const author = item.querySelector('.bili-dyn-title__text, .bili-dyn-item__name')?.textContent?.trim() ?? '';
        const text =
          item.querySelector('.bili-dyn-content__orig__desc .bili-rich-text__content, .bili-dyn-content__text')?.textContent?.trim() ?? '';
        if (author || text) {
          out.push({ author, text: text.slice(0, 60) });
        }
        if (out.length >= n) {
          break;
        }
      }
      return out;
    }, limit);
  } catch {
    return [];
  }
}

/** 视频播放页信息（www.bilibili.com/video/BV... 左侧信息区 + 右侧 UP 信息） */
export interface VideoPageInfo {
  /** 标题（h1.video-title） */
  title: string;
  /** 总时长（秒，读 #bilibili-player video.duration；未加载完成时为 0） */
  duration: number;
  /** 总时长显示文本（.bpx-player-ctrl-time-duration，mm:ss） */
  durationText: string;
  /** 当前播放进度（.bpx-player-ctrl-time-current，mm:ss） */
  currentTimeText: string;
  /** 播放量（.view.item .view-text，如 3.3万） */
  viewCount: string;
  /** 弹幕数（.dm.item .dm-text） */
  danmakuCount: string;
  /** 发布时间（.pubdate-ip.item .pubdate-ip-text） */
  pubDate: string;
  /** 点赞 / 投币 / 收藏（video-toolbar） */
  likeCount: string;
  coinCount: string;
  favCount: string;
  /** 简介（.video-desc-container .desc-info-text） */
  desc: string;
  /** 标签（.video-tag-container .tag-link） */
  tags: string[];
  /** UP 名 / UID（右侧 .up-name，href → space.bilibili.com/{uid}） */
  upName: string;
  upUid: string;
}

/**
 * 提取视频播放页信息（标题 / 时长 / 统计 / 点赞投币收藏 / 简介标签 / UP 信息）。
 * 只读 DOM，不发起网络请求；非视频页或提取失败返回 null。
 */
export async function extractVideoPageInfo(page: Page): Promise<VideoPageInfo | null> {
  try {
    return await page.evaluate(() => {
      const text = (sel: string): string => document.querySelector(sel)?.textContent?.trim() ?? '';
      const video = document.querySelector<HTMLVideoElement>('#bilibili-player video');
      const upNameLink = document.querySelector<HTMLAnchorElement>('.up-name');
      return {
        title: text('h1.video-title'),
        duration: video && isFinite(video.duration) ? video.duration : 0,
        durationText: text('.bpx-player-ctrl-time-duration'),
        currentTimeText: text('.bpx-player-ctrl-time-current'),
        viewCount: text('.view.item .view-text'),
        danmakuCount: text('.dm.item .dm-text'),
        pubDate: text('.pubdate-ip.item .pubdate-ip-text'),
        likeCount: text('.video-like .video-like-info'),
        coinCount: text('.video-coin .video-coin-info'),
        favCount: text('.video-fav .video-fav-info'),
        desc: text('.video-desc-container .desc-info-text'),
        tags: Array.from(document.querySelectorAll('.video-tag-container .tag-link')).map((el) => el.textContent?.trim() ?? ''),
        upName: upNameLink?.textContent?.trim() ?? '',
        upUid: upNameLink?.href.match(/space\.bilibili\.com\/(\d+)/)?.[1] ?? '',
      };
    });
  } catch {
    return null;
  }
}

/** UP 主页信息（space.bilibili.com/{uid}） */
export interface UpProfileInfo {
  /** UP 的 uid（纯数字；优先取 URL，兜底读页内链接） */
  uid: string;
  /** UP 名（未取到为空串） */
  name: string;
}

/** UP 名候选选择器：新版空间页 #h-name / .nickname；兼容旧版与视频页 .up-name */
const UP_NAME_SELECTORS = ['#h-name', '.nickname', 'h1.nickname', '.user-name', '.up-name'];

/**
 * 提取 UP 主页（space.bilibili.com）的 uid 与名称。
 * 只读 DOM、不发网络请求；两者都未取到返回 null。
 *
 * 名称取值链：`#h-name` / `.nickname` / … → **页面标题**（「XXX的个人空间…」）兜底。
 * `waitMs > 0` 时，若首次没读到名称会 `waitForSelector` 等昵称元素渲染后重读（后台标签页
 * 渲染/懒加载慢，仅靠固定 sleep 容易读到空串）。
 */
export async function extractUpProfileInfo(
  page: Page,
  options: { waitMs?: number } = {}
): Promise<UpProfileInfo | null> {
  const waitMs = options.waitMs ?? 3000;
  const read = (): Promise<UpProfileInfo> =>
    page.evaluate((nameSelectors) => {
      const pickText = (sels: string[]): string => {
        for (const sel of sels) {
          const t = document.querySelector(sel)?.textContent?.trim();
          if (t) {
            return t;
          }
        }
        return '';
      };
      const uidFromUrl = location.href.match(/space\.bilibili\.com\/(\d+)/)?.[1] ?? '';
      const uidFromLink =
        Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="space.bilibili.com/"]'))
          .map((a) => a.href.match(/space\.bilibili\.com\/(\d+)/)?.[1] ?? '')
          .find((v) => !!v) ?? '';
      // 标题兜底：「明日方舟的个人空间-哔哩哔哩视频」/「xxx的个人空间_哔哩哔哩_bilibili」
      const nameFromTitle = document.title.match(/^\s*(.+?)的个人空间/)?.[1]?.trim() ?? '';
      return {
        uid: uidFromUrl || uidFromLink,
        name: pickText(nameSelectors) || nameFromTitle,
      };
    }, UP_NAME_SELECTORS);

  try {
    let info = await read();

    // 名字没读到（多为后台标签页还没渲染出昵称）→ 等元素出现后重读一次
    if (!info.name && waitMs > 0) {
      await page.waitForSelector(UP_NAME_SELECTORS.join(', '), { timeout: waitMs }).catch(() => null);
      const retry = await read().catch(() => null);
      if (retry?.name) {
        info = retry;
      }
    }

    if (!info.uid && !info.name) {
      return null;
    }
    return info;
  } catch {
    return null;
  }
}

/** 当前播放器状态（视频页 #bilibili-player video）。用于「视频提前播完自动连播」时修正剩余时间。 */
export interface PlayerPlaybackState {
  /** 是否存在播放器 video 元素 */
  hasPlayer: boolean;
  /** 当前播放视频总时长（秒，未加载完为 0） */
  duration: number;
  /** 当前播放进度（秒） */
  currentTime: number;
  /** 当前播放视频剩余 = duration - currentTime（秒，duration 未就绪时为 0） */
  remaining: number;
  /** 是否暂停 */
  paused: boolean;
}

/**
 * 读取当前播放器状态（时长 / 进度 / 剩余 / 暂停）。
 * 视频提前播完自动连播到下一个视频时：duration 变为新视频总长、currentTime 从 0 重新计时，
 * 用返回值的 remaining 修正计划剩余时间。提取失败返回 null。
 */
export async function getPlayerPlaybackState(page: Page): Promise<PlayerPlaybackState | null> {
  try {
    return await page.evaluate(() => {
      const video = document.querySelector<HTMLVideoElement>('#bilibili-player video');
      if (!video) {
        return { hasPlayer: false, duration: 0, currentTime: 0, remaining: 0, paused: true };
      }
      const duration = isFinite(video.duration) ? video.duration : 0;
      const currentTime = isFinite(video.currentTime) ? video.currentTime : 0;
      return {
        hasPlayer: true,
        duration,
        currentTime,
        remaining: duration > 0 ? Math.max(0, duration - currentTime) : 0,
        paused: video.paused,
      };
    });
  } catch {
    return null;
  }
}

/** 自动连播开关状态（视频页底部控制条 .continuous-btn .switch-btn） */
export interface ContinuousPlaybackState {
  /** 是否存在自动连播开关元素 */
  exists: boolean;
  /** 开关是否处于开启状态（.switch-btn 带 on class） */
  on: boolean;
}

/**
 * 读取「自动连播」开关状态。
 * B 站视频页底部控制条的自动连播开关结构：
 * <div class="continuous-btn"><div class="txt">自动连播</div>
 *   <div class="switch-btn on"><div class="switch-block"></div></div></div>
 * 开启时 .switch-btn 带 on class。找不到开关返回 null。
 */
export async function getContinuousPlaybackState(page: Page): Promise<ContinuousPlaybackState | null> {
  try {
    return await page.evaluate(() => {
      const switchBtn = document.querySelector<HTMLElement>('.continuous-btn .switch-btn');
      if (!switchBtn) {
        return null;
      }
      return { exists: true, on: switchBtn.classList.contains('on') };
    });
  } catch {
    return null;
  }
}

/** 单条评论（视频播放页评论区，Shadow DOM 穿透提取） */
export interface CommentItem {
  author: string;
  /** UID（#user-name a href → space.bilibili.com/{uid}） */
  authorUid: string;
  /** 评论内容（bili-rich-text shadowRoot → p#contents） */
  text: string;
  /** 时间（#footer #pubdate） */
  pubdate: string;
  /** 点赞数（#footer #like #count） */
  like: string;
  /** 是否 UP 主（#user-up 徽章存在） */
  isUp: boolean;
}

/** 评论区提取结果 */
export interface CommentsInfo {
  /** 评论总数（bili-comments shadowRoot → #header #count） */
  total: number;
  comments: CommentItem[];
}

/**
 * 提取视频播放页评论区（前 limit 条）。
 * ⚠️ 评论区是多层 Web Component Shadow DOM（<bili-comments> 内含 <template shadowrootmode="open">），
 * 普通 document.querySelector 取不到，须沿 element.shadowRoot 递归穿透（见文档 5.6）。
 * 提取失败返回 null。
 */
export async function extractComments(page: Page, limit = 10): Promise<CommentsInfo | null> {
  try {
    return await page.evaluate((n) => {
      const out: CommentsInfo = { total: 0, comments: [] };

      // 在 root 及其所有 shadowRoot 后代中查找第一个匹配 selector 的元素
      const queryInShadow = (root: ParentNode, selector: string): Element | null => {
        const direct = root.querySelector(selector);
        if (direct) {
          return direct;
        }
        const walk = (el: Element): Element | null => {
          if (el.shadowRoot) {
            const hit = el.shadowRoot.querySelector(selector);
            if (hit) {
              return hit;
            }
          }
          for (const child of Array.from(el.children)) {
            const hit = walk(child);
            if (hit) {
              return hit;
            }
          }
          return null;
        };
        for (const el of Array.from(root.children)) {
          const hit = walk(el);
          if (hit) {
            return hit;
          }
        }
        return null;
      };

      const commentsRoot = document.querySelector('bili-comments');
      if (!commentsRoot) {
        return out;
      }
      const shadow = commentsRoot.shadowRoot;
      if (!shadow) {
        return out;
      }

      // 评论总数：shadowRoot → #header #count
      const countEl = queryInShadow(shadow, '#header #count');
      out.total = parseInt(countEl?.textContent?.trim() ?? '0', 10) || 0;

      // 单条评论：bili-comment-renderer 的 shadowRoot 内提取
      const renderers = shadow.querySelectorAll('bili-comment-renderer');
      for (const r of Array.from(renderers)) {
        const rs = r.shadowRoot;
        if (!rs) {
          continue;
        }
        const nameLink = rs.querySelector<HTMLAnchorElement>('#user-name a');
        const contentEl = queryInShadow(rs, 'bili-rich-text #contents');
        const pubdate = rs.querySelector('#footer #pubdate')?.textContent?.trim() ?? '';
        const like = rs.querySelector('#footer #like #count')?.textContent?.trim() ?? '';
        out.comments.push({
          author: nameLink?.textContent?.trim() ?? '',
          authorUid: nameLink?.href.match(/space\.bilibili\.com\/(\d+)/)?.[1] ?? '',
          text: contentEl?.textContent?.trim().slice(0, 200) ?? '',
          pubdate,
          like,
          isUp: !!rs.querySelector('#user-up'),
        });
        if (out.comments.length >= n) {
          break;
        }
      }
      return out;
    }, limit);
  } catch {
    return null;
  }
}
