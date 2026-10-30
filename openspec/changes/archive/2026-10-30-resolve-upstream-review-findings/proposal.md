# Proposal

## Why

针对 `upstream...HEAD` 既有文件的逐文件审查，发现若干实现、设置说明与已批准需求不一致，以及部分 fork 行为变更没有明确需求。用户已逐项决定保留并记录少数行为，其余指定行为恢复上游。本变更把这些决定和已确认的不一致纳入可审查的需求，避免将缺失需求直接当作代码缺陷，也不把静态发现冒充运行验证。

## What Changes

- 保留 managed-skills 根目录拒绝符号链接，以及多行输入中非末行的输入法安全布局，并明确其可观察边界。
- 按用户选择，将 HTML 会话导出、CodeAgent 的 commit 消息与标题生成失败回退、Provider 原始错误码扩展、扩展工具宽松校验、恢复请求的推测执行、服务启动后日志读取失败回执、Web Search 失败回执、Spinner 速度、Robomp GitHub 请求失败处理、JTD 转换与归档编码取消恢复为对应上游行为。恢复范围仅限上述已确认差异；不借此撤销其他已批准的 fork 功能。
- `xd://` 设备写入只以 `?` 请求设备文档，不再把空内容和 `help` 当作该帮助入口；空内容和 `help` 的其他处理沿用既有设备协议。
- 修复 `spec-executor` 必需委派与等待能力、ZCode 本地产物版本校验、native 替换后让位文件清理、LSP 未应用动作的成功状态、Windows `timeout -k` 取消回退退出码、`local -p` 诊断命令名、显示档位旁路开关、设置页汉化和深色主题文档默认值与现有需求不一致的问题。
- 以审查所用的已集成上游基线 `95db18ef9936bff96fbd33268b2363ab25a9bb9d` 为本次“恢复上游”的对照；若后续实际实施前上游基线变化，须在实施前核对并明确对照范围，不能静默改变已确认的行为或撤销无关 fork 能力。

## Capabilities

### New Capabilities

- 无。

### Modified Capabilities

- `fork-maintenance`：记录用户指定的有限上游行为恢复及其与现有 fork 契约的边界。
- `model-and-skill-discovery`：明确 managed-skills 符号链接根目录的管理边界及恢复请求推测执行的上游行为。
- `model-providers`：明确 CodeAgent 在 commit 和标题消费者中的上游回退边界，不改变其他已批准消费者的重试约束。
- `personal-commands`：明确 `xd://` 帮助入口和 LSP 动作的真实成功／失败状态。
- `shell-semantics`：落实声明命令诊断和 Windows timeout 取消回退退出码。
- `spec-driven-orchestration`：落实执行代理委派实施、审查和等待所需的原生能力。
- `fork-runtime`：落实 ZCode 本地构建产物的版本前置条件。
- `fork-verification-gates`：落实 native 换入成功后的让位文件清理。
- `tui-presentation`：明确多行输入法安全布局，落实显示档位、主要设置页汉化及深色主题文档一致性。

## Impact

影响模型与工具接口、HTML 导出、技能管理、交互显示、Robomp、归档编码及构建产物；具体行为以各能力的增量规格为准。恢复上游仅指用户逐项选择的范围，不得借此回滚或改写无关的 fork 既有／新增行为，也不改变上游基线元数据。需求与当前实现不一致时，以经批准后的规格为目标；本提案不声称现有实现或软件验证已经通过。

本轮仅创建 proposal 和增量规格，不创建设计或任务文档，不修改代码、同步主规格、归档变更或运行软件验证。上述具体行为选择已由用户确认；没有需要在需求阶段再次向用户询问的未决选择。
