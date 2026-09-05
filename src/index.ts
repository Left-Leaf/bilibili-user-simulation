/**
 * 人格引擎 package main 入口（声明用，不提供独立 npm script）。
 *
 * 无头后台正式运行请用：`npm run run:headless`
 * 有头观察请用：`npm run run:headed`
 * 详细说明见 README。
 */
import { runPersonaEngine } from '../run/persona-engine.js';

const personaId = process.argv[2] ?? 'ak-night-worker';

await runPersonaEngine({
  headless: true, // 默认无头后台运行
  mouseTrail: false,
  verbose: false,
  personaId,
});
