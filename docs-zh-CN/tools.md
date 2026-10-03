# Fork 工具参考

> 本页合并 fork 新增的三个 Agent 工具文档：`hub`、`repo` 与 `wiki`。

---

## hub

> 统一的代理协调界面：基于进程全局邮箱总线的对等消息传递、后台作业控制，以及对共享长时进程的监督。

由原有的 `irc`、`job` 和 `launch` 工具合并而成；每组操作族保留其原有行为和渲染方式。

### 源码
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

### 输入

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

### 操作族与调度
- **消息传递** — `send`（带 `to`）、`inbox`、`list`，以及带 `from` 的 `wait`。即发即忘的发送会返回投递回执（`injected`/`woken`/`revived`/`failed`）；直接发送可以唤醒被暂挂的代理，而广播只针对可见的活跃对等方，不会唤醒每一个被暂挂的代理。`await: true` 会在投递后等待一条回复。当异步执行被禁用时，忙碌的接收方可能会自动回复，而不是让等待中的发送者悬置。
- **作业** — `wait`（裸调用或带 `ids`）、`cancel`、`jobs`。按所有者作用域的可见性、watch/unwatch 投递抑制、返回的完成结果上的 `acknowledgeDeliveries`、等待期间每 500 ms 的 `onUpdate` 快照，以及自适应等待窗口。`jobs` 是原有的作业列表快照，再加上没有运行中作业条目的运行中子代理列表。
- **进程** — `start`、`ps`、`logs`、`stop`、`restart`、`describe`，以及携带 `name` 时的 `send`/`wait`。与原有 `launch` 工具的行为完全一致；`ps` 是 broker 的 `list`。参见下方的启动各节。

同时带有 `to` 和 `name` 的 `send` 会因歧义被拒绝。`wait` 按目标路由：`name` → 进程等待；否则为统一的协调等待。

### 统一的 `wait`
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

### 输出
- 消息传递与作业结果：单个文本块加上 `details: CoordinationDetails` — `{ op, from?, to?, receipts?, waited?, inbox?, peers?, jobs?, cancelled?, agents? }`。除作业操作的详情现在携带 `op`（`"wait" | "cancel" | "jobs"`）之外，形态与原有工具一致。
- 进程结果：`details: LaunchToolDetails` — `{ op, daemon?, daemons?, cursor?, timedOut?, state?, terminalRows?, matched?, spec? }`，与原有 `launch` 工具一致（内部 `ps` 存储的是 broker 操作 `list`）。
- 流式：监视作业的等待每 500 ms 发出带最新快照的 `onUpdate`；其他一切都是单次返回。

### 可用性
- 该工具始终注册（`loadMode: "essential"`）。
- 消息传递操作需要 `AgentRegistry` 和调用方代理 id；否则返回 `Peer messaging is unavailable in this session.`（`isIrcEnabled` 仍控制对等代理列表的提示词小节：对每个子代理以及任何仍能生成子代理的会话都为 true）。
- 作业操作需要 `session.asyncJobManager`；否则返回 `Async execution is disabled; no background jobs are available.`
- 进程操作需要 `launch.enabled`；否则返回 `Process supervision is disabled (launch.enabled=false).`

### 审批
`hubApproval`（按调用）：`start`、`stop`、`restart` 以及发往进程的 `send` 是 `exec`；其余一切 — 消息传递、作业控制、`ps`/`logs`/`describe`/`wait` — 都是 `read`。

### 启动与就绪（进程）
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

### 日志、输入、信号（进程）
```json
{"op":"logs","name":"web","grep":"error|warn","lines":50}
{"op":"logs","name":"web","follow":true,"cursor":1842,"timeout":30}
{"op":"send","name":"debugger","text":"breakpoint set --name main"}
{"op":"send","name":"debugger","keys":["CTRL_C"]}
```
每条 logs 结果都会返回一个字节游标；`follow: true` 会等待，直到输出推进到超过该游标、进程退出或超时耗尽。broker 保留一份 25 MiB 的当前日志外加一份轮转日志。按键：`ENTER`、`TAB`、`ESCAPE`、`CTRL_C`、`CTRL_D`、方向键。信号：`SIGINT`、`SIGTERM`、`SIGHUP`、`SIGQUIT`、`SIGKILL`。输入在所有项目客户端之间是同一个共享流。

