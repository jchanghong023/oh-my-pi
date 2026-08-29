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
- **主代理切换**：TUI 在补全未接管时用 `Tab` 于共享同一会话历史的 Main/Discuss 主代理间切换；Discuss 仅开放调查工具，禁止执行、写入、todo 与子代理委派。
  - 子代理满载并发：待办充足时任一完成立即补位、禁止多数等单个慢任务；任务不足窗口时全量启动、不硬凑。
- **魔法关键词斜杠命令**：为 `ultrathink`、`orchestrate`、`workflowz`、`fullsend` 注册可携带任务文本的斜杠命令。
- **JCH 个人命令**：新增 `/jchfix`、`/jchfixactions`、`/jchcatchup`、`/jchgs`、`/jchgitpull`、`/jchgitforcesync` 6 个可携带任务文本的斜杠命令（`/jchgitpush`、`/jchgitcommit` 已移除），实现见 `packages/coding-agent/src/jch-commands/`：
  - `/jchfix`：复现或确认现象后读取真实实现与调用链定位根因，只做最小修复、仅更新实际受影响的调用方与跨文件契约，测试按可观察行为更新，配置本身是根因时才允许修改；环境无法验证时报告阻塞、不提交。
  - `/jchfixactions`：先 `git fetch --all`，从当前分支 upstream remote URL 解析目标 GitHub 仓库，定位该仓库与当前分支相关的最新有效失败 run（failure/timed_out/startup_failure）并读 job/step/log 定位真实根因，按 event 判定 head SHA，只提交本次 CI 修复并普通 push，优先用 push 自然产生的新 run 验证，最多 3 轮修复；用于闭环修复 CI。
  - `/jchcatchup`：先 `git fetch --all`，再只读梳理仓库、分支、upstream、conflicts、staged/unstaged/untracked 与 diff、ahead/behind、local-only 与 remote-only commits，按修改路径或提交差异查看约 10–20 个相关 commits，输出“已完成 / 当前状态 / 未完成与异常 / 建议下一步”；用于接续工作时快速恢复现场。
  - `/jchgs`：先 `git fetch --all` 更新远端引用，再梳理当前分支、upstream、remote、conflicts、staged/unstaged/untracked、ahead/behind、未推送提交与远端新增提交，指出异常与最小安全的下一步；用于快速了解当前目录及其仓库的状态。
  - `/jchgitpull`：先 `git fetch --all`，再对当前分支按仓库已有 pull 配置执行普通 `git pull`，不自行决定 merge/rebase 策略、保留本地修改、失败时报告阻塞；用于更新当前分支。
  - `/jchgitforcesync`：命令本身即授权丢弃当前分支全部本地内容（staged、unstaged、untracked、ignored 与 local-only commits）——fetch all 后 hard reset 到最新 upstream tip 并彻底 clean，无 upstream 时停止、不 force-push；用于彻底对齐远端最新状态。
- **Claude 配置同步**：新增 `omp sync-claude [--provider <name>]`，把 Claude Code 的 `ANTHROPIC_BASE_URL` 与 `ANTHROPIC_AUTH_TOKEN` 写入当前 profile 的 `models.yml`。
- **移动端 TUI**：新增 `tui.mobile` 紧凑布局预设，默认关闭。

### 默认行为

- **默认设置**：`recap.enabled=false`、深色主题 `dark-terminal`、`display.showTurnTime=true`、`task.maxConcurrency=8`（上游默认 `32`）。
- **本地化/终端默认**：`statusLine.separator=slash`（上游 `powerline-thin`，默认字体无需 Nerd Font）、`mnemopi.embeddingVariant=multilingual`（上游 `en`，中文记忆召回）、`stt.language=zh-CN`（上游 `en`，中文语音转写）。
- **快捷键**：`Shift+Tab` 切换计划模式、`Ctrl+T` 选择临时模型、`Alt+P` 切换 thinking，并保留对应扩展快捷键冲突检查。
- **状态栏**：默认显示 active time；空间不足时把溢出段保留到第二行，按 editor top-border content width 居中并以 `floor((width-statusWidth)/2)` 左 inset 独立拟合终端行宽；每个 part 前重新打开文本色，分隔符后也复位，无自带 ANSI 的段（如 `time_spent`）不继承终端默认或 `statusLineSep` 色。

### 发布与文档

- **更新 URL 校验**：`omp update` 校验 GitHub release asset URL 前先做 percent-decode 归一化，容忍 tag 中 `+` 被编码为 `%2B`（`v18.0.9+fork.N` 的 `browser_download_url` 必需）。
- **安装/更新体验**：`install.sh` 与 `install.ps1` 在替换前先终止目标路径正在运行的旧 omp（Linux 按 `/proc/*/exe` 解析，Windows 按进程 Path 匹配）；下载到临时文件后原子替换（Linux 用 `mv`，Windows 用 `Move-Item`），避免 ETXTBSY/curl 23 与 exe 文件锁；Windows `curl.exe` 下载失败时自动回退 `Invoke-WebRequest`；安装与 `omp update` 下载显示进度条（百分比/速度/ETA），失败时输出 URL、HTTP 状态与服务器错误正文。
- **文档站**：新增英文/中文 VitePress 首页、自动侧栏与 GitHub Pages 发布；中文站提供完整翻译、使用指南和 `config.yml` 设置参考。

### 开发维护

- **本地快速检查**：新增 `bun run fastcheck`，从 `biome.json` 的 `files.includes` 编译正/排除 glob，只把实际交给 Biome 的文件标为 `checking`、其余标为 `skipping ... outside biome.json files.includes`；配置缺失或解析失败立即报错，零 included 时直接成功退出，禁止回退到“全部已检查”。
- **CI 与回归稳定性**：仅保留消费者实际恢复的 `warm_bun` Bun store cache 预热（删除无消费者的 `warm_darwin` 及其注释）；校验 timestamped musl binary、重试已知 pi-shell 信号竞态，并让 yield cancellation 与 fd inheritance 测试确定化。
- **CI 原生构建与测试并行化**：原生 addon 构建按 triple 拆成 6 个并行 job（matrix）+ gather 合并产物，Rust 测试拆 2 分片并行；下游 `needs` 与 `native-addons` artifact 布局不变。
- **原生 VCS 索引一致性**：连续 stage/unstage/commit 时直接重读磁盘 index，避免文件系统时间戳粒度导致 gitoxide 复用旧快照；状态读取使用 fresh repository handle。
