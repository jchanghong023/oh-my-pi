# debug

> 驱动一个 DAP 调试会话；相邻的调试 UI 代码复用同一子系统来处理日志、原始 SSE 捕获、报告、性能分析与系统诊断。

## 源码
- 入口：`packages/coding-agent/src/tools/debug.ts`
- 模型侧提示词：`packages/coding-agent/src/prompts/tools/debug.md`
- 关键协作模块：
  - `packages/coding-agent/src/dap/session.ts` — 会话生命周期、断点/状态缓存
  - `packages/coding-agent/src/dap/client.ts` — 适配器进程/套接字传输、DAP 消息循环
  - `packages/coding-agent/src/dap/config.ts` — 适配器解析与自动选择
  - `packages/coding-agent/src/dap/defaults.json` — 内置适配器定义
  - `packages/coding-agent/src/dap/types.ts` — request/response/capability 结构
  - `packages/coding-agent/src/tools/tool-timeouts.ts` — 单工具超时钳制
  - `packages/coding-agent/src/debug/index.ts` — 交互式调试选择器菜单
  - `packages/tui/src/apps/debug/log-viewer.ts` — 最近日志 TUI 查看器
  - `packages/tui/src/apps/debug/raw-sse.ts` — 原始 SSE TUI 查看器
  - `packages/tui/src/apps/debug/raw-sse-buffer.ts` — 有界 SSE 捕获缓冲
  - `packages/coding-agent/src/debug/remote-debugger.ts` — 一次性 JavaScriptCore 远程检查器套接字
  - `packages/coding-agent/src/debug/profiler.ts` — CPU/堆性能分析辅助
  - `packages/coding-agent/src/debug/report-bundle.ts` — `.tar.gz` 报告打包、日志源、缓存清理
  - `packages/coding-agent/src/debug/system-info.ts` — 系统快照采集与环境变量脱敏
  - `packages/tui/src/apps/debug/terminal-info.ts` — 终端状态采集/格式化
  - `packages/tui/src/apps/debug/protocol-probe.ts` — 终端协议探测面板与示例图

## 输入

| 字段 | 类型 | 必填 | 描述 |
| --- | --- | --- | --- |
| `action` | `"launch" \| "attach" \| "set_breakpoint" \| "remove_breakpoint" \| "set_instruction_breakpoint" \| "remove_instruction_breakpoint" \| "data_breakpoint_info" \| "set_data_breakpoint" \| "remove_data_breakpoint" \| "continue" \| "step_over" \| "step_in" \| "step_out" \| "pause" \| "evaluate" \| "stack_trace" \| "threads" \| "scopes" \| "variables" \| "disassemble" \| "read_memory" \| "write_memory" \| "modules" \| "loaded_sources" \| "custom_request" \| "output" \| "terminate" \| "sessions"` | 是 | `packages/coding-agent/src/tools/debug.ts` 中工具 switch 的派发键。 |
| `program` | `string` | 否 | 启动目标路径。`launch` 必填。若提供了 `cwd` 则相对其解析，否则相对会话 cwd 解析。 |
| `args` | `string[]` | 否 | `launch` 的程序 argv。 |
| `adapter` | `string` | 否 | 显式的适配器名称。否则由 `packages/coding-agent/src/dap/config.ts` 中的 `selectLaunchAdapter()` / `selectAttachAdapter()` 自动选取。 |
| `cwd` | `string` | 否 | 启动/附加的工作目录。默认为会话 cwd。 |
| `file` | `string` | 否 | 源码断点使用的源文件路径。 |
| `line` | `number` | 否 | 源码断点使用的源行号。 |
| `function` | `string` | 否 | 函数断点名称。提供该字段时，断点类操作走函数路径并忽略 `file`/`line`；schema 不会拒绝同时给出这两种形式。 |
| `name` | `string` | 否 | 数据断点信息的目标名称。`data_breakpoint_info` 必填。 |
| `condition` | `string` | 否 | 源码/函数/指令/数据断点的条件表达式。 |
| `hit_condition` | `string` | 否 | 指令/数据断点的命中次数条件。 |
| `expression` | `string` | 否 | 表达式或原始调试器命令。`evaluate` 必填。 |
| `context` | `string` | 否 | 求值上下文。默认为 `"repl"`，作为 DAP evaluate context 原样透传。 |
| `frame_id` | `number` | 否 | `evaluate`、`scopes`、`data_breakpoint_info` 的帧选择器。省略时，`scopes` 与 `evaluate` 默认使用当前停止帧。 |
| `scope_id` | `number` | 否 | 来自某个 scope 的 variables 引用。`variables` 接受该字段；也作为 `data_breakpoint_info` 的备选 variables 引用。 |
| `variable_ref` | `number` | 否 | `variables` 的 variables 引用；两者同时提供时优先于 `scope_id`。 |
| `pid` | `number` | 否 | `attach` 的本地进程 id。仅在未显式选择适配器时，才与 `port` 一起构成必填。 |
| `port` | `number` | 否 | 远程附加端口。若未强制指定适配器，则提供 `port` 时 attach 优先选择 `debugpy`。 |
| `host` | `string` | 否 | `attach` 的远程附加主机。 |
| `levels` | `number` | 否 | `stack_trace` 的最大栈帧数。 |
| `memory_reference` | `string` | 否 | `disassemble`、`read_memory`、`write_memory` 的内存引用/地址。提供时 `disassemble` 使用该字段；否则在适配器提供了当前停止位置的指令指针引用时回退到该引用。 |
| `instruction_reference` | `string` | 否 | 指令断点引用；指令断点类操作必填。`disassemble` 不使用该字段。 |
| `instruction_count` | `number` | 否 | `disassemble` 必填。 |
| `instruction_offset` | `number` | 否 | `disassemble` 的指令偏移。 |
| `count` | `number` | 否 | `read_memory` 的字节数。该操作必填。 |
| `data` | `string` | 否 | `write_memory` 的 base64 负载。该操作必填。 |
| `data_id` | `string` | 否 | 数据断点 id。`set_data_breakpoint` / `remove_data_breakpoint` 必填。 |
| `access_type` | `"read" \| "write" \| "readWrite"` | 否 | `set_data_breakpoint` 的访问过滤。 |
| `command` | `string` | 否 | 自定义 DAP 请求命令。`custom_request` 必填。 |
| `arguments` | `Record<string, unknown>` | 否 | `custom_request` 的自定义 DAP 请求体。 |
| `offset` | `number` | 否 | 指令断点、反汇编、内存读、内存写的偏移量。 |
| `resolve_symbols` | `boolean` | 否 | `disassemble` 的符号解析标志。 |
| `allow_partial` | `boolean` | 否 | `write_memory` 是否允许部分写入。 |
| `start_module` | `number` | 否 | `modules` 分页的起始索引。 |
| `module_count` | `number` | 否 | `modules` 分页的条数。 |
| `timeout` | `number` | 否 | 单次请求的秒数，默认 `30`；`clampTimeout("debug", ...)` 先应用正数 `tools.maxTimeout` 上限，再应用工具自身的 `5..300` 区间（因此 5 秒下限仍优先于更低的全局上限）。 |

