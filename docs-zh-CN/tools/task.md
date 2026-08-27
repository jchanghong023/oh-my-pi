# task

> 生成子代理 — 每次调用生成一个,或每次调用生成一个 `tasks[]` 批次(`task.batch`,默认开启)。当 `async.enabled=true` 时,普通的生成在后台运行;否则调用会阻塞直到它们完成。执行模式按项划分:如果某个项的自定义代理类型声明了 `blocking: true`,则该项以内联方式运行,而同一调用中的非阻塞项仍以后台作业形式生成。目前没有捆绑的代理声明 `blocking: true`。

## Source
- 入口: `packages/coding-agent/src/task/index.ts`
- 面向模型的提示: `packages/coding-agent/src/prompts/tools/task.md`
- 关键协作模块:
  - `packages/coding-agent/src/task/types.ts` — 动态 schema、进度/结果类型、输出上限。
  - `packages/coding-agent/src/task/discovery.ts` — 发现项目/用户/插件/捆绑代理。
  - `packages/coding-agent/src/task/agents.ts` — 捆绑代理定义和 frontmatter 解析。
  - `packages/coding-agent/src/task/executor.ts` — 创建子会话,运行子代理,收集输出,将已完成的会话交给生命周期管理器。
  - `packages/coding-agent/src/registry/agent-lifecycle.ts` — 已完成子代理的空闲 TTL 暂挂和唤醒。
  - `packages/coding-agent/src/registry/agent-registry.ts` — 进程全局代理目录(`running | idle | parked | aborted`)。
  - `packages/coding-agent/src/async/job-manager.ts` — 后台作业的注册、进度和结果投递。
  - `packages/coding-agent/src/task/parallel.ts` — 用于会话范围并发边界的 `Semaphore`。
  - `@oh-my-pi/pi-natives` (`crates/pi-iso`) — 隔离 PAL:`isoResolve` / `isoStart` / `isoStop` 后端解析和回退。
  - `packages/coding-agent/src/task/worktree.ts` — 隔离模式映射(`parseIsolationMode`)和生命周期(`ensureIsolation`/`cleanupIsolation`),补丁捕获,分支合并。
  - `packages/coding-agent/src/task/output-manager.ts` — 会话范围的 `agent://` id 分配。
  - `packages/coding-agent/src/task/name-generator.ts` — 默认的 AdjectiveNoun 代理 id。
  - `packages/coding-agent/src/internal-urls/agent-protocol.ts` — 将 `agent://<id>` 解析为已保存的子代理输出。
  - `packages/coding-agent/src/internal-urls/history-protocol.ts` — 将 `history://<id>` 解析为简洁的转录。
  - `packages/coding-agent/src/tools/index.ts` — 工具注册和递归深度门控。
  - `packages/coding-agent/src/sdk.ts` — 子会话路由器/工具布线以及每个子代理的 `AgentOutputManager`。
  - `docs/task-agent-discovery.md` — 更深入的发现和优先级说明。

## Inputs

线协议 schema 由 `task.batch` (默认开启) 切换形状。一个工作单元是任务项 `{ name?, agent?, task, effort?, outputSchema?, schemaMode?, isolated? }`。`isolated` 仅在 `task.isolation.mode` 不为 `none` **且计划模式已禁用**时存在;`effort` 仅在 `task.enableEffort=true`(默认关闭)时存在。

