# CHANGELOG · 跨工作区信使（dsh-cross-workspace）

所有时间均为 Asia/Shanghai。备份根目录：`<备份根目录>\dsh-cross-workspace\<yyyyMMdd-HHmmss>\`。

## 2026-11-06 · 0.8.1（mail_reply 参数文案修复）

> Release 摘要：修复 `mail_reply` 提示写 `messageId`、工具却要 `id` 导致的「需要 id」报错；
> 同时兼容旧字段 `messageId`，补齐开源前文档、GitHub 安装说明与包元数据。

- 修复 `mail_reply` 报「需要 id」：消费消息尾部提示由 `mail_reply（messageId=...）` 改为
  `mail_reply（id=...）`，与工具 schema 一致。
- `mail_reply` 增加可选 `messageId` 兼容别名：`id = args.id || args.messageId`，
  旧消息里的 `messageId` 提示仍可用；schema 不再强制 `required:['id']`，由执行期校验。
- 同步工具描述与 API/AGENTS 文档；新增回归：提示文本不含 `messageId`、旧别名字段可成功回复。
- 测试：**191 tests / 57 suites，191 pass，0 fail**（不新增用例数，覆盖在现有用例内）。
- 版本 `0.8.1`；发布状态：发布前准备完成。
- **开源发布准备**：修正 README 测试数漂移；补「从 GitHub 安装」；`package.json` 增加
  `repository/homepage/bugs` 与 `engines.dsh >=0.2.2-rc.1`（实测 DSH 版本）；`.gitignore`
  已排除 `reports/`/`.tmp/`，`package.json#files` 不含 `reports`。

### 备份

| 时间 | 目录 | 内容 |
|---|---|---|
| 2026-11-06 23:54:59 | `20261106-235459` | 0.8.1 mail_reply 文案/别名修复 + 191 测试（52 文件） |
| 2026-11-07 13:02:33 | `20261107-130233` | 0.8.1 最终开源准备：README/package/Release 摘要（54 文件） |

## 2026-11-06 · 0.8.0（数据版本与升级接口）

- **store schema 升到 v2**：新增 `STORE_VERSION` / `STORE_MIGRATIONS` / `migrateStoreDocument`；
  v1 数据加载时自动迁移并写回 `version: 2`，消息/群组/已读/附件/设置保持。
- 新增版本策略：
  - `store.json.version` 比插件支持的更高 → `store-version-too-new`，**不改写文件**；
  - version 非法 → `store-version-invalid`；缺迁移 → `store-migration-missing`；
  - `state.storeVersion` / `store.getStoreInfo()` 暴露当前 schema；
  - 新增 [`docs/UPGRADING.md`](docs/UPGRADING.md)：升级步骤、v1→v2 补字段、降级限制、
    维护者迁移契约、开源发布检查清单。
- 迁移只做加法：`editedAt`、`to.deletedGroupMemberIds`、`allowWorkspaceBroadcast`
  等旧数据缺省时由 normalization 回退，不伪造内容。
- 插件版本 `0.8.0`；包 `files` 加入 `docs/UPGRADING.md`。
- 测试：**191 tests / 57 suites，191 pass，0 fail**；新增 v1→v2 迁移、缺失版本、未来/非法版本拒绝用例。

### 备份

| 时间 | 目录 | 内容 |
|---|---|---|
| 2026-11-06 23:43:26 | `20261106-234326` | 0.8.0 FINAL：store schema v2 + 升级接口 + 191 测试（52 文件） |

## 2026-11-06 · 0.7.0（编辑消息 + 工作区广播默认关闭）

- **用户编辑消息**：面板消息详情新增「编辑」，可改主题/正文；新增 `edit` API action；
  会校验长度并写 `editedAt`，收件人、附件、已读状态、投递记录不变；列表/详情显示「已编辑」。
- **删除**：继续使用消息详情的「删除」；不删附件以外的无关数据，仍由 owner 确认。
- **隐私默认**：`allowWorkspaceBroadcast` 默认 `false`。默认只能发给**指定会话或群组**，
  工作区广播在设置页显式开启后才可用；关闭时旧广播也不会进入任何 Agent 的收件箱/提示，
  只保留在 owner 的管理面板。
- 设置页增加「允许工作区广播」开关，默认关闭。
- 测试：**186 tests / 56 suites，186 pass，0 fail**；新增 edit、广播默认关闭、deliver gating 用例。
- 版本 `0.7.0`。

### 备份

| 时间 | 目录 | 内容 |
|---|---|---|
| 2026-11-06 23:24:58 | `20261106-232458` | 0.7.0 最终交付：edit + 隐私投递 + 186 测试（50 文件） |

## 2026-11-06 · 0.6.2（群组删除后的权限冻结）

- **修复越权恢复**：先被移出群、之后群组被删除的成员，之前会通过旧的发送快照重新读到群历史。
  现在 `deleteGroup` 在删除时把“当时仍在群”的成员冻结到消息的 `to.deletedGroupMemberIds`；
  删除后只有“发送时快照 ∩ 删除时成员”能读，被移出成员不会因删群恢复权限。
