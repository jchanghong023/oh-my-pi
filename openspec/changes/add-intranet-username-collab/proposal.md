# Proposal

## Why

公司内网的 CentOS 7 服务器由多人跨机器使用，需要直接共享正在运行的 OMP 会话。现有 `/collab` 依赖秘密邀请链接，默认指向公网 Relay；`omp collab` 只提供本机发现和链接获取，仓库自带 Relay 是需要 Bun 的开发脚本，不能满足只分发 OMP 二进制、按登录用户名加入的使用方式。

本变更仅在 `OMP_OFFLINE` 生效的 CentOS 7 进程中将使用入口收敛为：部署者运行 `omp collab serve`，客户端通过既有 `collab.relayUrl` 配置 `ws://<内网IP或主机名>:<端口>`，房主执行无参数 `/collab`，同事执行 `/join j00808874`。用户名发现直接使用同一服务器的 HTTP。非 offline 保持现有行为。

## What Changes

- 本次全部新增能力 MUST 仅在既有 `OMP_OFFLINE` 真值规则判定启用时生效，包括内置 Relay 服务、用户名登记／查找、跨机器单房间限制及用户名直接加入。非 offline 即使配置了内网 `collab.relayUrl` 也 MUST NOT 启用这些能力，不新增触发开关，不更改既有公网／自托管邀请链接流程。

- 仅为启用 `OMP_OFFLINE` 的 CentOS 7 x64 进程提供内置 Relay 启动命令 `omp collab serve`。部署机只需要兼容的 OMP 独立二进制，无需单独安装 Bun、Node.js 或拉取源码、依赖；不要求模型凭据，不创建模型会话。
- 多用户、多机器共用一个预配置的内网 Relay。复用 `collab.relayUrl` 直连普通 `ws://<内网IP或主机名>:<端口>`，用户名发现使用同一服务器的 HTTP；offline 客户端不得拒绝非 localhost 的该连接或强制升级 WSS。监听地址和端口可明确指定，不增加配置项、额外服务或公网回退。
- 用房主 OMP 进程实际所属的 Linux 登录用户名登记当前房间，例如 `j00808874`；不使用数字 UID、可修改的显示名或单独业务账号作为加入标识。用户名只是房间路由名，不是认证身份。
- 每个用户名在一个共享 Relay 范围内最多有一个活动房间，跨主机、进程和 profile 生效。同一宿主重复 `/collab` 复用；另一进程遇到占用时报告冲突及所在主机，不自动抢占或迁移会话。
- `/join <username>` 自动定位并加入当前房间，不要求复制邀请链接。保留既有邀请链接加入、本机发现、只读链接和房主／访客权限边界；不将本机 IPC registry 或共享 NFS 目录扩充为跨机器目录服务。
- 能访问该 Relay 的客户端知道用户名即可直接加入已主动共享的房间，读取历史、发送提示、打断及使用既有可写访客能力；不需要复制链接、证书、TLS／WSS／HTTPS、反向代理、SSO、token／共享凭据、认证或房主批准。不新增安全、加密、密钥管理或身份证明要求；若复用既有协作内部加密帧或令牌，不要求用户配置或操作。
- 停止共享、宿主退出或房间失效后，用户名不能再解析到旧房间；会话切换和 Relay 重启不得把旧访客静默带入另一会话，访客离开后恢复加入前的会话。真实失败须明确呈现，不以公网服务或错误房间替代。

### 验收边界

- 在 CentOS 7 x64 的无公网环境，Relay 与参与用户名协作的客户端均启用 `OMP_OFFLINE` 后，仅使用 OMP 独立二进制启动 Relay；客户端跨机器通过普通 WS 及同一服务器的 HTTP 完成无参数共享和用户名加入，无需任何证书或额外凭据。
- 两个不同用户名可同时共享且不串房；同一用户名并发登记只能成功一个；同事获得既有完整控制访客能力，工具仍在房主机器、以房主账号执行。
- 不在线、占用、缺少内网配置、连接失败、共享终止及房间换代均有确定结果；未完成加入不能显示为已连接。
- 非 offline（包括 `OMP_OFFLINE` 未设置、空值或非启用值）继续使用原有 `/collab`、邀请链接解析、默认／自定义 Relay 与权限规则；不进行用户名登记或查询、不应用跨机器用户名唯一限制、不开放本次直接加入授权，`omp collab serve` 仍按原有不支持操作处理且不监听端口。配置内网地址不绕过此门禁。

### 非目标与已确认取舍

- 不新增 Windows／其他 Linux 平台交付要求，不升级 CentOS 7 系统运行库，不要求 root，不自动安装或修改防火墙、证书与系统服务。
- 不交付浏览器 Web UI、手机入口、Web 静态资源、`/share` 存储、房间大厅、全网用户列表、SSO、跨域身份映射或多 Relay 集群。
- 不同步工作目录、不远程挂载文件、不把模型或工具执行迁移到 Relay，不允许同一人同时共享多个活动房间。
- 非 offline 的全部功能、默认值、配置、命令帮助与补全、网络请求及安全边界保持不变，不移除上游已有命令；offline 中非本次内网用户名流程仍沿用现有邀请链接行为。
- 不增加网络隔离部署、安全警告、认证防冒名或证书验收要求；非 offline 的既有安全策略保持不变。

## Capabilities

### New Capabilities

- `intranet-collaboration`: 仅 offline 启用的内网用户名定位、跨机器单活动房间、直接加入控制、房间隔离及生命周期语义。

### Modified Capabilities

- `fork-runtime`: 增加仅 offline 启用的 CentOS 7 独立二进制内置 Relay、内网入口配置及无公网运行边界，保持非 offline 运行行为。
- `personal-commands`: 增加仅 offline 启用的内网无参数 `/collab`、`/join <username>` 及其与既有 TUI 命令的可观察行为，保持非 offline 命令语义。

## Impact

- CLI／发行入口涉及 `packages/coding-agent/src/commands/collab.ts`、命令帮助及现有 OMP 独立二进制打包链路；不依赖部署机额外 Bun 命令。
- 会话侧涉及 `packages/coding-agent/src/slash-commands/builtin-collaboration.ts`、`src/collab/` 及共享协作协议；复用现有房主权威会话与访客复制链路，不另建执行引擎。
- 现有 `packages/collab-web/scripts/local-relay.ts` 仅提供协议参考，其开发用途不等于已具备正式内网服务；本次不将整个 collab-web 产品纳入交付。
- 既有协作说明后续需区分 offline 用户名直连流程与非 offline 邀请链接流程，不把本次免证书、无认证的使用方式扩展到非 offline。
- 后续实现需同步 CLI 帮助、协作说明和内网快速指南；已有规格的 offline 触发方式、配置／缓存根、日志规则及非 TUI 命令门禁保持不变。
