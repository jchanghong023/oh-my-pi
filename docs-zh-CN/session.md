# Session Storage and Entry Model

本文档是 coding-agent 会话如何表示、持久化、迁移以及在运行时重建的权威规范。

## Scope

涵盖：

- 会话 JSONL 格式与版本管理
- 条目分类法与树语义（`id`/`parentId` + leaf 指针）
- 加载旧文件或畸形文件时的迁移/兼容性行为
- 上下文重建（`buildSessionContext`）
- 持久化保证、失败行为、截断/blob 外置化
- 存储抽象（`FileSessionStorage`、`MemorySessionStorage`）及相关工具

不涵盖 `/tree` UI 的渲染行为，除非该行为影响会话数据。

## Implementation Files

- [`src/session/session-manager.ts`](../packages/coding-agent/src/session/session-manager.ts) — 编排：树/leaf、append、持久化、blob、生命周期工厂
- [`src/session/session-entries.ts`](../packages/coding-agent/src/session/session-entries.ts) — 条目/header 类型、`SessionEntry` 联合类型、`CURRENT_SESSION_VERSION`
- [`src/session/session-migrations.ts`](../packages/coding-agent/src/session/session-migrations.ts) — 版本迁移
- [`src/session/session-loader.ts`](../packages/coding-agent/src/session/session-loader.ts) — 文件加载 + blob-ref 解析
- [`src/session/session-context.ts`](../packages/coding-agent/src/session/session-context.ts) — `buildSessionContext`
- [`src/session/session-persistence.ts`](../packages/coding-agent/src/session/session-persistence.ts) — 截断 + image blob 外置化
- [`src/session/session-paths.ts`](../packages/coding-agent/src/session/session-paths.ts) — 磁盘布局、目录编码、terminal breadcrumbs
- [`src/session/session-listing.ts`](../packages/coding-agent/src/session/session-listing.ts) — 发现（list/recent/resolve）
- [`src/session/session-storage.ts`](../packages/coding-agent/src/session/session-storage.ts) — 存储抽象
- [`src/session/session-title-slot.ts`](../packages/coding-agent/src/session/session-title-slot.ts) — 定宽当前标题槽
- [`src/session/indexed-session-storage.ts`](../packages/coding-agent/src/session/indexed-session-storage.ts) — 本地索引 + 有序的远端备份存储适配器
- [`src/session/messages.ts`](../packages/coding-agent/src/session/messages.ts) — 自定义消息转换器
- [`src/session/blob-store.ts`](../packages/coding-agent/src/session/blob-store.ts) — 内容寻址 blob 存储
- [`src/session/history-storage.ts`](../packages/coding-agent/src/session/history-storage.ts) — prompt 历史（独立子系统）

## On-Disk Layout

默认 file-session 位置：

```text
~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<sessionId>.jsonl
```

`<encoded-cwd>` 由规范化的 cwd 派生（因此 symlink 别名共享同一个 bucket）：home 下的目录为 `-<relative>`，temp 根目录下的目录为 `-tmp-<relative>`，其余为 `--<encoded-absolute>--`，路径分隔符替换为 `-`。

访问时，由短生命周期的哈希方案（`<scope>-<project-basename>-<sha256(canonical-cwd)>`，用于 17.2.5-17.2.8，并在 17.2.9 中由 #7397 回退）写入的 bucket 会以尽力而为的方式迁移回路径编码名称，连同旧式 `--<home-encoded>-*--` 形式的 home 相对 bucket。

Blob 存储位置：

```text
~/.omp/agent/blobs/<sha256>
```

Terminal breadcrumb 文件写入到：

```text
~/.omp/agent/terminal-sessions/<terminal-id>
```

Breadcrumb 内容是原始 cwd 和会话文件路径，以及可选的第三行 `fresh`。一个 fresh breadcrumb 会保留一个 `/new` 边界——其懒创建的 JSONL 文件尚不存在——以防止 `continueRecent()` 重新打开上一次的会话。写入是同步、有序且尽力而为的。

## File Format

会话文件为 JSONL：每行一个 JSON 对象。当前文件在物理上以一个定宽 256 字节的 `type: "title"` 槽开头，随后是会话 header，然后是 `SessionEntry` 值。旧文件可能直接以 header 开头。Loader 会剥离物理槽，并将其当前标题/来源合并到逻辑 header。

