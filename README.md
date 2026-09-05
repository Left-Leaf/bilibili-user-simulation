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
- 登录：启动后若未登录会自动进入**强制登录闸门**并弹出二维码（有头窗口 / 无头终端二维码）等待扫码，
  登录成功后才开始后续流程（蹲饼目标对齐 → 动态页 → 模拟行为）；退出登录/等待重登时可用 `login` 指令重新扫码。
- 引擎运行时通过 **stdin** 接收指令（见下「运行时指令」）：`login` `logout` `reload` `online` `record on|off` `status` `help`。

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

## 运行时指令（stdin）

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

## 人格配置字段说明（data/personas/*.json）

人格 = 养号行为 + 蹲饼目标的「人设」。加载时会与 `src/persona/defaults.ts` 的默认值**深层合并**，
缺省字段自动兜底——只需写想改的字段。示例：`data/personas/ak-night-worker.json`。

### 顶层

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 人格 id（引擎参数/指令里用；缺省用文件名） |
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
src/    库源码（index.ts = 库入口）
run/    example 启动入口：run-headless/run-headed（独立启动）、example-module（模块用法示例）、
        persona-engine.ts（引擎实现，双模式共用）
data/personas/  内置人格（ak-night-worker.json）
config-app.json5  被动蹲饼外发/录屏配置（example 模式读）
```

> 注意：本包作为 git/file 依赖被主项目引用时，主项目需自行提供 `puppeteer` 可执行环境
> （或在其 `.npmrc` 设 `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true`，并配置系统 Chrome 路径）。
