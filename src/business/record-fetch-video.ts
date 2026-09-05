/**
 * 蹲饼录屏（调试用，不影响业务）。
 *
 * 触发：update 提示（update_num>0）进入 runFetchSession 时开始录屏，
 * 记录「切前台 → 点击「有新动态」按钮 → feed/all 重载 → 增量判断」的完整流程，
 * 用于回放判断「获取不到新动态」的真实原因（收录延迟 / 点击未生效 / 页面异常）。
 *
 * 实现：CDP `Page.startScreencast`（无头模式同样支持），每帧 base64 JPEG 收集到内存，
 * 停止时落盘为帧序列 jpg；若系统装有 ffmpeg 则合成 mp4，否则保留帧目录。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { Page, CDPSession } from 'puppeteer-core';
import { packagePath } from '../utils/paths';

/** 录屏输出根目录（logs/ 已被 .gitignore 忽略，不会上传） */
const SCREENCAST_ROOT = packagePath('logs', 'screencast');

/** 录屏开关（默认关闭，由 run/config-app.json5 的 fetch_recording.enable 控制） */
let recordingEnabled = false;

/** 设置录屏开关（persona-engine / watch-persona 启动时从 config-app.json5 读取后调用） */
export function setFetchRecordingEnabled(enable: boolean): void {
  recordingEnabled = enable === true;
}

/** 当前是否开启录屏 */
export function isFetchRecordingEnabled(): boolean {
  return recordingEnabled;
}

/** 一次蹲饼录屏的句柄 */
export interface FetchRecording {
  /** 动态页 CDP 会话（startScreencast 挂在上面的） */
  session: CDPSession;
  /** 已收集的帧（每项为 base64 JPEG） */
  frames: string[];
  /** 本次录屏输出目录（logs/screencast/fetch-<ts>/） */
  dir: string;
  /** 录屏开始时刻（毫秒），用于按真实时长计算播放帧率（避免慢动作） */
  startedAt: number;
  /** 是否已停止（幂等，防止重复停止/重复合成） */
  finished?: boolean;
}

/**
 * 开始录屏：对动态页 page 开启 CDP screencast，帧收集到内存。
 * 失败（页面已关/无头异常）返回 null，不影响蹲饼业务。
 */
export async function startFetchRecording(page: Page): Promise<FetchRecording | null> {
  if (!recordingEnabled) {
    return null; // 配置关闭录屏（默认关）
  }
  try {
    const session = await page.createCDPSession();
    const dir = path.join(SCREENCAST_ROOT, `fetch-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    const rec: FetchRecording = { session, frames: [], dir, startedAt: Date.now() };
    session.on('Page.screencastFrame', (frame) => {
      rec.frames.push(frame.data);
      // 必须 ack，否则浏览器停止推帧
      session.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
    });
    await session.send('Page.startScreencast', { format: 'jpeg', quality: 80 });
    return rec;
  } catch {
    return null;
  }
}

/**
 * 停止录屏并落盘：写帧序列 jpg，系统有 ffmpeg 则合成 mp4
 * （按真实录制时长定帧率，播放为正常速度）。
 * @returns 可查看的路径（mp4 或帧目录）；无有效帧/失败返回 null
 */
export async function stopFetchRecording(rec: FetchRecording | null): Promise<string | null> {
  if (!rec || rec.finished) {
    return null; // 幂等：已停止过
  }
  rec.finished = true;
  try {
    await rec.session.send('Page.stopScreencast').catch(() => {});
  } catch {
    /* session 可能已断开（如浏览器关闭） */
  }
  if (rec.frames.length === 0) {
    return null; // 一帧都没录到（可能页面后台无渲染）
  }
  // 帧落盘（按序命名 00000.jpg …，供 ffmpeg 按 %05d 读取）
  let written = 0;
  for (let i = 0; i < rec.frames.length; i++) {
    const file = path.join(rec.dir, `${String(i).padStart(5, '0')}.jpg`);
    try {
      fs.writeFileSync(file, Buffer.from(rec.frames[i], 'base64'));
      written++;
    } catch {
      /* 单帧失败忽略 */
    }
  }
  if (written === 0) {
    return null;
  }
  // 尝试 ffmpeg 合成 mp4（无 ffmpeg 则保留帧序列目录）
  // 播放帧率按「帧数 / 真实录制时长」计算：CDP screencast 实际推帧约 8fps（且按内容变化推帧），
  // 此前硬编码 -framerate 5 会把帧拉长成慢动作。改用真实平均帧率合成，播放时长即真实操作时长（正常速度）。
  const elapsedMs = Math.max(1, Date.now() - rec.startedAt);
  const realFps = Math.min(30, Math.max(1, written / (elapsedMs / 1000)));
  const mp4 = path.join(rec.dir, 'video.mp4');
  const ok = await new Promise<boolean>((resolve) => {
    execFile(
      'ffmpeg',
      ['-y', '-framerate', realFps.toFixed(2), '-i', path.join(rec.dir, '%05d.jpg'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', mp4],
      { timeout: 60_000, windowsHide: true },
      (err) => resolve(!err)
    );
  });
  if (ok) {
    // 合成成功 → 删除帧序列 jpg，只保留 mp4
    for (let i = 0; i < written; i++) {
      try {
        fs.unlinkSync(path.join(rec.dir, `${String(i).padStart(5, '0')}.jpg`));
      } catch {
        /* 忽略删除失败 */
      }
    }
    return mp4;
  }
  return rec.dir; // 无 ffmpeg/合成失败 → 保留帧序列目录兜底
}
