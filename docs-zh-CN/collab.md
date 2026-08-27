# Collab: 实时会话共享

`/collab` 可在实时与其他 omp 实例共享正在运行的会话。访客会在自己的 TUI 中**以原生方式渲染同一个会话** —— 包括流式助手文本、工具调用卡片、底栏状态（cwd、模型、context %、cost）、ctrl+o 展开、`/dump` 等 —— 而非终端镜像。访客可以发起提示并中断代理；代理及其所有工具始终在主机上运行。

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

浏览器那一行是点击即可加入的链接（指向完整 `https://` 深链接的 OSC 8 超链接）：中继服务器在 `/` 提供 Web 访客客户端，房 id 和 key 通过 URL fragment 传递。在另一个 omp（任意目录、任意机器）中，这两种形式都可以使用：

运行 `/collab` 或 `/collab view` 启动或展示当前进行中的托管会话，同时呈现终端/浏览器加入链接以及它们对应的二维码。

```
/join my.omp.sh/#mgAYTZwEnpRQtca0CTgn-Q.gdJU…
```

访客在执行 `/leave`（或在主机停止时）后会恢复之前的会话。

### 命令

| 命令                | 效果                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------- |
| `/collab`           | 启动完整控制权的共享（已托管时则重新打印链接/二维码）                                 |
| `/collab <relay>`   | 通过指定的中继启动共享（`relay.example.com`、`ws://localhost:7475`）                  |
| `/collab view`      | 启动只读共享（已托管时则重新打印链接/二维码）                                         |
| `/collab status`    | 显示链接和参与者                                                                      |
| `/collab stop`      | 停止共享                                                                              |
| `/join <link>`      | 作为访客加入共享会话                                                                  |
| `/leave`            | 离开（访客）或停止共享（主机）                                                        |

## 链接格式

可被 `/join <link>` 和 `omp join "<link>"` 接受的形式：

```
:<roomId>.<key>                                                    → 默认中继 (wss://my.omp.sh)
:<roomId>#<key>                                                    → 旧版裸形式
host[:port]/r/<roomId>.<key>                                       → 自定义中继，wss:// 隐式
host[:port]/r/<roomId>#<key>                                       → 旧版直接中继形式
https://host[:port]/r/<roomId>.<key>                               → 直接中继 URL，归一化为 wss://
wss://host[:port]/r/<roomId>.<key>                                 → 直接 WebSocket 中继 URL
ws://localhost:7475/r/<roomId>.<key>                               → 直接明文 ws，仅限 localhost
https://host[:port]/#<link>                                        → Web UI 与中继同主机时的浏览器深链接
https://web-host[:port][/<path>]/#<relay-link>                     → 浏览器 UI 包装，fragment 中携带中继链接
https://web.example/collab/#relay.example.com/r/<roomId>.<key>     → Web UI 与中继位于不同主机
```

`<link>` / `<relay-link>` 会以递归方式按上述任一可接受链接解析。对于带有可解析 fragment 的 `http(s)` 浏览器包装链接，fragment 优先于 HTTP host/path 作为中继解析。这使得 `https://web.example/collab/#relay.example.com/r/<roomId>.<key>` 能够在 `web.example` 打开 Web UI 的同时加入 `wss://relay.example.com/r/<roomId>`。如果 fragment 不是完整的 collab 链接，则回退到旧版直接中继形式解析，因此 `https://relay.example.com/r/<roomId>#<key>` 仍然表示中继 `relay.example.com`。

末尾的 `.<key>` 或 `#<key>` 部分是房间密钥，base64url 编码，具有以下两种强度之一：

- **完整链接** —— 48 字节：32 字节的 AES-256-GCM 房间密钥后跟 16 字节的写入令牌。授予提示、中断和子代理控制权限。
- **仅查看链接** —— 仅 32 字节的裸密钥，无写入令牌。仅授予实时读取权限。无令牌的旧链接会按仅查看解析。

新生成的链接中房间密钥使用点号连接，因为 RFC 3986 禁止在 URL fragment 中出现原始 `#`；解析器仍然接受旧版 `#` 形式以及 `%23` 转义的旧版深链接。

## 端到端加密

每一个会话载荷（条目、事件、状态、提示）在进入 socket 之前都使用 AES-256-GCM 密封。中继只能看到：

- 房间 id 和连接数，
- 不透明的密文帧及其大小，
- 4 字节的路由前缀（用于指示帧的目标访客）。

链接本身即是信任边界：完整链接可读取并操控会话，仅查看链接只可读取。请像对待机密一样分享这两类链接。

## 访客权限模型

两种信任级别，由链接本身强制 —— 主机在加入时验证 16 字节的写入令牌，拒绝没有令牌的同行的写入操作（它们在参与者列表中显示为只读，加入提示中也会说明）。

拥有完整链接的访客可以：

- 读取整个会话（包括加入时的历史回放记录），
- 向代理发起提示（在每位参与者的记录上会渲染其名称徽章；LLM 看到的提示文本是原文 —— 名称仅用于显示），
- 中断代理（Esc），
- 针对主机的子代理使用 [Agent Hub](./agent-hub.md)：实时表格与进度、聊天（操控主机的子代理）、终止、恢复，以及按需从主机获取的记录查看，
- 回答主机的交互式 `select` 和 `editor` 请求。主机只向具有写权限的访客广播每个挂起中的请求；首个提交或取消的响应会结束该请求，并在其他端关闭该展示。

拥有仅查看链接的访客可以实时读取所有内容 —— 历史回放记录、流式文本、工具卡片、子代理记录 —— 但主机会拒绝其提示、中断和代理控制操作。

