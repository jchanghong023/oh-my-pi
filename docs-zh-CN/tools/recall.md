# recall

> 搜索当前活跃的长期记忆后端，并返回匹配的记忆。

## 源码
- 入口：`packages/coding-agent/src/tools/memory-recall.ts`
- 模型侧提示词：`packages/coding-agent/src/prompts/tools/recall.md`
- Hindsight 协作者：
  - `packages/coding-agent/src/hindsight/state.ts` — 会话状态、recall 查询默认值、提示词侧的自动 recall。
  - `packages/coding-agent/src/hindsight/content.ts` — 结果格式化与 UTC 时间戳格式化。
  - `packages/coding-agent/src/hindsight/client.ts` — HTTP `recall` 调用与错误映射。
  - `packages/coding-agent/src/hindsight/bank.ts` — 银行 id 与标签过滤作用域。
- Mnemopi 协作者：
  - `packages/coding-agent/src/mnemopi/state.ts` — 限定作用域的本地 recall 与带 id 的结果格式化。
  - `packages/coding-agent/src/mnemopi/config.ts` — 本地银行作用域与 recall 限制。
  - `docs/tools/retain.md` — 共享的后端、存储、作用域与保留行为。

## 注册 / 可见性
- 工具元数据：`approval = "read"`，`strict = true`，`loadMode = "discoverable"`。
- 工具仅在 `memory.backend = "hindsight"` 或 `"mnemopi"` 时注册；在 `"off"` 和 `"local"` 时不存在。
- 在具有显式工具列表的非受限会话中，注册会自动为任一受支持的后端包含共享的 `recall`/`retain`/`reflect` 集合。受限列表不会被扩展。
- 在普通的 `tools.xdev` 会话中，可发现的内置工具可以以 `xd://recall` 形式呈现；显式请求的工具仍位于顶层。
- 执行是单次的。该工具不会发出流式的参数/结果更新。

## 输入

| 字段 | 类型 | 必填 | 描述 |
|---|---|---:|---|
| `query` | `string` | 是 | 自然语言搜索查询。该工具会原样透传，除非 Mnemopi 的 `per-project-tagged` 可能执行一次内部共享银行回退查询。 |

## 输出
返回单次工具结果。

当存在匹配项时：
- `content[0].type = "text"`
- `content[0].text = "Found <n> relevant memory/memories (as of YYYY-MM-DD HH:MM UTC):\n\n<bullet list>"`
- `details = {}`

Hindsight 条目格式来自 `formatMemories(...)`：
- 每条形如 `- <text> [<type>] (<mentioned_at>)`；类型与时间戳后缀仅在相应字段存在时出现。

Mnemopi 条目格式来自 `formatScopedRecallWithIds(...)`：
- 每条形如 `- <content> (id: <id>) [<source>] (<YYYY-MM-DD>) c:<score>`；当 id 不可用时显示为 `(id unavailable)`，而 source、date 与 score 在缺失时省略。
- Mnemopi 的 recall 内容是默认上限为 500 字符的预览。被截断的预览以 `…` 结尾；在进行完整的 `memory_edit update` 之前，请使用 `read memory://<id>` 获取完整行。
- 尽管内部的 recall 行包含 `truncated` 和 `full_length`，本工具返回的是格式化文本，且 `details = {}`，并不暴露这些字段。

当不存在匹配项时：
- `content[0].text = "No relevant memories found."`
- `details = {}`
- `useless = true`，允许调用方/渲染器将该结果视为无贡献的上下文。

## 流程
1. `MemoryRecallTool.createIf(...)` 在 `memory.backend` 为 `"hindsight"` 或 `"mnemopi"` 时暴露该工具。
2. `execute(...)` 将操作包裹在 `untilAborted(...)` 中。
3. 如果后端是 `mnemopi`：
   - 读取 `session.getMnemopiSessionState()`，若后端未启动则抛出错误；
   - 调用 `state.recallResultsScoped(params.query)`；
   - 限定作用域的 recall 会用 `recallEnhanced(query, recallLimit, { includeFacts: true, channelId: bank })` 查询每个已解析的 recall 银行，按 id/content 合并/去重结果，排序后截断到 `recallLimit`；
   - per-project 模式可能包含安全的旧版银行，其工作记忆行全部属于当前绝对的 cwd；启动时扫描上限为 64 个候选银行目录；
   - 在 `per-project-tagged` 中，共享银行可能会收到一次额外的回退查询，其中剥离了项目银行字面量 token，使更广泛的全局记忆仍能匹配；
   - 结果使用 id 进行格式化，以便后续进行整行读取和 `memory_edit`。
4. 如果后端是 `hindsight`：
   - 读取 `session.getHindsightSessionState()`，若后端未启动则抛出错误；
   - 使用 `bankId`、查询、配置的 `budget`、`maxTokens`、`types` 和银行作用域标签过滤器调用 `state.client.recall(...)`；
   - `HindsightApi.recall(...)` 会 POST `/v1/default/banks/{bank_id}/memories/recall`；
   - 结果通过 `formatMemories(...)` 格式化为纯文本列表。