- 旧数据无冻结字段时回退快照（兼容）；无发送快照的 legacy 消息按当前群成员/删除时成员判断，和未读徽标一致。
- 工具描述同步：`mail_inbox` 说明群消息需发送快照 + 当前成员；`mail_reply` 说明原发件会话不存在时直接报错、不广播。
- Client 回复目标不再回退到 `from.workspacePath`，避免潜在的工作区广播路径。
- 测试：**177 tests / 53 suites，177 pass，0 fail**；覆盖移除→删除、重加→删除、legacy 快照、存储重载。

### 备份

| 时间 | 目录 | 内容 |
|---|---|---|
| 2026-11-06 22:43:25 | `20261106-224325` | 0.6.2 最终交付：删除权限冻结 + 工具文案 + 177 测试（48 文件） |

## 2026-11-06 · 0.6.1（对话隔离 / 群成员权限）

- **群聊权限收紧**：群消息现在要求同时满足“发送时快照成员”和“当前仍在群”才可读。
  - 被移出群后，旧群消息也读不到（`mail_inbox` / `mail_read` / `mail_reply` 都按此判断）；
  - 后来加入的新成员看不到入群前的历史；
  - 重新加回群后，因快照仍包含其 id，可恢复历史访问（已测试并写入契约）；
  - 群组被删除后，原快照成员保留历史访问；管理视角仍可查看全部。
- **回复不再广播**：原发件会话不存在时，`mail_reply` 直接报错，不再回退到原工作区广播；
  避免私聊回复被无关对话看到。
- 定向消息仍只有目标会话可读；工作区广播仍是显式公开给整个工作区的消息（不是私聊）。
- 测试：**170 tests / 53 suites，170 pass，0 fail**；新增群成员移除/新成员/删除群组/reply fallback 用例。
- 版本 `0.6.1`；README/AGENTS/API/ARCHITECTURE 同步权限说明。

### 备份

| 时间 | 目录 | 内容 |
|---|---|---|
| 2026-11-06 22:22:02 | `20261106-222202` | 0.6.1 对话隔离/群成员权限 + 170 测试（46 文件） |

## 2026-11-06 · 0.6.0（性能与内存优化）

- **轮询自适应**：可见且聚焦 4s；窗口失焦 12s；页面隐藏 15s 且不发请求；切回/聚焦立即刷新。
- **跳过无效重绘**：Client 对 `state` 计算语义签名；内容未变时不再 `setData`，不重绘列表、不重建交流图；
  相对时间最多每分钟刷新一次。
- **编辑/阅读时暂停轮询**：撰写、回复、群组编辑、消息详情打开时跳过后台 poll，避免输入被打断。
- **交流图限量 + 记忆化**：图只取最近 120 条消息（时间线 40 条）；模型按数据签名 memo，不再每 4 秒重建；
  图谱/卡片渲染使用 `content-visibility` 跳过屏幕外行。
- **Host 索引缓存**：`getIndex()` 默认缓存 5s，state 热路径不重复扫描会话/标题；新会话最多约 5s 后可见。
- 无协议变化；测试仍 **165 tests / 51 suites**。

### 备份

| 时间 | 目录 | 内容 |
|---|---|---|
| 2026-11-06 21:54:51 | `20261106-215451` | 0.6.0 性能/内存优化（44 文件） |
| 2026-11-06 22:06:32 | `20261106-220632` | 0.6.0 FINAL：review-23 修复 + 165 测试（45 文件） |
| 2026-11-06 22:11:34 | `20261106-221134` | 0.6.0 最终交付：review-24 PASS + 165 测试（46 文件） |

## 2026-11-06 · 0.5.0（清空未读角标）

- **全部已读**：面板顶部新增按钮，调用新的 `markAll` 管理 action；一次清掉所有会话/工作区/群组的未读数字角标。
  - 对每条消息补齐目标 `readBy`：单会话 `s:<id>`、群组全部成员、工作区广播 `w:<path>`；
  - 不删除消息、不改变投递状态；重复点击幂等（第二次 `marked: 0`）。
- `markAll` 成为第 13 个管理 action；仍需管理 API 的 POST + `x-dsh-cross-workspace` 头。
- README/API 增加角标说明与 FAQ。
- 测试：**164 tests / 51 suites，164 pass，0 fail**；覆盖 markAll 的 direct/group/workspace 广播（含 session viewer）、
  群组快照/改成员/legacy 无快照回退、direct 不过度标记、orphan 广播、幂等、持久化、权限 fence。
- 全部已读对**工作区广播**同时写 `w:<path>` 和该工作区每个会话的 `s:<id>`，所以选中会话时也不会留下广播未读；
  工作区会话列表覆盖 orphan（按 `index.sessions` 的 cwd 分组，不只已注册工作区）。
- 管理视角的群组未读改为按**发送时成员快照**判断（老消息无快照才回退当前成员），改群组成员后不会留下旧群组角标。
- 定向消息即使带 `to.workspacePath` 也只写 `s:<target>`，不会把同工作区其他会话一起标已读。

### 备份

| 时间 | 目录 | 内容 |
|---|---|---|
| 2026-11-06 20:54:53 | `20261106-205453` | 0.5.0 全部已读/角标清理（42 文件） |
| 2026-11-06 21:17:39 | `20261106-211739` | 0.5.0 FINAL：群组快照/direct/orphan 修复 + 163 测试（43 文件） |
| 2026-11-06 21:33:19 | `20261106-213319` | 0.5.0 最终交付：全部已读全部角标 + 164 测试（44 文件） |

## 2026-11-06 · 0.4.0（可视化交流图）

