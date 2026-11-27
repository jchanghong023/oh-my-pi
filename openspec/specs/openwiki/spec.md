# openwiki Specification

## Purpose

OpenWiki 随 OMP 发行，复用 OMP 模型和认证生成、更新仓库 Wiki，并提供按需只读查询，兼容已有数据。

## Requirements

### Requirement: 仓库 Wiki 命令与功能边界

`omp openwiki` MUST 仅用于仓库 Wiki。查询走内置工具，不提供个人知识库、外部连接器、MCP 或其他 Agent 集成。无操作显示帮助；不支持的操作（含 `search`、`read`）报错，不进入聊天或隐式生成。

#### Scenario: 显式生成和更新

- **WHEN** 执行 `omp openwiki [code] --init` 或 `--update`
- **THEN** 使用 OMP 模型；`--language` 优先，默认 `zh-CN`。仅在缺少 `openwiki/INSTRUCTIONS.md` 时创建空文件。

#### Scenario: 只读预览生成和更新

- **WHEN** 对 init/update 使用 `--dry-run`
- **THEN** 显示仓库、各阶段默认角色／显式 selector、快照候选、可比较的变更路径和现有页面范围。实际模型发现和认证未核验，页面由模型最终决定，候选不等于完整读取清单。不调用模型、不写文件或状态、不产生副作用。

保留原生 `link [directory]`、`workspace use <workspace>`／`current`／`clear` 与 `visualize [path] [--port <port>] [--no-open] [--export <dir>]`。禁用 OpenWiki 公网遥测；显式 `--telemetry-file` 仅本地写 `disabled: true`、`sent: false`。OMP 遥测不变，生成遵循 OMP 的离线及日志规则。

### Requirement: OpenWiki 源码归属与合并发行

