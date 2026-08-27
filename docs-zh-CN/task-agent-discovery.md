# Task 子代理的发现与选择

本文档描述 task 子系统如何发现代理定义、合并多个来源，以及在执行时解析所请求的代理。

内容涵盖当前的运行时行为，包括优先级、无效定义的处理，以及可能使某个代理实际不可用的生成/深度约束。

## 实现文件

- [`src/task/discovery.ts`](../packages/coding-agent/src/task/discovery.ts)
- [`src/task/agents.ts`](../packages/coding-agent/src/task/agents.ts)
- [`src/task/types.ts`](../packages/coding-agent/src/task/types.ts)
- [`src/task/index.ts`](../packages/coding-agent/src/task/index.ts)
- [`src/task/structured-subagent.ts`](../packages/coding-agent/src/task/structured-subagent.ts)
- [`src/task/spawn-policy.ts`](../packages/coding-agent/src/task/spawn-policy.ts)
- [`src/task/commands.ts`](../packages/coding-agent/src/task/commands.ts)
- [`src/prompts/agents/task.md`](../packages/coding-agent/src/prompts/agents/task.md)
- [`src/prompts/tools/task.md`](../packages/coding-agent/src/prompts/tools/task.md)
- [`src/discovery/helpers.ts`](../packages/coding-agent/src/discovery/helpers.ts)
- [`src/discovery/omp-extension-roots.ts`](../packages/coding-agent/src/discovery/omp-extension-roots.ts)
- [`src/config.ts`](../packages/coding-agent/src/config.ts)
- [`src/task/executor.ts`](../packages/coding-agent/src/task/executor.ts)

---

## 代理定义形态

Task 代理会被归一化为 `AgentDefinition`（`src/task/types.ts`）：

- 必填 `name`、`description` 和 `systemPrompt`
- 可选 `tools`、`spawns`、有优先级的 `model` 列表、`thinkingLevel`、`output`、`blocking`、`autoloadSkills`、`readSummarize`、`prewalk`、`advisor`
- `source`：`"bundled" | "user" | "project"`（扩展代理使用其扩展根目录的 project/user 级别打标）
- 可选 `filePath`

解析由 `parseAgentFields()`（`src/discovery/helpers.ts`）从 frontmatter 完成：

- 缺少 `name` 或 `description` => 无效（`null`），调用方视为解析失败
- `tools` 接受 CSV 或数组；如果提供了 `tools`，会自动追加 `yield`
- `spawns` 接受 `*`、CSV 或数组
- 向后兼容行为：如果缺少 `spawns` 但 `tools` 包含 `task`，则 `spawns` 变为 `*`
- `output` 按不透明 schema 数据原样透传
- `read-summarize: false`（归一化为 `readSummarize`）强制子代理的 `read` 工具返回逐字的原始文件内容而非结构化摘要 —— `runSubprocess` 会将其作为子代理隔离设置的 `read.summarize.enabled: false` 覆盖项应用（`src/task/executor.ts`）。`scout` 和 `librarian` 内置即关闭此选项。字段缺省时默认为启用。
- `model` 接受单个选择器、CSV 或数组。条目会在角色别名展开后按顺序依次尝试。
- `thinking-level` / `thinking` 选择代理配置的思考强度。当 `task.enableEffort`（默认 `false`）将其暴露出来时，task 条目的粗粒度 `effort`（`lo`、`med`、`hi`）在启动时优先生效。OMP 会将该提示映射到所选模型支持的最低、中等或最高思考强度，并将其裁剪到 `task.maxEffort`（默认 `max`）。该上限在重试回退切换模型时会被持续保留。如果所选模型在不超过该上限的情况下没有可用的思考强度，则生成失败；不支持可控思考强度的模型则会回退到其正常选择器。
- `blocking: true` 会让父会话在启用异步 task 执行时仍然等待该代理完成
- `autoloadSkills` 指定来自父会话、需在子代理首个提示之前注入的技能名称；未知的名称会被忽略
- `prewalk: true` 让子代理在其解析后的模型上启动，并在首次编辑/写入时交接给默认的 prewalk 目标（即 `smol` 角色），与会话级别的 `--prewalk` 完全一致；字符串值（如 `prewalk: "@smol"` 或 `prewalk: "openai/gpt-5-mini"`）用于选择自定义目标。`task.agentPrewalk` 设置项（代理名 → `"on"` / `"off"` / 模式，通过 `/agents` hub 中的 prewalk 条按代理配置）会覆盖 frontmatter。解析在 `runSubprocess`（`src/task/executor.ts`）中完成。目标不可用时跳过而不会导致生成失败。仅当解析后目标的模型身份和有效思考模式/等级在模型裁剪后与起始选择同时一致时，才跳过已解析的目标；同模型下的 effort 降…
- `advisor: true` 会为该代理生成的会话配对一个 advisor，使用为 `advisor` 角色解析出的模型运行；字符串值（如 `advisor: "deepseek/deepseek-v4-flash"` 或 `advisor: "@smol:high"`）用于设置显式的 advisor 模型模式（可选 `:level` 后缀），该模式会作为生成会话的 `modelRoles.advisor` 应用。`task.agentAdvisor` 设置项（代理名 → `"on"` / `"off"` / 模式，通过 `/agents` hub 中的 advisor 条按代理配置）会覆盖 frontmatter。解析在 `runSubprocess`（`src/task/executor.ts`）中完成；子代理默认不启用 advisor，最终生效的开启状态会持久化在 `session_init` 中，以便冷启动恢复后仍然保留。

