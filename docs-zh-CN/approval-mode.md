# 工具审批模式

工具审批有三个输入：

1. **工具声明** — 每个工具都可以声明一个 `approval` 等级：
   - `read`：读取数据或仅更新 UI 会话元数据。
   - `write`：修改工作区/会话状态，但不执行任意代码。
   - `exec`：执行代码、调用 shell、驱动浏览器、派生子智能体，或执行类似范围的广泛操作。
2. **工具策略** — 对象形式的声明可以设置 `policy: allow | deny | prompt`，并可选择带有 `override` 和原因。用于依赖于参数的安全/模式规则。
3. **用户策略** — `tools.approval.<toolName>: allow | deny | prompt` 覆盖当前模式，但不能绕过工具自身的 deny/prompt 策略或非 yolo 的安全覆盖。

没有 `approval` 声明的工具，以及格式错误的审批决策，都按 `exec` 处理。这是针对未知自定义工具的安全默认值。MCP 服务器工具声明为 `write`。

## 模式

通过 `tools.approvalMode` 进行配置：

| 模式             | 自动批准           | 需要提示     |
| ---------------- | ------------------ | ------------ |
| `always-ask`     | `read`             | `write`、`exec` |
| `write`          | `read`、`write`    | `exec`       |
| `yolo`（默认）   | `read`、`write`、`exec` | 无          |

`--auto-approve` 和 `--yolo` 会在会话期间强制将 `tools.approvalMode` 设置为 `yolo`。

## 用户覆盖

`tools.approval` 在每种模式下都生效：

```yaml
tools:
  approvalMode: write
  approval:
    bash: prompt
    read: allow
    mcp__filesystem_delete: deny
```

