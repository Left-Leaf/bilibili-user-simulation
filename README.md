# bilibili-user-simulation

人格驱动的 B 站养号 + 被动蹲饼引擎（Node.js / TypeScript，Puppeteer）。

- **模拟行为**：按人格生成并执行拟人化任务流 —— 首页推荐流浏览、动态页浏览、UP 主页浏览、
  打开 / 观看 / 关闭视频、点赞、三连、评论、关注、搜索、休息。
- **被动蹲饼**：常驻动态页，把关注流里**全部 UP** 的动态按「增量、不缺失」投递给宿主。
- **内核 `SimulationKernel`**：全局单例，统一持有浏览器会话；两个功能**互相独立**，可任意组合开关。

## 环境要求

- Node.js 18+（建议 20 / 22）
- Puppeteer 可用的 Chrome（首次运行会下载）

## 安装

```bash
npm install
```

## 快速开始

```bash
npm run start                                            # 默认人格 data/personas/ak-night-worker.json
npm run start -- <personaId>                             # 指定人格（personaId = 人格目录下的文件名）
npm run start -- <personaId> <personaDir>                # 指定人格目录（如主项目自己的 data/personas）
npm run start -- <personaId> <personaDir> <baselineTs>   # 指定增量基线（上次 stopFetch() 的返回值）
```

启动流程：打开浏览器 → 未登录则等待扫码（持久化登录态有效时自动跳过）→
`startFetch()` 打开蹲饼 → `startSimulation()` 打开模拟行为 → 持续运行直到 `Ctrl+C`；
退出时会关闭蹲饼并打印**本次最终基线**。

`baselineTs` 是**秒**时间戳：该时间之后的动态都会被获取并投递。
宿主应保存 `stopFetch()` 的返回值，下次启动传回即可无缝续接；不传则从当前时间开始。

## 作为依赖库使用

内核对外只暴露六类能力（另有主动关注）：

```ts
import { kernel } from 'bilibili-user-simulation';

// ① 生命周期：初始化（开浏览器 + 确保登录，不启动任何功能）/ 销毁
await kernel.initialize({ headless: true, personaId: 'ak-night-worker' });
// 指向自己的人格目录：kernel.initialize({ personaDir: '/my-app/data/personas', personaId: 'my-persona' });
await kernel.destroy(); // 停止全部、关闭浏览器、清除初始化信息与订阅

// ② 人格配置：加载 / 运行态热替换
await kernel.loadPersona({ personaId: 'my-persona' }); // 运行中调用：立即生效，不打断当前任务流
kernel.listPersonas();                                // 列出人格目录下全部可用人格

// ③ 模拟行为：启动 / 彻底中止（无暂停态）
await kernel.startSimulation();
await kernel.stopSimulation();

// ④ 动态获取：启动 / 关闭（关闭会取消监听并关闭动态页标签，并返回本次最终基线）
await kernel.startFetch();                 // 缺省基线 = 当前时间
await kernel.startFetch({ baselineTs });   // 传上次 stopFetch() 的返回值 → 基线之后的动态全部获取，不缺失
const baseline = await kernel.stopFetch(); // 保存它，下次启动传回即可无缝续接

// ⑤ 动态监听器：传入回调，返回订阅器（类似 Flutter StreamSubscription）
const sub = kernel.createDynamicListener((items, kind) => {
  // items = B 站动态接口原始 item 数组（不做任何筛选，按 UP / 关键词过滤由调用方自己决定）
  // kind  = 'INIT' | 'UPDATE'：'INIT' 只出现一次（本次 startFetch 的首次投递），其余都是 'UPDATE'
  // ⚠️ 两种 kind 都是「增量」（只含基线之后、没投递过的动态），不是全量快照 → 追加即可，别按 INIT 重建列表
});
sub.active;   // 是否仍在订阅
sub.cancel(); // 取消订阅（幂等）

// ⑥ 登录：登录 / 退出（都会先关闭蹲饼与模拟，让登录流程独占浏览器）
await kernel.login();
await kernel.logout();

// 另有：主动关注 UP（独立操作，全部在临时标签页完成，不中断当前任务流）
await kernel.followUp('161775300'); // → { uid, name, status: 'followed' | 'now-followed' | 'failed' }
```

### 接口一览

