---
name: authoring-extensions
description: Use when creating a new omp extension. Covers ExtensionAPI, factory signature, tool/command/event registration, and local-dev testing.
---

# 编写扩展

扩展是为 `oh-my-pi` 添加能力的主要方式。一个扩展模块就可以注册 LLM 可调用的工具、用户可调用的斜杠命令，以及贯穿整个会话生命周期运行的事件处理器 —— 全部集中在一个 TypeScript 文件中。其默认工厂既可以同步初始化，也可以返回 Promise。

## 最小可用扩展

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("My extension loaded!", "info");
  });
}
```

这就是一个可工作的扩展。把它放到 `~/.omp/agent/extensions/hello.ts` 并重启 omp，就能看到通知。

## 完整示例

下面的扩展注册了一个斜杠命令、一个工具以及一个 session-start 钩子：

```ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export default function myExtension(pi: ExtensionAPI) {
  const z = pi.zod;

  // Runs once when the session loads
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify(`Session ready in ${ctx.cwd}`, "info");
  });

  // Slash command: /greet
  pi.registerCommand("greet", {
    description: "Send a greeting into the conversation",
    handler: async (args, ctx) => {
      const name = args.trim() || "world";
      pi.sendMessage(
        {
          customType: "greeting",
          content: `Hello, ${name}!`,
          display: true,
          attribution: "user",
        },
        { triggerTurn: false }
      );
      ctx.ui.notify(`Greeted ${name}`, "info");
    },
  });

  // LLM-callable tool
  pi.registerTool({
    name: "word_count",
    label: "Word Count",
    description: "Count the words in a string",
    parameters: z.object({
      text: z.string().describe("Text to count"),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const count = params.text.split(/\s+/).filter(Boolean).length;
      return {
        content: [{ type: "text", text: String(count) }],
        details: { count },
      };
    },
  });
}
```

## 发现路径

omp 从以下来源加载扩展模块：

1. 通过能力系统发现的原生 `.omp` 位置：
   - `<cwd>/.omp/extensions/`
   - `~/.omp/agent/extensions/`
   - 在 `.omp/settings.json#extensions` 或 `~/.omp/agent/settings.json#extensions` 中列出的旧版扩展路径
2. 启用并已安装的插件，位于 `~/.omp/plugins/node_modules` 或项目插件根目录下 —— 包括 npm、marketplace 以及 `omp plugin link` 安装的插件 —— 通过它们的 `omp.extensions`/`pi.extensions` 清单。
3. 由 CLI 显式配置的路径（`omp --extension ./my-ext.ts`，也可用 `-e`；`--hook` 被视为别名）以及配置中 `extensions:` 设置所指定的路径。

运行时会按解析后的绝对路径去重 —— 先到先得。

用户目录是当前活跃 profile 的 agent 目录：默认为 `~/.omp/agent`，而 `omp --profile <name>` 使用 `~/.omp/profiles/<name>/agent`（并可被 `PI_CODING_AGENT_DIR` 覆盖）。

当一个路径指向目录时，omp 按以下顺序解析入口点：

1. `package.json` 中带有 `omp.extensions`（或旧版 `pi.extensions`）字段
2. `index.ts`
3. `index.js`

扫描 `extensions/` 目录时，omp 还会加载直接的 `*.ts`/`*.js` 文件，以及具有 `index.ts`、`index.js` 或清单文件的一级子目录。

扩展包也可以捆绑同级的能力目录。当一个包通过 `extensions:` 或 `--extension`/`-e` 加载时，`omp-plugins` 提供者会扫描其 `skills/`、`hooks/pre|post/`、`tools/`、`commands/`、`rules/`、`prompts/` 和 `.mcp.json`。

## package.json 清单

要将扩展打包为可安装的插件，请在 `package.json` 中添加一个 `omp` 字段：

```json
{
  "name": "my-omp-extension",
  "omp": {
    "extensions": ["./src/main.ts"]
  }
}
```

为了向后兼容，旧版 `pi` 键同样被接受：

```json
{
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

支持多个入口点：

```json
{
  "omp": {
    "extensions": ["./src/safety.ts", "./src/tools.ts"]
  }
}
```

已安装插件的清单条目可以是 `.ts`、`.js`、`.mjs` 或 `.cjs`；指向目录的清单条目会解析为 `index.ts`、`index.js`、`index.mjs` 或 `index.cjs`。对原生/已配置扩展目录的自动扫描仍仅限于 `.ts` 和 `.js`。

## 注册命令

```ts
pi.registerCommand("my-cmd", {
  description: "What the command does",
  handler: async (args, ctx) => {
    // args: everything the user typed after /my-cmd
    // ctx: ExtensionCommandContext — includes ctx.ui, ctx.cwd, session controls
    ctx.ui.notify("Running!", "info");
    await ctx.waitForIdle();
    await ctx.newSession();
  },
});
```

`ExtensionCommandContext` 的会话控制方法（仅可在命令中安全调用）：

| Method | Effect |
|---|---|
| `waitForIdle()` | Wait for the agent to finish streaming |
| `newSession(opts?)` | Open a fresh session |
| `switchSession(path)` | Switch to an existing session file |
| `branch(entryId)` | Fork from a specific history entry |
| `navigateTree(id, opts?)` | Jump to a different point in the session tree |
| `reload()` | Reload the session runtime |
| `compact(opts?)` | Compact the current context |

## 注册工具

工具由 LLM 调用。参数定义可以使用注入的、兼容 Zod 的 omptype 构建器；`pi.arktype` 以及向后兼容的 `pi.typebox` 也可用：

```ts
const z = pi.zod;

