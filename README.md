# bilibili-user-simulation

人格驱动的 B 站养号 + 被动蹲饼引擎（**独立 git 仓库 / 可独立启动**的依赖包）。

- `src/persona/` ① 人格管理（任务概率调控：transition 马尔科夫 / circadian / loader）
- `src/action/` ② 行为执行（生成器 PersonaDrivenGenerator + 执行器 TaskExecutor + 14 任务）
- `src/business/` ③ 蹲饼分发（passive-fetch 被动监听动态流 / fetch-coordinator 协调 / record 录屏）
- `src/kernel/` ④ **内核（SimulationKernel）**：全局静态单例，初始化（开浏览器并登录）后按需**独立开关**模拟行为 / 蹲饼，并支持指令控制

运行语义：真实时间（无加速）· 无时长上限 · 无限循环直到 Ctrl+C。运行数据（人格/登录态/logs/配置）
都在本仓库内，任意位置启动均有效（包根相对解析，不依赖宿主 cwd）。

## 三种使用方法

### 1) example：独立启动（包内自带入口）

```bash
npm install
npm run start:headless   # 全自动引擎·无头后台（-- [人格id]，默认 data/personas/ak-night-worker.json）
npm run start:headed     # 全自动引擎·有头观察
npm run start:kernel     # 内核模式·初始化后由指令开关功能（见下「内核」）
npm run typecheck
```

- 人格默认取包内 `data/personas/{id}.json`；
- 动态出口读 `config-app.json5`：`fetch_report` 外发接口，未配置则写本地 `logs/fetched-dynamics.md`；
- 登录：启动后若未登录会自动进入**强制登录闸门**并弹出二维码（有头窗口 / 无头终端二维码）等待扫码，
  登录成功后才开始后续流程（蹲饼目标对齐 → 动态页 → 模拟行为）；退出登录/等待重登时可用 `login` 指令重新扫码。
- 引擎运行时通过 **stdin** 接收指令（见下「运行时指令」）：`login` `logout` `reload` `online` `record on|off` `status` `help`。

### 2) 内核：初始化后按需独立开关（推荐给主项目）

```ts
import { kernel } from 'bilibili-user-simulation'; // 全局静态单例（SimulationKernel.getInstance() 同义）

await kernel.initialize({ headless: true, personaId: 'ak-night-worker' }); // ① 打开浏览器并登录（幂等；登录态有效免扫码）
// 主项目接入：指向自己的人格目录，personaId 就是该目录下的文件名
// await kernel.initialize({ headless: true, personaDir: '/host/data/personas', personaId: 'my-persona' });
await kernel.startFetch();        // ② 打开蹲饼（可独立开关）
await kernel.startSimulation();   // ② 打开模拟行为（可独立开关）
...
await kernel.stopSimulation();    // 只关模拟行为（蹲饼继续跑）
await kernel.stopFetch();         // 只关蹲饼（浏览器保持）
await kernel.shutdown();          // 全部关闭 + 退出浏览器
```

| 方法 | 作用 |
| --- | --- |
| `initialize(options)` | 打开浏览器并确保登录；**不启动任何功能**（人格：`personaDir` + `personaId`，或 `personaFile` / `persona`） |
| `startSimulation()` / `stopSimulation()` | 打开 / **彻底结束**模拟行为（任务流） |
| `startFetch()` / `stopFetch([closePage])` | 打开 / 关闭蹲饼（动态流捕获） |
| `login()` | 确保登录（未登录则扫码） |
| `shutdown()` | 停止全部 + 关闭浏览器 |
| `getStatus()` / `getDynamics(n)` | 状态快照 / 已捕获动态（B 站原始 item） |
| `listPersonas()` / `personaDir` | 当前人格目录下全部可用人格（`personaId` = 文件名）/ 当前人格目录 |
| `followUp(uid, opts)` | **主动关注某个 UP**（独立操作，不进入任务流，见下） |
| `executeCommand(line)` / `attachConsole(opts)` | 指令控制（见下「内核指令」） |