### 各 action 的必填项
- `launch`：`program`
- `attach`：`pid` 或 `port`，除非显式指定的适配器自带 attach 参数
- `set_breakpoint` / `remove_breakpoint`：`function`，或 `file` + `line`
- `set_instruction_breakpoint` / `remove_instruction_breakpoint`：`instruction_reference`
- `data_breakpoint_info`：`name`
- `set_data_breakpoint` / `remove_data_breakpoint`：`data_id`
- `evaluate`：`expression`
- `variables`：`variable_ref` 或 `scope_id`
- `disassemble`：能力 `supportsDisassembleRequest`，外加 `instruction_count`，以及 `memory_reference` 或带 `instructionPointerReference` 的当前停止位置
- `read_memory`：能力 `supportsReadMemoryRequest`，外加 `memory_reference` 和 `count`
- `write_memory`：能力 `supportsWriteMemoryRequest`，外加 `memory_reference` 和 `data`
- `modules`：能力 `supportsModulesRequest`
- `loaded_sources`：能力 `supportsLoadedSourcesRequest`
- `custom_request`：`command`

### 交互式选择器取值
`packages/coding-agent/src/debug/index.ts` 还暴露一个仅限 UI 的固定选择器，取值为 `open-artifacts`、`performance`、`work`、`dump`、`memory`、`logs`、`system`、`terminal`、`protocols`、`raw-sse`、`remote-debugger`、`transcript`、`clear-cache`。这些取值不能通过 `debugSchema` 被模型调用；它们是本地 TUI 菜单路由。

## 输出
该 agent 工具从 `packages/coding-agent/src/tools/debug.ts` 返回标准的 `toolResult()` 负载：
- `content`：一个文本块。每个 action 都渲染为人类可读文本；`content` 中不包含结构化 JSON 块。
- `details.action`：回显的 action。
- `details.success`：始终初始化为 `true`；失败会在返回结果之前抛出。
- `details.snapshot`：对于操作或创建会话的 action 存在，使用 `packages/coding-agent/src/dap/types.ts` 中的 `DapSessionSummary`。
- 各 action 专属的 `details` 字段：
  - `launch` / `attach`：`adapter`
  - 断点类 action：`breakpoints`、`functionBreakpoints`、`instructionBreakpoints`、`dataBreakpoints`
  - `data_breakpoint_info`：`dataBreakpointInfo`
  - `continue` / `step_*`：`state`、`timedOut`
  - `threads`：`threads`
  - `stack_trace`：`stackFrames`
  - `scopes`：`scopes`
  - `variables`：`variables`
  - `evaluate`：`evaluation`
  - `disassemble`：`disassembly`
  - `read_memory`：`memoryAddress`、`memoryData`、`unreadableBytes`
  - `write_memory`：`bytesWritten`
  - `modules`：`modules`
  - `loaded_sources`：`sources`
  - `custom_request`：`customBody`
  - `output`：`output`
  - `sessions`：`sessions`