- 面板新增「交流图」Tab：把当前加载的消息画成有向图。
  - 左侧「Agent 网络」：每个会话/群组/工作区是一张彩色卡片（名称、归属、收发/消息数、最近活动、进度条；运行中带绿点）。
  - 连线：直接消息、工作区广播、群组消息（发送者→群组→成员）；箭头表示方向，颜色跟随源节点。
  - 颜色：每个 Agent / 群组 / 工作区一种颜色；投递状态（已唤醒/排队/信箱/失败）显示在右侧记录与详情里；群组成员分发与工作区广播用虚线。
  - 右侧「跨 Agent 协作」时间线：按时间倒序列出协作记录，左侧色条对应发送方颜色，可搜索并点开消息。
  - 交互：悬停高亮卡片/连线；点卡片或连线看主题、收发方、时间、投递状态，可直接打开消息。
  - 播放：按时间顺序逐条显示连线；显示全部/暂停；顶部有 Agent/运行中/消息/群组统计与颜色图例。
  - 数据来源：现有 `state` 消息（最多 300 条），不新增 Host API；只读，不影响投递。
- Client-only 改动；无 Host 协议变化，测试仍 **153 tests / 49 suites**。

### 备份

| 时间 | 目录 | 内容 |
|---|---|---|
| 2026-11-06 19:38:57 | `20261106-193857` | 0.4.0 可视化交流图（38 文件） |
| 2026-11-06 19:50:09 | `20261106-195009` | 0.4.0 FINAL：review-17 修复 + 153 测试（39 文件） |
| 2026-11-06 19:54:29 | `20261106-195429` | 0.4.0 最终交付：review-18 PASS + fan 去重 + 153 测试（40 文件） |
| 2026-11-06 20:01:14 | `20261106-200114` | 0.4.0 样式重做：Agent 卡片 + 协作时间线（40 文件） |
| 2026-11-06 20:11:31 | `20261106-201131` | 0.4.0 FINAL：卡片配色修复 + review-19 修复（41 文件） |
| 2026-11-06 20:16:22 | `20261106-201622` | 0.4.0 最终交付：review-20 PASS + 卡片/时间线（42 文件） |

## 2026-11-06 · 0.3.0（群组指定收件人 + 运行中等待/排队）

- **群组指定收件人**：`mail_send` / `mail_reply` 的群组发送支持 `memberSessionIds` 子集；省略或空数组 =
  全部成员。后端校验必须是群组成员，发送方自动排除；`to.memberSessionIds` 只保存选中的快照，因此只有
  被选中的成员能看到这封（不会“所有人可见”）。面板群组发信/回信增加“全部成员 / 指定成员”选择。
- **运行中目标等待后再发**：新增 `settings.waitForIdleSeconds`（默认 120，0–600）。请求 `wake` 且目标
  正在运行时，先等 `agent.whenIdle()`；等到空闲后正常 followup + 启动确认；等待超时/设为 0 则把消息
  **排到当前轮结束后的下一轮**，返回 `delivery.mode='queued'`（`delivered:false`，明确未确认启动）。
  群组使用一个共享等待预算，运行中成员记为 `queued`；群组 mode 优先级 `wake > queued > mailbox`。
- **AI 规则写进工具描述与文档**：`mail_send`/`mail_reply` 现在明确要求读取 `delivery.mode`；
  `wake` 才是已确认启动，`queued` 只是排队，`mailbox` 未启动；不能凭工具返回成功就宣称对方已收到，
  只有回复/回执才能证明收到。
- 设置页增加“运行中等待秒数”。
- 测试：**153 tests / 49 suites，153 pass，0 fail**；覆盖群组子集可见性/校验、运行中等待后唤醒、
  超时 queued、群组 mixed queued、设置边界。
- 版本升到 `0.3.0`。

### 备份

| 时间 | 目录 | 内容 |
|---|---|---|
| 2026-11-06 18:33:31 | `20261106-183331` | 0.3.0 群组子集 + 运行中等待/排队 + 152 测试（36 文件） |
| 2026-11-06 18:47:27 | `20261106-184727` | 0.3.0 FINAL：review-15 修复 + 153 测试（37 文件） |
| 2026-11-06 19:21:21 | `20261106-192121` | 0.3.0 最终交付：review-16 PASS + 153 测试（38 文件） |

## 2026-11-06 · 0.2.6（文档可读性：人 + AI）

只改文档与随包清单，运行时行为不变。

- 重写 [`README.md`](README.md)：面向“看懂 + 会用”——一眼看懂图、60 秒上手、概念表、寻址表、
  投递语义表、群组、附件、设置默认值、安全边界、FAQ、开发与限制。
- 新增 [`AGENTS.md`](AGENTS.md)：面向 AI 的仓库操作手册——阅读顺序、仓库地图、12 条不变量、
  精确契约速查、投递状态机、测试/活体检查、改动流程、故障定位、扩展配方、DoD。
- 新增 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)：组件/数据流/收信/已读序列图、
  store 模型、索引与过滤、投递决策树、生命周期、安全边界、测试矩阵、失败恢复。
- 扩充 [`docs/API.md`](docs/API.md)：机器可读摘要、目录、12 个 action 与 6 个工具的示例、
  错误码总表、文档维护约定；机器摘要与 `package.json` 版本同步。
