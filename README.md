# dsh-multi-session

在**一个会话里**同时看住所有会话：总览面板 + 并排对话流 + 直接发消息。

DSH 原生只给你当前这一个会话的界面。开了五六个会话并行跑的时候，谁跑完了、谁卡住了、
另一个会话到底在干什么，都得一个个点开看。这个插件把这几个动作搬进同一个视图里。

## 它解决什么

| 痛点 | 这个插件 |
| --- | --- |
| 想知道别的会话在聊什么，得点开再点回来 | 在面板里 `⊞` 钉住最多 3 个会话，并排看它们的**对话正文** |
| 分不清哪些在跑、哪些在等我 | 面板按「运行中 → 刚完成 → 其余」排序，带状态点、轮数、token、模型、相对时间 |
| 会话一大堆，找不到 | 按工作区（cwd）分组，子代理会话与归档会话默认折叠、可单独打开 |
| 不想点开就想知道结果 | 运行中/刚完成的卡片直接显示该会话最后一句助手结论 |
| 切来切去只为说一句话 | 并排列底部就是输入框，直接给那个会话发消息或打断它 |

## 界面在哪

- **「多会话」页签**：任意会话顶部视图切换条里，点进去是总览面板。
- **钉住并排**：面板里每个会话卡片标题行右侧的 `⊞`，最多钉 3 个；再点 `⊟` 取消。钉住的选择存 localStorage，关掉面板再回来还在。
- **并排输入框**：每列底部一个输入框，`Enter` 发送（排进收件箱，不打断当前回合），`Shift+Enter` 插话（立刻打断当前回合）；运行中的列另有「停止」按钮。

## 架构

Host 半边和 Client 半边各管一段，边界很清晰：

```
┌─────────────────── Client（浏览器） ────────────────────┐
│  conversation.view         ── MultiSessionPanel（列表 / 并排）│
│  session.header.actions    ── ActiveSessionProbe（记录当前会话）│
│  shell.overlay（仅 dev）    ── DiagOverlay（诊断层）          │
│                                                          │
│  数据：插槽 standardProps 的 useWorkspaces / useSessions  │
│  对话：fetch /plugins/dsh-multi-session/digest            │
│  操控：fetch /plugins/dsh-multi-session/prompt            │
└──────────────────────────┬───────────────────────────────┘
                           │ HTTP（同源，带 cookie，过 connection gate）
┌──────────────────────────┴───────────────────────────────┐
│  Host（index.js）                                        │
│  /digest  ── sessionQuery.observeSession → foldDigest     │
│  /prompt  ── sessionController.prompt / .cancel           │
│  /report  ── 客户端异常落盘（仅诊断用）                     │
│  /probe   ── 仅 dev：开发期探针                            │
│  /stamp /reload ── 仅 dev：发布新 bundle + 页面自动重载     │
└──────────────────────────────────────────────────────────┘
```

### 为什么对话流必须走 Host

客户端 `ctx.get('sessions').retain()` 能拿到 `SessionBinding`，`readiness` 也 resolved，
但 `eventSource.snapshot.entries` **永远是 0 条**——客户端事件窗只对「正被会话视图打开」
的那个会话填充。所以想看任意会话的对话，只能由 Host 读事件再喂给客户端。

### 为什么取数用 observeSession

同样读一个 139 轮 / 33513 事件的历史会话：

| 路径 | 运行中会话 | 历史会话 | 说明 |
| --- | --- | --- | --- |
| `sessionQuery.observeSession` | **5ms** | **72–318ms** | 直接给内存/已备好的事件快照，不做 replay 校验 |
| `sessionQuery.readSurface` | 246–1028ms | 2281–6176ms | 只给当前模型面，慢在 replay 校验 |
| `sessionQuery.readSession` | — | 5658–5740ms | 完整日志 + 校验，最慢 |
| `listEvents` + 逐条 `readEvent` | — | 每次 readEvent ≈ 1920ms | 完全不可用 |

`observeSession` 拿不到事件时自动退回 `readSurface`，响应里的 `source` 字段说明走了哪条路
（`live` / `prepared` / `surface`）。

**注意**：折叠完必须 `lease.dispose()`，不要 `lease.retain()`——后者会让会话被插件长期持有。

### 为什么只显示你和 AI 的对话

DSH 把运行时上下文、时间戳、技能目录变更、压缩摘要等都以 `user/message` 事件存进日志。
Host 侧 `foldDigest` 做三层过滤后才进面板：

- `tool/call`、`tool/result` 完全不搬（工具调用和输出对「看清这段聊了什么」是噪音）；
- `<system-reminder>` 整段剥掉；
- 以 `Current runtime context` / `Time sampled while` / `The available skill catalog changed` /
  `[Compressed conversation section]` / `Browser time zone for this request` 等开头的注入消息整条丢弃。

