import { BaseTask, TaskResult } from './base';
import type { TaskContext } from '../execute/context';
import type { Page } from 'puppeteer-core';
import { MainState } from '../engine/state';
import { LeftClickBehavior, SleepBehavior } from '../behavior';
import { MousePositionManager } from '../engine/mouse-position-manager';
import {
  bvFromUrl,
  pickVideoEntry,
  findVideoEntryHandle,
  findVideoCoverHandle,
  collectVideoTargetLinks,
  extractVideoPageInfo,
  collectVideoEntries,
  isVideoPageUrl,
  type VideoEntry,
} from '../../utils/bilibili-dom';

/**
 * 打开视频页任务：只负责「进入视频页并读取视频信息」，不负责观看。
 *
 * 与 WatchVideo 的职责划分（用户架构要求）：
 * - OpenVideo：进入视频页 + 读取视频信息（总时长/标题/URL/推荐流）→ 结果交给生成器
 * - WatchVideo：由生成器拿到视频信息后生成，负责按「视频时长 × 观看比例」观看
 *
 * 目标视频由生成器的 OpenVideo「概率计算器」抉择（task-registrations.decideOpenVideo）：
 * - 在视频页：从右侧推荐流里按各视频吸引力抉择一个（推荐视频互相争夺实际打开资格），
 *   点击它并关闭旧视频标签页（连刷不堆积标签）
 * - 非视频页（主页/搜索/动态）：从当前页收集抉择一个视频打开
 * 打开后都会收集当前视频页右侧推荐流（recommendations）返回给生成器，
 * 只要还处在视频页，这些推荐信息都作为生成器的输入参数影响下一个任务
 * （继续看当前 / 打开推荐新视频 / 秒退），并与 WatchVideo/CloseVideo 按概率公平比较。
 *
 * - preCheck：有目标=在视频页且推荐流能找到；无目标=当前页有视频入口（或已在视频页）
 * - 返回：{ opened, videoDuration, videoUrl, title, upName, upUid, viewCount,
 *          viaRecommend, recommendations }，nextState = CONTENT_CONSUMING
 */
/**
 * 生成器定位阶段封装的目标视频信息：
 * - linkHrefs：目标视频在当前页的所有可跳转 <a> href（执行期据此确认跳转链接并定位）
 * - 基础信息（标题/作者/时长）供日志与后续决策
 */
export interface OpenVideoTargetInfo {
  bvid: string;
  linkHrefs: string[];
  title?: string;
  upName?: string;
  duration?: number;
}

export interface OpenVideoInput {
  /** 目标视频（生成器概率计算器从推荐流抉择出的）；为空 = 任务内从当前页收集抉择 */
  target?: VideoEntry;
  /** 生成器定位收集的目标视频信息（跳转链接 + 基础信息），执行器据此定位点击 */
  targetInfo?: OpenVideoTargetInfo;
}

export class OpenVideoTask extends BaseTask {
  constructor(private input: OpenVideoInput = {}) {
    super('OpenVideo');
  }

  /**
   * 生成器定位阶段调用（步骤 2/3）：收集目标视频在当前页的所有跳转链接 <a> href +
   * 基础信息，封装进任务输入（供执行期步骤 4 确认跳转链接并定位点击）。
   * 纯逻辑模拟无真实 page 或目标为空时跳过。
   */
  async prepareTargetInfo(page: Page): Promise<void> {
    const target = this.input.target;
    if (!target || this.input.targetInfo) {
      return;
    }
    const links = await collectVideoTargetLinks(page, target.bvid);
    this.input.targetInfo = {
      bvid: target.bvid,
      linkHrefs: links.hrefs,
      title: target.title ?? '',
      upName: target.author ?? '',
      duration: target.duration ? Number.parseFloat(target.duration) : undefined,
    };
  }

  /** 查找真实视频链接（/video/BV...，排除创作中心等伪链接） */
  private findVideoEntrySelector(): string {
    return 'a[href*="/video/BV"]';
  }

  /** preCheck：有目标=在视频页且推荐流能找到；无目标=当前页有视频入口（或已在视频页） */
  async preCheck(context: TaskContext): Promise<boolean> {
    const page = context.page;
    if (!page) {
      return false;
    }
    try {
      // 有抉择出的目标（来自视频页右侧推荐流）：必须在视频页，且推荐流里能找到目标 bvid
      if (this.input.target) {
        const ok = isVideoPageUrl(page.url()) && !!(await findVideoEntryHandle(page, this.input.target.bvid));
        if (!ok) {
          this.log(`⏭️ preCheck 失败：目标视频 ${this.input.target.bvid} 未在视频页推荐流找到`);
        }
        return ok;
      }
      // 无目标：已在视频页，或当前页有可见视频入口
      if (isVideoPageUrl(page.url())) {
        return true;
      }
      // 有可见视频入口才算可打开
      const entry = await pickVideoEntry(page);
      if (!entry) {
        // 日志：确认目标视频——当前页无视频入口（无法定位目标视频），preCheck 失败
        this.log(`⏭️ preCheck 失败：当前页无视频入口（${page.url().slice(0, 60)}）`);
      }
      return !!entry;
    } catch {
      return false;
    }
  }