- `package.json#files` 纳入 `AGENTS.md` 与 `docs/ARCHITECTURE.md`；版本升到 `0.2.6`。
- 测试仍为 **143 tests / 47 suites，143 pass / 0 fail**（文档改动不影响代码）。

### 备份

| 时间 | 目录 | 内容 |
|---|---|---|
| 2026-11-06 16:22:00 | `20261106-162200` | 0.2.6 文档体系（README/AGENTS/ARCHITECTURE/API，35 文件） |
| 2026-11-06 16:42:25 | `20261106-164225` | 0.2.6 FINAL：文档可读性/一致性修订 + 安装/权限/契约补全（36 文件） |

## 2026-11-06 · 0.2.5（归档/空白过滤的一致性收尾）

review-10 的 4 个 minor 全部处理：

- **未读计数一致**：`unreadForWorkspace` 只统计可列出的会话（不含 blank/archived/unknown），
  面板 state、`workspace_list` 文本与 value 的未读数不再因隐藏会话而漂移。
- **失效会话**：`isListableSession` 现在也排除 `unknown: true`（registry 里有 id 但 sessionController
  已查不到的陈旧记录不再出现在列表里）。
- **文档纠正**：可唤醒会话为 0 时 `delivery.mode = 'none'`（不是 mailbox），消息仍已保存。
- **群组说明**：已存在的群组按存储的成员快照保留历史成员；新建群组的可选列表只含可列出会话，
  编辑旧群组时历史成员仍保留为已选，但不会再作为“可选会话”出现。`workspace_list` 描述同步说明。
- 测试：**143 tests / 47 suites，143 pass，0 fail**；新增失效 registry 记录过滤、未读一致性、
  pickWakeSession 排除 unknown 等回归。
- 版本升到 `0.2.5`。

### 备份

| 时间 | 目录 | 内容 |
|---|---|---|
| 2026-11-06 16:09:26 | `20261106-160926` | 0.2.5 过滤一致性收尾 + 143 测试（31 文件） |
| 2026-11-06 16:12:57 | `20261106-161257` | 0.2.5 FINAL：群组历史成员措辞修正（32 文件） |
| 2026-11-06 16:15:24 | `20261106-161524` | 0.2.5 FINAL：workspace_list 例外措辞 + 交付（33 文件） |

## 2026-11-06 · 0.2.4（会话列表过滤：归档 + 空白）

用户要求：已归档的对话和无效（空白）的对话不要出现在工作区/群组列表里。

- `lib/resolve.js`：`buildIndex` 读取 `workspaceRegistry.archivedSessionIds`，给每条记录加 `archived` 标记；
  新增 `isListableSession()` —— 只有「已开始（非 blank）且未归档」的会话可列出；
  `pickWakeSession()` 只从可列出会话里选，**空白会话不再作为广播唤醒的兜底目标**。
- `workspace_list` 工具与面板 `state` 路由都过滤工作区会话和 orphan 会话；`renderWorkspaceList` 同步过滤，
  不再显示 `[空白]` 标记。显式会话 id 仍可寻址（保留直接投递能力）。
- 活体验证：`workspace_list` 中 02/01 的 `[空白]` 会话、以及已归档的 throwaway 测试会话全部消失，
  正常的已开始会话与群组保留。
- 测试：**141 tests / 46 suites，141 pass，0 fail**；新增归档标记/可列出判断、state/workspace_list 过滤、
  空白/归档显式 id 仍可投递、空白工作区不再有唤醒兜底等回归。
- 版本升到 `0.2.4`。

### 备份

| 时间 | 目录 | 内容 |
|---|---|---|
| 2026-11-06 15:57:38 | `20261106-155738` | 0.2.4 归档/空白会话过滤 + 141 测试（30 文件） |

## 2026-11-06 · 0.2.3（主题 token 合规修复）

按 Harness 插件规范复查 Client 半时发现 4 个**未在当前 Theme 注册**的 token：

| 旧写法 | 问题 | 修复 |
|---|---|---|
| `--dsw-radius-md`（23 处） | 当前 Theme.listTokens 无此 token | 改为明确的 `8px` 圆角（非颜色几何值） |
| `--dsw-radius-xl`（3 处） | 同上 | 改为 `12px` |
| `--dsw-alias-settings-card-fill` | 不存在；背景失效 | 改用已注册的 `--dsw-alias-bg-layer-1` |
| `--dsw-alias-settings-card-stroke` | 不存在；边框失效 | 改用已注册的 `--dsw-alias-border-l1` |

复查其余实际使用的 16 个 `--dsw-alias-*` token 全部存在；Client 仍只 `require('react')`、无 Harness Client 包 import、
无 `document.body` 写入、无字面颜色（`currentColor`/SVG 图形除外）、无内联 `innerHTML`。
破坏性操作的 `safeConfirm` 在 `window.confirm` 缺失/抛错时改为**失败关闭**（返回 false，不执行删除/清理）。
测试仍为 **139 tests / 45 suites，139 pass**；本次仅 Client 样式 token 与确认框，不影响 Host 行为。

### 备份

| 时间 | 目录 | 内容 |
|---|---|---|
| 2026-11-06 14:57:10 | `20261106-145710` | 0.2.3 主题 token 合规修复 + 版本/文档（28 文件） |
| 2026-11-06 14:58:09 | `20261106-145809` | 0.2.3 FINAL：README/备份表同步 + 临时文件清理（28 文件） |
| 2026-11-06 15:05:11 | `20261106-150511` | 0.2.3 FINAL：确认框失败关闭 + token 计数修正（29 文件） |

