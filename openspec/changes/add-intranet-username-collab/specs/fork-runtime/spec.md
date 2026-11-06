# Spec Delta

## ADDED Requirements

### Requirement: CentOS 7 内置协作 Relay 独立运行

OMP MUST 仅在 CentOS 7 x64 进程按既有规则启用 `OMP_OFFLINE` 时提供 `omp collab serve`，由兼容目标系统现有运行库的同一个 OMP 独立二进制运行内网 Relay 及用户名登记能力，不调用外部 Bun／Node.js，不要求源码、依赖安装、模型凭据或模型配置。该入口 MUST 独立于交互 TUI 和模型会话运行，MUST NOT 为启动 Relay 创建 Agent 或发起模型请求。

#### Scenario: 只有 OMP 二进制的离线部署

- **WHEN** CentOS 7 x64 部署机已提供兼容的 OMP 独立二进制，当前进程启用 `OMP_OFFLINE`，但没有 Bun、Node.js、项目源码或模型凭据，执行 `omp collab serve`
- **THEN** 在已配置的服务监听地址与端口启动 Relay，支持多个用户名和多个独立房间，并报告实际监听位置
- **AND** 不尝试安装运行时或依赖、不访问公网、不进入 TUI 或弹出模型配置向导
- **AND** 启动不要求 root 或升级系统运行库，不自动修改防火墙或系统服务

#### Scenario: 端口占用或监听失败

- **WHEN** 监听地址不可用、端口已占用或进程没有所需权限
- **THEN** 报告具体启动失败并以非零退出，不宣称服务已就绪，不自动转用未告知的地址或端口

#### Scenario: 退出 Relay

- **WHEN** 部署者向前台 Relay 进程发送正常终止信号
- **THEN** 终止监听与活动连接，使原房间和用户名登记不再被视为可加入，不遗留外部 Bun 子进程

#### Scenario: 非 offline 不提供 Relay 服务入口

- **WHEN** 当前进程未启用 `OMP_OFFLINE`，即使已有内网 Relay 配置，用户调用 `omp collab serve`
- **THEN** 继续按原有不支持操作的命令行为处理，不启动监听、不登记用户名、不初始化本次内网服务
- **AND** 非 offline 的既有命令帮助与补全不新增可用的 `serve` 入口，其他 CLI、TUI、模型与工具行为保持不变

### Requirement: 内网共享入口由部署配置统一提供

仅在 `OMP_OFFLINE` 生效时，本次内网协作 MUST 复用 `collab.relayUrl`，直接连接普通 `ws://<内网IP或主机名>:<端口>`，用户名发现 MUST 使用同一服务器的 HTTP。部署者 MUST 能明确指定 Relay 监听地址与端口，不增加配置项或额外服务，不要求用户每次共享或加入时输入地址。配置或连接失败 MUST 可见，MUST NOT 猜测公司地址或回退公网。非 offline MUST 保留该设置的原有语义，不因其指向内网而启用本次能力。

#### Scenario: 不同机器使用同一入口

- **WHEN** 房主与访客 OMP 进程均启用 `OMP_OFFLINE`，且机器已通过现有 OMP 设置机制配置同一内网 `collab.relayUrl`
- **THEN** 无参数 `/collab` 和 `/join <username>` 均使用该入口，不读取另一机器的本机 IPC registry 来完成用户名发现
- **AND** 不要求各用户分配独立 Relay 进程或独立端口

#### Scenario: offline 中未配置内网服务

- **WHEN** `OMP_OFFLINE` 已启用，用户尝试内网无参数共享或用户名加入，但没有显式的内网 Relay 配置、仍将使用内置公网默认地址
- **THEN** 在连接公网之前明确提示需要配置内网 `collab.relayUrl`，不向默认公网 Relay 查询用户名或发布会话
- **AND** 不自动写配置、不猜测内网域名、不新增 offline 命令行开关

#### Scenario: offline 跨机器普通 WS 直接共享与加入

- **WHEN** CentOS 7 x64 房主与访客均启用 `OMP_OFFLINE`，并将 `collab.relayUrl` 配置为同一内网服务器的普通 `ws://<IP或主机名>:<端口>`
- **THEN** 房主无参数 `/collab` 用系统登录用户名登记房间，另一机器的同事执行 `/join <username>` 时由 OMP 通过同一服务器 HTTP 自动查找并直接加入
- **AND** 不需要证书、TLS／WSS／HTTPS、反向代理、SSO、token／共享凭据、认证或房主批准，不要求复制邀请链接
- **AND** offline 客户端不因该 WS 地址不是 localhost 而拒绝连接，也不强制升级为 WSS；复用既有协作内部帧或令牌不要求用户配置或操作

#### Scenario: 既有运行约定保持不变

- **WHEN** 运行内网 Relay 或客户端协作流程
- **THEN** 继续遵循既有 `OMP_OFFLINE` 真值、配置根、缓存根、profile 及日志规则，不为本能力改变数字 UID 在缓存目录中的原有用途
- **AND** 不把公司模型配置变为纯 Relay 服务的启动前提，不自动启用浏览器、抓取、搜索或其他 offline 下被禁用的工具

#### Scenario: 非 offline 的设置与网络行为保持不变

- **WHEN** OMP 未启用 `OMP_OFFLINE`，无论 `collab.relayUrl` 采用默认值、显式公网地址或内网地址
- **THEN** 保持原有设置解析、默认值、协作网络请求及授权语义，不进行本次用户名登记或发现，不追加内网配置要求或限制原有公网协作
- **AND** 不自动改写配置、不启用本次内网运行策略，不改变非 offline 的邀请链接、只读、解析、认证及传输安全策略或其他功能