- 逻辑上的第一条 entry 始终是会话 header（`type: "session"`）。
- 其余逻辑 entry 是 `SessionEntry` 值。
- 运行时 entry 是 append-only 的；分支导航通过移动指针（`leafId`）而不是修改现有 entry。

### Header (`SessionHeader`)

```json
{
  "type": "session",
  "version": 3,
  "id": "1f9d2a6b9c0d1234",
  "timestamp": "2026-02-16T10:20:30.000Z",
  "cwd": "/work/pi",
  "title": "optional session title",
  "titleSource": "auto",
  "additionalDirectories": ["/work/shared"],
  "previousSessionFiles": ["/old/location/session.jsonl"],
  "providerPromptCacheKey": "optional inherited cache identity",
  "parentSession": "optional lineage marker"
}
```

说明：

- `additionalDirectories` 记录除 `cwd` 之外经过规范化、去重的工作区根目录。
- `previousSessionFiles` 记录成功移动后的先前绝对位置。
- `providerPromptCacheKey` 携带符合条件的完整 fork 所继承的 provider prompt-cache 标识。
- `parentSession` 是一个不透明的 lineage 字符串。当前代码根据流程（`fork`、`forkFrom`、`createBranchedSession`，或显式的 `newSession({ parentSession })`）写入 session id 或 session path。将其视为元数据，而非类型化的外键。

- `titleSource` 为 `auto` 或 `user`；自动重命名不能覆盖用户标题。

### Entry Base (`SessionEntryBase`)

所有非 header 的 entry 包含：

```json
{
  "type": "...",
  "id": "8-char-id",
  "parentId": "previous-or-branch-parent",
  "timestamp": "2026-02-16T10:20:30.000Z"
}
```

`parentId` 对于根 entry（首次 append，或 `resetLeaf()` 之后）可以为 `null`。

## Entry Taxonomy

`SessionEntry` 是以下类型的联合：

- `message`
- `thinking_level_change`
- `model_change`
- `service_tier_change`
- `compaction`
- `branch_summary`
- `reset_boundary`
- `custom`
- `custom_message`
- `label`
- `title_change`
- `ttsr_injection`
- `credential_pin`
- `session_init`
- `mode_change`

### `message`

直接存储一个 `AgentMessage`。

```json
{
  "type": "message",
  "id": "a1b2c3d4",
  "parentId": null,
  "timestamp": "2026-02-16T10:21:00.000Z",
  "message": {
    "role": "assistant",
    "provider": "anthropic",
    "model": "claude-sonnet-4-5",
    "content": [{ "type": "text", "text": "Done." }],
    "usage": {
      "input": 100,
      "output": 20,
      "cacheRead": 0,
      "cacheWrite": 0,
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "total": 0
      }
    },
    "timestamp": 1760000000000
  }
}
```

### `model_change`

```json
{
  "type": "model_change",
  "id": "b1c2d3e4",
  "parentId": "a1b2c3d4",
  "timestamp": "2026-02-16T10:21:30.000Z",
  "model": "openai/gpt-4o",
  "role": "default"
}
```

`role` 是可选的；在上下文重建中，缺失会被视为 `default`。

### `service_tier_change`

```json
{
  "type": "service_tier_change",
  "id": "c1d2e3f4",
  "parentId": "b1c2d3e4",
  "timestamp": "2026-02-16T10:21:45.000Z",
  "serviceTier": { "openai": "priority", "google": "flex" }
}
```

`serviceTier` 是一个按族映射的 map，键为 `openai`/`anthropic`/`google`（每个值为 `auto`/`default`/`flex`/`scale`/`priority`），当没有激活的 tier 时为 `null`。存储为单个字符串（`"flex"`、`"openai-only"`、`"claude-only"`、…）的旧 entry 在读取时被规范化为此 map。

### `thinking_level_change`

```json
{
  "type": "thinking_level_change",
  "id": "c1d2e3f4",
  "parentId": "b1c2d3e4",
  "timestamp": "2026-02-16T10:22:00.000Z",
  "thinkingLevel": "high"
}
```

`configured` 还可以额外保留用户选择的选择器（`"auto"` 或一个具体级别）。读取较旧 entry 的代码会回退到 `thinkingLevel`。

### `compaction`

