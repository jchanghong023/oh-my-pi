# Spec Delta

## Purpose

让普通模式 Windows 用户可显式选择额外模型，让公司内网用户复用已有认证和角色默认值，并明确凭据刷新和向量回退的适用条件。

## ADDED Requirements

### Requirement: Windows CodeAgent 模型

普通模式 Windows MUST 支持手动选择内置 CodeAgent，凭据取自 Windows 当前用户注册表。

#### Scenario: CodeAgent 凭据被拒绝
- **WHEN** CodeAgent 请求因认证被拒绝
- **THEN** 提示当前请求的错误，只重新读取一次注册表凭据；新值只用于后续请求，不重放失败请求。

### Requirement: Windows Ascend 模型

普通模式 Windows MUST 提供内置 Ascend 模型，以 `ASCEND_API_KEY` 认证；支持文本、推理和工具，部分型号支持图片。

#### Scenario: 显式选用 Ascend
- **WHEN** 用户配置 `ASCEND_API_KEY` 并选择 Ascend 模型
- **THEN** 可发起该型号支持的请求，图片支持按型号决定。

### Requirement: 公司模型认证

公司内网模式 MUST 复用有效的 Claude 配置调用公司模型，无需另行登录；凭据变更在重启后生效。

#### Scenario: 公司凭据无效
- **WHEN** 公司认证无效且请求依赖公司模型
- **THEN** 提示原因并让该请求失败，不回退到公网模型；用户更新凭据后需重启。

### Requirement: 公司模型角色和上下文

公司模型可用且角色未配置时，系统 MUST 用 `GLM-5.3-public` 处理对话、计划和深度任务，用 `Qwen3.8-27B` 处理轻量任务、子任务、识图和顾问，用 `Qwen3.6-35B-A3B` 处理微型任务和提交说明。

#### Scenario: 缺省角色与显式选择
- **WHEN** 公司模型可用且用户未配置角色，或用户显式配置角色或手动选模
- **THEN** 无配置的角色采用上述默认值；显式配置或手动选择优先。

#### Scenario: 上下文按模型限制
- **WHEN** 内网模式选择 `company/Qwen3.8-27B` 或其他 `company` 聊天模型
- **THEN** 前者上限为 262144 token；其他聊天模型默认为 204800 token，有专门限制者以对应规则为准。

### Requirement: 未知模型思考探测

OMP MUST 默认不探测未知模型是否支持思考，并允许在设置中开启该行为。

#### Scenario: 使用未知模型
- **WHEN** 用户选择未知模型且未显式开启探测
- **THEN** 不进行能力探测；开启设置后允许探测。

### Requirement: 会话记忆向量模型

会话记忆 MUST 默认使用多语言向量模型。公司模式仅在记忆已启用、认证有效且无显式向量设置时允许使用公司文本向量服务；不得向显式配置的其他向量地址发送公司凭据。

#### Scenario: 使用公司默认向量服务时临时过载
- **WHEN** 符合公司默认向量条件且公司服务临时过载
- **THEN** 一次操作至多请求四次；显式向量设置不被公司默认值覆盖。

#### Scenario: 使用显式配置的其他向量地址
- **WHEN** 公司模式下启用了会话记忆且公司认证有效，但用户显式配置了其他向量地址
- **THEN** 显式地址优先，发往该地址的请求不携带公司默认凭据。
