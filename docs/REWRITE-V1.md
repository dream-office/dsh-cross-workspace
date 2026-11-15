# cross-workspace v1.0 重做架构（rewrite/v1.0）

> 目标：**不是再补 0.9.1**，而是从冻结候选 `c811d48` 起，client 从零重写；Host 内部允许
> 抽模块，但 **store 数据、6 个 mail 工具、管理 API 路径与参数、投递语义保持不变**。
> 本文先于实现；预览 HTML 用于确认视觉与按钮，再接 Host。
> 分支：`rewrite/v1.0`；目标版本 `1.0.0`；未 push/Release。

---

## 1. 硬约束（不可动）

| 项 | 约束 |
|---|---|
| store | 保留 `.dsh/cross-workspace/store.json`、`attachments/`、群组/设置；schema v2 可读；迁移可回滚 |
| 工具 | `mail_send / mail_inbox / mail_read / mail_reply / mail_wait / workspace_list` 名称、参数、结果字段不变 |
| API | `POST /plugins/dsh-cross-workspace/api`，actions 名称与 request/value 不变 |
| 投递 | `wake / queued / mailbox / failed / none` 语义、群组 top-level mode、wake 确认规则不变 |
| 备份 | 重做前已有 `20261115-rewrite-pre`（repo + store + profile + bundle）；本分支另有 `20261115-174535` |

**允许改**：Host 内部文件拆分、client 全部重写、测试/文档、build stamp。
**禁止**：删 store、改工具/API 契约、在未备份时迁移数据、push/Release。

---

## 2. client 单状态模型

### 2.1 唯一 `view` 状态

```ts
type View =
  | 'dashboard'
  | 'messages'
  | 'groups'
  | 'workspaces'
  | 'graph'
  | 'settings'
  | 'compose'      // 发送抽屉（全屏遮罩 + 底部抽屉）
  | 'detail'       // 消息详情
  | 'groupEditor'  // 新建/编辑群组
```

- **只有一个顶层 `view`**；不再有 `surface / secondary / split / compose / detail / groupEditor`
  六个布尔/字符串互相覆盖。
- `split` 只是 ≥1100 的 **布局结果**（消息列表 + 详情并排），不是状态。
- 每个视图接收 `params`（如 `{messageId, groupId, returnView}`），由 `navigate(view, params)` 统一设置。
- 返回：`back()` 读 `params.returnView || 'dashboard'`；不靠多层条件嵌套猜当前页。
- 每按一次按钮 = 一个明确 handler（`onSend`, `onOpenMessage`, `onBack`, `onRetry`, `onRefresh`…），
  **禁止空函数**；测试覆盖每个 handler 的状态变化或 API 调用。

### 2.2 组件边界

```
App
├─ TopBar (workspace, build stamp, range/search/refresh/new, more)
├─ DashboardView (KPI 6、7天柱、投递环形、三卡、最近消息 6/12/20)
├─ MessagesView (列表；≥1100 时与 DetailPane 并排)
├─ GroupsView (列表 + 新建/编辑)
├─ WorkspacesView (工作区/会话树)
├─ GraphView (SVG 交流图 + 节点点击)
├─ SettingsView (设置入口；无 shell API 时给 Host 设置页提示)
├─ ComposeDrawer (收件人 + 主题 + 正文 + 发送)
├─ DetailPane (回复/重试/标记已读/编辑/删除)
└─ GroupEditor (名称/成员/保存/取消)
```

- host 侧继续用 `lib/store.js`、`lib/resolve.js`、`lib/delivery.js`、`lib/format.js`；
  v1 新增 `lib/state.js` 负责 `buildState` 分组，避免 `index.js` 继续膨胀。
- `client.js` 不引入构建步骤；仅 `require('react')`，样式继续走 `--dsw-alias-*` + 青碧 tokens。

### 2.3 Build stamp

顶部常驻：

```
1.0.0-rewrite <short-sha>
```

实现：client 常量 `BUILD_STAMP = '1.0.0-rewrite <sha>'`，由 `scripts/stamp.mjs` 在提交前写入/校验；
测试断言 `^1\.0\.0-rewrite [0-9a-f]{7,40}$`。用户一眼可确认加载的是新版，而不是缓存。

---

## 3. 数据与迁移