## 2026-11-06 · 0.2.2 hotfix（wake 诚实报告）

真实唤醒还有一个“谎报”问题：`Agent.followup()` 成功只代表消息进队列，不代表目标会话真的启动并接纳它。
归档/被阻塞的会话会出现 `turn/start` → `turn/end blocked`，消息**没有**变成 `user/message`，
但旧实现仍返回「已唤醒」。

- 修复 `lib/delivery.js`：followup 后最多轮询 1.6s，调用 `agent.session.snapshotEvents()`（公开方法，
  全量读取并填充内部快照）检查是否有 `user/message` 且 `data.id` 等于本次生成的 UserMessage id；
  只有确认接纳才记 `mode:'wake'`/`delivered:true`。
- review-6 抓到的冷缓存问题：`eventsSnapshot` 只是会被每次 append 置空的缓存，直接读它会得到 undefined
  并退回 turn/status，从而在归档/阻塞目标上再次误报。改为**优先调用 `snapshotEvents()`**，
  `.eventsSnapshot`/`.events` 仅作防御性回退；测试 harness 也改成真实契约（log + 懒加载快照 + append 失效）。
- 若 turn 启动但消息未被接纳（归档/阻塞），降级为 `mode:'mailbox'`、`delivered:false`，note 写
  「已入队但未观察到会话启动；消息在信箱里，需打开该会话后才会处理」。
- 群组投递逐成员做同样确认；`turn/end blocked` 的成员不会计入“已唤醒”。
- 无可观察 API 的环境（旧测试 fake harness）保留 turnBoundary/状态回退与兼容行为。
- **活体验证**（throwaway workspace + 临时 helper，已清理）：正常会话 → 返回「已唤醒」且真的回信；
  同一会话归档后再唤醒 → 返回「信箱（未唤醒）+ 已入队但未观察到会话启动」，目标日志里是
  `turn/start → turn/end blocked` 且没有 `user/message`。
- 测试：**139 tests / 45 suites，139 pass，0 fail**（约 14s，含 4 次 1.6s 观察轮询）；覆盖接纳成功、
  turn 启动但无 `user/message`（归档等价）、冷缓存（`eventsSnapshot` 未填充 + append 失效）、群组混合、
  无观察 API 的兼容回退。
- 已知依赖：`session.snapshotEvents()` 在安装版 dsh-session 里标记为 deprecated（0.2.x 可用的唯一全量读取入口）；
  已按 reviewer 建议记录，待上游提供受支持的读取 API 后迁移。
- 版本升到 `0.2.2`。

### 备份

| 时间 | 目录 | 内容 |
|---|---|---|
| 2026-11-06 14:31:14 | `20261106-143114` | 0.2.2 唤醒诚实报告修复 + 139 测试 + 活体验证（26 文件） |
| 2026-11-06 14:41:44 | `20261106-144144` | review-6 冷缓存修复：snapshotEvents 读取 + API 文档（27 文件） |
| 2026-11-06 14:47:59 | `20261106-144759` | v0.2.2 最终：冷缓存测试 + 活体正常/归档复测（27 文件） |
| 2026-11-06 14:51:25 | `20261106-145125` | review-7 PASS + snapshotEvents 依赖说明（28 文件） |

## 2026-11-06 · 0.2.1 hotfix（唤醒投递的 UserMessage 格式）

真实群组唤醒暴露出的严重 bug：`Agent.followup()` 接受的是**完整 UserMessage**，而插件此前传的是
`{ content, source }` 草稿，缺少 `role`/`id`。发送方群发（wake=true）唤醒本会话后，下一轮 provider 请求
报 `messages[422]: missing field role`，该轮失败两次（随后用户把内容作为普通消息重发才恢复）。

- 修复 `lib/delivery.js`：单目标与群组唤醒都改为
  `{ role:'user', id:<uuid>, content:[{type:'text',...}], source:{kind:'user'} }`；
- 新增回归测试：fake idle agent 捕获 followup 参数，断言 role/id/source/content 完整；
  **131 tests / 43 suites，131 pass，0 fail**（约 7s，连跑两次一致）；
- 影响范围：v0.1.0 起所有 `wake=true` 的真实唤醒都会中招（此前的 E2E 用的是 mailbox 路径，未暴露）；
- 版本升到 `0.2.1`。

### 备份

| 时间 | 目录 | 内容 |
|---|---|---|
| 2026-11-06 13:14:01 | `20261106-131401` | 唤醒 hotfix + 131 条回归测试（25 文件） |
| 2026-11-06 13:31:32 | `20261106-133132` | review-5 PASS + API 版本号同步（26 文件） |

## 2026-11-06 · 0.2.0 手动群组

用户需求：**手动把几个对话拉进群组**，往群组发消息时所有成员收到。

### 新增

- **群组模型**（持久化在 `store.json` 的 `groups` 里）：`{id,name,createdAt,updatedAt,sessionIds}`；
  群组名唯一（大小写不敏感、≤60 字符），成员可跨工作区、上限 `maxGroupMembers`（默认 32）。