## 基于角色的自定义代理

OMP 从 `~/.omp/agent/agents/*.md` 发现用户代理，从 `.omp/agents/*.md` 发现项目代理。

在 frontmatter 中为代理指定一个角色别名，然后按名称分派即可。对于模型路由，task 分派仅设置 `agent`，不设置 worker 模型：

`~/.omp/agent/agents/reviewer.md`：

```md
---
name: reviewer
description: Review a change for correctness.
model: "@review"
---

Review the assigned change and report concrete findings.
```

在 `~/.omp/agent/config.yml` 中设置角色映射：

```yaml
modelRoles:
  review: openai/gpt-5.4:high
```

`@review` 通过 `modelRoles.review` 解析。每个 `modelRoles.<role>` 值存储一个具体的模型选择器，并可追加如 `:high` 的思考后缀（`src/config/model-resolver.ts`）。修改该映射会影响后续的 task 解析而无需编辑代理定义。Task/eval 预检会在重新发现代理之前重新加载当前的全局、项目和显式覆盖设置，因此活动会话期间新增的代理文件及其角色别名会基于同一份刷新后的配置状态进行解析。

发起一次分派时，指定代理名和任务：

```json
{
  "context": "Review the current change in this repository.",
  "tasks": [
    { "agent": "reviewer", "task": "Report concrete correctness findings." }
  ]
}
```

`/model` 的 Roles 视图可以分配并持久化自定义角色映射，例如 `review`、`fast` 和 `good`。仅修改当前或默认会话的模型选择不会重新映射这些角色。

## 监控运行中的代理

分派之后，按 `Alt+A` 打开 [Agent Hub](./agent-hub.md)。其实时花名册显示每个 task 代理的状态、当前活动、模型、运行时长和用量。选择某个代理即可阅读其会话记录并直接进行引导；停放中的代理也可以在同一视图中被恢复。

### `vibe_spawn` 的层级路由

`vibe_spawn` 将 `fast` 映射到内置的 `sonic`，将 `good` 映射到内置的 `task`。两者在解析时都会先经过 `task.agentModelOverrides`，再回退到其内置代理的默认模型（`src/vibe/runtime.ts`、`src/task/agents.ts`）。

通过将别名保留在 `task.agentModelOverrides` 中、仅将具体选择器放在 `modelRoles` 中，从而按角色路由这些层级：

```yaml
task:
  agentModelOverrides:
    sonic: "@fast_worker"
    task: "@good_worker"
modelRoles:
  fast_worker: openai/gpt-5-mini
  good_worker: openai/gpt-5.4:high
```

`vibe_spawn` 的 `cli` 仍然是 `fast` 或 `good`；修改 `modelRoles` 即可改变 worker 模型。

## 内置代理

内置代理在构建时通过 `src/task/agents.ts` 使用文本导入方式嵌入。

`EMBEDDED_AGENT_DEFS` 定义了：

- 来自提示文件的 `scout`、`designer`、`reviewer`、`security-reviewer` 和 `librarian`
- 来自共享的 `task.md` 正文加上注入的 frontmatter 的 `task` 和 `sonic`；没有任何内置代理设置 `prewalk` —— 通用 `task` 代理的交接由 `task.prewalk` 设置（默认关闭）启用，也可通过 `/agents` / `task.agentPrewalk` / 用户代理 frontmatter 按代理单独启用