### 跨实例生命周期（进程）
与原有 `launch` 工具一致：第一个进程操作会在 `~/.omp/run/daemons/<project-hash>/` 下的私有 socket 上启动一个分离的 broker；项目中的每个 omp 实例共享名称、日志与状态。最后一个 omp 进程退出后，broker 会停止非持久化进程并退出。`persist: true` 选择不参与最后一个客户端的清理；重启策略（`no`/`on-failure`/`always`）使用有界指数退避，最长 30 秒。

### 限制与上限
- 邮箱：每个代理 100 条消息（`MAILBOX_CAP`）；超出上限时丢弃最旧的消息。
- 等待型发送：`irc.timeoutMs` 默认 `120_000`；`0` 表示禁用；负数/非有限值回退到默认值。
- 消息/作业 `wait` 窗口：自适应阶梯 `[5s, 10s, 30s, 1m, 5m]`，每次背靠背等待上升一个梯级（按所有者），60 秒未等待后重置回最低梯级；没有按调用或设置的覆盖。
- 作业保留 5 分钟；管理器最大运行数的回退值 15；`async.maxJobs` 限制在 1..100。
- 启动名称 1-48 个字符；`ready.port` 1..65535；`logs`/`wait`/`stop` 超时上限为一小时。

### 错误
- 大多数校验/可用性失败都是带 `isError: true` 的文本结果：消息传递不可用、缺少 `to`/`message`、向自己发送（`Cannot send a message to yourself.`）、`await` 配合 `to:"all"`、同一次发送同时带 `to`+`name`、`cancel` 缺少 `ids`，以及 launch 被禁用。异步被禁用时的 `jobs`/`cancel` 响应是个例外：它返回 `Async execution is disabled; no background jobs are available.` 以及空作业列表，且不带 `isError` 标志。
- 启动校验（缺少 `name`/`application`、`ready.port` 非法、不支持的键）会抛出 `ToolError`，与之前完全一致。
- `wait` 超时是正常结果（`waited: null` 或被标记为 `useless` 的全运行快照），绝不是错误。
- 每个接收方的投递失败会以 `failed` 回执呈现；只有当什么也没投递成功时，`send` 才是 `isError`。

### 备注
- IRC 总线、代理注册表、作业管理器和启动 broker 都是未改动的子系统；合并的只是工具界面。
- 运行中的接收方仍会以非中断性旁注的形式收到消息注入（`irc:incoming` 自定义消息、`prompts/system/irc-incoming.md`）；回复是真实的轮次。
- 向被暂挂的代理发送消息会唤醒它 — 这是唯一的恢复原语；task 工具没有 `resume` 参数。
- TUI 渲染按各部分保留：消息卡片（`IRC ➤ / ⟵` 头）、作业等待帧（可被取代的微光行）和启动帧的渲染与合并前的工具逐字节一致；`hub` 渲染器只负责分发。
---

## repo

> 只读检索当前代码仓库的本地文件正文与 Python 符号索引。索引由用户通过 `/repo` 管理，agent 工具不会自行建立或删除。

### 范围与维护

- 索引根目录是规范化后的 Git 工作树根目录；非 Git 目录则使用规范化后的会话工作目录。每个根目录在用户的 agent 目录下有独立的 SQLite 索引（`repo/<根目录的 SHA-256>.db`），不同工作树、非 Git 目录之间不共用。`/repo` 在首次建立索引前显示实际根目录；不会自动首次建库，也没有 `omp repo` CLI 命令组。
- 在交互式 TUI 中打开 `/repo`：`b` 建立尚不存在的索引（按 `y` 确认），`u` 对已有索引执行全量范围核对并更新，`r` 重建（按 `y` 确认），`d` 只删除索引（按 `y` 确认），`c` 取消正在运行的索引操作，`Esc` 关闭面板。操作期间按 `Esc` 会询问是否取消并关闭；删除期间则询问是否在删除完成后关闭。确认界面按 `n` 或 `Esc` 可放弃。面板显示进度、失败项、覆盖状态与上次完整核对时间。
- 枚举遵守现有文件搜索的忽略规则。符号链接、超过 2 MiB 的文件、二进制或非 UTF-8 文件以及不可读文件会被排除或报告。索引保存文件正文、路径、分类和 Python 模块／类／函数／方法的快照，而不是实时源码。全量核对会重新枚举并读取整个范围，可发现未跟踪文件以及大小和修改时间不变的内容变化。更新或重建失败／取消时，已有的可用代仍保留；删除索引不删除源码。