- **群组消息**：`message.to` 增加 `groupId/groupName/memberSessionIds` 成员快照；
  群组消息只对发送时的成员可见，后加入的成员看不到旧消息；每个成员各自维护已读。
- **投递**：群组消息默认只投信箱；`wake=true` 时逐个尝试唤醒空闲成员，运行中/超频/无法恢复的成员
  降级为信箱，唤醒路径的逐成员结果记录在 `delivery.members`，汇总 `mode`/`delivered`/`note`。
- **回复**：回复群组消息默认回到群组（收件人为回复时的当前成员）；原群组已删除时给出明确错误。
- **管理 API**：`state` 返回 `groups[]`（含成员、未读）并接受 `groupIdFilter`；`send` 支持 `groupId` /
  `to="group:<名称>"`；新增 `groupCreate` / `groupUpdate` / `groupDelete`。
- **UI**：左侧新增「群组」区；顶部「新建群组」打开编辑器，按工作区勾选会话、可改名/增删成员/删除；
  发消息目标类型增加「群组」；群组消息带群组徽标，详情显示群组与成员数，回复回群组。
- **工具**：`mail_send` 支持 `to="group:<名称>"` / `groupId`；`mail_inbox` 显示所在群组的群发；
  `mail_reply` 群消息回群组；`workspace_list` 同时列出群组与成员。
- 版本号升到 `0.2.0`；locale 的 meta 描述同步提到群组。

### 设计取舍

- **默认只投信箱**：群发不默认唤醒所有成员，避免一次群发烧掉一批 token；需要时显式 `wake=true`。
- **成员快照**：消息按发送时成员投递，新增成员不会补收旧消息，避免“拉人进群后历史全泄露”。
- **删组不删信**：删除群组后历史消息仍留在信箱，`to.groupId` 保留，可读可回（回复会提示群已删除）。
- **硬链接/附件**：群发同样受发送方工作区附件限制与硬链接拒绝策略约束。

### 测试

- 全量回归（store / resolve / format / route）：**127 tests / 42 suites，127 pass，0 fail**（约 7s，
  连跑三次一致）。群组覆盖 store CRUD/唯一名/上限/快照可见性/删组保信、resolve 群组寻址与优先级、
  delivery 逐成员结果、route group actions/state.groups/groupIdFilter/send、tools 群发/群回/
  workspace_list groups、format 群组文案（zh/en）。

### 复核 4（review-4）：PASS

- 0 new blocker / 0 new major；群组模型、快照可见性、寻址优先级、逐成员投递、群回复、群 CRUD、
  state.groups/groupIdFilter、工具/workspace_list、客户端 payload 对齐、文档/版本/release 面全部通过。
- 非阻塞观察（已处理可处理项）：`mail_send` schema 已去掉 `required:['to']` 以支持 groupId-only；
  API 版本号升到 0.2.0、`send.wake` 注释说明群组强制默认信箱；`maxGroupMembers` 标注为仅 config/store；
  `delivery.members` 标注仅唤醒路径；API §5 补 `group-not-found`；CHANGELOG 中的盘符临时路径字面量已清除。
  其余（管理视角顶部徽标不含群组未读、选中群组不自动切到「全部」、设置页无 maxGroupMembers 控件）留作后续增强。
- 验证限制：面板视觉未在浏览器里实测（需刷新页面加载新 Client）；真实群唤醒只用 fake-Host 验证；
  归档会话的群组成员关系未测。

### 备份

| 时间 | 目录 | 内容 |
|---|---|---|
| 2026-11-06 12:09:17 | `20261106-120917` | 群组功能开发前基线（24 文件） |
| 2026-11-06 12:17:43 | `20261106-121743` | 群组 Host 核心 + 文档（24 文件，Client/测试未完成） |
| 2026-11-06 12:28:46 | `20261106-122846` | v0.2.0 群组功能完成：Host + Client + 127 条测试 + 文档（24 文件） |
| 2026-11-06 12:40:35 | `20261106-124035` | review-4 PASS + 非阻塞 nit 修复后（25 文件）；随后仅同步本表再存最终版 |

## 2026-11-05 · 首个可用版本 0.1.0

### 新增

- Host 半：持久化信箱（`$DSH_HOME/cross-workspace/store.json` + `attachments/`）、工作区/会话索引与寻址、
  唤醒/信箱双投递（含频率限制、最大回复深度、运行中降级）、6 个 agent 工具（`mail_send` / `mail_inbox` /
  `mail_read` / `mail_reply` / `mail_wait` / `workspace_list`）、管理 HTTP API、按 agent 注册的未读摘要
  system prompt context。
- Client 半：侧栏面板图标（`sidebar.panellist` id `cross-workspace`）、完整管理页（`main` key
  `cross-workspace`）、设置页（`settings.section` id `cross-workspace` order 62）。中英双语、只用主题 token、
  无构建步骤。
- 测试：`test/store.test.mjs`、`test/resolve.test.mjs`、`test/format.test.mjs`、`test/route.test.mjs`，
  共 102 条（review-1 后从 75 条扩到 97 条，review-2 后再补到 102 条：硬链接/缺失附件/预览本地化/
  自唤醒措辞/allowExternalAttachments 持久化），覆盖 store 持久化/可见性/已读/附件/清理、索引与寻址、
  渲染文本、HTTP 路由与工具、系统提示注入生命周期。
- 文档：`README.md`（使用/配置/安全边界）、`docs/API.md`（前后端与测试共同契约）。