- **批次形状** (`task.batch` 开启): `{ context, tasks: item[] }` — 每个项一个子代理,所有项都在相同的扇出规则下运行;没有顶层 agent 字段。`context` 是**必需的**共享背景,会渲染到每个生成的子代理的系统提示中(`CONTEXT` 部分);`agent`、`outputSchema` 和 `schemaMode` 按项设置。仅当其设置启用时才添加 `effort`;`isolated` 还要求计划模式已禁用。
- **扁平形状** (`task.batch` 关闭): `{ ...item }` — 每次调用恰好生成一个。共享背景放入一个 `local://` 文件(例如 `local://ctx.md`),每个生成的 `task` 引用该文件;子代理共享父级的 `local://` 根。

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `context` | `string` | 是(批次) | 通过子代理系统提示前置到每次调用的共享背景。当 `task.batch` 关闭时被拒绝。 |
| `tasks` | `array` | 是(批次) | 每个子代理对应一个任务项。提供的名称在调用内必须唯一(不区分大小写)。当 `task.batch` 关闭时被拒绝。 |
| `name` | `string` | 否 | 稳定的代理名称 — 成为注册表/IRC id。默认为生成的 AdjectiveNoun 名称。由 `AgentOutputManager` 按会话唯一化。在批次形状中为项字段,在扁平形状中为顶层字段。 |
| `agent` | `string` | 否 | 运行此项的代理类型(例如 `scout`)。默认为生成策略的默认代理(通常为 `task`);同一批次调用中的项可以使用不同的代理类型。在批次形状中为项字段,在扁平形状中为顶层字段。 |
| `task` | `string` | 是 | 工作内容 — 完整、自包含的指令。修剪后为空则被拒绝。在批次形状中为项字段,在扁平形状中为顶层字段。 |
| `effort` | `"lo" \| "med" \| "hi"` | 否 | 仅当 `task.enableEffort=true` 时存在。每次生成的思考力度,映射到已解析模型支持的范围(它能覆盖的最低/中间/最高级别,例如 `high`/`xhigh`/`max`)。覆盖代理的默认选择器,包括 `auto`;省略它则保留代理已配置的选择器 — 仅对配置为 `auto` 的代理(例如捆绑的 `task`)进行每提示自动分类;`scout`/`sonic` 配置为 `medium`。在批次形状中为项字段,在扁平形状中为顶层字段。 |
| `outputSchema` | JSON Schema (在线协议粗校验层为 `object \| boolean \| string \| null`) | 否 | 调用特定的结构化输出契约。优先于代理 frontmatter `output` 和继承的父会话 schema。在批次形状中为项字段,在扁平形状中为顶层字段。 |
| `schemaMode` | `"permissive" \| "strict"` | 否 | 有效输出 schema 的验证模式。覆盖父会话模式;默认为 `permissive`。在批次形状中为项字段,在扁平形状中为顶层字段。 |
| `isolated` | `boolean` | 否 | 在隔离的工作区中运行并返回补丁。仅当 `task.isolation.mode` 不为 `none` 且计划模式已禁用时存在;在批次形状中按项设置,在扁平形状中为顶层字段。隔离的代理在完成时被销毁 — 不可唤醒。 |

没有线协议标签字段:TUI/注册表中显示的单行 UI 标签是由 tiny/title 模型从 `task` 文本自动生成的(fire-and-forget),因此调用者从不提供它。

运行时保持宽松:即使在 `task.batch` 开启时也接受扁平形式(内部调用者如 commit 流程的 `analyze_files`,以及过时的转录)。模型只看到一种形状。

没有遗留的每次调用 `schema` 参数。使用 `outputSchema` 和可选的 `schemaMode`;当缺失时,结构化输出回退到代理定义的 `output` frontmatter,然后是继承的父会话 schema。

## Outputs

工具返回一个文本块加上 `details: TaskToolDetails`。

后台响应 (`async.enabled=true`):
- `content`: `` Spawned agent `<id>` (job `<jobId>`). The result will be delivered when it yields. ... `` 以及一个协调提示(启用消息传递时为 `hub` 私信,否则为 `hub` 作业控制)。批次调用改为返回 `` Spawned N background agents using <agent types>. ... ``(去重后的每项代理类型,以逗号连接),并附带逐代理的 `- `<id>` (job `<jobId>`)` 列表。
- `details`: `{ projectAgentsDir, results, totalDurationMs, progress: [<AgentProgress per spawn>], async: { state, jobId, type: "task" } }`。该调用维护一个共享的 `progress[]` 快照;`async.jobId` 是首个启动的作业,`async.state` 对所有异步生成进行聚合(在所有作业完成前为 "running",如果任何生成失败则为 "failed")— 在调用返回前已完成的作业已经反映。混合调用的 `results` 携带阻塞生成的内联 `SingleResult`(纯后台调用返回 `results: []`)。
- 实时进度通过 `onUpdate(...)` 持续流式传输到同一工具块;每个最终结果稍后作为 async-result 注入到父对话。投递文本追加后续提示:`` <id> is now idle — message it via `hub` to follow up; transcript at history://<id> ``(中止变体仅指向转录)。

