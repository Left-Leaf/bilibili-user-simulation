# bilibili-user-simulation

人格驱动的 B 站养号 + 被动蹲饼引擎（**独立 git 仓库 / 可独立启动**的依赖包）。

- `src/persona/` ① 人格管理（任务概率调控：transition 马尔科夫 / circadian / loader）
- `src/action/` ② 行为执行（生成器 PersonaDrivenGenerator + 执行器 TaskExecutor + 14 任务）
- `src/business/` ③ 蹲饼分发（passive-fetch 被动监听动态流 / fetch-coordinator 协调 / record 录屏）

运行语义：真实时间（无加速）· 无时长上限 · 无限循环直到 Ctrl+C。运行数据（人格/登录态/logs/配置）
都在本仓库内，任意位置启动均有效（包根相对解析，不依赖宿主 cwd）。

## 两种使用方法

### 1) example：独立启动（包内自带入口）

```bash
npm install
npm run start:headless   # 无头后台（-- [人格id]，默认 data/personas/ak-night-worker.json）
npm run start:headed     # 有头观察
npm run typecheck
```

- 人格默认取包内 `data/personas/{id}.json`；
- 动态出口读 `config-app.json5`：`fetch_report` 外发接口，未配置则写本地 `logs/fetched-dynamics.md`；
- 首次登录：启动后向 stdin 输入 `login` 扫码（有头弹窗 / 无头终端二维码）。
- stdin 指令：`login` `logout` `reload` `online` `record on|off` `status` `help`。

### 2) 模块：被主项目 import 后由主项目启动

```ts
import { runPersonaEngine } from 'bilibili-user-simulation'; // 库入口 = src/index.ts

await runPersonaEngine({
  headless: true,
  personaFile: '/path/to/my-persona.json', // ① 指明人格配置文件（也可传 persona 对象）
  onDynamics: (dynamics, kind) => {         // ② 注册动态监听，接收模块内部捕获的动态
    // kind: 'INIT'（初始加载） | 'UPDATE'（轮询更新）
  },
});
```

- 注册 `onDynamics` 后即为**模块模式**：捕获的动态交给主项目回调，不再读 `config-app.json5`
  自动外发/写本地文档（出口由主项目决定）。
- 也可直接 `setDynamicListener(fn)` / `loadPersonaFromFile(path)`（见 `src/index.ts` 导出）。
- 可运行示例：`ts-node run/example-module.ts <人格JSON路径>`。

## 目录

```
src/    库源码（index.ts = 库入口）
run/    example 启动入口：run-headless/run-headed（独立启动）、example-module（模块用法示例）、
        persona-engine.ts（引擎实现，双模式共用）
data/personas/  内置人格（ak-night-worker.json）
config-app.json5  被动蹲饼外发/录屏配置（example 模式读）
```

> 注意：本包作为 git/file 依赖被主项目引用时，主项目需自行提供 `puppeteer` 可执行环境
> （或在其 `.npmrc` 设 `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true`，并配置系统 Chrome 路径）。
