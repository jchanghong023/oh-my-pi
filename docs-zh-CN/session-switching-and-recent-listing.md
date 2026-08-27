# Session switching and recent session listing

本文档介绍 coding-agent 如何发现最近的会话、解析 `--resume` 目标、展示会话选择器,以及如何切换当前运行时会话。

文档聚焦于当前实现行为,包括回退路径与注意事项。

## Implementation files

- [`../src/session/session-manager.ts`](../packages/coding-agent/src/session/session-manager.ts)
- [`../src/session/session-listing.ts`](../packages/coding-agent/src/session/session-listing.ts)
- [`../src/session/session-paths.ts`](../packages/coding-agent/src/session/session-paths.ts)
- [`../src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts)
- [`../src/cli/session-picker.ts`](../packages/coding-agent/src/cli/session-picker.ts)
- [`../src/modes/components/session-selector.ts`](../packages/coding-agent/src/modes/components/session-selector.ts)
- [`../src/modes/controllers/selector-controller.ts`](../packages/coding-agent/src/modes/controllers/selector-controller.ts)
- [`../src/main.ts`](../packages/coding-agent/src/main.ts)
- [`../src/sdk.ts`](../packages/coding-agent/src/sdk.ts)
- [`../src/modes/interactive-mode.ts`](../packages/coding-agent/src/modes/interactive-mode.ts)
- [`../src/modes/utils/ui-helpers.ts`](../packages/coding-agent/src/modes/utils/ui-helpers.ts)

## Recent-session discovery

### Directory scope

`SessionManager` 默认在按 canonical-cwd 分桶的目录下保存文件会话:

- `~/.omp/agent/sessions/<encoded-cwd>/*.jsonl`

`<encoded-cwd>` 是对路径编码后的 canonical cwd(在 home 下为 `-<relative>`,在 temp 根目录下为 `-tmp-<relative>`,其他情况下为 `--<encoded-absolute>--`;参见 [session.md](session.md#on-disk-layout))。已回滚的 17.2.5-17.2.8 哈希分桶方案会尽力迁移。`SessionManager.list(cwd, sessionDir?)` 仅读取已解析分桶,除非显式提供 `sessionDir`。

### Two listing paths with different payloads

存在两条不同的列表流水线:

1. `getRecentSessions(sessionDir, limit)`(欢迎/摘要视图)
   - 仅从每个文件读取 4 KiB 前缀。
   - 同时理解当前定宽 title-slot 文件和旧式 header-first 文件。
   - 解析 header + 最早的用户文本预览。
   - 返回轻量的 `RecentSessionInfo`(`path`、`name`、`timeAgo`)。
   - 按文件 `mtime` 降序排序。

2. `SessionManager.list(...)` / `SessionManager.listAll()`(resume 选择器与 ID 匹配)
   - 每个文件读取 4 KiB 前缀加上有界 32 KiB 尾部,而不是完整 JSONL 内容。
   - 构建 `SessionInfo`(`path`、`id`、`cwd`、title/parent 元数据、日期、大小、消息预览/计数,以及生命周期状态)。
   - 使用前缀解析加 marker 计数处理列表文本,使用尾部解析处理 final-message 生命周期状态;超出前缀的较晚消息可能不会出现在 `allMessagesText` 中。
   - 状态为 `complete`、`interrupted`、`aborted`、`error`、`pending` 或 `unknown`。
   - 按 `modified` 降序排序。基于 stat 的扫描结果会被缓存;较大的列表使用有界的并行 worker。

正常的按目录扫描会在 EPERM 原子回写回退产生的最新孤立 `.bak` 的主 JSONL 缺失时对其进行修复。`listSessionsReadOnly` 是非变更的变体。

### Metadata fallback behavior

对于 recent summary(`RecentSessionInfo`):

- 显示名称优先级(`sessionDisplayName`):`title` -> 第一条用户消息 -> `Untitled · <time>` 标签(刻意不使用原始 `id`)
- 欢迎界面会将渲染的名称截断到可用列宽(没有固定长度)
- 仅保留第一行,并从 title/消息派生的名称中去除控制字符(`sanitizeSessionName`)

对于 `SessionInfo` 列表条目:

- `title` 在存在时为定宽 title-slot 值,否则为 `header.title`,再否则为前缀中可见的最后一次 compaction `shortSummary`
- `firstMessage` 是从前缀中可发现的第一条用户消息文本,否则为 `"(no messages)"`
- 选择器还会在 all-projects 范围内显示修改时间、文件大小、生命周期状态(除 `unknown` 外)、fork 标记以及 cwd

## `--continue` resolution and terminal breadcrumb preference

`SessionManager.continueRecent(cwd, sessionDir?)` 按以下顺序解析目标:

1. 读取 terminal-scoped breadcrumb(`~/.omp/agent/terminal-sessions/<terminal-id>`)
2. 校验 breadcrumb。已具体化的目标可用;缺失的目标仅在其可选第三行为 `fresh`(表示一个懒加载未具体化的 `/new` 边界)时可用。
3. 缺失的 fresh 目标会启动新会话,而不是回退并恢复之前的 transcript。
4. 将过时的、修复前产生的子代理 breadcrumb 解析到其交互式父会话。
5. 如果 breadcrumb 的 cwd 与当前 cwd 不同、不再存在,且当前位置没有自己的会话,则将 breadcrumb 会话重新根植到当前 cwd(`open` + `moveTo`)。
6. 否则使用 cwd 匹配当前 cwd 的 breadcrumb;若 cwd 不匹配,则使用当前分桶中最新的一次会话。
7. 若没有可用的 breadcrumb,则按 mtime 选择最新文件;若仍不存在,则创建新会话。

终端 ID 派生优先使用 TTY 路径,回退到基于环境变量的标识符(`ZELLIJ_PANE_ID`、`TMUX_PANE`、`CMUX_SURFACE_ID`、`KITTY_WINDOW_ID`、`WEZTERM_PANE`、`TERM_SESSION_ID`、`WT_SESSION`)。

Breadcrumb 写入是尽力而为且非致命的。

`-c <value>` 在唯一的 positional 值匹配 session-id 形式时,会被规范化为显式 resume 目标;其他位置文本仍然是 `--continue` 的初始 prompt。

## Startup-time resume target resolution (`main.ts`)

### `--resume <value>`

`createSessionManager(...)` 以两种模式处理字符串值的 `--resume`:

1. 类路径值(包含 `/`、`\\`,或以 `.jsonl` 结尾)
   - 直接 `SessionManager.open(sessionArg, parsed.sessionDir)`

2. resume 键值
   - `resolveResumableSession(...)` 先搜索本地会话,除非自定义 `sessionDir` 禁用了全局回退,否则再搜索所有会话
   - 匹配不区分大小写,接受 `id` 前缀、完整 JSONL 文件名前缀,或时间戳之后的 session-id 后缀
   - 使用 modified 降序的首个匹配(没有歧义提示)

如果匹配到的会话所记录的 cwd 不再存在,CLI 会提示 `Move (re-root) it into the current directory? [Y/n]`。确认后会打开它,并通过 `moveTo(cwd)` 重新定位;拒绝则干净退出。非 TTY 无法回答时会抛出 `SessionResolutionError`。

否则,会话将在其记录的项目中打开,包括全局匹配;启动时切换进程 cwd,重新加载项目作用域的 settings/plugins,并在构造 agent 之前重新解析已启用的模型。它**不会**仅仅因为跨项目匹配就 fork。

无匹配时抛出 `Session "..." not found.`。

### `--resume` (no value)

在初始 session-manager 构造之后处理:

1. 使用 `SessionManager.list(cwd, parsed.sessionDir)` 列出当前文件夹的会话
2. 若为空,仅探测 `SessionManager.listAll()` 以区分全局空状态并预加载 Tab 作用域;选择器仍会在当前文件夹作用域内打开
3. 若两个列表都为空,打印 `No sessions found` 并退出
4. 打开全屏 TUI 选择器(`selectSession`)
5. 若取消,打印 `No session selected` 并退出
6. 选中后,将进程/项目作用域状态切换到该会话的 cwd,然后 `SessionManager.open(selected.path)`

### `--continue`

直接使用 `SessionManager.continueRecent(...)`(上述 breadcrumb 优先行为)。

## Picker-based selection internals

## CLI picker (`src/cli/session-picker.ts`)

`selectSession(sessions, options)` 使用 `SessionSelectorComponent` 创建全屏 alternate-screen TUI,并仅 resolve 一次:

- selection -> resolve 选中的 `SessionInfo`
- cancel (Esc) -> resolve 为 `null`
- hard exit (Ctrl+C path) -> 停止 TUI 并退出
- Tab 切换 current-folder / all-projects 作用域;all-projects 列表是懒加载的,或被预加载提供
- search 将会话元数据/前缀文本与 `history.db` 中的 prompt-history 匹配合并,经过短 debounce
- mouse wheel 在 fullscreen 选择器中改变选择,左键点击选中
- Delete,或在搜索为空时的 Backspace,会打开确认并删除 JSONL 以及会话工件

## Interactive in-session picker (`SelectorController.showSessionSelector`)

流程:

1. 通过 `SessionManager.list(currentCwd, currentSessionDir)` 拉取当前文件夹的会话;即使文件夹作用域为空,all-projects 列表仍保持懒加载
2. 在编辑器区域挂载 `SessionSelectorComponent`,具有懒加载 all-project 加载以及 `history.db` prompt 匹配器
3. 回调:
   - select -> 锁定选择器输入并调用 `handleResumeSession(sessionPath)`;可恢复的切换前失败会解锁选择器
   - cancel -> 恢复编辑器并重渲染
   - exit -> `ctx.shutdown()`

`/resume <id-prefix>` 解析本地再解析全局匹配并直接切换。`/resume @claude` 和 `/resume @codex` 改为打开只读源导入选择器:选中的外部 transcript 会被持久化为 OMP 会话,然后切换过去;在这些选择器中不提供删除、历史扩充以及 all-project 作用域。

## Session selector component behavior

`SessionList` 支持:

- Up/Down 与 Page Up/Page Down 导航(夹紧,不环绕)
- Enter 选中
- Delete,或在搜索为空时的 Backspace,在确认后删除
- Esc 取消;Ctrl+C 退出
- Tab 切换 current-folder / all-projects 作用域
- mouse wheel/click 在 fullscreen 选择器中
- 多 token 搜索,跨 id/title/cwd/first message/prefix message text/path:字面匹配按 recency 优先,然后是足够强的 fuzzy 匹配;`history.db` 中的 prompt-history 匹配在输入暂停后可能被提升

空列表渲染行为:

- current-folder 作用域渲染 `No sessions in current folder. Press Tab to view all.`;all-projects 作用域渲染 `No sessions found`
- 在空列表上 Enter/Delete/Backspace 不做任何事
- Esc/Ctrl+C 仍然有效

## Runtime switch execution (`AgentSession.switchSession`)

`switchSession(sessionPath)` 是核心的进程内切换路径。

生命周期/状态转换:

1. 捕获前一个文件并发出可取消的 `session_before_switch`(`reason: "resume"`,目标文件)
2. 断开 agent listeners,中止活动工作,运行切换前 reconciler,并 flush 待处理的 bash/session 写入
3. 快照回滚状态(manager、queues、messages、model/thinking/tier、tools/prompts、provider-cache identity,以及 checkpoint/rewind state),然后清空消息队列
4. 对于不同的会话,排出/分离 advisor recorders
5. `sessionManager.setSessionFile(sessionPath)`:更新 breadcrumb,加载/迁移/blob-resolve/index 条目,并采用已存在的 recorded cwd
6. 同步 session id、memory key、继承的 provider-cache key、display context,以及 checkpoint/rewind state
7. 发出 `session_switch`,替换消息,重置 advisor session state,并同步 todos
8. 对不同会话,或对 replay 发生变化的重载同一会话,关闭 provider sessions
9. 按 role/default 回退顺序恢复第一个可用的 recorded model
10. 如果加载的分支以一个中断的工具流结束,则追加合成的 abort 消息并重建 display context
11. 恢复已配置的 thinking(`auto` 保持 auto)以及 per-family service tiers,当不存在对应条目时回退到当前 settings
12. 按需重置 memory/tool session state,重新连接 listeners,运行 mode reconciliation,并刷新 workspace-aware 基础系统 prompt
13. 对不同会话恢复 advisor cost,完成 bash 转换,通知 session-change 回调,并返回 `true`

快照之后的任何失败都会恢复之前的 manager 和 runtime state,重新连接/reconcile 它,将 bash 转换标记为失败,然后重新抛出。

## UI state rebuild after interactive switch

`SelectorController.handleResumeSession` 在 `switchSession` 周围执行 UI 重置:

- 停止 loading 动画
- 清空 status 容器
- 清空 pending-message UI 和 pending tool map
- 重置 streaming component/message 引用
- 调用 `session.switchSession(...)`
- 如果恢复会话的 cwd 与之前不同,则将进程和由 cwd 派生的缓存重新指向它(`applyCwdChange`)
- 清空 chat 容器并从会话上下文重新渲染(`renderInitialMessages`)
- 从新的会话工件重新加载 todos
- 显示 `Resumed session`(跨项目恢复时显示 `Resumed session in <dir>`)

因此,可见的对话/todo 状态会从新的会话文件重新构建。

## Startup resume vs in-session switch

### Startup resume (`--continue`, `--resume`, direct open)

- 会话文件在 `createAgentSession(...)` 之前选择。
- `sdk.ts` 在创建过程中构建现有会话上下文。
- 代理消息和 replay 状态在构造期间恢复一次。
- Model/thinking/service tier 使用持久化状态,带当前配置回退。
- 然后 interactive mode 协调持久化的 mode state。

### In-session switch (`/resume`-style selector path)

- 在已运行的会话上使用 `AgentSession.switchSession(...)`。
- 原地重建 messages/model/thinking/tier 以及 session-scoped runtime state。
- 发出 `session_before_switch`/`session_switch` 钩子。
- 刷新 UI chat/todos。
- Interactive mode reconciliation 通过已注册的 session-switch reconciler 运行。

## Failure and edge-case behavior

### Cancellation paths

- CLI 选择器 cancel -> 返回 `null`,调用方打印 `No session selected`,进程退出。
- Interactive 选择器 cancel -> 关闭 overlay,无会话变更。
- 核心钩子取消(`session_before_switch`) -> `switchSession()` 返回 `false`。
- **当前交互式注意事项:**`handleResumeSession` 不检查该 boolean,而是继续其 UI 刷新/状态路径。因此,被钩子取消的交互式切换会保留旧会话,但可能显示误导性的 resumed 状态。

### Empty list paths

- CLI `--resume`(无值):只有空的 current-folder **且** 全局列表才会打印 `No sessions found` 并退出;否则,空的 folder-scope 选择器会提示 Tab。
- Interactive selector:空的 folder 作用域渲染 Tab 提示并保持可取消。

### Missing/invalid target session file

当打开/切换到特定路径时(`setSessionFile`):

- ENOENT -> 视为空 -> 在该确切路径初始化新会话并持久化。
- header 格式错误/无效(或解析条目实际上不可读) -> 视为空 -> 初始化并持久化新会话。

这是恢复行为,不是硬失败。

### Hard failures

在真正的 I/O 失败(权限错误、回写失败等)时,switch/open 仍可能抛出,并向调用方传播。

### ID prefix matching caveats

- 匹配使用小写 session id、小写 JSONL filename,以及文件名时间戳之后的小写 id 后缀上的 `startsWith`。
- Modified 降序的首个匹配胜出;如果多个会话共享一个前缀,则没有歧义 UI。
- 前缀列表的元数据刻意保持轻量,因此搜索文本可能不会包含会话文件前 4KB 之外的消息。