已结算响应 (`async.enabled=false`,无作业管理器,每个项的代理 `blocking: true`,或异步作业主体):
- `content`: 由 `packages/coding-agent/src/prompts/tools/task-summary.md` 渲染的摘要,预览上限为 5000 字符;`agent://<id>` 保存完整输出。同步批次连接每个生成的摘要。
- `details.results`: 每个生成对应一个 `SingleResult`;`usage`、`outputPaths` 已填充(对同步批次跨生成聚合)。

`SingleResult` 包含:
- 标识: `index`, `id`, `agent`, `agentSource`, `task`, `description`, 可选 `assignment`(内部负载名称;线协议字段为 `name`/`agent`/`task`)
- 状态: `exitCode`, 可选 `error`, 可选 `aborted`, 可选 `abortReason`, 可选 `retryFailure`
- 输出: `output`, `stderr`, `truncated`, `durationMs`, `tokens`, `requests`, 可选 `contextTokens`/`contextWindow`, `usage`
- 模型: 可选 `modelOverride`, `resolvedModel`, `resolvedModelIsFallback`
- 结构化结果: 可选 `structuredOutput`,包含 schema 源/模式、验证状态、已解析的 `data` 和验证 `error`
- 工件元数据: `outputPath?`, `patchPath?`, `branchName?`, `branchBaseSha?`, `nestedPatches?`, `outputMeta?`
- 提取的工具数据: `extractedToolData?` 来自已注册的子进程工具处理程序,如 `yield`

工件和旁路:
- 每个具有工件目录的子代理写入 `<id>.md`;`agent://<id>` 解析为该文件。
- 子代理自身的子代理使用点限定(`<id>.<child>`);`agent://<id>/<child>` 读取该嵌套输出。当路径未指定嵌套输出且文件为 JSON 时,`agent://<id>/<path>` 和 `agent://<id>?q=<query>` 执行 JSON 提取。
- 当父代理持久化工件时,每个子代理获得 `<id>.jsonl` 会话历史;`history://<id>` 将其渲染为简洁的转录(对实时和已暂挂代理都有效)。
- 隔离补丁模式在合并前写入 `<id>.patch`。

## Flow
1. `TaskTool.create(...)` 通过进程级 memo (`discoverAgentsForCreate`) 按 cwd 一次性发现代理,以渲染动态提示描述。
2. `execute(...)` 修复原始参数 (`repairTaskParams`),然后进行验证:始终拒绝 `schema`;除非 `task.batch` 开启,否则拒绝 `tasks`/`context`;批次调用需要非空 `tasks`(每项一个 `task`,提供的名称唯一)、非空共享 `context`,且 `tasks` 旁边不能有顶层 `task`;扁平调用需要 `task`。然后将调用规范化到其生成列表 (`resolveSpawnItems`)。
3. 按项执行拆分:代理类型声明 `blocking: true` 的项以内联方式运行;其余成为后台作业。当 `async.enabled=false`、会话没有 `AsyncJobManager`(孤立宿主)或每个项都是阻塞时,整个调用同步运行;内联生成在会话范围信号量下通过 `#executeSync(...)` 运行。
4. 后台执行(任何具有 `async.enabled=true` 和 `AsyncJobManager` 的非阻塞项):
   - 代理 id 通过 `AgentOutputManager.allocate(...)` 预先分配 — 每项的 `name`,或生成的 AdjectiveNoun 名称 — 每个生成一个;
   - 每个生成一个 `type: "task"` 作业在 `session.asyncJobManager` 中注册(`id` = 代理 id,`queued: true`,`ownerId` = 调用者代理 id),工具立即返回;
   - 每个作业主体获取会话范围的 `Semaphore`(每个 `TaskTool` 实例一个,在每次获取和释放前根据实时 `task.maxConcurrency` 设置就地调整大小),将作业标记为正在运行,使用该生成的参数运行 `#executeSync(...)`,并通过共享的 `buildAsyncDetails`/`onUpdate` 报告进度;
   - 失败或中止的运行抛出 `TaskJobError`,以便作业状态为 `failed`,但代理本身保持注册并可被询问。
   - 混合调用先注册异步作业,然后以内联方式运行其阻塞项,一旦它们完成就返回 — 文本结合了内联摘要和已生成作业的列表,块继续在内联结果旁呈现仍在运行的后台行。
