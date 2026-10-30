# Spec Delta

## ADDED Requirements

### Requirement: 审查指定差异恢复上游行为

OMP MUST 对本次用户明确选定的行为恢复审查基线 `95db18ef9936bff96fbd33268b2363ab25a9bb9d` 的上游语义，且 MUST 保留其他已批准的 fork 功能。对照仅限以下命名行为；不将整个文件或包回滚，不修改上游基线记录。

#### Scenario: 会话 HTML 导出资源
- **WHEN** 生成会话 HTML 导出
- **THEN** viewer、Markdown 和代码高亮资源的选择、加载与失败提示 MUST 按该基线的上游规则；开发检出与发行产物分别沿用其原有路径，不再要求所有发行路径内联资源或离线可用。

#### Scenario: Provider 错误码和扩展工具校验
- **WHEN** Provider 错误经本次差异涉及的错误提取与输出路径返回，或扩展作者提供不符合 schema 的工具参数
- **THEN** Provider 原始错误码的新增提取、优先级和传播 MUST 恢复该基线对应行为；扩展工具对 schema 不匹配参数 MUST 沿用上游通用校验，不再提供本次新增的扩展工具 `lenientArgValidation` 选项。
- **AND** 恢复范围不包括已批准的内建工具参数反馈和其他已批准工具能力；不得因移除扩展选项删除这些能力。

#### Scenario: 服务日志与 Web Search 失败回执
- **WHEN** 已启动服务的日志读取失败，或 Web Search 未配置模型／所有候选均失败
- **THEN** 对应失败传播和工具回执 MUST 恢复该基线的上游行为；不得保留本次新增的服务日志失败专用回执或 Web Search `isError` 标记。
- **AND** 服务是否已启动属于实际状态，不得声称失败回执使已启动服务自动撤销；不改变已批准的服务参数校验或 native PipeStreams 降级要求。

#### Scenario: Robomp GitHub 请求失败
- **WHEN** PR 元数据解析、PR 审查、review 处理或 PR 对话处理中的本次指定 GitHub 请求发生 `GitHubError`
- **THEN** 对应路径 MUST 恢复该基线捕获错误、记录 warning 后返回的行为；其他异常和未指定路径 MUST 保持既有行为。

#### Scenario: JTD 转换与归档编码
- **WHEN** 将 JTD 转为 JSON Schema，或调用归档编码
- **THEN** 本次涉及的 JTD form、根 definitions、引用转义及附加属性语义 MUST 恢复该基线的上游转换行为；归档编码 MUST 不保留本次新增的 `AbortSignal` 编码取消接口和相应取消检查。
- **AND** 恢复不得改变其他已批准的工具协议、归档读写功能或权限边界。

#### Scenario: 上游对照变化或行为冲突
- **WHEN** 实施前上游基线已经变化，或恢复指定差异会与其他已批准 fork 契约冲突
- **THEN** MUST 明确核对原审查基线与受影响契约，不得静默扩大回滚；无法同时满足时 MUST 报告冲突并在改变已确认范围前获得用户决定。