**人格目录（personaId = 文件名）**：`personaDir` 指向人格目录（默认包内 `data/personas`），
`personaId` 即该目录下的**文件名**（不含 `.json`）—— 按 `{personaDir}/{personaId}.json` 查找。
主项目作为依赖库导入时，指向自己的目录即可，**换人格只改 personaId**：

```ts
import { listPersonas, kernel } from 'bilibili-user-simulation';

const personaDir = '/host/data/personas';
console.log(listPersonas(personaDir).map((p) => p.id));   // ['ak-night-worker', 'my-persona', ...]
await kernel.initialize({ personaDir, personaId: 'my-persona' }); // 加载 personaDir/my-persona.json
```

- **文件名即 personaId**：JSON 里的 `id` 字段若与文件名不一致，以**文件名**为准（唯一且可预测）；
- 人格文件只需写想改的字段（与包内默认值深层合并）；
- 找不到时抛错并列出该目录下**可用的人格 id**；
- 也可用 `personaFile`（任意路径的单个人格文件）或 `persona`（直接传对象，优先级最高）。

**`stopSimulation()` 的停止流程**（不中断执行器，只阻塞生成器 + 中止持续性任务）：

1. **阻塞生成器** → 执行器不再生成下一个任务；
2. **中止持续性任务** → `fetchCoordinator.abortCurrentTask()` → `controller.abort()`（调用任务的「中断处理」→ 等主体收尾）；
   浏览 / 观看 / 休息类任务立即结束；非持续性短任务（点赞 / 搜索 / 开关视频等）不可中断，等它自然做完；
3. 等执行器跑完最后一个任务（并完成 ③ 结束处理 → 生成后一个状态）；
4. **清理页面** —— 蹲饼未开启：页面全部关闭（浏览器保持打开，下次 `startSimulation()` 自动重建主页）；蹲饼已开启：只保留蹲饼用的动态页。

> 模拟行为只有「从零打开」与「彻底结束」两种状态，**没有暂停态**。

### 3) 模块：被主项目 import 后由主项目启动（全自动引擎）

```ts
import { runPersonaEngine } from 'bilibili-user-simulation'; // 库入口 = src/index.ts

await runPersonaEngine({
  headless: true,
  personaDir: '/host/data/personas', // ① 人格目录（personaId = 该目录下的文件名）
  personaId: 'my-persona',
  onDynamics: (dynamics, kind) => {         // ② 注册动态监听，接收模块内部捕获的动态
    // kind: 'INIT'（初始加载） | 'UPDATE'（轮询更新）
  },
});
```

- 也可用 `personaFile: '/path/to/my-persona.json'`（单个文件任意路径）或 `persona: {...}`（直接传对象）。

- 注册 `onDynamics` 后即为**模块模式**：捕获的动态交给主项目回调（`items` 为 **B 站接口原始对象数组**，
  见下「蹲饼数据格式」），不再读 `config-app.json5` 自动外发/写本地文档（出口由主项目决定）。
- 也可直接 `setDynamicListener(fn)` / `loadPersonaFromFile(path)`（见 `src/index.ts` 导出）。
- 可运行示例：`ts-node run/example-module.ts <人格JSON路径>`。

## 运行时指令（stdin）

### 全自动引擎指令（`runPersonaEngine`：run-headless / run-headed）

引擎运行中在**终端（stdin）输入一行指令**即可控制（模块接入时复用宿主进程的 stdin）。