MUST 使用父仓固定的 [`vendor/openwiki` 子模块](https://github.com/jchanghong023/openwiki.git)。OMP 只负责接入、构建和引用，不另建知识核心、存储、模型策略或安装器。

#### Scenario: 正式发行与本地构建

- **WHEN** 构建 Windows x64／Linux glibc x64 发行版
- **THEN** 使用父仓锁定提交，源码、依赖或资源缺失即失败；本地构建允许子模块有改动，不强制重置、不视为正式发行。
- **AND** 随 OMP 安装和更新交付运行依赖、技能／提示词、浏览器资源和第三方许可。全新安装可进程内运行，不另装包、运行时或服务，不依赖开发 checkout 或运行时下载；可用 Git／浏览器辅助程序，生成仍需可达模型。

OpenWiki 随 OMP [通过 CNB 一体交付](../fork-runtime/spec.md#requirement-cnb-精确输入缓存与四附件交付)，不单独发布。验收遵循[维护规格](../fork-maintenance/spec.md#requirement-按风险选择验证和报告证据)。

### Requirement: 使用 OMP 模型与认证

规划和页面生成 MUST 复用 OMP 认证、端点、Provider 限制和请求策略，支持模型调用工具后继续生成，不设 OpenWiki 专用模型目录、登录或网关。

| 阶段 | 选择优先级 |
|---|---|
| 页面 | `--modelId`／`--model-id` > 当前 profile 的 `default` |
| 规划 | `--planner-model` > 共享显式模型 > `plan`；仅 `plan` 未设时回退 `default`，不选 `task` |

#### Scenario: 单独指定规划模型

- **WHEN** 使用 `--planner-model`
- **THEN** 仅覆盖本次规划模型及 effort；按 OMP selector 解析，尊重 `off`，不强加 effort 或 `auto`。调试显示两阶段实际模型 ID，持久化仍记共享／页面模型，不改变检查点格式。

内网和免认证模型仍由 OMP 配置。离线只用已配置且可达的内网模型，不联网发现或登录；读取浏览不需模型凭据。解析、认证、工具能力或调用失败，以及取消时，如实报告并释放资源，不擅自切换模型。

### Requirement: 复用原生生成编排与恢复

生成 MUST 沿用 OpenWiki 的持久化生命周期，不走 OMP Task。页面和整次运行以各自已持久化的状态判定完成，不凭 Agent 声明或退出。

#### Scenario: 原有页面并行行为

- **WHEN** 页面并行生成、失败或恢复
- **THEN** 每项只提交所属页面，不影响在途页面和验证；单次运行去重，不另加跨进程锁。中断或部分失败可在同一 checkout 原生恢复；失败或跳过页面以非零退出，不推进全局成功基线。
- **AND** 帮助说明 `OPENWIKI_PAGE_CONCURRENCY` 默认 1、范围 1–8。增量执行不因 Git 干净而忽略未完成状态。指令变更仅跟踪根 `AGENTS.md` 和 `openwiki/INSTRUCTIONS.md`：有基线看有效内容差异；无基线看非空 Wiki 指令或 Git 可见的根指令变更，不追溯之前已清空的 Wiki 指令。
- **AND** 收尾只做无 DOM 的 Mermaid 结构检查：流程图节点标签／保留字、时序图和复合状态块。确认有错时保留正文为纯文本并记录原因，未覆盖的语法照原样保留。

### Requirement: OMP 内置只读查询工具

`openwiki_search`、`openwiki_read`、`openwiki_list_workspaces`、`openwiki_list_wikis` MUST 进程内只读运行，不调用模型或 MCP，不改 Wiki、Claims 或注册表，不扩大受限会话权限。

#### Scenario: 按设置启用或关闭内置查询

- **WHEN** `openwiki.tools.enabled` 变化
- **THEN** 同步更新会话工具与提示。默认关闭（含离线），显式工具列表不能绕过；允许使用时，若 `tools.commands` 启用且有内置 Bash，挂为 Bash 命令，否则挂为顶层工具。CLI 不变。

| 查询 | 契约 |
|---|---|
| 搜索与读取 | 查询非空、limit 为整数、相对路径提示限量且只影响排序。将结果 `ref` 拆为不带锚点的 `page` 和 `sections`；只合并同一 Wiki／页面的节，结果有 `wiki` 才传入。工具文档保留完整示例。 |
| 错误 | 保留原生错误分类，指出字段及约束，不用替代读取。缺页报告路径并建议重搜；页和锚点混写时提示拆分；未知节列出页面、坏锚点和最多 20 个可用锚点并标明是否截断。 |
| 匹配 | 支持中英文、单字及混合标识符。中文连续词优先于标点拆开的同排名结果，不按散字拼词；支持部分多词命中，保留原始片段和完整 Markdown 小节。 |
| 列表 | 列当前仓库上下文的工作区，或指定工作区内可访问成员，沿用 profile 标识和选择。 |

### Requirement: 按需检索仓库 Wiki

MUST 仅按请求或证据需要查询，不为无关任务自动列出、预读、生成或可视化 Wiki。

#### Scenario: 概览调研优先使用已有 Wiki

- **WHEN** 需要架构、功能概览或跨模块调查，Wiki 可用且未被排除
- **THEN** 先复用会话已有小节，否则先搜索、不先列工作区；用结果引用读全文，不猜页面或重复委派。具名文件、符号、错误、编辑、现行行为或重大 Wiki 主张以源码为先；Wiki 不可用、为空、过时或冲突时转查源码，不阻塞或隐式生成。

### Requirement: 保留跨仓库工作区链接

MUST 保留本地命名工作区及跨仓库只读查询，不引入个人数据源或承诺跨仓库图谱。

#### Scenario: 管理并使用仓库工作区

- **WHEN** 使用 `omp openwiki link` 或访问链接仓库
- **THEN** 按活动工作区解析，歧义报 `workspace_required`；Wiki 移动、缺失或不可访问时明确报错，不选替代项。注册表、缓存和用户状态按[配置根与 profile](../fork-runtime/spec.md#requirement-安装与运行)隔离，离线规则相同；不使用独立配置目录、不接管或迁移旧配置。切换不改仓库数据。

### Requirement: 保留已有仓库 Wiki 数据格式

MUST 保留 `openwiki/`、Claims、页面清单及检查点的格式和身份。不可读时报错，不静默清空、覆盖或重建。

#### Scenario: 接续已有 Wiki 和 Claims

- **WHEN** 更新、恢复或查询已有 Wiki
- **THEN** 复用页面、Claims 和进度。init 可替换生成结果，但按[初始化规则](#scenario-显式生成和更新)保留已有指令。

### Requirement: 原有可视化与静态导出

MUST 保留实时浏览和静态导出。实时服务默认监听回环；导出支持 HTTP 子路径和相对资源，不承诺 `file://`。两者仅用随包离线资源，不下载、不依赖 CDN、外部字体或开发缓存。相关源码、生成器、依赖、许可或资源内容改变时须重新生成；仅 OMP 版本、无关锁文件或路径改变不使资源失效。

#### Scenario: 实时浏览与关闭

- **WHEN** 执行 `omp openwiki visualize`，随后停止或退出
- **THEN** 显示实际页面，Wiki 变化可刷新，启动及刷新失败如实报告。退出释放本次监听和监视，不影响其他宿主任务。导出不依赖 Agent、MCP 或生成器服务。

### Requirement: 默认接入不安装外部 OpenWiki 链路

MUST NOT 隐式安装或运行独立版、拉取连接器、添加自动更新工作流或改 `CLAUDE.md`。不修改、执行或依赖用户工作流，不移除或禁用独立版能力。

#### Scenario: 显式生成维护指令区块

- **WHEN** 显式 init/update（不含[预览](#scenario-只读预览生成和更新)）
- **THEN** 写入 `openwiki/`，在根 `AGENTS.md` 创建或刷新有标记的 Wiki 区块，仅说明位置和只读查询。保留区块外内容；标记不合法或重复时拒绝改动。
