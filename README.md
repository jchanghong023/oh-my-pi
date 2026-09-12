<p align="center">
  <img src="https://github.com/can1357/oh-my-pi/blob/main/assets/hero.png?raw=true" alt="omp">
</p>

<p align="center">
  <strong>把 IDE 接进终端的编码 agent。</strong>
  <strong><a href="https://omp.sh">omp.sh</a></strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent"><img src="https://img.shields.io/npm/v/@oh-my-pi/pi-coding-agent?style=flat&colorA=222222&colorB=CB3837" alt="npm version"></a>
  <a href="https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/CHANGELOG.md"><img src="https://img.shields.io/badge/changelog-keep-E05735?style=flat&colorA=222222" alt="Changelog"></a>
  <a href="https://github.com/can1357/oh-my-pi/actions"><img src="https://img.shields.io/github/actions/workflow/status/can1357/oh-my-pi/ci.yml?style=flat&colorA=222222&colorB=3FB950" alt="CI"></a>
  <a href="https://github.com/can1357/oh-my-pi/blob/main/LICENSE"><img src="https://img.shields.io/github/license/can1357/oh-my-pi?style=flat&colorA=222222&colorB=58A6FF" alt="License"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&colorA=222222&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://www.rust-lang.org"><img src="https://img.shields.io/badge/Rust-DEA584?style=flat&colorA=222222&logo=rust&logoColor=white" alt="Rust"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-f472b6?style=flat&colorA=222222" alt="Bun"></a>
  <a href="https://discord.gg/4NMW9cdXZa"><img src="https://img.shields.io/badge/Discord-5865F2?style=flat&colorA=222222&logo=discord&logoColor=white" alt="Discord"></a>
</p>

<p align="center">
  Fork of <a href="https://github.com/badlogic/pi-mono">Pi</a> by <a href="https://github.com/mariozechner">@mariozechner</a>
</p>

目前能力最完整的 agent 界面。由真实使用持续打磨 —— 开箱即用，且从里到外开放。

**60+** 个 provider · **31** 个内置工具 · **14** 个 lsp 操作 · **28** 个 dap 操作 · 约 **80k** 行 Rust 核心。

> [!NOTE]
> Pull Request 目前**暂时对所有人开放**，作为一次试验。此前我们要求先获得
> 担保才接受 PR；该要求现已解除，以便评估开放贡献的效果。视结果而定，
> 担保制度可能恢复。



## 安装

安装本 fork 通过 [`jchanghong023/oh-my-pi` releases](https://github.com/jchanghong023/oh-my-pi/releases) 发布的最新二进制。以下命令直接使用 fork 的 GitHub release 资产，不会安装上游的 npm、Homebrew、Nix 或 `omp.sh` 构建。

**Linux glibc (x64 · arm64)**

```sh
curl -fsSL https://raw.githubusercontent.com/jchanghong023/oh-my-pi/main/scripts/install.sh | sh -s -- --binary
```

**Windows x64 (PowerShell)**

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/jchanghong023/oh-my-pi/main/scripts/install.ps1))) -Binary
```

安装脚本在运行时解析最新发布的 fork release。若要安装指定的 fork release，请在 Linux 上通过 `--ref` 传入其 tag，在 Windows 上通过 `-Ref` 传入。

fork 发布版二进制报告的版本号为 `omp/<upstream-version>+fork.<build-number>`。工作区包版本仍与上游兼容，因为本 fork 不向 npm 发布包。

Linux musl 二进制（x64 · arm64）由本 fork 发布。macOS 二进制目前不由本 fork 发布。



### Shell 补全

`omp` 依据实时的命令/flag 元数据，自行生成 **bash**、**zsh** 与 **fish** 的补全脚本，因此永远不会与真实 CLI 脱节。子命令、flag 与枚举值静态补全；模型名（`--model`、`--smol`、`--slow`、`--plan`）基于内置模型目录解析，`--resume` 则基于磁盘上的 session 解析。

```sh
# zsh — add to ~/.zshrc (or write the output into a file on your $fpath)
eval "$(omp completions zsh)"

# bash — add to ~/.bashrc
eval "$(omp completions bash)"