对于 MCP 工具，策略键名必须使用最终注册的确切名称。通常的形式是
`mcp__<sanitized_server>_<sanitized_tool>`。冗余的 `<server>_` 前缀会从工具名中移除，
因此服务器 `echo` 的工具 `echo_it` 注册为 `mcp__echo_it`。超过 64 个字符的名称
会被截断并附加确定性的哈希后缀；请使用最终截断后的名称，而不是未截断的原始模式。参见
[MCP 工具命名](./mcp-server-tool-authoring.md#naming-and-collision-domain)。

每次工具调用的解析流程：

1. 执行 `tool.approval(args)`；省略/格式错误的决策默认为 `exec` 等级。
2. 工具声明的 `policy: deny` 始终拒绝。接下来检查用户 `deny`，它也始终拒绝。
3. 在 `yolo` 下，工具显式的 `allow`/`prompt` 策略优先；否则有效的用户策略胜出，或允许该调用。仅 `override` 标志本身不会在 `yolo` 下强制弹出提示。
4. 在非 yolo 模式下，`override: true` 的决策仅允许伴随的 `policy: allow`；其他所有非 deny 情况都会弹出提示。
5. 在没有 override 的情况下，工具显式的 `allow`/`prompt` 策略胜出，然后是有效的用户策略胜出。
6. 没有显式策略时，由当前模式按等级自动批准或弹出提示。

策略字符串会进行首尾空白处理并归一化大小写。无效的用户值会被忽略。

## 安全覆盖

工具可以通过对象形式的审批强制弹出提示：

```ts
approval: { tier: "exec", override: true, reason: "Critical pattern detected" }
```

`bash` 对关键性的破坏性模式使用此机制，例如 `rm -rf /`、fork 炸弹、先远程获取后执行、对 `/etc/passwd` 的写入，以及主机关机命令。它还支持配置的 `bash.patterns` 规则：`deny` 是绝对的，`prompt` 强制弹出提示，`allow` 显式允许匹配的调用在 `write` 等级下通过。原因会显示在审批提示中。在 `yolo` 下，单纯的关键性 override 会被忽略，但工具/用户显式的 `prompt` 或 `deny` 策略仍会强制执行。

`bash.patterns` 仅影响 `bash` 工具的审批决策。`eval` 工具声明为 `exec` 等级，并且可以通过子进程启动 shell，因此 `bash.patterns` 的 `deny` 规则不适用于通过 `eval` 运行的同一命令 — 在 `yolo` 下，该 `exec` 调用会解析为 `allow`。若要拦截 `eval` 可达的 shell，请与 `bash.patterns` 一并添加 `tools.approval.eval` 策略（`prompt` 或 `deny`）。

### 计算机安全

默认禁用的 [`computer` 工具](./computer-use.md) 根据调用的 `read_only` 声明来选择其等级：

- `read_only: true` 使用 `read`；
- `read_only: false`、缺失字段、参数格式错误或任何其他值，使用 `exec`。

审批提示在适用时会显示 `read-only`，随后是提交的 JavaScript（由标准格式化器截断为 2,000 字符）。`read_only` 是一个由审批等级强制执行的信任声明，而不是对脚本的静态分析。

此外，提供方发起的计算机使用调用可能携带 `pendingSafetyChecks` 元数据。任何待处理的安全检查都会强制弹出交互式提示，无论是否为 yolo、工具的 `allow`，或已经批准的 `xd://` 分发。提示会列出每个安全检查的代码、消息以及经过清理/截断的数据。如果没有交互式 UI，调用将以失败关闭，错误为 `pending provider safety checks but no interactive UI is available`。

工具审批并不授权底层的真实世界操作。屏幕上的文本是不可信的，不能覆盖用户的直接指令。重要的操作仍然需要在风险发生时对确切的目标、范围和值进行确认，除非用户的直接消息已经明确授权。

## 各工具的提示详情

工具可以通过 `formatApprovalDetails(args)` 向审批提示添加详情行。标准提示包括：

- `Allow tool: <name>`
- 对于未标注的 `mcp__...` 工具，显示 `Origin: MCP server tool`
- 当工具决策提供原因时显示 `Reason: <reason>`
- 工具特定的详情，例如命令、路径、代码、浏览器操作或子智能体分配

## 在工具上定义审批

内置工具和自定义工具使用相同的结构：

```ts
export type ToolTier = "read" | "write" | "exec";
export type ToolApprovalDecision =
  | ToolTier
  | {
      tier: ToolTier;
      reason?: string;
      override?: boolean;
      policy?: "allow" | "deny" | "prompt";
    };
export type ToolApproval = ToolApprovalDecision | ((args: unknown) => ToolApprovalDecision);

approval?: ToolApproval;
formatApprovalDetails?: (args: unknown) => string | string[] | undefined;
```

示例：

```ts
approval: "read";

approval: (args) => (LSP_READONLY_ACTIONS.has(args.action) ? "read" : "write");

approval: (args) =>
  isCritical(args.command)
    ? { tier: "exec", override: true, reason: "Critical pattern detected" }
    : "exec";

approval: (args) =>
  isForbidden(args)
    ? { tier: "exec", policy: "deny", reason: "Blocked by tool policy" }
    : "write";
```

## ACP 会话

ACP（`omp acp`）使用与普通 OMP 启动相同的设置解析器。全局的 `~/.omp/agent/config.yml` 生效，ACP 会话 `cwd` 对应的项目配置生效，传给 ACP 服务器进程的任何 `--config <file>` 覆盖也对该进程创建的会话生效。

要自动批准 ACP 工具调用，请在全局或项目配置中设置模式：

```yaml
tools:
  approvalMode: yolo
```

也可以在启动 ACP 服务器时使用运行时覆盖或单进程的配置覆盖：

```bash
omp acp --yolo
omp acp --auto-approve
omp acp --approval-mode yolo
omp acp --config ./acp-yolo.yml   # file contains tools.approvalMode: yolo
```

优先级遵循常规的设置优先级：运行时标志（`--approval-mode`、`--auto-approve`、`--yolo`）覆盖 `--config` 覆盖，覆盖项目配置，覆盖全局配置。ACP 目前未定义 `session/new`、`session/load` 或 `session/resume` 的审批策略字段，因此需要按会话启用 yolo 的 ACP 客户端应使用上述某个标志或针对该会话的 `--config` 覆盖来启动独立的 `omp acp` 进程。

当 `tools.approvalMode: yolo` 被显式配置或通过运行时标志提供时，它完全适用于 ACP。它会跳过 OMP 的审批提示，也会跳过 ACP 客户端对 `bash`、`edit`、`delete` 和 `move` 的权限关卡，除非 `tools.approval.<tool>` 被设置为 `prompt` 或 `deny`。Schema 默认值为 `yolo`，但默认配置的 ACP 会话仍会保留客户端权限关卡；在客户端希望无人值守执行时，请显式设置 `tools.approvalMode: yolo`。

当 ACP 需要审批时，OMP 会通过 ACP 客户端路由，而不是通过终端 TUI。由客户端把关的 `bash`、`edit`、`delete` 和 `move` 调用使用 ACP 的 `session/request_permission`；通用审批提示在客户端声明支持 `elicitation.form` 时使用表单征询（form elicitation）。被拒绝、取消或不支持的提示会使工具调用被拒绝/取消；OMP 不会静默放行。

## 子智能体

子智能体以 `tools.approvalMode: yolo` 无头运行，因此普通的基于等级的提示不会阻塞它们。父级 `task` 的审批是授权边界。用户的 `tools.approval.<tool>` 设置保持权威：`deny` 阻止该工具，`allow` 允许它，`prompt` 在无头的子智能体中无法满足，会导致调用被拒绝。
