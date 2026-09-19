# Collab：实时会话共享

`/collab` 可将你正在运行的会话实时共享给其他 omp 实例。访客会在自己的 TUI 中**原生渲染同一个会话**——流式助手文本、工具调用卡片、底栏状态（cwd、模型、上下文占比、成本）、ctrl+o 展开、`/dump`——而非终端镜像。访客可以发送提示词并中断 agent；agent 及所有工具均在主机机器上运行。

## 快速开始

主机端：

```
/collab
```

会输出

```
Collab session started!
 • Join from another terminal: omp join "mgAYTZwEnpRQtca0CTgn-Q.gdJUbTovD94ofDaa8YvhY0-ty16w4fn8PgB6PLnoA30"
 • or any web browser: my.omp.sh/#mgAYTZwEnpRQtca0CTgn-Q.gdJUbTovD94ofDaa8YvhY0-ty16w4fn8PgB6PLnoA30
```

浏览器那一行点击即可加入（是指向完整 `https://` 深链接的 OSC 8 超链接）：中继在 `/` 提供 Web 访客客户端，房间 id 与密钥通过 URL fragment 携带。在另一个 omp（任意目录、任意机器）中，两种形式均可：

运行 `/collab` 或 `/collab view` 会启动或展示当前活动中的托管会话，同时呈现终端/浏览器加入链接及其对应的二维码。

```
/join my.omp.sh/#mgAYTZwEnpRQtca0CTgn-Q.gdJU…
```

访客此前的会话会在 `/leave` 时（或主机停止时）恢复。

### 命令

| 命令              | 效果                                                                   |
| ----------------- | ---------------------------------------------------------------------- |
| `/collab`         | 启动完整控制权共享（已在托管时则重新打印链接/二维码）                  |
| `/collab <relay>` | 通过指定中继启动共享（`relay.example.com`、`ws://localhost:7475`）     |
| `/collab view`    | 启动只读共享（已在托管时则重新打印链接/二维码）                        |
| `/collab status`  | 显示链接与参与者                                                        |
| `/collab stop`    | 停止共享                                                                |
| `/collab list`    | 列出所有活动中的本地 Collab 主机（不含链接）                            |
| `/join <link>`    | 作为访客加入共享会话                                                    |
| `/leave`          | 离开（访客）或停止共享（主机）                                          |

### 自动共享每个会话

显式的 `/collab stop` 与 `/leave` 还会取消会话切换时已排入队列的替代房间。之后发生的另一次会话变更仍遵循已保存的自动启动策略。访客可以回答启动对话框，但在外层启动——包括设置 UI 与会话记录回放——成功完成之前，无法发送提示词、中断或控制 agent。

专用加入保留对会话变更的观察：加入失败会立即回到已保存的自动启动策略，而 `/leave` 或主机断开连接会为本地会话及其后续替代房间恢复自动托管。远程副本重新同步绝不会启动本地主机。

显式以 `omp join <link>` 启动优先于自动启动：它以访客身份初始化，不会发布临时本地主机，也保持已保存的自动启动设置不变。如果在主机已建立之后交互式启动失败，该房间会在终端拆除之前关闭并撤回，然后重新抛出启动错误。

把 `collab.autoStart` 设为 `view` 或 `control`，每个交互式会话就会在启动时通过 `collab.relayUrl` 自行托管，无需运行 `/collab`。房间在扩展的 `session_start` 钩子运行之前创建——扩展在启动时提出的问题会被保留，并交付给第一个加入的写入者——且中继连接在后台进行，因此缓慢或不可达的中继绝不会延迟提示符出现（失败会显示为一条暗淡的状态行）。访客可以加入自动启动的房间并立即回答启动问题，但——与本地输入框出于同样原因被限制 Enter 一样——在启动完成之前，他们无法发送提示词、中断或驱动子 agent；此类帧会被以 `… is unavailable until the host finishes starting up` 拒绝。每个自动启动的会话都会把自身发布到下文的本地主机注册表；该设置的值是注册表将为其发放的最高访问级别（`view`：仅只读链接；`control`：可发送提示词与中断的链接）。`/collab` 仍像从前一样工作：它重新打印当前房间，或者在你要求控制权时用完整控制房间替换只读房间。

