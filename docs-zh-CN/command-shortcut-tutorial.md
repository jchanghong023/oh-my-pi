# Oh My Pi 命令与快捷键教程

面向新手的速查手册：`omp` 怎么启动、每个内置子命令做什么、交互界面有哪些快捷键。本文只讲"什么时候用、用完会发生什么"；单个命令的完整参数用 `omp <命令> --help` 查看，全部设置见[设置参考](./settings-reference.md)。

## 最快上手

```sh
omp                                  # 直接进入交互会话
omp "修复构建错误"                    # 带着任务启动会话
omp @需求.md @截图.png "按文档实现"    # 把文件与图片附到首条消息
omp -p "总结最近一次提交"              # 非交互：处理完打印结果就退出（脚本用）
omp --continue                        # 继续上一次会话
```

几条约定，知道就不容易踩坑：

- 首个参数**不是**子命令时，整条命令默认按"启动会话"处理，剩下的文字就是给模型的消息：`omp models` 是子命令，`omp 你好` 是一次会话。少数像 `marketplace`、`uninstall` 这样的插件管理词会提示你改用 `omp plugin …`，确要当提示词发就在前面加 `omp launch`。
- `@路径` 把文件或图片附到首条消息；引号包住的路径里的空格不会拆词。
- `--` 之后的内容一律按字面文本发给模型，哪怕长得像选项：`omp -- --help` 是在问"--help 是什么"，不是打印帮助。
- 选项值直接跟在后面（`--model opus`），也可写 `--model=opus`；写等号形式时值允许以 `-` 开头。
- `--cwd`、`--model` 这类启动选项出现在最前面时，会转交给会话类命令；其他子命令会把它们剥掉而不是报错。
- `omp --help` 列出全部子命令与常用选项；`omp <子命令> --help` 看该命令自己的参数和示例。

## 常用启动选项

按用途分组，只列新手最常用的一批；完整清单看 `omp --help`。

**会话续接**

| 选项 | 作用 |
| --- | --- |
| `--continue`、`-c` | 继续上一次会话（最常用）。 |
| `--resume [id]`、`-r`、`--session [id]` | 按 ID 前缀或文件恢复会话；不带值则打开选择器。 |
| `--fork <会话>` | 把已保存会话复制成一个新分支继续。 |
| `--from-claude` / `--from-codex` | 导入 Claude Code / Codex 的会话（两者互斥，不能与续接选项同用）。 |
| `--export <会话>` | 把会话导出为 HTML 后退出。 |
| `--no-session` | 不保存本次会话（一次性）；续接与导入不可用。 |

**模型与推理**

| 选项 | 作用 |
| --- | --- |
| `--model <id或角色>` | 指定模型或角色（`slow` 等），支持模糊匹配（`opus`、`gpt-5.2`）。 |
| `--models <a,b,c>` | 逗号分隔的模型列表，供会话内 `Ctrl+P` 循环切换。 |
| `--thinking <等级>` | 思考等级：`off`…`max`、`auto`。 |
| `--hide-thinking` | 界面上隐藏思考块（只是不显示，不关闭模型思考）。 |
| `--print-thoughts` | 打印模式下把思考块也打进输出。 |

**输出方式**

| 选项 | 作用 |
| --- | --- |
| `--print`、`-p` | 非交互执行：处理完提示、打印最后回复、退出。管道输入会自动进入此模式。 |
| `--mode <模式>` | `text`（默认）、`json`（逐行 JSON 事件，供程序消费）、`rpc` / `rpc-ui`（界面宿主用）、`acp`（编辑器接入）。 |

**目录与环境**

| 选项 | 作用 |
| --- | --- |
| `--cwd <目录>` | 在指定目录启动。 |
| `--add-dir <目录>` | 额外加入一个工作区目录（可重复）。 |
| `--profile <名称>` | 使用隔离的配置档（独立的登录、会话、设置与缓存）。 |
| `--config <文件>` | 本次运行额外叠加一份 `config.yml` 式配置（可重复）。 |

