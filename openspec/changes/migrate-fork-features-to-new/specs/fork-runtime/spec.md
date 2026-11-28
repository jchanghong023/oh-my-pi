# Spec Delta

## Purpose

规定公司内网和普通模式的启动、数据目录、网络和诊断行为，保留用户可配置的运行默认值，并区分内网模式与单次模型离线设置。

## ADDED Requirements

### Requirement: 公司内网模式和单次离线

`OMP_OFFLINE` MUST 启用公司内网模式，优先使用本地资料、可用技能和已配置的内网服务；停用外部网页搜索和浏览器工具，保留已启用的 HTTP，不向公网刷新凭据。

#### Scenario: 组合使用内网模式与离线参数
- **WHEN** 只指定 `--offline`，或同时设置 `OMP_OFFLINE` 和 `--offline`
- **THEN** `--offline` 仅覆盖当次模型离线设置，不单独启用公司内网模式，且可与公司内网模式并用。

### Requirement: 持久配置和内网运行数据

`OMP_CONFIG_ROOT` MUST 接受绝对路径和以 `~` 开头的路径，以指定配置、凭据及会话的持久目录。公司内网红区运行需要同时设置 `OMP_OFFLINE` 和可写的绝对配置路径。

#### Scenario: Linux 公司内网模式
- **WHEN** 在 Linux 上以公司内网模式运行
- **THEN** 默认将缓存、运行日志及统计数据放入 `/dev/shm/omp-<用户编号>`；配置、凭据和会话留在持久目录。

### Requirement: 常用能力的运行默认值

OMP MUST 默认跳过启动设置向导、关闭语言服务和 AI 辅助提交；用户仍可手动打开向导或开启相关功能。

#### Scenario: 默认启动和显式启用
- **WHEN** 用户用默认设置启动，或显式开启语言服务或 AI 辅助提交
- **THEN** 默认不自动进入向导或启用上述能力；AI 辅助提交的开关同时约束 `/commit` 和 Eval 的提交入口。

### Requirement: 主会话后台任务上限

OMP MUST 默认限制每个主会话同时运行至多 32 个后台任务，含派生任务，并允许调低上限。

#### Scenario: 后台工作达到上限
- **WHEN** 当前主会话的后台任务和派生任务合计达到其上限
- **THEN** 拒绝新后台任务。

### Requirement: 按需探测 Python

启动、创建或恢复会话 MUST 不探测 Python，实际运行 Python Eval 时才探测。

#### Scenario: Linux 公司内网 Python Eval
- **WHEN** 在 Linux 公司内网模式下首次实际运行 Python Eval
- **THEN** 优先尝试预设的 Python 3.11 路径，不可用时再查找兼容解释器。

### Requirement: Windows 主进程代理

Windows 主进程的 HTTP(S) 请求 MUST 支持系统静态代理及按公司地址规则直连内网站点。

#### Scenario: 显式代理覆盖系统规则
- **WHEN** 应用或环境变量显式配置代理
- **THEN** 显式设置先于系统代理默认和公司地址规则。

### Requirement: HTTPS 证书策略的适用范围

OMP 使用 Node 或托管 Git 发起的 HTTPS 请求 MUST 支持清单规定的默认宽松证书策略，显式 TLS 或 Git 设置优先；安装器和 `omp update` 读取发行元数据时 MUST 严格校验证书。

#### Scenario: 运行请求与发行元数据使用不同策略
- **WHEN** OMP 发起受该默认值影响的请求，或安装器、`omp update` 读取发行元数据
- **THEN** 运行请求尊重显式覆盖；安装和更新的发行元数据均不继承运行请求的宽松策略，并拒绝证书校验不通过的连接。

### Requirement: 运行诊断日志

OMP MUST 记录可关联的操作阶段、耗时和结果，区分失败、超时、取消、降级、部分提交与未知；日志不得记录凭据和请求正文。

#### Scenario: 内网模式记录警告和错误
- **WHEN** 公司内网模式记录警告或错误且未显式调整日志级别
- **THEN** 警告和错误默认即时写入；用户可通过 `OMP_LOG_LEVEL` 调整级别。