| 接口 | 说明 |
| --- | --- |
| `initialize(options)` | 打开浏览器并确保登录，**不启动任何功能**。`headless`（默认 `true`）+ `userDataDir` / `browserArgs` / `waitForLogin`（默认 `true`）/ `verbose` 等，以及人格来源；详见 `KernelInitializeOptions` |
| `destroy()` | 停止模拟与蹲饼、关闭浏览器、清除初始化信息与全部订阅（可再次 `initialize()`） |
| `loadPersona(options)` | 加载或**运行态热替换**人格配置（立即生效，不打断任务流） |
| `listPersonas()` | 列出当前人格目录下全部可用人格（`personaId` = 文件名） |
| `startSimulation()` / `stopSimulation()` | 启动 / 彻底中止模拟行为（**无暂停态**）。`stopSimulation()` 阻塞生成器 → 等当前任务收尾 → 清理不再需要的页面 |
| `startFetch(options)` | 打开动态页并监听更新。`baselineTs` = 增量基线（秒）；`initialTimeoutMs`（默认 25000）；`watchdogIntervalMs`（默认 60000）。返回是否「已覆盖基线」 |
| `stopFetch()` | 取消监听并关闭动态页标签；**返回本次最终基线**（秒），保存后下次传给 `startFetch` 即可无缝续接 |
| `createDynamicListener(cb)` | 创建动态监听器，返回订阅器（`active` / `cancel()`） |
| `login()` / `logout()` | 登录（未登录则等待扫码）/ 退出登录（浏览器保持打开） |
| `followUp(uid, opts)` | 主动关注 UP。`holdTasks`（默认 `true`）= 这几秒内暂停派发新任务，避免与本操作竞争标签页 |

人格来源优先级：`persona`（直接传对象）> `personaFile`（文件路径）> `personaDir` + `personaId`。

### 语义要点

- **未登录时 `startFetch()` / `startSimulation()` 直接抛错**（登录是最高优先级操作，先 `await kernel.login()`）。
- `startFetch()` / `startSimulation()` **重复调用幂等**；`startSimulation()` 每次都从零开始（状态机 reset）。
- **蹲饼开启期间不会产生长休息**：长休息会关闭浏览器 / 长时间停止活动，会让蹲饼失效 ——
  开启蹲饼时生成侧直接不采样该状态（若此刻正在长休息，会先把它停掉）。
- `login()` / `logout()` 会**先关蹲饼、再关模拟**，然后独占浏览器执行登录 / 登出。
- **基线不落盘**：库不写任何基线文件，基线由宿主自己保存（`stopFetch()` 的返回值，
  或已收到动态里 `pub_ts` 的最大值）。
- 出口数据是 **B 站原始 item**；配套只读辅助：`dynId` / `dynAuthor` / `dynPubTs` / `dynPubTimeText` / `dynText`。

## 人格配置 `data/personas/*.json`

**文件名即 personaId**（JSON 里的 `id` 与之不一致时以文件名为准）。
人格只需写想改的字段，缺失部分自动与内置默认值深层合并。
字段说明见 `src/persona/types.ts` 与 `src/persona/defaults.ts`。

运行中换人格：`await kernel.loadPersona({ personaId: 'other' })` —— 立即生效、不重启模拟、不打断当前任务流。

## 目录结构

```
run/run-kernel.ts   唯一启动入口（npm run start）
src/kernel/         内核（全局单例，对外唯一入口）
src/persona/        人格加载与状态转移（Markov 游走）
src/action/         任务生成 / 执行 / 各类任务与拟人行为
src/business/       被动蹲饼 / 蹲饼-任务协调 / 主动关注
src/utils/          页面工具（DOM 提取、运行时 shim、路径）
vendor/             jsQR（终端扫码）
data/personas/      人格配置
```

## 注意事项

- 运行数据固定放在**包根**，不随 `personaDir` 变化：登录态 `puppeteer-browser/data`、日志 `logs/`（均已 gitignore）。
- 请用 `Ctrl+C` 退出，避免残留 Chrome 进程锁住 `puppeteer-browser/data`。
- **长时间无人值守运行建议脱离编辑器终端**（用独立控制台 / 服务启动）：曾观察到编辑器终端下的运行被
  **整棵进程树静默结束**（日志突然中断、零错误输出、`process.on('exit')` 不触发、无崩溃记录），
  而同一命令在独立终端里可以稳定长跑。
- 启动入口内置进程级探针（`exit` / `unhandledRejection` / `uncaughtException` / `SIGTERM`），
  便于区分「代码自己退出」与「被外部强杀」。
- 类型检查：`npm run typecheck`。
