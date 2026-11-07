# AGENTS.md · 给 AI 的仓库操作手册

> 这是 **dsh-cross-workspace** 仓库的 AI 协作约定。人类可读说明在 [`README.md`](README.md)，
> 精确契约在 [`docs/API.md`](docs/API.md)，运行原理在 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。
>
> 如果你只读一段：**先跑测试，守住第 3 节的 12 条不变量，按第 6 节验证、第 10 节 DoD 收尾。**

- 当前版本：`0.8.1`
- 文档最后同步：2026-11-07
- 当前测试：**191 tests / 57 suites，191 pass / 0 fail**
- 插件类型：Cordis bundle（Host 半 + Web Client 半），本地 `link:` 安装
- 运行范围：本机同一个 DSH Host 进程，不经过网络

---

## 1. 阅读顺序

1. 本文件（规则与不变量）
2. [`docs/API.md`](docs/API.md)（所有字段、路由、工具、错误码）
3. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)（数据流、状态机、失败模式）
4. 只读你真正要改的源码文件；不要凭记忆猜 API，用 `cordis_inspect_query` 查当前安装版

> 文档与代码冲突时：**先停下来核对安装版 API**；以实测为准，然后同步文档与测试。
> 不要把“看起来对”当成验收。

---

## 2. 仓库地图

```
index.js                 Host 半（唯一入口）
  ├─ inject 服务：tools / webServer / agents / sessions / sessionController /
  │               workspaceRegistry / workingDirectory
  ├─ 6 个 agent 工具：mail_send / mail_inbox / mail_read / mail_reply /
  │                   mail_wait / workspace_list
  ├─ 管理 API：POST /plugins/dsh-cross-workspace/api（actions 见 docs/API.md §4）
  ├─ 系统提示注入：agent.ctx.systemPrompt.context({ name: 'cross-workspace-mail' })
  └─ 投递编排：sendMessage / deliverMessage / toolContext
lib/store.js             信箱持久化（JSON 原子写、群组、设置、附件复制、清理）
lib/resolve.js           workspace/session 索引、寻址、归档/空白/失效过滤、pickWakeSession
lib/format.js            工具结果/系统提示/面板文本（中英文）
lib/delivery.js          单会话/工作区/群组投递；wake 启动确认；WakeLimiter
client.js                Web Client（单文件、无构建、只 require('react')；含交流图 SVG）
docs/API.md              契约（字段、路由、错误码、工具参数）
docs/ARCHITECTURE.md     数据流/状态机/生命周期/测试矩阵
docs/UPGRADING.md        插件/store 版本、迁移、降级、开源发布检查
README.md                人类使用说明/安装/FAQ
CHANGELOG.md             版本与变更记录
test/*.test.mjs          node:test；必须显式列文件运行
reports/                 独立复核记录（gitignore，不进 package files）
locale/{zh,en}.json      插件标题/描述（Plugin Manager 读取）
icon.svg                 插件图标
cordis.patch.yml         bundle 插入行（id: cross-workspace）
package.json             bundle + client 清单、exports、files
```

### 文件职责边界

- **不要在 `index.js` 里写持久化细节**：放 `lib/store.js`。
- **不要在 `client.js` 里写业务规则**：投递/过滤/群组规则在 Host；Client 只展示与发请求。
- **不要在 `lib/resolve.js` 里做投递**：它只构建索引与寻址。
- **不要在 `lib/format.js` 里改状态**：它只渲染文本。
- **性能约束**：Client 的 `stateSignature` 跳过未变化的轮询重绘；交流图只取最近 120 条消息
  （`GRAPH_MESSAGE_LIMIT`），不要把它改回全量 300；轮询在隐藏/失焦/编辑时降频或暂停；
  `getIndex()` 默认缓存 5 秒，不要在 state 热路径上强制 `maxAgeMs:0`。
- **不要新增构建步骤/依赖**：当前 bundle 无依赖、无打包；`client.js` 是手写 module-loader 工厂。

---

## 3. 不变量（违反即回归，必须修）

1. **Session 日志是唯一真相**：插件只读 Session（`snapshotEvents()` 等），**绝不** `session.append()`
   或新增自定义事件类型（会导致 Session 无法重新打开）。
2. **wake 必须传完整 UserMessage**：`{ role:'user', id, content:[{type:'text',text}], source:{kind:'user'} }`；
   不要传 `{content, source}` 草稿（会触发 `messages[N]: missing field role`）。