所有会变更主机会话或机器的操作都仅限主机执行：`/model`、`/compact`、`/resume`、`/branch`、bash（`!`）、python（`$`）、skills 等。访客保留一个小型的本地白名单（`/dump`、`/export`、`/copy`、`/help`、`/hotkeys`、`/theme`、`/settings`、`/leave`、`/collab`、`/exit`、`/quit`）。

当访客在助手回合进行中接入时，该正在进行的回合会在下一次 `message_update` 中出现：访客会从该 update 的完整累积消息中合成缺失的 `message_start`，再转发增量。如果访客接入后主机不再发出该回合的进一步 update，则没有可用于合成实时部分的 update。持久化条目仍会到达副本的消息状态中，但 entry 帧会被刻意不渲染，因此这种边缘情况在实时 TUI 中可以保持不出现。

## Web 客户端

`packages/collab-web` 是一个独立的浏览器客户端，可使用同样的链接 —— 访客端无需安装 omp。中继服务器在 `/` 提供该客户端，这正是 `/collab` 深链接能够点击即加入的原因：`https://<relay>/#<link>` 会加载客户端并从 fragment 自动连接。它会渲染实时记录（流式文本、思考、工具卡片）、一个带按需记录的子代理面板，以及一个具有与访客同等权限（提示、中断、Hub 操作）的编辑器。在该包中运行 `bun run dev` 以启动本地实例，运行 `bun run mock-host` 以启动一个用于开发的离线脚本化主机，运行 `bun run build` 以输出可部署到任何位置（HTTPS 必需以使用 WebCrypto）的静态 `dist/`。该客户端仅与中继通信，密钥始终保留在 th…

当浏览器 UI 与 WebSocket 中继分开托管时，请设置 `collab.webUrl`。当为空时，`/collab` 会从 `collab.relayUrl` 推导 `http(s)://host[:port]`；显式的 Web UI URL 必须使用 `https://`，`http://localhost` 仅作为开发源例外。生成的浏览器 URL 仍然在 fragment 中携带特定中继的 collab 链接。

## 设置

| 设置                  | 默认值                | 含义                                                                                              |
| --------------------- | --------------------- | ------------------------------------------------------------------------------------------------- |
| `collab.relayUrl`     | `wss://my.omp.sh`     | 未内联传递中继时，`/collab` 使用的中继                                                            |
| `collab.webUrl`       | empty                 | `/collab` 链接的浏览器 UI URL；为空时由中继推导；显式 `http://` 仅允许 localhost                  |
| `collab.displayName`  | OS username           | 显示给其他参与者的名称                                                                            |
| `share.serverUrl`     | `https://my.omp.sh/s` | `/share` 使用的分享查看器/上传基址（链接为 `<base>/<id>#<key>`）                                  |
| `share.redactSecrets` | `true`                | 在上传前对 `/share` 快照运行密钥混淆器                                                            |

## 自托管中继

生产中继目前不提供自托管分发：其 Go 源码和独立二进制均未发布。下面的端点列表记录了托管服务的网络契约，而非可安装的发行版。

对于本地协议开发，本仓库在 [`packages/collab-web/scripts/local-relay.ts`](../packages/collab-web/scripts/local-relay.ts) 提供了一个源码可用、仅 WebSocket 的替代实现。在 `packages/collab-web` 下运行 `bun run relay` 以监听 `ws://localhost:7466`。它实现了 `/r/<roomId>`，但不提供浏览器客户端、`/share` blob 或 `/healthz`，因此不能替代生产服务。

中继是一个小型、对内容不感知的 Go 服务。它仅保留活动连接所需的状态，并提供：

- `GET /` —— 静态 collab-web 访客客户端（`/collab` 深链接的目标），
- `GET /r/<roomId>?role=host|guest` —— WebSocket 升级，
- `POST /s` / `GET /s/<id>` / `GET /s/<id>/raw` —— `/share` blob 上传、查看器页面以及 blob 获取，
- `GET /healthz` —— 存活探针。

## 架构说明

Hub 拓扑 —— 主机具有权威性，访客之间互不直接连接：

1. `welcome` + `snapshot-chunk` 帧 —— 初始状态和记录。记录按字节大小分块，以便每次到达都重置访客的进度超时；过大的复制条目在传输前会被缩减。
2. `entry` 帧 —— 持久化会话条目，在外部化 blob 之前广播，以保持图片内联（访客无法解析主机的 blob 引用）。访客会按保留的 id 将其追加到 `~/.omp/collab/<roomId>.jsonl` 副本会话文件以及代理的消息数组中，这就是 `/dump` 和上下文估算能够工作的原因。
3. `event` 帧 —— 实时代理事件，直接送入访客的常规事件控制器；为防止重复渲染，仅以事件方式进行渲染。
4. `state` 帧 —— 防抖的底栏快照：流式标志、主机的完整模型对象和思考级别（应用到访客的副本代理状态，因此模型显示和上下文窗口计算是原生的）、主机的上下文数字以及参与者。
5. `bus` 帧 —— 镜像的子代理生命周期/进度 EventBus 流量，在访客本地总线上重新发布，使子代理 HUD 和状态行计数能够以原生方式工作。
6. `agents` 帧 —— 代理注册表快照，馈送到访客本地的注册表，使 Agent Hub 表格能够渲染主机的子代理。
7. `ui-request` / `ui-request-end` 帧 —— 主机的 select/editor 提示，展示给具有完整控制权的访客，并在任意一处处理后于所有端关闭。访客通过 `ui-response` 进行应答。

访客→主机：`hello`、`prompt`、`abort`、`agent-cmd`（hub chat/kill/revive）、`fetch-transcript`（由定向的 `transcript` 帧应答的增量子代理记录读取），以及 `ui-response`。副本通过常规的 `/resume` 机制加载，因此主题、ctrl+o 以及记录行为天然就是原生的；访客进程永远不会 chdir 到主机的路径。
