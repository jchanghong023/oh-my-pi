# hub

> 统一的代理协调界面：基于进程全局邮箱总线的对等消息传递、后台作业控制，以及对共享长时进程的监督。

由原有的 `irc`、`job` 和 `launch` 工具合并而成；每组操作族保留其原有行为和渲染方式。

## 源码
- 入口：`packages/coding-agent/src/tools/hub/index.ts`（schema、`HubTool`、统一的 `wait`、渲染器分发）
- 消息传递部分：`packages/coding-agent/src/tools/hub/messaging.ts`
- 作业部分：`packages/coding-agent/src/tools/hub/jobs.ts`
- 启动部分：`packages/coding-agent/src/tools/hub/launch.ts`
- 共享类型：`packages/coding-agent/src/tools/hub/types.ts`
- 面向模型的提示词：`packages/coding-agent/src/prompts/tools/hub.md`
- 关键协作模块：
  - `packages/coding-agent/src/irc/bus.ts` — 进程全局 `IrcBus`：每代理邮箱、投递、等待者匹配。
  - `packages/coding-agent/src/registry/agent-registry.ts` — 进程全局代理目录与状态。
  - `packages/coding-agent/src/registry/agent-lifecycle.ts` — 直接发送时对被暂挂接收者的唤醒。
  - `packages/coding-agent/src/session/agent-session.ts` — `deliverIrcMessage(...)`：接收者侧注入与唤醒轮次。
  - `packages/coding-agent/src/async/job-manager.ts` — 作业注册表、取消、投递抑制、自适应等待阶梯。
  - `packages/coding-agent/src/launch/client.ts` / `broker.ts` / `presence.ts` / `protocol.ts` — 进程监督 broker。
  - `packages/coding-agent/src/config/settings-schema.ts` — `irc.timeoutMs`（等待型发送）、`launch.enabled`。

## 输入

| 字段 | 类型 | 是否必填 | 说明 |
| --- | --- | --- | --- |
| `op` | `"send" \| "wait" \| "inbox" \| "list" \| "jobs" \| "cancel" \| "start" \| "ps" \| "logs" \| "stop" \| "restart" \| "describe"` | 是 | 操作。 |
| `to` | `string` | `send`（对等） | 接收方代理 id，或用于广播的 `"all"`。与 `name` 互斥。 |
| `message` | `string` | `send`（对等） | 消息正文。修剪后为空会被拒绝。 |
| `replyTo` | `string` | 否 | `send`：正在回复的消息 id。 |
| `await` | `boolean` | 否 | 对等 `send`：投递后阻塞，直到该对等方发来的下一条消息到达。与 `to: "all"` 一起使用时无效。 |
| `from` | `string` | 否 | `wait`：只接受来自此代理 id 的消息（纯消息等待）。 |
| `ids` | `string[]` | 否 | `wait`：要监视的作业 id（省略 = 所有运行中作业）；`cancel`：要终止的作业 id（必填）。 |
| `peek` | `boolean` | 否 | `inbox`：把消息留在进程全局总线邮箱中。请注意，当前实现仍会把已缓冲在活跃接收方会话上的消息抽取到本次结果中。 |
| `name` | `string` | 进程操作 | 稳定的项目作用域启动名称（1-48 个字符）。在 `send`/`wait` 上，它会把该操作路由到进程 broker。 |
| `application`, `args`, `env`, `cwd`, `pty`, `ready`, `restart`, `persist`, `detached` | — | `start` | 启动规格，与原有 `launch` 工具一致。 |
| `lines`, `head`, `grep`, `follow`, `cursor` | — | `logs` | 日志窗口控制，未做改动。 |
| `for`, `pattern` | — | `wait`（name） | 进程生命周期条件 / 输出正则。 |
| `text`, `enter`, `keys`, `signal` | — | `send`（name） | 进程 stdin / 终端按键 / 信号。 |
| `timeout` | `number` | 否 | `logs`/`stop`/带 `name` 的 `wait`：秒；默认 30（stop：5）。 |

