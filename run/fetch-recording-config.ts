/**
 * 读取 / 写回 `run/config-app.json5` 中的 `fetch_recording` 配置（被动蹲饼录屏开关）。
 *
 * 配置节示例：
 *   fetch_recording: {
 *     enable: true,   // 是否录屏：蹲饼触发时对动态页开启 CDP screencast，合成 mp4 到 logs/screencast/
 *   }
 *
 * 默认关闭（调试定位「获取不到新动态」问题时临时开启）。
 * 运行时 `record` 指令会写回该节（`setFetchRecordingByCommand`），重启后仍生效。
 */
import fs from 'node:fs';
import path from 'node:path';
import JSON5 from 'json5';
import { setFetchRecordingEnabled } from '../src/business/record-fetch-video.js';
import { packagePath } from '../src/utils/paths.js';

/**
 * 从 `run/config-app.json5` 读取 `fetch_recording` 节并注册录屏开关；
 * 文件缺失 / 解析失败 / 字段缺失时默认关闭（不抛错）。
 */
export function loadFetchRecordingConfig(): void {
  const cfgPath = packagePath('config-app.json5');
  try {
    let enable = false;
    if (fs.existsSync(cfgPath)) {
      const raw = JSON5.parse(fs.readFileSync(cfgPath, 'utf-8')) as {
        fetch_recording?: { enable?: boolean };
      };
      enable = raw.fetch_recording?.enable === true;
    }
    setFetchRecordingEnabled(enable);
    if (enable) {
      console.log('🎬 蹲饼录屏：已开启（蹲饼触发时录制画面到 logs/screencast/）');
    }
  } catch (err) {
    console.warn(`⚠️ 读取 fetch_recording 配置失败: ${(err as Error).message}`);
    setFetchRecordingEnabled(false);
  }
}

/**
 * 运行时 `record` 指令设置录屏开关：更新内存开关，并写回 `run/config-app.json5` 的
 * `fetch_recording.enable`。写回采用**定位该节后局部替换**，保留其它配置与注释格式；
 * 配置中没有该节时自动追加，文件缺失时自动创建。
 * 写回失败不抛错（内存开关已生效，仅下次启动回退到配置文件原值）。
 */
export function setFetchRecordingByCommand(enable: boolean): void {
  setFetchRecordingEnabled(enable);
  const cfgPath = packagePath('config-app.json5');
  try {
    let raw: string;
    if (fs.existsSync(cfgPath)) {
      raw = fs.readFileSync(cfgPath, 'utf-8');
    } else {
      raw = `{\n  fetch_recording: {\n    enable: ${enable},\n  },\n}\n`;
    }
    const lines = raw.split('\n');
    let inRec = false;
    let replaced = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!inRec) {
        if (/\bfetch_recording\s*:/.test(line)) {
          inRec = true;
          if (line.includes('}')) {
            // 单行内联节 fetch_recording: { enable: true, }
            const next = line.replace(/(enable\s*:\s*)(true|false)/, `$1${enable}`);
            lines[i] = next;
            replaced = next !== line;
            break;
          }
          continue;
        }
      } else {
        if (!replaced && /enable\s*:\s*(true|false)/.test(line)) {
          lines[i] = line.replace(/(enable\s*:\s*)(true|false)/, `$1${enable}`);
          replaced = true;
        }
        if (line.includes('}')) {
          if (!replaced) {
            // 节内没有 enable 字段 → 在闭合行前插入
            lines.splice(i, 0, `    enable: ${enable},`);
            replaced = true;
          }
          break;
        }
      }
    }
    if (!inRec) {
      // 配置中没有 fetch_recording 节 → 追加一个
      raw = raw.trimEnd() + `\n\n  fetch_recording: {\n    enable: ${enable},\n  },\n`;
    } else {
      raw = lines.join('\n');
    }
    fs.writeFileSync(cfgPath, raw, 'utf-8');
    console.log(`💾 已写回 ${path.basename(cfgPath)}：fetch_recording.enable = ${enable}（重启后仍生效）`);
  } catch (err) {
    console.warn(`⚠️ 写回 fetch_recording 配置失败（内存开关已生效）: ${(err as Error).message}`);
  }
}
