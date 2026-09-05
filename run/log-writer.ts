/**
 * 轻量滚动日志：把 console 输出同时写入文件（stdout 保留），供正式运行持久化。
 *
 * - 按自然日分割（每自然天一个文件），避免单文件无限增长
 * - patch console.log/error/warn：stdout + 文件双写
 * - 日志失败不影响运行（try/catch 兜底）
 *
 * 用法（正式运行入口调用一次）：
 *   installLogWriter({ dir, prefix })
 * 之后所有 console.* 都会同时落到 logs/persona-YYYYMMDD.log。
 */
import fs from 'node:fs';
import path from 'node:path';
import { packagePath } from '../src/utils/paths.js';

export interface LogWriterOptions {
  /** 日志目录（默认 logs） */
  dir?: string;
  /** 文件前缀（默认 persona） */
  prefix?: string;
}

/** 对象 → 可读文本（避免 [object Object]） */
function fmtArg(a: unknown): string {
  if (typeof a === 'string') {
    return a;
  }
  if (a instanceof Error) {
    return `${a.name}: ${a.message}${a.stack ? `\n${a.stack}` : ''}`;
  }
  try {
    const s = JSON.stringify(a);
    return s === undefined ? String(a) : s;
  } catch {
    return String(a);
  }
}

/**
 * 安装滚动日志（幂等：重复调用只生效第一次）。
 * @returns 当前日志文件路径
 */
export function installLogWriter(opts: LogWriterOptions = {}): { file: string } {
  const dir = opts.dir ?? packagePath('logs');
  fs.mkdirSync(dir, { recursive: true });
  const prefix = opts.prefix ?? 'persona';

  const dayFile = (): string => {
    const d = new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    return path.join(dir, `${prefix}-${ymd}.log`);
  };

  // 幂等：避免重复 patch（如有头/无头入口叠加调用）
  const KEY = '__persona_log_writer_installed__';
  if ((globalThis as Record<string, unknown>)[KEY]) {
    return { file: dayFile() };
  }
  (globalThis as Record<string, unknown>)[KEY] = true;

  const write = (level: string, args: unknown[]): void => {
    try {
      const ts = new Date().toISOString();
      const line = `[${ts}] [${level}] ${args.map(fmtArg).join(' ')}\n`;
      fs.appendFileSync(dayFile(), line);
    } catch {
      // 日志写入失败不影响运行
    }
  };

  const orig = { log: console.log, error: console.error, warn: console.warn };

  console.log = (...args: unknown[]) => {
    orig.log(...args);
    write('INFO', args);
  };
  console.error = (...args: unknown[]) => {
    orig.error(...args);
    write('ERROR', args);
  };
  console.warn = (...args: unknown[]) => {
    orig.warn(...args);
    write('WARN', args);
  };

  return { file: dayFile() };
}
