# Session Operations: export, dump, share, fresh, clear, fork, resume/continue

本文档描述当前已实现的会话导出、分享、对话重置、生命周期、fork 与 resume 操作的面向操作员的可观察行为。

## Implementation files

- [`../src/modes/controllers/command-controller.ts`](../packages/coding-agent/src/modes/controllers/command-controller.ts)
- [`../src/session/agent-session.ts`](../packages/coding-agent/src/session/agent-session.ts)
- [`../src/session/session-manager.ts`](../packages/coding-agent/src/session/session-manager.ts)
- [`../src/export/html/index.ts`](../packages/coding-agent/src/export/html/index.ts)
- [`../src/export/custom-share.ts`](../packages/coding-agent/src/export/custom-share.ts)
- [`../src/main.ts`](../packages/coding-agent/src/main.ts)

## Operation matrix

| Operation                               | Entry path                   | Session mutation                              | Session file creation/switch                                                               | Output artifact                                                                     |
| --------------------------------------- | ---------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `/dump`                                 | Slash command (TUI/headless) | No                                            | No                                                                                         | Clipboard/command text plus best-effort temporary JSON sidecar                      |
| `/export [--themes] [path]`             | Slash command (TUI/headless) | No                                            | No                                                                                         | HTML file                                                                           |
| `--export <session.jsonl> [outputPath]` | CLI startup fast-path        | No runtime session mutation                   | No active session; reads target file                                                       | HTML file                                                                           |
| `/share`                                | Slash command (TUI/headless) | No                                            | No                                                                                         | Encrypted share link (gist or share server); temp HTML only for TUI custom handlers |
| `/new`                                  | Interactive slash command    | Yes (starts an empty conversation)            | Switches identity; assigns a new transcript path in persistent mode                        | None                                                                                |
| `/fresh`                                | Slash command (TUI/headless) | Yes (provider-facing in-memory id/state only) | No; keeps current session file/header                                                      | None                                                                                |
| `/clear`                                | Interactive slash command    | Yes (clears live/model conversation context)  | No; retains session identity, metadata, transcript file, and full on-disk history          | Appends a durable `reset_boundary`                                                  |
| `/drop`                                 | Interactive slash command    | Yes (starts an empty conversation)            | Attempts to delete the current persisted session and artifacts, then switches to a new one | None                                                                                |
| `/fork`                                 | Interactive slash command    | Yes (active session identity changes)         | Creates new session file and switches current session to it (persistent mode only)         | Copies artifact directory to new session namespace when present                     |
| `--fork <id\|path>`                     | CLI startup                  | Yes after session creation                    | Creates a new session fork from the selected source into current cwd/session dir           | None                                                                                |
| `/resume [id\|@claude\|@codex]`         | Interactive slash command    | Yes (active in-memory state replaced)         | Switches to a selected/matched session, or imports a selected foreign session              | None                                                                                |
| `--resume`                              | CLI startup picker           | Yes after session creation                    | Opens selected existing session file                                                       | None                                                                                |
| `--resume <id\|path>`                   | CLI startup                  | Yes after session creation                    | Opens existing session; a missing recorded cwd may be re-rooted into the current directory | None                                                                                |
| `--continue`                            | CLI startup                  | Yes after session creation                    | Opens terminal breadcrumb or most-recent session; creates new one if none exists           | None                                                                                |

## Export and dump

### `/export [--themes] [outputPath]` (slash command)

流程：

1. 内置斜杠命令注册表（`src/slash-commands/builtin-registry.ts`）使用 `parseExportArgs` 解析参数；TUI 将同一条命令委托给 `CommandController.handleExportCommand`。
2. `--themes` 选择已配置的 dark/light TUI 主题，而非独立网页调色板。去除该 flag 后，至多接受一个以空白分隔的路径；多余的 token 会产生 `Usage: /export [--themes] [path]`。
3. `AgentSession.exportToHtml()` 调用 `exportSessionToHtml(sessionManager, state, { outputPath, palette, themeNames })`。
4. TUI 显示路径并在浏览器中打开该文件。无头命令执行会打印路径但不会打开。

行为细节：

