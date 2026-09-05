import { BaseTask, TaskResult } from './base';
import type { TaskContext } from '../execute/context';
import { MainState } from '../engine/state';
import { LeftClickBehavior, KeyPressBehavior, ScrollBehavior, SleepBehavior } from '../behavior';
import { MousePositionManager } from '../engine/mouse-position-manager';
import { HumanScroller } from '../engine/human-scroller';
import {
  bvFromUrl,
  extractVideoPageInfo,
  getContinuousPlaybackState,
  getPlayerPlaybackState,
  isVideoPageUrl,
} from '../../utils/bilibili-dom';

/** 观看视频任务的输入：由生成器（决策层）在拿到 OpenVideo 结果后提供。 */
export interface WatchVideoInput {
  /** 视频实际总时长（秒），由 OpenVideoTask 读取并交给生成器 */
  videoDuration: number;
  /** 初步计划观看时长（毫秒），由生成器（人格）决定；进入后按播放器剩余播放时间修正 */
  durationMs: number;
  /** 是否全屏观看，由人格决定 */
  fullscreen: boolean;
  /** 10 秒内退出视频的概率，来自 persona.early_exit_prob */
  earlyExitProb?: number;
}

/** 观看过程中的播放进度状态（内部维护，每次检查从播放器同步） */
interface PlaybackProgress {
  /** 视频总时长（秒） */
  totalDuration: number;
  /** 当前已播放时长（秒） */
  playedSeconds: number;
}

/**
 * 观看视频任务：只负责「观看」，不负责打开视频页。
 *
 * 与 OpenVideo 的职责划分（用户架构要求）：
 * - OpenVideo：进入视频页 + 读取视频信息 → 结果交给生成器
 * - WatchVideo：由生成器拿到视频信息后生成，负责观看
 *
 * - preCheck：当前页必须是视频页（否则说明生成器没先 OpenVideo）
 * - 行为：确定视频播放 → 关闭自动连播 →（可选）全屏 → 按计划观看
 * - 观看时长：生成器 durationMs 为计划，进入时**不再修正**；内部维护播放进度状态
 *   （视频总时长 + 当前已播放时长），定期从播放器同步并打印；
 *   视频播放完成时即使计划时间未到也提前结束任务。
 */
export class WatchVideoTask extends BaseTask {
  constructor(private input: WatchVideoInput) {
    super('WatchVideo');
  }

  /** preCheck：必须在视频页才能观看（否则前置检查失败，由生成器处理） */
  async preCheck(context: TaskContext): Promise<boolean> {
    const page = context.page;
    if (!page) {
      return false;
    }
    try {
      // 当前页必须是视频页（普通视频或 bangumi 番剧/TV剧；OpenVideo 应已先进入）
      return isVideoPageUrl(page.url());
    } catch {
      return false;
    }
  }