流式/UI 行为：
- 该可发现工具的渲染器会合并调用与结果（`mergeCallAndResult: true`），以内联方式渲染，并在参数/结果仍在组装期间启用动画化的部分结果展示。
- `debug.ts` 自身不通过 `_onUpdate` 发送进度更新；执行结果的投递是一次性的。
- 审批按 action 区分：只读 action（`output`、`threads`、`stack_trace`、`scopes`、`variables`、`disassemble`、`read_memory`、`loaded_sources`、`modules`、`sessions`）请求读审批；其他所有 action 请求执行审批。
- 交互式选择器由 UI 驱动而非模型驱动。它会切换 TUI 组件、向聊天面板追加状态行、用外部查看器打开文件、写入归档/临时文件，或启动进程级 JavaScriptCore 检查器套接字。

模型工具结果之外的旁路产物：
- `createReportBundle()` 在 reports 目录下写入 `omp-report-<timestamp>.tar.gz`，并把文件系统路径返回给 UI 处理器。
- `#handleWorkReport()` 在打开之前先写入 `/tmp/work-profile-<Date.now()>.svg`。
- `RawSseViewerComponent` 与 `DebugLogViewerComponent` 可以把捕获的文本复制到剪贴板。

## 流程

1. 工具注册是有条件的：`packages/coding-agent/src/tools/debug.ts` 中的 `DebugTool.createIf()` 除非 `session.settings.get("debug.enabled")` 为 true（默认 `true`），否则返回 `null`。`packages/coding-agent/src/tools/index.ts` 接入该工厂，并在工具过滤中再次检查同一设置。
2. `DebugTool.execute()` 通过 `clampTimeout("debug", params.timeout)` 钳制 `params.timeout`，先应用可选的正数 `tools.maxTimeout` 上限，再应用工具自身的 5 秒下限与 300 秒上限，并把调用方 `AbortSignal` 与 `AbortSignal.timeout(...)` 组合起来。
3. `launch` 解析 cwd/program 路径，把目标归类为文件/目录/缺失，除非所选适配器设置了 `acceptsDirectoryProgram` 否则拒绝目录，并委托给 `dapSessionManager.launch()`。`attach` 解析 cwd 并选择适配器；只有在没有显式适配器时才要求 `pid` 或 `port`。
4. `DapSessionManager.launch()` / `.attach()` 强制只存在一个根会话，通过 `DapClient.spawn()` 启动适配器，注册监听器，发送 `initialize`，缓存 capabilities，订阅整棵树的停止事件，发送 `launch`/`attach`，然后完成 `initialized` → `configurationDone` 握手。
5. `DapClient.spawn()` 以 `NON_INTERACTIVE_ENV` 分离启动适配器。`stdio` 使用适配器管道；`socket` 在 Linux 上使用 Unix 套接字，在其他平台使用适配器回调到本地 TCP 监听器；`tcp` 替换适配器参数中的 `${port}`，启动本地服务器后再连接。子会话通过 `DapClient.connect()` 复用根 `tcp` 服务器。
6. `packages/coding-agent/src/dap/session.ts` 中的 `#registerSession()` 安装反向请求处理器：
   - `runInTerminal`：通过 `ptree.spawn()` 以分离方式启动请求的 debuggee 命令，并返回 `{ processId }`
   - `startDebugging`：把子 DAP 客户端连接到根 TCP 服务器，转发请求的 `launch`/`attach` 配置，在 `configurationDone` 之前绑定根断点，并递归安装同样的处理器
   - 事件：`output`、`initialized`、`stopped`、`continued`、`exited` 与 `terminated` 更新缓存的会话状态；停止的子会话成为活动目标
