# Fork 与上游差异

本页是最近合入的上游正式 release 与当前 fork 差异的状态快照，不是 release 历史账本；每个列表项的描述最多占 2 个 Markdown 源码行；只维护一个“当前上游基线”段与一个仅含当前 release 的“上游同步记录”段。

## 当前上游基线

- **版本**：`v18.0.11`
- **同步日期**：2026-08-29
- **Merge**：`3ad7875fdd`

## 上游同步记录

- 2026-08-29：合入正式 release `v18.0.11`（merge `3ad7875fdd`）。

## Fork 改动

### 仓库治理

- **差异维护**：`AGENTS.md` 要求修改本 fork 前先阅读本页，并要求 fork 改动与上游 release 同步完成后在同一变更中更新当前快照。
- **上游同步**：只合入上游正式 release tag，使用 `.omp/skills/upstream-release-sync/SKILL.md`；merge 后以 committer date 的 UTC 日期、hash 原位替换唯一同步记录并产出独立 docs commit，不保留 release 历史。
- **Release 基线**：`.github/workflows/ci.yml` 的 `release_metadata` 从本页“当前上游基线”读取 `baseline_tag`，生成 `<baseline-without-v>+fork.${{ github.run_number }}`，不再回退到上游 latest。

### 用户功能

- **Markdown 文档索引**：新增外部 Markdown 目录持久索引与内嵌 `dft` schema；`/docs` 管理索引，`wiki` 作为 essential 只读内置工具默认提供给非受限代理，受限会话保持显式白名单；无专用文档子代理、`/doc` 或自然语言路由；默认仅建 FTS 且工具层拒绝结构化操作，结构化提取需显式选择，`init/reinit` 以隐藏代际全量构建并原子切换。
- **Command Code**：新增 `command-code` provider、API key 登录、模型发现与缓存身份归一化；登录只 trim/store、不绑定官方校验端点，实际请求使用配置的 provider baseUrl；env metadata 优先 `COMMAND_CODE_API_KEY`，回退 legacy `COMMANDCODE_API_KEY`。
- **OpenCode Zen 免费模型**：模型中心只展示 `opencode-zen` 与旧 `opencode` 中 catalog bundled 且 input/output 价格都为零的模型；缺失 cost 的 bundled/discovered 行直接跳过，gateway 新 ID 按“价格未知”隐藏，主列表与 locked preview 共用过滤。
- **主代理切换**：TUI 的 `Tab` 在有补全时接受补全，无补全且主会话空闲时按输入顺序切换 Main/Discuss；讨论主代理仅保留只读调查工具，禁止执行命令、写入、todo 和子代理委派；工具目录刷新保留动态挂载的 `xd://` 设备。
- **子代理满载并发**：待办充足时任一完成立即补位、禁止多数等单个慢任务；任务不足窗口时全量启动、不硬凑。
- **魔法关键词斜杠命令**：为 `ultrathink`、`orchestrate`、`workflowz`、`fullsend` 注册可携带任务文本的斜杠命令；RPC builtin residual prompt 同步转发 images 与 steer/followUp 行为。
- **JCH 个人命令**：新增 `/jchfix`、`/jchdiagnose`、`/jchfuncreview`、`/jchfuncreviewfix`、`/jchverify`、`/jchci`、`/jchcifix`、`/jchcatchup`、`/jchgs`、`/jchgitpull`、`/jchgitdiscardall` 11 个个人斜杠命令，实现见 `packages/coding-agent/src/jch-commands/`：
  - `/jchfix`：必填问题参数，按真实调用链定位根因并最小修复，执行直接验证和项目强制检查，不提交或推送。
  - `/jchdiagnose`：必填问题参数，只读确认正确行为、根因证据、影响范围与最小修复边界，不改变文件或外部状态。
  - `/jchfuncreview`：显式选择未提交修改、指定 commit 或路径，委派独立只读子代理按现实可达、高置信功能问题门槛审查，主代理复核后只报告成立问题。
  - `/jchfuncreviewfix`：显式选择未提交修改、指定 commit 或整个仓库，独立只读子代理先审查、主代理裁决后最小修复；项目强制检查不受可选验证 10 秒上限约束。
  - `/jchverify`：显式选择未提交修改、指定 commit 或路径，只读执行直接行为验证、相关既有测试和项目强制检查，报告是否可交付而不修复。
  - `/jchci`：只读检查当前分支及可确认关联 PR 的有效 GitHub Actions runs、HEAD 关系和失败证据，不重跑、触发、取消、提交或推送。
  - `/jchcifix`：定位当前分支最新有效 CI 失败，最小修复后仅提交并普通推送相关改动；手动 dispatch 必须指定已推送 upstream branch，验证对应 HEAD，最多 3 轮。
  - `/jchcatchup`：更新远端引用后梳理分支、upstream、工作区 diff、相关 untracked 源文件及提交差异，读取足以解释现场且默认不超过 20 个相关 commits。
  - `/jchgs`：更新远端引用后报告当前分支、upstream、remote、工作区、ahead/behind、未推送与远端新增提交，以及最小安全下一步。
  - `/jchgitpull`：先 fetch all，再按既有 pull 配置更新当前分支；参数仅作补充，不改变当前分支目标或 merge/rebase 策略。
  - `/jchgitdiscardall`：交互式 TUI 专用，明确授权丢弃当前分支 staged、unstaged、untracked、ignored 与 local-only 内容；fetch 后复核 upstream 存在再 reset/clean，不修改远端。