  async execute(context: TaskContext): Promise<TaskResult> {
    const steps: TaskResult[] = [];
    try {
      // 行为1：确定视频播放（存在 video 元素且未暂停）
      const playing = await this.ensurePlaying(context);
      if (!playing) {
        throw new Error('视频未能开始播放');
      }

      // 行为1.5：页面加载完成后检查「自动连播」开关，若开启则关闭（真人观看一般不自动连播）
      const autoPlayDisabled = await this.disableContinuousPlayback(context);
      if (autoPlayDisabled) {
        this.log('🔕 关闭自动连播');
      }

      // 行为2：若人格要求全屏
      if (this.input.fullscreen) {
        const fs = await this.enterFullscreen(context);
        steps.push(fs);
        await new SleepBehavior(500 + Math.random() * 1000).execute(context);
      }

      // 行为3：观看（计划时长 = 生成器决定，进入时不再按播放器剩余时间修正；
      //        内部维护「播放进度」状态：视频总时长 + 当前已播放时长，定期同步并打印；
      //        视频播放完成时即使计划时间未到也提前结束任务）
      const playerNow = await getPlayerPlaybackState(context.page!).catch(() => null);
      // 播放进度状态：视频总时长 + 当前已播放时长（播放器未就绪时用生成器给的视频时长兜底）
      const progress: PlaybackProgress = {
        totalDuration: playerNow && playerNow.hasPlayer && playerNow.duration > 0 ? playerNow.duration : this.input.videoDuration,
        playedSeconds: playerNow && playerNow.hasPlayer ? Math.max(0, playerNow.currentTime) : 0,
      };

      let durationMs = this.input.durationMs;

      // 秒关：小概率只观看 3~10 秒（与视频时长无关）
      const earlyExitProb = this.input.earlyExitProb ?? 0.1;
      const earlyExit = Math.random() < earlyExitProb;
      if (earlyExit) {
        durationMs = 3000 + Math.random() * 7000;
      }
      const bvid = bvFromUrl(context.page?.url() ?? '');
      // 真实标题用公共方法取 h1.video-title（比 document.title 准确），并顺带拿 UP 名
      const pageInfo = await extractVideoPageInfo(context.page!).catch(() => null);
      const vidTitle = (pageInfo?.title || (await context.page?.title().catch(() => '')) || '').slice(0, 24);
      const planSec = Math.round(this.input.durationMs / 1000);
      const planNote = earlyExit ? '⚡秒关' : `计划 ${planSec}s`;
      this.log(
        `▶ 观看视频: ${bvid || '无BV'}「${vidTitle}」观看 ${(durationMs / 1000).toFixed(0)}s（总长 ${progress.totalDuration.toFixed(0)}s，${planNote}）${this.input.fullscreen ? ' 全屏' : ''}${pageInfo?.upName ? `｜UP: ${pageInfo.upName}` : ''}`
      );

      const checkInterval = 5000;
      const PROGRESS_EVERY = 6; // 每 6 个片段（约 30s）打印一次观看进度
      let completed = false; // 视频是否已播放完成（即使计划未到也结束）
      const watchStart = Date.now();
      let i = 0;
      while (Date.now() - watchStart < durationMs) {
        await new SleepBehavior(checkInterval).execute(context);
        i++;
        // 同步播放进度状态：每次检查都从播放器读取当前已播放时长 / 总时长
        const player = await getPlayerPlaybackState(context.page!).catch(() => null);
        if (player && player.hasPlayer && player.duration > 0) {
          progress.totalDuration = player.duration;
          progress.playedSeconds = player.currentTime;
          // 视频已播放完成（剩余 ≤1s）→ 即使计划时间未到也结束任务
          if (player.remaining <= 1) {
            completed = true;
            this.log(`🎬 视频已播完（已看 ${progress.playedSeconds.toFixed(0)}s），提前结束观看`);
            break;
          }
        }
        if (Math.random() < 0.3 && !this.input.fullscreen) {
          // 偶尔滚动看简介/评论区（30% 概率）——看完后滚回视频位置继续观看（真人会这么做）
          const { mousePos, distance } = await MousePositionManager.instance.browseScrollParams(context.page!);
          await new ScrollBehavior(mousePos, distance).execute(context);
          await new SleepBehavior(800 + Math.random() * 2000).execute(context);
          await new HumanScroller().scrollBackToTop(context.page!).catch(() => {});
        }
        // 定期打印观看进度：同步内部状态（已看 = 内部 playedSeconds）/ 计划 / 总时长
        if (i % PROGRESS_EVERY === 0) {
          this.log(
            `⏳ 观看进度: 已看 ${progress.playedSeconds.toFixed(0)}s / 计划 ${(durationMs / 1000).toFixed(0)}s（总长 ${progress.totalDuration.toFixed(0)}s）`
          );
        }
      }

      return {
        success: true,
        data: {
          durationMs: Math.round(Math.min(durationMs, Date.now() - watchStart)),
          videoDuration: progress.totalDuration,
          completed, // 是否因视频播放完成而提前结束
          fullscreen: this.input.fullscreen,
          steps: steps.length,
          // 秒关标记：生成器据此触发 CloseVideo 关闭视频标签页（避免视频残留继续播放）
          quickClose: earlyExit,
        },
        nextState: MainState.CONTENT_CONSUMING,
      };
    } catch (error) {
      return {
        success: false,
        error: `观看视频失败: ${(error as Error).message}`,
        data: { steps: steps.length },
      };
    }
  }

