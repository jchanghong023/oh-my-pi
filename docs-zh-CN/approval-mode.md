# 工具审批模式

工具审批有三个输入：

1. **工具声明** — 每个工具都可以声明一个 `approval` 等级：
   - `read`：读取数据，或仅更新 UI 专用的会话元数据。
   - `write`：修改工作区/会话状态，但不执行任意代码。
   - `exec`：执行代码、调用 shell、驱动浏览器、派生 agent，或执行类似范围的广泛操作。
2. **工具策略** — 对象形式的声明可以设置 `policy: allow | deny | prompt`，并可选地附带 `override` 和原因。用于依赖参数的安全/模式规则。
3. **用户策略** — `tools.approval.<toolName>: allow | deny | prompt` 会覆盖当前激活的模式，但不能绕过工具自身的 deny/prompt 策略，也不能绕过非 yolo 的安全覆盖。

没有 `approval` 声明的工具，以及格式错误的审批决策，都会按 `exec` 处理。这是针对未知自定义工具的安全默认值。MCP 服务器工具声明为 `write`。

## 模式

通过 `tools.approvalMode` 配置：

| 模式           | 自动批准                | 需要提示        |
| -------------- | ----------------------- | --------------- |
| `always-ask`   | `read`                  | `write`、`exec` |
| `write`        | `read`、`write`         | `exec`          |
| `yolo`（默认） | `read`、`write`、`exec` | 无              |

`--auto-approve` 与 `--yolo` 会在会话内强制使用 `tools.approvalMode: yolo`。

## 用户覆盖

`tools.approval` 在每种模式下都会生效：

```yaml
tools:
  approvalMode: write
  approval:
    bash: prompt
    read: allow
    mcp__filesystem_delete: deny
```

