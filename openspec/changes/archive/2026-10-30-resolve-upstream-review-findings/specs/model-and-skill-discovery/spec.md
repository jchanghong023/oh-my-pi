# Spec Delta

## ADDED Requirements

### Requirement: Managed Skills 根目录符号链接边界

OMP MUST 拒绝通过符号链接形式的 managed-skills 根目录进行管理操作，避免修改该目录外的用户文件。

#### Scenario: 管理根是符号链接
- **WHEN** managed-skills 根目录是符号链接，包括指向现存目录的有效链接
- **THEN** 管理写入、更新和删除 MUST 明确失败，MUST NOT 跟随该根链接修改或删除目标中的技能文件。

#### Scenario: 管理根不是符号链接
- **WHEN** managed-skills 根目录是普通目录或尚不存在
- **THEN** 沿用现有目录创建、文件安全检查和技能管理行为；此限制 MUST NOT 禁止其他已批准的共享技能发现目录使用既有规则。

### Requirement: 恢复请求的推测执行沿用上游

OMP MUST 移除仅因 `recoverModelRequest` 而禁用推测执行的 fork 例外，并对该请求沿用审查基线的上游推测执行启用与取消规则。

#### Scenario: 恢复请求开启或关闭推测执行
- **WHEN** 恢复模型请求且推测执行配置启用或关闭
- **THEN** 是否推测执行 MUST 按上游既有配置、准入及生命周期规则决定，不得仅因恢复标记而额外禁用；现有预算、安全和取消边界继续生效。
