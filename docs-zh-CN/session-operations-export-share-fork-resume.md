# 会话操作：export、dump、share、fresh、clear、fork、resume/continue

本文件描述当前已实现的会话导出、分享、对话重置、生命周期、fork 与 resume 操作的面向操作员的可观察行为。

## 实现文件

- [`../src/modes/controllers/command-controller.ts`](../packages/coding-agent/src/modes/controllers/command-controller.ts)
- [`../src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts)
- [`../src/session/session-manager.ts`](../packages/coding-agent/src/session/session-manager.ts)
- [`../src/export/html/index.ts`](../packages/coding-agent/src/export/html/index.ts)
- [`../src/export/custom-share.ts`](../packages/coding-agent/src/export/custom-share.ts)
- [`../src/main.ts`](../packages/coding-agent/src/main.ts)

## 操作矩阵

| 操作 | 入口路径 | 会话变更 | 会话文件创建/切换 | 输出产物 |
| --- | --- | --- | --- | --- |
| `/dump` | 斜杠命令（TUI/headless） | 否 | 否 | 剪贴板/命令文本，外加尽力而为的临时 JSON sidecar |
| `/export [--themes] [path]` | 斜杠命令（TUI/headless） | 否 | 否 | HTML 文件 |
| `--export <session.jsonl> [outputPath]` | CLI 启动快速路径 | 无运行时会话变更 | 无活动会话；读取目标文件 | HTML 文件 |
| `/share` | 斜杠命令（TUI/headless） | 否 | 否 | 加密的分享链接（gist 或 share server）；仅 TUI 自定义 handler 使用临时 HTML |
| `/new` | 交互式斜杠命令 | 是（开启一个空对话） | 切换标识；在持久化模式下分配新的 transcript 路径 | 无 |
| `/fresh` | 斜杠命令（TUI/headless） | 是（仅面向 provider 的内存 id/状态） | 否；保留当前会话文件/header | 无 |
| `/clear` | 交互式斜杠命令 | 是（清空 live/model 对话上下文） | 否；保留会话标识、元数据、transcript 文件和完整的磁盘历史 | 追加一个持久的 `reset_boundary` |
| `/delete` | 交互式斜杠命令 | 是（开启一个空对话） | 尝试删除当前持久化的会话和 artifacts，然后切换到新会话 | 无 |
| `/fork` | 交互式斜杠命令 | 是（活动会话标识发生变化） | 创建新的会话文件并把当前会话切换到它（仅持久化模式） | 存在时把 artifact 目录复制到新的会话命名空间 |
| `--fork <id\|path>` | CLI 启动 | 是（会话创建之后） | 从选定来源在当前 cwd/session dir 中创建新的会话 fork | 无 |
| `/resume [id\|@claude\|@codex]` | 交互式斜杠命令 | 是（替换活动的内存状态） | 切换到选定/匹配的会话，或导入选定的外部会话 | 无 |
| `--resume` | CLI 启动 picker | 是（会话创建之后） | 打开选定的既有会话文件（picker 以当前文件夹范围打开；global list 仅为「一切为空」的提前退出和即时 Tab 切换而预加载） | 无 |
| `--resume <id\|path>` | CLI 启动 | 是（会话创建之后） | 打开既有会话；缺失的记录 cwd 可能被 re-root 到当前目录 | 无 |
| `/restart` | 交互式斜杠命令 | 是（进程重新启动） | 用原始启动 flags 重新启动 omp，并就地恢复当前会话 | 无 |
| `--continue` | CLI 启动 | 是（会话创建之后） | 打开终端 breadcrumb 或最近会话；若不存在则创建新会话 | 无 |

## 导出与 dump

### `/export [--themes] [outputPath]`（斜杠命令）

流程：

1. 内置斜杠命令注册表（`src/slash-commands/builtin-registry.ts`）用 `parseExportArgs` 解析参数；TUI 将同一条命令委托给 `CommandController.handleExportCommand`。
2. `--themes` 选择已配置的 dark/light TUI 主题，而不是独立的 web 调色板。移除该 flag 后，至多接受一个以空白分隔的路径；多余的 token 会产生 `Usage: /export [--themes] [path]`。
3. `AgentSession.exportToHtml()` 调用 `exportSessionToHtml(sessionManager, state, { outputPath, palette, themeNames })`。
4. TUI 显示路径并在浏览器中打开该文件。无头命令执行会打印路径而不打开它。

行为细节：

- `--copy`、`clipboard` 和 `copy` 参数会被显式拒绝，并警告应使用 `/dump`。
- 导出会嵌入会话 header/entries/leaf，以及来自 agent 状态的当前 `systemPrompt` 和工具描述。
- 存放在会话文件旁的子代理 transcript（`<session>/<AgentId>.jsonl`，对嵌套 spawn 递归）会作为 `subSessions` 嵌入（`src/export/html/index.ts` 中的 `collectSubSessions`；可通过 `ExportOptions` 中的 `includeSubSessions: false` 禁用）。在页面中，task tool 卡片里的 agent id 会打开带面包屑导航的子会话浮层。
- 工具调用通过 `<omp-tool-view>` web 组件渲染——即与 collab-web 共享的 React 逐工具渲染器（`packages/collab-web/src/tool-render/`），由 `bun run gen:tool-views` 预构建进 `src/export/html/tool-views.generated.js`。
- 导出期间不会追加任何会话条目。

注意事项：

- 解析基于空白分隔，因此带空格、加引号的路径不会被保留。请使用不含空格的路径。

### `--export <inputSessionFile> [outputPath]`（CLI）

`main.ts` 中的流程：

1. 在交互式/会话启动之前提前处理。
2. 调用 `exportFromFile(inputPath, outputPath?)`。
3. `SessionManager.open(inputPath)` 加载条目，然后生成并写入 HTML。
4. 进程打印 `Exported to: ...` 并退出。

行为细节：

- 输入文件缺失时会显示 `File not found: <path>`。
- 此路径不创建 `AgentSession`，也不会变更任何正在运行的会话。

### `/dump`（剪贴板/无头文本导出）

流程：

1. 该命令调用 `session.formatSessionAsText()`。
2. 若返回空字符串，命令会报告 `No messages to dump yet.`
3. 否则它还会尝试 `session.dumpLlmRequestToTmpDir()`，并把得到的路径追加到 transcript。TUI 将合并后的文本复制到剪贴板；headless/ACP 命令执行则把它作为命令输出返回。

Dump transcript 包含的内容：

- 系统提示词
- 当前 model/thinking level
- 工具定义 + 参数
- 用户/助手消息
- thinking 块与工具调用
- 工具结果与执行块（`excludeFromContext` 的 bash/python 条目除外）
- custom/hook/文件提及/branch summary/compaction summary 条目

这个尽力而为的 JSON sidecar 位于 OS 临时目录下，文件名为 `omp-llm-request-<id>.json`。它包含当前 model、thinking level、service tier、system prompt、wire tool schemas 以及经 LLM 转换的 messages。命令结束后它仍会保留，其中可能包含原始上下文或机密信息；请相应地保护或删除它。sidecar 失败不会抑制 transcript（TUI 会报告该失败；headless 执行会静默省略该路径）。

dump 不会追加任何会话持久化条目。

## `/share`

`/share` 会发布会话的端到端加密快照，并打印一个 viewer link。实现：[`../packages/coding-agent/src/export/share.ts`](../packages/coding-agent/src/export/share.ts)。

### TUI 阶段 1：自定义 share handler（若存在）

交互式 TUI 的 `loadCustomShare()` 会在 `~/.omp/agent` 中检查第一个存在的候选文件：

- `share.ts`
- `share.js`
- `share.mjs`

要求：

- 模块必须默认导出一个函数 `(htmlPath) => Promise<CustomShareResult | string | undefined>`。

若存在且有效，则保留旧有契约：会话会被导出到一个临时 HTML 文件（`${os.tmpdir()}/${Snowflake.next()}.html`），handler 收到它的路径，临时文件随后被删除。Handler 结果的解读方式：

- string => 视为 URL，显示并打开
- object => 显示 `url` 和/或 `message`；打开 `url`
- `undefined`/falsy => 通用提示 `Session shared`

关键回退行为：

- 若自定义 handler 存在但加载失败，命令报错并返回。
- 若自定义 handler 执行时抛出异常，命令报错并返回。
- 在上述两种失败情况下，它都**不会**回退到默认流程。
- 只有当不存在自定义 share 脚本时，默认流程才会运行。
- headless/ACP 斜杠命令执行不会加载自定义 share 脚本；它始终使用默认的加密流程。

### 默认的加密分享

对于 headless 执行，或在 TUI 中仅在未找到自定义 share handler 时，`shareSession()` 会：

1. 构建会话快照（`header`、`entries`、`leafId`，外加来自 agent 状态的当前 `systemPrompt` 和工具描述）。
2. 若启用了 `share.redactSecrets`（默认启用）且混淆器已有配置或经正则发现的 secrets，则进行一次类型化的逐字段 redaction，改写承载文本的 header、prompt、tool、entry、sub-session 和 message 字段。内联图片字节会为后续的 size 处理保留。不透明的 provider replay 字段与无类型的 extension payload（`details`、`data`、`outputSchema`、compaction preserve data）会被丢弃而不予遍历。
3. JSON 会经过 gzip 压缩，并用新生成的 AES-256-GCM 密钥封装（`[12B IV][ciphertext+tag]`）。
4. 上传目标由 `share.store` 选择：
   - **Share server**（默认，`store: "blob"`）—— `POST <share.serverUrl>`（默认 `https://my.omp.sh/s`），携带原始 blob，上限 1 MB。超限的快照会被裁剪直至装得下：先内联图片，再长字符串（32 KB → 8 KB → 2 KB → 512 B 上限），最后是最旧的条目。
   - **Secret gist**（`store: "gist"`）—— 当 `gh` 已安装并通过认证时，封装后的 blob 会以 base64 编码推送到 `session.ompshare.txt`（封装后预算 5 MB；gist raw 抓取上限 10 MB）；当 `gh` 不可用时回退到 share server。
5. 两种情况下链接都是 `<share.serverUrl>/<id>#<base64url key>`。在该处提供的 viewer 页面会抓取该 blob（hex id 走 GitHub gist API，其他一切从服务器的 blob store 取）并在客户端解密；密钥只存在于 URL fragment 中，绝不会出现在任何 HTTP 请求里。

UI 会报告 share URL（外加底层 gist URL，以及适用时的裁剪说明）。Headless `/share` 会打印同样的这些行。与 `/export` 不同，`/share` 对内存中（`--no-session`）的会话也有效：快照由 live entries 构建，不需要会话文件。

share 中的取消/中止语义：

- Loader 有 `onAbort` 钩子，用于恢复编辑器 UI 并报告 `Share cancelled`。
- 上传本身不会被中途中止；取消是 UI 层面的，并在上传返回后检查。

## `/fresh`

交互式 `/fresh` 会重置当前会话面向 provider 的 stream state，**而不触碰本地 transcript、会话文件或 header**。当你遇到卡死或损坏的 provider stream（prompt cache 过期、回合中途出现故障，或服务端 conversation id 已漂移）时，可以用它来恢复，同时保留你所能看到的对话。

`AgentSession.freshSession()`：

- 在 agent 正在流式输出时会被拒绝——请等待响应结束，或先中止它。
- 关闭每一个已缓存的 provider-session state 条目（服务端 conversation / prompt-cache 句柄），并报告被剪除的数量。
- 生成新的 provider session id，并把 hindsight 和 mnemopi memory 重新以它作为键，同时使 append-only context 失效，让下一回合把完整的本地 transcript 重新发送给 provider。
- 保持本地 transcript、会话文件和会话标识不变，因此你说过或收到过的任何内容都不会丢失。

由于它同时保留可见对话和面向模型的对话，`/fresh` 不同于 `/clear`（就地清空 live/model 对话）、`/new`（开启一个全新的空会话）以及 `/delete`（尝试删除当前会话并开启一个新会话）。只有 `/fresh` 在保留既有对话的同时，让 provider stream state 获得一个干净的开始。

## `/clear`

交互式 `/clear` 会就地清空当前对话上下文。它仅在 TUI 中可用，并且在响应正在流式输出，或前台 bash/Python 执行正在运行时会被拒绝。若 compaction 处于活动状态，命令会中止它，并等待其停止后再重置。

`AgentSession.resetSessionContext()`：

- 丢弃 live messages、已排队的 steer/follow-up turns、pending tool calls、error 状态、checkpoint/rewind 和 deferred tool state，以及 session-stop continuation 状态。它还会取消本 agent 已排队的 continuation 工作和 async bash/task 任务。
- 轮换 provider 端的 session state、重新初始化 advisors、使 append-only model context 失效，并重置 memory promotion，让下一回合从基础 system prompt 和当前项目指令重建。
- 保留 session id、title、cwd、model、settings、active plan path 和 transcript file。
- 追加一个持久的 `reset_boundary`。折叠后的 live transcript 与重建后的 model context 从最新 boundary 之后开始，而 JSONL transcript 与整份 transcript 的导出会保留磁盘上重置前的历史。

TUI 在成功 clear 之后会清空它渲染的 transcript。这与 `/fresh`（轮换 provider stream state 但不清空对话）、`/new`（创建新的会话标识和 transcript 文件）以及 `/delete`（在开启新会话前尝试删除旧的持久化会话）不同。

## BTW 历史

`/btw` 历史与会话 artifacts 存放在一起，并留在主对话之外。键盘控制、follow-up、持久化和迁移安全性参见 [BTW 命令参考](slash-command-internals.md#11-内置命令说明btw)。

## `/fork`

交互式 `/fork` 会基于当前会话创建一个新会话，并切换活动的会话标识。

### 前置条件与即时守卫

- 若 agent 正在流式输出，`/fork` 会被拒绝并给出警告。
- UI 状态/加载指示器会在操作前被清除。

### 会话层面流程

`AgentSession.fork()`：

1. 发出 `session_before_switch`，`reason: "fork"`（可取消）。
2. Flush 待处理的写入。
3. 调用 `SessionManager.fork()`。
4. 把 artifacts 目录从旧会话命名空间复制到新命名空间（尽力而为；非 ENOENT 的复制失败会被记录，但不致命）。
5. 更新 `agent.sessionId`，并在尚未显式固定 prompt-cache key 时继承之前的 provider prompt-cache key。
6. 发出 `session_switch`，`reason: "fork"`。

`SessionManager.fork()` 行为：

- 要求持久化模式且存在会话文件。
- 创建新的 session id 和新的 JSONL 文件路径。
- 重写 header：
  - 新的 `id`
  - 新的 timestamp
  - `cwd` 保持不变
  - `parentSession` 设为之前的 session id
  - `providerPromptCacheKey` 设为之前 header 继承的 key；若没有固定过 key，则设为之前的 session id
- 在新文件中保留所有非 header 条目不变。

### 非持久化行为

- 内存中的 session manager 从 `fork()` 返回 `undefined`。
- `AgentSession.fork()` 返回 `false`。
- UI 报告 `Fork failed (session not persisted or cancelled)`。

### CLI `--fork <id|path>`

启动时的 `--fork` 在常规会话创建之前解析：

1. `--fork` 与 `--no-session` 同时使用会被拒绝。
2. 形似路径的值（`/`、`\` 或 `.jsonl`）会调用 `SessionManager.forkFrom(path, cwd, sessionDir)`。
3. 其他值通过 `resolveResumableSession(...)` 解析：先查找本地会话，当未强制指定 `sessionDir` 时再进行全局搜索。匹配接受小写的 session id 前缀、完整 JSONL 文件名前缀，以及去掉 timestamp 的文件名 id 后缀。
4. fork 出的文件会在当前 cwd/session-dir 范围内创建，并成为启动阶段的活动 session manager。
5. Full-context fork 会自动从源 header 继承的 key 播种 `providerPromptCacheKey`，没有时回退到源 session id。当 `--model`、`--thinking`、`--system-prompt`、`--append-system-prompt`、`--tools` 或 `--no-tools` 改变了 provider 路由或 prompt/tool 形态时，启动会丢弃该自动继承。

使用 `--prompt-cache-key <key>` 可显式固定 provider prompt-cache 标识，并独立于 OMP session id 和 `--provider-session-id` 两者。`--provider-session-id` 继续控制 provider session/routing headers 和 sticky credential 选择；在支持的情况下，`--prompt-cache-key` 控制 OpenAI Responses 的 `prompt_cache_key` payload。

## resume 与 continue

## 交互式 `/resume [value]`

无参数时：

1. 打开通过 `SessionManager.list(currentCwd, currentSessionDir)` 填充的会话选择器。picker 始终以当前文件夹范围为起点打开；空状态（`No sessions in current folder. Press Tab to view all.`）会引导用 Tab 进入 all-projects，而不是自动切换（issue #3099）。
2. Tab 切换到 all-projects 范围，惰性加载并缓存 `SessionManager.listAll()`。
3. 选中后，`SelectorController.handleResumeSession(sessionPath)` 调用 `session.switchSession(sessionPath)`。若切换被拒绝，它会返回 `false`，选择器随即停止，不会应用新会话的 UI 状态。
4. 成功切换后，UI 清空/重建 chat 和 todos，然后报告 `Resumed session`（当恢复的会话属于另一个项目时报告 `Resumed session in <dir>`，此时进程 cwd 和由 cwd 派生的缓存会通过 `applyCwdChange` 重新指向）。

带参数时：

- `/resume <id>` 会以本地优先、再全局回退的方式解析 id/filename 前缀，并直接切换到匹配的文件；未知的值会报告 `Session "<value>" not found`。
- `/resume @claude` 和 `/resume @codex` 打开外部会话 picker。选中一个会把它在全新的 OMP 会话标识下转换并持久化，然后切换到该新会话。

## CLI `--resume`

### `--resume`（无参数）

- `main.ts` 列出当前 cwd/sessionDir 的会话，并以当前文件夹范围打开 picker。当该列表为空时，它会预加载 `SessionManager.listAll()`，使用户主动用 Tab 切换到 all-projects 范围时是即时的；它不会自动切换范围（issue #3099）。只有当全局列表也为空时，才会打印 `No sessions found`。
- 选中的路径会在会话创建之前通过 `SessionManager.open(selectedPath)` 打开；随后进程/项目范围会切换到被恢复会话的 cwd（`switchToResumedProject`），重新加载 cwd-scoped 的 settings 和 plugin caches，并重新解析 scoped models。

### `--resume <value>`

`createSessionManager()` 的解析顺序：

1. 若 value 形似路径（`/`、`\` 或 `.jsonl`），直接打开。
2. 否则 `resolveResumableSession(...)` 搜索：
   - 当前范围（`SessionManager.list(cwd, sessionDir)`）
   - 全局会话（`SessionManager.listAll()`），仅在未提供显式 `sessionDir` 时
3. 匹配接受大小写不敏感的 session id 前缀、完整 JSONL 文件名前缀，以及 `<timestamp>_<sessionId>.jsonl` 中 timestamp 之后的 id 后缀。

跨项目 id 匹配行为：

- 若匹配到的会话所记录的目录已不存在，CLI 会询问 `Session's directory no longer exists (...). Move (re-root) it into the current directory? [Y/n]`。
  - 选择 yes（默认）时，先 `SessionManager.open(match.path)` 再 `manager.moveTo(cwd)`，会把既有会话 re-root 到当前目录，而不复制它。
  - 选择 no 时，启动被取消。在非 TTY 模式下，启动会以错误失败，并指引用户以交互方式运行。
- 若所记录的目录仍然存在，则直接打开匹配到的会话。启动随后会把进程/项目范围切换到被恢复会话的 cwd，并重新加载 cwd-scoped 的 settings 和 plugin caches。它不会被隐式 fork。

## CLI `--continue`

`SessionManager.continueRecent(cwd, sessionDir)`：

1. 解析当前 cwd 对应的会话目录。
2. 读取 terminal-scoped breadcrumb。若它指向嵌套的 artifact/subagent 会话，解析会向上走到顶层交互式父会话（最多八层）。
3. 若 breadcrumb 指向一个记录在不同 cwd 下、其目录已不存在的会话，**且**当前目录没有自己的会话，则通过 `moveTo` 把该会话 re-root 到当前目录，而不是重新开始。
4. 否则，若 breadcrumb 的 cwd 与当前 cwd 匹配，则使用 breadcrumb 会话；否则回退到最近修改的会话文件。
5. 打开找到的会话；若不存在，则创建新会话。

为保持兼容，当 UUID 是唯一的 positional message 时，`--continue <full-UUID>` 会被规范化为 `--resume <UUID>`。在未提供显式 session flag/session directory 时，`autoResume` 设置会调用同样的 `continueRecent` 行为，并在找到先前的 transcript 时恢复会话的 model/thinking 状态。

这是仅限启动时的行为；不存在交互式 `/continue` 斜杠命令。

## 会话切换实际如何变更运行时状态

`AgentSession.switchSession(sessionPath)` 执行 resume 类操作所用的运行时转换：

1. 发出 `session_before_switch`，`reason: "resume"` 且带 `targetSessionFile`（可取消）。
2. 断开 agent 事件订阅，中止在途工作，并运行可选的 pre-switch reconciler。
3. Flush 待处理的 bash/session 写入并捕获回滚状态：session manager 状态；agent messages 和全部队列；model/thinking/service tiers；tools 与 prompts；provider/cache ids；memory promotion；以及 checkpoint rewind 状态。
4. 清空 agent 队列和 next-turn 队列。针对不同的文件，drain/detach advisor recorders。
5. `sessionManager.setSessionFile(sessionPath)`，更新 provider-cache/session ids 与 memory keys，构建 display context，并 rehydrate checkpoint 状态。
6. 发出 `session_switch`，`reason: "resume"`。
7. 替换 agent messages，重置 advisor 状态，并同步 todos。针对不同的文件，或针对 replay messages 发生变化的同文件 reload，关闭已缓存的 provider sessions。
8. 恢复可用的持久化 model。若加载的分支以一次被中断的 turn 结尾，则追加其合成的 abort message 并重建 context。
9. 恢复已配置的/生效的 thinking 和按 family 的 service tiers，当目标分支没有对应条目时回退到当前 settings。
10. 对于不同的 transcript，重置 memory context；对于任何对话重写，清除 session-scoped 的 tool 状态。
11. 重新连接 agent 事件，运行可选的 session-switch reconciler（交互式模式用它重新进入 plan 等持久化模式），并尽力刷新 workspace-root 的 system-prompt 块。Reconciler/prompt-refresh 的错误会被记录，而不是回滚已提交的切换。
12. 恢复目标 advisor 的成本状态，完成 bash 转换，在 session id 变化时通知 session-change 回调，并返回 `true`。
当 before-switch hook 取消，或 cwd 策略拒绝该转换时，`switchSession()` 会返回 `false`。没有 cwd-change 回调的跨项目切换会被拒绝，而不是静默采用目标 cwd；回调的拒绝同样属于取消。交互式选择器会检查这一结果，并让既有 session/UI 保持不变。

若受守卫转换中的某一步抛出异常，`switchSession()` 会恢复已捕获的 session、agent queues/messages、tools/prompts、model/thinking/service-tier、provider/cache、memory 和 checkpoint 状态；它会重新连接先前的 agent 订阅，并在重新抛出之前重跑模式协调。

`switchSession()` 本身不会创建新的会话文件。

## 事件发射与取消点

### switch/fork 生命周期 hook

对于 `newSession`、`fork` 和 `switchSession`：

- 前置事件：`session_before_switch`
  - reasons：`new`、`fork`、`resume`
  - 通过返回 `{ cancel: true }` 取消
- 后置事件：`session_switch`
  - 相同的 reason 集合
  - 包含 `previousSessionFile`

`ExtensionRunner.emit()` 在遇到第一个取消性的前置事件结果时会提前返回。
当 before-switch hook 取消时，`switchSession()` 返回 `false`，且不会发出 after-switch 事件。

### custom tool 的 `onSession` 行为

SDK 将 extension 的 session events 桥接到 custom tool 的 `onSession` 回调：

- `session_switch` -> `onSession({ reason: "switch", previousSessionFile })`
- `session_branch` -> `reason: "branch"`
- `session_start` -> `reason: "start"`
- `session_tree` -> `reason: "tree"`
- `session_shutdown` -> `reason: "shutdown"`

这些回调是观察性的；它们不会取消 switch/fork。

### 与本文件相关的其他取消面

- `/fork` 在流式输出期间被阻塞（用户必须先等待/中止当前响应）。
- `/resume` selector 可被用户关闭 selector 而取消。
- 跨项目 `--resume <id>` 可通过拒绝缺失目录的 move/re-root 提示来取消。
- `/share` 有 UI abort 路径（`Share cancelled`）；上传本身不会在途中被终止。

## 非持久化（内存中）会话行为

当 session manager 通过 `SessionManager.inMemory()`（`--no-session`）创建时：

- 会话文件路径不存在。
- `/export` 会失败并报 `Cannot export in-memory session to HTML`（会传播到命令错误 UI）。`/share` 仍然有效：快照由 live entries 构建。
- `/fork` 会失败，因为 `SessionManager.fork()` 要求持久化。
- `/dump` 仍然有效，因为它会序列化内存中的 agent 状态。
- 若设置了 `--no-session`，CLI 的 resume/continue 语义会被绕过，因为 manager 创建会立即返回 in-memory。

## 已知实现注意事项（截至当前代码）

- `/share` 的自定义 share 失败不会降级到默认的加密分享流程；它们会以错误终止 TUI 命令。
- `/export` 的参数分词不会保留带空格、加引号的路径。
- `/delete` 把删除视为尽力而为：它尝试删除当前 session JSONL 和 artifact 目录，记录任何删除失败，并仍然创建和切换到新会话。删除失败或只删一部分都可能把旧会话或其 artifacts 留在磁盘上，因此 `/delete` 并非有保证的 erasure boundary。