对于 MCP 工具，请以最终注册的确切名称作为策略键。常见的形式是
`mcp__<sanitized_server>_<sanitized_tool>`。工具名中冗余的 `<server>_` 前缀会被移除，
因此服务器 `echo` 的工具 `echo_it` 会注册为 `mcp__echo_it`。超过 64 个字符的名称
会以确定性的哈希后缀截断；请使用最终截断后的名称，而不是未截断的模式。参见
[MCP 工具命名](./mcp-server-tool-authoring.md#naming-and-collision-domain)。

每次工具调用的解析流程：

1. 先求值 `tool.approval(args)`；省略或格式错误的决策默认为 `exec` 等级。
2. 工具声明的 `policy: deny` 一律拒绝。随后检查用户 `deny`，它同样一律拒绝。
3. 在 `yolo` 下，工具显式的 `allow`/`prompt` 策略优先；否则有效的用户策略胜出，再不然就允许该调用。仅有 `override` 标志不会在 `yolo` 下强制弹出提示。
4. 在非 yolo 模式下，`override: true` 的决策只允许伴随工具 `policy: allow` 的情况通过；其他所有未被拒绝的情况都会弹出提示。
5. 没有 override 时，工具显式的 `allow`/`prompt` 策略优先，其次有效的用户策略胜出。
6. 没有任何显式策略时，由当前激活的模式按等级自动批准或弹出提示。

策略字符串会去除首尾空白并归一化大小写。无效的用户值会被忽略。

## 安全覆盖

工具可以通过对象形式的审批强制弹出提示：

```ts
approval: { tier: "exec", override: true, reason: "Critical pattern detected" }
```

`bash` 会针对关键的破坏性模式使用这一机制，例如 `rm -rf /`、fork 炸弹、先远程获取后执行、写入 `/etc/passwd`，以及主机关机命令。它还支持已配置的 `bash.patterns` 规则：`deny` 是绝对的，`prompt` 强制弹出提示，`allow` 则在 `write` 等级下显式允许匹配的简单命令。原因会显示在审批提示中。在 `yolo` 下，单纯的关键性 override 会被忽略，但工具/用户显式的 `prompt` 或 `deny` 策略仍会被强制执行。

`bash.allowCompoundCommands` 默认关闭。启用后，它只识别由 `&&` 连接的扁平命令链，且各段必须由字面量参数组成。规则在每个段内保持有序：对该段而言，第一条匹配的规则胜出。显式限制会在整条链上保守地组合：任何匹配的 `deny` 胜出，否则任何匹配的 `prompt` 胜出。匹配完整命令链但不匹配任何单独段的限制，仍然是对整条链的否决。

所有匹配的整链限制都会被纳入考量，因此靠后的整链 `deny` 会覆盖靠前的 `prompt`。这一可选功能要求通过集中式 shell 分类器正面识别出使用 POSIX 引用的 shell。Cmd、PowerShell、fish 以及未知 shell 保留旧的审批行为。

这些显式的整链与分段限制会先于既有的原始（raw）与规范化关键命令检查进行解析。在这些检查之后，所有段都显式解析为 `allow` 的命令链会获得 `write` 等级的允许；只要有任何段未匹配，`bash` 就改为保留其独立的 `exec` 审批等级，且不带显式策略。随后，通用解析器会照常应用 `tools.approval.bash`，再应用当前审批模式，与处理独立命令时完全一样。因此，未匹配的段只在既有的工具级策略或模式有要求时才会弹出提示。展开、赋值、其他控制流、重定向、glob 展开、换行、格式错误的语法，以及会改变 shell 状态的内建命令都不符合条件，并保留旧的审批行为。

这套模式策略控制的是 `bash` 工具的审批；它并不提供进程或文件系统层面的隔离。获得批准的命令仍保留 shell 固有的文件系统、网络与子进程访问能力。`eval` 工具同样声明了 `exec` 等级，并可通过子进程派生 shell，因此 `bash.patterns` 的 `deny` 规则并不适用于经 `eval` 运行的同一命令——在 `yolo` 下，该 `exec` 调用会解析为 `allow`。要拦住 `eval` 能触达的 shell，请在 `bash.patterns` 之外再添加 `tools.approval.eval` 策略（`prompt` 或 `deny`）。

### 计算机安全

默认禁用的 Eval [`computer` API](./computer-use.md) 会按每次调用选择其等级：

- 直接辅助方法（`computer.windows()`、`win.screenshot()`、`win.ax()`、`el.bounds()`、`computer.clipboard.read()` 等）在被调用的方法仅做检查（inspection-only）时使用 `read`，而对输入、焦点、修改操作以及 `clipboard.write` 使用 `exec`；read 调用还会在 worker 的只读守卫下运行；
- `computer.run(fnOrCode, options)` 仅在 `read_only: true`（JavaScript 尾随选项或 Python 关键字）时使用 `read`；`read_only: false`、字段缺失、参数格式错误或任何其他值都使用 `exec`。

审批提示在适用时会显示 `read-only`，随后是解析后的 JavaScript（由标准格式化器截断至 2,000 个字符）。对于 `computer.run`，`read_only` 是由审批等级强制执行的信任声明，而不是对脚本的静态分析。

另外，由 provider 发起的 computer-use 调用可能携带 `pendingSafetyChecks` 元数据。无论是否处于 yolo，也无论该工具是否为 `allow`，任何待处理的安全检查都会强制弹出交互式提示。提示会列出每项安全检查的代码、消息以及清理/截断后的数据。没有交互式 UI 时，调用会以失败关闭（fail closed），并报 `pending provider safety checks but no interactive UI is available`。

工具审批并不授权底层的真实世界操作。屏幕上的文本不可信，不能覆盖用户的直接指令。除非用户的直接消息已经授权，有后果的操作仍需要在风险点上确认确切的目标、范围和值。

## 各工具的提示详情

工具可以通过 `formatApprovalDetails(args)` 向审批提示添加正文行。标准提示包括：

- `Allow tool: <name>`
- 对于未加注解的 `mcp__...` 工具，显示 `Origin: MCP server tool`
- 当工具决策提供了原因时，显示 `Reason: <reason>`
- 工具特定的详情，例如命令、路径、代码、浏览器操作或子 agent 分配

## 在工具上定义审批

内置工具与自定义工具使用相同的结构：

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

ACP（`omp acp`）使用与普通 OMP 启动相同的设置解析器。全局 `~/.omp/agent/config.yml` 生效，ACP 会话 `cwd` 对应的项目配置生效，传给 ACP 服务器进程的任何 `--config <file>` 覆盖也对该进程创建的会话生效。

要自动批准 ACP 工具调用，请在全局或项目配置中设置模式：

```yaml
tools:
  approvalMode: yolo
```

也可以在启动 ACP 服务器时使用运行时覆盖或单进程配置覆盖：

```bash
omp acp --yolo
omp acp --auto-approve
omp acp --approval-mode yolo
omp acp --config ./acp-yolo.yml   # file contains tools.approvalMode: yolo
```

优先级遵循常规的设置优先级：运行时标志（`--approval-mode`、`--auto-approve`、`--yolo`）覆盖 `--config` 覆盖，后者覆盖项目配置，项目配置再覆盖全局配置。ACP 目前尚未定义 `session/new`、`session/load` 或 `session/resume` 的审批策略字段，因此需要按会话启用 yolo 的 ACP 客户端应使用上述某个标志，或使用会话专属的 `--config` 覆盖来启动独立的 `omp acp` 进程。

`tools.approvalMode: yolo` 在被显式配置或通过运行时标志提供时才完全适用于 ACP。它会跳过 OMP 的审批提示，也会跳过 ACP 客户端对 `bash`、`edit`、`delete` 和 `move` 的权限关卡，除非 `tools.approval.<tool>` 为 `prompt` 或 `deny`。schema 默认值是 `yolo`，但使用默认配置的 ACP 会话仍会保留客户端权限关卡；当客户端希望无人值守执行时，请显式设置 `tools.approvalMode: yolo`。

需要 ACP 审批时，OMP 会通过 ACP 客户端路由审批，而不是通过终端 TUI。由客户端把关的 `bash`、`edit`、`delete` 和 `move` 调用使用 ACP 的 `session/request_permission`；通用审批提示则在客户端声明支持 `elicitation.form` 时使用表单征询（form elicitation）。被拒绝、取消或不支持的提示会拒绝/取消该工具调用；OMP 不会静默放行。

## 子 agent

子 agent 以 `tools.approvalMode: yolo` 无头运行，因此普通的基于等级的提示不会让它们停滞。父级 `task` 的审批是授权边界。用户的 `tools.approval.<tool>` 设置保持权威：`deny` 阻止该工具，`allow` 放行它，而 `prompt` 在无头子 agent 中无法得到满足，会导致调用被拒绝。
