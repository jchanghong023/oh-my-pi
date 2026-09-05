# Fork 与上游差异

本仓库仅供个人使用：持续同步上游最新 `main`，保留个人功能和默认值，安装后无需额外配置即可使用，不以对外发布为目标。

本页面向本人和 AI agent，只记录**相对当前上游基线仍有效、对使用者有影响的功能差异**，不记录实现细节、修复或同步历史。开发规则见 `AGENTS.md`，同步步骤见 `.omp/skills/upstream-release-sync/SKILL.md`。

冲突很大或上游重写模块时，可以先采用上游实现，再依据本页重建 fork 功能；保留的是行为，不是旧代码。三份 fork 文档不得被上游覆盖。上游已提供等价且满足个人需求的行为时，删除对应差异；未能可靠恢复的功能不能视为同步完成。

## 当前上游基线

* **分支**：`can1357/oh-my-pi@main`
* **版本**：`v18.1.10`
* **Upstream commit**：`5964a0f7649275bcde818f20073193fd032451f2`
* **同步日期**：2026-09-05

## Fork 意图

### Markdown 文档索引

* 支持外部 Markdown 目录持久索引，通过 `/docs` 面板或 `omp docs init/reinit/list/status/remove` 管理，并向普通代理提供只读 `wiki` 查询工具；CLI 删除索引须带 `--force`。
* 默认仅启用全文检索；结构化提取必须显式请求，支持内置 DFT 或自定义 JSON schema，并需要已配置的 task 模型和凭据。
* `wiki` 支持全文搜索、原文章节/证据读取和索引状态查询；结构化索引另支持实体查找、关系遍历与冲突查询。存在多个索引时，除状态查询外必须指定索引。
* 索引重建期间继续提供完整旧索引，完成后整体切换，不暴露未完成结果。
* 正确处理 Markdown 围栏、标题、CRLF 原文证据、Linux 路径大小写和终端文本。

### Command Code

* 保留 `command-code` provider，支持 API Key 登录和配置的 provider `baseUrl`。
* 支持 Anthropic Messages / OpenAI Completions 双协议及模型发现。
* API Key 环境变量优先 `COMMAND_CODE_API_KEY`，兼容 `COMMANDCODE_API_KEY`。
* provider 默认模型为 `deepseek/deepseek-v4-flash`。
* 模型价格优先取 Command Code 价格源；缺失时依次回退到内置参考模型价格、模型发现默认价格。

### OpenCode Zen

* `/models` 面板仅展示内置目录明确标为免费、且当前 input/output 价格均为 0 的 `opencode-zen` 模型。
* 缺失价格或未列入内置免费目录的模型隐藏，新发现模型即使报告零价也不例外；此过滤不代表全局禁用其他模型。

### 主代理与 Discuss

* `Ctrl+0` 固定在 Main ↔ Discuss 之间切换，不支持配置顺序；运行中或有排队消息时不能切换。
* 会话/分支切换后恢复对应代理状态。
* Discuss 只能使用允许的**内置工具实例**，不能被同名扩展替代。
* Discuss 仅用于调查讨论，不执行命令、修改文件或外部状态、创建 Todo、编写实施计划或委派工作；需要实施时须切回 Main，不自动重放请求。
* Discuss 与 Plan/Goal/Vibe 互斥，相关模式暂停时也不能切入 Discuss。

### 魔法关键词的内置命令与 fullsend

* 上游已有 `ultrathink`、`orchestrate`、`workflowz` 魔法关键词，可在任务正文中以独立小写词触发，无需整条消息只有关键词；代码块、行内代码和 XML/HTML 区域不触发。fork 新增的关键词只有 `fullsend`，遵循同样的匹配规则。
* fork 为这四个关键词新增对应的内置命令 `/ultrathink`、`/orchestrate`、`/workflowz`、`/fullsend`，方便输入，并允许命令后直接携带任务文本。
* `fullsend` 注入执行策略：不以成本或 token 用量为约束，同时优先速度与验证质量，要求端到端完成任务，不牺牲正确性、完整性或必要验证。
* 有 `task` 工具且委派更快时，该策略要求并行处理独立工作；有等待任务则完成一个立即补位，任务不足并发上限时全部启动，不为凑并发扩大范围。这是对模型的提示词要求，不是程序调度保证。

