# 自定义工具

自定义工具是模型可调用的函数，插入到与内置工具相同的工具执行流水线中。

自定义工具是一个 TypeScript/JavaScript 模块，导出一个工厂函数。工厂函数接收一个宿主 API（`CustomToolAPI`），并返回一个工具或一个工具数组。

## 是什么（以及不是什么）

- **Custom tool（自定义工具）**：在模型轮次中可被调用（`execute` + 参数 schema）。
- **Extension（扩展）**：生命周期/事件框架，可以注册工具并拦截/修改事件。
- **Hook（钩子）**：通过扩展运行器加载的遗留事件驱动拦截器 API。
- **Skill（技能）**：静态的指引/上下文包，不是可执行的工具代码。

如果你需要让模型直接调用代码，就使用自定义工具。

## 当前代码中的集成路径

当前有两种活跃的集成方式：

1. **SDK 提供的自定义工具**（`options.customTools`）
   - 在非受限的 SDK 引导中，会转换为扩展的工具定义，通过生成的扩展进行注册，并始终包含在初始激活工具集合中。
   - 在受限会话中（`restrictToolNames: true`），除非设置 `allowRestrictedCustomTools: true`，否则 SDK 提供的自定义工具会被排除；被启用的工具只有当其名称也出现在 `toolNames` 中时才会处于激活状态。

2. **通过加载器 API 从文件系统发现的模块**（`discoverAndLoadCustomTools` / `loadCustomTools`）
   - 作为库 API 暴露在 `packages/coding-agent/src/extensibility/custom-tools/loader.ts` 中。
   - 宿主代码可以调用这些 API，从 config/provider/plugin 路径发现并加载工具模块。

```text
Model tool call flow

LLM tool call
   │
   ▼
Tool registry (built-ins + registered custom definitions)
   │
   ▼
CustomTool.execute(toolCallId, params, onUpdate, ctx, signal)
   │
   ├─ onUpdate(...)  -> streamed partial result
   └─ return result  -> final tool content/details
```

## 发现位置（加载器 API）

`discoverAndLoadCustomTools(configuredPaths, cwd, builtInToolNames)` 会合并以下来源：

1. 能力提供者（`toolCapability`），包括：
   - 原生 OMP 配置（`~/.omp/agent/tools`、`.omp/tools`）
   - Claude 配置（`~/.claude/tools`、`.claude/tools`）
   - Codex 配置（`~/.codex/tools`、`.codex/tools`）
   - Claude marketplace 插件缓存提供者
2. 已安装的插件清单（通过插件加载器，路径为 `~/.omp/plugins/node_modules/*`）
3. 显式传递给加载器的配置路径

### 重要行为

- 重复解析的路径会被去重。
- 工具名称冲突会对照内置工具和已加载的自定义工具进行拒绝。
- `.md` 和 `.json` 文件会被某些提供者作为工具元数据发现，但可执行模块加载器会拒绝将它们作为可运行的工具。
- 相对配置路径相对于 `cwd` 解析；`~` 会被展开。

## 模块契约

自定义工具模块必须导出一个函数（首选默认导出）：

```ts
import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";

const factory: CustomToolFactory = (pi) => ({
  name: "repo_stats",
  label: "Repo Stats",
  description: "Counts tracked TypeScript files",
  parameters: pi.zod.object({
    glob: pi.zod.string().optional(),
  }),

  async execute(toolCallId, params, onUpdate, ctx, signal) {
    onUpdate?.({
      content: [{ type: "text", text: "Scanning files..." }],
      details: { phase: "scan" },
    });

    const result = await pi.exec(
      "git",
      ["ls-files", params.glob ?? "**/*.ts"],
      { signal, cwd: pi.cwd },
    );
    if (result.killed) {
      throw new Error("Scan was cancelled");
    }
    if (result.code !== 0) {
      throw new Error(result.stderr || "git ls-files failed");
    }

    const files = result.stdout.split("\n").filter(Boolean);
    return {
      content: [{ type: "text", text: `Found ${files.length} files` }],
      details: { count: files.length, sample: files.slice(0, 10) },
    };
  },

  onSession(event) {
    if (event.reason === "shutdown") {
      // cleanup resources if needed
    }
  },
});

export default factory;
```

参数 schema 可以使用与 Zod 兼容的 omptype 构建器（`pi.zod`）、原生 omptype 构建器（`pi.arktype`），或者兼容旧式 TypeBox 的 shim（`pi.typebox`），并流经共享的校验/传输流水线。

工厂返回类型：

- `CustomTool`
- `CustomTool[]`
- `Promise<CustomTool | CustomTool[]>`

## 传递给工厂的 API 表面（`CustomToolAPI`）

来自 `types.ts` 和 `loader.ts`：

- `cwd`：宿主工作目录
- `exec(command, args, options?)`：进程执行辅助函数
- `ui`：UI 上下文（在无头模式下可能为空操作）
- `hasUI`：在非交互流程中为 `false`
- `logger`：共享的文件日志器
- `arktype`：注入的 omptype `type(...)` 构建器
- `typebox`：兼容旧式 TypeBox 风格 schema 的 shim
- `pi`：注入的 `@oh-my-pi/pi-coding-agent` 导出
- `pushPendingAction(action)`：暂存一个预览动作，最终通过向 `xd://resolve` 或 `xd://reject` 写入纯文本原因来完成

