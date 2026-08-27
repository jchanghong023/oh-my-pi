# retain

> 通过当前激活的长期记忆后端存储持久化事实。

## Source
- 入口: `packages/coding-agent/src/tools/memory-retain.ts`
- 面向模型的提示词: `packages/coding-agent/src/prompts/tools/retain.md`
- Hindsight 协作者:
  - `packages/coding-agent/src/hindsight/state.ts` — 每个会话的队列、刷新、自动 retain。
  - `packages/coding-agent/src/hindsight/backend.ts` — 会话启动、提示词注入、子代理别名。
  - `packages/coding-agent/src/hindsight/bank.ts` — 银行 ID 派生、标签作用域、首次使用的银行/任务设置。
  - `packages/coding-agent/src/hindsight/client.ts` — HTTP `retain` / `retainBatch` 调用。
  - `packages/coding-agent/src/hindsight/content.ts` — 保留转录整形、记忆标签剥离。
  - `packages/coding-agent/src/hindsight/mental-models.ts` — 银行作用域的心智模型种子与缓存渲染。
  - `packages/coding-agent/src/hindsight/seeds.json` — 内置心智模型种子定义。
  - `packages/coding-agent/src/hindsight/transcript.ts` — 为自动 retain 提取用户/助手轮次。
- Mnemopi 协作者:
  - `packages/coding-agent/src/mnemopi/backend.ts` — 本地后端启动、提示词注入、子代理别名、入队/清空。
  - `packages/coding-agent/src/mnemopi/state.ts` — 作用域内的 recall/retain 状态与本地写入。
  - `packages/coding-agent/src/mnemopi/config.ts` — 本地 SQLite 路径、银行、作用域、Provider 设置。
  - `packages/mnemopi/src/core/memory.ts` — `remember(...)` 使用的本地记忆运行时。

## Registration / Visibility
- 工具元数据: `approval = "read"`, `strict = true`, `loadMode = "discoverable"`, 尽管成功的调用会入队或执行记忆写入。
- 该工具仅当 `memory.backend = "hindsight"` 或 `"mnemopi"` 时注册;在 `"off"` 和 `"local"` 时不存在。
- 在具有显式工具列表的无限制会话中,注册会自动包含受支持后端对应的共享 `recall`/`retain`/`reflect` 集合。受限列表不会被扩宽。
- 在普通的 `tools.xdev` 会话中,可发现的内置项可以以 `xd://retain` 的形式呈现;显式请求的工具保持顶层。
- 执行返回一次最终结果,没有进度回调或取消参数。

## Inputs

| Field | Type | Required | Description |
|---|---|---:|---|
| `items` | `Array<{ content: string; context?: string }>` | Yes | 一条或多条要存储的记忆。`minItems: 1`。每条记录必须自包含;`context` 是可选的逐条来源信息。 |

## Outputs
输出取决于当前激活的 `memory.backend`。

Hindsight:
- `content[0].type = "text"`
- `content[0].text = "<count> memory queued."` 或 `"<count> memories queued."`
- `details = { count: number }`
- 写入在工具返回前不会确认。队列稍后刷新;刷新失败会发出会话警告通知,且不会返回给模型。

Mnemopi:
- `content[0].type = "text"`
- `content[0].text = "<count> memory stored."` 或 `"<count> memories stored."`
- `details = { count: number }`
- 工具同步调用本地写入,但 `rememberScoped(...)` 会捕获每次写入失败并返回 `undefined`;`retain` 忽略该返回值,仍然报告请求的计数。因此该响应不是逐条持久化收据。

## Flow
1. `MemoryRetainTool.createIf(...)` 在 `memory.backend` 为 `"hindsight"` 或 `"mnemopi"` 时暴露该工具。
2. `execute(...)` 重新读取 `memory.backend` 并分派到匹配的会话状态。
3. 如果后端是 `mnemopi`:
   - 获取 `session.getMnemopiSessionState()`,如果后端未启动则抛出;
   - 对每条记录,使用 `source: "coding-agent-retain"`、`importance: 0.75`、`scope: "bank"`、`extract: true`、`extractEntities: true`、`veracity: "tool"`、`memoryType: "fact"`,以及元数据 `{ session_id, cwd, context, tool: "retain" }` 调用 `state.rememberScoped(item.content, ...)`;
   - 写入进入作用域内的 retain 银行;同一会话中完全重复的内容会更新 Mnemopi 核心中现有的工作记忆行。