# fish
omp completions fish > ~/.config/fish/completions/omp.fish
```

## 每个工具，都_性能拉满_。

编辑一次到位。读取只给摘要，而不是倾倒整个文件内容。搜索瞬间返回。随便挑哪个模型 —— omp 都能做对。

| model            | metric       | what                                                                  |
| ---------------- | ------------ | --------------------------------------------------------------------- |
| Grok Code Fast 1 | 6.7% → 68.3% | 编辑格式一旦不再拖垮模型，提升立现十倍。 |
| Gemini 3 Flash   | +5 pp        | 相对 str_replace —— 比 Google 针对该格式的最佳尝试还强。 |
| Grok 4 Fast      | −61% tokens  | 一旦坏 diff 引发的重试循环消失，输出量随之骤降。 |
| MiniMax          | 2.1×         | 通过率翻了一倍多。同样的权重，同样的 prompt。 |

- `read`：摘要化片段 · 理想默认值 · 选择器命中率
- `grep`：西部最快
- `lsp`：你的 IDE 知道的一切，agent 都知道
- `prompts`：针对每个模型反复调校

[阅读完整博文 ↗](https://blog.can.ac/2026/02/12/the-harness-problem/)


## 你_喜爱_的 Pi，**开箱即用**。

omp 最初构建在 [Mario Zechner](https://github.com/mariozechner) 出色的 [Pi](https://github.com/badlogic/pi-mono) 之上，并补上了你所缺的一切。

### 01 · 带工具调用的代码执行

多数 harness 给 agent 一个 Python 沙箱就算完事。我们则同时运行持久化的 Python 和一个 Bun worker，两个内核都能通过 loopback 桥回调 agent 自己的工具——read、search、task。agent 在 Python 里用 tool.read 加载 CSV，再从 JavaScript 里画图，全程不必离开当前 cell。

![omp TUI 正在运行 Python 代码并绘制图表。](assets/python.webp)

### 02 · LSP 接入每一次写入

让它改名，得到的就是真正的改名。该调用走 workspace/willRenameFiles，因此 re-export、barrel 文件和别名导入都会在文件移动之前同步更新。你的 IDE 知道的一切，agent 都知道。

![omp TUI 中 TypeScript 与 Biome 语言服务器已激活。](assets/lspv.webp)

_[阅读 LSP 配置文档](docs/lsp-config.md)_

### 03 · 驱动真正的调试器

C 二进制段错误：agent 挂上 lldb，单步走到出错的指针，读取栈帧。Go 服务卡住：它挂上 dlv，遍历 goroutine。Python 进程僵死：debugpy，暂停、检查、求值。而多数 agent 还在到处撒 print。

![omp TUI：针对 /tmp/omp-native/demo 处原生二进制的实时 lldb-dap 会话。Adapter=lldb-dap，Status=stopped，Frame=xorshift32，指令指针 0x10000055C，位置 demo.c:6:10。Debug scopes 与 Debug variables 卡片显示局部变量（x = 57351），agent 核对了这段计算：x 从 7 → 57351（= 7 ^ (7<<13)）。](https://omp.sh/clips/dap-poster.webp)

_[观看录屏 ↗](https://omp.sh/clips/dap.mp4)_

### 04 · 会时间旅行的流式规则

你的规则一直休眠，直到模型开始跑偏。一次正则匹配就会在 token 中途中止流，把规则作为系统提醒注入，并从同一位置重试。你获得了纠偏能力，却不必每一轮都付上下文税。注入内容能挺过压缩，所以修正真正生效。

![omp TUI：agent 正在读取 src.rs 并准备写入 Box::leak，此时请求中止（红色 `Error: Request was aborted`），一张琥珀色的 `⚠ Injecting rule: box-leak` 卡片注入规则正文 `Don't reach for Box::leak in production code paths`，随后 agent 纠正方向，改提议 `Arc<str>` 并请用户确认。](https://omp.sh/clips/ttsr-poster.webp)