### 输入

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `action` | `"status" \| "search" \| "symbol"` | 是 | `status` 不扫描目录，只读取保存的覆盖状态；`search` 搜索索引中的文件正文；`symbol` 搜索 Python 符号名称及限定名称。 |
| `query` | `string` | `search`、`symbol` 必填 | 查询文本或符号名称；去除两端空白后不可为空，最多 500 字符。`status` 不传该字段。 |
| `path` | `string` | 否 | 精确匹配相对文件路径，或匹配目录前缀（`src` 匹配 `src/` 下的文件，不匹配 `src2/`）；不按文件名任意子串匹配。用于检索，不用于 `status`。 |
| `category` | `"source" \| "test" \| "config" \| "other"` | 否 | 按索引器对文件的保守分类筛选，不代表对正文含义的判定。用于检索。 |
| `limit` | `number` | 否 | 每页命中数，默认 20，限制在 1–50。用于检索。 |
| `cursor` | `string` | 否 | 前一页返回的续页令牌，续页须保持相同的 action、query、path、category。 |

例如：`{"action":"search","query":"Widget","path":"src","category":"source"}`、`{"action":"symbol","query":"Widget.render","limit":20}`、`{"action":"status"}`。额外字段会被拒绝。

### 匹配与结果

- 正文检索优先排列完整标识符／原文匹配（词边界完整匹配优先于子串），原句未命中时也可通过拆分出的词元召回文件。短于三个 Unicode 码点的查询回退到索引正文子串检索。标点和引号不是正则表达式操作符，也没有需要学习的查询语法；大小写匹配使用 JavaScript 的 Unicode `toLowerCase()`，而非依地区设置变化的规则。符号检索按 Python 名称和限定名称的子串匹配，精确名称优先。结果给出相对路径、分类、原始行号范围，以及有长度上限的正文片段或符号类型／名称／限定名称／签名。
- 每次返回一页结果，并附覆盖状态和警告。出现 `Next cursor` 时可继续翻页；令牌绑定索引代，更新后若令牌过期须从第一页重查。无效或不匹配的令牌会报错，不会悄悄跳页。单个字段（包括路径、片段和签名）可能截断；`Fields truncated` 标明受影响字段，被截断的路径不一定能用于定位。
- `status` 返回索引是否存在、代号、文件／符号数量、已知待处理路径、失败／排除项、不确定状态与上次完整核对时间，但不检查所有源码。处理已知路径和核对完整范围是不同的操作：`search`／`symbol` 在检索前先处理已知修改路径，`u` 则重新枚举、核对整棵目录。覆盖状态区分完整／不完整、已核对／未核对；成功的工具编辑可自动更新已知路径，外部命令或未观测到的修改仍可能使完整范围处于未核对状态，需在面板按 `u` 核对。Python 解析错误时保留已索引的正文，删除过期符号并报告失败。索引缺失、零命中、覆盖不完整和错误是不同状态；命中或未命中均不能证明当前源码内容或全局不存在。

已知源码路径应直接 `read`，编辑或依赖正文前须读取当前文件。缺索引时，在用户决定是否建立前使用 `read`／`grep`；需要穷尽或针对当前文件的结论时使用 `grep`。此索引不提供依赖图、调用图或影响分析。

### 源码

- 工具与参数：`packages/coding-agent/src/tools/repo.ts`
- 面向模型的指导：`packages/coding-agent/src/prompts/tools/repo.md`
- 索引与面板：`packages/coding-agent/src/repo/service.ts`、`packages/coding-agent/src/modes/components/repo-hub.ts`
---

## wiki

> 搜索已索引的 Markdown 语料库并返回匹配的章节文本——经过排序、去重并按预算裁剪。