| 指令 | 名称 | 说明 |
| --- | --- | --- |
| `login` | 登录 | 强制执行登录流程（弹出/重打二维码等待扫码）。启动后未登录会自动进入登录闸门，一般无需手动输入；用于「退出登录后 / 等待重登态」解除等待重新扫码，或换号登录。 |
| `logout` | 退出登录 | 退出当前账号：中断当前任务流，收尾执行 LogoutTask 登出 → 下线；浏览器保持打开（仅 B 站主页），等待重新登录。 |
| `online` | 强制唤醒（上线） | 强制结束当前休息——无论是长休息任务（RestTask 已关浏览器离线）还是会话间的下线休息倒计时——立即重新打开浏览器 → 过登录闸门 → 重新开动态页开始获取动态 → 进入模拟用户行为。 |
| `reload` | 热重启 | 结束当前上线周期，**重载人格配置**后立即重新上线（跳过下线休息）。改 `data/personas/*.json`（人格 / `fetch_targets` 蹲饼目标）后用此令生效。 |
| `record on` / `record off` | 蹲饼录屏开关 | 开关蹲饼录屏（CDP screencast → `logs/screencast/`，用于回放定位「取不到新动态」原因）；写回 `config-app.json5` 的 `fetch_recording`，重启后仍生效。输入 `record` 查询当前开关状态。 |
| `status` | 状态快照 | 打印：人格 / 上线次数 / 任务统计 / 生成器主状态 / 当前页面 URL / 标签页 / 上一任务 / 登录态 / 被动蹲饼已抓动态 / 控制标志。 |
| `help` | 帮助 | 列出全部可用指令。 |

> Ctrl+C：优雅关闭浏览器并退出（避免 Chrome 孤儿进程锁住 `puppeteer-browser/data`）。

### 内核指令（`SimulationKernel`）

内核模式下用同一套指令系统：`kernel.attachConsole()` 挂 stdin（`run-kernel` 即此用法），也可
`await kernel.executeCommand('sim off')` 从 IPC / HTTP / 宿主代码下发，或用 `kernel.registerCommand()` 扩展指令。

| 指令 | 说明 |
| --- | --- |
| `sim on` | **从零打开**模拟行为（重置生成器状态机） |
| `sim off` | **彻底结束**模拟行为（阻塞生成器 → 持续式任务收尾 → 清理页面） |
| `fetch on` | 打开蹲饼（目标 UP 对齐 → 动态页 → 初次获取 → 守护） |
| `fetch off [close]` | 关闭蹲饼（保留监听与增量基线，便于快速重开；加 `close` 同时关闭动态页标签） |
| `follow <uid> [no-hold]` | **主动关注 UP**（独立操作，不进任务流；`no-hold` 连「暂停生成新任务」也不做） |
| `login` | 确保登录（未登录则扫码） |
| `status` | 打印内核状态快照（初始化 / 登录态 / 两个功能 / 当前页面 / 动态数） |
| `dynamics [n]` | 查看最近捕获的动态（默认 5 条，按原始字段展示摘要） |
| `help` | 列出全部可用指令 |

### 主动关注 UP（`follow` / `kernel.followUp()`）

一次性操作，**不进入模拟任务流**（生成器 / 执行器都不参与），且对正在运行的模拟任务**不做破坏性干扰**：

- 全部操作在**临时标签页**上完成（打开 UP 主页 → 判断是否已关注 → 未关注则拟人点击「关注」），
  结束后**立即关闭**；从不改动主操作页（`ctx.page`）、**不中断正在执行的任务**；
- 模拟行为运行时，仅在这几秒内**暂停「生成新任务」**（防止恰好有「关闭视频标签 / 切换主操作页」
  的任务与本次操作竞争标签页）；传 `no-hold`（或 `holdTasks: false`）则完全不干预；
- **幂等**：已关注直接返回 `status: 'followed'`，不会重复点击；
- 仅支持按 **uid**（纯数字）关注；失败返回 `status: 'failed'` + `detail`（如 uid 缺失、按钮不可用）。

```ts
const r = await kernel.followUp('161775300');            // 或 { uid: '161775300', name: '明日方舟' }
// r: { target, status: 'followed' | 'now-followed' | 'failed', detail }
await kernel.executeCommand('follow 161775300');          // 指令通道（留空 / 非数字会给出用法提示）
await kernel.followUp('161775300', { holdTasks: false }); // 完全不干预任务流
```

> 与蹲饼目标对齐（`syncFetchTargets`）的区别：后者在**主操作页**上导航，只应在启动阶段调用；
> 本功能随时可用（含模拟运行中），不会影响任务流。