加载器以空操作的 UI 上下文启动，并要求宿主代码在真实 UI 就绪时调用 `setUIContext(...)`。如果运行时未提供 pending-action 存储，调用 `pushPendingAction` 将抛出 `Pending action store unavailable for custom tools in this runtime.`

## 执行契约与类型

`CustomTool.execute` 的签名：

```ts
execute(toolCallId, params, onUpdate, ctx, signal);
```

- `params` 通过 `Static<TParams>` 由其 omptype 或 TypeBox schema 提供静态类型。
- 运行时的参数校验会在 agent 循环中、`execute` 执行之前发生。
- `onUpdate` 用于为 UI 流式输出发送部分结果。
- `ctx` 包含 `sessionManager`、`modelRegistry`、当前的 `model`、`isIdle()`、`hasQueuedMessages()`、`abort()`，以及可选的 `settings`、`fetch`、`localProtocolOptions` 和 `autoApprove`。
- `signal` 携带取消信号，可能为 `undefined`。

会话引导桥接器将自定义工具转换为扩展的 `ToolDefinition`，并以正确的参数顺序转发调用。`CustomToolAdapter` 仍然可供那些直接将自定义工具适配为 agent 工具接口的库使用者使用。

工具定义还可以声明 `strict`、`hidden`、`loadMode`、`deferrable`、`mcpServerName`、`mcpToolName` 和 `approval`。当 `loadMode` 被省略时，自定义工具名称默认为 `"discoverable"`，但规范的必备内置工具名称（`read`、`write`、`bash`、`edit`、`glob`、`computer`、`eval`、`task`、`hub`、`learn` 和 `manage_skill`）除外，它们默认为 `"essential"`，这样包装器或重新注册就不会降级它们。显式指定的 `loadMode` 始终优先生效；要将其他任何工具保持为顶层，请使用 `"essential"`。尽管公开的 `CustomTool` 类型也声明了 `formatApprovalDetails`，但 SDK/发现桥接器不会将该回调传递到已注册的工具定义中，因此在正常的集成路径上无法自定义审批详情……

## 工具如何暴露给模型

- 会话引导将包含的 SDK 提供和发现到的自定义工具包装为扩展的工具定义；库使用者也可以直接使用 `CustomToolAdapter`。
- 它们按名称插入到会话工具注册表中。
- 在非受限的 SDK 引导中，自定义工具和扩展注册的工具会被强制包含在初始激活集合中。受限会话会排除 SDK 提供的自定义工具，除非设置 `allowRestrictedCustomTools: true`，并且只有在某个自定义工具的名称出现在 `toolNames` 中时才会将其作为已启用的工具暴露。
- 命令行 `--tools` 目前仅校验内置工具名称；自定义工具的纳入通过发现/注册路径和 SDK 选项处理。

## 渲染钩子

可选的渲染钩子：

- `renderCall(args, options, theme)`
- `renderResult(result, options, theme)`

正常的 SDK 和文件系统发现路径会将自定义工具包装为扩展。在这些路径上，`renderResult` 只会接收上述三个参数；桥接器不会转发原始的工具参数。公开的 `CustomTool` 类型为直接使用 `CustomToolAdapter` 的使用者保留了一个可选的第四个 `args` 参数。

TUI 中的运行时行为：

- 如果钩子存在，工具输出会渲染在 `Box` 容器内。
- `renderResult` 接收 `{ expanded, isPartial, spinnerFrame? }` 作为其 `options` 参数。
- 渲染器错误会被捕获并记录；UI 会回退到默认的文本渲染。

## 会话/状态处理

可选的 `onSession(event, ctx)` 接收会话生命周期事件，包括：

- `start`、`switch`、`branch`、`tree`、`shutdown`
- `auto_compaction_start`、`auto_compaction_end`
- `auto_retry_start`、`auto_retry_end`
- `ttsr_triggered`、`todo_reminder`

当分支/会话上下文发生变化时，使用 `ctx.sessionManager` 从历史中重建状态。

## 失败与取消语义

### 同步/异步失败

- 在 `execute` 中抛出（或返回 rejected promise）被视为工具失败。
- Agent 运行时将失败转换为带有 `isError: true` 和错误文本内容的工具结果消息。
- 使用扩展包装器时，`tool_result` 处理器可以进一步重写 content/details，甚至覆盖错误状态。

### 取消

- Agent 的中止会通过 `AbortSignal` 传播到 `execute`。
- 将 `signal` 转发到子进程工作（`pi.exec(..., { signal })`）以支持协作式取消。
- `ctx.abort()` 允许工具请求中止当前的 agent 操作。

### onSession 错误

- `onSession` 中的错误会被捕获并以警告形式记录；它们不会导致会话崩溃。

## 设计时需要考虑的真正约束

- 工具名称在当前激活的注册表中必须全局唯一。
- 在 `details` 中优先使用确定性、符合 schema 形状的输出，以便渲染器/状态重建。
- 使用 `pi.hasUI` 守卫 UI 相关代码。
- 将工具目录中的 `.md`/`.json` 视为元数据，而非可执行模块。