4. 如果后端是 `hindsight`:
   - 获取 `session.getHindsightSessionState()`,如果后端未启动则抛出;
   - 每条输入记录交给 `HindsightSessionState.enqueueRetain(...)`;
   - `HindsightRetainQueue.enqueue(...)` 追加记录,并在队列达到 `RETAIN_FLUSH_BATCH_SIZE` 时立即刷新,或为 `RETAIN_FLUSH_INTERVAL_MS` 启动去抖动计时器;
   - 刷新时,`HindsightRetainQueue.#doFlush(...)` 校验所有权,通过 `ensureBankExists(...)` 尽力确保银行存在,将记录映射为 `MemoryItemInput`(使用 `context ?? config.retainContext`、`metadata.session_id` 以及银行作用域标签),然后发送一次异步 `retainBatch(...)` 请求。

## Modes / Variants
- Hindsight 工具路径:仅限排队的批量写入。
- Mnemopi 工具路径:直接本地 `remember(...)` 进入作用域内的 retain 银行。
- 来自 `computeBankScope(...)` 的 Hindsight 银行作用域:
  - `global` — 一个共享银行,无项目标签。
  - `per-project` — 银行 ID 追加 `-<project label>`,其中标签是 git 主检出根目录的 basename(不在仓库内时为 cwd 的 basename)。
  - `per-project-tagged` — 共享银行加上保留记忆上的 `project:<project label>` 标签。
- 来自 `computeMnemopiBankScope(...)` 的 Mnemopi 银行作用域:
  - `global` — retain 和 recall 使用共享银行。
  - `per-project` — retain 和 recall 使用由绝对 cwd basename 加上该绝对 cwd 的哈希派生的项目银行。
  - `per-project-tagged` — retain 写入由 cwd 派生的项目银行;recall 同时读取共享银行。
  - Per-project recall 可能添加安全的旧版银行,其存储的工作记忆行均匹配当前 cwd;扫描最多 64 个候选银行目录。
- 会话作用域:
  - 工具调用的 retain 属于当前后端的每个会话工作;
  - 持久化的 Hindsight 记忆是跨会话的服务端银行数据;
  - 持久化的 Mnemopi 记忆是本地 SQLite 数据;
  - 两个受支持后端的子代理都会别名父记忆状态。

## Side Effects
- Filesystem
  - Hindsight:保留记忆无任何操作。不写入本地记忆文件。
  - Mnemopi:写入 `mnemopi.dbPath` 下的本地 SQLite,默认为代理记忆目录下的 `mnemopi/mnemopi.db`,必要时每个作用域银行为一个数据库文件。
- Network
  - Hindsight:通过 `retainBatch(...)` 调用 `POST /v1/default/banks/{bank_id}/memories`,以及在每个会话状态下每个银行首次写入之前,通过 `ensureBankExists(...)` 可选调用 `PUT /v1/default/banks/{bank_id}`(该集合使用主会话状态创建并与子代理别名共享)。
  - Mnemopi:无,除非配置的嵌入或 LLM Provider 在提取期间发起调用。
- Session state
  - Hindsight:追加到内存中的 `HindsightRetainQueue`,包含 `metadata.session_id`,并与子代理共享父状态。
  - Mnemopi:通过会话作用域的 `Mnemopi` 实例写入,包含 `session_id`、`cwd` 和可选的 `context`,并与子代理共享作用域资源。
- User-visible prompts / interactive UI
  - Hindsight 异步刷新失败会发出 `session.emitNotice("warning", ...)`;模型不会被告知。
  - Mnemopi 写入失败由 `rememberInScope(...)` 记录;工具响应不暴露逐条失败。
