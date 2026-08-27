# learn

> 将一条可复用的经验沉淀到长期记忆中，并可选择创建或更新托管技能。

## 来源
- Entry: `packages/coding-agent/src/tools/learn.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/learn.md`
- Managed-skill helper: `packages/coding-agent/src/autolearn/managed-skills.ts`
- Local memory backend: `packages/coding-agent/src/memory-backend/local-backend.ts`
- Local lesson persistence: `packages/coding-agent/src/memories/index.ts` (`saveLearnedLesson(...)`)

## 注册 / 可见性
- `loadMode = "essential"` 且 `strict = true`，因此该工具保持在顶层，而不会挂载到 `xd://` 下。
- 审批是动态的：包含 `skill` 的调用，或在 `memory.backend = "local"` 时的任何调用，其 `approval = "write"`；仅涉及记忆的 Hindsight/Mnemopi 调用，其 `approval = "read"`。
- 注册要求 `autolearn.enabled = true`（默认 `false`）且 `memory.backend` 为 `"hindsight"`、`"mnemopi"` 或 `"local"`。
- 处于启用状态的顶层会话会在普通的显式工具列表中自动包含 `learn`。子代理不会自动发现或自动接收该工具，但当它们请求的工具/frontmatter 列表中显式包含 `learn` 时可以使用。
- 执行是单次的，不发出任何进度更新。

## 输入

| 字段 | 类型 | 必填 | 描述 |
|---|---|---:|---|
| `memory` | `string` | 是 | 需长期保存的、自包含的经验：内容、发生时机与原因。该 schema 不要求最小长度；后端特定的清洗与存储策略决定空值能否成功。 |
| `context` | `string` | 否 | 该经验的来源上下文。 |
| `skill` | `{ action: "create" \| "update"; name: string; description: string; body: string }` | 否 | 在经验保存成功后需要创建或增强的托管技能。`body` 是 Markdown，不含 frontmatter。 |

## 输出
- 仅保存经验：
  - `content[0].text = "Lesson stored."` 或 `"Lesson queued for retention."`
  - `details = { skill: null }`
- 保存经验并操作技能：
  - `content[0].text = "<lesson result>. Created managed skill \"<name>\"."` 或 `"... Updated ..."`
  - `details = { skill: "<name>" }`
- 已编写技能出现命名冲突时，会在保存/入队经验后返回 `isError: true`，并报告 `details = { skill: null, shadowed: true }`。

## 流程
1. `LearnTool.createIf(...)` 仅在 `autolearn.enabled = true` 且 `memory.backend` 为 `"hindsight"`、`"mnemopi"` 或 `"local"` 时才暴露该工具。
2. `execute(...)` 在尝试任何技能变更之前先存储经验：
   - Mnemopi：调用 `rememberScoped(...)`，参数为 `source: "coding-agent-learn"`、`importance: 0.8`、`scope: "bank"`，启用抽取，`veracity: "tool"`、`memoryType: "fact"`，并附带 session/cwd/context 元数据；返回的 id 缺失视为失败。
   - 本地后端：调用 `localBackend.save(...)`，该调用会规范化并写入项目范围内的 `learned.md`；`stored === 0` 视为失败。
   - Hindsight：调用 `state.enqueueRetain(memory, context)` 将保留任务入队，并报告经验已入队。
3. 若 `skill` 缺失，工具在记忆写入/入队后即返回。
4. 若 `skill.action == "create"`，工具会将经小写化与校验的名称与当前已编写的技能进行比对。若存在冲突，则在经验已存储或入队后返回错误结果。
5. 其余情况调用 `writeManagedSkill(...)`。由于经验已持久化，技能写入失败会作为部分结果抛出。
6. 与 `manage_skill` 不同，`learn` 不会在写入后调用会话的 `refreshSkills` 回调。托管技能将在后续的技能刷新或会话中被发现。

## 模式 / 变体
- 仅捕获经验到记忆。
- 经验加上托管技能的创建/更新，用于值得固化为 `SKILL.md` 的可重复流程。
- 特定后端的持久化方式：Hindsight 入队、Mnemopi 的 scoped SQLite、或项目范围内的本地 `learned.md`。
- 托管技能文件已存在时 `create` 失败；不存在时 `update` 失败。同名的进程内变更会被串行化。

## 副作用
- 文件系统：
  - 本地后端写入 `<agent-dir>/memories/<encoded-cwd>/learned.md`。
  - 托管技能写入 `<agent-dir>/managed-skills/<sanitized-name>/SKILL.md`；默认的 agent 目录为 `~/.omp/agent`。
  - Mnemopi 写入其 scoped SQLite 数据库。
- 网络：Hindsight 队列稍后会刷新到所配置的服务器。Mnemopi 在同步写入行之后，可能调度其配置的 embedding/事实抽取任务；本地基于文件的存储本身是离线的。
- 会话状态：读取后端状态、设置、cwd 与 session id。此处创建的技能不会立即注入到当前激活的技能列表中。
- 后台任务：Hindsight 的 retention 与 Mnemopi 的抽取/embedding 可能在工具返回结果后继续运行。

## 限制与上限
- 可用性要求 `autolearn.enabled` 已开启并配置受支持的记忆后端；这两项设置默认均为关闭/未启用。
- 托管技能名称会先去除首尾空白并小写化，然后必须匹配 `[a-z0-9][a-z0-9-]{0,63}`。
- 托管描述会折叠为单行，并去除控制字符与格式字符、尖括号、反引号，以及重复的波浪号。
- 最终托管的 `SKILL.md` 内容，包括生成的 frontmatter 与 description，UTF-8 字节数上限为 `64_000`。
- 托管技能永远不会覆盖已编写的技能；已编写技能的名称在发现时优先。
- 本地经验按新到旧排列，并按规范化渲染后的行进行去重，最多 100 条经验条目。经验内容在经过提示注入中和与密钥脱敏后，上限 2,000 字符；context 上限 400 字符。

## 错误
- 当 Mnemopi 状态缺失时：`Mnemopi backend is not initialised for this session.`
- 当本地 Mnemopi 写入未返回 id 时：`Mnemopi did not store the lesson (no memory id returned).`；此时不会尝试可选的技能操作。
- 当本地后端规范化后经验为空时：`Lesson was empty after sanitization; nothing stored.`；此时不会尝试可选的技能操作。
- 当 Hindsight 状态缺失时：`Hindsight backend is not initialised for this session.`
- 当 `skill.action = "create"` 与已编写技能命名冲突时，会在经验保存成功后返回 `isError: true`、`details = { skill: null, shadowed: true }`。
- 托管技能的校验、创建/更新、安全或体积相关的失败，会在经验保存成功后抛出 `<lesson result>, but the managed skill could not be written: <reason>`。

## 备注
- 应谨慎使用该工具。一条精确可复用的经验胜过几条含糊的记忆。
- 仅对可重复的流程使用 `skill`；普通的事实应仅保留为记忆。
- 托管技能的 frontmatter 由规范化的名称与清洗后的描述生成；`body` 不得包含 frontmatter。
- 托管技能与已编写技能是相互隔离的。`learn` 将托管技能写入以供后续发现刷新使用；当活动会话需要在变更后立即刷新时，请使用 `manage_skill`。