- **不迁移 store**：继续读写现有 `store.json`（schema v2）；新增字段必须可选、向后兼容。
- 如未来必须迁移：
  1. 先复制 `store.json` → `store.backup-<ts>.json`；
  2. 迁移函数纯函数，可 `--rollback`；
  3. 启动时先校验，失败不覆盖原文件；
  4. 测试覆盖 v2 → v3 → 回滚。
- v1 重做阶段**不做**迁移；先证明读取/写入同一份 store 正常。
- 附件路径、群组成员快照、`deletedGroupMemberIds`、readBy 规则全部沿用。

---

## 4. Host 兼容层

- 工具注册、schema、`output.schema/render` 不改；从 `index.js` 抽到 `lib/tools.js` 时逐字保留。
- actions 按域拆 `lib/actions/state.js`、`send.js`、`groups.js`、`settings.js`；路径与错误码不变。
- 投递继续用 `lib/delivery.js`；本次重做**不改** wake 确认/排队/限流语义。
- 验收：旧 client 仍能调新 Host；新 client 仍能调旧 Host（接口兼容）。

---

## 5. 预览 HTML

- 路径：`preview/v1.0.0.html`（单文件、无依赖、假数据）。
- 包含：仪表盘/KPI/图表/三卡/消息表、消息列表、群组/工作区/交流图/设置、发送抽屉、详情；
  所有按钮可点，底部显示当前视图与操作日志；顶部显示 `1.0.0-rewrite preview`。
- 预览只验证视觉/交互；**不接 Host、不读写 store**。
- 截图：当前环境无浏览器自动化，无法生成真实 1280/390/320 截图；预览 HTML 可直接打开查看。
  设计参考图在 `设计系统\cross-workspace-UI\证据\`（v4 设计，不是本预览截图）。

---

## 6. 测试策略

1. **真渲染**：fake React 渲染完整 `App`（不是只调用组件），覆盖初始 dashboard。
2. **每个按钮一个测试**：调用 handler 后断言 `view`/`params`/API 调用/列表内容；禁止只断言 DOM 存在。
3. **KPI 一致性**：DashboardView 的数值与 `state.stats`/`days` 求和一致；未读 KPI 进 `unread` 筛选。
4. **二级页**：工作区/群组/交流图的每个入口、返回、编辑、发送都有测试。
5. **兼容测试**：旧 `state` fixture 能渲染；6 工具 schema 快照；store v2 读写。
6. **build stamp**：正则 + 页面顶部出现。
7. 目标：≥ 220 tests；Playwright 可用后再补截图，不以截图代替测试。

---

## 7. 干净安装（不破坏当前 store/profile）

1. 新分支先不安装；预览 HTML 直接打开。
2. 接 Host 后：
   - 确认 `F:\__备份\4-项目\跨工作区信使\2026\11\20261115-rewrite-pre` 存在；
   - Plugin Manager 关闭 `cross-workspace`；
   - 用新分支路径重新 enable（或替换 profile link）；
   - 重启 DSH + 强刷；
   - 验证 store 未迁移、旧消息/群组/设置仍在。
3. 回滚：Plugin Manager 关闭 → 切回 `c811d48` → enable；store 未动，直接恢复。
4. 不手动改 profile 的 package/patch；走 `plugin_manager`。

---

## 8. 交付顺序

1. 本文架构 + `preview/v1.0.0.html`（本轮）
2. 新 client 骨架：单 `view` + TopBar + Dashboard + Messages + 每按钮 handler + build stamp
3. 二级页/抽屉/详情/群组编辑接入
4. Host 抽模块（保持契约）
5. 全量测试 + 独立复核 + 干净安装验证
6. 最后才讨论 1.0.0 发布/tag/push

---

## 9. 风险

| 风险 | 处理 |
|---|---|
| 用户仍看到旧 UI | build stamp 是唯一可信标志；加载不到新 stamp 先查 module cache/版本，不继续改 UI |
| 大规模重写漏契约 | 先冻结工具/API schema 快照测试，Host 改动逐字对照 |
| store 被误迁移 | v1 不迁移；任何迁移先备份 + 回滚测试 |
| 预览与真实样式偏差 | 预览只用宿主 token；接 Host 后真渲染复核 |
| 无截图证据 | 明确标注不可用；不伪造截图，不用设计图冒充实机 |
