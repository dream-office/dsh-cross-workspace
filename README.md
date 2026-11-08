# 跨工作区信使 · dsh-cross-workspace

> **非官方插件**：与 DeepSeek / DeepSeek Harness 官方无隶属、无背书关系。

> **一句话**：让不同工作区里的 DSH 会话互相发消息、传文件、传 JSON；可以手动拉群群发，
> 也可以在 Web 面板里像收邮件一样管理。
>
> **给 AI**：先读 [`AGENTS.md`](AGENTS.md)（仓库操作规则、不变量、验收清单），
> 精确契约看 [`docs/API.md`](docs/API.md)，运行原理看 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

- 版本：`0.8.5`（`package.json` / API 契约 / CHANGELOG 同步）
- 文档最后更新：2026-11-08
- 测试：**191 tests / 57 suites，全绿**（数字以当前仓库为准，改测试后需同步）
- 运行位置：本机同一个 DSH Host 进程内；没有出站网络请求，消息与附件不上传

---

## 0. 安装 / 升级 / 卸载

**前置条件**：DSH Desktop（带 Plugin Manager 工具/界面；实测 DSH `0.2.2-rc.1`），
Node.js `>=22.13.0`；插件本身**没有 npm 依赖、没有构建步骤**；不需要单独启动服务。
`package.json` 的 `engines.dsh` 声明为 `>=0.2.2-rc.1`，供插件市场做兼容过滤。

安装（把 `<本项目绝对目录>` 换成实际 checkout 路径；目录必须存在）：

```text
plugin_manager install_bundle target="<本项目绝对目录>"
```

期望结果：`application: "applied"`，`enabled: true`。安装的是本地目录的 `link:`，不是复制。

### 从 GitHub 安装

仓库地址：`https://github.com/dream-office/dsh-cross-workspace`。

```text
git clone https://github.com/dream-office/dsh-cross-workspace.git
plugin_manager install_bundle target="<clone 后的 dsh-cross-workspace 绝对目录>"
```

安装后按下面的「验证安装」检查工具与面板；升级时 `git pull` 后重新安装/重载即可。
项目使用 **MIT License**，见 [`LICENSE`](LICENSE)。

### npm 包（已放弃）

2026-11-07 npm 发布已下架；项目**不再以 npm 作为分发渠道**，市场使用 GitHub tarball。
`0.8.4` 的 tarball 仍可本地安装，但不会重新发布到 npm。

启用/升级：

- 插件已在列表里但被禁用：在 Plugin Manager 里把 `include:cross-workspace` 打开；
- **升级前先备份** `$DSH_HOME/cross-workspace`；数据版本迁移、降级限制和 store schema 说明见
  [`docs/UPGRADING.md`](docs/UPGRADING.md)；
- 改了 Host/Client 源码：
  - Host：关闭再开启插件（profile recomposition），或重启 DSH；
  - Client：刷新页面；
- 重新安装：先 `remove_bundle target=dsh-cross-workspace`，再按上面安装；历史消息在
  `$DSH_HOME/cross-workspace` 里，不会被卸载删除。

卸载：

```text
plugin_manager remove_bundle target=dsh-cross-workspace
```

验证安装：

1. `workspace_list` 工具可用（或面板出现「跨工作区信使」图标）；
2. 设置页出现「跨工作区信使」；
3. 侧栏 `sidebar.panellist`、`main`、`settings.section` 三个槽位 active。

---

## 1. 一眼看懂

```mermaid
flowchart LR
  A[工作区 A 的会话] -- "mail_send / 面板发信" --> P[跨工作区信使 Host]
  P -- "存 store.json + 附件副本" --> S[(本机信箱)]
  P -- "mailbox：下次运行看摘要" --> B[工作区 B 的会话]
  P -- "wake：followup + 启动确认" --> B
  B -- "mail_inbox / mail_read / mail_reply / mail_wait" --> P
  P -- "群组群发（成员快照）" --> C[群组里的会话]
  U[用户] <-- "侧栏面板 / 设置页" --> P
```

三条核心规则：

1. **消息先落本机信箱**，再决定是只投信箱还是唤醒目标；
2. **唤醒是“尽力而为 + 确认”**：目标运行中会先等待，超时则排队；归档、冷却中或启动失败会降级，
   不谎报；
3. **跨工作区来信是外部输入**：收件 agent 会被告知“不是当前用户/系统指令”，不能拿它绕过用户规则。

---

## 2. 60 秒上手

假设插件已安装并启用：