- Background work / cancellation
  - Hindsight 刷新稍后在去抖动计时器或队列大小阈值上运行;后端 `enqueue(...)` 和 `clear(...)` 显式排空队列。刷新时的会话所有权不匹配会记录并丢弃该批次。
  - Mnemopi 事实/实体提取和嵌入可能在同步行写入之后继续。后端 `enqueue(...)` 请求完整整合;后端 clear 在删除其数据库文件之前释放作用域实例。
  - `retain.execute()` 本身没有中止信号处理。

## Limits & Caps
- 输入模式要求 `items.length >= 1`;记录字符串在模式层面没有最小长度。
- 工具可用性要求 `memory.backend` 为 `"hindsight"` 或 `"mnemopi"`;默认 `memory.backend` 为 `"off"`。
- Hindsight 队列刷新阈值: `RETAIN_FLUSH_BATCH_SIZE = 16`。
- Hindsight 队列去抖动: `RETAIN_FLUSH_INTERVAL_MS = 5_000`。
- Hindsight 队列写入使用 `retainBatch(..., { async: true })`;客户端请求超时默认为 `hindsight.retainTimeoutMs = 60_000`,但不会等待服务端整合。
- Hindsight 自动 retain 设置:
  - `hindsight.autoRetain = true`
  - `hindsight.retainEveryNTurns = 3`
  - `hindsight.retainOverlapTurns = 2`
  - `hindsight.retainContext = "omp"`
  - `hindsight.retainMode = "full-session"`
- Mnemopi retain 设置:
  - `mnemopi.autoRetain = true`
  - `mnemopi.retainEveryNTurns = 4`
  - `mnemopi.scoping = "per-project"`

## Errors
- 当 `memory.backend == "mnemopi"` 但没有状态时,抛出 `Mnemopi backend is not initialised for this session.`。
- 当 `memory.backend == "hindsight"` 但没有状态时,抛出 `Hindsight backend is not initialised for this session.`。
- 在已释放状态上的 Hindsight 队列入队会抛出 `Hindsight retain queue is closed.`。
- Hindsight 刷新时的 API 失败会被捕获、记录,并转换为警告通知而非工具错误。
- Hindsight 银行/任务创建失败在 `ensureBankExists(...)` 中以 debug 级别记录并被吞掉;后续写入仍然执行。
- Mnemopi `remember(...)` 失败在 `MnemopiSessionState.rememberInScope(...)` 中被捕获、记录,不会重新抛出给工具调用者。

## Notes
- Hindsight 存储位于服务端。`hindsightBackend.clear(...)` 排空本地队列,清除本地缓存/状态,并警告上游删除必须在 Hindsight UI 或 `deleteBank` 中进行。
- Mnemopi 存储是本地 SQLite。`mnemopiBackend.clear(...)` 删除每个活动作用域银行的数据库文件,然后在会话保持活动时重新水合后端。
- Hindsight 自动 retain 使用相同的银行但路径与此工具不同: `retainSession(...)` 提取纯净的用户/助手转录,剥离 `<memories>` / `<mental_models>` 块,并调用单条 `retain(...)`。
- Mnemopi 自动 retain 使用 `source: "coding-agent-transcript"`、`importance: 0.65`、`veracity: "unknown"` 和 `memoryType: "episode"` 存储准备好的转录。
- Hindsight 心智模型引导位于共享后端中: `HindsightSessionState.runMentalModelLoad(...)` 可选地解析种子、创建缺失的模型,然后缓存渲染的 `<mental_models>` 块以供提示词注入。
- 内置的 Hindsight 种子为 `user-preferences`、`project-conventions` 和 `project-decisions`。`projectTagged: true` 的种子继承当前作用域的 retain 标签;未标记的种子读取整个银行。
- Hindsight 心智模型默认值: `hindsight.mentalModelsEnabled = true`、`hindsight.mentalModelAutoSeed = true`、`hindsight.mentalModelRefreshIntervalMs = 5 * 60 * 1000`、`hindsight.mentalModelMaxRenderChars = 16_000`。首轮加载等待最多 `MENTAL_MODEL_FIRST_TURN_DEADLINE_MS = 1500`。
- Hindsight 种子生命周期为仅创建。更改 `packages/coding-agent/src/hindsight/seeds.json` 不会变更现有的服务端模型。
- `recall.md` 和 `reflect.md` 依赖相同的后端选择和作用域行为。
