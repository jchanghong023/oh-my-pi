# Stream：直播你的终端

`omp stream` 将你的 omp 会话广播到 `live.omp.sh/<username>` —— 一个 Twitch 风格的页面，包含实时终端和一栏聊天。观众看到的正是你的终端所显示的内容（机密除外）；他们无法向会话输入内容。

Stream 独立于 [Collab](collab.md)。Collab 把会话本身（条目、事件、提示词）复制给可以驱动 agent 的访客；Stream 只把渲染后的屏幕行单向发送给观众。

## 快速开始

直播需要一个 stencil.so 账号。在任意 omp 会话中用 `/login` → **Stencil（stencil.so 账号）** 登录一次即可；该凭据与你其他的登录一起存储并自动刷新。对于脚本和本地开发，`STENCIL_API_KEY=<token>` 会覆盖存储的凭据；`STENCIL_AUTH_URL` 将登录（`auth.stencil.so`）、`STENCIL_BASE_URL` 将 Stencil API（`api.stencil.so`）重新指向本地服务器。

你的 Stencil 用户名就是频道。服务器从 bearer token 推导它，因此 `omp stream` 不接受频道参数。

在你工作的目录中：

```
omp stream --title "Refactoring the parser"
```

输出：

```
● live.omp.sh/your_username  "Refactoring the parser"
  waiting for sessions in /work/proj …
```

然后在另一个终端于同一目录启动 omp（次数不限）。在 `omp stream` 运行期间启动的每个会话都会自动接入，并在其页脚显示 `● LIVE 3`（`3` = 当前观众数）。观众页面把每个会话显示为各自的窗格；会话退出时其窗格随之消失。在推流端按 Ctrl-C 会结束广播，每个已接入的会话都会去掉其徽标。

在 `omp stream` 启动之前就已经在运行的会话不会被接入——请重启它们。

### Streamer 控制台

在终端上，`omp stream` 是一个全屏聊天控制台：头部包含直播徽标、频道、标题、你的 stencil.so 用户名、观众 URL、观众数和已接入的窗格；中部是聊天与事件的日志；底部是输入行。

| 输入             | 效果                                                    |
| ---------------- | ------------------------------------------------------- |
| `<text>` + Enter | 以频道所有者身份发送聊天消息                            |
| `/title <text>`  | 更改直播标题                                            |
| `/quit`、Ctrl-C  | 停止直播（会话脱离，频道下线）                          |
| 上 / 下          | 回溯之前的消息                                          |

`--no-tui`（或非 TTY 的 stdout/stdin）会退化为行日志模式，此时 stdin 的每一行都作为聊天发送。

### 选项与设置

| 标志 / 设置              | 含义                                                                             |
| ------------------------ | -------------------------------------------------------------------------------- |
| 频道                     | 你的 Stencil 用户名，由服务器从 bearer token 推导                                |
| `--title <text>`         | 直播标题（默认：目录名）                                                         |
| `--server <url>`         | 流服务器地址（默认：`stream.serverUrl`）                                         |
| `--no-tui`               | 行日志控制台，代替全屏聊天                                                       |
| `STENCIL_API_KEY`        | Bearer token 覆盖；否则使用 `/login` 的 Stencil 凭据                             |
| `stream.serverUrl`       | 默认服务器，`https://live.omp.sh`                                                |
| `stream.redactPatterns`  | 从每个被流式发送的行中遮蔽的额外正则表达式                                       |

## 哪些内容会离开机器

只有终端行。会话进程会：

1. 获取 TUI 刚刚绘制的行（scrollback 提交和实时视口）。
2. 去除文本样式（SGR）和超链接（OSC 8）之外的所有转义序列；内联图片变为 `[image]`。
3. **脱敏**该行（见下文）。
4. 与上次发送的视口做 diff 并发送行补丁——从不发送会话条目、提示词、工具参数或作为数据的文件内容。

行通过一个私有本地 socket（`0600`，位于按目录划分的 omp 运行时目录之下）传给 `omp stream` 进程，后者把多个会话多路复用成窗格，并通过 WSS 以明文转发给服务器。服务器在内存中保留每个窗格的视口和最近 2000 行历史，以便迟到的观众获得快照；任何内容都不持久化。

### 脱敏

脱敏不可逆且有意过度匹配。任何匹配都会把该段文本替换为 `••••••`；有匹配的行以无样式方式发送。来源：

- 名称看起来是机密的环境变量的值（`*_KEY`、`*_TOKEN`、`*_SECRET`、`*PASSWORD*`……），以及从该目录的 `.env` 文件加载的每一个值，无论名称如何（8+ 字符）。
- `.omp/secrets.yml` 和 `~/.omp/agent/secrets.yml` 条目。
- 凭据形状（GitHub/GitLab/OpenAI/Anthropic/AWS/Slack/Stripe/npm/HF token、JWT、PEM 块、`Bearer …`）。厂商前缀的匹配**没有**长度门槛，因此 token 在被逐字符输入或流式输出时就会被遮蔽。
- `NAME=value`、`NAME: value`、`"NAME": "value"`，其中 `NAME` 看起来是机密——值会被遮蔽（覆盖屏幕上的 `read .env` 和配置文件）。
- 连接 URL 中的密码（`scheme://user:password@host`）。
- `stream.redactPatterns`。

已知的明文值还会按前缀（6+ 字符）匹配，因此部分输入的机密在完成之前就会被遮蔽。

脱敏无法知道它从未见过的机密：一个从别处粘贴、既不匹配任何形状也不匹配任何已配置值的 token 会被显示出来。对任何不寻常的内容使用 `stream.redactPatterns` 或 `secrets.yml`，并且优先选择暂停：暂停窗格的观众会看到一张 `BRB` 卡片。

## 服务器

`live.omp.sh` 是一个小型 Go 服务（stencil `apps/live`）：频道目录（`GET /api/channels`、`GET /api/channels/<name>`）、主页预览（`GET /api/channels/<name>/preview` —— 第一个窗格的视口，从不计为观众）、基于身份派生的主机 socket（`/ws/host`）、观众 socket（`/ws/watch/<name>`）、带每观众限速的聊天，以及 web UI（终端行以从 `/fonts/` 提供的完整 Berkeley Mono Nerd Font 渲染）。线上格式位于 `@oh-my-pi/pi-wire/stream`。

主机使用 stencil.so bearer 进行认证（主机 socket 上的 `Authorization: Bearer …`）；服务器针对签发者的 JWKS（`LIVE_ISSUER`、`LIVE_TOKEN_AUDIENCE`）验证它，或者在本地开发环境下，使用与 `STENCIL_API_KEY` 配对的静态 `LIVE_DEBUG_TOKENS` 列表。它直接从已认证的 Stencil 用户名派生每个主机的频道，因此观众总能在 `live.omp.sh/<username>` 找到账号。观众保持匿名。
