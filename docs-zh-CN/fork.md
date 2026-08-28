# Fork 与上游差异

本页以最近合入的上游正式 release 为比较基线。上游同步和 fork 差异都在此维护；每个列表项的描述最多占 2 个 Markdown 源码行；只维护一个“当前上游基线”段与一个“上游同步记录”段。

## 当前上游基线

- **版本**：`v18.0.10`
- **同步日期**：2026-08-28
- **Merge**：`ae423ed6ec`

## 上游同步记录

- 2026-08-28：合入正式 release `v18.0.10`（merge `ae423ed6ec`）。

## Fork 改动

### 仓库治理

- **差异维护**：`AGENTS.md` 链接本页，并要求 fork 改动与上游 release 同步在同一变更中更新清单。
- **上游同步**：只合入上游正式 release tag，使用 `.omp/skills/upstream-release-sync/SKILL.md`；merge 后立即在 `docs-zh-CN/fork.md` 记录 hash、UTC 日期并产出独立 docs commit，与 merge commit 共同构成一次同步变更。
- **Release 基线**：`.github/workflows/ci.yml` 的 `release_metadata` 从本页“当前上游基线”读取 `baseline_tag`，生成 `<baseline-without-v>+fork.${{ github.run_number }}`，不再回退到上游 latest。

### 用户功能

- **Command Code**：新增 `command-code` provider、API key 登录、模型发现与缓存身份归一化；状态栏 env metadata 按 `$pickenv` 优先级回显真实 envVar（`COMMAND_CODE_API_KEY` 优先，缺省回退 legacy `COMMANDCODE_API_KEY`）。
- **OpenCode Zen 免费模型**：模型中心只展示 `opencode-zen` 与旧 `opencode` 中 catalog bundled 且 input/output 价格都为零的模型，gateway 新 ID 在 catalog 更新前按“价格未知”隐藏，主列表与 locked preview 共用同一过滤。
- **讨论模式**：新增 `/discuss on|off|status`；启用时只允许调查和讨论，移除写工具、执行、todo 与实现行为；session 切换到目标 transcript 时恢复源 session 的工具快照（包括合法空数组），失败需抛错，禁止留下“模式已关闭、工具仍被过滤”的静默状态。
- **Fullsend**：新增独立小写关键词与 `/fullsend [task]`，以最快的完整、正确、已验证交付为目标，同速时优先并行委派。
- **魔法关键词斜杠命令**：为 `ultrathink`、`orchestrate`、`workflowz`、`fullsend` 注册可携带任务文本的斜杠命令。
- **JCH 个人命令**：新增 `/jchfix`、`/jchfixactions`、`/jchcatchup`、`/jchgs`、`/jchgitpull`、`/jchgitpush`、`/jchgitforcesync`、`/jchgitcommit` 8 个可携带任务文本的斜杠命令，实现见 `packages/coding-agent/src/jch-commands/`：
  - `/jchfix`：复现或确认现象后读取真实实现与调用方定位根因，做最小修复并迁移受影响调用方、按可观察契约验证；用于把问题一次修好，不压制症状、不 commit/push。
  - `/jchfixactions`：定位最近一次失败的 GitHub Actions workflow run 并读取失败日志定位根因，修复后按仓库约定提交、普通 push，再用 `gh` 触发同一 workflow 验证；用于闭环修复 CI。
  - `/jchcatchup`：严格只读梳理仓库、分支、冲突、工作区 diff 与最近 commits，还原当前改造的进度与风险，输出“已完成 / 当前状态 / 未完成与异常 / 建议下一步”；用于接续工作时快速恢复现场。
  - `/jchgs`：严格只读地运行 git status、git remote -v 等并梳理分支、upstream、ahead/behind、工作区改动与远端配置，指出异常与最小安全的下一步；用于快速了解当前目录及其仓库的状态。
  - `/jchgitpull`：先核对当前分支、upstream 与工作区状态再按仓库配置拉取，保留本地修改、不 reset/clean/stash，拉取不安全时说明阻塞；用于安全更新当前分支。
  - `/jchgitpush`：先核对 upstream 与相对远端的 ahead/behind，默认普通 push、不推无关分支或 tags，仅参数明确要求时才用 `--force-with-lease`；用于安全推送当前分支。
  - `/jchgitforcesync`：命令本身即授权丢弃本地改动——fetch 后把当前分支 reset 到远端 tip 并清理 untracked 文件，默认不删 ignored、不 force-push；用于彻底对齐远端最新状态。
  - `/jchgitcommit`：按仓库提交约定只提交目标相关文件，必要时拆分明显无关的修改，不 push；用于生成干净、聚焦的 commit。