7. 操作类 action（`set_breakpoint`、`evaluate`、`threads`、`read_memory`、`custom_request` 等）调用 `dapSessionManager` 方法。多数走 `#sendRequestWithConfig()`，该方法在需要时先发送 `configurationDone`，再发送 DAP 请求，并刷新活动会话及其所有祖先。
8. 断点类 action 在活动的根/子树间同步期望的断点集合。新创建的子会话在自身的 `configurationDone` 请求之前收到这些集合。
9. `continue` 与三个 step action 会清空缓存的停止状态，在发送 DAP 请求之前订阅会话树内任意位置的停止/终止事件，随后 `#awaitStopOutcome()` 返回活动子会话的停止位置，或报告目标在超时后仍在运行。
10. `pause` 发送 DAP `pause`，必要时等待 stopped 事件；若程序已经停止，则复用缓存的停止状态。
11. `stack_trace`、`scopes`、`variables`、`evaluate` 在调用方省略 id 且有可用缓存状态时，默认使用当前停止的子会话/线程/帧。
12. `output` 读取活动 `DapSession` 的内存输出环形缓冲。`terminate` 从根会话遍历每个子会话，尽力发送 `terminate`/`disconnect`，即便某个适配器超时也会释放整棵树。
13. `sessions` 读取管理器当前的映射并格式化根与子会话摘要。同一时间只能存在一棵根会话树；适配器请求的递归子会话通过 `parentSessionId` / `childSessionIds` 跟踪。
14. `packages/coding-agent/src/debug/index.ts` 中的交互式选择器构造一个固定取值的 `SelectList`，并把每个取值分派到对应处理器：
   - `performance`：`startCpuProfile()`，等待 Enter/Escape，停止 profiling，用 `getWorkProfile(30)` 读取 30 秒的 work profile，再通过 `createReportBundle()` 打包
   - `work`：读取 `getWorkProfile(30)`，写入临时 SVG，用外部程序打开
   - `dump`：立即创建一份 report bundle
   - `memory`：强制 GC，用 `collectMemoryStats()` 收集数值形式的进程与堆统计信息，然后打包
   - `logs`：构造一个 `DebugLogSource` 并挂载 `DebugLogViewerComponent`
   - `raw-sse`：从会话解析出 `RawSseDebugBuffer` 并挂载 `RawSseViewerComponent`
   - `remote-debugger`：复用或启动一个回环 JavaScriptCore `RemoteInspectorServer` 套接字并展示其 host/port；该 Bun API 属于进程级，没有停止操作
   - `system`：调用 `collectSystemInfo()`，并把 `formatSystemInfo()` 渲染到聊天面板
   - `terminal`：`collectTerminalState()` + `formatTerminalState()` 渲染到聊天面板
   - `protocols`：除非被抑制，先触发一次桌面通知测试，然后挂载带示例图的 `ProtocolProbeComponent`
   - `open-artifacts`：若存在则打开当前会话的产物目录
   - `transcript`：委派给 `ctx.handleDebugTranscriptCommand()`
   - `clear-cache`：显示确认后，用 `clearArtifactCache()` 删除早于 30 天的产物目录

## 模式 / 变体
- **可用性开关**
  - 当 `debug.enabled` 为 false 时工具隐藏；该设置默认为 `true`。该工具使用可发现加载与排他并发。
- **适配器选择**
  - 内置适配器 id 为 `gdb`、`lldb-dap`、`codelldb`、`debugpy`、`dlv`、`js-debug-adapter`、`netcoredbg`、`kotlin-debug-adapter`、`rdbg`、`php-debug-adapter`、`bash-debug-adapter`、`dart-debug-adapter`、`flutter-debug-adapter` 与 `elixir-ls-debugger`。自动选择只考虑其配置命令可解析的适配器；显式选择某个已配置但不可用的适配器时，会产生针对该适配器的安装/配置错误。
  - `launch`：显式 `adapter` 优先；否则 `selectLaunchAdapter()` 按扩展名匹配、根标记匹配，再对无扩展名的二进制优先选用原生调试器（`gdb`、`lldb-dap`）的顺序排序可用适配器。
  - `attach`：显式 `adapter` 优先；否则远程 `port` 优先选 `debugpy`，其次是原生调试器，再其次是首个可用适配器。
- **自定义适配器配置**
  - 可通过 `dap.json`、`.dap.json`、`dap.yaml`、`.dap.yaml`、`dap.yml` 或 `.dap.yml` 添加或覆盖调试适配器。
  - 搜索顺序与 LSP 配置一致：项目根、项目配置目录（`.omp/`、`.claude/`、`.codex/`、`.gemini/`）、用户配置目录（`~/.omp/agent/`、`~/.claude/`、`~/.codex/`、`~/.gemini/`）、插件根，最后回退到 home 根。文件按从低到高的优先级合并。
  - 配置形态可以是 `{ "adapters": { ... } }`，也可以是顶层的适配器映射。
  - 适配器字段：
    - `command`：可执行文件名称或路径。必填。
    - `args`：适配器 argv。
    - `languages`：展示/过滤元数据。
    - `fileTypes`：小写文件扩展名，用于 launch 自动选择。
    - `rootMarkers`：用于为项目中的适配器排序的文件/目录。
    - `launchDefaults`：默认 DAP launch 参数，在所选 program/cwd/args 之前合并。
    - `attachDefaults`：默认 DAP attach 参数。显式适配器可以在没有 PID 或 port 的情况下 attach；参数由该适配器自行校验。
    - `connectMode`：`"stdio"`（默认）、`"socket"`（Delve 风格的平台相关套接字/回调），或 `"tcp"`（启动本地 DAP 服务器，并把 `${port}` 替换进 `args`）。
    - `acceptsDirectoryProgram`：对于像 `dlv` 这样可以启动包/项目目录的适配器，设为 `true`。

