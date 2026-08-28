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
- **JCH 个人命令**：记录 `/jchfix`、`/jchfixactions`、`/jchcatchup`、`/jchgitpull`、`/jchgitpush`、`/jchgitforcesync`、`/jchgitcommit`。
- **Claude 配置同步**：新增 `omp sync-claude [--provider <name>]`，把 Claude Code 的 `ANTHROPIC_BASE_URL` 与 `ANTHROPIC_AUTH_TOKEN` 写入当前 profile 的 `models.yml`。
- **移动端 TUI**：新增 `tui.mobile` 紧凑布局预设，默认关闭。

### 默认行为

- **默认设置**：`recap.enabled=false`、深色主题 `dark-terminal`、`display.showTurnTime=true`。
- **快捷键**：`Shift+Tab` 切换计划模式、`Ctrl+T` 选择临时模型、`Alt+P` 切换 thinking，并保留对应扩展快捷键冲突检查。
- **状态栏**：默认显示 active time；空间不足时把溢出段保留到第二行，按 editor top-border content width 居中并以 `floor((width-statusWidth)/2)` 左 inset 独立拟合终端行宽；每个 part 前重新打开文本色，分隔符后也复位，无自带 ANSI 的段（如 `time_spent`）不继承终端默认或 `statusLineSep` 色。

### 发布与文档

- **Fork 发布与更新**：安装脚本和 README 使用 `jchanghong023/oh-my-pi` release；POSIX 与 PowerShell installer 默认/仅 `--ref`/`-Ref` 都走 fork binary，仅显式 `--source`/`-Source` 才 clone fork（默认 `main`）并安装本地 `packages/coding-agent`；保留下载进度、PATH 冲突警告与 `--version` build timestamp。
- **文档站**：新增英文/中文 VitePress 首页、自动侧栏与 GitHub Pages 发布；中文站提供完整翻译、使用指南和 `config.yml` 设置参考。

### 开发维护

- **本地快速检查**：新增 `bun run fastcheck`，从 `biome.json` 的 `files.includes` 编译正/排除 glob，只把实际交给 Biome 的文件标为 `checking`、其余标为 `skipping ... outside biome.json files.includes`；配置缺失或解析失败立即报错，零 included 时直接成功退出，禁止回退到“全部已检查”。
- **CI 与回归稳定性**：仅保留消费者实际恢复的 `warm_bun` Bun store cache 预热（删除无消费者的 `warm_darwin` 及其注释）；校验 timestamped musl binary、重试已知 pi-shell 信号竞态，并让 yield cancellation 与 fd inheritance 测试确定化。
- **原生 VCS 索引一致性**：连续 stage/unstage/commit 时直接重读磁盘 index，避免文件系统时间戳粒度导致 gitoxide 复用旧快照；状态读取使用 fresh repository handle。
