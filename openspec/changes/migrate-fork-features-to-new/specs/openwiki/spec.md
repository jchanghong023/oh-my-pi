# Spec Delta

## Purpose

让用户无需另装 OpenWiki 即可生成、续跑和更新仓库知识库，并在不提供模型凭据的情况下查询、浏览或导出已有 Wiki 内容。

## ADDED Requirements

### Requirement: 内置 Wiki 生成与接续

OMP MUST 内置 `omp openwiki code --init` 和 `--update`，沿用 OMP 模型和认证，可分别指定规划和撰写模型。`OPENWIKI_PAGE_CONCURRENCY` 接受 1–8，默认 1。

#### Scenario: 生成或续跑
- **WHEN** 用户开始新运行、恢复中断运行或更新 Wiki
- **THEN** 新运行未指定 `--language` 时用简体中文；恢复沿用检查点语言，显式语言与检查点冲突则报错。
- **AND** 运行可接续，报告失败或跳过的页面；生成或更新会在根 `AGENTS.md` 记录 Wiki 位置和只读查询提示。

### Requirement: 只读预览与无公网遥测

`--dry-run` MUST 只读展示仓库、拟用模型、可比较的变更路径和现有页面范围。OpenWiki MUST 禁用公网遥测。

#### Scenario: 无凭据预览
- **WHEN** 用户用 `--dry-run` 预览
- **THEN** 不调用模型、不核验认证、不写文件。

#### Scenario: 显式记录遥测状态
- **WHEN** 用户为非预览运行显式设置 `--telemetry-file`
- **THEN** 只在本地记录 `disabled: true` 和 `sent: false`，不向公网发送。

### Requirement: 可选的 Wiki 会话查询工具

`openwiki.tools.enabled` MUST 默认关闭；开启后，工具可列出工作区及可访问的 Wiki，按中文、英文或混合标识符搜索，返回匹配片段并按页或小节读取。

#### Scenario: AI 按需查项目概览
- **WHEN** 用户开启设置，AI 需要了解项目概览
- **THEN** 可通过只读工具获取相关资料，不需要模型凭据。

### Requirement: 可视化和静态导出

`omp openwiki visualize` MUST 支持在浏览器查看和刷新仓库 Wiki、指定端口或关闭自动打开浏览器；`--export` 支持导出可部署的静态站点。浏览和导出不需要模型凭据。

#### Scenario: 浏览或导出已有 Wiki
- **WHEN** 用户对已有 Wiki 启动可视化或请求静态导出
- **THEN** 可按指定设置访问和刷新，或获得静态站点；不要求登录模型提供者。