房间跟随会话，而非进程。`/new`、`/resume`、`/fork` 和分支操作会先停止当前房间——向访客道别并撤回其注册表条目——再按当前生效的自动启动策略启动替代房间。持有旧链接的访客绝不会看到不同的会话。在未提交的 `/resume` 期间，旧房间会转而挂起，同时目标会话临时处于活动状态；回滚会恢复对原始房间的访问，无需回调。关闭（shutdown）会立即使房间不可用，并在销毁会话之前完成其清理。会话变更失败后，`/collab` 与 `/join` 会使用当前会话的托管状态，并在继续之前淘汰任何过期的自有房间；加入仍拒绝替换活动中的主机。

显式停止也会取消待处理的自动启动，而不改动已保存的策略。仍在排队或加密中的应用帧会被丢弃；只有最后的告别帧会被排空。已经交给传输层的字节无法收回。之后的另一次会话变更或手动启动可以再次托管。

访客所有权在副本激活之前开始，并持续到先前本地会话恢复完毕。加入、重新同步和失败的加入均不得把副本发布为本地主机。离开会等待恢复完成；恢复失败会被报告，并使托管保持阻塞。恢复期间的显式停止会抑制其待处理的自动重启，但不会取消恢复本身。

### 列出活动中的本地主机

挂起会抑制会话数据、加入操作和访客动作，但不会抑制已存在的房间本地对话框的终止。已结束的对话框只携带其请求 ID，因此即使 `/resume` 之后回滚，访客也能将其关闭。针对已存在对话框的第一个通过身份验证的应答，会在目标会话处于临时状态期间被保留，且仅在原始房间恢复、该写入者仍获授权时才被应用。提交、停止和本地取消都不能把该应答应用到另一个会话。在该临时窗口内的加入必须等窗口落定后重试。`/collab status` 打印房间已发布的访问级别，因此只读房间绝不会通过 status 暴露其内部控制链接。

已被接纳的工作通常不会因关闭房间而撤销。特别是，子 agent 复活（revival）与本地调用者共享，并保持绑定到原始 agent 引用与会话记录；它可能在房间关闭之后完成，但旧访客的后续提示词会被丢弃。关闭房间也不会取消本地调用者已合并的复活请求。

替代房间会等待会话操作完成其钩子、会话记录替换以及任何回滚之后才连接。在原位会话记录重置或树导航期间，现有访客继续接收复制数据，但在操作落定之前，提示词与 agent 控制命令会被拒绝；该时间段内的新加入和注册表发现均不可用。如果先前已接纳的提示词在执行前被丢弃，其访客会在保留的房间中收到错误。而正在退场的房间则会发送一条告别，说明未进入会话的提示词必须在重新加入后重新提交。临时切换必须先落定，才能决定适用哪种通知。

`omp collab list`（以及 TUI 内的 `/collab list`）会枚举同一 omp 配置根目录下本机上所有活动中的 Collab 主机——跨终端、跨项目、跨 profile。列出仅涉及元数据；它从不打印或传输链接：

```
omp collab list                          # one row per host, no links
omp collab list --json                   # {"version": 1, "hosts": [...]}
omp collab link <instanceId|pid>         # print that host's full-control browser URL
omp collab link <instanceId|pid> --view  # print its view-only browser URL
omp collab link <instanceId> --json      # {"version": 1, "instanceId", "generation", "access", "url"}
```

每个主机行都带有稳定的 `instanceId`（每个进程随机生成，在该进程托管的各房间之间保持不变）、房间 `generation`（进程每次启动新房间时递增，例如在 `/resume` 时）、PID、会话 ID 与名称、工作目录、模型、启动时间、参与者数量、中继连接当前是否打开、是否有主机侧问题正在等待可写访客（`inputRequired`），以及注册表将发放的最高 `access`（`view` 或 `control`）。主机按启动时间排序，其次按 PID，再按实例 ID。空结果（"No active Collab hosts."）是成功结果，而非错误。

