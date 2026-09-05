/**
 * 包根相对路径助手：bilibili-user-simulation 需**独立启动**（不依赖宿主 cwd）。
 *
 * 早期实现用 `process.cwd()` 解析 data/logs/puppeteer-browser/config 等运行数据，
 * 那要求必须从宿主仓库根运行。现改为以「本包根」为基准的绝对路径解析，
 * 使引擎在任意位置（包内 `npm run start:*` / 被依赖安装后）都能找到自己的运行数据。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本文件所在目录 = <包根>/src/utils */
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** bilibili-user-simulation 包根目录（相对本文件上溯两级，与 process.cwd() 无关） */
export const PACKAGE_ROOT = path.resolve(HERE, '..', '..');

/** 拼出包根下的路径（segments 为空时返回包根） */
export function packagePath(...segments: string[]): string {
  return path.join(PACKAGE_ROOT, ...segments);
}