3. **wake 必须确认接纳**：followup 后轮询 `agent.session.snapshotEvents()`，看到**本次生成的 UserMessage id**
   出现在 `user/message` 才算 `mode:'wake'`；`turn/start` 后 `turn/end blocked` 不算。
   最长等 1.6s；没确认就退回 `mailbox`/排队，不许谎报。
   **目标正在运行**时先等 `waitForIdleSeconds`：等到空闲 → 正常 wake 确认；超时/0 → followup 排队，
   `mode:'queued'`、`delivered:false`（当前轮结束后的下一轮才处理，尚未启动）。
   **任何情况下都不能凭工具成功就宣称对方收到**；`wake` 才是已确认启动，`queued`/`mailbox` 都不是。
4. **列表过滤**：`isListableSession = !blank && !archived && !unknown`。空白、已归档、失效会话不得出现在
   `workspace_list`、面板工作区列表、orphan 列表、群组可选会话里。已有群组的历史成员快照按存储保留。
5. **广播唤醒只选可列出会话**：不再回退到空白会话；发送方自己永远排除；没有候选 →
   `delivery.mode='none'`（消息仍已保存）。
6. **群组按发送时成员快照 + 当前成员**：`to.memberSessionIds` 是快照；默认全部成员可见，`memberSessionIds` 子集
   则只有选中成员可见；子集必须是群组成员，发送方自动排除；**被移出群后旧消息也不可读**，新成员看不到入群前
   消息；群组删除时冻结“删除时仍在群”的成员，只有快照∩删除时成员保留历史访问，被移出的成员不会因删群恢复；
   回复群消息回群组；删群组不删消息。
7. **附件安全**：默认只允许发送方工作区内文件（`realpath` 校验）；`nlink > 1` 拒绝；
   `allowExternalAttachments=true` 会**同时**放宽工作区根与硬链接校验（显式风险），不要默认开。
8. **管理 API 安全**：仅 POST + `x-dsh-cross-workspace: 1`；有 `connection` 时唯一准入是
   `connection.requestRejection(req) === undefined`（不回落到 Origin）；只有服务缺失时才回退同源检查。
   这是单机单 Owner 插件，没有多用户 ACL；`fromSessionId` 由已认证面板提供，工具路径由调用 Agent 决定。
   1 MiB body 上限。
9. **工具结果必须是 lossless JSON**：不要返回 `undefined` 字段/value；可选字段要么省略，要么给值。
10. **Client 规范**：只 `require('react')`；不 import Harness Client 包；不写 `document.body/head`；
    不用 `innerHTML`；颜色只用 `--dsw-alias-*` / `--dsw-static-*` 主题 token（布局可用 `--dsh-frame-*`），
    不写字面颜色；locale 走 `ctx.locale` 订阅；slot 注册走 `ctx.slots.inject`；清理监听器/定时器。
11. **生命周期清理**：所有注册放 `ctx.effect`/`ctx.on`；agent 作用域注册要同时由 agent dispose 与
    插件卸载清理；存储卸载前 `store.flush()`。
12. **隐私**：不把真实姓名、学号、邮箱、手机号、客户名、个人绝对路径写进随包文件或测试夹具。
    `reports/` 必须保持 gitignore 且不进 `package.json#files`。

---

## 4. 精确契约（速查；完整版见 docs/API.md）

### 4.1 Agent 工具

| 工具 | 关键参数 | 要点 |
|---|---|---|
| `mail_send` | `to`, `sessionId`, `groupId`, `memberSessionIds`, `subject`, `body`, `data`, `files`, `wake`, `replyTo` | 群组可指定成员子集；运行中目标先等，超时 queued |
| `mail_inbox` | `unreadOnly`（默认 true）, `limit`（1-100） | 只返回本会话可见消息 |
| `mail_read` | `id`, `markRead`（默认 true） | 返回 data、附件路径、内联小文本 |
| `mail_reply` | `id` / `messageId`（至少一个）, `body`, `data`, `files`, `wake`, `memberSessionIds`, `subject` | 普通消息回发件会话；群消息回群组（可指定成员） |
| `mail_wait` | `timeoutSeconds`（1-300）, `after` | 长轮询；`timeoutMs: 310_000`；不标记已读 |
| `workspace_list` | `query` | 工作区/有效会话/群组；空白/归档/失效不列 |

工具 schema 在 `index.js` 的 `registerTool(...)`；`output` 必须提供 `schema + render`。

### 4.2 管理 API actions

`state` / `send` / `read` / `mark` / `markAll` / `edit` / `delete` / `deliver` / `settings` / `prune` / `clear` /
`groupCreate` / `groupUpdate` / `groupDelete`

- 成功：`{ ok:true, value }`；失败：`{ ok:false, error:{ code, message } }`。
- 错误码：见 `docs/API.md` §10「错误码总表」；`StoreError`/`TargetError` 映射 400，未知异常 500。
- `state` 是面板主数据源；Client 每 4 秒轮询，操作后刷新。

### 4.3 设置默认值（`lib/store.js`）