示例 `.omp/dap.json`：

```json
{
  "adapters": {
    "custom-jvm": {
      "command": "kotlin-debug-adapter",
      "args": ["--stdio"],
      "languages": ["java", "kotlin"],
      "fileTypes": [".java", ".kt", ".kts"],
      "rootMarkers": ["pom.xml", "build.gradle", "build.gradle.kts"],
      "launchDefaults": {
        "request": "launch",
        "projectRoot": "."
      },
      "attachDefaults": {
        "request": "attach",
        "host": "127.0.0.1"
      }
    }
  }
}
```

OpenOCD 远程目标的 GDB 示例：

```json
{
  "adapters": {
    "pico-openocd": {
      "command": "gdb",
      "args": [
        "-q",
        "-ex",
        "file zig-out/firmware/gc9a01-test.elf",
        "-i",
        "dap"
      ],
      "attachDefaults": {
        "target": ":3334"
      }
    }
  }
}
```
- **传输**
  - `stdio`：直接使用适配器的 `stdin`/`stdout` 帧传输。
  - `socket`：Linux 上使用 Unix 域套接字；macOS/其他平台使用适配器回调到本地 TCP 监听器。
  - `tcp`：预留一个回环端口，用它替换适配器参数中的 `${port}`，等待适配器开始监听后连接。解析出的 JavaScript/TypeScript 适配器使用该方式，且递归的 `startDebugging` 子会话也需要它。
- **DAP agent 工具 action**
  - `launch` — 启动适配器，初始化会话，可能停在入口；返回格式化后的会话快照与 `details.adapter`。
  - `attach` — 连接到活动进程或远程端口；输出结构与 `launch` 相同。
  - `set_breakpoint` — 源码或函数断点的添加/更新；返回该目标当前的断点列表。
  - `remove_breakpoint` — 源码或函数断点的移除；返回剩余的断点列表。
  - `set_instruction_breakpoint` / `remove_instruction_breakpoint` — 要求 `supportsInstructionBreakpoints`；返回当前的指令断点列表。
  - `data_breakpoint_info` — 要求 `supportsDataBreakpoints`；为 `name` 向适配器询问 `dataId`、访问类型与描述。
  - `set_data_breakpoint` / `remove_data_breakpoint` — 要求 `supportsDataBreakpoints`；返回缓存的数据断点列表。
  - `continue` / `step_over` / `step_in` / `step_out` — 返回描述执行是停止、终止还是继续运行的文本，外加 `details.state` 与 `details.timedOut`。
  - `pause` — 中断运行中的目标并返回停止快照。
  - `evaluate` — 适配器表达式求值；上下文默认为 `repl`。
  - `stack_trace` — 获取解析出的线程的栈帧。
  - `threads` — 获取当前线程。
  - `scopes` — 显式 `frame_id` 或当前停止帧的 frame scopes。
  - `variables` — `variable_ref` 或 `scope_id` 对应的变量。
  - `disassemble` — 要求 `supportsDisassembleRequest`；围绕 `memory_reference` 反汇编，或在未提供内存引用时围绕当前停止位置的指令指针反汇编。
  - `read_memory` — 要求 `supportsReadMemoryRequest`；返回地址、base64 数据与不可读字节数。
  - `write_memory` — 要求 `supportsWriteMemoryRequest`；写入 base64 数据并报告已写入的字节数。
  - `modules` — 要求 `supportsModulesRequest`；可通过 `start_module` / `module_count` 可选分页。
  - `loaded_sources` — 要求 `supportsLoadedSourcesRequest`；返回已加载源的描述符。
  - `custom_request` — 以任意参数发送任意 DAP 请求名。
  - `output` — 转储会话缓存中捕获的 stdout/stderr/console 文本。
  - `terminate` — 断开并释放活动会话；不存在会话时返回 `No debug session to terminate.`。
  - `sessions` — 列出所有缓存的会话摘要。