## 蹲饼数据格式（出口 = B 站接口原始数据）

蹲饼的出口数据**就是 B 站动态流接口 `data.items[]` 的原始对象**（不裁剪、不改名、不合成字段），
字段与接口完全一致，宿主可直接按 B 站字段使用：

| 出口 | 数据 |
| --- | --- |
| `onDynamics(items, kind)` / `setDynamicListener` | `BiliDynamicItem[]`（原始对象数组；`kind: 'INIT' \| 'UPDATE'`） |
| `fetch_report` 外发 | `{ source, kind, captured_at, count, items: BiliDynamicItem[] }` |
| `logs/fetched-dynamics.md` | 可读 Markdown（作者 / 时间 / 正文摘要） |
| `kernel.getDynamics(n)` / `dynamics [n]` 指令 | `BiliDynamicItem[]` |

**原始 item 结构**（实测，`GET api.bilibili.com/x/polymer/web-dynamic/v1/feed/all`）：

```
id_str, type, visible, basic{}, modules{}, orig
└─ modules
   ├─ module_author: mid(number), name, face, jump_url, following,
   │                 pub_ts(string 秒), pub_time(相对文本如「18分钟前」), vip{}, pendant{}, official_verify{}
   ├─ module_dynamic
   │   ├─ desc: null | { text, rich_text_nodes[] }
   │   ├─ major: { type: "MAJOR_TYPE_OPUS|ARCHIVE|DRAW|LIVE_RCMD|…",
   │   │           opus{ jump_url, title, summary{ text, rich_text_nodes[] }, pics[{ url, width, height, size }] },
   │   │           archive{ bvid, title, cover, duration_text, stat{ play, danmaku, … } },
   │   │           draw{ id, items[{ src, width, height, size }] }, live_rcmd{}, article{}, … }
   │   └─ additional: { type: "ADDITIONAL_TYPE_GOODS|VOTE|COMMON|…", goods{}, vote{}, … }
   ├─ module_stat: forward / comment / like 各自 { status, count, forbidden, disabled, silent, hidden }
   └─ module_more / module_tag / module_interaction / module_share_view / …
```

**图片 / 视频资源不会被丢弃**：它们原样保留在 `major.*` 里（`opus.pics[].url`、`draw.items[].src`、
`archive.bvid` / `archive.cover` 等），由宿主自行取用。

**便捷读取辅助**（只读，不修改数据）：`dynId(item)`、`dynAuthor(item)`（`{ uid, name }`）、
`dynPubTs(item)`（绝对秒时间戳）、`dynPubTimeText(item)`（接口相对文本）、
`dynText(item, maxLen?)`（正文：`desc.text` → `major.opus.summary.text` → `archive.title` →
`draw` 计数 → 转发原动态 → `[TYPE]` 兜底）。

> 注意：接口中 `update_num`、`pub_ts` 是**字符串**；`pub_time` 是**相对时间**（如「18分钟前」），
> 需要绝对时间请用 `dynPubTs()`。转发动态的原动态在 `orig`（结构同 item）。

### 蹲饼与「长休息」的联动

长休息会**关闭浏览器 / 长时间停止活动**，会让蹲饼失效，因此内核按以下规则自动联动（无需使用者关心）：

| 条件 | 行为 |
| --- | --- |
| 蹲饼**已开启** | 任务生成侧把「长休息」**权重置 0**（`fetchCoordinator.longRestDisabled`）：Rest 注册表的长休息概率强制为 0；状态机采样到 `BROWSER_CLOSED` 也改写为继续浏览 ⇒ **永不长休息**（短休息不受影响） |
| 蹲饼**关闭**且在长休息中，此时**开启蹲饼** | 先**停止长休息**（用「强制上线」机制中断 Rest 等待循环）→ 再开蹲饼 → 然后继续后续流程 |
| 蹲饼**关闭** | 恢复人格原本的长休息概率（`setLongRestDisabled(false)`） |