## 操作族与调度
- **消息传递** — `send`（带 `to`）、`inbox`、`list`，以及带 `from` 的 `wait`。即发即忘的发送会返回投递回执（`injected`/`woken`/`revived`/`failed`）；直接发送可以唤醒被暂挂的代理，而广播只针对可见的活跃对等方，不会唤醒每一个被暂挂的代理。`await: true` 会在投递后等待一条回复。当异步执行被禁用时，忙碌的接收方可能会自动回复，而不是让等待中的发送者悬置。
- **作业** — `wait`（裸调用或带 `ids`）、`cancel`、`jobs`。按所有者作用域的可见性、watch/unwatch 投递抑制、返回的完成结果上的 `acknowledgeDeliveries`、等待期间每 500 ms 的 `onUpdate` 快照，以及自适应等待窗口。`jobs` 是原有的作业列表快照，再加上没有运行中作业条目的运行中子代理列表。
- **进程** — `start`、`ps`、`logs`、`stop`、`restart`、`describe`，以及携带 `name` 时的 `send`/`wait`。与原有 `launch` 工具的行为完全一致；`ps` 是 broker 的 `list`。参见下方的启动各节。

同时带有 `to` 和 `name` 的 `send` 会因歧义被拒绝。`wait` 按目标路由：`name` → 进程等待；否则为统一的协调等待。

## 统一的 `wait`
一个阻塞原语。它解析作业分支（显式的 `ids`、按所有者作用域且被静默过滤，或调用者拥有的每一个运行中作业），并在会话能够向对等方发送消息时停放一个总线等待者，然后对以下各项竞速：
- 每个被监视的运行中作业的 `job.promise`，
- 第一条匹配的传入消息（给出 `from` 时按它过滤），
- 自适应等待窗口（`manager.nextPollWaitMs(owner)`），
- 工具调用中止信号。

结果：
- 消息胜出（即便是同时冲线：被总线等待者消费的消息绝不会丢失）→ 该消息会与原有 `irc wait` 完全一样地返回（`details.waited`），作业则继续运行；它们的结果仍会自行投递。
- 作业完成或窗口耗尽 → 与原有 `job` 轮询完全一样的作业快照（`details.jobs`、`## Completed` / `## Still Running` 小节）。全部仍在运行的快照会被标记为 `useless`，并渲染为可被取代的等待帧，由下一次 `hub` 调用顶掉。
- 没有作业分支：带对等方存活检测的纯消息等待（受同一个自适应窗口约束）；如果也没有运行中的对等方，则立即返回 `No running background jobs to wait for.`（若存在无作业的运行中代理列表，则一并返回）。
- 显式 `ids` 未匹配到任何可见项 → `No matching jobs found for IDs: ...`，并带每个 id 的代理提示（`history://<id>`），绝不挂起。
- 已缓冲在会话上的消息会在开始监视任何内容之前满足该等待。

阶梯记账（`nextPollWaitMs` / `recordPollWaitEnd`）只在真正阻塞的路径上运行；立即返回不会改动梯级。

## 输出
- 消息传递与作业结果：单个文本块加上 `details: CoordinationDetails` — `{ op, from?, to?, receipts?, waited?, inbox?, peers?, jobs?, cancelled?, agents? }`。除作业操作的详情现在携带 `op`（`"wait" | "cancel" | "jobs"`）之外，形态与原有工具一致。
- 进程结果：`details: LaunchToolDetails` — `{ op, daemon?, daemons?, cursor?, timedOut?, state?, terminalRows?, matched?, spec? }`，与原有 `launch` 工具一致（内部 `ps` 存储的是 broker 操作 `list`）。
- 流式：监视作业的等待每 500 ms 发出带最新快照的 `onUpdate`；其他一切都是单次返回。

## 可用性
- 该工具始终注册（`loadMode: "essential"`）。
- 消息传递操作需要 `AgentRegistry` 和调用方代理 id；否则返回 `Peer messaging is unavailable in this session.`（`isIrcEnabled` 仍控制对等代理列表的提示词小节：对每个子代理以及任何仍能生成子代理的会话都为 true）。
- 作业操作需要 `session.asyncJobManager`；否则返回 `Async execution is disabled; no background jobs are available.`
- 进程操作需要 `launch.enabled`；否则返回 `Process supervision is disabled (launch.enabled=false).`

## 审批
`hubApproval`（按调用）：`start`、`stop`、`restart` 以及发往进程的 `send` 是 `exec`；其余一切 — 消息传递、作业控制、`ps`/`logs`/`describe`/`wait` — 都是 `read`。

## 启动与就绪（进程）
`application` 和 `args` 是彼此独立的字段，因此调用方不需要 shell 引号：

```json
{
  "op": "start",
  "name": "web",
  "application": "bun",
  "args": ["run", "dev"],
  "ready": { "log": "Local:.*http", "port": 5173, "timeout": 30 }
}
```