- **交互式选择器路由（仅 UI）**
  - `logs` — 把当天的日志尾部以及可选的更早按日日志文件加载进 `DebugLogViewerComponent`；支持复制、区间选择、pid 过滤、加载更早内容。
  - `raw-sse` — 对会话的 `RawSseDebugBuffer` 做实时查看；支持尾部跟随、滚动、全部复制。
  - `remote-debugger` — 在 `127.0.0.1` 与一个自动预留的端口上启动或复用进程级 JavaScriptCore WebKit 检查器；它是实验性的，无法停止/重新绑定，且需要兼容的 Safari/WebKit 检查器客户端。
  - `performance` — CPU profile + 30 秒 work profile + 报告打包。
  - `memory` — 数值形式的内存统计（`memory.json`）+ 报告打包。
  - `dump` — 不含 profiler 产物的报告打包。
  - `work` — 独立导出/打开 work profile 火焰图。
  - `system` — 格式化后的 OS/arch/CPU/内存/版本/cwd/shell/终端转储。
  - `terminal` — 格式化后的终端子协议/几何尺寸/回滚状态转储。
  - `protocols` — 终端协议测试：桌面通知副作用，外加一个采样特殊协议的探测面板。
  - `open-artifacts` / `transcript` / `clear-cache` — 打开产物目录、导出 transcript、清理产物缓存。

## 副作用
- 文件系统
  - 相对于会话 cwd 解析 program/file/cwd 路径。
  - 报告创建会写入 `.tar.gz` 归档，并可能读取会话 JSONL、产物文件、子 agent 会话 JSONL 与日志文件。
  - 内存报告只包含数值形式的进程/堆计数器，不含堆快照或运行时派生的类型名。会话数据、产物、日志、设置、raw SSE 诊断信息以及环境值仍可能包含私有数据；共享前请检查归档。环境脱敏匹配的是变量名，而不是值中的任意机密。
  - 含 `heap.heapsnapshot` 的旧内存报告必须按含凭据文件对待。不要共享它们；若已共享，请吊销或轮换被暴露的 provider 与 MCP 凭据（包括 OAuth 刷新令牌），并删除已共享的副本。
  - Work profile 导出会写入 `/tmp/work-profile-<timestamp>.svg`。
  - 日志源从 logs 目录读取按日切分的日志文件。
  - 产物缓存清理会删除早于截止时间的会话产物目录。
  - `resolveRawSseDebugBuffer()` 在 owner 上存在显式 `rawSseDebugBuffer` 属性时复用该属性，否则以私有 `Symbol("debug.rawSseBuffer")` 键缓存一个 buffer（owner 不可扩展时静默跳过）。
- 网络
  - Socket/TCP 模式的适配器会绑定或连接本地套接字；远程 attach 可能经由适配器连接到远程调试端口。
  - 仅限 UI 的 `remote-debugger` 路由会在随机预留的 `127.0.0.1` TCP 端口上打开一个进程级 JavaScriptCore 检查器。它会探测套接字是否就绪，且没有停止操作。
- 子进程 / 原生绑定
  - 以分离方式启动调试适配器（`gdb`、`lldb-dap`、`python -m debugpy.adapter`、`dlv` 以及来自 `defaults.json` 的其他适配器）。
  - 反向 DAP `runInTerminal` 请求通过 `ptree.spawn()` 以分离方式启动 debuggee。
  - `getWorkProfile(30)` 来自 `@oh-my-pi/pi-natives`。
  - CPU profiling 使用 `node:inspector/promises`；内存统计在 GC 之后使用 `process.memoryUsage()` 与 `bun:jsc` 的 `heapStats()` 提供的数值计数器；raw/log 查看器通过 `@oh-my-pi/pi-utils` 的 `sanitizeText()` 净化文本。
  - `openPath()` 为产物目录和 SVG 启动操作系统默认的文件/浏览器处理器。
  - Log/raw-SSE 查看器可以调用 `copyToClipboard()`。
- 会话状态（transcript、memory、jobs、checkpoints、registry）
  - `DapSessionManager` 在内存中保存会话摘要、断点、线程、栈帧、停止位置、输出捕获、capabilities 与最近使用时间戳。
  - 活动会话 id 是单例 `dapSessionManager` 的全局值。
  - `RawSseDebugBuffer` 按 owner/会话存储最近的 SSE 事件。
  - `remote-debugger.ts` 缓存活动的检查器端点并合并并发启动；底层 Bun 检查器对该进程是单向的。
  - 该工具为 `exclusive`；调度器会阻塞并发的 debug 工具调用。
- 用户可见提示 / 交互式 UI
  - 调试选择器在删除缓存前显示确认。
  - Performance profiling 期间会临时接管编辑器的 Enter/Escape 处理器，直到 profiling 停止。
  - Log/raw-SSE 查看器会用自定义组件替换编辑器面板。
- 后台工作 / 取消
  - 每个 DAP 请求都接受 `AbortSignal`；超时和调用方取消会中止当前请求，而不是整个会话生命周期。
  - `DapSessionManager` 每 30 秒运行一次后台清理循环。
  - Raw SSE 查看器会订阅 buffer 更新，直到关闭。