- **Claude 配置同步**：新增 `omp sync-claude [--provider <name>]`，把 Claude Code 的 `ANTHROPIC_BASE_URL` 与 `ANTHROPIC_AUTH_TOKEN` 写入当前 profile 的 `models.yml`。
- **移动端 TUI**：新增 `tui.mobile` 紧凑布局预设，默认关闭。

### 默认行为

- **默认设置**：`recap.enabled=false`、深色主题 `dark-terminal`、`display.showTurnTime=true`。
- **快捷键**：`Shift+Tab` 切换计划模式、`Ctrl+T` 选择临时模型、`Alt+P` 切换 thinking，并保留对应扩展快捷键冲突检查。
- **状态栏**：默认显示 active time；空间不足时把溢出段保留到第二行，按 editor top-border content width 居中并以 `floor((width-statusWidth)/2)` 左 inset 独立拟合终端行宽；每个 part 前重新打开文本色，分隔符后也复位，无自带 ANSI 的段（如 `time_spent`）不继承终端默认或 `statusLineSep` 色。

### 发布与文档

- **更新 URL 校验**：`omp update` 校验 GitHub release asset URL 前先做 percent-decode 归一化，容忍 tag 中 `+` 被编码为 `%2B`（`v18.0.9+fork.N` 的 `browser_download_url` 必需）。
- **安装/更新体验**：`install.sh` 与 `install.ps1` 在替换前先终止目标路径正在运行的旧 omp（Linux 按 `/proc/*/exe` 解析，Windows 按进程 Path 匹配）；下载到临时文件后原子替换（Linux 用 `mv`，Windows 用 `Move-Item`），避免 ETXTBSY/curl 23 与 exe 文件锁；安装与 `omp update` 下载显示进度条（百分比/速度/ETA），失败时输出 URL、HTTP 状态与服务器错误正文。
- **文档站**：新增英文/中文 VitePress 首页、自动侧栏与 GitHub Pages 发布；中文站提供完整翻译、使用指南和 `config.yml` 设置参考。

### 开发维护

- **本地快速检查**：新增 `bun run fastcheck`，从 `biome.json` 的 `files.includes` 编译正/排除 glob，只把实际交给 Biome 的文件标为 `checking`、其余标为 `skipping ... outside biome.json files.includes`；配置缺失或解析失败立即报错，零 included 时直接成功退出，禁止回退到“全部已检查”。
- **CI 与回归稳定性**：仅保留消费者实际恢复的 `warm_bun` Bun store cache 预热（删除无消费者的 `warm_darwin` 及其注释）；校验 timestamped musl binary、重试已知 pi-shell 信号竞态，并让 yield cancellation 与 fd inheritance 测试确定化。
- **CI 原生构建与测试并行化**：原生 addon 构建按 triple 拆成 6 个并行 job（matrix）+ gather 合并产物，Rust 测试拆 2 分片并行；下游 `needs` 与 `native-addons` artifact 布局不变。
- **原生 VCS 索引一致性**：连续 stage/unstage/commit 时直接重读磁盘 index，避免文件系统时间戳粒度导致 gitoxide 复用旧快照；状态读取使用 fresh repository handle。