默认值：`cwd` = 会话目录、`args: []`、`env: {}`、`pty: true`、`restart: "no"`、`persist: false`、`detached: false`，就绪超时 30 秒。`detached: true` 隐含 `persist`、强制 `pty: false`，并禁用 stdin。`ready.log` 是针对捕获输出的正则；`ready.port` 在 `ready.host`（默认 `127.0.0.1`）上探测 TCP；两者同时存在时，两者都必须通过。就绪超时会让进程继续运行并报告其状态。

名称在一个项目目录内稳定且唯一。活跃名称必须先停止或重启；启动一个已完成的名称会创建新的启动并轮转其先前的输出日志。

## 日志、输入、信号（进程）
```json
{"op":"logs","name":"web","grep":"error|warn","lines":50}
{"op":"logs","name":"web","follow":true,"cursor":1842,"timeout":30}
{"op":"send","name":"debugger","text":"breakpoint set --name main"}
{"op":"send","name":"debugger","keys":["CTRL_C"]}
```
每条 logs 结果都会返回一个字节游标；`follow: true` 会等待，直到输出推进到超过该游标、进程退出或超时耗尽。broker 保留一份 25 MiB 的当前日志外加一份轮转日志。按键：`ENTER`、`TAB`、`ESCAPE`、`CTRL_C`、`CTRL_D`、方向键。信号：`SIGINT`、`SIGTERM`、`SIGHUP`、`SIGQUIT`、`SIGKILL`。输入在所有项目客户端之间是同一个共享流。

## 跨实例生命周期（进程）
与原有 `launch` 工具一致：第一个进程操作会在 `~/.omp/run/daemons/<project-hash>/` 下的私有 socket 上启动一个分离的 broker；项目中的每个 omp 实例共享名称、日志与状态。最后一个 omp 进程退出后，broker 会停止非持久化进程并退出。`persist: true` 选择不参与最后一个客户端的清理；重启策略（`no`/`on-failure`/`always`）使用有界指数退避，最长 30 秒。

## 限制与上限
- 邮箱：每个代理 100 条消息（`MAILBOX_CAP`）；超出上限时丢弃最旧的消息。
- 等待型发送：`irc.timeoutMs` 默认 `120_000`；`0` 表示禁用；负数/非有限值回退到默认值。
- 消息/作业 `wait` 窗口：自适应阶梯 `[5s, 10s, 30s, 1m, 5m]`，每次背靠背等待上升一个梯级（按所有者），60 秒未等待后重置回最低梯级；没有按调用或设置的覆盖。
- 作业保留 5 分钟；管理器最大运行数的回退值 15；`async.maxJobs` 限制在 1..100。
- 启动名称 1-48 个字符；`ready.port` 1..65535；`logs`/`wait`/`stop` 超时上限为一小时。

## 错误
- 大多数校验/可用性失败都是带 `isError: true` 的文本结果：消息传递不可用、缺少 `to`/`message`、向自己发送（`Cannot send a message to yourself.`）、`await` 配合 `to:"all"`、同一次发送同时带 `to`+`name`、`cancel` 缺少 `ids`，以及 launch 被禁用。异步被禁用时的 `jobs`/`cancel` 响应是个例外：它返回 `Async execution is disabled; no background jobs are available.` 以及空作业列表，且不带 `isError` 标志。
- 启动校验（缺少 `name`/`application`、`ready.port` 非法、不支持的键）会抛出 `ToolError`，与之前完全一致。
- `wait` 超时是正常结果（`waited: null` 或被标记为 `useless` 的全运行快照），绝不是错误。
- 每个接收方的投递失败会以 `failed` 回执呈现；只有当什么也没投递成功时，`send` 才是 `isError`。

## 备注
- IRC 总线、代理注册表、作业管理器和启动 broker 都是未改动的子系统；合并的只是工具界面。
- 运行中的接收方仍会以非中断性旁注的形式收到消息注入（`irc:incoming` 自定义消息、`prompts/system/irc-incoming.md`）；回复是真实的轮次。
- 向被暂挂的代理发送消息会唤醒它 — 这是唯一的恢复原语；task 工具没有 `resume` 参数。
- TUI 渲染按各部分保留：消息卡片（`IRC ➤ / ⟵` 头）、作业等待帧（可被取代的微光行）和启动帧的渲染与合并前的工具逐字节一致；`hub` 渲染器只负责分发。