**工具与审批**

| 选项 | 作用 |
| --- | --- |
| `--tools <a,b,c>` | 只启用列出的工具；`--no-tools` 全部关闭。 |
| `--no-lsp` | 关闭 LSP 工具、格式化与诊断。 |
| `--approval-mode <模式>` | 审批级别：`always-ask`、`write`、`yolo`；`--auto-approve` / `--yolo` 是 yolo 的快捷写法。 |
| `--max-time <时长>` | 到时停止会话（`600`、`10m`、`1h`）。 |

**扩展与提示词**

| 选项 | 作用 |
| --- | --- |
| `--extension <路径>`、`-e` | 本次加载一个扩展（可重复）。 |
| `--skills <通配>` | 只加载匹配的技能（如 `git-*,docker`）；`--no-skills` 全关。 |
| `--system-prompt <文本或文件>` | 整体替换系统提示词；`--append-system-prompt` 追加。 |
| `--plan-yolo` | 以只读计划模式启动，自动接受模型方案后切到执行模型实现。 |
| `--goal <目标>` | 直接进入目标模式开始干活（交互会话专用）。 |

## 全部内置子命令

按用途分组；别名写在括号里。

### 启动与协作

| 命令 | 用途 |
| --- | --- |
| `launch` | 启动编码会话（默认命令，`omp` 就是它）。 |
| `acp` | 作为 ACP 服务器经 stdio 运行，供编辑器等客户端接入。 |
| `join` | 加入分享出来的协作会话（等同会话内 `/join`）。 |
| `collab` | 列出本机活跃的协作主机；`collab link` 取控制链接（`--view` 只读）。 |
| `share` | 把已保存会话生成加密分享链接（等同 `/share`）。 |
| `clip` | 把 `/record` 录制上传为公开片段并打印链接。 |
| `play` | 在终端回放 `/record` 录制；空格暂停，`q` 退出。 |
| `stream` | 把本地会话画面与聊天广播到公开直播频道。 |
| `render` | 用生产渲染管线绘制整个会话记录（附重绘耗时）。 |

### 模型与账户

| 命令 | 用途 |
| --- | --- |
| `login` | 在终端登录模型提供商（等同 `/login`）。 |
| `models` | 列出、搜索、刷新可用模型。 |
| `usage` | 显示每个已认证账户的用量上限；`usage clients` 按客户端细分，`usage invalidate` 清缓存。 |
| `token` | 获取某提供商的 API key 或 OAuth 令牌。 |
| `tiny-models` | 下载本地小模型（会话标题、记忆、单词补全用）。 |
| `bench` | 模型吞吐基准：首字延迟、预填充与解码，实时仪表盘。 |
| `if-bench` | 指令遵循与工作记忆基准（缓存友好，适合行为回归）。 |
| `dry-balance` | 干跑 OAuth 多账户平衡逻辑（只在排障时用）。 |

### 配置与环境

| 命令 | 用途 |
| --- | --- |
| `config` | 管理配置项；全部设置说明见[设置参考](./settings-reference.md)。 |
| `setup` | 引导式初始化，或安装可选功能的依赖。 |
| `auth-broker` | 管理 omp 凭据保险库。 |
| `auth-gateway` | 运行由凭据库背书的 HTTP 前向代理（`serve`），或以 JSON 行方式供父进程使用（`stdio`）。 |
| `ssh` | 管理 SSH 主机配置。 |
| `completions` | 打印 shell 补全脚本（bash / zsh / fish）。 |

### 代码检索与 Git

| 命令 | 用途 |
| --- | --- |
| `grep` | 在命令行直接用 grep 工具检索代码。 |
| `read` | 看 read 工具对某个路径、URL 或内部 URI 会返回什么。 |
| `find` | 语义检索：找到实现某功能的文件与行范围。 |
| `search`（`q`、`web-search`） | 在命令行测试联网搜索。 |
| `git` | 全屏 Git 界面：分栏 diff、暂存侧栏、提交编辑器。 |
| `worktree`（`wt`） | 添加、列出、清理 Git worktree。 |
| `commit` | 生成提交信息并更新 changelog。 |