## 限制与上限
- 工具超时钳制：`packages/coding-agent/src/tools/tool-timeouts.ts` 中的 `default=30`、`min=5`、`max=300`。
- 单次 DAP 请求默认超时：`packages/coding-agent/src/dap/client.ts` 中的 `DEFAULT_REQUEST_TIMEOUT_MS = 30_000`。
- 单一活动会话：由 `packages/coding-agent/src/dap/session.ts` 中的 `#ensureLaunchSlot()` 强制。
- 空闲会话清理：`IDLE_TIMEOUT_MS = 10 * 60 * 1000`，每 `CLEANUP_INTERVAL_MS = 30 * 1000` 检查一次。
- 适配器存活心跳：`HEARTBEAT_INTERVAL_MS = 5 * 1000`。
- 输出捕获上限：`MAX_OUTPUT_BYTES = 128 * 1024`；整块从头部丢弃（随后对最前一块按字节切片，以恰好保留上限），并记录 `outputTruncated`。
- 启动/附加后首次停止捕获超时：`STOP_CAPTURE_TIMEOUT_MS = 5_000`。
- Socket 模式适配器就绪超时：`packages/coding-agent/src/dap/client.ts` 中 `waitForCondition()` 与 TCP 连接超时逻辑中的 `10_000` ms。
- `packages/tui/src/apps/debug/raw-sse-buffer.ts` 中的 raw SSE 缓冲上限：
  - `MAX_RAW_SSE_EVENTS = 1_000`
  - `MAX_RAW_SSE_CHARS = 512_000`
  - 每个事件 `MAX_RAW_SSE_EVENT_CHARS = 64_000`；超出预算的事件先压缩 `tools` schema（保留名称，省略 schema/description），再做 head+tail 裁剪：保留首尾两段，中间插入 `: omp-debug-elided chars=...` 注释，末尾追加 `: omp-debug-truncated originalChars=...` 标记
- `packages/tui/src/apps/debug/log-viewer.ts` 中的日志查看窗口：
  - `INITIAL_LOG_CHUNK = 50`
  - `LOAD_OLDER_CHUNK = 50`
- `packages/coding-agent/src/debug/report-bundle.ts` 中的报告/日志摄取上限：
  - 交互式日志读取的 `MAX_LOG_LINES = 5000`
  - 尾部读取上限 `MAX_LOG_BYTES = 2 * 1024 * 1024`
  - 报告归档只包含最后 `1000` 行日志
  - 子 agent 会话的纳入数量上限为最近的 `10` 个 JSONL 文件
- `packages/coding-agent/src/debug/index.ts` 中的交互式 profiling 窗口：performance 与 work 报告都请求 `getWorkProfile(30)`。
- 产物缓存清理默认值：`clearArtifactCache()` 与选择器确认文本中均为 `30` 天。

## 错误
- `packages/coding-agent/src/tools/debug.ts` 中的参数校验会抛出带明确消息的 `ToolError`，例如：
  - `program is required for launch`
  - 未选择显式适配器时：`attach requires pid or port`
  - `set_breakpoint requires file+line or function`
  - `variables requires variable_ref or scope_id`
  - `instruction_count is required for disassemble`
  - `disassemble requires memory_reference unless the current stop location has an instruction pointer reference`
  - `memory_reference is required for read_memory`
  - `count is required for read_memory`
  - `data is required for write_memory`
  - 所选适配器未设置 `acceptsDirectoryProgram` 时：`launch program resolves to a directory: <path>...`
  - `command is required for custom_request`
- 适配器选择失败会抛出 `No debugger adapter available. Installed adapters: ...`。
- 受能力限制的 action 通过 `requireCapability(...)` 抛出，例如 `Current adapter does not support memory reads`。
- 无会话与状态相关错误来自 `DapSessionManager`，例如 `No active debug session. Launch or attach first.`、`No active stack frame. Run stack_trace first or supply frame_id.`、`Debugger reported no threads.`
- 启动第二个活动会话会抛出 `Debug session <id> is still active. Terminate it before launching another.`
- DAP 传输/请求失败以 `DapClient` 抛出的错误形式呈现：
  - `DAP request <command> timed out after <ms>ms`
  - `DAP event <event> timed out after <ms>ms`
  - `DAP adapter <name> is not running`
  - `DAP adapter exited (code N): <stderr>` 或 `DAP adapter exited unexpectedly (code N)`
  - DAP 请求失败时适配器响应中的 `message`
- 目标在超时后仍保持运行时，`continue` / `step_*` 有意不视为致命：它们返回 `details.timedOut = true` 与 `state: "running"`，而不是抛出。
- `terminate` 在发送 `terminate`/`disconnect` 期间抑制适配器错误；它仍会释放客户端，并在可能时返回最后一份摘要。
- 交互式选择器处理器上报 UI 错误，而不是抛出：
  - profiler 启停、报告打包、日志读取、system-info 采集、缓存清理、产物打开以及远程检查器启动使用 `ctx.showError(...)` / `ctx.showWarning(...)`
  - 空日志与空产物缓存是 warning/status 消息，不是失败
  - log/raw-SSE 查看器中的复制失败会成为 UI 中的 status/error 文本
