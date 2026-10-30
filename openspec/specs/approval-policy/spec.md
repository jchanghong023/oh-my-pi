# approval-policy

## Purpose

规定工具调用的授权确认模式、默认值、各模式的放行边界，以及模式与用户逐工具策略、危险操作确认之间的关系。配置优先级与默认值归属见本文；其他能力的默认值不再重复列明。

## Requirements

### Requirement: 授权模式与默认值

OMP MUST 提供 `always-ask`、`always-ask-cached`、`write`、`yolo`、`guarded` 五种工具授权确认模式，缺省值为 `yolo`。模式 MUST 可由设置项 `tools.approvalMode` 设置，也可由启动参数 `--approval-mode` 指定，两者的取值集合与语义 MUST 完全一致。

#### Scenario: 未显式配置授权模式

- **WHEN** 用户未配置 `tools.approvalMode`，也未传入 `--approval-mode`
- **THEN** 工具调用按 `yolo` 解析，即自动授权读取、写入与执行级别。

#### Scenario: 启动参数覆盖设置项

- **WHEN** 用户以 `--approval-mode guarded` 启动，而用户配置为 `write`
- **THEN** 本次进程按 `guarded` 解析授权，且该启动参数 MUST NOT 被持久写入用户配置。

### Requirement: 授权模式的放行边界

每种模式 MUST 按工具声明的能力级别（读取、写入、执行）放行：`always-ask` 自动授权读取级别，写入与执行仍需确认；`always-ask-cached` 对带文件或目录目标的读取调用先询问，并 MAY 按文件或目录记住读取或写入授权（本次会话或跨会话），无目标时的只读调用自动授权，执行级别仍需确认；`write` 自动授权读取与写入级别，执行仍需确认；`yolo` 放行全部级别；`guarded` 同样放行全部级别，但 MUST 保留工具声明的危险操作覆盖（critical override）逐次确认。用户策略及受限目录的独立约束仍然有效。

#### Scenario: guarded 放行普通调用但危险操作仍确认

- **WHEN** 授权模式为 `guarded`，工具对本调用声明了危险操作覆盖
- **THEN** OMP MUST 为该调用要求确认，且该确认 MUST NOT 因模式放行或已记住的授权而被跳过或记住。

#### Scenario: yolo 与 guarded 的差别

- **WHEN** 同一工具调用分别以 `yolo` 与 `guarded` 执行，该工具声明了危险操作覆盖
- **THEN** `yolo` 不因该覆盖中断，直接放行；`guarded` 放行普通调用但对该危险操作逐次要求确认。

#### Scenario: always-ask 与 always-ask-cached 的差别

- **WHEN** 同一带文件目标的读取调用在 `always-ask` 与 `always-ask-cached` 下分别执行，且此前未记住任何授权，亦无其他策略要求确认
- **THEN** `always-ask` 按读取级别自动放行；`always-ask-cached` MUST 先要求确认，并可把该文件或目录的读取授权记住，供后续调用复用。

#### Scenario: 执行级调用仍需确认

- **WHEN** 授权模式为 `always-ask`、`always-ask-cached` 或 `write`，且工具调用声明的能力级别为执行
- **THEN** OMP MUST 要求确认，MUST NOT 因模式自动放行。

### Requirement: 用户策略与受限目录始终有效

所有授权模式 MUST 继续遵循用户逐工具策略 `tools.approval`：`deny` MUST 优先于模式放行，`prompt` MUST 要求确认，`allow` MUST 可放行该工具；模式 MUST NOT 让 `deny` 失效。配置在 `tools.restrictedFolders` 内的目录，其任何读取、写入、编辑、搜索或命令调用 MUST 在任何模式与任何已记住授权下逐次要求确认。

#### Scenario: 用户策略阻止被模式放行的工具

- **WHEN** 授权模式为 `yolo`，用户对某工具设置 `tools.approval.<tool>: deny`
- **THEN** 该工具调用 MUST 被阻止，MUST NOT 因 `yolo` 放行。

#### Scenario: 受限目录内调用

- **WHEN** 工具调用触及 `tools.restrictedFolders` 中的目录或其子目录
- **THEN** OMP MUST 逐次要求确认，MUST NOT 复用此前记住的文件或目录授权。

### Requirement: 未知或非法模式取值

OMP MUST NOT 把未知模式当作已放行。设置项 `tools.approvalMode` 出现未知取值时 MUST 回落缺省 `yolo`；启动参数 `--approval-mode` 出现未知取值时 MUST 作为非法参数报错并拒绝该值，MUST NOT 静默降级为其他模式。

#### Scenario: 设置项损坏

- **WHEN** 用户配置中 `tools.approvalMode` 的值不属于五种受支持模式
- **THEN** OMP MUST 按缺省 `yolo` 解析，且不改写该配置。

#### Scenario: 启动参数非法

- **WHEN** 用户传入 `--approval-mode` 且取值不属于五种受支持模式
- **THEN** OMP MUST 报告该参数值非法并列出受支持取值，本次启动 MUST NOT 采用该值。