5. `#executeSync(...)` 运行生成路径 (`#runSpawn`),该路径从磁盘重新发现代理,因此运行时解析可能与创建时描述不同。
6. 它解析每个生成请求的 `agent` 类型,拒绝未知或设置禁用的代理,并强制父生成策略以及 `PI_BLOCKED_AGENT` 自我递归防护。
7. 模型优先级: `task.agentModelOverrides` → 代理 frontmatter → 已配置的任务角色/会话回退。输出 schema 优先级: 每次调用 `outputSchema` → 代理 frontmatter `output` → 继承的父会话 schema。
8. 计划模式换成具有只读工具子集和计划模式提示的 `effectiveAgent`;`runSubprocess(...)` 接收 effective agent。
9. 如果 `isolated`,则需要 git 仓库(`getRepoRoot(...)` / `captureBaseline(...)`),将 `task.isolation.mode` 映射到后端种类提示 (`parseIsolationMode`),并通过原生 PAL 实现工作区(`ensureIsolation` → `isoResolve`/`isoStart`),当后端不可用时遍历候选列表。
10. 工件目录来自父会话文件(如果可用),否则是临时目录。当会话正在执行已批准的计划时,计划引用会传递给子代理。
11. 非隔离生成直接使用父 cwd 调用 `runSubprocess(...)`;隔离生成在隔离工作区内运行,然后提交到分支(`mergeMode === "branch"`)或捕获补丁,并始终清理工作区。
12. `runSubprocess(...)` 创建一个子代理会话,具有隔离的设置快照(继承父设置 — `async.enabled` 和 `bash.autoBackground.enabled` 从父级**继承**,而不是强制禁用;`tier.openai`/`tier.anthropic`/`tier.google` 通过 `tier.subagent` 重新解析;`tools.approvalMode` 强制为 `yolo`,因为无头子代理没有 UI 来确认提示;`advisor.enabled` 强制关闭,除非生成按代理选择加入;每次生成的覆盖可禁用读取摘要并清除隔离运行的额外工作区根),子 `agentId` 等于已分配的 id,子内部 URL 路由器/`AgentOutputManager`,输出 schema,系统提示 `CONTEXT` 部分中的共享 `context`(批次调用)…
13. 子工具可用性: 如果提供了显式 `agent.tools`;当代理具有 `spawns` 且深度允许时自动添加 `task`;在 `task.maxRecursionDepth` 处剥离 `task`;确保 `hub` 出现在显式工具列表中;将 `exec` 扩展为 `eval` + `bash`;剥离父拥有的 `todo` — 除非生成已预先启用 prewalk,其计划推动 + todo 门需要子代在模型交接前提交自己的 todo 列表。
14. 子代必须通过隐藏的 `yield` 工具完成;最多 3 次提醒提示,最后一次在支持时强制 `toolChoice = yield`。`finalizeSubprocessOutput(...)` 协调原始文本、`yield` 负载、结构化 schema 和中止状态。
15. 运行结束时的生命周期(保活,在运行终结器中):
    - 调用者信号、挂钟超时或内部硬中止 → 注册表状态 `aborted`,会话被释放 — 终态;
    - 对非隔离的保活代理的软请求预算中止 → 视为可恢复:代理变为 `idle` 并可接收后续/唤醒;
    - 隔离运行 → 状态 `parked` 无唤醒器(工作区已合并 + 清理,因此会话不可唤醒;转录仍可通过 `history://` 读取),然后会话被释放并分离;
    - 其他所有情况(成功和失败)→ 状态 `idle` 并附加实时会话,`AgentLifecycleManager.global().adopt(id, { idleTtlMs, revive })` 启动暂挂计时器。唤醒器重新打开会话 JSONL。