- report-bundle 辅助函数对许多文件读取有意采用尽力而为策略：缺失的会话文件、缺失的产物目录、不可读的产物文件、缺失的日志目录、不可访问的缓存目录以及缺失的子 agent 文件都会被静默跳过。
- `collectSystemInfo()` 对 CPU 探测采用尽力而为策略；该处失败时回退为 `Unknown CPU`。
- 远程检查器启动会拒绝已被占用的端口，若所选回环套接字在探测截止时间内仍不可达则失败。UI 会将其上报为 `Failed to start remote debugger: ...`。

## 备注
- `packages/coding-agent/src/prompts/tools/debug.md` 告知模型只支持一个活动根会话。适配器请求的子会话归属于该根树。
- 默认的 JavaScript/TypeScript 适配器通过 TCP 运行 vscode-js-debug 的 `dapDebugServer.js`。可通过以下方式之一安装；第一种与最后一种由 `packages/coding-agent/src/dap/config.ts` 中的 `resolveJsDebugServerPath()` 自动发现。（不要尝试 `npm i -g js-debug-adapter`——它会 404；`js-debug-adapter` 是 omp 的适配器 id，不是 npm 包。）
  - 发行版 tarball，解压后使 `dapDebugServer.js` 落在 `~/.local/opt/js-debug/src/dapDebugServer.js`：
    ```sh
    curl -sL -o js-debug-dap.tar.gz \
      https://github.com/microsoft/vscode-js-debug/releases/download/v1.117.0/js-debug-dap-v1.117.0.tar.gz
    mkdir -p ~/.local/opt && tar -xzf js-debug-dap.tar.gz -C ~/.local/opt
    ```
    把 `v1.117.0` 替换为 [releases 页面](https://github.com/microsoft/vscode-js-debug/releases)上的最新 tag。
  - 通过 `JS_DEBUG_DAP_SERVER=<path-to-dapDebugServer.js>` 指定任意其他位置。
  - 使用 Mason 的 Neovim 用户：`:MasonInstall js-debug-adapter` → 发现于 `~/.local/share/nvim/mason/packages/js-debug-adapter/js-debug/src/dapDebugServer.js`。
- 若 `node` 在 `PATH` 上，适配器在 `node` 下运行，否则在 omp 宿主（Bun）下运行；`resolveDefaultJsDebugAdapter()` 回退到 `process.execPath`，因此纯 Bun 环境也受支持。
- `configurationDone` 在根与子会话的 launch/attach 握手期间自动发送；若初始握手未完成，则在后续请求之前惰性发送。
- `startDebugging` 反向请求会在同一 TCP 服务器上创建递归子会话；停止的子会话将成为线程级 action 的目标。
- `output` 仅暴露活动会话合并后的 `output` 事件流；该工具不区分 stdout、stderr 与 console 类别。
- 会话摘要暴露 `needsConfigurationDone`、`parentSessionId` 与 `childSessionIds`。
- 源码断点文件路径在缓存并跨树同步之前会用 `path.resolve()` 规范化。
- `evaluate` 默认为 `repl`，因此在适配器支持时该工具可以转发原始调试器命令。
- `disassemble` 先按 `memory_reference` 解析目标，再解析当前停止会话的 `instructionPointerReference`；两者都不存在时抛出。
- `RawSseDebugBuffer.recordEvent()` 在有界保留之前先递增 `totalEvents`。因此快照显示的保留记录数可能少于观察到的事件总数。
- raw SSE buffer 的监听器失败会被吞掉，以免查看器 bug 破坏捕获。
- `createDebugLogSource()` 按从新到旧的顺序遍历按日日志文件，但 `loadOlderLogs()` 会在拼接前反转每个请求的切片，从而使较早的块按时间顺序前置。
- `clearArtifactCache()` 按目录 mtime 删除目录，而不是按单个文件的新旧程度。
- `addDirectoryToArchive()` 通过 `Bun.file(...).text()` 把产物文件按文本读取。二进制产物内容不会在报告归档中按字节保留。
- 工具渲染器会为 TUI 预览截断显示的输出，但底层文本结果仍包含完整的返回字符串。
- 仅限 UI 的 JavaScriptCore 远程调试器在启动后具有幂等性，且无法停止，因为 `bun:jsc` 不返回句柄。它只绑定到 `127.0.0.1`；由于 Bun 在 macOS 上可能在套接字已就绪时仍抛出虚假的 bind 错误，成功与否由回环就绪探测判定。
