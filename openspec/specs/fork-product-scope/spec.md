# fork-product-scope

## Purpose

规定个人 fork 的终端使用场景、零配置目标及验收条件。终端 TUI 以本 fork OMP 为 Agent 核心。

## Requirements

### Requirement: 项目定位与使用场景

OMP MUST 使用本 fork OMP 作为 Agent 核心，并按真实终端入口完成消息、模型与工具验收。

#### Scenario: 项目定位与使用场景的详细边界

- **WHEN** 本节所述功能在适用条件下运行
- **THEN** 以下具体约束适用：

终端使用本 fork 的 OMP 作为 Agent 核心，目标为零配置文件、开箱即用：

| 场景 | 使用目标 | 具体契约 |
| --- | --- | --- |
| 终端 TUI | 直接使用 OMP 原生终端交互入口，跟进上游能力，并带有本 fork 的个人默认值；公司无互联网环境通过 `OMP_OFFLINE=1` 使用本地资源和公司内部模型服务，日常启动与核心任务不依赖公网 | [默认设置](../fork-runtime-defaults/spec.md)、[快捷键与状态栏](../tui-presentation/spec.md)、[公司内网模型](../model-providers/spec.md)、[安装与运行](../fork-runtime/spec.md)；[新手快速指南](../../../docs-zh-CN/quick-start-intranet.md) |

- **零配置文件**：默认使用不要求用户手工创建、填写或修改 OMP 配置文件；所需默认值由内置行为、场景启动参数和已有环境信息提供。模型服务可达及必要认证仍是使用前提；公司环境复用既有 Claude Code 配置的具体约定见[公司内网模型](../model-providers/spec.md)，不要求另配一份 OMP 凭据。
- 用户仍可主动调整偏好并由程序持久化；可选设置不能成为默认使用的必经步骤。零配置不禁止程序保存会话、缓存或用户主动选择。
- **验收目标**：在未手工提供 OMP 配置文件、对应服务与认证已就绪的条件下，从真实终端入口完成消息发送、模型响应和工具执行；公司场景在无公网条件下完成。
- 高频同步与最小业务代码差异的维护原则统一见 [Fork 维护约束](../fork-maintenance/spec.md)。

#### Scenario: 项目定位与使用场景的可观察行为

- **WHEN** 零配置启动终端 TUI
- **THEN** 使用本 fork OMP 作为 Agent 核心，并按真实入口完成消息、模型与工具验收
