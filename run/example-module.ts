/**
 * example（模块用法）：演示「把 persona-engine 作为依赖包导入，由主项目调用启动」。
 *
 * 与 run-headless/headed（example 独立启动：包内默认人格 + config-app 出口）不同，
 * 本文件展示模块接入的两个关键点：
 *  - personaFile：指明外部人格配置文件（主项目自己的，而非包内 data/personas）
 *  - onDynamics： 注册动态监听，接收模块内部被动蹲饼捕获的动态（此时不再自动外发/落盘）
 *
 * 用法（cwd = 本包根）：
 *   npx --node-options="--experimental-specifier-resolution=node --no-warnings --loader ts-node/esm" \
 *       ts-node --project tsconfig.json run/example-module.ts <人格JSON路径> [人格id]
 */
import { runPersonaEngine } from '../src/index.js';

const personaFile = process.argv[2];
if (!personaFile) {
  console.error('用法: ts-node run/example-module.ts <人格JSON文件绝对路径>');
  process.exit(1);
}

await runPersonaEngine({
  headless: true,
  personaFile, // 指明人格配置文件（主项目自己的）
  onDynamics: (dynamics, kind) => {
    // 注册动态监听：模块内部每次捕获到一批动态即回调（初始加载 INIT / 轮询更新 UPDATE）
    console.log(`[模块回调] 捕获 ${dynamics.length} 条动态 (${kind})`);
    for (const d of dynamics.slice(0, 5)) {
      console.log(`  - ${d.author || d.uid}: ${(d.text || '(无文案)').slice(0, 40)}`);
    }
  },
});