### 修复（安装前代码审查发现）

- 附件-only 消息被 `empty-message` 误拒：空消息判断现在接受 `attachmentSources`。
- `maxSubjectChars` 原按 UTF-8 字节计数，中文主题被误限；改为按字符计数，错误文案改为「字符」。
- 工作区级未读数从「当前查看者」改为「该工作区管理口径」（没人读过的信），面板可看到其它工作区积压；
  顶部徽标仍用当前查看者 `unreadTotal`。
- 空白会话唤醒策略、`delivery.mode` 文档口径、API.md §5/§7 签名漂移等一系列一致性问题。
- `workspace_list` 返回值含 `undefined` 字段导致 Host 拒绝（`value is not lossless JSON`）：
  已改为按需省略可选字段。

### 独立复核（reports/review-1.md，0 blocker / 3 major / 10 minor / 6 nit）与修复

**Major**

1. **附件可绕过文件权限**：`mail_send` 原接受任意绝对路径并把文件复制进 store，`mail_read` 还会内联文本，
   等于绕过会话的 fs sandbox。修复：新增设置 `allowExternalAttachments`（默认 false）；发送时对每个附件用
   `realpath` 校验必须位于**发送方工作区**内（符号链接逃逸也拒绝），错误码 `attachment-outside-workspace` /
   `attachment-root-unknown`。README 与工具描述同步说明。
2. **机器路径/本地用户名出现在发布面**：README 在 `package.json#files` 里却写了本机盘符路径与 Windows
   用户目录；CHANGELOG 写了本机备份路径。修复：README 全部改用 `<本项目目录>` / `<DSH运行时>` 等占位符；
   CHANGELOG 改用 `<备份根目录>`；新增 `LICENSE`（MIT）并加入 `files`。
3. **HTTP fence 可被回落绕过**：`connection.requestRejection(req)` 明确返回拒绝时，原实现仍回落到
   Origin==Host 比较。修复：装配了 connection 服务时只接受 `=== undefined`，被拒即 403；仅服务缺失时才用
   同源兜底。补充说明进 README/API。
4. **持久化竞态**：`markRead` 在写盘进行中触发时可能丢失一次已读状态写入。修复：`MailStore._schedulePersist`
   增加 dirty 循环与写完后补写。

**Minor（已处理）**

- `mail_send` / `mail_reply` 的工具结果与 `delivery.note` 现在跟随 `promptLocale`（zh/en），`mail_wait` 超时/取消
  文案同样本地化；广播回退提示也本地化。
- 广播唤醒会**排除发送方自己**（`pickWakeSession(workspace, excludeSessionId)`），避免自己唤醒自己。
- `mail_reply` 原发件会话已不存在时仍会退化为工作区广播，现在在结果 warnings 里明确说明（文档同步）。
- README 的配置说明改为「无 Config schema、宽松读取」；工具参数指向 API §6 并补齐参数表。
- `.gitignore` 增加 `reports/`、`coverage/`、`*.tmp` 等；`package.json#files` 加入 CHANGELOG/LICENSE。
- 文档补：管理 API 的 `returned/total/orphans` 等返回字段、`w:` viewer 的适用范围、format 导出签名、
  `allowExternalAttachments`、`promptLocale` 的作用范围。

**Nits（已处理/说明）**

- `dsh.client.inject` 已裁剪为 locale/settings/sidebar 三项（去掉不存在的静态 slots 行）。
- workspace viewer 由面板真正发送 `workspacePath`（管理视角目前不标记已读）属于可选增强，留待下一版；
  当前行为在 API.md 里已写明。
- 视觉/明暗主题的实际观感仍需浏览器确认（reviewer 的 Client Slots inspect 多次超时）。

### 独立复核 2（reports/review-2.md，0 blocker / 1 major / 4 minor / 5 nit）与修复

- **NEW-1（major）硬链接可绕过附件路径检查**：`lstat(realpath(path)).nlink > 1` 且未开启
  `allowExternalAttachments` 时拒绝，错误码 `attachment-hardlink`；README/API 记录“realpath 校验与复制之间的
  换链竞态”为本机同用户残余风险（未在本轮做 fd-based copy）。
- **NEW-2 `allowExternalAttachments` 无可视开关**：设置页新增开关（含风险提示），保存 patch 同步该字段。
- **NEW-3 内联预览**：只有真正截断时才丢弃末尾 U+FFFD；截断标记随 `promptLocale`（zh/en）。
- **NEW-4 不存在的附件**被误报为“工作区外”：现在返回 `file-not-found`，不再给开启外部附件的错误建议。
- **NEW-5 API 旧未读口径**：§4 已改为“工作区口径不依赖查看者；管理视角 inbox 为空、用 all 汇总”。
- **NEW-6/7/8/9/10**：README 发布提醒改为“CHANGELOG 随包、reports 不随包”；CHANGELOG 的 inject 条目改为已处理；
  API §5 补 `buildIndex`/`resolveTarget` 的 options、exists、`MailView.files.mediaType`；工具 `files` 参数
  描述加入工作区限制；自唤醒被跳过时 warnings 用“只有发送方自己”的措辞，API §3 补排除规则。
- 复核测试：102 tests / 35 suites 已验证两遍；hardlink / missing-file / preview locale / self-wake warning /
  `allowExternalAttachments` 持久化的回归测试在本轮补齐。