  /** 确定视频正在播放：检测 video 元素，暂停则点击播放，仍暂停则直接 play() */
  private async ensurePlaying(context: TaskContext): Promise<boolean> {
    const page = context.page!;
    const state = await page
      .evaluate(() => {
        const v = document.querySelector('video');
        if (!v) {
          return { exists: false, paused: true };
        }
        return { exists: true, paused: (v as HTMLVideoElement).paused };
      })
      .catch(() => ({ exists: false, paused: true }));

    if (!state.exists) {
      return false;
    }
    if (state.paused) {
      // 暂停中 → 解析视频画面坐标并拟人点击开始播放（深层懒加载兜底由管理器处理）
      const vResolved = await MousePositionManager.instance
        .resolveTarget(page, 'video')
        .catch(() => ({ point: null, alreadyClicked: false }));
      if (vResolved.point && !vResolved.alreadyClicked) {
        await new LeftClickBehavior(vResolved.point!).execute(context).catch(() => {});
      }
      await new SleepBehavior(800 + Math.random() * 1200).execute(context);
      // 若仍未播放（点击命中控制条等），直接调 play() 兜底
      const stillPaused = await page
        .evaluate(() => {
          const v = document.querySelector('video');
          return v ? (v as HTMLVideoElement).paused : true;
        })
        .catch(() => true);
      if (stillPaused) {
        await page
          .evaluate(() => {
            const v = document.querySelector('video');
            (v as HTMLVideoElement | null)?.play?.().catch(() => {});
          })
          .catch(() => {});
      }
    }
    return true;
  }

  /**
   * 关闭自动连播：视频页底部控制条「自动连播」开关若处于开启状态（.switch-btn 带 on class）
   * 则拟人点击关闭。真人观看通常关闭自动连播，避免播完自动跳转下一个视频打乱观看节奏。
   * 返回是否执行了关闭操作。
   */
  private async disableContinuousPlayback(context: TaskContext): Promise<boolean> {
    const page = context.page!;
    const state = await getContinuousPlaybackState(page).catch(() => null);
    if (!state || !state.on) {
      return false;
    }
    const resolved = await MousePositionManager.instance
      .resolveTarget(page, '.continuous-btn .switch-btn')
      .catch(() => ({ point: null, alreadyClicked: false }));
    if (resolved.point && !resolved.alreadyClicked) {
      await new LeftClickBehavior(resolved.point!).execute(context).catch(() => {});
      await new SleepBehavior(300 + Math.random() * 600).execute(context);
    }
    return true;
  }

  /** 进入全屏：优先点全屏按钮，失败则按 F 键 */
  private async enterFullscreen(context: TaskContext): Promise<TaskResult> {
    const page = context.page!;
    const btn = await page.$('.bpx-player-ctrl-fullscreen, .bpx-player-ctrl-fullscreen-exit').catch(() => null);
    if (btn) {
      const resolved = await MousePositionManager.instance.resolveTarget(
        page,
        '.bpx-player-ctrl-fullscreen, .bpx-player-ctrl-fullscreen-exit'
      );
      if (!resolved.point && !resolved.alreadyClicked) {
        return { success: false, error: '找不到全屏按钮' };
      }
      if (resolved.alreadyClicked) {
        return { success: true };
      }
      return new LeftClickBehavior(resolved.point!).execute(context);
    }
    return new KeyPressBehavior('f').execute(context);
  }
}
