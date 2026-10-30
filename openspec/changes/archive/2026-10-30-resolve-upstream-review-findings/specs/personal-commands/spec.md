# Spec Delta

## ADDED Requirements

### Requirement: 设备文档查询入口

OMP MUST 仅将向 `xd://` 设备写入的 `?` 识别为本次指定的设备文档请求。

#### Scenario: 请求设备文档
- **WHEN** 用户或 Agent 向设备写入 `?`，允许其周围空白
- **THEN** MUST 返回该设备文档，而不执行设备动作。

#### Scenario: 空内容和 help 不是文档入口
- **WHEN** 向设备写入空内容或 `help`，包括不同大小写
- **THEN** MUST NOT 仅因该内容返回设备文档；MUST 按该设备既有输入、校验及错误规则处理，不能据此猜测执行成功。

### Requirement: LSP code action 应用结果状态

OMP MUST 使 LSP code action 的结构化成功状态与实际应用结果一致。

#### Scenario: 未指定动作
- **WHEN** `code_actions` 指定 `apply=true` 但 `query` 缺失或仅含空白
- **THEN** MUST 不应用任何动作，并以失败状态和明确提示返回；`details.success` MUST 为 `false`，工具结果 MUST 标记失败，不能以成功状态报告该次应用。

#### Scenario: 指定并应用动作
- **WHEN** `apply=true` 且有效选择器匹配可应用动作并实际成功应用
- **THEN** MUST 保留已应用动作与结果的真实成功反馈；取消、选择失败或应用失败不得伪报成功。
