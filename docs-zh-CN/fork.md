# Fork 与上游差异

本页只记录**当前 fork 相对上游 `main` 必须保留的功能与行为意图**，不记录实现细节、修复历史或已被上游吸收的改动。

合并上游时：

* **优先采用上游最新实现**，不要为了保留旧代码而阻止上游重构。
* 仅保留本页明确列出的 **fork 意图**。
* 若上游已重写相关模块，应先接受上游实现，再按本页意图重新实现 fork 功能。
* 上游已实现等价或更好的行为时，直接使用上游实现并删除对应 fork 差异。
* 每次成功同步上游后，在同一变更中更新本页。

## 当前上游基线

* **分支**：`can1357/oh-my-pi@main`
* **版本**：`v18.1.10`
* **Upstream commit**：`5964a0f7649275bcde818f20073193fd032451f2`
* **同步日期**：2026-09-05
* **Integration**：`81f6ab1576`

## 上游同步记录

* 2026-09-05：合入 `5964a0f764`（package `18.1.10`，integration `81f6ab1576`）。

## Fork 意图

### Markdown 文档索引

* 支持外部 Markdown 目录持久索引，通过 `/docs` 管理，并向普通代理提供只读 `wiki` 查询工具。
* 默认仅启用全文检索；结构化提取必须显式请求。
* 索引重建使用新代际完整构建后原子切换，不能让未完成索引对外可见。
* 保持 Markdown 围栏、标题、CRLF evidence、Linux 路径大小写和终端文本处理正确。

### Command Code

* 保留 `command-code` provider，支持 API Key 登录和配置的 provider `baseUrl`。
* 支持 Anthropic Messages / OpenAI Completions 双协议及模型发现。
* API Key 环境变量优先 `COMMAND_CODE_API_KEY`，兼容 `COMMANDCODE_API_KEY`。

### OpenCode Zen

* `opencode-zen` 只展示明确确认 input/output 均免费（价格为 0）的模型。
* 缺失价格或新发现但价格未知的模型默认隐藏。

### 主代理与 Discuss

* `Ctrl+0` 按配置顺序切换 Main/Discuss。
* 会话/分支切换后恢复对应代理状态。
* Discuss 只能使用允许的**内置工具实例**，不能被同名扩展替代。

### 魔法命令与 fullsend

* 保留 `/ultrathink`、`/orchestrate`、`/workflowz`、`/fullsend`，并允许命令后直接携带任务文本。
* `fullsend` 并发执行时，有待办任务则任一任务完成立即补位，不等待其他慢任务；任务不足并发上限时直接全部启动。

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
* `/jchgitdiscardall`：交互确认后恢复到 upstream，并清理所有未跟踪文件。

### Claude 配置同步

* 保留 `omp sync-claude [--provider <name>]`，将 Claude Code endpoint/token 同步到当前 OMP profile。
* 可自动识别仅修改 `baseUrl`/`apiKey` 的内置 Anthropic provider。

### 默认设置

保持以下 fork 默认值：

* `recap.enabled=false`
* `statusLine.compactThinkingLevel=false`
* `composer.shape=pi`
* `theme=dark-terminal`
* `display.showTurnTime=true`
* `task.maxConcurrency=8`
* `mnemopi.embeddingVariant=multilingual`
* `stt.language=zh-CN`
* 文件日志默认关闭

### 快捷键与状态栏

* `Shift+Tab`：计划模式。
* `Ctrl+T`：临时模型。
* `Alt+P`：thinking blocks 显示/隐藏。
* 状态栏默认显示 active time，并支持窄终端自动换行。
* `composer.shape=pi` 时状态栏独立位于输入框下方。

### Fork 发布与更新

* Fork Release 版本使用 `+fork.N`，仅从本仓库 `main` 通过手动 CI 发布。
* 二进制必须携带 fork 版本、构建时间和更新仓库信息。
* `omp update` 按 fork build counter 判断更新，并支持 `%2B` 编码的 `+` 版本 URL。
* 安装器只安装 fork Release 的预编译二进制：Linux x64/arm64、Windows x64。

### 文档站

* 保留中英文 VitePress 文档站及 GitHub Pages 发布。
* 中文站保留完整翻译、使用指南和 `config.yml` 设置参考。

### Fork 开发工具

* 保留 `bun run fastcheck`，仅检查本地修改的 TypeScript lint/format。
* 保留 `bun scripts/jch-localci.ts [full]` 作为独立 Linux-x64 本地检查入口；默认不构建 native，`full` 才构建。
* Todo 仅在请求包含至少 3 个独立用户可见结果时创建。
