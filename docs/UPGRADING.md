# 升级、数据版本与开源发布

> 面向维护者和使用者。插件版本（`package.json.version`）和 **store 数据版本**
> （`lib/store.js` 的 `STORE_VERSION`）是两套独立版本号：插件升级不一定改数据格式，但数据格式一旦
> 变化必须走这里的迁移流程。

- 插件版本：`0.8.2`
- 最后同步：2026-11-07
- 当前 store schema：`2`
- 当前测试：191 tests / 57 suites（以仓库实际为准）
- 数据位置：`$DSH_HOME/cross-workspace/store.json` + `attachments/`

---

## 1. 版本对应表

| 插件版本 | store schema | 数据变化 |
|---|---|---|
| 0.1–0.7 | 1 | 初始信箱、群组、设置；0.6.2/0.7 已出现 `editedAt`/`deletedGroupMemberIds`/`allowWorkspaceBroadcast` 字段，但仍写 schema 1 |
| 0.8.0 | 2 | 正式引入 schema 版本与迁移；旧字段缺省时由 normalization 补齐，消息结构不变 |
| 0.8.x+ | 2 | 只增加版本读取/迁移接口与 `storeVersion` 状态字段 |

> 判断依据不是插件版本，而是 `store.json` 的 `version` 字段；插件启动时自动迁移。
> 面板 `state.storeVersion` 和 `store.getStoreInfo()` 会返回当前 schema 版本。

---

## 2. 正常升级（v1 → v2）

1. **先备份**整个 `$DSH_HOME/cross-workspace` 目录（至少 `store.json` 与 `attachments/`）。
2. 替换/升级插件（本地 `link:` 目录则替换代码；安装包则用 Plugin Manager 升级）。
3. 关闭再开启 `include:cross-workspace`，或重启 DSH（Host 半生效）；刷新页面（Client 半生效）。
4. 首次加载时：
   - `version` 缺失 → 按 v1 读取并自动迁移到 v2；
   - 迁移后自动把 `version: 2` 写回 `store.json`；
   - 消息、群组、已读、附件路径、设置保持不变；缺失字段由 normalization 补默认值。
5. 打开面板验证：`state.storeVersion === 2`，消息/群组数量正确，未读正常。
6. 迁移成功后再做一次备份。

### 旧数据具体怎么补

- `editedAt`：旧消息没有 → 不显示「已编辑」，不做伪造。
- `to.deletedGroupMemberIds`：旧删群消息没有 → 按历史快照兼容（仅对旧数据；新删群会冻结成员）。
- `allowWorkspaceBroadcast`：旧设置没有 → 取默认 `false`（隐私默认），旧广播对 Agent 隐藏，
  owner 管理面板仍可见；需要广播时在设置页显式开启。
- 其他字段缺省：走 `normalizeMessage` / `normalizeGroup` / `normalizeSettings` 的默认值。

---

## 3. 降级与不兼容

- **不支持直接降级插件**，尤其当 `store.json.version > STORE_VERSION` 时：
  插件会抛 `store-version-too-new`，**不会改写/删除** store.json，也不会静默清空。
  处理：升级插件到匹配版本，或从升级前备份恢复 `store.json`。
- **旧插件读新数据**没有兼容承诺；先备份再尝试。
- `version` 非法（非整数/小于 1）：抛 `store-version-invalid`，同样不自动改写文件。
- 迁移缺少对应函数：抛 `store-migration-missing`（开发期错误，不是用户数据问题）。

---

## 4. 维护者迁移契约

数据格式变化时按顺序做：

1. `lib/store.js` 提升 `STORE_VERSION`（整数 +1）。
2. 在 `STORE_MIGRATIONS` 增加 `n: data => data` 的纯函数，只做必要转换；不要依赖时间/外部状态。
3. 新字段必须在 `normalizeMessage` / `normalizeGroup` / `normalizeSettings` 里可缺省、可回退。
4. `load()` 负责迁移并写回；迁移失败时绝不覆盖原文件。
5. 增加测试：旧版本数据可加载、迁移后字段正确、写回版本、未来版本拒绝、非法版本拒绝。
6. 更新本文档的版本对应表、`docs/API.md` 的 store/state 字段、`CHANGELOG.md`。
7. 备份到工作区外的备份目录，并让独立子智能体复核。

### 版本号策略

- **插件 semver**：新增功能 `0.x` 次版本；只修 bug/文档 `0.x.y`；正式 `1.0.0` 后按 semver。
- **store schema**：只在磁盘结构/语义变化时 +1；纯 UI/工具行为变化不 +1。
- **管理 API**：action 只增不删；删除/改名视为破坏性变更，需要主版本或明确迁移说明。
- **工具参数**：只增可选参数；已有字段语义变化要写 CHANGELOG 与 API 迁移注记。

---

## 5. 开源发布前检查清单

- [x] `package.json`：`license`、`files` 完整；`repository` / `homepage` / `bugs` 已填
      `dream-office/dsh-cross-workspace` 规划地址；`private: true` 暂时保留（仅 GitHub 发布，不发 npm）。
- [x] `LICENSE` 存在且与 `package.json#license` 一致（当前 MIT）。
- [x] 不包含个人绝对路径、真实姓名/客户数据；个人邮箱仅限 owner 批准的 `package.json#author`；
      `SECURITY.md`/`CODE_OF_CONDUCT.md` 使用 GitHub 私下报告；`reports/` 保持 gitignore 且不在 `files`。
- [x] `README.md` / `AGENTS.md` / `docs/API.md` / `docs/ARCHITECTURE.md` / `docs/UPGRADING.md` 同步。
- [x] 测试全绿；`CHANGELOG.md` 写明迁移影响。
- [ ] 打 tag（例如 `v0.8.2`）；Release 说明链接本文档的升级步骤。
- [ ] 发布前做隐私扫描（真实路径、邮箱、密钥）；不要把本机 `store.json`/附件/备份提交。
- [ ] 安装说明使用相对路径/占位符，不写维护者个人目录。

---

## 6. 常见问题

**Q：升级后消息变少？**
先看 `state.total` 与 `store.json.version`；插件有保留天数/数量清理，检查设置 `retentionDays`/`maxMessages`。
迁移本身不删消息。

**Q：升级后旧广播消失？**
`allowWorkspaceBroadcast` 默认关闭；这是隐私默认，不是数据丢失。owner 管理面板仍可见；需要时在设置页开启。

**Q：能回退到旧版插件吗？**
可以回退代码，但若数据已迁到更高 schema，旧插件可能拒绝或误解；先备份，必要时恢复旧 `store.json`。