### 知识索引（fork 新增）

| 命令 | 用途 |
| --- | --- |
| `docs` | 管理外部 Markdown 知识库索引：`init` 建立、`remove` 删除；索引供 `/wiki` 面板与 `wiki` 工具检索。 |

### 进程与终端

| 命令 | 用途 |
| --- | --- |
| `ps` | 列出并控制后台守护进程（看日志、停止、重启）。 |
| `shell` | 交互式 shell 控制台。 |
| `say` | 用本地 TTS 引擎把文字合成并播放。 |
| `toks` | 用内置离线分词器统计文件或文本的 token 数。 |
| `compress` | 把文本文件改写成紧凑提示词格式，并报告丢弃了什么。 |
| `agents` | 管理内置任务 agent。 |
| `browser-relay` | 运行本地 CDP 中继，让浏览器自动化能驱动你自己的 Chrome 标签页。 |
| `cleanse` | 用加权并行子 agent 检测并修复项目诊断问题。 |

### 插件、技能与扩展

| 命令 | 用途 |
| --- | --- |
| `plugin`（`plugins`） | 管理插件：安装、卸载、列表、市场。 |
| `install` | 安装或链接一个扩展包（`plugin install` / `plugin link` 的别名）。 |
| `skill`（`skills`） | 在技能市场安装、搜索、发布、管理技能。 |

### 维护与诊断

| 命令 | 用途 |
| --- | --- |
| `update` | 检查并安装更新；`--canary` / `--stable` 切换发布通道。 |
| `gc` | 存储垃圾回收。 |
| `stats` | 查看使用统计。 |
| `grievances` | 查看、清理、上报自动质量记录积累的工具问题。 |
| `images`（`img`） | 检查、诊断、探测、清理图片发布后端。 |
| `ttsr` | 检查与测试 Time-Traveling Stream Rules（流式输出语义）。 |
| `predict` | 对比各单词补全引擎的实时幽灵文本。 |
| `gallery` | 在确定性画廊里预览工具、输入框、状态栏渲染器。 |

> 另有一个隐藏内部命令 `__complete`，只服务于 shell 补全脚本，不要手工调用。

## 交互界面快捷键

会话里输入 `/hotkeys` 随时查看内置速查，输入 `/` 浏览全部斜杠命令。下表为默认键位（本 fork 相对上游调整了 4 个，见本节末尾）。

### 全局动作

| 键 | 动作 |
| --- | --- |
| `Ctrl+P` / `Shift+Ctrl+P` | 向前 / 向后循环切换角色模型。 |
| `Ctrl+T` | 为当前会话临时选一个模型。 |
| `Alt+M` | 打开模型选择器并设置各角色。 |
| `Shift+Tab` | 切换计划模式（只读规划）。 |
| `Ctrl+R` | 搜索历史提示。 |
| `Ctrl+O` | 展开 / 收起工具输出。 |
| `Ctrl+Shift+O` | 显示 / 隐藏工具活动。 |
| `Alt+P` | 显示 / 隐藏思考块。 |
| `Shift+F1` | 循环思考等级。 |
| `Ctrl+G` | 用外部编辑器（`$VISUAL` / `$EDITOR`）编辑当前草稿。 |
| `Ctrl+Q` 或 `Ctrl+Enter` | 把下一条消息排入队列，不打断正在跑的回合。 |
| `Alt+Up` / `Shift+Up` | 把排队中的消息取回编辑器。 |
| `F5` / `Alt+R` | 重试上一次失败的回合。 |
| `Alt+L` | 重置终端显示（界面花掉时用）。 |
| `Alt+Shift+L` | 复制当前行。 |
| `Alt+Shift+C` | 复制整段提示。 |
| `Ctrl+Shift+V` / `Alt+Shift+V` | 粘贴文本且不做折叠处理。 |
| `Ctrl+V`（Windows 另有 `Alt+V`） | 粘贴剪贴板：优先图片，没有图片就贴文本。 |
| 按住 `Space` | 语音输入：按住说话、松开转写；也可在设置里绑定开关键。 |
| `Ctrl+L` | 实时语音模式开关（同 `/live`）。 |
| `Alt+A` | 打开 Agent Hub，监督子 agent 的活动与用量。 |