加载路径：

1. `loadBundledAgents()` 使用 `parseAgent(..., "bundled", "fatal")` 解析嵌入的 markdown
2. 结果缓存在内存中（`bundledAgentsCache`）
3. `clearBundledAgentsCache()` 仅在测试中重置缓存

由于内置解析使用 `level: "fatal"`，格式错误的前置元数据会抛错，并可能导致整个发现过程失败。

## 文件系统与插件发现

`discoverAgents(cwd, home)`（`src/task/discovery.ts`）会合并 OMP 原生根目录、OMP 扩展包和 Claude marketplace 插件根目录中的代理，然后再追加内置定义。直接跨运行时的根目录（如 `.claude/agents`、`.codex/agents`、`.gemini/agents`）会被有意跳过 —— 它们的前置元数据 schema 并非 OMP 的 task 代理契约（`TASK_AGENT_CONFIG_SOURCE = ".omp"` 用于过滤原生配置目录列表）。

### 发现输入与优先级

1. 来自 `findAllNearestProjectConfigDirs("agents", cwd)` 的最近项目 `.omp/agents` 目录（仅取首个 `.omp` 命中）
2. 来自 `getConfigDirs("agents", { project: false })` 的用户 `.omp/agents` 目录（仅取首个 `.omp` 命中）
3. 每个由 `listOmpExtensionRoots(...)` 返回的、已启用的 OMP 扩展包的 `<extension-root>/agents`，顺序如下：
   - CLI `--extension` 根目录
   - 项目 `extensions:` 设置
   - 用户 `extensions:` 设置
   - 已安装的 npm/link 插件
4. Claude marketplace 插件根目录（`listClaudePluginRoots(home, cwd)`）下的 `agents/` 子目录 —— 仅当 `isProviderEnabled("claude-plugins")` 为真时启用；项目级插件在用户级插件之前排序
5. 内置代理（`loadBundledAgents()`）

当 `omp-plugins` 能力提供者被禁用时，OMP 扩展包接口也会被禁用。Marketplace 根目录会从 `listOmpExtensionRoots` 中排除，仅通过单独门控的 Claude 插件路径进入。

## 合并与冲突规则

发现过程使用按精确 `agent.name` 的先到优先去重：

- 一个 `Set<string>` 用于跟踪已见到的名称。
- 已加载的代理按目录顺序展平，仅保留名称未出现过的项。
- 内置代理使用同一集合进行过滤，仅在名称仍未出现过时才会被添加。

由此带来的影响：

- 项目的 `.omp` 覆盖用户的 `.omp`。
- 较早出现的扩展根目录会覆盖较晚出现的扩展根目录、Claude marketplace 插件和内置代理。
- 非内置代理会覆盖同名的内置代理。
- 名称匹配区分大小写（`Task` 与 `task` 是不同的）。
- 在同一目录内，markdown 文件在去重之前按文件名的字典序读取。

## 代理文件无效或缺失时的行为

按目录（`loadAgentsFromDir`）：

- 不可读或缺失的目录：视为空（`readdir(...).catch(() => [])`）
- 文件读取或解析失败：记录警告，跳过该文件
- 解析路径使用 `parseAgent(..., level: "warn")`

前置元数据失败的行为来自 `parseFrontmatter`：

- 在 `warn` 级别下的解析错误会记录警告
- 解析器回退到简单的 `key: value` 行解析器
- 如果必填字段仍然缺失，`parseAgentFields` 失败，随后抛出 `AgentParsingError`，由调用方捕获（跳过该文件）

净效果：一个有问题的自定义代理文件不会中断其他文件的发现过程。

## 代理的查找与选择

查找使用按精确名称的线性搜索：

- `getAgent(agents, name)` => `agents.find(a => a.name === name)`
- 在未受限制的会话中，缺省的 `agent` 字段默认为 `task`
- 在受限父级 `spawns` 列表下，缺省的 `agent` 字段默认为列表中的第一个代理

`resolveEffectiveSubagentPolicy()` 由 task 和 eval 支持的子代理启动共享。在分配产物之前，它会：

