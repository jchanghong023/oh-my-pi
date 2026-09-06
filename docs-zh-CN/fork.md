# Fork 与上游差异

本仓库仅供个人使用：持续同步上游最新 `main`，保留个人功能和默认值，安装后无需额外配置即可使用，不以对外发布为目标。

本页面向本人和 AI agent，只记录**相对当前上游基线仍有效、对使用者有影响的功能差异**，不记录实现细节、修复或同步历史。开发规则见 `AGENTS.md`，同步步骤见 `.omp/skills/upstream-release-sync/SKILL.md`。

## 当前上游基线

* **分支**：`can1357/oh-my-pi@main`
* **版本**：`v18.1.12`
* **Upstream commit**：`6d3bc569d16cd7351073eaa767caed51021befbb`
* **同步日期**：2026-09-07

## 当前功能差异

### Markdown 文档索引

* 支持外部 Markdown 目录持久索引，通过 `/docs` 面板或 `omp docs init/reinit/list/status/remove` 管理，并向普通代理提供只读 `wiki` 查询工具；CLI 删除索引须带 `--force`。
* 默认仅启用全文检索；结构化提取必须显式请求，支持内置 DFT 或自定义 JSON schema，并需要已配置的 task 模型和凭据。
* `wiki` 支持全文搜索、原文章节/证据读取和索引状态查询；结构化索引另支持实体查找、关系遍历与冲突查询。存在多个索引时，除状态查询外必须指定索引。
* 索引重建期间继续提供完整旧索引，完成后整体切换，不暴露未完成结果。
* Markdown 围栏中的标题不拆分章节，结束围栏须使用相同字符、长度不少于起始围栏且后面仅有空白；支持 ATX/Setext 标题，CRLF 文件的证据保持原文字节定位；Linux 上仅大小写不同的文档保持独立身份，终端展示过滤控制字符。

### Command Code

* 保留 `command-code` provider，支持 API Key 登录和配置的 provider `baseUrl`。
* 支持 Anthropic Messages / OpenAI Completions 双协议及模型发现。
* API Key 环境变量优先 `COMMAND_CODE_API_KEY`，兼容 `COMMANDCODE_API_KEY`。
* provider 默认模型为 `deepseek/deepseek-v4-flash`。
* 模型价格优先取 Command Code 价格源；缺失时依次回退到内置参考模型价格、模型发现默认价格。
* 模型列表与详情分别标示渠道报价（`quote`）、参考估算（`est.`）与未知（`unknown`）；未携带价格来源的旧缓存也显示未知，不显示为免费。费用计算与累计费用展示仍使用原有回退价格，不受来源标识影响。

### OpenCode Zen

* `/models` 面板仅展示内置目录明确标为免费、且当前 input/output 价格均为 0 的 `opencode-zen` 模型。
* 缺失价格或未列入内置免费目录的模型隐藏，新发现模型即使报告零价也不例外；此过滤不代表全局禁用其他模型。

### 代理行为与 Discuss

* Todo 提示词默认以至少 3 个独立用户可见结果作为创建条件，常规检查 → 执行 → 验证算一个结果；仍保留用户明确要求、提供任务集合或中途追加指令等创建/更新条件。
* `Shift+F2` 固定在 Main ↔ Discuss 之间切换，不支持配置顺序；运行中或有排队消息时不能切换。
* 会话/分支切换后恢复对应代理状态。
* Discuss 只能使用允许的**内置工具实例**，不能被同名扩展替代。
* Discuss 可在聊天内给出实施方案和步骤，但不写计划文件、不执行命令、修改文件或外部状态、创建 Todo 或委派工作；需要实施时提示用 `Shift+F2` 切回 Main，不自动重放或实施请求。
* Discuss 与 Plan/Goal/Vibe 互斥，相关模式暂停时也不能切入 Discuss。

### 魔法关键词的内置命令与 fullsend

* 上游已有 `ultrathink`、`orchestrate`、`workflowz` 魔法关键词，可在任务正文中以独立小写词触发，无需整条消息只有关键词；代码块、行内代码和 XML/HTML 区域不触发。fork 新增的关键词只有 `fullsend`，遵循同样的匹配规则。
* fork 为这四个关键词新增对应的内置命令 `/ultrathink`、`/orchestrate`、`/workflowz`、`/fullsend`，方便输入，并允许命令后直接携带任务文本。
* `fullsend` 注入执行策略：成本和 token 用量不作为优化约束；在同等正确性、完整性与验证标准下缩短完成时间，端到端完成任务。仅做对速度或验证质量有实际收益的调用与并行，不把额外调用或花费视为目标，不扩大任务范围或权限。
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
* `/jchgitdiscardall [--ignored=true|false]`：始终无交互确认，先执行 `git fetch --all --prune`、`git reset --hard @{upstream}`。无参数或 `--ignored=false` 时以 `git clean -df` 清理未跟踪内容，保留 ignored；`--ignored=true` 时以 `git clean -xdf` 同时清理 ignored 文件和目录。非法、重复或多余参数在任何 Git 操作前报用法错误；任一步失败即停止。重置目标是当前分支配置的跟踪分支，不是本仓库名为 `upstream` 的分支。

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
* 文件日志默认关闭；临时开启方式见“安装与运行”。

### 快捷键与状态栏

* `Shift+Tab`：计划模式。
* `Ctrl+T`：临时模型。
* `Alt+P`：thinking blocks 显示/隐藏。
* `Shift+F1`：循环切换 thinking level。
* 状态栏默认显示 active time，并支持窄终端自动换行。
* 状态栏在未显示其他模式状态时显示当前主代理 Main/Discuss。
* `composer.shape=pi` 时状态栏独立位于输入框下方。

### 安装与运行

* `omp --log-file` 仅为本次启动启用现有轮转文件日志，写入当前 profile 的默认日志目录；例如 `omp --profile work --log-file`。不启用控制台日志、不写持久配置；未传参数时默认不写文件，也不覆盖已有显式日志配置。
* `PI_NATIVE_DIR` 严格限定 native addon 加载目录；指定后不回退到工作区、安装包、缓存或内嵌 addon，缺失或不兼容则加载失败。

以下是现有个人分发能力，不代表对外发布目标；上游同步不触发构建或发布。

* 个人 Release 版本使用 `+fork.N`，仅从本仓库 `main` 通过手动 CI 生成。
* 二进制必须携带 fork 版本、构建时间和更新仓库信息。
* `omp update` 按 fork build counter 判断更新，并支持 `%2B` 编码的 `+` 版本 URL。
* 安装器只安装 fork Release 的预编译二进制：Linux x64/arm64、Windows x64。

### 文档站

* 保留供个人查阅的中英文 VitePress 文档站及 GitHub Pages 部署能力。
* 中文站以覆盖上游全部文档的完整翻译为目标，并保留使用指南和 `config.yml` 设置参考；翻译独立同步，内容可能落后于当前代码基线。

### Fork 开发工具

* 保留 `bun run fastcheck`，仅检查本地修改的 TypeScript lint/format。
* 保留 `bun scripts/jch-localci.ts [full]` 作为独立 Linux-x64 本地检查入口；默认不构建 native，`full` 才构建。