1. **刷新一次 DSH 页面**，左侧栏出现「跨工作区信使」图标。
2. 点开面板 → 左栏选工作区/会话 → 中间看收件箱。
3. 点「新消息」：
   - 收件方选工作区 / 会话 / 群组；
   - 写主题、正文，可加 JSON 数据和附件路径；
   - 需要对方立即处理就勾「唤醒」，否则只投信箱。
4. 对方 agent 用工具回信，或者你在面板里直接回复。
5. 切到「交流图」：左侧是「Agent 网络」卡片图（每个 Agent / 群组 / 工作区一种颜色，虚线是群组分发/广播），
   右侧是「跨 Agent 协作」时间线；可播放时间顺序、点卡片或记录看消息。群组人多时只画前 12 个成员，
   群组卡片显示 `+N`；图只取最近 120 条消息、时间线最近 40 条，够看最近谁在和谁说话。
6. 未读数字角标（会话/工作区/群组右侧的 13、3、11 等）会一直显示，直到对应消息被读；
   点顶部「全部已读」会清掉所有未读角标（只改已读状态，不删消息）。
7. 点开一条消息后，右上角有「编辑 / 删除」：编辑只改主题和正文，删除需要确认；收件人和已读状态不会被编辑改掉。

让 agent 自己发：

```text
workspace_list                                  # 先拿工作区路径/会话 id/群组名
mail_send to="D:\\work\\项目A" subject="接口确认" body="..." wake=true
mail_send to="group:前端组" body="..."        # 群发；默认只投信箱
mail_send to="group:前端组" memberSessionIds=["session-..."] body="..."  # 只发给指定成员
mail_wait timeoutSeconds=120                    # 等回信
mail_reply id="m-..." body="收到"
```