```js
{
  defaultDelivery: 'wake',
  allowWake: true,
  allowWorkspaceBroadcast: false,
  promptContext: true,
  promptLocale: 'zh',
  retentionDays: 30,
  maxMessages: 800,
  maxHops: 6,
  wakesPerMinute: 20,
  targetWakeCooldownSeconds: 3,
  waitForIdleSeconds: 120,
  maxBodyBytes: 32768,
  maxSubjectChars: 200,
  maxDataBytes: 65536,
  maxFileBytes: 5 * 1024 * 1024,
  maxTotalFileBytes: 20 * 1024 * 1024,
  maxFiles: 8,
  inlineTextBytes: 32768,
  maxGroupMembers: 32,
  allowExternalAttachments: false,
}
```

### 4.4 运行时服务（改代码前用 `cordis_inspect_query` 再确认）

- `ctx.tools.register(definition, options?)` → disposer；`definition.output = {schema, render}`；
- `ctx.webServer.register({ kind:'exact', path, handler })` → disposer；
- `ctx.sessionController.resolveAgent(sessionId)` → `{ agent } | { error }`（**不是**直接 Agent）；
- `ctx.workingDirectory.get(session)`；`ctx.workspaceRegistry.list()` / `archivedSessionIds`；
- `ctx.agents.turnBoundaryOf(session).lastTurn`；
- `agent.session.snapshotEvents()`（公开全量读取；在上游替代 API 出现前使用，已在 CHANGELOG 记录 deprecated）。

---

## 5. 投递状态机

```
requested=mailbox ───────────────────────────────► mailbox
requested=wake
  ├─ allowWake=false / hop>maxHops / 限流 / 冷却 ──► mailbox（note 说明）
  ├─ 目标运行中：等 waitForIdleSeconds
  │    ├─ 等到空闲 ──────────────────────────────► followup + 确认
  │    └─ 超时/0 ────────────────────────────────► queued（下一轮，未确认启动）
  ├─ 无目标会话（工作区/群组空） ─────────────────► none
  ├─ 群组：逐成员如上；mode 优先级 wake > queued > mailbox
  └─ 单会话：followup
        ├─ 1.6s 内确认 user/message 进入日志 ──────► wake/delivered:true
        └─ 未确认（归档/阻塞/慢启动） ─────────────► mailbox/delivered:false
```

硬规则：

- `followup` 返回成功 ≠ 已唤醒；
- 归档会话可以显式 id 投递，但不得在列表中列出；
- 群组 `members` 逐项结果必须如实，不得把 blocked 成员算 wake。

---

## 6. 测试与验证

### 必须显式列文件（裸 `test` 目录在部分 Node 版本会失败）

```powershell
$node = '<DSH运行时>\dependencies\node\bin\node.exe'
& $node --test test\store.test.mjs test\resolve.test.mjs test\format.test.mjs test\route.test.mjs
```

当前基线：**191 tests / 57 suites，191 pass / 0 fail**（约 17s；含 1.6s wake/queued 观察轮询）。
连跑两次一致才算稳定。

### 语法与清单

```powershell
& $node --check index.js
& $node --check client.js
& $node --check lib\store.js
& $node --check lib\resolve.js
& $node --check lib\format.js
& $node --check lib\delivery.js
```

### 改动后必须做的活体检查

1. 在 Plugin Manager 关闭再开启 `include:cross-workspace`（或重启 DSH）→ Host 生效；
2. 刷新页面 → Client 生效；
3. `workspace_list` 返回正常（无 lossless JSON 报错、无空白/归档会话）；
4. `mail_send` 一次真实 mailbox 往返；条件允许再测一次 wake（空闲目标）；
5. 查看目标日志：wake 成功时应有 `user/message`，失败时不得有假 `delivered:true`。

> 活体测试只对 **throwaway/临时会话**（自建、自归档、测试后清理）或自己的临时目标做；不要向用户正在
> 使用的群组/长期会话发测试消息。第 7 节“禁止”里的“未经要求发送测试消息”与这里不冲突：临时目标 + 清理是允许的。

> 本机观察到的环境行为（不是本仓库的契约保证）：首轮工具调用偶尔遇到
> `Auto review ... pending native tool schema` 的瞬态错误；重试一次通常即可，但连续出现要排查插件 schema
> 或 live Host 状态，不要把自动复核错误当成业务失败。

---

## 7. 改动流程（硬性顺序）

1. **读**：本文件 + `docs/API.md` 相关章节 + 要改的源码 + 测试。
2. **改**：最小改动；遵守第 3 节不变量；不要顺手重构无关代码。
3. **测**：显式文件列表跑两遍；必要时补回归测试（每个 bug 至少一个会失败的用例）。
   当前计数写在 README/AGENTS/API/ARCHITECTURE 里，**加/删测试后一起更新**，否则文档会说谎。