获取链接是针对每个主机的刻意行为。`omp collab link` 会向所选主机请求一个 URL，该 URL 绑定到列出时观察到的 generation：如果主机此后已启动新房间（会话切换），请求会以 `stale_generation` 失败，而不是发放后继房间，此时需重新列出。以 `view` 访问级别发布的主机会拒绝 `control`。匹配到多个（或零个）活动主机的 PID 会被拒绝并附上候选实例 ID；请改用实例 ID。打印出的 URL 授予其访问级别所声明的能力——请像对待 `/collab` 链接本身一样对待控制 URL。

工作原理：每个房间一旦中继连接成功，就会发布自己的私有 IPC 端点（macOS/Linux 上是 Unix domain socket，Windows 上是命名管道——绝不是 TCP 端口）；轮换时会以全新的制品名称发布，因此撤回旧房间绝不会干扰其后继者。完整控制与只读 URL、房间密钥以及写入令牌都保存在主机进程内存中；磁盘上只在 `~/.omp/run/collab-hosts` 下保存发现元数据（协议版本、实例 ID、PID、端点、创建时间和随机 bearer 令牌）。在 macOS/Linux 上，每次发布时权限都会收紧为仅所有者可访问。Windows 继承配置根目录的 ACL，因此该根目录必须保持仅该用户私有。该端点上有两种经过身份验证的操作：`snapshot`（主机状态，其中自由格式字符串有长度上限，因此异常的会话标题不会导致主机无法列出）和 `link`（`access` + `generation` → 一个 URL）。列出操作会以较短的独立超时并发查询每个活动主机，跳过无响应或版本不兼容的条目，并清理已崩溃主机遗留的元数据；暂时的 socket 错误（`EMFILE`、`EACCES` 等）绝不会清掉活动主机。已停止的房间会立即消失——注册表不保留历史，不列出访客或远程主机，也不需要更改中继。第三方仪表板和桥接器可以基于 `omp collab list --json` 加 `omp collab link` 构建——或者直接使用换行分隔的 JSON 端点——而无需 omp 自己发布远程产品。

注册表目录缺失意味着没有活动主机。不可读或符号链接的注册表目录属于列出错误，而非成功的空结果；在 POSIX 上还会拒绝属于其他所有者的目录。个别不可达或格式错误的主机条目仍会被独立忽略。目录错误会使 CLI 以非零码退出；`/collab list` 则显示经过净化、有长度上限的错误信息，并保持 TUI 可用。

## 链接格式

可被 `/join <link>` 和 `omp join "<link>"` 接受的形式：

```
<roomId>.<key>                                                    → default relay (wss://my.omp.sh)
<roomId>#<key>                                                    → legacy bare form
host[:port]/r/<roomId>.<key>                                     → custom relay, wss:// inferred
host[:port]/r/<roomId>#<key>                                     → legacy direct relay form
https://host[:port]/r/<roomId>.<key>                             → direct relay URL, normalized to wss://
wss://host[:port]/r/<roomId>.<key>                               → direct websocket relay URL
ws://localhost:7475/r/<roomId>.<key>                             → direct plain ws, localhost only
https://host[:port]/#<link>                                      → browser deep link when web UI and relay share a host
https://web-host[:port][/<path>]/#<relay-link>                   → browser UI wrapper with relay link in the fragment
https://web.example/collab/#relay.example.com/r/<roomId>.<key>   → web UI and relay on different hosts
```

`<link>` / `<relay-link>` 会递归地按上文任意一种可接受的链接解析。对于带可解析 fragment 的 `http(s)` 浏览器包装链接，fragment 优先于 HTTP host/path 被当作中继处理。这使得 `https://web.example/collab/#relay.example.com/r/<roomId>.<key>` 能在 `web.example` 打开 Web UI，同时加入 `wss://relay.example.com/r/<roomId>`。如果 fragment 不是完整的 collab 链接，解析会回退到旧版直接中继形式，因此 `https://relay.example.com/r/<roomId>#<key>` 仍表示中继 `relay.example.com`。

末尾的 `.<key>` 或 `#<key>` 部分是房间密钥，经 base64url 编码，具有以下两种强度之一：