1. 原子地重新加载当前会话持久化的全局、项目和显式覆盖设置，同时保留运行时覆盖项
2. 从父级生成策略中解析省略的或显式的代理名称
3. 强制执行深度、阻止自递归和父级生成策略的检查
4. 使用 `discoverAgents(session.cwd)` 重新发现代理，并进行精确名称查找
5. 检查 `task.disabledAgents`
6. 解析 plan-mode 限制、输出 schema、模型策略和隔离策略

名称缺失会在预检阶段失败，并显示 `Unknown agent "...". Available: ...`；不会启动任何子进程。

### 描述阶段 vs 执行阶段的发现

`TaskTool.create()` 在为面向模型的工具描述构建时，会按解析后的工作目录记忆化发现结果。执行阶段会重新发现代理，因此如果代理或扩展文件在会话中途发生变化，运行时集合可能与先前的描述不同。阻塞行为是在策略解析之后确定的，而不是基于过时的描述阶段代理对象。

## 模型与结构化输出的优先级

对于 task 分派，模型优先级为：

1. `task.agentModelOverrides[agentName]`
2. 代理 frontmatter 中有优先级的 `model` 列表
3. 父级当前激活的模型，然后是其配置/默认模型回退

前两个来源中的角色别名会通过 `modelRoles` 展开。共享的 eval 桥也可以在设置覆盖之前提供一个调用本地的模型覆盖；task 线路 schema 并不暴露该字段。

运行时输出 schema 的优先级为：

1. task 条目的显式 `outputSchema`
2. 代理 frontmatter 的 `output`
3. 父会话的 `outputSchema`

task 条目的可选 `schemaMode` 会覆盖父会话的模式；默认值为 `permissive`。

面向模型的提示（`src/prompts/tools/task.md`）会标记只读代理，并警告不要将推理工作卸载给 `scout`/`sonic`。

## 命令发现的交互

`src/task/commands.ts` 是用于工作流命令（而非代理定义）的并行基础设施，但遵循相同的整体模式：

- 首先从能力提供者发现
- 按名称先到优先去重
- 如果名称仍未出现，则追加内置命令
- 通过 `getCommand` 进行精确名称查找

在 `src/task/index.ts` 中，命令辅助函数会与代理发现辅助函数一起被重新导出。代理发现本身在运行时并不依赖于命令发现。

## 超出发现的可用性约束

代理可以被发现，但由于执行保护措施仍可能无法运行。

### 禁用代理的设置

`resolveEffectiveSubagentPolicy()` 会在解析代理之后检查 `task.disabledAgents`。名称被禁用会在预检阶段失败，并在可用时列出启用的备选项。

### 父级生成策略

解析器会检查 `session.getSessionSpawns()`：

- `"*"`（也包括 `true`、`null` 或缺省）=> 允许任意代理；缺省的 `agent` 默认为 `task`
- `""` 或 `false` => 拒绝所有
- CSV 列表 => 仅允许列表中的名称；缺省的 `agent` 默认为列表中的第一个名称

被拒绝时：`Cannot spawn '...'. Allowed: ...`。

### 阻止自递归的环境变量防护

`PI_BLOCKED_AGENT`（或内部请求覆盖）会在发现之前拒绝尝试生成同一个被阻止的代理。

### 递归深度门控

`task.maxRecursionDepth` 默认为 `2`；负值会禁用该上限。当当前 task 深度已经达到上限时，共享策略会拒绝该生成。当子任务达到上限时，`runSubprocess` 还会从其工具列表中移除 `task` 并将其生成策略设为空。

对于受限的代理工具列表，当声明了 `spawns` 且深度允许时，`runSubprocess` 会自动添加 `task`。它还会保留宿主的 `hub` 协作工具，除非会话显式限制了工具名称。

## Plan 模式行为

当父级 plan 模式启用时，`resolveEffectiveSubagentPolicy()` 会在启动子进程之前构建一个 `effectiveAgent`：

- 在其前置位置加入 plan 模式子代理的系统提示
- 将工具限制为 `read`、`grep`、`glob` 和 `web_search`，并当代理自身的工具列表中声明了 `ast_grep` 时一并保留
- 清空子代理的生成列表
- 清空 `prewalk`（只读探索不得接收 prewalk 的 plan/implement 提示）

Plan 模式还会拒绝每次生成的隔离、apply 和 merge 控制。同一个 `effectiveAgent` 会用于子进程启动、模型/思考覆盖和输出 schema 的选择。