- `--copy`、`clipboard` 和 `copy` 参数会被显式拒绝，并提示应使用 `/dump`。
- 导出会嵌入会话 header/entries/leaf，以及来自 agent 状态的当前 `systemPrompt` 和工具描述。
- 存储在会话文件旁的子代理 transcript（`<session>/<AgentId>.jsonl`，对嵌套 spawn 递归）会作为 `subSessions` 嵌入（位于 `src/export/html/index.ts` 的 `collectSubSessions`；可通过 `ExportOptions` 中的 `includeSubSessions: false` 禁用）。在页面中，task tool 卡片中的 agent id 会打开带面包屑导航的子会话浮层。
- 工具调用通过 `<omp-tool-view>` web 组件渲染——这是与 collab-web 共享的 React 按工具渲染器（`packages/collab-web/src/tool-render/`），由 `bun run gen:tool-views` 预构建到 `src/export/html/tool-views.generated.js`。
- 导出过程中不会向会话追加任何条目。

注意事项：

- 解析基于空白分隔，因此带空格、带引号的路径不会被保留。请使用不含空格的路径。

### `--export <inputSessionFile> [outputPath]` (CLI)

`main.ts` 中的流程：

1. 在交互式/会话启动前提前处理。
2. 调用 `exportFromFile(inputPath, outputPath?)`。
3. `SessionManager.open(inputPath)` 加载条目，然后生成并写入 HTML。
4. 进程打印 `Exported to: ...` 并退出。

行为细节：

- 输入文件缺失时显示 `File not found: <path>`。
- 此路径不创建 `AgentSession`，也不会变更任何正在运行的会话。

### `/dump`（剪贴板/无头文本导出）

流程：

1. 该命令调用 `session.formatSessionAsText()`。
2. 若返回空字符串，命令报告 `No messages to dump yet.`
3. 否则它还会尝试调用 `session.dumpLlmRequestToTmpDir()`，并将得到的路径追加到 transcript。TUI 将合并后的文本复制到剪贴板；headless/ACP 命令执行则将其作为命令输出返回。

Dump transcript 包含的内容：

- System prompt
- Active model/thinking level
- Tool definitions + parameters
- User/assistant messages
- Thinking blocks and tool calls
- Tool results and execution blocks (except `excludeFromContext` bash/python entries)
- Custom/hook/file mention/branch summary/compaction summary entries

这个尽力而为的 JSON sidecar 位于 OS 临时目录下，文件名为 `omp-llm-request-<id>.json`，其中包含当前 model、thinking level、service tier、system prompt、wire tool schemas，以及 LLM 转换后的 messages。它在命令执行后会保留下来，其中可能包含原始上下文或敏感信息；请相应地进行保护或删除。sidecar 失败不会抑制 transcript（TUI 会报告该失败；headless 执行则静默省略该路径）。

Dump 不会向会话持久化中追加任何条目。

## Share

`/share` 会发布会话的端到端加密快照，并打印一个 viewer link。实现：[`../packages/coding-agent/src/export/share.ts`](../packages/coding-agent/src/export/share.ts)。

### TUI phase 1: custom share handler (if present)

交互式 TUI 的 `loadCustomShare()` 会在 `~/.omp/agent` 中按顺序查找第一个存在的候选文件：

- `share.ts`
- `share.js`
- `share.mjs`

要求：

- 模块必须默认导出一个函数 `(htmlPath) => Promise<CustomShareResult | string | undefined>`。

若存在且有效，则保留旧的契约：会话会被导出到一个临时 HTML 文件（`${os.tmpdir()}/${Snowflake.next()}.html`），handler 收到其路径，临时文件随后被删除。Handler 结果的解读方式：

- string => 视为 URL，显示并打开
- object => 显示 `url` 和/或 `message`；打开 `url`
- `undefined`/falsy => 通用提示 `Session shared`

关键回退行为：

- 若 custom handler 存在但加载失败，命令报错并返回。
- 若 custom handler 执行时抛出异常，命令报错并返回。
- 上述两种失败情况下，**不会**回退到默认流程。
- 只有在不存在 custom share 脚本时，才会运行默认流程。
- headless/ACP 斜杠命令执行不会加载 custom share 脚本；它始终使用默认加密流程。

### Default encrypted share

对于 headless 执行，或仅当 TUI 中未找到 custom share handler 时，`shareSession()` 会：

