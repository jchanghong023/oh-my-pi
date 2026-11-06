# Spec Delta

## ADDED Requirements

### Requirement: 内网无参数共享与用户名加入命令

CentOS 7 原生 TUI MUST 仅在进程启用 `OMP_OFFLINE` 时支持本次用户名流程。使用既有 `collab.relayUrl` 配置普通 `ws://<内网IP或主机名>:<端口>` 后，裸 `/collab` MUST 共享当前会话并用实际登录用户名登记，`/join <username>` MUST 按 [内网协作](../intranet-collaboration/spec.md) 的单房间规则直接加入，无需证书、TLS、反向代理、认证、额外凭据或房主批准。非 offline MUST 保持原有命令语义。

#### Scenario: 房主只输入 collab

- **WHEN** 登录用户名为 `j00808874` 的用户在启用 `OMP_OFFLINE` 且将 `collab.relayUrl` 配置为普通远端 `ws://` 地址的 TUI 输入 `/collab`
- **THEN** 当前会话成功共享后显示实际共享状态、登录用户名以及可供同事使用的 `/join j00808874`
- **AND** 不要求填写用户名、另建账号、配置证书或在命令后追加 Relay 地址

#### Scenario: 同事只提供房主用户名

- **WHEN** 同事在另一台 CentOS 7 机器启用 `OMP_OFFLINE`、配置同一普通远端 `ws://` Relay 后输入 `/join j00808874`，房主已有有效共享
- **THEN** 通过同一服务器的 HTTP 查找并直接加入该用户名房间，无需复制链接、认证、额外凭据或房主批准
- **AND** 仅在当前房间加入完成后显示成功，失败保持或恢复原本地会话并明确提示原因

#### Scenario: 当前用户名已在其他宿主共享

- **WHEN** 用户在另一进程或机器执行 `/collab`，同一用户名已有活动房间
- **THEN** 显示已有房间所在主机及加入命令，不将本进程当前会话伪装为已共享，不自动终止对方房间

#### Scenario: 非 offline 的 collab 不登记用户名

- **WHEN** 用户在未启用 `OMP_OFFLINE` 的 TUI 执行 `/collab`，即使已配置内网 `collab.relayUrl`
- **THEN** 继续执行原有分享及邀请链接行为，不向 Relay 登记登录用户名，不施加跨机器每用户名一个房间的限制
- **AND** 不新增用户名加入提示，不改变原有默认 Relay、命令帮助、补全或授权方式

#### Scenario: 非 offline 不将 join 参数解析为用户名

- **WHEN** 用户在未启用 `OMP_OFFLINE` 的 TUI 输入 `/join j00808874`
- **THEN** 按原有邀请链接解析及错误反馈处理，不将该参数作为用户名查询，不发送用户名发现或加入请求，不开放内网直接加入控制
- **AND** 有效的邀请链接仍按原有方式加入，不追加 offline 模式或内网配置要求

### Requirement: 用户名加入保留既有协作命令与退出语义

用户名加入 MUST 扩展现有协作命令链路，而不是替换邀请链接解析或另建访客模式。既有 `/join <link>`、`omp join <link>`、`/collab status`、`/collab stop`、`/leave` 和本机 `omp collab list/link` MUST 保持原有用途；非 TUI 命令门禁 MUST 不因新增用户名解析而放宽。本次 MUST NOT 宣称交付 GUI、浏览器或非 TUI 的用户名加入入口。

#### Scenario: 既有邀请链接继续可用

- **WHEN** 用户向 `/join` 提供原本支持的完整协作链接
- **THEN** 继续按链接中的 Relay、房间和权限加入，不将有效链接解释为用户名，不将只读链接升级为控制权限

#### Scenario: 访客退出与房主停止

- **WHEN** 通过用户名加入的访客执行 `/leave`
- **THEN** 按既有访客离开流程恢复其原本地会话，不停止房主共享
- **WHEN** 房主执行 `/collab stop` 或房主语义下的 `/leave`
- **THEN** 结束共享并撤销该活动用户名登记，后续同事不能继续加入旧房间

#### Scenario: 本机发现不冒充全网目录

- **WHEN** 用户执行 `omp collab list`、`omp collab link` 或 TUI 的 `/collab list`
- **THEN** 保持原有本机发现与显式链接获取用途，不将输出宣称为全部机器或全部用户的共享列表

#### Scenario: 非 TUI 宿主不隐式执行

- **WHEN** ACP 或 RPC 宿主收到新增的用户名协作命令调用
- **THEN** 继续遵循现有命令可执行性和参数门禁，不隐式启动 TUI、房间或 Relay，不将仅 TUI 可用的流程冒充已成功执行