```json
{
  "type": "compaction",
  "id": "d1e2f3a4",
  "parentId": "c1d2e3f4",
  "timestamp": "2026-02-16T10:23:00.000Z",
  "summary": "Conversation summary",
  "shortSummary": "Short recap",
  "firstKeptEntryId": "a1b2c3d4",
  "tokensBefore": 42000,
  "details": { "readFiles": ["src/a.ts"] },
  "preserveData": { "hookState": true },
  "fromExtension": false
}
```

### `branch_summary`

```json
{
  "type": "branch_summary",
  "id": "e1f2a3b4",
  "parentId": "a1b2c3d4",
  "timestamp": "2026-02-16T10:24:00.000Z",
  "fromId": "a1b2c3d4",
  "summary": "Summary of abandoned path",
  "details": { "note": "optional" },
  "fromExtension": true
}
```

如果从根分支（`branchFromId === null`），`fromId` 是字面字符串 `"root"`。

### `reset_boundary`

由 `/clear` 追加的无 payload 标记。折叠后的实时 transcript 以及重建的 model context 从最新的适用边界之后开始；全历史 transcript 导出会保留其之前的 entry。

### `custom`

由核心子系统或扩展拥有的不透明、非 LLM 记录。`buildSessionContext` 不会直接将它们转换为 model message，但特定子系统的回放代码可以消费 `customType` 值以恢复运行时状态或诊断中断的轮次。

```json
{
  "type": "custom",
  "id": "f1a2b3c4",
  "parentId": "e1f2a3b4",
  "timestamp": "2026-02-16T10:25:00.000Z",
  "customType": "com.example.my-extension.state",
  "data": { "state": 1 }
}
```

当前由核心拥有的值包括：