### 草稿与退出

- `Ctrl+C` 清空未发送的草稿；**紧接着按 `Up` 可以找回**（含图片附件与折叠粘贴，最多 100 条）。连按两次 `Ctrl+C` 退出 omp。

### 魔法关键词与斜杠命令（fork 增强）

消息以 `fullsend`、`ultrathink`、`orchestrate`、`workflowz` 开头会附加对应的隐藏提示；同名斜杠命令 `/fullsend`、`/ultrathink`、`/orchestrate`、`/workflowz` 都接受可选任务文本，例如 `/fullsend 完成并验证发布`。开关与语义见[设置参考](./settings-reference.md)的 `magicKeywords` 条目。

### Vim 模式（默认关闭）

在 `/settings` 的 Interaction → Input 里开启 Vim Editing Mode。提示词框从插入模式出发：`Escape` 回普通模式（边框变色提示），`v` / `V` 进字符 / 行选择。常用键：`h j k l` 移动、`w b e` 词移动、`0 ^ $` 行首 / 首个非空 / 行尾、`gg` / `G` 首末行、`i a I A o O` 进入插入、`dd` / `yy` / `cc` 行级删除 / 复制 / 修改、配合动作的 `dw` `cw` `yb`、`p` / `P` 粘贴、`u` 撤销。`Ctrl` 组合键、`Enter`、`Tab` 在任何模式下都保持应用行为——`Enter` 在普通模式照样发送。

### 自定义键位

用户改键写在 `~/.omp/agent/keybindings.yml`：键是动作 ID，值是一个和弦或数组；置空数组表示禁用该动作。

```yaml
app.model.cycleForward: Ctrl+P
app.history.search: []
```

### 本 fork 的默认键位差异

相对上游交换了 4 个默认键：计划模式 `Shift+Tab`（上游 `Alt+Shift+P`）、临时选模型 `Ctrl+T`（上游 `Alt+P`）、思考块开关 `Alt+P`（上游 `Ctrl+T`）、思考等级循环 `Shift+F1`（上游 `Shift+Tab`）。从上游迁过来的 `keybindings.yml` 不受影响。

## 按场景选命令

1. **想跑会话** → `omp`（默认入口）；脚本化用 `omp -p` 或 `--mode json`；编辑器嵌入用 `omp acp`。
2. **想续 / 复 / 派会话** → `--continue`（最常用）、`--resume`（按 id 选）、`--fork`（开分支）、`--from-claude|--from-codex`（跨工具导入）、`share` + `join`（协作接入）。
3. **想取信息** → `omp grep`（代码）、`omp read`（文件 / URL）、`omp search`（联网）、`omp models`（可用模型）、`omp usage`（账户上限）。
4. **想加能力** → `omp plugin`（长期）、`omp install`（一次性）、`-e`（本次）、`omp setup`（补依赖）。
5. **想看进程** → `omp ps`（后台进程）、`omp worktree list`（隔离工作树）、`omp grievances`（工具问题记录）。
6. **想收尾** → `omp update`（升级）、`omp gc`（回收存储）、`omp worktree clear`（清工作树）、`omp stats`（统计）。
7. **想诊断 / 基准** → `omp bench` / `omp if-bench`（模型）、`omp dry-balance`（账户调度）、`omp ttsr`（流式语义）、`omp images`（图片后端）。
8. **想展示 / 离线化** → `--export`（HTML）、`omp gallery`（渲染预览）、`omp render`（整段转录）、`omp completions`（shell 补全）。