- **完整链接**——48 字节：32 字节的 AES-256-GCM 房间密钥，后跟 16 字节的写入令牌。授予发送提示词、中断和子 agent 控制能力。
- **仅查看链接**——仅 32 字节的裸密钥，无写入令牌。只授予实时读取能力。无令牌的旧式链接按仅查看解析。

新生成的链接中，房间密钥以点号连接，因为 RFC 3986 禁止在 URL fragment 中出现原始 `#`；解析器仍接受旧式 `#` 形式以及经 `%23` 转义的旧式深链接。

## 端到端加密

每个会话载荷（条目、事件、状态、提示词）在接触 socket 之前都会用 AES-256-GCM 密封。中继只能看到：

- 房间 id 与连接数，
- 不透明的密文帧及其大小，
- 4 字节的路由前缀（帧的目标是哪位访客）。

持有链接即构成信任边界：完整链接可读取并操控会话，仅查看链接只能读取。请像对待机密一样保管这两类链接。

## 访客权限模型

两种信任级别，由链接本身强制执行——主机在加入时验证 16 字节写入令牌，并拒绝没有令牌的对端写入（这些对端在参与者列表中显示为只读，加入通知中也会说明）。

持有完整链接的访客可以：

- 读取整个会话（包括加入时已有的历史会话记录），
- 向 agent 发送提示词（在每位参与者的会话记录中都会带上其名称徽章渲染；LLM 看到的提示词文本是原样内容——名称仅用于显示），
- 中断 agent（Esc），
- 针对主机的子 agent 使用 [Agent Hub](./agent-hub.md)：实时表格与进度、聊天（可操控主机的子 agent）、终止、复活，以及查看会话记录（按需从主机获取），
- 回答主机交互式的 `select` 和 `editor` 请求。主机只把每个待处理请求广播给可写访客；第一个提交或取消的应答会使其落定，并在其他端关闭相应展示。

持有仅查看链接的访客可以实时读取所有内容——历史会话记录、流式文本、工具卡片、子 agent 会话记录——但主机会拒绝来自他们的提示词发送、中断和 agent 控制。

所有会改动主机会话或机器的操作都仅限主机执行：`/model`、`/compact`、`/resume`、`/branch`、bash（`!`）、python（`$`）、skill 等。访客保留一个小的本地白名单（`/dump`、`/export`、`/copy`、`/open`、`/help`、`/hotkeys`、`/theme`、`/settings`、`/leave`、`/collab`、`/exit`、`/quit`）。

当访客在助手回合进行中加入时，该进行中的回合会在随后的第一个 `message_update` 上呈现：访客会先从该 update 的完整累积消息中合成缺失的 `message_start`，再转发增量。如果访客加入后主机没有再为该回合发出任何 update，就没有可用于合成实时部分的 update。持久化条目仍会到达副本的消息状态，但 entry 帧被刻意不渲染，因此这一边缘情况可以保持不出现在实时 TUI 中。

## Web 客户端

`packages/collab-web` 是一个独立的浏览器客户端，使用同样的链接——访客侧无需安装 omp。中继在 `/` 提供该客户端，这正是 `/collab` 深链接能够点击即加入的原因：`https://<relay>/#<link>` 会加载客户端并从 fragment 自动连接。它渲染实时会话记录（流式文本、思考、工具卡片）、一个带按需会话记录的子 agent 面板，以及一个具备同样访客能力（发送提示词、中断、hub 操作）的输入框。在该包中运行 `bun run dev` 可启动本地实例，运行 `bun run mock-host` 可获得一个用于开发的离线脚本化主机，运行 `bun run build` 可输出可部署到任何位置的静态 `dist/`（WebCrypto 需要 HTTPS）。该客户端只与中继通信，密钥始终留在 URL fragment 中。

当浏览器 UI 与 websocket 中继分开托管时，请设置 `collab.webUrl`。为空时，`/collab` 会从 `collab.relayUrl` 推导出 `http(s)://host[:port]`；显式的 Web UI URL 必须使用 `https://`，`http://localhost` 开发源除外。生成的浏览器 URL 仍在 fragment 中携带该中继专属的 collab 链接。