### 复核 3（reports/review-3.md）：PASS

- 0 new blocker / 0 new major；review-2 的 10 项（NEW-1…NEW-10）全部确认修复；
  102 tests / 35 suites 复核两遍全绿；privacy scan 在发布面干净；严格 fence 活体复验 403。
- 复核提出的非阻塞 nit：CHANGELOG 曾出现具体盘符临时路径（已改为 `<盘符>`）；
  硬链接测试的链接创建未包 try/catch（仅影响非 Windows 可移植性）；`realpath` 的 EACCES 目前也映射为
  `file-not-found` 文案。均不影响交付。
- 验证限制：面板视觉仍未在浏览器里实测（Client Slots inspect 多次超时）；`realpath`→copy 的 TOCTOU 是
  已记录的本机同用户残余风险，未做竞态实测；归档会话行为未测。

### 验证

- `node --test test\store.test.mjs test\resolve.test.mjs test\format.test.mjs test\route.test.mjs`：
  **102 tests / 35 suites，102 pass，0 fail**（约 6s；review-2 后连跑两次一致）。
- **review-2 修复后活体复验**（再次关闭/开启插件重载后）：
  - `workspace_list` 正常返回 2 个注册工作区 + 孤儿会话；
  - 工作区外附件 `C:\Windows\win.ini` → `attachment-outside-workspace`；
  - 同盘硬链接（`<盘符>\__cw-hardlink-src.txt` 的链接放在工作区 `.tmp/`）→ `attachment-hardlink` 拒绝；
  - 工作区内不存在的路径 → `file-not-found`；
  - 测试用临时文件与硬链接已按名字删除。
- 本地 fake-Host 集成冒烟：路由注册、6 工具注册、`state` / `send`(mailbox+wake) / `read` / `mark` / `delete` /
  `deliver` / `settings` / `prune` / `clear`、HTTP 403/405/415 拦截、唤醒降级、tools render 形状。
- 安装：`plugin_manager install_bundle target=<本项目目录>` 成功；
  profile `package.json` 记录 `link:<本项目目录>` 并追加 bundle；
  `node_modules/dsh-cross-workspace` 为 Junction。
- 安装后活体检查（当前页面）：
  - `sidebar.panellist` 占用 `cross-workspace`（order 23，active）；
  - `main` 占用 key `cross-workspace`（active）；
  - `settings.section` 占用 `cross-workspace`（order 62，active）；
  - `mail_*` 六个工具出现在当前 Agent 的工具表。
- **活体跨工作区 E2E（2026-11-05 23:34，真实 Harness）**：
  1. 主会话（本机当前开发会话）用 `mail_send` 向临时工作区 `.tmp\cw-e2e-b`
     广播一封带 JSON 数据的测试信（`wake=false`），消息 id `m-mw3phf7u-4ea49a`。
  2. 以 `cwd=.tmp\cw-e2e-b` 启动真实子会话；它的 `mail_inbox` 返回 1 条未读，
     `mail_read` 正确返回正文 + `data={"purpose":"e2e",...}`。
  3. 子会话用 `mail_reply` 回复 `E2E-REPLY-OK`，自动路由回主会话，线程 `m-mw3phf7u-…`，hop=1，
     `delivery=mailbox`（主会话运行中，按规则降级）。
  4. 主会话在下一轮**真的在系统提示里看到**「【跨工作区信箱】本会话有 1 条未读…」；
     `mail_read` 读回正文与 `data={"ok":true,"from":"workspace-b"}`。
  5. 验证后通过管理 API `delete` 删除两封测试信、删除临时目录，store 回到 0 条。
  - 产物：`.tmp/cw-host-smoke.mjs` / `cw-deliver-smoke.mjs` / `cw-json-check.mjs`
    （Lead 侧 fake-Host 冒烟）；E2E 临时目录已清理。

### 备份记录

| 时间 | 目录（相对 `<备份根目录>`） | 内容 |
|---|---|---|
| 2026-11-05 23:30:58 | `20261105-233058` | 安装前检查点：19 个文件（Host/Client/Tests/Docs） |
| 2026-11-05 23:51:45 | `20261105-235145` | 安装 + 活体 E2E 后、review 修复前：20 个文件 |
| 2026-11-06 00:15:31 | `20261106-001531` | review-1 修复 + 97 条测试 + docs/LICENSE 后：22 个文件 |
| 2026-11-06 00:30:04 | `20261106-003004` | review-2 修复（硬链接/缺失文件/预览本地化/设置开关）+ 102 条测试：23 个文件 |
| 2026-11-06 00:40:09 | `20261106-004009` | review-3 PASS 后（24 文件）；随后仅补本表一行，再存最终版 |

### 已知限制 / 下一步

- 安装的是 `link:` 本地包。实践验证：在 Plugin Manager 里**关闭再开启本插件**会触发一次 profile
  recomposition，HMR 按文件变更替换 linked package，无需重启；最稳妥仍是重启 DSH。
- 跨机器通信不在本版范围；只覆盖同一 Host 进程内的工作区。
- 归档会话不进入 `workspace_list`，也不能被唤醒。
- 唤醒投递会真实调用目标模型、消耗 token。
- 管理视角没有「工作区级已读」；阅读/标记已读以具体会话为单位。
- 视觉/明暗主题的实际观感需浏览器确认。