  async execute(context: TaskContext): Promise<TaskResult> {
    const page = context.page!;
    const steps: TaskResult[] = [];
    try {
      // 当前是否已在视频页：决定目标来源（推荐流 vs 当前页）与是否关旧标签
      const inVideoPage = isVideoPageUrl(page.url());
      const pageUrl = page.url();
      const pageTitle = await page
        .title()
        .catch(() => '')
        .then((t) => t.slice(0, 40));
      this.log(`🖥️ 当前网页: ${pageTitle}(${pageUrl.slice(0, 70)})`);

      // 目标视频：优先用生成器概率计算器抉择的 target（来自视频页右侧推荐流）；
      // 否则从当前页用公共方法随机选一个可见视频入口
      let entry: VideoEntry | null = this.input.target ?? null;
      if (entry) {
        this.log(`🎯 打开推荐视频: [${entry.bvid}]「${entry.title.slice(0, 30)}」（旧视频 ${pageUrl.slice(0, 50)}）`);
      } else {
        entry = await pickVideoEntry(page);
        if (entry) {
          this.log(`🎯 目标视频: ${entry.title.slice(0, 40)}(${entry.href.slice(0, 60)}) [${entry.bvid}]`);
        } else {
          this.log(`🎯 目标视频: 未找到（当前页无可见 /video/BV 链接）`);
        }
      }

      // 需要点击的场景：不在视频页（首次打开），或目标来自推荐流（连刷：在视频页点推荐新视频）
      const needClick = !!entry && (!inVideoPage || !!this.input.target);
      if (needClick) {
        // 打开视频入口：定位标题卡片 → 解析坐标（关闭悬浮弹窗+居中+兜底）→ 拟人点击 → 等待/捕获 → 关闭旧标签
        await this.openVideoEntry(context, page, entry!, inVideoPage, pageUrl, steps);
        // 加载确认：等视频页「内容完全就绪」（页面加载 + 标题渲染 + 视频元数据 duration 可用）
        // 再读取信息。若只等 video 元素挂载，duration 可能仍为 NaN → 提取「总长 0s」（实测）。
        await this.waitVideoPageReady(context);
      } else if (!entry && !inVideoPage) {
        // 既无目标也非视频页 → 无法打开
        throw new Error('未找到可见的视频');
      }

      // 读取信息 + 收集当前视频页右侧推荐流，返回统一打开结果
      return await this.finishOpen(context, steps, !!this.input.target);
    } catch (error) {
      // 失败诊断：记录「当前网页」与「目标视频」的上下文，便于判断失败情况
      const diag = await this.collectFailureContext(context).catch(() => null);
      const errMsg = `打开视频页失败: ${(error as Error).message}${diag ? `｜当前页: ${diag.pageTitle}(${diag.pageUrl})｜目标: ${diag.selector}｜页内视频链接 ${diag.videoLinkCount} 个` : ''}`;
      return {
        success: false,
        error: errMsg,
        data: { steps: steps.length, ...(diag ?? {}) },
      };
    }
  }

  /**
   * 等待视频页「内容完全就绪」后再读取信息（新标签 / 当前页导航共用）：
   * 1. 页面加载完成（readyState === 'complete'）
   * 2. 标题元素渲染（B 站 SPA 懒加载，标题数据后到）
   * 3. 视频元数据就绪：`#bilibili-player video` 的 `duration` 可用（有限正数）——
   *    HTML5 video 的 duration 需 `loadedmetadata` 后才有效，仅 waitForSelector('video')
   *    只保证元素挂载，duration 可能仍是 NaN → 提取「总长 0s」。
   * 4. 拟人停留（等数据落定，模拟真人等待观感）。
   * 各步均带超时兜底（catch 吞掉），不阻塞打开成功判定。
   */
  private async waitVideoPageReady(context: TaskContext): Promise<void> {
    const page = context.page;
    if (!page) {
      return;
    }
    await page.waitForFunction(() => document.readyState === 'complete', { timeout: 15000 }).catch(() => {});
    await page.waitForSelector('h1.video-title, .video-info-title', { timeout: 15000 }).catch(() => {});
    // 等视频元数据（metadata）加载完成：duration 可用（有限正数）。播放器懒加载，元素挂载早于元数据。
    await page
      .waitForFunction(
        () => {
          const v = document.querySelector('#bilibili-player video') as HTMLVideoElement | null;
          return !!v && Number.isFinite(v.duration) && v.duration > 0;
        },
        { timeout: 15000 }
      )
      .catch(() => {});
    await new SleepBehavior(1500 + Math.random() * 1500).execute(context);
  }