| `customType`             | `data` schema                                                                                                                                                                                                                                            | Writer and consumer                                                                                                                                                                                                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tool_execution_start`   | `{ toolCallId: string, toolName: string, startedAt: string, args?: { command?: string, path?: string }, intent?: string }`                                                                                                                               | `AgentSession` 在工具实现开始之前立即写入一个标记。退出诊断会将其与 assistant 的 tool call 和 tool result 组合，以重建遗留的待处理 call。参数摘要是截断后的投影；读取时接受旧式的完整参数对象。                                                                                                                |
| `session_exit`           | `{ reason: string, kind: "normal" \| "signal" \| "fatal" \| "process_exit", recordedAt: string, pendingToolCalls?: Array<{ toolCallId?: string, toolName: string, args?: unknown, intent?: string, assistantTimestamp?: number, startedAt?: string }> }` | 当会话具有 assistant 历史或待处理的 tool call 时，正常释放和事后拆解会记录该退出。写入方会立即调用 `flushSync()`，以便后续进程检查最后持久化的轮次；flush 失败会被记录。Resume 诊断会消费最新的有效记录。 |
| `user_todo_edit`         | `{ phases: TodoPhase[] }`                                                                                                                                                                                                                                | SDK/UI todo 编辑会持久化完整的 phase 快照。Todo 恢复会向后扫描以查找最新的快照（或成功的 `todo` 工具结果）并恢复其 phase。                                                                                                                                                              |
| `vibe-session-lifecycle` | 版本为 1 的事件，结构为 `{ version: 1, id, ownerId, parentSessionId, action, ... }`；`spawn` 添加 `cli`、`agent`、`childSessionFile` 和 `createdAt`；turn 事件添加 `turn`；tombstone 事件添加 `reason`。                                               | Vibe 运行时持久化并回放子会话的 spawn、turn-started/settled、tombstone 以及 tombstone-revoked 转换，以恢复所拥有的子会话和进行中的状态。无效或超出范围的事件会被忽略。                                                                                                                                                |
| `autoresearch-control`   | `{ mode: "on" \| "off" \| "clear", goal?: string }`                                                                                                                                                                                                      | 内置的 autoresearch 命令写入 mode/goal 变更，实验限制关闭写入 `mode: "off"`。`reconstructControlState()` 在 resume 时回放有效记录以恢复 autoresearch 是否激活及其 goal；`clear` 会移除 goal。                                                                                                            |

Resume 时，如果非终止的会话尾部之后存在一个有效的最新 `session_exit`，loader 会追加一条带有 `stopReason: "aborted"` 的合成 assistant 消息，并重建显示/agent 上下文。仅当正常退出记录了待处理的 tool call 时，正常退出才会触发该转换；异常退出类型可以在没有该列表的情况下触发该转换。这可以防止恢复后的 transcript 将一个已中断的轮次呈现为仍处于活动状态。

表中的字符串保留给其核心消费者使用。扩展 MUST NOT 使用这些字符串。请使用带命名空间的标识符（例如反向域名或包限定名）作为扩展记录；冲突可能导致核心回放逻辑将扩展数据解释为生命周期状态。未知命名空间的值对核心 session-context 重建保持不透明。

### `custom_message`

由扩展提供的、确实参与 LLM context 的消息。`content` 可以是字符串或 text/image 内容块，`attribution` 记录该消息是由用户还是 agent 发起的。

```json
{
  "type": "custom_message",
  "id": "a2b3c4d5",
  "parentId": "f1a2b3c4",
  "timestamp": "2026-02-16T10:26:00.000Z",
  "customType": "my-extension",
  "content": "Injected context",
  "display": true,
  "details": { "debug": false },
  "attribution": "agent"
}
```

### `label`

```json
{
  "type": "label",
  "id": "b2c3d4e5",
  "parentId": "a2b3c4d5",
  "timestamp": "2026-02-16T10:27:00.000Z",
  "targetId": "a1b2c3d4",
  "label": "checkpoint"
}
```

`label: undefined` 会清除 `targetId` 的标签。

### `title_change`

会话重命名的 append-only 审计 entry。它记录 `title`、`source`（`auto` 或 `user`），以及可选的 `previousTitle` 和 `trigger`。当前标题也会在定宽标题槽中更新，这样 listing 不需要重写整个文件。

### `ttsr_injection`

```json
{
  "type": "ttsr_injection",
  "id": "c2d3e4f5",
  "parentId": "b2c3d4e5",
  "timestamp": "2026-02-16T10:28:00.000Z",
  "injectedRules": ["ruleA", "ruleB"]
}
```

### `credential_pin`

记录 provider 和用于将恢复的 OAuth 流量重新绑定到服务账户并保留账户作用域 prompt-cache 重用的伪匿名 SHA-256 账户/作用域哈希。它不存储原始账户身份；导出的哈希仍然可链接，并非匿名。

### `session_init`

```json
{
  "type": "session_init",
  "id": "d2e3f4a5",
  "parentId": "c2d3e4f5",
  "timestamp": "2026-02-16T10:29:00.000Z",
  "systemPrompt": "...",
  "task": "...",
  "tools": ["read", "edit"],
  "outputSchema": { "type": "object" },
  "outputSchemaMode": "strict",
  "restrictToolNames": true,
  "spawns": "*",
  "readSummarize": false
}
```

### `mode_change`

```json
{
  "type": "mode_change",
  "id": "e2f3a4b5",
  "parentId": "d2e3f4a5",
  "timestamp": "2026-02-16T10:30:00.000Z",
  "mode": "plan",
  "data": { "planFile": "/tmp/plan.md" }
}
```

## Versioning and Migration

当前会话版本：`3`。

### v1 -> v2

当 header `version` 缺失或 `< 2` 时应用：

- 为每个非 header entry 添加 `id` 和 `parentId`。
- 使用文件顺序重建线性的 parent 链。
- 当 compaction 字段 `firstKeptEntryIndex` 存在时，迁移为 `firstKeptEntryId`。
- 设置 header `version = 2`。

### v2 -> v3

当 header `version < 3` 时应用：

- 对于 `message` entry：将旧式的 `message.role === "hookMessage"` 重写为 `"custom"`。
- 设置 header `version = 3`。

### Migration Trigger and Persistence

- 迁移在会话加载期间运行（`setSessionFile`）。
- 如果运行了任何迁移，内存中的表示会被标记为需要完整重写，而不是立即重写。
- 接下来的持久化操作会在增量 append 继续之前执行完整重写。

## Load and Compatibility Behavior

`loadEntriesFromFile(path)` 行为：

- 文件缺失（`ENOENT`） -> 返回 `[]`。
- 至少 8 MiB 的当前文件使用流式 JSONL loader；较小的或非文件存储使用完整文本读取。
- 不可解析的行由宽松的 JSONL 解析器处理。
- 可选的定宽标题槽会被移除并合并到 header。
- 如果第一个逻辑 entry 不是有效的 session header（`type !== "session"` 或缺少字符串 `id`） -> 返回 `[]`。

`SessionManager.setSessionFile()` 行为：

- 来自 loader 的 `[]` 被视为空/不存在的会话，并在该确切路径上替换为新初始化的会话；其 header 会被立即物化。
- 有效文件会被加载，必要时迁移，解析 blob 引用，然后建立索引。

## Tree and Leaf Semantics

底层模型是 append-only 树 + 可变的 leaf 指针：

- 每个 append 方法恰好创建一个新 entry，其 `parentId` 为当前 `leafId`。
- 新 entry 成为新的 `leafId`。
- `branch(entryId)` 仅移动 `leafId`；现有 entry 保持不变。
- `resetLeaf()` 设置 `leafId = null`；下一次 append 会创建一个新的根 entry（`parentId: null`）。
- `branchWithSummary()` 将 leaf 设置为分支目标并追加一个 `branch_summary` entry。

`getEntries()` 按插入顺序返回所有非 header 的 entry。在正常操作中不会删除现有 entry；重写在更新表示（迁移、移动、定向重写辅助函数）的同时保留逻辑历史。

## Context Reconstruction (`buildSessionContext`)

`buildSessionContext(entries, leafId?, byId?, options?)` 解析发送给 model 的内容。`options.transcript: true` 则改为构建显示 transcript。完整 transcript 模式会内联保留 compaction；`collapseCompactedHistory` 仅渲染当前压缩后的尾部，`keepDanglingToolCalls` 在中途 UI 重建期间保留仍在运行的 tool call。

算法：

1. 确定 leaf：
   - `leafId === null` -> 返回空 context。
   - 显式的 `leafId` -> 使用该 entry（如果找到）。
   - 否则回退到最后一个 entry。
2. 沿 `parentId` 向根方向遍历，遇到重复的 id 时停止以限制损坏的循环，然后反转得到 root->leaf。
3. 在整条路径上推导运行时状态：
   - 来自最新 `thinking_level_change` 的已解析和已配置的 thinking 选择器
   - 来自最新 `service_tier_change` 的 service tier
   - 来自 `model_change` entry 的 model map（`role ?? "default"`）；在出现显式 default 之前，assistant 消息推断仅为旧式回退
   - 去重后的 `injectedTtsrRules`
   - 来自最新 `mode_change` 的 mode/modeData（默认 mode 为 `"none"`）
4. 选择发射边界：
   - 之后的 `reset_boundary` 会将该边界之前的所有内容从 model context 和折叠后的实时 transcript 中隐藏
   - 否则最新的 compaction 会发出其 summary 以及保留的/compaction 之后的消息（provider 原生的替换历史可以提供保留的 model context）
   - 完整 transcript 导出会保留 reset 之前的历史，并按时间顺序渲染 compaction
5. 将 `message`、`custom_message` 和 `branch_summary` entry 转换为消息。其他 entry 类型仅影响回放状态或元数据。
6. 从回放中移除悬空的 tool call（除非出于中途 transcript 明确保留），在重写的轮次上中和对受保护的推理元数据的处理；从 model context 中删除不安全的 aborted/error assistant 轮次及其配对的 tool result。

## Persistence Guarantees and Failure Model

### Persist vs in-memory

- `SessionManager.create/open/continueRecent/forkFrom` -> persistent 模式（`persist = true`）。
- `SessionManager.inMemory` -> 非 persistent 模式（`persist = false`），使用 `MemorySessionStorage`。

### Write pipeline

已完成的 entry 会更新内存，并在懒文件创建门控被跨越后，在 append 调用中同步交给文件/内存存储。这里没有 `fsync`，因此保证覆盖软件崩溃，但不覆盖断电。流式的部分文本在已完成消息被追加之前不会被持久化。

- 一个新的普通会话在包含 assistant 消息或调用方调用 `ensureOnDisk()` 之前，仅存在于内存中。
- 在该门控之前，entry 保留在内存中；跨越该门控时会写入完整的标题槽、header 以及累积的 entry。
- 此后，entry 以增量方式 append。
- 保存编辑器草稿会强制写入可发现的 header，并存储带标记的 `draft.txt`；如果草稿消失而仅剩下启动元数据，close 会删除该仅含草稿的会话。显式的 `ensureOnDisk()` 会话保持可恢复状态。
- 并发的已完成 append 会用权威的完整正文重写来取代正在进行的原子重写，以防止过时的发布覆盖它们。

### Durability operations

- `flush()` 排空异步的磁盘/存储队列和打开的 writer（无 `fsync`）；`flushSync()` 在支持时执行同步排空/完整重写。
- 原子完整重写使用存储的 `writeTextAtomic` 并带有提交保护；file storage 会先暂存然后重命名覆盖目标，包括 EPERM 安全的 move-aside 回退。
- 重写服务于重命名、entry 重写、迁移/清理、移动/fork 和恢复。会话标题的变更通常会更新定宽标题槽并追加一个 `title_change` 审计 entry，而不是重写正文。

### Error behavior

- 持久化错误会被锁定，并在后续的 flush/close/write 操作中重新抛出；首次错误会连同会话文件上下文一起被记录一次。
- 失败的原子发布会触发权威修复。如果存储可能已发布写入且无法证明修复是持久的，`SessionPersistenceIndeterminateError` 会以原始错误和恢复错误失败关闭。
- Writer 关闭时会传播第一个有意义的错误。

## Data Size Controls and Blob Externalization

在持久化 entry 之前：

- 超过 500,000 字符的字符串会被截断为 `"[Session persistence truncated large content]"`，但已签名/加密的 provider 块、签名字段以及完整的 Anthropic 原生 web-search 历史块除外——为了回放它们必须保持字节精确。
- 临时的 `jsonlEvents` 会被移除。
- 如果一个对象同时具有字符串 `content` 和数值 `lineCount`，则会在截断后重新计算行数。
- `image_url` 字段中的 image data URL 始终通过内容寻址存入 blob 存储，并替换为 `blob:sha256:<hash>`，无论长度如何。其他 base64 image payload 在 1,024 个字符时进行外置化：image content/data payload 和 image-generation 结果。
- 当权威的 reasoning 项已存在于 `providerPayload` 中时，省略多余的 OpenAI Responses `thinkingSignature` 副本。

加载时，已持久化的 blob 引用会被解析回下游传输所期望的内联 payload 形式。

## Storage Abstractions

`SessionStorage` 拥有 `SessionManager` 所使用的类文件系统操作：同步的目录/存在性/写入/stat/list 操作；异步的 read、sliced read、write、带保护的原子 write、rename、unlink、artifact-aware deletion、title update、writer 创建以及后端排空。

实现与适配器：

- `FileSessionStorage`：真实的本地文件
- `MemorySessionStorage`：基于 map/chunk 的内存存储，用于非 persistent 会话和测试
- `IndexedSessionStorage`：共享的本地索引加上有序的远端发布，用于 Redis/SQL 后端的存储

`SessionStorageWriter` 暴露 `append`、可选的 `appendSync`、`flush`、可选的 `flushSync`、`isOpen`、`close` 和 `getError`。

## Session Discovery Utilities

发现辅助函数位于 `session-listing.ts`；`SessionManager` 暴露项目作用域的包装器：

- `getRecentSessions(sessionDir, limit?)` -> 轻量级的欢迎元数据，默认 limit 为 4
- `findMostRecentSession(sessionDir)` -> 按 mtime 最新的会话
- `listSessions(sessionDir, storage)` / `SessionManager.list(...)` -> 带生命周期状态的项目作用域
- `listSessionsReadOnly(...)` -> 相同的元数据，但不进行备份恢复
- `listAllSessions(storage)` / `SessionManager.listAll()` -> 所有项目作用域
- `resolveResumableSession(...)` -> 本地查找然后可选的全局回退

Recent/most-recent 扫描仅读取 4 KiB 的前缀。完整列表会读取该前缀以及一个上限为 32 KiB 的尾部以获取生命周期状态。扫描是 stat-keyed 并被缓存；大型集合使用有上限的并行 worker 处理。普通的按目录扫描还会在主 JSONL 缺失时恢复最新的孤立 EPERM 备份。Resume 匹配是大小写不敏感的，接受 session id 前缀、完整文件名前缀，或时间戳之后的 id 后缀。

## Related but Distinct: Prompt History Storage

`HistoryStorage`（`history-storage.ts`）是一个独立的 SQLite 子系统，用于 prompt 回忆/搜索，而非会话回放。

- 数据库：`~/.omp/agent/history.db`
- 表：`history(id, prompt, created_at, cwd, session_id)`
- FTS5 索引：`history_fts`，由 trigger 维护同步
- 使用内存中的 last-prompt 缓存对连续相同的 prompt 进行去重
- 插入通过异步排空队列（~100 ms 延迟）批处理，因此 prompt 捕获不会阻塞轮次执行

Use session files for conversation graph/state replay; use `HistoryStorage` for prompt history UX.