pi.registerTool({
  name: "search_notes",           // snake_case, unique
  label: "Search Notes",          // human-readable label for TUI
  description: "Full-text search through project notes",
  parameters: z.object({
    query: z.string().describe("Search query"),
    limit: z.number().default(10).optional().describe("Max results"),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    if (signal?.aborted) {
      return { content: [{ type: "text", text: "Cancelled" }] };
    }
    onUpdate?.({ content: [{ type: "text", text: "Searching..." }] });
    // ... do work ...
    return {
      content: [{ type: "text", text: `Found N results for "${params.query}"` }],
      details: { query: params.query, count: 0 },
    };
  },
});
```

工具定义还可以设置 `loadMode: "essential" | "discoverable"`（默认为 `"discoverable"`）、`approval: "read" | "write" | "exec"`（默认为 `"exec"`），以及用于 provider 结构化输出语法行为的 `strict`。

## 订阅事件

```ts
pi.on("tool_call", async (event, ctx) => {
  // event.toolName, event.input, event.toolCallId
  if (event.toolName !== "bash") return;

  const command = String((event.input as { command?: unknown }).command ?? "");
  if (command.includes("rm -rf /")) {
    return { block: true, reason: "Blocked by safety policy" };
  }
});

pi.on("turn_end", async (_event, ctx) => {
  ctx.ui.setStatus("tokens", `~${ctx.getContextUsage()?.tokens ?? "?"} tokens`);
});

pi.on("session_stop", async (event) => {
  if (event.stop_hook_active) return;
  return { continue: true, additionalContext: `Review final status after turn ${event.turn_id}.` };
});
```

完整事件目录：参见 [extension authoring guide](../extensions.md)。

## 扩展 vs 钩子 —— 何时使用哪个

| Need | Use |
|---|---|
| Tools + commands + events in one module | **Extension** (`ExtensionAPI`) |
| Pure event interception (policy, redaction) | **Extension** or **Hook** (both work; extension is preferred) |
| Legacy hook module already exists | **Hook** (`HookAPI` from `@oh-my-pi/pi-coding-agent/extensibility/hooks`) |
| Registering a provider, shortcut, or CLI flag | **Extension only** |
| Shipping as a marketplace plugin | **Extension** (use `package.json` manifest) |

扩展是钩子的严格超集。新的编写工作应使用 `ExtensionAPI`。

## 调试

omp 将结构化日志写入当前 state root 的 `logs/` 目录（默认为 `~/.omp/logs/`；调试级别始终开启，且不会向控制台写入任何内容，因为这会破坏 TUI）。每个文件名都包含进程 ID。跟踪当天的默认 profile 日志可查看扩展加载诊断信息：

```
tail -f ~/.omp/logs/omp.$(date +%F).*.log
```

扩展加载失败时会连同其路径和错误一起记录。已加载的扩展也可以通过 `pi.logger` 输出它们自己的调试日志。

要按名称临时禁用某个特定的扩展模块而无需移除文件：

```yaml
# ~/.omp/agent/config.yml
disabledExtensions:
  - extension-module:my-ext
```

派生的名称是文件名的词干（对于 `index.ts` 形式的条目则是目录名）：`/path/to/my-ext.ts` → `my-ext`。

## 重要约束

- **不要在加载期间调用运行时操作。** 像 `pi.sendMessage()` 这样的方法如果在模块求值期间（活动会话开始之前）同步调用，会抛出 `ExtensionRuntimeNotInitializedError`。在加载期间注册处理器/工具/命令；运行时操作仅在事件处理器、工具或命令中执行。
- **`tool_call` 错误是 fail-closed 的。** 如果 `tool_call` 处理器抛出异常，该工具将被阻止。
- **自调度回调在没有隔离的情况下与进程内运行。** 一个抛出异常的原生 `setInterval`/`setTimeout`/分离的 Promise 回调会逃出处理器分发的 try/catch，并使整个会话崩溃（`uncaughtException`）。后台工作请使用 `ctx.setInterval` / `ctx.setTimeout` —— 它们会捕获回调中的异常，并在 `session_shutdown` 时自动清理。对于原生定时器，你必须自行添加 `try/catch` 和清理逻辑。
- **命令名不能与内建命令冲突。** 冲突会以诊断日志形式被跳过。
- **保留的快捷键会被忽略**（`ctrl+c`、`ctrl+d`、`ctrl+z`、`ctrl+k`、`ctrl+p`、`ctrl+l`、`ctrl+o`、`ctrl+t`、`ctrl+g`、`ctrl+q`、`alt+m`、`alt+p`、`shift+tab`、`shift+ctrl+p`、`alt+enter`、`escape`、`enter`）。

## 进一步阅读

- `docs/extensions.md` — 运行时内部细节与完整 API 参考
- `docs/extension-loading.md` — 详细的路径解析规则
- `docs/hooks.md` — 钩子子系统内部细节
- `docs/skills/examples/hello-extension/` — 完整可运行的示例