1. 构建会话快照（`header`、`entries`、`leafId`，加上来自 agent 状态的当前 `systemPrompt` 和工具描述）。
2. 若启用了 `share.redactSecrets`（默认启用）且混淆器已通过配置或正则发现 secrets，则会进行类型化的逐字段 redaction pass，改写承载文本的 header、prompt、tool、entry、sub-session 和 message 字段。内联图片字节会保留给后续的 size pass 使用。不透明 provider replay 字段以及无类型的扩展 payload（`details`、`data`、`outputSchema`、compaction preserve data）会被丢弃而不予遍历。
3. JSON 被 gzip 压缩，并使用新生成的 AES-256-GCM 密钥进行封装（`[12B IV][ciphertext+tag]`）。
4. 上传目标由 `share.store` 决定：
   - **Share server**（默认，`store: "blob"`）—— `POST <share.serverUrl>`（默认 `https://my.omp.sh/s`），发送原始 blob，上限 1 MB。超大的快照会被裁剪以满足大小限制：先裁剪内联图片，再裁剪长字符串（32 KB → 8 KB → 2 KB → 512 B 上限），最后裁剪最旧的条目。
   - **Secret gist**（`store: "gist"`）—— 当 `gh` 已安装并完成认证时，封装的 blob 会以 base64 形式推送到 `session.ompshare.txt`（封装后预算 5 MB；gist raw 抓取上限 10 MB），若 `gh` 不可用则回退到 share server。
5. 两种情况下，链接均为 `<share.serverUrl>/<id>#<base64url key>`。在该处提供服务的 viewer 页面会抓取 blob（GitHub gist API 通过 hex id，其他情况使用服务器的 blob 存储），并在客户端解密；密钥仅存在于 URL fragment 中，不会出现在任何 HTTP 请求里。

UI 会显示 share URL（以及底层的 gist URL，并在适用时附带裁剪说明）。Headless `/share` 会打印同样的几行内容。与 `/export` 不同，`/share` 适用于内存中的（`--no-session`）会话：快照由 live entries 构建，不需要会话文件。

Share 中的取消/中止语义：

- Loader 拥有 `onAbort` 钩子，用于恢复编辑器 UI 并报告 `Share cancelled`。
- 上传本身不会中途被中止；取消发生在 UI 层，并在上传返回后进行检查。

## Fresh

交互式 `/fresh` 仅重置当前会话中面向 provider 的 stream state，**不会改动本地 transcript、会话文件或 header**。在 provider stream 卡死或损坏（prompt cache 过期、回合中途出现故障，或服务端 conversation id 已漂移）时，可使用它来恢复，同时保留你当前可见的对话。

`AgentSession.freshSession()`：

- 在 agent 正在流式输出时被拒绝——需等待响应结束或先中止它。
- 关闭所有已缓存的 provider-session state 条目（服务端 conversation / prompt-cache 句柄），并报告被剪除的数量。
- 生成新的 provider session id，并为 hindsight 和 mnemopi 内存使用新 id 重新建键，并令 append-only context 失效，使下一回合会把完整的本地 transcript 重新发送给 provider。
- 本地 transcript、会话文件和会话标识保持不变，因此你说过的或收到的一切都不会丢失。

由于它同时保留了可见的对话和面向模型的对话，因此 `/fresh` 区别于 `/clear`（就地清空 live/model 对话）、`/new`（开启一个全新的空会话）以及 `/drop`（尝试删除当前会话并开启新会话）。只有 `/fresh` 在保留既有对话的同时，让 provider stream state 获得一个干净的开始。

## Clear

交互式 `/clear` 会在原地清空当前对话上下文。它仅在 TUI 中可用，并且在响应正在流式输出，或前台 bash/Python 执行正在运行时被拒绝。如果启用了 compaction，命令会中止它，并等待其停止后再重置。

`AgentSession.resetSessionContext()`：

- 丢弃 live messages、已排队的 steer/follow-up turns、pending tool calls、error 状态、checkpoint/rewind 和 deferred tool state，以及 session-stop continuation 状态。同时取消本 agent 已排队的 continuation 工作和 async bash/task 任务。
- 轮换 provider 端的 session state、重新初始化 advisors、令 append-only model context 失效，并重置 memory promotion，使下一回合从基础 system prompt 和当前项目指令重新构建。
- 保留 session id、title、cwd、model、settings、active plan path 以及 transcript file。
- 追加一个持久的 `reset_boundary`。折叠后的 live transcript 与重建后的 model context 从最新的 boundary 之后开始，而 JSONL transcript 与完整 transcript 导出则保留磁盘上重置前的历史。