客户端 `renderDigestItem` 再兜一层：类型不是 `user` / `assistant` 的一律不渲染。

### 数据从哪来（客户端）

| 需要的东西 | 来源 |
| --- | --- |
| `running` / `cwd` / `parentId` / `updatedAt` / `projectionValues` | `props.useSessions(identity)` 的 `SessionMeta` |
| 工作区分组 / 归档会话 | `props.useWorkspaces(identity)` |
| 「当前是哪个会话」 | `conversation.session.header.actions` 插槽收到的 `props.sessionId` |

注意 `running` / `cwd` / `parentId` **只在 `useSessions` 里**，`useWorkspaces` 没有运行态；
也没有 `running` 的类型定义暗示它在工作区快照里（这条曾经害我写错两版）。

selector 必须是**模块级稳定引用**（`const identity = (state) => state`），否则每帧重订阅。

## 路由

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `/plugins/dsh-multi-session/digest` | GET | `?sessionId=&limit=&live=1&fresh=1&mode=` → `{ok, ms, source, turns, endReason, items}` |
| `/plugins/dsh-multi-session/prompt` | POST | `{sessionId, text, mode:'queue'\|'steer'}` 发消息；`{sessionId, action:'cancel'}` 停止 |
| `/plugins/dsh-multi-session/report` | GET/POST | 客户端异常上报，落盘到系统临时目录（保留最近 40 条） |
| `/plugins/dsh-multi-session/probe` | GET/POST | **仅 dev**：开发期探针 |
| `/plugins/dsh-multi-session/stamp` | GET | **仅 dev**：发布新 bundle 并回 `{rev}`，供页面自动重载轮询比对 |
| `/plugins/dsh-multi-session/reload` | GET | **仅 dev**：手动触发一次 bundle 重发布（只放行 loopback） |

所有业务路由都过 `connection.requestRejection(req)` 鉴权闸门（缺失 → 503，未授权 → 401/403）。
`curl` 直接请求会得到 `{"error":"unauthorized"}`，这是正常的——只有浏览器同源 fetch 带 cookie 才过。

`digest` 的 Host 侧缓存：键 `v4:${mode}:${live?'live':'idle'}:${sessionId}:${limit}`，
`live=1` 用 800ms TTL、空闲用 60 秒，`fresh=1` 绕过缓存，最多 200 条。
`live` 必须进键——否则会话刚跑完那一刻，空闲请求会命中「助手最后一句话还没写进去」的旧 payload。

## 安装

从市场装，或本地装：

```
plugin_manager action=install_bundle target=<插件目录或包名>
```

## 开发

开发期设施（诊断探针、`/stamp`、`/reload`、页面自动重载、客户端 `__internals` 测试出口）
**默认关闭**。打开方式二选一：

- 插件配置 `dev: true`（在 profile 的 patch 里给本插件加这一项）；
- 或环境变量 `DSH_MULTI_SESSION_DEV=1`（改完要重启 DSH 才生效）。

打开后 Host 会在 `index.html` 注入 `window.__DSH_MULTI_SESSION_DEV__ = true`，
客户端据此启用诊断层。

- **改 client.js**：`link:` 依赖是实时的，文件一变 `clientModules.rebuilt()` 就发布新 bundle，
  index.html 里注入的轮询（每 2 秒比一次 `/stamp` 的 rev）会让页面自动重载（需 dev 打开）。
- **改 index.js（Host）**：ESM 模块缓存不会自动失效，必须让 Host 重新 import 一次。
  实测唯一可靠的手段是把 bundle 关一次再开：

  ```
  plugin_manager action=set_bundle target=dsh-multi-session enabled=false
  plugin_manager action=set_bundle target=dsh-multi-session enabled=true
  ```

  （`remove_bundle` 对本插件返回 `not-removable`；`set_plugin` 不接受 `include:` 前缀的 entryId。）
  装完页面**不会**自动重载，得手动刷新。
- 语法自检：`node --check index.js`、`node --check client.js`。
- 图标是 SVG（`icon.svg`）；市场收录要求位图，所以市场条目用 GitHub 托管的 png，不指向这个 SVG。

## 已知限制

- 并排最多 3 列，每列默认最近 20 条（可点「载入更早」按 20 递增，Host 上限 600）。
- 单条正文上限：用户 1500 字、助手 3000 字——为了轮询载荷（约 28–38KB）。
- 运行中每 1.2 秒刷新一次；停下后降频到 8 秒继续跟（不会停），避免刚跑完那一刻停在旧结果上。
- 子代理会话默认折叠（实测 761 个会话里 639 个是子代理，全放出来会淹没面板）。
- 冷启动补标是启发式的：空闲会话若只是被改名（`updatedAt` 前移），也可能被误标成「待查看」。
- 纯 Web 插件，页面关掉就看不到任何东西；要关页面也收得到得另接 webhook。

## License

MIT