## 设置

| 设置                  | 默认值                | 含义                                                                               |
| --------------------- | --------------------- | ---------------------------------------------------------------------------------- |
| `collab.relayUrl`     | `wss://my.omp.sh`     | 未内联传入中继时 `/collab` 所用的中继                                              |
| `collab.webUrl`       | empty                 | `/collab` 链接使用的浏览器 UI URL；为空时从中继推导；显式 `http://` 仅允许 localhost |
| `collab.displayName`  | OS username           | 显示给其他参与者的名称                                                              |
| `collab.autoStart`    | `off`                 | `view` / `control`：在每个交互式会话启动时托管它，并将其发布到本地注册表            |
| `share.serverUrl`     | `https://my.omp.sh/s` | `/share` 使用的分享查看/上传基址（链接形如 `<base>/<id>#<key>`）                    |
| `share.redactSecrets` | `true`                | 上传前对 `/share` 快照运行密钥混淆器                                                |

## 自托管中继

生产中继目前不提供自托管发行：其 Go 源码和独立二进制文件均未发布。下面的端点列表描述的是托管服务的网络契约，而不是可安装的发行版。

对于本地协议开发，本仓库在 [`packages/collab-web/scripts/local-relay.ts`](../packages/collab-web/scripts/local-relay.ts) 提供了一个源码可见、仅支持 WebSocket 的替代实现。在 `packages/collab-web` 下运行 `bun run relay`，它会监听 `ws://localhost:7466`。它实现了 `/r/<roomId>`，但不提供浏览器客户端、`/share` blob 或 `/healthz`，因此不能替代生产服务。

中继是一个小型的、不感知内容的 Go 服务。除活动连接外它不保留任何状态，并提供：

- `GET /`——静态 collab-web 访客客户端（`/collab` 深链接的目标），
- `GET /r/<roomId>?role=host|guest`——WebSocket 升级，
- `POST /s` / `GET /s/<id>` / `GET /s/<id>/raw`——`/share` blob 上传、查看器页面和 blob 获取，
- `GET /healthz`——存活探针。

## 架构说明

Hub 拓扑——主机是权威方，访客之间从不对等互联：

1. `welcome` + `snapshot-chunk` 帧——初始状态与会话记录。会话记录按字节上限切分为块，因此每次到达都会重置访客的进度超时；过大的被复制条目会在传输前缩减。
2. `entry` 帧——持久化会话条目，在 blob 外部化之前广播，因此图片保持内联（访客无法解析主机的 blob 引用）。访客在保留 id 的情况下把它们追加到 `~/.omp/collab/<roomId>.jsonl` 下的副本会话文件以及 agent 的消息数组中，这就是 `/dump` 和上下文估算能正常工作的原因。
3. `event` 帧——实时 agent 事件，直接送入访客的常规事件控制器；渲染仅基于事件，以防止重复渲染。
4. `state` 帧——防抖的底栏快照：流式标志、主机的完整模型对象与思考级别（应用到访客的副本 agent 状态，因此模型显示和上下文窗口计算是原生的）、主机的上下文数字，以及参与者。
5. `bus` 帧——镜像的任务子 agent 生命周期/进度 EventBus 流量，在访客本地总线上重新发布，因此子 agent HUD 和状态行计数能原生工作。
6. `agents` 帧——agent 注册表快照，馈送给访客本地注册表，因此 Agent Hub 表格能渲染主机的子 agent。
7. `ui-request` / `ui-request-end` 帧——主机的 select/editor 提示，展示给完整控制访客，并在落定后在所有端关闭。访客以 `ui-response` 应答。

访客→主机：`hello`、`prompt`、`abort`、`agent-cmd`（hub 的 chat/kill/revive）、`fetch-transcript`（增量子 agent 会话记录读取，由定向的 `transcript` 帧应答），以及 `ui-response`。副本通过常规的 `/resume` 机制加载，因此主题、ctrl+o 和会话记录行为从构造上就是原生的；访客进程绝不会 chdir 到主机路径。