TUI 在成功 clear 之后会清空其渲染的 transcript。这与 `/fresh`（轮换 provider stream state 但不清空对话）、`/new`（创建新的会话标识和 transcript 文件）以及 `/drop`（在开启新会话前尝试删除旧的持久化会话）不同。

## Fork

交互式 `/fork` 会基于当前会话创建一个新会话，并切换当前的活动会话标识。

### Preconditions and immediate guards

- 若 agent 正在流式输出，`/fork` 会被拒绝并给出警告。
- UI 状态/加载指示器会在操作前被清除。

### Session-level flow

`AgentSession.fork()`：

1. 发出 `session_before_switch`，`reason: "fork"`（可取消）。
2. Flush 待处理写入。
3. 调用 `SessionManager.fork()`。
4. 将 artifacts 目录从旧会话命名空间复制到新命名空间（尽力而为；非 ENOENT 的复制失败会被记录而非视为致命错误）。
5. 更新 `agent.sessionId`，并在未显式固定 prompt-cache key 的情况下，继承之前的 provider prompt-cache key。
6. 发出 `session_switch`，`reason: "fork"`。

`SessionManager.fork()` 行为：

- 要求 persistent 模式且存在会话文件。
- 创建新的 session id 和新的 JSONL 文件路径。
- 使用以下内容重写 header：
  - 新的 `id`
  - 新的 timestamp
  - `cwd` 保持不变
  - `parentSession` 设置为之前的 session id
  - `providerPromptCacheKey` 设置为之前 header 中继承的 key；若没有固定的 key，则设置为之前的 session id
- 在新文件中保留所有非 header 条目不变。

### Non-persistent behavior

- 内存中的 session manager 会从 `fork()` 返回 `undefined`。
- `AgentSession.fork()` 返回 `false`。
- UI 报告 `Fork failed (session not persisted or cancelled)`。

### CLI `--fork <id|path>`

启动时 `--fork` 在常规会话创建前解析：