- **Claude 配置同步**：新增 `omp sync-claude [--provider <name>]`，把 Claude Code 的 `ANTHROPIC_BASE_URL` 与 `ANTHROPIC_AUTH_TOKEN` 写入当前 profile 的 `models.yml`。
- **移动端 TUI**：新增 `tui.mobile` 紧凑布局预设，默认关闭。

### 默认行为

- **默认设置**：`recap.enabled=false`、`statusLine.compactThinkingLevel=false`、`composer.shape=pi`（状态栏独立置于输入框下方并按需自动换行）、深色主题 `dark-terminal`、`display.showTurnTime=true`、`task.maxConcurrency=8`（上游默认 `32`）。
- **本地化/终端默认**：`statusLine.separator=slash`（上游 `powerline-thin`，默认字体无需 Nerd Font）、`mnemopi.embeddingVariant=multilingual`（上游 `en`，中文记忆召回）、`stt.language=zh-CN`（上游 `en`，中文语音转写）。
- **文件日志关闭**：集中日志器默认不启用文件 transport，不创建日志目录、日志文件或空文件；显式调用 `setTransports` 的服务与测试不受影响。
- **快捷键**：`Shift+Tab` 切换计划模式、`Ctrl+T` 选择临时模型、`Alt+P` 显示或隐藏 thinking blocks，并保留对应扩展快捷键冲突检查。
- **状态栏**：默认显示 active time，启动即应用已配置的 preset/segments；空间不足时将全部溢出段按可用宽度自动换行，box 行按 editor top-border content width 居中并以 `floor((width-statusWidth)/2)` 左 inset 独立拟合终端行宽；每个 part 前重新打开文本色，分隔符后也复位，无自带 ANSI 的段（如 `time_spent`）不继承终端默认或 `statusLineSep` 色。

### 发布与文档

- **更新 URL 校验**：`omp update` 校验 GitHub release asset URL 前先做 percent-decode 归一化，容忍 tag 中 `+` 被编码为 `%2B`（`v18.0.9+fork.N` 的 `browser_download_url` 必需）。
- **Fork 二进制发布**：CI 由 `workflow_dispatch` 构建，`queue: max` 保留同 ref 的全部等待运行，仅允许从 `main` 按输入发布 `+fork.N` GitHub Release；二进制嵌入 fork 版本、构建时间与更新仓库，`omp update` 比较 fork build counter 并从 fork Release 更新。
- **安装/更新体验**：安装器比较已装版本、同版本跳过下载并以唯一同目录临时文件原子替换；Linux 不终止现有会话，旧进程继续使用旧 inode 并提示重启；Windows 因 exe 文件锁仅在提前告警后终止目标 Path 精确匹配的进程；保留下载进度、curl 回退与错误正文。
- **文档站**：新增英文/中文 VitePress 首页、自动侧栏与 GitHub Pages 发布；两套 locale 各自提交 `package-lock.json` 并以 `npm ci` 锁定依赖构建，部署 checkout 完整 Git 历史以输出页面真实 `lastUpdated`；中文站提供完整翻译、使用指南和 `config.yml` 设置参考。
- **DFT 知识调研**：完全重写为 OMP 内置 Markdown 索引技术报告；先概览采集、FTS/RAG、结构化抽取、图/MCP、Agent/代码索引等相关技术，再详述 `docs`/`wiki` 的 FTS 与 structured 实现、生命周期、安全和适用边界，并保留 grep 对照实测基线。

### 开发维护

- **本地快速检查**：新增 `bun run fastcheck`，从 `biome.json` 的 `files.includes` 编译正/排除 glob，只把实际交给 Biome 的文件标为 `checking`、其余标为 `skipping ... outside biome.json files.includes`；配置缺失或解析失败立即报错，零 included 时直接成功退出，禁止回退到“全部已检查”。
- **源码 UI 启动**：新增 `bun run omp2`，仅从 `$HOME/.omp/natives/<version>` 加载匹配版本的原生包，以当前仓库 TypeScript 源码启动交互式界面且不触发本地原生构建；`AGENTS.md` 要求仅测试交互式 UI 时使用该命令。
- **CI 与回归稳定性**：原生 TS 分桶经 `xvfb-run` 提供显示服务覆盖可见 Chromium，进程内用例保留启动页避免关闭最后窗口时浏览器退出；Brush 将全外部命令的后台 pipeline 直接记录为含全部进程的 job；`pi-shell` jobspec 信号测试在同一次 shell 执行内完成就绪、`%1` 信号与回收；Git 测试 fixture 禁用自动维护且状态栏 VCS 测试显式启用 Git；`warm_bun` 按需预热，yield cancellation 与 fd inheritance 测试保持确定化；冷启动恢复夹具遵循真实 CLI 的 prepaint gate，resume/continue/fork 使用绑定同一测试终端但尚未启动的 composer；文档 evidence 夹具跨断言按源路径选择证据，Mnemopi dispose 超时夹具使用可控 timer。
- **CI 原生构建与测试并行化**：原生 addon 构建按 triple 拆成 6 个并行 job（matrix）+ gather 合并产物，Rust 测试拆 2 分片并行；下游 `needs` 与 `native-addons` artifact 布局不变。
- **Nix Bun 依赖锁**：为 Command Code 的 `turbo-stream` 同步再生 `nix/bun.nix`；OMP Nix 显式构建 `bun-lock` check，并规范 native/WASM 生成器的 EOF 换行差异，防止依赖表达式漂移。
- **原生 VCS 索引一致性**：连续 stage/unstage/commit 时直接重读磁盘 index，避免文件系统时间戳粒度导致 gitoxide 复用旧快照；状态读取使用 fresh repository handle。
