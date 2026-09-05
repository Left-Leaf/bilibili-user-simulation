/**
 * 读取 `run/config-app.json5` 中的 `fetch_report` 配置（被动蹲饼外发接口）。
 *
 * 配置节示例：
 *   fetch_report: {
 *     enable: true,               // 是否启用外发
 *     url: 'http://127.0.0.1:8000/api/fetch-dynamics',  // 外部接口（POST JSON）
 *     batch_size: 50,             // 单次请求最多条数
 *   }
 */
import fs from 'node:fs';
import path from 'node:path';
import JSON5 from 'json5';
import type { FetchReportConfig } from '../src/business/passive-fetch.js';
import { packagePath } from '../src/utils/paths.js';

/** 默认外发配置（关闭） */
const DEFAULT_FETCH_REPORT: FetchReportConfig = { enable: false, url: '', batchSize: 50 };

/**
 * 从 `run/config-app.json5` 读取 `fetch_report` 节；
 * 文件缺失 / 解析失败 / 字段缺失时返回关闭态（不抛错）。
 */
export function loadFetchReportConfig(): FetchReportConfig {
  const cfgPath = packagePath('config-app.json5');
  try {
    if (!fs.existsSync(cfgPath)) {
      return { ...DEFAULT_FETCH_REPORT };
    }
    const raw = JSON5.parse(fs.readFileSync(cfgPath, 'utf-8')) as { fetch_report?: Partial<FetchReportConfig> };
    const fr = raw.fetch_report ?? {};
    return {
      enable: fr.enable === true,
      url: typeof fr.url === 'string' ? fr.url : '',
      batchSize: typeof fr.batchSize === 'number' && fr.batchSize > 0 ? Math.floor(fr.batchSize) : 50,
    };
  } catch (err) {
    console.warn(`⚠️ 读取 fetch_report 配置失败: ${(err as Error).message}`);
    return { ...DEFAULT_FETCH_REPORT };
  }
}