> 内核模式下 `RestTask` 的长休息本身也已降级为「停止活动、浏览器保持打开」（`ctx.state.preventBrowserClose`）；
> 上面的权重置 0 是更前置的规避手段，两者叠加保证蹲饼不会被长休息打断。
> 相关实现：`fetch-coordinator.ts`（`longRestDisabled`）、`task-registrations.ts`（Rest 注册表）、
> `persona-generator.ts`（BROWSER_CLOSED 分支）、`rest.ts`（`ctx.state.currentRest` 标记）、`kernel.startFetch()`。

## 任务的统一执行模型（开始 / 执行 / 结束 + 控制器）

执行器对**每一个任务**固定按三段调用，状态流转是强制流程：

```text
preCheck(context)          前置检查（不通过则跳过）
   ↓
onStart(context)           ① 开始处理：载入「前一个状态」（context.currentState）
   ↓
execute(context)           ② 执行：只做事 / 产出数据，不生成状态
   ├─ 一次性任务 → 返回 TaskResult
   └─ 持续性任务 → 返回 TaskController（执行器 await controller.done）
   ↓
onEnd(context, outcome)    ③ 结束处理：生成「后一个状态」（TaskResult.nextState）
```

- **开始函数负责载入前一个状态**：`BaseTask.onStart()` 默认把 `context.currentState`
  （上一任务 onEnd 生成并写入）载入到 `this.prevState`；子类覆盖时必须 `await super.onStart(context)`。
- **结束函数负责生成后一个状态**：任务在 `execute()` 里用 `this.setNextState(...)`（或 `finishWith()`）
  声明落点，`BaseTask.onEnd()` 默认把它合并进最终结果；执行器据此更新 `context.currentState`，
  供下一个任务的开始函数载入。未声明则沿用前一个状态（状态机不变）。`onEnd` 即使 `execute` 抛错也会被调用。
- **持续性任务**（`BrowseHome` / `BrowseProfile` / `BrowseDynamic` / `WatchVideo` / `Rest`）：
  - `execute()` 立即返回 `TaskController`，任务主体在后台运行；`controller.done` **只表示任务是否结束**，不带结果；
  - 结果存在任务状态里（`this.result`），由 ③ 结束函数读取；
  - 主体用 `controller.dwell(ms)` / `controller.waitIfPaused()` 做可中断 / 可暂停的分片等待；
  - **中止**（`controller.abort()` = 调用任务的 `onInterrupt()` → 等主体收尾 → 结束异步进程），
    执行器等到 `done` 结束后才调用 `onEnd`；
  - 谁来中止：被动蹲饼让位、内核 `sim off` 停止模拟（都经 `fetchCoordinator.abortCurrentTask()`）。
- 中断语义：持续性任务被中断后若只是**让位**（如蹲饼插队），主体返回 `success: true + data.interrupted`
  ⇒ 任务流继续；只有 `status: interrupted/terminated` 才会终止整条任务流。

## 人格配置字段说明（data/personas/*.json）

人格 = 养号行为 + 蹲饼目标的「人设」。按 `{personaDir}/{personaId}.json` 查找（**personaId = 文件名**），
加载时会与 `src/persona/defaults.ts` 的默认值**深层合并**，缺省字段自动兜底——只需写想改的字段。
示例：`data/personas/ak-night-worker.json`（包内）；主项目可放自己的 `data/personas/` 并用 `personaDir` 指向。

### 顶层

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 人格 id（展示/兼容用）；**实际以文件名为准**（`personaId` = 文件名，二者不一致时以文件名为准） |
| `meta` | object | `name`/`description`/`age`/`occupation`/`gender`(`male\|female`)/`bio`，展示用 |
| `state_transition_bias` | object | **状态转移偏置**（人格差异根源）：`from状态 → { to状态: 乘性系数 }`，稀疏、缺省 1.0=常人；调制 BASE_MATRIX 后归一化，马尔科夫游走据此涌现行为序列 |
| `initial_state_dist` | object | 上线起点分布：`状态名 → 概率`（替代「目的→入口」） |
| `interests` | object | 兴趣偏置（内容相关度） |
| `fetch_targets` | array | **蹲饼目标 UP**（指向性动态获取）：`[{ uid?, name }]`。引擎登录后确保关注这些 UP，其动态被定向捕获/投递 |

