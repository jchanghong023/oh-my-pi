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
- **AND** 同步中的 Git 写操作 MUST 通过可用工具执行普通 Git 命令，不要求受限脚本会话；同步只完成本地 `main` 集成，不推送分支或标签
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

### Requirement: 上游继承行为与本地差异边界

以下行为 MUST 沿用[当前已集成上游](../fork-upstream-baseline/spec.md)的既有链路，保留其他已批准的 fork 功能，不重新引入已撤销的本地特例。

#### Scenario: 维护上游继承能力

- **WHEN** 维护以下能力
- **THEN** 以下边界适用：
  - 会话 HTML 导出的 viewer、Markdown 和代码高亮资源按上游规则选择、加载和提示失败；开发检出与发行产物分别沿用原有路径，不要求所有发行路径内联资源或离线可用。
  - Provider 错误码提取、优先级和传播沿用上游；扩展工具使用通用 schema 校验，不提供扩展作者可选的 `lenientArgValidation`。已批准的内建工具参数反馈和其他工具能力保持不变。
  - 服务日志读取失败和 Web Search 未配置模型／所有候选失败沿用上游失败传播及回执，不增加服务日志失败专用回执或 Web Search `isError` 标记。日志读取失败不撤销已启动服务；服务参数校验及 native PipeStreams 降级要求保持不变。
  - Robomp 的 PR 元数据解析、PR 审查、review 处理及 PR 对话处理中的 GitHub 请求遇到 `GitHubError` 时，沿用上游捕获、记录 warning 后返回的行为；其他异常和路径保持既有行为。
  - 归档编码沿用上游接口，不增加 `AbortSignal` 编码取消接口或检查；其他归档读写、工具协议及权限边界保持不变。

#### Scenario: 保留 JTD 转换约束

- **WHEN** 将 JTD 转为 JSON Schema
- **THEN** 根 `definitions` MUST 转为 `$defs`，本地引用 MUST 使用正确转义的 URI fragment；属性形式保留显式 `additionalProperties: true`，未显式开放时保持封闭；其余 form 转换沿用上游。

### Requirement: OpenWiki fork 子模块与源码归属

OMP MUST 通过 `vendor/openwiki` git submodule 引用 `https://github.com/jchanghong023/openwiki.git`，由父仓库 gitlink 固定正式发行所用提交。OpenWiki 业务源码及必要接入修改 MUST 继续归属该 fork；OMP MUST NOT 复制第二份 Wiki、Claims 或页面编排实现，也不得将构建生成物作为另一份可维护源码。

#### Scenario: 已有子模块声明继续使用
- **WHEN** 仓库已经具有该路径和 fork URL 的子模块声明
- **THEN** 接入沿用现有子模块，不重复添加、不替换为普通源码目录，也不因功能尚未接入而视为需要重新安装一个独立项目

#### Scenario: 修改 OpenWiki 实现
- **WHEN** 内置接入需要调整 OpenWiki 的宿主初始化、资源、生命周期或已有知识行为
- **THEN** 这些修改在 OpenWiki fork 源码中维护，OMP 仓库只保留必要的宿主接线、构建规则及对子模块提交的引用
- **AND** 正式更新父仓库引用时，所需修改必须包含在 fork 可取得的对应提交中，不依赖仅存在于开发机的子模块未提交内容

#### Scenario: 固定版本与引用更新
- **WHEN** 获取或更新正式发行所依赖的 OpenWiki 版本
- **THEN** 以父仓库记录的 gitlink 提交为准，不以 `.gitmodules` URL、浮动分支或独立 OpenWiki 已发布包版本代替；本地开发构建可使用子模块当前工作区及未提交修改，不得为此强制重置工作区
- **AND** 本变更不授权提交、推送、更新远端或发布，相关实际操作仍遵循用户单独授权

### Requirement: OpenWiki 最小接入维护边界

OMP MUST 优先复用 OpenWiki fork 已有的生成、页面工作池、Claims、检索和可视化模块，仅为模型接入、内置工具、宿主生命周期、合并发行及定向修复已确认的并行 verification 跨页修改缺陷增加必要修改。允许直接维护 OpenWiki fork，不以上游兼容或持续同步为前提；本约定不改变 OMP 自身的上游同步与基线要求。

#### Scenario: 保留原有 Agent 与编排
- **WHEN** 接入 OpenWiki 的仓库生成和更新能力
- **THEN** 保留其原有规划 Agent 与页面工作池，允许必要 Agent 源码和 DeepAgents／LangChain 等运行依赖进入 OMP 产物，不要求改写为 OMP 通用 Task 编排或先完成无 Agent 核心拆分

#### Scenario: 保留 OpenWiki fork 独立功能
- **WHEN** 为 OMP 内置路径调整 OpenWiki 的初始化、资源、认证或遥测行为
- **THEN** fork 原有独立 CLI、MCP、个人模式和其他既有功能仍可独立使用；OMP 不纳入这些能力不意味着删除或全局禁用它们

#### Scenario: 不维护平行实现或无关抽象
- **WHEN** 为 OMP 适配模型、查询工具、命令和发行
- **THEN** OMP 仅维护宿主集成，不另建同功能知识核心、通用存储后端、独立模型策略或新的 Wiki 安装器；OpenWiki 上游同步不是本次交付步骤
