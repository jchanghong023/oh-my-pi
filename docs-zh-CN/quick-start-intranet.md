# OMP Fork：项目简介与内网快启

## 1. 与上游的差异和贡献

截至 2026-11-22，本 Fork 的 `main`（`28fdf1a48d`）比上游 `main`（`e1a9f4b41d`）领先 **1,573 个提交**（含合并提交），落后 0 个。`jchanghong023` 向上游提交了 **81 个 PR**。

## 2. 项目哲学

做一个个人开箱即用的 Agent：从红区 CentOS 7 到黄区 Windows 和自己的 Linux 机器，都用同一个 OMP。**默认零配置**：无需手写 OMP 配置文件，红区特殊环境优化。

## 3. 下载

- CNB：优先下载，发布更快。`https://cnb.cool/jchanghong/bin/-/releases`
- GitHub：定期同步。`https://github.com/jchanghong023/oh-my-pi/releases`
- 嵌入式 SDK：在 CNB 的 `omp` 发布中，黄区 Windows x64 选 `omp-sdk-win32-x64.zip`（需 AVX2），红区 Linux x64 选 `omp-sdk-linux-x64.zip`（glibc 2.17 baseline）。这两个 ZIP 用于[编译 SDK 宿主](../README.md#windows--linux-x64-sdk-构建包)，不是 CLI 安装包。

`omp update` 只原地更新独立 fork 二进制。若当前安装由包管理器维护，要切换到本 fork，请按[安装说明](../README.md#安装)重新安装。
如果安装版本比最新稳定版更新，`omp update --stable` 只切换更新渠道，不降级。

## 4. 红区快速使用

在 CentOS 7 上将 `omp-linux-x64` 安装为 `PATH` 上的 `omp`。红区必配 `OMP_OFFLINE` 和 `OMP_CONFIG_ROOT`：下面两行 `setenv` 可放入 `.cshrc`，其余命令在 tcsh 终端执行。代理就绪后再运行 `omp`：

```tcsh
setenv OMP_OFFLINE 1
setenv OMP_CONFIG_ROOT "$HOME/omp-data"
ma dmas_ide
ide agent
cd /path/to/project
omp
```

### 环境变量与数据

- `OMP_CONFIG_ROOT`：持久数据目录，存放配置、凭据和会话。
- `OMP_CACHE_DIR`：可选性能目录，使用当前用户可访问的绝对路径；红区 Linux 默认使用 `/dev/shm/omp-<UID>`。缓存、统计、日志和运行依赖可避开网络磁盘。
- `OMP_SKILLS_DIR`：可选团队共享技能目录；用 `/extensions` 查看或启停共享技能，不改共享文件。

红区模式会暂时关闭 Web Search、Browser（含 `/crawl`）和 Fetch；本地文件和已配置、可达的内网服务仍可使用。

红区默认关闭终端程序状态通知（OSC 7501），防止不兼容的终端把 `7501…state=working…` 显示成输入。旧版或曾手动开启时，可运行 `omp config set terminal.programStatus false`，然后重启 OMP。

## 5. 黄区快速使用

- `OMP_CONFIG_ROOT`：可选，指定持久数据目录。
- `ASCEND_API_KEY`：仅使用 Ascend 时设置。

## 6. 本 Fork 的主要功能

### 启动与交互

- **启动提速与红区 NFS 优化**：在上游已经很快的基础上继续减少启动等待，并针对红区 NFS 优化交互响应。
- **中文终端与三种显示模式**：常用设置、模型选择和授权界面用中文；`/display clean` 专注聊天，`/display compact`（默认）显示活动与本轮 Diff，`/display detailed` 查看完整工具记录。
- **旧扩展升级**：使用旧 TUI 组件 API 的扩展需要按 [TUI 迁移指南](../docs/extensions.md#migrating-from-pi-tui) 更新；日常终端命令不需要迁移。
- **内网群聊**：用 `/collab2 1234` 开房、`/collab2 join 1234` 加入，多人可向同一个 Agent 发消息。设置了 `OMP_OFFLINE` 时默认连接 `10.239.93.104:9333`，未设置时连接 `127.0.0.1:9333`。开房和加入应使用同一服务器；可通过 `OMP_COLLAB2_IP` 覆盖，只填 IP，不带端口或子网前缀。
- **危险操作确认**：用 `omp --approval-mode guarded` 启动，普通工具调用自动放行，工具标记的危险操作仍需确认。
- **中文语音输入**：语音转写默认使用中文。
- **LSP 按需启用**：默认关闭；有可用语言服务器时，用 `omp config set lsp.enabled true` 开启定义、引用和诊断查询。

### 内置开源工具与技能

- **OpenSpec**：内置需求管理，用 `omp openspec init` 初始化项目，再用 `/skill:openspec-propose` 起草变更。
- **OpenWiki**：用 `omp openwiki code --init` 生成中文代码 Wiki，之后可以直接在聊天里问项目架构。
- **Superpowers**：内置开源开发工作流，用 `/skill:brainstorming` 梳理方案。
- **测试插件（Developer Test Agent）**：用 `/dt` 生成或修复 Python、Java、C/C++ 和 Go 单元测试。
- **复用 Codex 技能**：默认发现已有的 Codex 用户技能，无需复制。
- **内置记忆**：红区启用记忆后可直接复用未禁用的公司向量模型；显式向量配置仍优先。

### 多代理与无人值守

- **Team**：在 TUI 输入 `/team <需求>`，或从命令行运行 `omp -p '/team <需求>'`，发起只读调查和交叉评审，不改代码。命令行调用把问题写在命令里，不另附 stdin 或 `@文件`。
- **Goal Autopilot**：用 `/goal-autopilot <目标>` 运行无人值守长任务。无有效推荐的表单超时后返回未答复；恢复任务仍需结题复核。
- **按清单执行**：用 `/todoloop tasks.md --check` 只预检，用 `/todoloop tasks.md` 按组执行 Markdown 待办。
- **按需编排**：`/orchestrate` 拆解并分派任务，`/workflowz` 组织批量工作，`/ultrathink` 深入分析。
- **同目录实例通信**：默认允许同目录的其他 OMP 实例读取子代理输出并向其发消息；不需要时运行 `omp config set task.crossInstance false`。

### 个人内置技能与命令

- **需求与设计**：`/skill:jch-grill-me` 澄清需求，`/skill:jch-grill-todo` 生成任务清单，`/skill:jch-codebase-design` 设计模块与接口。
- **大仓审查**：`/skill:big-review-scan` 把仓库或 Fork 改动拆分初审，`/skill:big-review-verify` 对照源码复核发现。
- **独立使用档案**：用 `omp -P work` 启动，隔离配置和会话。
- **画布**：用 `/sketch` 手绘或贴图标注。附件加入草稿前可按 Esc 取消；PNG 成功加入后，由你手动发送。
- **控制改动**：`/minimal` 要求最小充分改动和验证；`/workspace` 提醒 Agent 限定写入范围，不是沙箱。
- **切换工作树**：`/wt <分支>` 切换会话工作树，不搬动或清理未提交的改动。
- **网页转 Markdown**：`/crawl <URL>` 不调用模型，直接爬内网保存网页内容。
- **循环与输入法**：`/loopn "检查" "复核"` 轮换提示词（`Esc` 停止）；`/jchime` 排查 Linux IBus/X11 中文输入问题。

## 7. 上游常用快捷键和内置命令

快捷键按本 Fork 的默认绑定列出。

- `Esc`：中断当前任务。已有排队消息时，正在运行的 Bash 命令转入后台，排队消息回到输入框。
- `Esc Esc`：输入框为空时打开对话回退面板。选定回退点会开启新会话，原会话保留。
- `Ctrl+T`：临时切换当前会话的模型。
- `Shift+Tab`：切换计划模式。
- `Ctrl+O`：展开或收起改动或工具详情。
- `Ctrl+Q`：将后续消息加入队列。
- `Ctrl+R`：搜索历史提示词；启用 Vim 编辑模式时，普通模式下用于重做，搜索历史用 `/` 或 `?`。
- `Alt+E`：切换模型的思考等级。
- `← ←`：输入框为空时连按两次左方向键，打开子代理面板；在子代理视图中返回主会话。
- `@`：搜索并引用项目文件。
- `/new`：新建会话。
- `/delete`：直接删除当前会话的历史记录及其附件，并开启新会话；不会弹出确认。
- `/resume`：恢复历史会话。
- `/tree`：查看并切换当前会话的分支。
- `/rename <标题>`：给当前会话改名。
- `/copy`：从对话中选择文字或代码复制。
