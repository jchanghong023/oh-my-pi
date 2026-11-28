# Spec Delta

## Purpose

让用户直接调用随 OMP 交付的需求规划、代码组织、开发测试和工作流能力，不因功能迁移失去现有入口或被迫额外安装工具。

## ADDED Requirements

### Requirement: 内置 JCH 技能

OMP MUST 随应用提供 `/skill:jch-grill-me` 和 `/skill:jch-codebase-design`。

#### Scenario: 手动使用与子代理发现
- **WHEN** 用户在普通会话手动调用 `jch-grill-me`，或主会话与子代理发现 `jch-codebase-design`
- **THEN** 前者可调用，后者可被主会话和子代理用于审视代码组织。

### Requirement: 内置 OpenSpec

OMP MUST 提供 `omp openspec` 和 `openspec-*` 内置技能，无需额外安装 OpenSpec 或 Node.js；项目初始化须经明确授权，生成正文使用简体中文。

#### Scenario: 整理需求与初始化授权
- **WHEN** 用户调用内置 OpenSpec 整理需求或方案，或进入尚未初始化的项目
- **THEN** 已有项目可直接使用工作流；未经明确授权不初始化；生成的文档正文为简体中文。

### Requirement: 内置 Superpowers 和脚本入口

OMP MUST 随应用提供可手动调用的 Superpowers 技能，无需另装插件或联网；`omp superpowers` 支持执行和中止指定脚本。

#### Scenario: 运行脚本或报告不可用
- **WHEN** 用户运行清单内脚本，或脚本不在清单或缺少运行环境
- **THEN** 可运行脚本返回输出和退出结果；不可运行时说明原因，不静默下载补装。

### Requirement: Developer Test Agent

OMP MUST 提供可手动调用的 Developer Test Agent（如 `/dt`），用于 Python、Java、C/C++ 和 Go 的单元测试生成或修复、覆盖率报告和达标判断、断言审查。对于云端修复入口支持的语言，用户还可按云端结果修复。

#### Scenario: 执行开发测试任务
- **WHEN** 用户针对受支持语言显式发起测试任务，或该操作所需的云端覆盖率工具缺失
- **THEN** 可执行时提供所请求的测试操作及结果；必需云端工具不可用时指出缺项，不声称完成云端验收。

#### Scenario: 按云端结果修复
- **WHEN** 用户提供受支持的语言和对应的云端结果，且所需工具可用
- **THEN** 可根据云端结果执行修复并报告结果。