### 源码
- 入口：`packages/coding-agent/src/tools/wiki.ts`
- 面向模型的提示词：`packages/coding-agent/src/prompts/tools/wiki.md`
- 关键协作者：
  - `packages/coding-agent/src/docs/service.ts` — 索引发现与检索
  - `packages/coding-agent/src/docs/markdown.ts` — 章节形态分类与标题截断
  - 索引生命周期：`omp docs init "<dir>" --name <name>` / `omp docs remove <name> --force`

### 输入

| 字段 | 类型 | 必填 | 描述 |
| --- | --- | --- | --- |
| `query` | `string` | 是 | 关键词或整句提问；结果按相关度排序。没有需要学习的查询语法：`AND`/`OR`、引号与通配符都按普通字符处理。 |

多余的键会被忽略而不是拒绝（宽松的参数校验）；缺失或为空的 `query` 会报错，错误信息会列出实际收到的键，并附上用法示例。超过 500 个字符的 `query` 会在检索与回显之前被截断（带省略号），因此回显永远不会超过它所请求的页面。

### 分析与排序
- 拉丁词与数字按整词匹配（像 `MBIST是什么` 这样的中英混写会保留完整的拉丁片段）；汉字串切分为相邻 bigram，功能词整词丢弃，因此不会产生语料中不存在的组合。
- 多个查询词以并集而非过滤方式组合——某个章节命中的词越多，排名越高。
- 超过 32 个词元的查询会被均匀降采样，保留首尾，因此需求句末尾的技术要点不会丢失。
- 排序优先级：查询原样出现在标题 → 原样出现在正文（`std::vector` 优于散落的 `vector std`）→ 包含全部词元 → 同档内按 BM25。
- 配置了多个索引时，一次查询会覆盖全部索引。

### 输出
- 单次返回结果；`content[0].text` 是由命中章节拼成的一页 Markdown。
- 每个命中先渲染一行页头 `[n] <relative path>:<start>-<end> · <heading path> · sectionId=<id>`，随后是该章节的完整文本。
- 页面开头给出命中总数，页脚报告有多少章节因体积被跳过、有多少重复命中被折叠。
- 单页最多约 20,000 字符（在该语料上约合 10–12k token）与 200 个章节；最佳命中总是完整保留，即使它单独就超出预算。
- 跨文档逐字重复的章节（长于约 200 字符）只出现一次；后续副本折叠为指针行。`#### Cell` 之类的结构标签会被跳过。标题即内容的章节以 "(heading only …)" 形式返回。
- 该工具不流式输出更新。

### 流程
1. 从 agent 目录与会话 cwd 实例化 `DocsService`；若不存在任何索引，则失败并给出 `omp docs init` 用法提示，而不是执行检索。
2. 以 200 个章节为上限执行排序检索；零命中时失败并建议使用一个独特的词而不是整句。
3. 构建页面：分类每个命中的形态、折叠重复项、把页头与正文按同一字符预算计费，并且绝不因体积丢弃最佳命中。
4. 如果所有匹配都只是占位，调用仍会返回用于定位的页头，而不是失败。

### 副作用
- 对磁盘或会话状态无影响；该工具是只读的（`approval: "read"`）。

### 限制与上限
- 页面预算：约 20,000 字符，包含开头的页头行；每次调用的章节数：200。
- 查询上限：500 字符——更长的查询会被截断，然后检索并回显。
- 入库章节在导入时上限为 18,000 字符，因此任何命中都能整段返回。
- 检索语义固定（词元并集、拉丁整词、汉字 bigram）；没有操作符、过滤器或字段限制。

### 错误
- 缺少 `query`：`wiki requires a query. Received: <keys>. Example: {"query":"MBIST"}`。
- 未配置任何索引：`No document indexes. Run: omp docs init "<dir>" --name <name>`。
- 没有任何章节匹配：`No section matches "<query>". Use one distinctive term rather than a sentence.`
- 匹配项完全不带正文文本：`Sections matching "<query>" carry no body text.`

### 备注
- 语料是 `omp docs init` 导入时的一份快照：自那次导入之后被修改或新增的源文件不在其中。重新导入该目录即可纳入。
- 语料由两个索引命令维护；`/wiki` 面板会列出已有索引并可发起这两个动作，而本工具只读。
- 当旧版索引把整篇文档存成单个标题时，标题路径会被截断，因此页头不会消耗掉它们本应用来描述内容的页面预算。