4. **文档**：同步 `README.md` / `docs/API.md` / `docs/ARCHITECTURE.md` / `AGENTS.md`（如果契约/行为变了）。
5. **版本**：行为或包内容变化才 bump `package.json` 版本；同步 `package.json` / `docs/API.md` /
   `AGENTS.md` / `docs/ARCHITECTURE.md` / `README.md` 的版本号与“最后同步”日期，并写 CHANGELOG。
6. **备份**：按工作区约定把项目目录备份到工作区外的备份区；不要把个人绝对路径写进随包文档。
7. **复核**：交给独立子智能体按隐私、正确性、一致性、发布面复核；有 blocker 先修再复核。
8. **收尾**：确认无临时文件、无 `reports/` 进入发布、无测试回执污染；更新备份总目录。

### 禁止

- 手改 profile 的 `package.json` / `cordis.patch.yml`（用 `plugin_manager`）；
- 在插件里读 profile 的 patch 文件、猜路径；
- 绕过 `connection.requestRejection` 的准入；
- 在 Client 里 import Harness Client 包、写 DOM 全局、用字面颜色；
- 为通过测试而放宽断言/迁就实现；
- 未经用户要求发送群组/跨会话测试消息（活体测试用 throwaway 会话并清理）。

---

## 8. 常见故障 → 定位

| 现象 | 先查 |
|---|---|
| 工具报 `messages[N]: missing field role` | wake 的 UserMessage 是否完整（第 3 节第 2 条） |
| `已唤醒` 但目标没动 | 是否确认了 `user/message`；是否 archived/blocked；看目标 Session 尾部 |
| `workspace_list` 里出现空白/归档 | `isListableSession`、state/workspace_list/render 是否都过滤 |
| 群组发送缺成员结果 | `delivery.members` 是否逐项；运行中/限流会降级 |
| 附件 `attachment-outside-workspace` | 发送方工作区根、realpath、`allowExternalAttachments` |
| 管理 API 403 | Origin/`connection.requestRejection`、`x-dsh-cross-workspace` 头 |
| Client 面板空白 | 刷新页面；slot id/key；`state` 请求 403；console 是否有 slot crash |
| 重启后旧代码 | linked package 需要关闭再开启插件或重启；Client 需要刷新 |
| store.json 损坏 | 应自动改名 `store.corrupt-<ts>.json` 并空库启动；不要删用户数据 |

---

## 9. 扩展配方

### 新增一个 agent 工具

1. `index.js` 里 `registerTool({ name, description, parameters, output: outputOf(...), timeoutMs?, execute })`；
   `outputOf` 是本文件的局部 helper（返回 `{schema, render}`），`output.schema` 必须描述 value，`render`
   返回 `ContentBlock[]`；`execute(args, exec)` 的 `exec.agent/session` 是调用者，参数用 `args`，错误直接 throw。
2. 尽量复用现有 `sendMessage`/`store`/`cwd` 逻辑，不要在工具里重写业务；
3. `test/route.test.mjs` 加：schema 校验、正常路径、错误码、lossless JSON；
4. `docs/API.md` §6 工具表 + 参数/返回值同步；`README.md` 使用示例同步；
   工具总数/计数会出现在 AGENTS §2/§4.1、ARCH §1/§7、README §12、API §0 `tools`，一并更新。

### 新增一个管理 API action

1. 在 `index.js` 的 `actions` 对象加方法；
2. `docs/API.md` §4 写 request/value/错误码；
3. Client 在 `client.js` 的 API 调用处接入并处理错误；
4. 路由测试覆盖成功 + 典型失败 + 安全 fence。

### 新增设置项

1. `lib/store.js`：`DEFAULT_SETTINGS` + `SETTING_NUMBERS`/类型校验 + `normalizeSettings`；
2. Client 设置页加控件（文案中英双语）；
3. `docs/API.md` Settings 表 + README 表；
4. 测试：默认值、边界、非法值、持久化。

### 新增用户可见文案

- Host 文本：`lib/format.js` 的 `pickText(locale, zh, en)`；
- Client 文本：`client.js` 的 `t(zh, en)` / `useText`，跟随 `ctx.locale`；
- 不要只写中文或只写英文；中英都要可读。

---

## 10. 完成定义（DoD）

- [ ] 行为符合 `docs/API.md` 与第 3 节不变量
- [ ] 显式测试文件跑两遍全绿，新增回归覆盖本次改动
- [ ] `node --check` 所有改动的 JS 通过
- [ ] README / API / ARCHITECTURE / AGENTS 与行为一致
- [ ] 版本/CHANGELOG/备份一致（需要时）
- [ ] 独立复核 PASS（0 blocker / 0 major）
- [ ] 无临时文件、无报告/测试产物进入 `package.json#files`
- [ ] 没有改动工作区外的用户文件

满足以上之前，不要对用户说“完成”。