  /**
   * 打开视频入口（首次打开 / 连刷共用）。
   *
   * 分阶段流程（基于当前架构）：
   * 1. 精确定位「标题卡片」handle（findVideoEntryHandle 按页面类型排除封面/「稍后再看」噪音）
   * 2. 解析视口坐标（MousePositionManager.resolveTarget：内部**先关闭悬浮弹窗**（mini player 等）
   *    → scrollIntoView 居中 → getClientRects 首块中心落点 → 深层懒加载兜底 handle.click）
   * 3. 纯坐标拟人点击（LeftClickBehavior；已兜底点击则跳过）
   * 4. 等待/捕获新视频页（target=_blank 开新标签；或当前页导航，按 bvid 精确校验防连刷假成功）
   * 5. 连刷时关闭旧视频标签，避免标签堆积
   */
  private async openVideoEntry(
    context: TaskContext,
    page: NonNullable<TaskContext['page']>,
    entry: VideoEntry,
    inVideoPage: boolean,
    pageUrl: string,
    steps: TaskResult[]
  ): Promise<void> {
    // 步骤4：确定跳转链接元素位置——生成器已封装目标视频的跳转链接信息，执行期据此确认并重新定位
    if (this.input.targetInfo?.linkHrefs?.length) {
      this.log(`🔗 目标视频跳转链接 ${this.input.targetInfo.linkHrefs.length} 个（生成器定位）`);
    }
    // 1) 精确定位「标题卡片」handle（确认目标存在 + 作为滚动/兜底锚点）
    const entryHandle = await findVideoEntryHandle(page, entry.bvid);
    if (!entryHandle) {
      throw new Error('未找到可见的视频入口');
    }
    // 2) 优先用「封面图区域随机取点」点击：封面区域大、命中率高，
    //    且不会误点到同卡片的 UP 主页入口（space.bilibili.com 链接）
    const coverHandle = await findVideoCoverHandle(page, entry.bvid);
    let clicked = false;
    if (coverHandle) {
      const coverPoint = await MousePositionManager.instance.resolveCoverClickPoint(page, coverHandle);
      if (coverPoint) {
        const cl = await new LeftClickBehavior(coverPoint).execute(context);
        steps.push(cl);
        if (!cl.success) {
          throw new Error(cl.error);
        }
        clicked = true;
      }
    }
    // 3) 封面图不可用 → 兜底：标题卡片 resolveTarget（关闭悬浮弹窗 + 居中落点 + 深层懒加载兜底点击）
    if (!clicked) {
      const resolved = await MousePositionManager.instance.resolveTarget(page, entryHandle);
      if (!resolved.point && !resolved.alreadyClicked) {
        throw new Error('未找到可见的视频入口');
      }
      if (!resolved.alreadyClicked) {
        const cl = await new LeftClickBehavior(resolved.point!).execute(context);
        steps.push(cl);
        if (!cl.success) {
          throw new Error(cl.error);
        }
      }
    }

    // 4) 等待并捕获新视频标签页（视频链接 target=_blank 开新标签）
    const videoPage = await this.findVideoPage(context);
    if (videoPage) {
      // 连刷（在视频页点推荐）→ 关闭旧视频标签页，避免标签堆积
      if (inVideoPage && isVideoPageUrl(page.url())) {
        await page.close().catch(() => {});
        this.log(`🗑️ 关闭旧视频标签: ${pageUrl.slice(0, 60)}`);
      }
      context.page = videoPage;
      this.log(`📑 捕获到新标签页: ${videoPage.url().slice(0, 70)}`);
    } else if (isVideoPageUrl(context.page!.url())) {
      // 连刷（有 target）时校验当前页 bvid === 目标 bvid：URL 可能因 vd_source 等参数变化串不同
      // 但仍是旧视频，整串比较会误判「已导航」→ 用 bvid 精确校验，避免连刷假成功（还在旧视频）
      if (this.input.target && bvFromUrl(context.page!.url()) !== this.input.target.bvid) {
        throw new Error(`点击推荐视频后未切换到目标视频（当前 ${context.page!.url().slice(0, 60)}）`);
      }
      // 部分链接是当前页直接导航（非 target=_blank），当前页已是视频页
      this.log('📄 视频页（当前页导航）');
    } else {
      // 点击后未开新标签也未导航（被前端拦截等）→ 打开失败，交给生成器（超阈值后走下一任务）
      throw new Error('点击视频链接后未进入视频页');
    }
  }