1. `--fork` 与 `--no-session` 同时使用会被拒绝。
2. 形似路径的值（`/`、`\` 或 `.jsonl`）会调用 `SessionManager.forkFrom(path, cwd, sessionDir)`。
3. 其他值通过 `resolveResumableSession(...)` 解析：先查找本地会话，当未强制指定 `sessionDir` 时再进行全局搜索。匹配接受小写的 session id 前缀、完整 JSONL 文件名前缀，以及去除 timestamp 的文件名 id 后缀。
4. 派生（fork）得到的文件会在当前 cwd/session-dir 范围内创建，并作为启动时的活动 session manager。
5. Full-context forks 会自动从源 header 继承的 key 注入 `providerPromptCacheKey`，若没有则回退到源 session id。当 `--model`、`--thinking`、`--system-prompt`、`--append-system-prompt`、`--tools` 或 `--no-tools` 改变了 provider 路由或 prompt/tool 形态时，启动时会丢弃该自动继承行为。

使用 `--prompt-cache-key <key>` 可显式固定 provider prompt-cache 标识，并独立于 OMP session id 和 `--provider-session-id`。`--provider-session-id` 继续控制 provider session/routing headers 和 sticky credential 选择；`--prompt-cache-key` 则在支持时控制 OpenAI Responses 的 `prompt_cache_key` 负载。

## Resume and continue

## Interactive `/resume [value]`

无参数时：

1. 打开通过 `SessionManager.list(currentCwd, currentSessionDir)` 填充的会话选择器。
2. Picker 起始于当前目录范围；Tab 切换到 all-projects 范围，并惰性加载和缓存 `SessionManager.listAll()`。
3. 选中后，`SelectorController.handleResumeSession(sessionPath)` 调用 `session.switchSession(sessionPath)`。
4. UI 清空/重建 chat 和 todos，然后报告 `Resumed session`（当恢复的会话属于其他项目时报告 `Resumed session in <dir>`，此时进程的 cwd 以及由 cwd 派生的缓存会通过 `applyCwdChange` 重新指向）。

带参数时：

- `/resume <id>` 使用 id/filename 前缀进行解析，优先本地匹配，再回退到全局匹配，并直接切换到匹配的文件；未知的值会报告 `Session "<value>" not found`。
- `/resume @claude` 和 `/resume @codex` 打开外部会话 picker。选中某项后，会将其转换并以全新的 OMP 会话标识持久化，然后切换到该新会话。

## CLI `--resume`

### `--resume` (no value)

- `main.ts` 列出当前 cwd/sessionDir 的会话，并在当前目录范围打开 picker。当该列表为空时，它会预加载 `SessionManager.listAll()`，以便用户主动通过 Tab 切换到 all-projects 范围时是即时的；它不会自动切换范围。只有当 global list 也为空时，才会打印 `No sessions found`。
- 选中的路径会在会话创建前通过 `SessionManager.open(selectedPath)` 打开。从其他项目选择会话时，会先把进程切换到该项目目录，并重新加载 cwd-scoped 的 settings/caches。

### `--resume <value>`

`createSessionManager()` 解析顺序：

1. 若 value 形似路径（`/`、`\` 或 `.jsonl`），则直接打开。
2. 否则 `resolveResumableSession(...)` 在以下范围搜索：
   - 当前 scope（`SessionManager.list(cwd, sessionDir)`）
   - 全局会话（`SessionManager.listAll()`）—— 仅当未提供显式 `sessionDir` 时
3. 匹配接受大小写不敏感的 session id 前缀、完整 JSONL 文件名前缀，以及 `<timestamp>_<sessionId>.jsonl` 中 timestamp 之后的 id 后缀。

跨项目 id 匹配行为：

- 若匹配到的会话所记录的目录已不存在，CLI 会询问 `Session's directory no longer exists (...). Move (re-root) it into the current directory? [Y/n]`。
  - 若选择 yes（默认），则先调用 `SessionManager.open(match.path)`，再调用 `manager.moveTo(cwd)`，将现有会话 re-root 到当前目录，且不会复制。
  - 若选择 no，则取消启动。在非 TTY 模式下，启动会以错误失败，并提示用户以交互方式运行。
- 若所记录的目录仍然存在，则直接打开匹配到的会话。启动后，进程/项目范围会随后切换到恢复会话的 cwd，并重新加载 cwd-scoped 的 settings 和 plugin caches。它不会被隐式 fork。

## CLI `--continue`

`SessionManager.continueRecent(cwd, sessionDir)`：

1. 解析当前 cwd 对应的会话目录。
2. 读取 terminal-scoped breadcrumb。若它指向一个嵌套的 artifact/subagent 会话，解析会逐级向上走到顶层交互式父会话（最多 8 层）。
3. 若 breadcrumb 指向一个记录在不同 cwd 下、且该目录已不存在的会话，**且**当前目录没有自己的会话，则通过 `moveTo` 把该会话 re-root 到当前目录，而不是重新开始。
4. 否则，若 breadcrumb 的 cwd 与当前 cwd 匹配，则使用 breadcrumb 会话；否则回退到最近修改的会话文件。
5. 打开找到的会话；若不存在，则创建新会话。

为保持兼容，当 `--continue <full-UUID>` 中的 UUID 是唯一的 positional message 时，它会被标准化为 `--resume <UUID>`。当没有显式提供 session flag/session directory 时，`autoResume` 设置会调用相同的 `continueRecent` 行为，并在找到先前 transcript 时恢复其 model/thinking 状态。

这是仅限启动时的行为；不存在交互式 `/continue` 斜杠命令。

## How session switching actually mutates runtime state

`AgentSession.switchSession(sessionPath)` 执行 resume 类操作所用的运行时切换：