16. 此后的生命周期: `idle` 代理在 `task.agentIdleTtlMs` 后被暂挂(会话被释放;保留 `AgentRef` + 会话文件);消息传递(`hub`)或 Agent Hub 将其唤醒回 `idle`。"Main" 从不被暂挂。

## Modes / Variants
- 执行模式
  - 后台作业 — `async.enabled=true`;非阻塞生成通过 `AsyncJobManager` 进行。
  - 同步内联 — `async.enabled=false`、无作业管理器,或项的代理声明 `blocking: true`(按项:混合调用同时运行两种模式)。
- 批次模式 (`task.batch`,默认开启)
  - 开启 — `{ context, tasks[] }`: 每个项一个独立生成,必需的 `context` 在调用的生成之间共享,`agent`、`outputSchema` 和 `schemaMode` 按项设置。仅当其设置启用时才出现 `effort`;`isolated` 还要求计划模式已禁用。生命周期、唤醒和并发语义与 N 个并行单次调用匹配。
  - 关闭 — 每次调用单个生成;`tasks`/`context` 被拒绝并从 schema 中移除,具有相同的条件 `effort`/`isolated` 字段。
- 隔离模式 (`task.isolation.mode`): `none`, `auto`, `apfs`, `btrfs`, `zfs`, `reflink`, `overlayfs`, `projfs`, `block-clone`, `rcopy`(出于向后兼容接受遗留的 `worktree`, `fuse-overlay`, `fuse-projfs`);PAL 解析具有回退的实际后端。
- 隔离合并策略: 补丁模式(捕获/应用根补丁)或分支模式(提交到 `omp/task/<id>`,cherry-pick 到父级)。
- 代理源优先级按精确名称先到先得: 项目 `.omp/agents`;用户 `.omp/agent/agents`;CLI → 项目设置 → 用户设置 → 已安装 npm/link 插件顺序中的 OMP 扩展包 `agents/` 根;Claude marketplace 插件代理(项目优先于用户);然后是捆绑的(`scout`, `designer`, `reviewer`, `security-reviewer`, `librarian`, `task`, `sonic`)。
- Prewalk: 代理 frontmatter `prewalk` 或 `task.agentPrewalk[agentName]` 可以在正常模型上启动并在第一次编辑/写入时移交给更便宜的已解析模型。`task.prewalk`(默认关闭)为捆绑的通用 `task` 代理启用此行为。缺失/未配置的目标以及精确的 model+effort 无操作会跳过移交而不是使生成失败。
- Advisor: 代理 frontmatter `advisor` 或 `task.agentAdvisor[agentName]`(`"on"` / `"off"` / 模型模式)将子会话与 advisor 配对;显式模式落在子代的 `modelRoles.advisor` 上。子代理默认为无 advisor。

## Side Effects
- 文件系统
  - 在会话工件目录或临时任务目录下写入 `<id>.jsonl` 和 `<id>.md`;隔离补丁模式写入 `<id>.patch`。
  - 创建/删除 worktree 或 overlay 挂载目录;分支模式创建临时 worktree 和任务分支。
- 网络
  - 子会话可以使用其活动工具集允许的任何联网工具/模型。
  - MCP 代理工具可以使用 60_000 ms 超时调用现有的父 MCP 连接。
- 子进程/原生绑定
  - 隔离后端通过 `pi-natives` PAL (`crates/pi-iso`) 运行:Linux 上具有 `fuse-overlayfs`/`fusermount[3]` 回退的内核 `overlay`,APFS/Btrfs/ZFS/reflink 克隆,Windows 上的 ProjFS,作为最后手段的递归复制。
  - 用于基线捕获、补丁应用、worktree、分支、stash、cherry-pick、提交的 Git 操作。
