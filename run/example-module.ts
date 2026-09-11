/**
 * example（模块用法）：演示「把 bilibili-user-simulation 作为依赖包导入，由主项目调用启动」。
 *
 * 与 run-headless/headed（example 独立启动：包内默认人格 + config-app 出口）不同，
 * 本文件展示模块接入的三个关键点：
 *  - personaDir：指明**主项目自己的**人格目录（如 <主项目>/data/personas）。
 *    **personaId 就是该目录下的文件名**：`{personaDir}/{personaId}.json`；
 *  - onDynamics：注册动态监听，接收模块内部被动蹲饼捕获的动态（此时不再自动外发/落盘）；
 *  - listPersonas：列出人格目录下全部可用人格（文件名即 id），供使用者选择。
 *
 * 用法（cwd = 本包根）：
 *   ts-node run/example-module.ts [人格目录] [personaId]
 *   # 默认：人格目录 = 包内 data/personas，personaId = ak-night-worker
 *   # 例：ts-node run/example-module.ts D:/my-app/data/personas my-persona
 */
import path from 'node:path';
import { listPersonas, runPersonaEngine } from '../src/index.js';

/** ① 人格目录（主项目自己的；省略则用包内 data/personas） */
const personaDir = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
/** ② personaId = 人格目录下的文件名（不含 .json） */
const personaId = process.argv[3] ?? 'ak-night-worker';

// 列出该目录下所有可用人格（文件名即 personaId）
const available = listPersonas(personaDir);
console.log(`[模块示例] 人格目录: ${personaDir ?? '(包内 data/personas)'}`);
console.log(
  available.length
    ? `[模块示例] 可用人格（${available.length}）: ${available.map((p) => p.id).join(', ')}`
    : '[模块示例] ⚠️ 该目录下没有 .json 人格配置'
);
console.log(`[模块示例] 使用 personaId: ${personaId}\n`);

await runPersonaEngine({
  headless: true,
  personaDir, // 指明人格目录（主项目自己的 data/personas）
  personaId, // 文件名即 personaId
  onDynamics: (dynamics, kind) => {
    // 注册动态监听：模块内部每次捕获到一批动态即回调（初始加载 INIT / 轮询更新 UPDATE）
    console.log(`[模块回调] 捕获 ${dynamics.length} 条动态 (${kind})`);
    for (const d of dynamics.slice(0, 5)) {
      console.log(`  - ${d.author || d.uid}: ${(d.text || '(无文案)').slice(0, 40)}`);
    }
  },
});