  /** 读取当前视频页信息 + 收集右侧推荐流，返回统一打开结果 */
  private async finishOpen(context: TaskContext, steps: TaskResult[], viaRecommend: boolean): Promise<TaskResult> {
    const page = context.page!;
    const pageInfo = await extractVideoPageInfo(page).catch(() => null);
    const videoUrl = page.url();

    // 校验：必须真的在视频页（普通视频或 bangumi 番剧/TV剧），否则判定失败让生成器关闭重试
    if (!isVideoPageUrl(videoUrl)) {
      throw new Error(`未真正进入视频页（当前 ${videoUrl}）`);
    }

    const title = pageInfo?.title || (await page.title().catch(() => '')) || '';
    const duration = pageInfo?.duration ?? 0;
    // 收集当前视频页右侧推荐流：只要还处在视频页，都作为生成器的输入参数影响下一个任务。
    // 推荐流 SPA 懒加载：先等推荐容器出现（视频页右侧 .video-page-card-small / 主页 .bili-video-card）
    // 再收集；容器始终不出现（超时 8s，如无推荐）则继续下方轮询兜底，保证连刷闭环有目标可点。
    await page
      .waitForFunction(() => !!document.querySelector('.video-page-card-small, .bili-video-card'), { timeout: 8000 })
      .catch(() => {});
    let recommendations = await collectVideoEntries(page, 20);
    for (let i = 0; i < 5 && recommendations.length === 0; i++) {
      await this.sleepReal(600);
      recommendations = await collectVideoEntries(page, 20);
    }
    this.log(
      `▶ 已打开视频页: ${bvFromUrl(videoUrl) || '无BV'}「${title.slice(0, 24)}」总长 ${duration.toFixed(0)}s${pageInfo?.upName ? `｜UP: ${pageInfo.upName}` : ''}${pageInfo?.viewCount ? `｜播放 ${pageInfo.viewCount}` : ''}｜推荐 ${recommendations.length} 个${viaRecommend ? '（推荐连刷）' : ''}`
    );

    return {
      success: true,
      data: {
        opened: true,
        videoDuration: duration,
        videoUrl,
        title,
        upName: pageInfo?.upName ?? '',
        upUid: pageInfo?.upUid ?? '',
        viewCount: pageInfo?.viewCount ?? '',
        viaRecommend,
        recommendations,
        steps: steps.length,
      },
      nextState: MainState.CONTENT_CONSUMING,
    };
  }

  /** 收集失败时的上下文：当前页 URL/标题 + 目标视频选择器 + 页内视频链接数 */
  private async collectFailureContext(
    context: TaskContext
  ): Promise<{ pageUrl: string; pageTitle: string; selector: string; videoLinkCount: number } | null> {
    const page = context.page;
    if (!page) {
      return null;
    }
    const pageUrl = page.url().slice(0, 120);
    const pageTitle = await page
      .title()
      .catch(() => '')
      .then((t) => t.slice(0, 40));
    const selector = this.findVideoEntrySelector();
    const videoLinkCount = await page.$$eval(this.findVideoEntrySelector(), (list) => list.length).catch(() => 0);
    return { pageUrl, pageTitle, selector, videoLinkCount };
  }

  /** 在所有标签页中查找「真正的新视频页」（点击 target=_blank 打开的新标签） */
  private async findVideoPage(context: TaskContext): Promise<NonNullable<TaskContext['page']> | null> {
    const browser = context.browser;
    if (!browser) {
      return null;
    }
    // 用「页面对象引用」排除当前页（而非 URL 比较）：同页导航（SPA）时当前页 URL 会变成目标，
    // 若用 URL 比较会把当前页自己误判为「新标签」，随后被 close() 关闭 → 所有标签消失（实测）。
    const currentPage = context.page;
    // 轮询最多 12 秒（20 次 × 600ms）：B 站新标签页懒加载/网络慢时延迟出现，延长轮询降低偶发「未进入视频页」失败
    for (let i = 0; i < 20; i++) {
      const pages = await browser.pages().catch(() => [] as NonNullable<TaskContext['page']>[]);
      for (const p of pages) {
        if (p !== currentPage && isVideoPageUrl(p.url())) {
          return p;
        }
      }
      await this.sleepReal(600);
    }
    return null;
  }
}