- 会话状态(转录、内存、作业、检查点、注册表)
  - 创建具有隔离设置快照的子 `AgentSession` 实例;已完成的会话在进程全局 `AgentRegistry` 中保持注册为 `idle`/`parked`,直到进程拆除或显式释放。
  - 当 `async.enabled=true` 时,在 `session.asyncJobManager` 中为每个生成注册一个异步作业;完成作为 async-result 消息注入到父级。
  - 在 `AgentLifecycleManager` 中启动空闲 TTL 计时器(已 unref;它们从不保持进程打开)。
  - 在父事件总线上发出 `task:subagent:event`、`task:subagent:progress` 和 `task:subagent:lifecycle`。
  - 通过 `AgentOutputManager` 分配会话范围的输出 id,以便 `agent://` 在调用中保持唯一。
  - 与子代理共享父 `local://` 根和 `ArtifactManager`。
- 后台工作/取消
  - `hub` 取消(或父工具调用中止)取消后台作业;父工具调用中止通过调用信号取消同步运行。硬中止的运行状态为 `aborted` 并被拆除。
  - 缺少 `yield` 恢复向子会话发送最多三个内部提醒提示。

## Limits & Caps
- 每次生成的力度是可选的: `task.enableEffort` 默认为 `false`;当为 false 时,`effort` 从面向模型的动态 schema 中省略。
- 并发: 一个会话范围的 `Semaphore` 在每次获取和释放前根据实时 `task.maxConcurrency` 设置就地调整大小,然后限制并行 `task` 调用之间的并发子代理 — 异步作业主体和同步回退都获取它。因此会话中设置的更改会影响新的生成和已在信号量上排队的工作。
- 空闲 TTL: `task.agentIdleTtlMs`,默认 `420_000` ms(7 分钟);`<= 0` 禁用暂挂并使空闲会话保持活动直到退出。
- 每个子代理输出截断: `MAX_OUTPUT_BYTES = 500_000` 和 `MAX_OUTPUT_LINES = 5000`,在 `packages/coding-agent/src/task/types.ts` 中(可通过 `PI_TASK_MAX_OUTPUT_BYTES` / `PI_TASK_MAX_OUTPUT_LINES` 覆盖)。完整原始输出仍写入 `<id>.md`。
- 进度合并: `PROGRESS_COALESCE_MS = 150`;最近输出尾部: `RECENT_OUTPUT_TAIL_BYTES = 8 * 1024`(最后 8 个非空行)。
- 缺少 `yield` 的提醒重试: `MAX_YIELD_RETRIES = 3`;MCP 代理超时: `MCP_CALL_TIMEOUT_MS = 60_000` — 两者都在 `packages/coding-agent/src/task/executor.ts` 中。
- 软请求预算: `task.softRequestBudget` 默认为 200 个请求(`0` 禁用)。超出时,当 `task.softRequestBudgetNotice` 启用时注入收尾通知;在 1.5× 预算时,运行被强制停止以产生部分结果。捆绑的 scout/sonic 代理可能会施加较低的内置上限。
- 硬挂钟: `task.maxRuntimeMs` 应用于每个生成;默认 `0` 禁用它。
- 递归深度门控: `task.maxRecursionDepth`;`packages/coding-agent/src/tools/index.ts` 在达到或超过限制时隐藏 `task` 工具,`runSubprocess(...)` 也在最大深度处剥离子 `task` 访问。
- 最终内联摘要预览使用 `fullOutputThreshold = 5000` 字符,在 `packages/coding-agent/src/task/index.ts` 中;`agent://<id>` 指向完整工件。

## Errors
- 参数验证失败以空 `results` 的正常工具文本形式返回:
  - `schema`(永远不接受)
  - `tasks` / `context` 在 `task.batch` 禁用时
  - 批次调用: 缺失/空 `tasks`,没有 `task` 的项,重复的提供名称,缺少共享 `context`,`tasks` 旁边的顶层 `task`
  - 扁平调用: 缺失/空 `task`
  - 未知或设置禁用的代理类型,生成策略拒绝,在隔离模式为 `none` 时请求 `isolated`
