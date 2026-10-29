# fork-maintenance

## Purpose

规定个人 fork 的需求维护、上游同步、文档和 Git 钩子约束；验证边界由 [fork-verification-gates](../fork-verification-gates/spec.md) 规定。

## Requirements

### Requirement: Fork 维护责任和需求权威

本仓库是 `jchanghong023/oh-my-pi` 个人 fork，由 AI Agent 实现和维护，正确性 MUST 依靠可复现的自动化验证，不能依赖用户手工读代码或人工回归。[已批准需求目录](../)是唯一需求基线，[待定变更](../../changes/)只保存未批准的提案与增量，`docs-zh-CN/` 不是第二份需求来源。

#### Scenario: 修改功能或需求

- **WHEN** 修改功能或维护需求
- **THEN** 修改前按功能域读取相关规格及适用的待定变更，跨域按引用补读，不一次性加载全部需求；需求变化同步对应规格，实现方式变化不制造需求变更，也不按代码现状删减未实现的已批准目标

#### Scenario: 维护 fork 差异与项目规则

- **WHEN** 实现或维护 fork 功能，或改变入口、命令或规则
- **THEN** 高频跟进上游，保持最小、集中、内聚的业务代码差异，优先接入上游既有文件与链路；不为避免合并冲突另建平行实现，也不增加推测性抽象、兼容层及无关重构；入口、命令或规则变化时维护根及适用子级 `AGENTS.md`
- **AND** 全仓库最多八个项目 `AGENTS.md`，根文件登记所有有效子级文件；缓存、临时副本及第三方资源不作为项目规则，不为凑数量拆分全局规则

#### Scenario: 选择开发平台和工具链

- **WHEN** 开发或维护本 fork
- **THEN** 日常平台为 Windows x64（PowerShell），同时支持 Linux x64 与 Ubuntu-24.04 WSL2；工具链跟随仓库固定版本，不单独升级；`scripts/` 承载门禁和安装器，`openspec/` 承载需求

### Requirement: 上游同步与基线

上游同步 MUST 保全本地改动和 fork 功能，并按 [上游基线](../fork-upstream-baseline/spec.md)维护唯一的当前基线。

#### Scenario: 确定同步来源和保护工作区

- **WHEN** 准备同步上游
- **THEN** 唯一同步来源为 `https://github.com/can1357/oh-my-pi.git` 的 `refs/heads/main` HEAD，不以 tag、Release、其他分支或远端跟踪引用代替，不接受上游历史改写；集成分支固定为本地 `main`，`origin` 的有效 fetch/push 身份均为 `jchanghong023/oh-my-pi`
- **AND** 保全本地改动及整个 `openspec/`，核对 `main:openspec/specs/fork-upstream-baseline/spec.md` 中唯一完整 `Upstream commit` 有效且为 `main` 祖先

#### Scenario: 完成上游同步

- **WHEN** 成功同步上游
- **THEN** 更新基线 SHA、UTC 日期及上游 `packages/coding-agent/package.json` 的版本，逐域核对仍有效的 fork 差异；上游等价提供后删除相应本地需求及差异说明，不追加历史或第二份清单
- **AND** 基线的 `## 当前上游基线` 下保留唯一 `* **版本**：` 或 `- **版本**：` 行，值为反引号包裹的 `v数字.数字.数字`
- **AND** 保留根 `AGENTS.md` 的 fork 引用、整个 `openspec/`、`docs-zh-CN/quick-start-intranet.md` 和根 `README.md` 的 fork 约定；上游正文随基线更新

#### Scenario: 同步涉及本地提交或无法保全功能

- **WHEN** 上游同步需要本地提交，或冲突无法可靠保留 fork 功能
- **THEN** 同步授权包含必要的本地提交，不包含 push；提交格式为 `sync(upstream): merge main@<目标前12位>`，命令级禁用 hooks 和签名，不改全局 Git 配置
- **AND** 同步中的 Git 写操作 MUST 统一通过已部署的受限同步脚本会话执行，不得在 Agent 外部命令中绕过检查；同步只完成本地 `main` 集成，不推送分支或标签
- **AND** 无法可靠保留 fork 功能时中止，不重置整个仓库或丢弃无关改动

#### Scenario: 同步检查或冲突重建

- **WHEN** 执行上游同步检查，或冲突重建需要验证
- **THEN** 仅做 staged Git 检查与必要的语义审查，必要时最多一次 `bun run check:tools`；缺依赖只允许 `bun install --frozen-lockfile --ignore-scripts`；首轮失败仅修复本次相关问题并复验失败项一次，仍失败则中止、不提交
- **AND** 不运行编译、类型检查、测试、UI/browser/heavy、Docker、benchmark、打包、发布、任何 Rust/native 检查与构建或 fastcheck/fulltest/slowtest；冲突重建需 UT 与真实入口 E2E 而未获额外验证授权时中止并报告未验证，不以未验证重建宣称同步完成

### Requirement: Fork 文档维护

根 README 和中文文档 MUST 保持各自职责，不重复维护上游文档翻译。

#### Scenario: 更新上游 README

- **WHEN** 上游 README 正文变化
- **THEN** 根 `README.md` 作为上游 README 的中文版，以 `docs-zh-CN/README.upstream.md` 英文快照对照更新；上游正文未变则不动。Install/下载段保留 fork release、安装器、`+fork.N` 及平台声明，其余正文不加 fork 内容

#### Scenario: 维护和审查中文文档

- **WHEN** 维护或审查 `docs-zh-CN/`
- **THEN** 只保留 fork 自有指南、工程背景和历史记录，不恢复上游文档翻译或文档站点；review 仅审查其中 fork 新增文档

### Requirement: Git 钩子

OMP MUST Git 钩子保持禁用，提交和推送不自动运行检查。

#### Scenario: Git 钩子的详细边界

- **WHEN** 本节所述功能在适用条件下运行
- **THEN** 以下具体约束适用：

- 本 fork 不保留或使用任何 Git 钩子，包括提交、推送、签出及外部工具跟踪钩子；安装、开发和上游同步不得恢复钩子或其自动安装步骤。
- 现有 checkout 删除全部钩子文件，并在本仓库设置 `git config --local core.hooksPath /dev/null`；不修改用户全局 Git 配置。
- `git commit` 与 `git push` 不自动运行检查或外部跟踪程序。既有验证命令及通过标准保持不变，仅按任务授权显式执行。

#### Scenario: Git 钩子的可观察行为

- **WHEN** 安装、开发或上游同步后执行提交或推送
- **THEN** Git 钩子保持禁用，提交和推送不自动运行检查