1. 发出 `session_before_switch`，`reason: "resume"` 且包含 `targetSessionFile`（可取消）。
2. 断开 agent 事件订阅，中止 in-flight 工作，并运行可选的 pre-switch reconciler。
3. Flush 待处理的 bash/session 写入，并捕获回滚状态：session manager 状态；agent messages 与全部队列；model/thinking/service tiers；tools 与 prompts；provider/cache ids；memory promotion；以及 checkpoint rewind 状态。
4. 清空 agent 与 next-turn 队列。针对不同的文件，drain/detach advisor recorders。
5. 调用 `sessionManager.setSessionFile(sessionPath)`，更新 provider-cache/session ids 与 memory keys，构建 display context，并 rehydrate checkpoint 状态。
6. 发出 `session_switch`，`reason: "resume"`。
7. 替换 agent messages，重置 advisor 状态，并同步 todos。针对不同的文件，或针对 replay messages 发生变化的同文件 reload，关闭已缓存的 provider sessions。
8. 恢复可用的持久化 model。若加载的分支以一次被中断的 turn 结尾，则追加其合成的 abort message 并重建 context。
9. 恢复已配置的/生效的 thinking 和 per-family service tiers，当目标分支没有对应条目时回退到当前 settings。
10. 对于不同的 transcript，重置 memory context；对于任何 conversation rewrite，清除 session-scoped tool 状态。
11. 重新连接 agent 事件，运行可选的 session-switch reconciler（交互式模式下用于重新进入 plan 等持久化模式），并尽力刷新 workspace-root 的 system-prompt 块。Reconciler/prompt-refresh 的错误会被记录，而不是回滚已提交的切换。
12. 恢复目标 advisor 成本状态，完成 bash 转换，并在 session id 发生改变时通知 session-change 回调。

若受保护切换中的某一步抛出错误，`switchSession()` 会恢复已捕获的 session、agent 队列/messages、tools/prompts、model/thinking/service-tier、provider/cache、memory 与 checkpoint 状态；它会重新连接先前的 agent 订阅，并重新执行 mode reconciliation，然后再向上抛出。

`switchSession()` 本身不会创建新的会话文件。

## Event emissions and cancellation points

### Switch/fork lifecycle hooks

对于 `newSession`、`fork` 和 `switchSession`：

- 前置事件：`session_before_switch`
  - reasons：`new`、`fork`、`resume`
  - 通过返回 `{ cancel: true }` 取消
- 后置事件：`session_switch`
  - 相同的 reason 集合
  - 包含 `previousSessionFile`

`ExtensionRunner.emit()` 在遇到首个取消性的前置事件结果时会提前返回。

### Custom tool `onSession` behavior

SDK 将 extension 的 session events 桥接到 custom tool 的 `onSession` 回调：

- `session_switch` -> `onSession({ reason: "switch", previousSessionFile })`
- `session_branch` -> `reason: "branch"`
- `session_start` -> `reason: "start"`
- `session_tree` -> `reason: "tree"`
- `session_shutdown` -> `reason: "shutdown"`

这些回调是观察性的；它们不会取消 switch/fork。

### Other cancellation surfaces relevant to this doc

- 流式输出期间 `/fork` 被阻塞（用户必须先等待/中止当前响应）。
- `/resume` selector 可被用户关闭 selector 来取消。
- 跨项目 `--resume <id>` 可通过在缺失目录的 move/re-root 提示中选择否来取消。
- `/share` 拥有 UI abort 路径（`Share cancelled`）；上传本身不会在途中被终止。

## Non-persistent (in-memory) session behavior

当 session manager 通过 `SessionManager.inMemory()`（`--no-session`）创建时：

- 会话文件路径不存在。
- `/export` 会失败并报 `Cannot export in-memory session to HTML`（会传播到命令错误 UI）。`/share` 仍然有效：快照由 live entries 构建。
- `/fork` 会失败，因为 `SessionManager.fork()` 要求持久化。
- `/dump` 仍然有效，因为它会序列化内存中的 agent 状态。
- 若设置了 `--no-session`，CLI 的 resume/continue 语义会被绕过，因为 manager 创建会立即返回 in-memory。

## Known implementation caveats (as of current code)

- `SelectorController.handleResumeSession()` 不会检查 `session.switchSession(...)` 的 boolean 结果；被 hook 取消的 switch 仍可能继续走到 UI 的 "Resumed session" 重绘/状态路径。
- `/share` custom-share 失败时不会降级到默认加密 share 流程；它会以错误终止 TUI 命令。
- `/export` 参数分词不会保留带空格、带引号的路径。
- `/drop` 将删除视为尽力而为：它尝试删除当前
  session JSONL 和 artifact 目录，记录任何删除失败，并仍然
  创建并切换到新会话。失败或部分的删除可能将
  旧会话或其 artifacts 留在磁盘上，因此 `/drop` 并非有保证的
  erasure boundary。