- 没有 git 仓库的隔离执行返回 `Isolated task execution requires a git repository. ...`;不可用的后端通过 PAL 候选列表回退(通过 `fellBack`/`fallbackReason` 报告),其他后端错误重新抛出,在所有候选用尽时以回退原因报错。
- 作业注册失败返回 `Failed to start background task job(s): ...`;仅调度部分作业的批次在即时文本中报告失败的 id 并保持已启动的继续运行。
- 子失败显示为 `SingleResult.exitCode = 1`,并填充 `stderr`/`error`;异步作业标记为失败,但投递文本仍带有输出以及后续/转录提示。
- 如果子级省略 `yield`,`finalizeSubprocessOutput(...)` 注入诸如 `SYSTEM WARNING: Subagent exited without calling yield tool after 3 reminders.` 的警告。
- 当其他工具读取 `agent://<id>` 时,解析错误对模型可见: 无会话,无工件目录,缺少 id,冲突的提取语法,或用于提取的 JSON 无效。

## Notes
- 并行性是单个助手消息中的并行 `task` 调用 — 或者,使用 `task.batch`,在单个调用中的 `tasks[]` 批次;无论哪种方式,会话范围信号量限制扇出。当 `async.enabled=true` 时,每个生成都是独立的后台作业。
- 没有批次模式的共享背景约定: 将其一次性写入 `local://` 文件,并在每个生成的 `task` 中引用该路径 — 子代理共享父级的 `local://` 根。使用 `task.batch` 时,必需的 `context` 参数将共享背景直接带入每个生成的系统提示。
- 对于后续工作,优先选择消息传递现有代理(`hub`)而不是新的生成: 它已持有相关上下文。`hub` op:"list" 显示空闲/已暂挂候选;消息传递已暂挂代理会唤醒它。`history://<id>` 显示代理已执行的操作。
- 同行消息传递可用性是派生的,而不是配置的(`packages/coding-agent/src/tools/hub/messaging.ts` 中的 `isIrcEnabled`): 它仅在有人可以消息传递时存在 — 会话可以生成子代理,或者它本身就是子代理。消息传递是到已完成子代理的唯一后续路径,因此没有 hub 消息传递的 task 会使空闲代理搁浅。
- 代理发现优先级按精确名称先到先得: 项目 `.omp` 代理优先于用户 `.omp`,然后是 `listOmpExtensionRoots` 顺序(CLI、项目设置、用户设置、已安装 npm/link 插件)中的 OMP 扩展包 `agents/` 根,Claude marketplace 插件代理(项目优先于用户),以及捆绑代理。跳过直接的 `.claude/agents`、`.codex/agents` 和 `.gemini/agents` 根。创建时发现按 cwd 为提示描述进行记忆化;执行时发现保持新鲜。
- 子会话不继承对话历史。内置的延续是工作区树/技能/上下文文件、共享的 `local://` 根,以及在存在已批准计划时的计划引用。
- 当父级传递 `mcpManager` 时,子会话禁用独立 MCP 发现并获得重用父连接的代理工具。
- 分支模式合并在 cherry-pick 之前临时 stash 父仓库;stash-pop 冲突不会取消合并 cherry-picked 提交 — 它们保持在 HEAD 上,stash 条目被保留,冲突作为 `stashConflict` 单独呈现。补丁模式仅在 `git.patch.canApplyText(...)` 成功时应用组合的根补丁;失败时保留 `.patch` 工件以供手动处理。
- 嵌套的 git 仓库在隔离工作区内独立 diff,并使用 `applyNestedPatches(...)` 单独合并。
- `agent://` id 基于名称(`Task` 优先,仅当名称重复时才为 `Task-2`/`Task-3`,如 `Parent.Child` 嵌套),由 `AgentOutputManager` 确定;这正是防止重复或嵌套调用之间工件冲突的原因。
