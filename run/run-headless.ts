/**
 * 人格引擎正式无头运行入口（养号后台，一直持续运行）。
 *
 * 正式运行语义（用户要求）：
 * - 真实时间：无时间模拟加速（1 秒 = 1 秒）
 * - 无时间限制：一直运行，上线（打开浏览器并确认登录）→ 任务流 → 下线（关闭浏览器/退出登录）→ 离线休息 → 重新上线，无限循环
 *
 * 用法：
 *   npm run run:headless -- [人格id]
 *
 * 参数（默认）：人格id=ak-night-worker。
 * Ctrl+C 终止。
 */
import { runPersonaEngine } from './persona-engine.js';

const personaId = process.argv[2] ?? 'ak-night-worker';

await runPersonaEngine({
  headless: true,
  mouseTrail: false, // 无头：不注入鼠标轨迹
  verbose: false, // 精简输出，避免刷屏
  personaId,
});