5. 后端失败会通过 `logger.warn("recall failed", ...)` 记录，并在需要时重新抛出为 `Error` 实例。

## 模式 / 变体
- 工具路径：仅基于显式查询的 recall。它不会从最近的对话轮次中组合上下文。
- 后端自动 recall 在 `HindsightSessionState.beforeAgentStartPrompt(...)` / `maybeRecallOnAgentStart(...)` 和 `MnemopiSessionState.beforeAgentStartPrompt(...)` / `maybeRecallOnAgentStart(...)` 中拥有更丰富的查询组合路径。
- Hindsight 银行作用域：
  - `global` — 无标签过滤。
  - `per-project` — 每个项目标签一个独立的银行 id（git 主检出根目录的 basename；在仓库外使用 cwd 的 basename）。
  - `per-project-tagged` — 共享银行 id 加上 `project:<project label>` 过滤器，`tagsMatch = "any"`，因此带项目标签和未带标签的全局记忆都可以出现。
- Mnemopi 银行作用域：
  - `global` — recall 读取共享银行。
  - `per-project` — recall 读取从绝对 cwd 的 basename 加上该绝对 cwd 的哈希派生的银行。
  - `per-project-tagged` — recall 读取从 cwd 派生的项目银行与共享银行，然后合并结果。
  - per-project 模式还可以读取经安全识别的旧版仅 cwd 银行，以恢复在早期基于 git 根目录派生的方案下创建的记忆。
- 会话作用域：读取跨会话的内存数据，使用当前会话的缓存配置和作用域。子代理别名使用父级后端的作用域。

## 副作用
- 网络
  - Hindsight：`POST /v1/default/banks/{bank_id}/memories/recall`。
  - Mnemopi：无，除非配置的本地运行时提供者在 recall 期间执行 embedding/LLM 工作。
- 会话状态
  - 在显式工具路径成功时无副作用。与后端自动 recall 不同，本工具不会更新 `lastRecallSnippet`，也不会刷新系统提示词。
- 后台工作 / 取消
  - 如果工具调用信号被取消，则通过 `untilAborted(...)` 中止。

## 限制与上限
- 工具可用性要求 `memory.backend` 为 `"hindsight"` 或 `"mnemopi"`；默认 `memory.backend` 是 `"off"`。
- 原始 `HindsightApi.recall(...)` 的 Hindsight 客户端默认 budget 为 `"mid"`；本工具会根据配置覆盖。
- Hindsight recall 设置：
  - `hindsight.recallBudget = "mid"`
  - `hindsight.recallMaxTokens = 1024`
  - `hindsight.recallTypes = ["world", "experience"]`
  - `hindsight.recallTimeoutMs = 30_000`
- Mnemopi recall 设置：
  - `mnemopi.recallLimit = 8`（运行时被限制为至少 1）
  - `mnemopi.scoping = "per-project"`
  - 每个结果的内容预览上限为 500 字符
- 显式工具路径不应用 `hindsight.recallContextTurns`、`hindsight.recallMaxQueryChars`、`mnemopi.recallContextTurns` 或 `mnemopi.recallMaxQueryChars`；这些上限仅影响后端自动 recall 的查询组合。

## 错误
- 当 `memory.backend == "mnemopi"` 但不存在状态时，抛出 `Mnemopi backend is not initialised for this session.`。
- 当 `memory.backend == "hindsight"` 但不存在状态时，抛出 `Hindsight backend is not initialised for this session.`。
- Hindsight 的 HTTP、fetch 与超时失败会变成 `HindsightError`；HTTP 错误在可用时包含 `statusCode` 和已解析的 `details`。
- Mnemopi recall 按目标捕获失败并记录。健康的目标仍会贡献结果；如果每个尝试的目标都失败，则抛出原始错误（单个目标时）或带有银行详细信息的 `AggregateError`（多个目标时），而不是转换为空结果。
- 工具捕获到的非 `Error` 失败会在重新抛出前规范化为 `new Error(String(err))`。

## 备注
- 共享后端详情见 `docs/tools/retain.md`：存储、子代理别名、银行作用域、任务设置与心智模型行为。
- Hindsight 心智模型不由本工具获取。它们可能已经出现在代理的开发者指令中，因为后端会单独缓存一个 `<mental_models>` 块，与 recall 结果分开。
- Mnemopi 开发者指令可能包含来自自动 recall 的 `<memories>` 块；本显式工具不会更新该块。
- 该工具返回记忆命中；它不会在它们之间进行综合。远程 Hindsight 综合请使用 `reflect`；Mnemopi 的 `reflect` 变体是本地 recall 加上格式化。