`interests`：
- `keywords: string[]` —— 搜索/内容偏好关键词
- `up_uid_affinity: Array<{ uid?, name }>` —— 关注的 UP（名字为主、uid 可选）
- `category_bias: Record<tname, number>` —— 分区(如「游戏」)权重

`fetch_targets`（蹲饼指向性）：
- 数组元素 `{ uid, name }`，**uid 优先**（直接进主页关注）；name 用于展示
- 引擎启动/重载时注入 passive-fetch：非空时**只捕获/投递这些 UP 的动态**；空数组 = 不过滤（捕获关注流全部）

### `behavior` —— 行为习惯（多数 0..1 概率或区间）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `dwell_time` | object | 各状态停留时长 `[均值, 标准差]`（秒），键如 `home_feed`/`content_consuming`… |
| `scroll_speed_px_per_sec` | `[min,max]` | 滚动速度区间（px/s） |
| `scroll_pause_prob` | 0..1 | 滚动中停下细看概率 |
| `scroll_back_prob` | 0..1 | 回滚重看概率 |
| `like_prob` / `coin_prob` / `collect_prob` / `comment_prob` / `share_prob` | 0..1 | 点赞/投币/收藏/评论/转发概率 |
| `follow_prob` | 0..1 | UP 主页关注概率 |
| `binge_watch_tendency` | 0..1 | 连刷倾向（看完一个视频继续刷推荐） |
| `video_watch_ratio` | `[min,max]` | 视频观看比例（如 0.3~0.9 后退出） |
| `early_exit_prob` | 0..1 | 10s 内提前退出视频概率（秒关） |
| `close_video_after_watch_prob` | 0..1 | **看完视频后关闭标签页权重**：命中则观看结束即关视频页回非视频页（不连刷/不在视频页做其它任务）；**≥1 恒关闭** |

### `error_rate` —— 拟人失误倾向

`misclick_prob` / `typo_prob` / `premature_close_prob` / `double_click_prob` / `back_button_prob` / `idle_wander_prob`(0..1)，
`idle_wander_duration_ms: [min,max]`(漫游时长 ms)，`skip_interaction_prob`(0..1)。

### `circadian` —— 作息（决定在线/休息节奏）

| 字段 | 说明 |
| --- | --- |
| `chronotype` | `morning_lark\|afternoon_peak\|night_owl\|reversed`（示例夜猫子） |
| `peak_width_hours` | 活跃高峰宽度（小时） |
| `sleep_time` | 睡眠段 `[起,止]` 小时，支持跨午夜（如 `[2,9]`），睡眠段强制离线 |
| `online_minutes` | 单次在线时长范围 `[min,max]`（分钟），意愿高时更持久 |
| `offline_minutes` | 两次在线间休息范围 `[min,max]`（分钟） |

> 完整类型定义见 `src/persona/types.ts`；默认值见 `src/persona/defaults.ts`（BASE_MATRIX 转移矩阵、DEFAULT_BEHAVIOR、DEFAULT_ERROR_RATE）。

## 目录

```
src/      库源码（index.ts = 库入口）
src/kernel/   内核（SimulationKernel 单例 + commands 指令系统）
run/      example 启动入口：run-headless/run-headed（全自动引擎）、run-kernel（内核模式·指令控制）、
          example-module（模块用法示例）、persona-engine.ts（引擎实现，双模式共用）
data/personas/  内置人格（ak-night-worker.json）
config-app.json5  被动蹲饼外发/录屏配置（example 模式读）
```

> 注意：本包作为 git/file 依赖被主项目引用时，主项目需自行提供 `puppeteer` 可执行环境
> （或在其 `.npmrc` 设 `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true`，并配置系统 Chrome 路径）。