> 路径只是示例，实际用 `workspace_list` 返回的值。完整工具参数见 [`docs/API.md` §6](docs/API.md#6-agent-工具)。

---

## 3. 核心概念

| 概念 | 说明 |
|---|---|
| **工作区 workspace** | `workspaceRegistry` 注册的目录；按规范化绝对路径识别 |
| **会话 session** | 一个 DSH 对话，有 `sessionId` 和 `cwd`；空白的“新会话”不算有效对话 |
| **消息 message** | 发给会话 / 工作区广播 / 群组的一段通信，可带 JSON 与附件 |
| **群组 group** | 用户手动选的会话集合（可跨工作区）；按**发送时成员快照**投递 |
| **查看者 viewer** | 读信主体：会话用 `s:<sessionId>`；纯工作区视角用 `w:<路径>` |
| **唤醒 wake** | 调 `agent.followup()` 并**确认消息真的被接纳**，让目标立即开始一轮 |
| **信箱 mailbox** | 不唤醒；目标下次运行时在系统提示里看到未读摘要 |

### 会话过滤（0.2.4+）

以下会话**不会出现在工作区/群组可选列表**：

- 已归档（Workspace 归档集合）
- 空白（`New Session`，还没开始对话）
- 失效（registry 有 id，但 `sessionController` 已查不到）

例外：**已有群组**按存储快照保留历史成员；编辑旧群组时它们仍是已选状态，但不会再作为“可选会话”出现。
空白/归档会话仍可用显式 `session:<id>` 投递；真正唤醒归档目标会诚实报「信箱（未唤醒）」。
**失效 unknown** 会话（registry 有 id 但 controller 查不到）无法投递，会报 `session-not-found`。

---

## 4. 寻址：`to` 怎么写

| 写法 | 含义 |
|---|---|
| `<工作区绝对路径>` | 工作区广播；唤醒时会挑一个空闲、已开始、未归档且**不是发送方自己**的会话 |
| `<工作区标题>` | 工作区标题（唯一前缀也可） |
| `<会话 id>` / `session:<会话 id>` | 精确会话 |
| `<群组名>` / `group:<群组名或 id>` | 群组 |
| `workspace:<路径或标题>` | 强制按工作区解析 |
| `session:<id>` / `group:<名>` | 强制按会话 / 群组解析 |

解析失败会给出 `code`、可读消息；`ambiguous` 等错误还会带 `candidates[]`（可能为空），不会静默失败。
HTTP/面板路径返回结构化 `{code,message,candidates?}`；agent 工具路径抛 `Error(message)`，候选写在消息文本里。

---

## 5. 投递语义（重要）

`mail_send` 返回的 `delivery.requested` 是“你请求的模式”，`delivery.mode` 是“实际生效的模式”。

| 请求 | 实际 | 什么时候 |
|---|---|---|
| `wake` | `wake` | 目标空闲、未归档，且 1.6 秒内确认到这条 `user/message` 进入目标 Session 日志 |
| `wake` | `queued` | 目标正在运行；等 `waitForIdleSeconds` 仍未空闲，消息排到当前轮结束后的下一轮（**未确认启动**） |
| `wake` | `mailbox` | 被归档或 gate 阻塞 / 唤醒冷却中 / 超过每分钟上限 / 超过 `maxHops` / 启动未被确认 |
| `wake` | `none` | 目标工作区没有“除发送方外的可列出会话”；消息仍已保存（不尝试自唤醒） |
| `mailbox` | `mailbox` | 正常只投信箱；目标下次运行看未读摘要 |

广播唤醒会**排除发送方自己**；没有可唤醒候选 → `none`；有候选但正在运行 → 先等待，超时 → `queued`。

群组发送：

- 默认 `mailbox`；只有显式 `wake=true` 才尝试唤醒；
- **收件人**：省略 `memberSessionIds` = 全部成员可见；传子集 = 只发给选中的成员，群组其他成员看不到这封；
  子集必须是群组成员，发送方自动排除；
- 按**发送时成员快照**投递；只有**请求了唤醒**的群组发送才逐成员记录 `delivery.members`；
  纯 mailbox 群发只是落信箱，不产生 members，也不会调用任何目标 agent；
- 运行中的成员先等待；超时记为 `queued`，不会谎报为唤醒；`turn/end blocked` 的成员不计“已唤醒”；
- 群组默认不把发送方自己算进收件人。

**AI 发送规则**：工具成功 ≠ 对方收到。必须读 `delivery.mode`：`wake` 是已确认启动，`queued` 是排队
（下一轮才处理，尚未启动），`mailbox` 是只进信箱，`none` 是没投出去。只有对方的回复/回执才能证明“收到”。

---

## 6. 群组（手动拉群）

在面板左栏「群组」里可以：

- 新建群组：填名字，从任意工作区勾选会话；
- 发群消息时可以选「全部成员」（默认，所有人可见）或「指定成员」（只有勾选的人能看到）；
- 改名、增删成员、删除群组（**不删除历史消息**）；
- 点群组只看该群消息；回复群消息默认回到群组（收件人 = 回复时的当前成员）。

群组是**用户维护**的概念；agent 工具只能往已有群组发信，不能自建群组，避免模型随意改变收件人集合。

---

## 7. 附件与 JSON 数据

- 消息可以带 `data`（任意 JSON）与 `files`（本地文件路径列表）；
- 附件是**复制**进 `$DSH_HOME/cross-workspace/attachments/<messageId>/`，不依赖原路径；
- 默认**只允许发送方工作区内的文件**（`realpath` 校验，拒绝符号链接逃逸与硬链接）；
- 需要工作区外文件时，在设置页显式开启 `allowExternalAttachments`（不建议长期开启）；开启后不再做
  工作区根与硬链接校验，这会放宽本机文件边界，属于显式选择的风险；
- 读取时小文本附件会内联，二进制给本地副本路径；单文件默认 5 MiB、合计 20 MiB、最多 8 个。

---

## 8. 设置（设置 → 跨工作区信使）

| 设置 | 默认 | 作用 |
|---|---|---|
| `defaultDelivery` | `wake` | 发信不传 `wake` 时默认投递方式 |
| `allowWake` | `true` | 总开关；关闭后所有唤醒都降级信箱 |
| `allowWorkspaceBroadcast` | `false` | 是否允许工作区广播；默认关闭，消息只能发给指定会话/群组 |
| `promptContext` | `true` | 是否在系统提示里注入未读摘要 |
| `promptLocale` | `zh` | 注入文本语言（`zh`/`en`） |
| `retentionDays` | `30` | 过期清理天数（0 = 不按天清理） |
| `maxMessages` | `800` | 最多保留消息数 |
| `maxHops` | `6` | 回复链最大深度，防来回唤醒循环 |
| `wakesPerMinute` | `20` | 每分钟唤醒次数上限 |
| `targetWakeCooldownSeconds` | `3` | 同一目标唤醒冷却 |
| `waitForIdleSeconds` | `120` | 目标正在运行时最多等待多久再排队（0 = 不等待直接排队） |
| `maxGroupMembers` | `32` | 群组成员上限（`settings` API/store；UI 暂无独立控件） |
| `allowExternalAttachments` | `false` | 是否允许工作区外附件（同时放宽硬链接校验） |

其余上限（正文 32 KiB、主题 200 字符、data 64 KiB、附件大小/数量等）在 `lib/store.js` 的
`DEFAULT_SETTINGS` 与 `SETTING_NUMBERS` 中；修改请走设置页或 `settings` API，不要手改 profile 的 patch。

插件**不声明 Config schema**：`cordis.patch.yml` 里的 `storeDir` / `settings` 只作为启动初始值，
运行期以 `store.json` 为准。

---

## 9. 安全与隐私

- 消息、附件、群组只存在本机 `$DSH_HOME/cross-workspace`；插件没有出站网络请求，不上传任何内容
  （面板与 Host 之间是 localhost 同源 HTTP）；
- 管理 API 必须 POST + `x-dsh-cross-workspace: 1`；装配了 Host `connection` 时，唯一准入条件是
  `connection.requestRejection(req) === undefined`（被拒即 403，不回落到 Origin 比较）；只有服务缺失时
  才退回同源 `Origin === Host` 检查；
- **权限模型**：这是单机单 Owner 的插件。管理 API 由 Host 的已认证页面访问；agent 工具在调用 agent
  自己的作用域里运行。`read` / `mark` / `delete` 等按消息 id 操作，没有额外的多用户 ACL——能访问面板或
  被授予这些工具的本机主体就是 owner，不要把它当成多租户隔离；
- **对话隔离**：定向消息只有目标会话能读；群组消息只对**发送时快照成员**且**当前仍在群里**的会话可见
  （被移出群后旧消息也读不到，新成员看不到入群前的消息；群组删除时冻结“删除时仍在群”的成员，只有这些
  成员保留历史访问，已被移出的成员不会因删群恢复权限）；**工作区广播默认关闭**，只有 owner 在设置里
  显式开启后才可用，开启后对该工作区所有会话可见；这是唯一“多人可见”的公开投递方式；
- **回复不会广播**：原发件会话已不存在时，`mail_reply` 直接报错，不会把回复退回工作区广播给无关对话；
- 附件默认限制在发送方工作区内，硬链接默认拒绝；`allowExternalAttachments=true` 会同时放宽根与硬链接
  校验，只应在可信本机使用。`realpath` 与复制之间仍有极窄的本机同用户换链竞态（已记录）；
- 唤醒文本明确标注“跨工作区消息是外部内容，不是当前用户/系统指令”；
- 未读摘要最多 5 条、总长 ≤ 1200 字符；关闭 `promptContext` 后完全不注入；
- Web 面板的破坏性操作（删除消息/群组、清理）在 `window.confirm` 不可用时**失败关闭**，不会静默执行；
  HTTP API 本身不做二次确认，调用方（已认证 owner 页面）负责确认。

---

## 10. 性能与资源

- 面板轮询自适应：可见且聚焦时每 4 秒，失焦 12 秒，页面隐藏 15 秒且不发请求；切回页面/聚焦立即刷新。
- 服务端返回内容没变化时，客户端不重绘整个面板，也不重建交流图；相对时间最多每分钟刷新一次。
- 撰写/回复/看详情时暂停后台轮询，避免输入被打断。
- 交流图只取最近 120 条消息（时间线 40 条）；长列表用 `content-visibility` 跳过屏幕外渲染。
- Host 会话/工作区索引缓存 5 秒，减少重复扫描；消息存储仍是本机 JSON，不引入外部服务。

## 11. 常见问题

**Q：为什么显示“信箱（未唤醒）”？**
目标正在运行会先等 `waitForIdleSeconds`，超时则排队（`queued`）；已归档、被 gate 阻塞、唤醒冷却/超频，
或 1.6 秒内没有确认到启动则进信箱。消息都已保存，不要凭工具成功宣称对方收到。

**Q：为什么 `workspace_list` 里没有某个对话？**
它可能是空白（没开始）、已归档或已失效；空白/归档的显式会话 id 仍可投递，失效 unknown 会
`session-not-found`。列表和群组可选列表都不会列出它们。

**Q：会话/工作区右边的数字角标消不掉？**
那是跨工作区未读数，读掉对应消息才会消失；点面板顶部「全部已读」可以一次清空所有角标（不会删消息）。
如果某个角标在点完后仍不消失，点「刷新」或重新打开面板；正常状态刷新后应为 0。

**Q：为什么显示“排队（目标运行中）”？**
目标正在跑当前轮，插件最多等 `waitForIdleSeconds` 秒；仍没空闲就把消息排到下一轮（`queued`），
并不代表已开始处理。看 `delivery.mode`：`wake` 才是已确认启动。

**Q：附件被拒 `attachment-outside-workspace`？**
文件不在发送方工作区。把它复制进工作区，或在设置里显式开启 `allowExternalAttachments`（开启后
硬链接/根校验也会放宽，见 §9）。

**Q：消息存在哪？怎么清理？**
`$DSH_HOME/cross-workspace/store.json` 与 `attachments/`；面板设置页可清理已读/全部，或调 `prune`。
卸载插件不会删除历史消息。

**Q：为什么群组里有人收不到？**
群组按**发送时**成员快照投递；后加入成员看不到旧消息。运行中成员先等待，超时排队到下一轮。

**Q：跨机器能用吗？**
不能。当前只覆盖同一个 DSH Host 进程里的本机工作区；跨机器需要另加传输层。

**Q：改完代码怎么生效？**
Host 改动：在 Plugin Manager 里把插件关闭再开启（profile recomposition，会热替换 linked package），
或重启 DSH；Client 改动：刷新页面。只改配置不用重装。

---

## 12. 开发

```
index.js               Host 半：6 个工具、管理 API、投递、系统提示注入
client.js              Web 半：侧栏图标、管理页、设置页
lib/store.js           持久化信箱（纯 Node，可单测）
lib/resolve.js         工作区/会话索引、寻址、归档/空白过滤
lib/format.js          工具/提示/面板的可读文本
lib/delivery.js        唤醒、启动确认、降级策略
docs/API.md            前后端/测试共同遵守的精确契约
docs/ARCHITECTURE.md   数据流、状态机、生命周期
AGENTS.md              AI 改这个仓库前必读
test/                  node:test 单元/路由测试
reports/               本机复核记录（不随包发布）
```

```powershell
# 把 <DSH运行时> 换成本机 dsh-runtimes 的 node.exe 路径
# 如果 node 已在 PATH：
node --test test\store.test.mjs test\resolve.test.mjs test\format.test.mjs test\route.test.mjs

# 否则用 DSH 自带 Node（Windows 示例；把 <DSH运行时> 换成实际目录）
$node = '<DSH运行时>\dependencies\node\bin\node.exe'
& $node --check index.js
& $node --check client.js
& $node --test test\store.test.mjs test\resolve.test.mjs test\format.test.mjs test\route.test.mjs
```

验收与备份规则、改动流程、扩展步骤见 [`AGENTS.md`](AGENTS.md)。视觉上的明暗主题观感需要刷新页面后
人工确认；文档不代替真实截图。

---

## 13. 已知限制

- 仅限本机同一 DSH Host；没有跨机器传输层。
- 工作区广播的已读状态按“每个会话各自”跟踪，没有工作区级已读。
- 唤醒会真实调用目标模型并消耗 token。
- 群组成员快照是**发送时**的；删除群组不删除历史消息。
- 系统提示注入依赖目标 Agent 的 `systemPrompt` 服务；某些精简 composition 没有该服务时只保留工具，不注入摘要。
- 归档/空白/失效会话默认不列出；已有群组的历史成员快照除外。

---

## 14. 变更记录与验证

- 详细版本历史：[`CHANGELOG.md`](CHANGELOG.md)
- 当前版本：`0.8.5`
- 自动测试：**191 tests / 57 suites，191 pass / 0 fail**
- 独立复核记录在本机 `reports/`（已 gitignore，不随包发布）；文档会随行为变化同步更新。

> 本 README 面向人和 AI 共同阅读：概念、入口、默认值、错误语义都写全；精确字段以 `docs/API.md` 为准。

---

## 15. 数据版本与升级

`package.json.version` 是插件版本；`lib/store.js` 的 `STORE_VERSION` 是 `store.json` 数据版本。
当前两者分别是 `0.8.5` 和 `2`。

- 升级前先备份 `$DSH_HOME/cross-workspace`；
- v1 数据加载时自动迁移到 v2，并把 `version: 2` 写回；
- 数据版本高于插件支持时返回 `store-version-too-new`，**不会改写数据**；
- 面板 `state.storeVersion` 可查当前数据版本。

完整步骤、降级限制和维护者迁移契约见 [`docs/UPGRADING.md`](docs/UPGRADING.md)。

---

## 16. 许可

MIT，见 [`LICENSE`](LICENSE)。`package.json` 已填写 `dream-office` 账号的
`repository` / `homepage` / `bugs`；公开前按
[`docs/UPGRADING.md`](docs/UPGRADING.md) §5 的开源检查清单扫描隐私与发布面。

---

## 17. 参与贡献

- 贡献流程与测试命令：[`CONTRIBUTING.md`](CONTRIBUTING.md)
- 行为准则：[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)
- 安全漏洞：不要开公开 issue，按 [`SECURITY.md`](SECURITY.md) 私下报告
- 贡献默认按 MIT 授权，与项目一致。