### JCH 命令

保留以下个人命令及其核心语义：

* `/jchfix`：定位根因并最小修复，不提交、不推送。
* `/jchdiagnose`：只读诊断根因、影响和修复边界。
* `/jchfuncreview`：独立只读功能审查，仅报告高置信问题。
* `/jchfuncreviewfix`：审查后最小修复。
* `/jchverify`：只读验证指定修改是否可交付。
* `/jchci`：只读分析当前 HEAD/PR 的 GitHub Actions。
* `/jchcifix`：修复当前有效 CI 失败，并仅提交、普通推送相关修改。
* `/jchcatchup`：查看本地状态/最近提交；`full` 时深入比较远端差异。
* `/jchgs`：`fetch --all` 后显示状态。
* `/jchgitpull`：直接按当前 upstream/pull 配置执行 `git pull`。
* `/jchgitdiscardall`：无交互确认，直接执行 `git fetch --all --prune`、`git reset --hard @{upstream}`、`git clean -xdf`；丢弃本地修改并清理未跟踪内容（包括被 Git 忽略的文件和目录）。目标是当前分支配置的跟踪分支，不是本仓库名为 `upstream` 的分支。

### Claude 配置同步

* 保留 `omp sync-claude [--provider <name>]`，将 Claude Code endpoint/token 同步到当前 OMP profile。
* 可自动识别仅修改 `baseUrl`/`apiKey` 的内置 Anthropic provider。

### 默认设置

保持以下 fork 默认值：

* `recap.enabled=false`
* `statusLine.compactThinkingLevel=false`
* `composer.shape=pi`
* `theme.dark=dark-terminal`（浅色主题仍为上游默认 `light`）
* `display.showTurnTime=true`
* `task.maxConcurrency=8`
* `mnemopi.embeddingVariant=multilingual`
* `stt.language=zh-CN`
* 文件日志默认关闭

### 快捷键与状态栏

* `Shift+Tab`：计划模式。
* `Ctrl+T`：临时模型。
* `Alt+P`：thinking blocks 显示/隐藏。
* `Alt+,`：循环切换 thinking level。
* 状态栏默认显示 active time，并支持窄终端自动换行。
* 状态栏在未显示其他模式状态时显示当前主代理 Main/Discuss。
* `composer.shape=pi` 时状态栏独立位于输入框下方。

### 个人安装与更新

以下是现有个人分发能力，不代表对外发布目标；上游同步不触发构建或发布。

* 个人 Release 版本使用 `+fork.N`，仅从本仓库 `main` 通过手动 CI 生成。
* 二进制必须携带 fork 版本、构建时间和更新仓库信息。
* `omp update` 按 fork build counter 判断更新，并支持 `%2B` 编码的 `+` 版本 URL。
* 安装器只安装 fork Release 的预编译二进制：Linux x64/arm64、Windows x64。

### 文档站

* 保留供个人查阅的中英文 VitePress 文档站及 GitHub Pages 部署能力。
* 中文站保留完整翻译、使用指南和 `config.yml` 设置参考。

### Fork 开发工具

* 保留 `bun run fastcheck`，仅检查本地修改的 TypeScript lint/format。
* 保留 `bun scripts/jch-localci.ts [full]` 作为独立 Linux-x64 本地检查入口；默认不构建 native，`full` 才构建。
* `PI_NATIVE_DIR` 严格限定 native addon 加载目录；指定后不回退到工作区、安装包、缓存或内嵌 addon，缺失或不兼容则加载失败。
* Todo 提示词默认以至少 3 个独立用户可见结果作为创建条件，常规检查 → 执行 → 验证算一个结果；仍保留用户明确要求、提供任务集合或中途追加指令等创建/更新条件。