_[观看录屏 ↗](https://omp.sh/clips/ttsr.mp4)_

### 05 · 一等公民级的子 agent

把工作拆给多个 worker，拿回带类型的结果。task 会扇出到相互隔离的工作树，每个 worker 运行自己的工具集，最终 yield 出的是一个通过 schema 校验的对象，父 agent 可直接读取。无需解析散文，兄弟 agent 之间不会产生合并冲突，也不会留下孤儿改动。

![omp TUI 展示 `task` 派生两个子 agent `ComponentsExports` 与 `RoutesExports`，constraints 区块要求同级 agent 之间互发 IRC 私信，每个子 agent 的状态卡带有成本与耗时，最后的 Findings 章节列出两处导出，并附一条坦白的“IRC 协调说明”，指出握手是单向的。](https://omp.sh/clips/irc-poster.webp)

_[观看录屏 ↗](https://omp.sh/clips/irc.mp4)_

想边跑边看扇出过程：`Alt+A` 打开 [Agent Hub](docs/agent-hub.md)，其中的名册会显示每个子 agent 的当前活动与用量。点开一个就能读它的实时转录、输入一条引导消息、唤醒已挂起的 worker，或在不必中止父会话的情况下杀掉卡死的 worker。

### 06 · 第二个模型，盯住每一轮。

把一个 reviewer 模型配对到 'advisor' 角色，它会读主 agent 走的每一轮，并就地注入笔记——一句轻声提醒、一点担忧，或一个硬性阻断。它跑在自己的上下文和自己的模型上，因此能抓住干活者匆匆略过的东西。主 agent 看到笔记后会纠偏，或者告诉你它为何不纠。

![omp TUI：/advisor 状态显示 advisor 运行在 openai-codex/gpt-5.5 上；主 agent 把一处 catch 收窄为只处理 ENOENT（而不是吞掉所有错误）之后，一张琥珀色的 “Advisor 1 note (concern)” 卡片提醒该修复已不再匹配用户字面上的验收标准。](https://omp.sh/clips/advisor-poster.webp)

_[观看录屏 ↗](https://omp.sh/clips/advisor.mp4)_

### 07 · 把链接递出去，人就进来了。

/collab 把你的实时会话放到中继上，返回一个链接——外加一个二维码。队友用 omp join 从另一个终端加入，或者直接在浏览器里打开。以读写方式共享，就能和同一个人在同一个 agent 上结对；或者用 /collab view 生成只读链接，任何人都能看，但谁都改不了。帧在客户端加密，中继永远看不到你的密钥。

![omp TUI：/collab 视图打印 'Collab session started!'，并给出 omp join 命令、my.omp.sh 浏览器链接、'Anyone with this link can watch the session but cannot prompt the agent' 的说明，以及一个可扫描的大二维码。](https://omp.sh/clips/collab-poster.webp)

_[观看录屏 ↗](https://omp.sh/clips/collab.mp4)_

### 08 · 直接读 arxiv 上的 pdf，有何不可？

web_search 串联二十三个经过排序的 provider，把找到的 URL 直接交给 read。arxiv PDF、GitHub 页面、Stack Overflow 帖子都会以带完整锚点的结构化 markdown 返回——和你处理本地文件用的是同一套工具。可引用、可跟进、可摘录，永远不丢来路。

![omp TUI：web_search 针对 inference-time compute scaling 返回 10 条排好序的 Perplexity 来源，agent 选中一篇 arxiv 论文，调用 read https://arxiv.org/pdf/2604.10739v1，并用真实数字总结该论文的核心结果。](https://omp.sh/clips/web-poster.webp)

_[观看录屏 ↗](https://omp.sh/clips/web.mp4)_

### 09 · 不折不扣的原生，Windows 上也是。

别的 agent 靠 shell 调用 rg、grep、find 和 bash。在很多机器上这些二进制根本不存在；即便存在，每次调用也要付出一次 fork-exec 往返的代价。omp 把真正的实现链接进进程。ripgrep、glob、find：进程内。brush 就是那个 bash——它的会话能跨调用存活，另有 58 个命令行工具（ls、sed、sort、xargs，甚至 jq）被移植进 builtins crate 并在进程内运行，零 fork/exec。同一个 omp 二进制跑在 macOS、Linux 和 Windows 上——无需 WSL 桥。

### 10 · 带优先级和结论的代码审查

对这次改动能否发布给出明确结论，每个问题都按 P0 到 P3 分级并标注置信度。/review 会派出专门的 reviewer 子 agent，并行扫描分支、单个 commit 或未提交的改动。你先处理阻塞发布的问题；重要的事不会淹没在一整面散文中。

### 11 · Hashline：按内容哈希编辑

完美的编辑，更少的 token。模型只需指向锚点，而不用重新打出想改的那些行，于是空白字符之争和「找不到字符串」的死循环从此消失。编辑一个已过期的文件时锚点会对不上——我们会在补丁破坏任何东西之前拒绝它。同样的工作，Grok 4 Fast 的输出 token 少了 61%。

### 12 · GitHub 不过是另一个文件系统

别的 harness 外挂了 gh_issue_view、gh_pr_view、gh_search——每个都有自己的参数，agent 得学，你得出力调试。我们跳过了这一步。read 本来就处理路径；PR 也是路径。只需教模型一个接口，只需维护一个正确的面。

### 13 · 由 agent 亲自打理的记忆

agent 会跨会话记住你的代码库。它在运行中用 retain 写入事实，用 learn 记下可复用的经验，再用 recall 把它们取回来，并把每个会话压缩成一份心智模型，在下一个会话的第一轮加载。用 `memory.backend` 选择引擎——local、Hindsight 或 Mnemopi。默认按项目隔离，因此它学到的关于这个仓库的东西就留在这个仓库里。

### 14 · ACP：可由编辑器驱动的 agent

在 Zed 里运行 omp，你得到的是和终端里驱动的一模一样的 agent——它读你正看着的那个缓冲区，通过编辑器的保存路径写入，在编辑器的终端里启动 shell。破坏性工具会停下来弹出权限提示，你回答一次就可以忘了它。没有桥、没有插件，也没有需要保持同步的第二个大脑。

### 15 · 直接继承你其他工具已写下的东西

其他 agent 都附带一个导入器，指望你去做转换。omp 直接以原生形态读取磁盘上已有的八种格式——Cursor MDC、Cline .clinerules、Codex AGENTS.md、Copilot applyTo，以及其他。不需要迁移脚本，不需要 YAML 转 TOML，也没有 "受支持的子集" 这类脚注。你们团队上个季度写下的配置，今晚照样能用。

### 16 · omp commit：原子拆分，经过校验的提交信息

omp 通过 git_overview、git_file_diff 和 git_hunk 读取工作区，然后把互不相关的改动拆成按依赖关系排序的原子 commit。存在环的会被拒绝，任何东西都不会被写入。源文件的权重高于测试、文档和配置，因此头条 commit 就是真正重要的那个。锁文件完全排除在分析之外。

### 17 · 读 PR。_遍历 skills。_ 从子 agent 里取出 JSON。

十六种内部 scheme——`pr://`、`issue://`、`agent://`、`skill://`、`ssh://` 等等——会在 agent 已经调用的每个 FS 形态的工具中透明解析。`read pr://1428` 返回的形状与 `read src/foo.ts` 一致。`grep` 能像遍历目录一样遍历 diff。`agent://<id>/findings.0.path` 按路径从子 agent 的输出中取出某个字段。

### 18 · 冲突解决，从此简单。

每个合并冲突都变成一个 URL。agent 把 `@theirs`、`@ours` 或 `@base` 写入 `conflict://N`，文件就干净地解决了。批量形式：`conflict://*`。

![omp TUI：✓ Read src/session.ts（⚠ 1 处冲突），随后 ✓ Write conflict://1 · 1 line，内容为 @theirs，最后给出确认 'Resolved.'](https://omp.sh/clips/conflict-poster.webp)

_[观看录屏 ↗](https://omp.sh/clips/conflict.mp4)_

### 19 · 先预览，再接受。

`ast_edit` 会返回一张 _(proposed)_ 卡片，附上替换数量。改动处于暂存状态。agent 往 `xd://resolve` 写入一行理由；TUI 把它变成一张 **Accept** 卡片，随后磁盘操作才发生——原子、全有或全无。

![omp TUI：✓ AST Edit: console.log($X)（proposed）3 replacements · 1 file，随后 ✓ Accept: 3 replacements in 1 file (AST Edit)，最后显示 'Applied 3 replacements in src/auth.ts.'](https://omp.sh/clips/codemod-poster.webp)

_[观看录屏 ↗](https://omp.sh/clips/codemod.mp4)_

### 20 · 驱动_真正的浏览器_。_或者你的 Slack？_

Eval 的 `browser.open(...)` 返回一个 tab 句柄，带有直接的导航、检查、交互和元素操作辅助方法；`tab.run(...)` 负责自定义 JavaScript。它在一个隔离的 tab 运行时里驱动 Chromium 或 Electron。隐身模式默认开启，而浏览器 relay 可以接管你已经打开的 Chrome 标签页，且不抢走焦点。

### 21 · 亲手接管桌面本身

Eval 的 `computer` 辅助方法——`computer.window(...)`、`win.screenshot()`、`win.ax()`、`el.press()`，外加用于多步脚本的 `computer.run(fnOrCode, options)`——控制真实主机：枚举窗口与显示器、截取屏幕、发送原生输入、遍历操作系统无障碍树，并使用剪贴板。它不暴露任何浏览器 DOM。


## 无论任务需要什么，_它都已经内置_。

核心工具与 `read`、`bash` 处于同一命名空间。用 `--tools read,edit,bash,…` 固定启用的工具集；不常用的可发现工具留在 `xd://` 设备之后。`read xd://` 可列出它们，启用 `tools.xdev` 后可用 `write xd://<tool>` 运行其中一个。

**文件与搜索**

- `read` — 通过一个路径读取文件、目录、压缩包、SQLite、PDF、notebook、URL、远程 `ssh://` 路径以及内部 `://` 协议。
- `write` — 创建或覆盖文件、压缩包条目或 SQLite 行。
- `edit` — 带内容哈希锚点与陈旧锚点恢复的 hashline 补丁。
- `ast_edit` — 借助 ast-grep 做结构化重写，应用前先预览。
- `ast_grep` — 基于 50+ tree-sitter 语法的结构化代码查询。
- `grep` — 在文件、glob 与内部 URL 上做正则匹配。
- `glob` — 基于 glob 的路径查找；需要内容匹配时改用 `grep`。

**运行时**

- `bash` — 工作区 shell，内置 46 个进程内 coreutils，可选 PTY，支持后台任务派发。
- `eval` — 持久化的 Python 与 JavaScript 单元，共享 prelude 并支持工具重入。

**代码智能**

- `lsp` — 诊断、导航、符号、重命名、代码操作、原始请求。
- `debug` — 驱动 DAP 会话 —— 断点、单步、线程、栈、变量。
- `security_scan` — 规划并运行原生安全审查；驱动 Codex Security 云端扫描。

**协调**

- `task` — 并行展开子 agent，可选工作区隔离。
- `hub` — 给在线 agent 发消息，等待或取消后台任务，并监督长时间运行的进程。
- `todo` — 对会话 todo 列表做有序变更，并跟踪阶段。
- `ask` — 面向交互式运行的结构化追问。

**桌面与 Web**

- `browser` — 通过 Puppeteer 操作无头 Chromium 中的标签页、CDP 接入的应用，或经 relay 操作你自己的 Chrome。
- `computer` — 针对宿主桌面的持久化 JS：窗口、截图、原生输入、AX 树、剪贴板。
- `web_search` — 一次查询覆盖已配置的多个 provider，返回答案与引用。
- `github` — GitHub CLI 操作 —— 仓库、PR、issue、代码搜索、Actions 运行监视。
- `generate_image` — 通过 Gemini、GPT 或 xAI Grok 图像模型生成或编辑位图。
- `tts` — 通过 xAI Grok Voice 做语音合成 —— 五个内置音色，WAV 或 MP3。

**记忆与 skills**

- `checkpoint` — 标记对话状态，以便之后折叠并汇报。
- `rewind` — 裁剪探索性上下文，保留一份简明报告。
- `retain` — 把持久事实排入当前 memory bank。
- `recall` — 在 memory bank 中检索原始记忆。
- `reflect` — 基于 memory bank 综合作答。
- `memory_edit` — 按 id 更新、遗忘或作废已存储的记忆。
- `learn` — 记录可复用的经验；可选将其提升为受管理的 skill。
- `manage_skill` — 创建、更新或删除一个隔离的受管理 skill。

需要相应设置才启用，默认关闭：`github`、`security_scan`、`generate_image`、`tts`、`checkpoint`、`rewind`，以及各记忆工具（`retain`/`recall`/`reflect`/`memory_edit`，取决于 `memory.backend`）。

[完整参考 →](https://omp.sh/docs/tools)

### 提示词控制

四个独立的小写单词可让某一轮对话切换到专门的 agent 行为：

- `ultrathink` — 要求谨慎的多步推理，并使用所支持的最高自动思考强度。
- `orchestrate` — 通过并行子 agent 执行大量独立工作，并逐阶段验证。
- `workflowz` — 用当前 `task` 工具构建确定性的多子 agent 工作流。
- `fullsend` — 不以金钱或 token 为约束，在同等正确性、完整性与验证标准下选择预期完成时间最短的路径；委派仅在能带来实际速度或验证收益时使用。

它们只在正文中触发，出现在行内代码、围栏代码块、XML/HTML 区段、标识符或路径中都不会触发。精确的匹配规则与配置见 [魔法关键词](docs/magic-keywords.md)。

### 会话控制

斜杠命令会改变整个会话的运行方式：

- `/vibe` — 进入 [Vibe 模式](docs/vibe-mode.md)：充当导演，驱动持久化的 `fast`/`good` 工作会话，且只使用 `read` 工具集。
- `/fresh` — 重置 provider 流状态（过期的 prompt 缓存、卡住的流），但不改变本地对话记录。见[会话操作](docs/session-operations-export-share-fork-resume.md#fresh)。


## 六十多个 provider，上千个模型，_只差一个 /model_。

九个角色按意图路由工作。`default` 用于常规轮次。`smol` 用于廉价的子 agent 扇出。`slow` 用于深度推理。`plan` 用于计划模式。`commit` 用于变更日志。另有与名字对应的 `vision`、`task`、`advisor` 和 `tiny`。启动时可用 `--smol`、`--slow` 或 `--plan` 覆盖；用 `Ctrl+P` 在当前角色已配置的模型之间循环。会话中可用 `/model` 斜杠命令切换当前模型。

下文认证标签：`oauth` 用你的 provider 账号登录，`plan` 经由 coding plan 订阅路由，`local` 连接本地服务器运行、密钥可选。

### 前沿 API

直连 API 与网关。可按角色混用 provider。

Anthropic `oauth` · OpenAI · OpenAI Codex `oauth` · Google Gemini · Google Vertex · Google Antigravity `oauth` · xAI · SuperGrok `oauth` · DeepSeek · Mistral · Groq · Cerebras · Fireworks · Together · Baseten · DeepInfra · Hugging Face · NVIDIA · Meta · Amazon Bedrock · Azure OpenAI · SiliconFlow · GMI Cloud · CoreWeave · Sakana AI · Command Code · OpenRouter · Synthetic · Vercel AI Gateway · Cloudflare AI Gateway · Wafer Serverless

### 编码套餐

走订阅路由。`/login` 会把会话绑定到订阅。

Cursor `oauth` · GitHub Copilot `oauth` · GitLab Duo · Devin `oauth` · Kimi Code `plan` · Moonshot · MiniMax Coding Plan `plan` · MiniMax Coding Plan CN `plan` · Alibaba Coding Plan `plan` · Qwen Portal `oauth` · Z.AI / GLM Coding Plan `plan` · Zhipu Coding Plan `plan` · Xiaomi MiMo · Qianfan · Umans `plan` · NanoGPT · Novita · Venice · Kilo · ZenMux · OpenCode Go · OpenCode Zen

### 自行运行

兼容 OpenAI 的 `/v1/models`。本地实例无需密钥。

Ollama `local` · Ollama Cloud · LM Studio `local` · llama.cpp `local` · vLLM `local` · LiteLLM

### 自定义 OpenAI 兼容 provider

在 `~/.omp/agent/models.yml` 中定义自定义 provider：

```yaml
providers:
  spark:
    baseUrl: http://192.168.10.223:8000/v1
    api: openai-completions
    apiKey: dummy
    models:
      - id: minimax-m3
        name: MiniMax M3
        contextWindow: 100000
        maxTokens: 32000
```

运行 `omp models spark` 验证能否发现模型。然后运行 `omp setup`，在默认模型步骤里选中它；也可以在会话中打开 `/model`，把它指派给 `default` 角色。

若想跳过选择器直接预设默认模型，把选择器写入 `~/.omp/agent/config.yml`：

```yaml
modelRoles:
  default: spark/minimax-m3
```

### 让路由好用的四个开关

- **自定义 provider** — 任何使用 `openai-completions`、`openai-responses`、`openai-codex-responses`、`azure-openai-responses`、`anthropic-messages`、`bedrock-converse-stream`、`google-generative-ai`、`google-gemini-cli` 或 `google-vertex` 协议的端点，都能在 `~/.omp/agent/models.yml` 中声明。
- **回退链** — 在 `retry.fallbackChains` 下按角色或按模型配置链。主 provider 抛出 429 或撞上配额墙时，链中下一项接管本轮剩余部分——冷却结束后恢复。
- **按路径限定模型** — 给 `enabledModels` 和 `disabledProviders` 的条目加上 `path:` 前缀，就能只对某个仓库固定另一套模型，而不必改动全局配置。限定条目覆盖该路径及其下所有内容。
- **轮换凭据** — 为同一个 provider 堆叠多个 API key，运行时按会话亲和性轮换，并对单个凭据退避。当一个 key 撑不到中午就会烧光配额时尤其有用。

完整的 provider 与路由参考见 [omp.sh/docs/providers](https://omp.sh/docs/providers)。

## 二十三个后端。_一个 agent 早就会用的工具_。

`web_search` 是内置的，不是外挂上去的。`auto` 会依次走过一个二十三个 provider 组成的链路；如果你已经在为某家付费，可以按名字固定它。每一次命中背后，站点感知的抽取都会把 GitHub、各类 registry、arXiv、Stack Overflow 和文档转成结构化 markdown——锚点与链接目标都得以保留。

### 搜索 provider

二十三个后端。固定其中一个，或让 `auto` 按顺序走完整条链路。

| provider     | 认证                                      |
| ------------ | ----------------------------------------- |
| `auto`       | 链路                                      |
| `perplexity` | `PERPLEXITY_API_KEY`（匿名回退）          |
| `gemini`     | oauth                                     |
| `anthropic`  | oauth                                     |
| `codex`      | oauth                                     |
| `xai`        | oauth 或 `XAI_API_KEY`                    |
| `zai`        | `ZAI_API_KEY`                             |
| `exa`        | `EXA_API_KEY`（或 mcp）                   |
| `tinyfish`   | `TINYFISH_API_KEY`                        |
| `jina`       | `JINA_API_KEY`                            |
| `kagi`       | `KAGI_API_KEY`                            |
| `tavily`     | `TAVILY_API_KEY`                          |
| `firecrawl`  | `FIRECRAWL_API_KEY`（无密钥回退）         |
| `brave`      | `BRAVE_API_KEY`                           |
| `kimi`       | `/login kimi-code` 或搜索密钥             |
| `parallel`   | `PARALLEL_API_KEY`                        |
| `synthetic`  | `SYNTHETIC_API_KEY`                       |
| `searxng`    | 自托管                                    |
| `duckduckgo` | 无密钥                                    |
| `startpage`  | 无密钥                                    |
| `google`     | 无密钥（浏览器）                          |
| `ecosia`     | 无密钥（浏览器）                          |
| `mojeek`     | 无密钥（浏览器）                          |
| `public`     | 无密钥（聚合以上全部）                    |

Exa 也支持通过 `/login exa` 保存 API key；显式选择无密钥时会走 public MCP 回退。

### 专用处理器

agent 拿到的是结构化内容，而不是被剥光的 HTML。

- **代码托管** — github, gitlab
- **包仓库** — npm, PyPI, crates.io, Hex, Hackage, NuGet, Maven, RubyGems, Packagist, pub.dev, Go packages
- **研究来源** — arxiv, semantic scholar
- **论坛** — stack overflow, reddit, hn
- **文档** — mdn, readthedocs, docs.rs

页面会转成 markdown，链接结构保持完整。agent 可以引用、跟进和摘录，而不会丢失锚点。

### 安全数据库

漏洞查询返回的是厂商数据，而不是博客摘要。

- **NVD** — 美国国家漏洞数据库
- **OSV** — 开源漏洞源
- **CISA KEV** — 已知被利用漏洞

[`web_search` 参考 ↗](https://omp.sh/docs/tools#web_search)


## 约 **~80,000** 行 Rust 代码，包办了其他 harness 靠 shell 出去完成的工作。

六个 crate，一个带平台标签的 N-API addon。搜索、shell、AST、高亮、PTY、桌面控制、图片解码、BPE 计数 —— 全部在进程内、跑在 libuv 线程池上。热路径上没有 fork/exec。另有约 80k 行以 vendor 形式随行：brush bash fork，加上 58 个命令行工具 —— coreutils、findutils、sed、jq、ripgrep 驱动的 grep、fd、diff、moreutils —— 全部移植进 builtins crate，直接编译进 shell。

- Crates：`pi-natives`、`pi-shell`、`pi-ast`、`pi-iso`、`pi-voice`、`pi-walker`
- Platforms：`linux-x64`、`linux-arm64`、`darwin-x64`、`darwin-arm64`、`win32-x64`、`win32-arm64` —— x64 同时提供 AVX2 与 baseline 两种二进制

按 crate 统计，只算代码行：

| Crate         | 作用                                                                                   |   ~LoC |
| ------------- | -------------------------------------------------------------------------------------- | -----: |
| pi-shell      | 内嵌 bash 引擎 · 持久会话 · 进程内 coreutils 调度 · 输出 minimizer | 38,000 |
| pi-natives    | N-API 接口层 —— 即下表所有模块                                    | 25,000 |
| pi-walker     | 并行、识别 ignore 的遍历器 + 供 grep · glob · workspace · shell 共用的扫描缓存    |  5,200 |
| pi-iso        | 工作区隔离 · apfs · btrfs · zfs · reflink · overlayfs · projfs · rcopy        |  3,300 |
| pi-ast        | tree-sitter + ast-grep 匹配、代码块定位、结构化摘要                |  2,900 |
| pi-voice      | 音频采集/播放 · Opus · 实时 WebRTC                                            |  1,000 |

`pi-natives` 内部的逐模块拆分（省略胶水代码与测试）：

| Module        | 作用                                                                              | 依赖                                |   ~LoC |
| ------------- | --------------------------------------------------------------------------------- | ----------------------------------------- | -----: |
| desktop       | 窗口/显示器枚举 · 截图 · 原生输入 · 供 `computer` 使用的 AX 树                   | xcap · enigo · OS AX FFI                  | 10,600 |
| grep          | 正则搜索 · 并行/串行 · glob 与类型过滤 · 模糊查找             | grep-regex · grep-searcher                |  3,280 |
| text          | 感知 ANSI 的宽度计算 · 截断 · 按列切分 · 保留 SGR 的换行                  | unicode-width · segmentation              |  2,070 |
| snapcompact   | 为上下文压缩做位图帧栅格化 + PNG 编码                   | image · png                               |  1,760 |
| keys          | Kitty 键盘协议，回退到 xterm · PHF 完美哈希查找             | phf                                       |  1,740 |
| ast           | ast-grep 模式匹配与结构化重写                                 | ast-grep-core                             |  1,510 |
| diff          | 供工具与预览使用的结构化文件 diff                                    | in-tree                                   |  1,030 |
| pty           | 为 sudo · ssh 交互式提示分配原生 PTY                          | portable-pty                              |    630 |
| crash_handler | 原生崩溃捕获与上报                                                | in-tree                                   |    610 |
| highlight     | 语法高亮 · 11 个语义类别 · 30+ 个别名                        | syntect                                   |    550 |
| appearance    | Mode 2031 + 通过 CoreFoundation FFI 获取 macOS 原生深色/浅色                        | core-foundation                           |    450 |
| task          | 在 libuv 线程池上跑阻塞工作 · 取消 · 超时 · 性能剖析           | tokio · napi                              |    440 |
| glob          | 用 glob 做发现 · 类型过滤 · 按 mtime 排序 · 遵循 gitignore               | ignore · globset                          |    430 |
| fd            | 用于替代 find 工具的文件系统遍历器                                       | ignore                                    |    385 |
| clipboard     | 系统剪贴板文本复制与图片读取 · 无需 xclip/pbcopy                  | arboard                                   |    370 |
| workspace     | 一次遍历完成工作区遍历、gitignore 与 AGENTS.md 发现                 | ignore                                    |    275 |
| power         | macOS 电源断言 API，阻止空闲/系统/显示器休眠                | IOKit FFI                                 |    270 |
| prof          | 环形缓冲性能剖析器，输出 folded-stack 与 SVG 火焰图              | inferno                                   |    240 |
| file_lock     | 跨进程建议性文件锁                                               | in-tree                                   |    210 |
| ps            | 跨平台进程树终止与后代列举                           | libc · libproc · CreateToolhelp32Snapshot |    195 |
| tokens        | O200k / Cl100k BPE token 计数 · 两张表均内嵌                          | tiktoken-rs                               |     70 |
| html          | HTML 转 Markdown，可选内容清理                                   | html-to-markdown-rs                       |     60 |
| sixel         | 终端图片渲染 · 解码 PNG · JPEG · WebP · GIF · 缩放 · SIXEL 编码 | icy_sixel · image                         |     55 |


## 四个入口：_交互式_、_一次性_、RPC 与 ACP。

同一个引擎，四层外壳。`omp` 运行 TUI。`omp -p` 回答单条 prompt 后退出。Node SDK 把 session 嵌进你的进程。`omp --mode rpc` 与 `omp acp` 通过 stdio 把控制权交给另一个程序。

### Interactive — 拿不准时，agent 会问你

TUI 是默认界面。工具调用以卡片形式渲染，编辑在落地前先预览，语义不明时经由 `ask` 工具处理——那是 agent 可以在回合中途调用的结构化选项选择器。其余交给键盘。

同一套 prompt 卡片也会出现在 ACP 上，因此编辑器无需自己实现就能拿到选择器。

![omp TUI 展示来自 ask 工具的多选问题。](assets/ask.webp)

### SDK — 嵌入 Node

`@oh-my-pi/pi-coding-agent`

Node 与 TypeScript 宿主可直接把引擎接入自己的进程。该包导出 `ModelRegistry`、`SessionManager`、`createAgentSession` 与 `discoverAuthStorage`；session 会发出类型化事件，供你订阅。

```ts
import {
  ModelRegistry,
  SessionManager,
  createAgentSession,
  discoverAuthStorage,
} from "@oh-my-pi/pi-coding-agent";

const auth = await discoverAuthStorage();
const models = new ModelRegistry(auth);
await models.refresh();

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  authStorage: auth,
  modelRegistry: models,
});
await session.prompt("list .ts files");
```

### RPC — 通过 stdio 驱动

`omp --mode rpc`

适合非 Node 的嵌入方，或当你需要进程隔离时使用。输入 NDJSON 命令，输出响应帧与事件帧。`--mode rpc-ui` 会把工具卡片、选择器与对话框作为 `extension_ui_request` 帧下发，宿主必须作答。

```
$ omp --mode rpc --no-session
> {"id":"r1","type":"prompt","message":"list .ts files"}
< {"id":"r1","type":"response", ...}
> {"id":"r2","type":"set_model","provider":"anthropic","modelId":"sonnet-4.5"}
> {"id":"r3","type":"abort"}
```

### ACP — 与编辑器对话

`omp acp`

基于 JSON-RPC 的 [Agent Client Protocol](https://github.com/zed-industries/agent-client-protocol)。当编辑器声明能力后，工具 I/O 会经由它路由，写入则由 `session/request_permission` 把关。

| omp 工具     | ACP 路由                           |
| ------------ | ----------------------------------- |
| `bash`       | `terminal/create + terminal/output` |
| `read`       | `fs/read_text_file`                 |
| `write`      | `fs/write_text_file`                |
| `edit, bash` | `session/request_permission`        |

完整参考：[omp.sh/docs/sdk](https://omp.sh/docs/sdk)。


## 值得留下的 harness，是你 _不会用尽_ 的那个。

上手入口：**[omp.sh](https://omp.sh)**。

omp 是 [Mario Zechner](https://github.com/mariozechner) 的 [Pi](https://github.com/badlogic/pi-mono) 的 fork，被重写为一个以编码为先的界面：sessions、subagents、slash commands、extensions —— 全部 TypeScript，全部 MIT，全部在 [GitHub](https://github.com/can1357/oh-my-pi) 上。你可以用配置塑造它，从外部 hook 它，或者在需要时直接读源码。

### 原语

extension 就是一个 TypeScript 模块。与内置功能相同的 tool API、相同的 slash-command 注册表、相同的快捷键表、相同的 TUI 原语。没有任何东西是保留的。

### 发现

首次运行时，omp 会继承磁盘上已有的东西：来自 `.claude`、`.cursor`、`.windsurf`、`.gemini`、`.codex`、`.cline`、`.github/copilot` 和 `.vscode` 的 rules、skills 与 MCP servers。不需要迁移脚本。

### 可扩展性

让你缺的那块直接由 omp 写出来，然后 `/reload-plugins`。可以留在本地，放进 `marketplace` 分发，或者发布到 npm。

## 设计哲学

omp 是 [Mario Zechner](https://github.com/mariozechner) 的 [pi-mono](https://github.com/badlogic/pi-mono) 的 fork，并扩展出一套开箱即用的编码工作流。

核心理念：

- 为真实的编码工作保留交互式、终端优先的 UX
- 内置实用能力（tools、sessions、branching、subagents、extensibility）
- 让高级行为可配置，而不是隐藏起来

---

## 开发

### 从源码开始

全新克隆的仓库需要先装好 workspace 依赖并构建本地 Rust/N-API addon，源码 CLI 才能启动。

```sh
bun setup
bun dev
```

`bun setup` 会安装 Bun workspaces 并构建 `@oh-my-pi/pi-natives`。改动 Rust crates 或 `packages/natives` 后，重新运行 `bun run build:native`。

Nix 用户可以直接获得锁定版本的 Bun 与 Rust 工具链，以及所有原生构建依赖：

```sh
nix develop
bun setup
bun dev
```

用 `nix build .#omp` 构建可分发的 Nix 包并做冒烟测试。Wayland screencast 支持默认关闭（链接 libpipewire 会让运行时闭包增加约 750 MB）；可用 `omp.override { withWaylandScreencast = true; }` 启用。`nix/bun.nix` 只在 `bun.lock` 变化时生成；发版时会自动重新生成。若改动了依赖，请运行：

```sh
bun run gen:nix
```

该命令在可用时使用 `nix develop` 中的 `bun2nix`，否则通过 Nix 进入开发 shell，最后回退到锁定版本的 `bunx bun2nix@2.1.2`。不要手动编辑 `nix/bun.nix`。

非交互式冒烟检查：

```sh
bun dev -- --version
```

### Debug 命令

`/debug` 会打开用于调试、问题上报与性能剖析的工具。

架构说明与贡献指南见 [packages/coding-agent/DEVELOPMENT.md](packages/coding-agent/DEVELOPMENT.md)。

---

## Monorepo 包

| 包 | 说明 |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **[@oh-my-pi/collab-web](packages/collab-web)**                               | 协作实时会话的浏览器访客客户端、mock host 与本地中继 |
| **[@oh-my-pi/pi-ai](packages/ai)**                                            | 支持流式输出与模型/provider 集成的多 provider LLM 客户端 |
| **[@oh-my-pi/pi-catalog](packages/catalog)**                                  | 模型目录：内置模型数据库、provider 描述符与身份信息 |
| **[@oh-my-pi/pi-agent-core](packages/agent)**                                 | 带工具调用与状态管理的 agent 运行时 |
| **[@oh-my-pi/pi-coding-agent](packages/coding-agent)**                        | 交互式编码 agent 的 CLI 与 SDK |
| **[@oh-my-pi/pi-tui](packages/tui)**                                          | 支持差分渲染的终端 UI 库 |
| **[@oh-my-pi/pi-natives](packages/natives)**                                  | grep、shell、image、text、语法高亮等能力的 N-API 绑定 |
| **[@oh-my-pi/omp-stats](packages/stats)**                                     | 面向 AI 使用统计的本地可观测性面板 |
| **[@oh-my-pi/omptype](packages/omptype)**                                     | 兼容 ArkType 的 schema 校验，带惰性 JIT 编译 |
| **[@oh-my-pi/pi-utils](packages/utils)**                                      | 共享工具（日志、流、目录/环境变量/进程辅助） |
| **[@oh-my-pi/pi-wire](packages/wire)**                                        | 协作实时会话的共享协议类型与中继常量 |
| **[@oh-my-pi/pi-mnemopi](packages/mnemopi)**                                  | 面向 Oh My Pi agents 的本地 SQLite 记忆引擎 |
| **[@oh-my-pi/snapcompact](packages/snapcompact)**                             | 位图帧上下文压缩包与 SQuAD 评测套件 |
| **[@oh-my-pi/browser-relay](packages/browser-relay)**                         | 让 Eval browser API 驱动你现有标签页的 Chrome 扩展 |
| **[@oh-my-pi/pi-metaharness](packages/metaharness)**                          | 统一的 benchmark 运行器、Harbor 运行记录存储、REST/SSE API 与实时面板 |
| **[@oh-my-pi/typescript-edit-benchmark](packages/typescript-edit-benchmark)** | 基于 TypeScript 源码变异的编辑 benchmark 套件 |

### Rust Crates

| Crate | 说明 |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **[pi-natives](crates/pi-natives)**                | `@oh-my-pi/pi-natives` 使用的核心 Rust 原生 addon（N-API `cdylib`）；聚合下列 crates |
| **[pi-shell](crates/pi-shell)**                    | 从 `pi-natives` 拆出的内嵌 shell / PTY / 进程管理（封装 `brush-*`） |
| **[pi-ast](crates/pi-ast)**                        | 基于 tree-sitter 的代码摘要器与 AST 工具（50+ 语言语法） |
| **[pi-iso](crates/pi-iso)**                        | 任务隔离后端解析器：APFS clones、btrfs/zfs reflinks、overlayfs、projfs、rcopy |
| **[pi-voice](crates/pi-voice)**                    | 音频采集/播放、Opus 编解码与实时 WebRTC 流式原语 |
| **[pi-walker](crates/pi-walker)**                  | 并行的忽略规则感知文件系统遍历器，其扫描缓存由 grep、glob 与 workspace 共享 |
| **[pi-edit](crates/pi-edit)**                      | `edit` 工具背后的编辑引擎：基于行的 patch/hashline 模式、流式预览、原子应用 |
| **[brush-core](crates/vendor/brush-core)**         | 为内嵌 bash 执行而 vendor 的 [brush-shell](https://github.com/reubeno/brush) fork |
| **[pi-builtins](crates/pi-builtins)**              | Bash builtins（cd、echo、test、printf、read、export、…）外加 67 个进程内命令行工具 |

## 贡献

Issues 与 pull requests 对所有人开放。目前的开放 PR 仍属**试行**——我们先前的 vouch 要求已暂时取消，以便观察效果，之后可能恢复。贡献指南见 **[CONTRIBUTING.md](CONTRIBUTING.md)**。

---

## 许可证

OMP 基于 [MIT License](LICENSE) 授权。

第三方与 vendor 代码（包括 `crates/vendor/brush-core` 以及 `crates/pi-builtins/LICENSE` 中标明的第三方部分）仍遵循各自的上游许可证。署名与附加条款见 `THIRD-PARTY-NOTICES.txt` 及各组件内的声明。

© 2025 Mario Zechner
© 2025-2026 Can Bölük
© 2026 Stencil Labs, Inc.

_为常开的终端而生_

- [omp.sh](https://omp.sh)
- [GitHub](https://github.com/can1357/oh-my-pi)
- [Changelog](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/CHANGELOG.md)
- [npm](https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent)
- [Discord](https://discord.gg/4NMW9cdXZa)
- [MIT](https://github.com/can1357/oh-my-pi/blob/main/LICENSE)
