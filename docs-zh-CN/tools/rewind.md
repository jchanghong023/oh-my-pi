# rewind

> 通过裁剪探索性上下文并保留精炼报告来结束一个活跃的检查点。

## Source
- Entry: `packages/coding-agent/src/tools/checkpoint.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/rewind.md`
- Key collaborators:
  - `packages/coding-agent/src/session/agent-session.ts` — 验证待处理的 rewind 状态、执行实际的 rewind，并注入保留的报告。
  - `packages/coding-agent/src/session/session-manager.ts` — 分叉已持久化的会话树，并追加持久化的 summary/report 条目。
  - `packages/coding-agent/src/session/session-context.ts` — `buildSessionContext()` 在重建上下文时将持久化的 `branch_summary` 条目转换为对 LLM 可见的 `branchSummary` 消息。
  - `packages/coding-agent/src/tools/index.ts` — 注册该工具并共享 `checkpoint.enabled` 开关。

## Registration / Visibility
- Tool metadata: `approval = "read"`, `strict = true`, `loadMode = "discoverable"`。执行是单次的；rewind 副作用会被延迟处理，而不会以进度更新的形式流式输出。
- Registration requires `checkpoint.enabled = true` (default `false`).
- 启用时，顶级会话会获得该工具。Subagent 默认不会发现它，但可以通过显式的 `tools:`/requested-tools 列表获得。
- `checkpoint` 和 `rewind` 是一对安全工具：在特性启用时，显式请求其中任意一个会自动包含另一个。
- In an ordinary `tools.xdev` session, discoverable built-ins may be presented as `xd://rewind`; an explicitly requested tool remains top-level.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `report` | `string` | Yes | 调查结果。`execute()` 会对其进行 trim，并在结果为空时拒绝。 |

## Outputs
该工具返回单个文本结果以及结构化详情：

- text body:
  - `Rewind requested.`
  - `Report captured for context replacement.`
- `details`:
  - `report: string` — trim 后的报告文本
  - `rewound: true`

返回的工具结果并非最终的 rewind。`AgentSession` 会等待 `turn_end`，然后异步应用 rewind 副作用。

## Flow
1. Tool registration in `packages/coding-agent/src/tools/index.ts` enforces `checkpoint.enabled` and the top-level/explicit-subagent visibility rules. `RewindTool.createIf()` itself always constructs the tool.
2. 没有活跃检查点时，`execute()` 区分两种状态：
   - 已存在保留的已完成 rewind：`ToolError("Checkpoint already completed; continue from the retained rewind report instead of calling rewind again.")`
   - 不存在已完成的 rewind：`ToolError("No active checkpoint. Create a checkpoint before calling rewind.")`
3. It trims `params.report`; if empty, it throws `ToolError("Report cannot be empty.")`.
4. It returns a `toolResult()` with `details.report` and `details.rewound = true`.
5. On the successful rewind tool result, `AgentSession` extracts the report from `details.report` or the first text content block and stores it in `#pendingRewindReport`.
6. At `turn_end`, `#extractRewindReport()` finds the pending or successful rewind result and calls `#applyRewind()`.
7. `#applyRewind()` first calls `sessionManager.branchWithSummary(checkpointEntryId, report, { startedAt })`, recording a `branch_summary` at the checkpoint branch point. If that entry no longer resolves, it logs a warning and branches from root instead.
8. It appends a hidden persisted `rewind-report` custom message. Its content is rendered from `prompts/system/rewind-report.md`, which tells the next turn that the checkpoint completed, not to call `rewind` again, and includes the report; details contain `{ report, startedAt, rewoundAt }`.
9. It sets `#lastCompletedRewind`, rebuilds the display/LLM session context from the new active branch, and replaces both the turn's active message array and `agent.state.messages`. The exploratory branch and successful rewind tool result are therefore absent from the next provider call.
10. It resets advisor session state while preserving cost, synchronizes todo state from the new branch, and closes provider sessions whose history was rewritten.
11. Finally it clears `#checkpointState` and `#pendingRewindReport`. On later resume or tree navigation, the persisted retained report rehydrates `#lastCompletedRewind`.

## Modes / Variants
- Normal rewind: checkpoint entry exists; session history branches from that exact entry.
- Fallback rewind: checkpoint entry ID is missing from the current session tree; rewind branches from root and logs a warning.
- Deferred turn-end apply: the tool result only requests rewind; branching and context replacement happen after the surrounding assistant turn finishes.
- Resumed checkpoint: an unfinished successful checkpoint tool result on the active persisted branch rehydrates the checkpoint state, allowing rewind after process resume.

## Side Effects
- Session state (transcript, memory, jobs, checkpoints, registries)
  - Rebuilds active conversation history from the checkpoint branch plus the retained summary/report; it does not restore files or process state.
  - Adds a hidden custom message `rewind-report` carrying rendered recovery guidance and the report.
  - Records `#lastCompletedRewind`, clears the active checkpoint and pending report, resets advisors, resynchronizes todo state, and closes provider sessions invalidated by the history rewrite.
  - Repositions the persisted session leaf to the checkpoint branch point and appends new session entries.
- Filesystem
  - Persists the new `branch_summary` and `custom_message` entries into the session `.jsonl` file through normal `SessionManager` append persistence.
  - Session files are named `<ISO-timestamp-with-:-and-.-replaced>_<uuidv7>.jsonl` in the session directory; default directory selection is `~/.omp/agent/sessions/<encoded-cwd>/` when no override is passed.
- User-visible prompts / interactive UI
  - The tool result is visible before turn-end application.
  - The persisted `branch_summary` becomes an LLM-visible `branchSummary` message when context is rebuilt; compaction rendering presents it as a user-role `<summary>` block.
  - The hidden `rewind-report` custom message becomes developer-role retained guidance for the next provider call.
- Background work / cancellation
  - Rewind application is deferred to `turn_end`. There is no separate job object or cancel handle.

## Limits & Caps
- Availability is gated by `checkpoint.enabled`, default `false`.
- Subagents require an explicit requested-tools entry; requesting either checkpoint tool auto-includes its sister.
- A session has at most one active checkpoint; there is no path to name or choose among multiple checkpoints.
- Report text must be non-empty after `trim()`.
- Rewind restores only active conversation/session-tree context; there is no file, artifact, blob, process, or git restore path.
- Persisted report/summary content is subject to the global session persistence cap `MAX_PERSIST_CHARS = 500_000`.

## Errors
- `ToolError("Checkpoint already completed; continue from the retained rewind report instead of calling rewind again.")` — thrown when the active branch already contains the retained completion.
- `ToolError("No active checkpoint. Create a checkpoint before calling rewind.")` — thrown when neither an active checkpoint nor a completed rewind is present.
- `ToolError("Report cannot be empty.")` — thrown when the trimmed report is empty.
- Missing checkpoint entry IDs during apply do not fail the completed tool call; `#applyRewind()` logs `Rewind branch checkpoint missing, falling back to root` and branches from root.

## Notes
- Checkpoint selection is implicit. `rewind` always targets the single `#checkpointState` captured or rehydrated from the last unfinished successful `checkpoint`; there is no checkpoint list, label, or ID parameter.
- Restored state is active conversation/session-tree context:
  - persisted branch reset to `checkpointEntryId` or root fallback
  - branch summary of the abandoned exploratory path
  - retained `rewind-report` custom message
  - rebuilt in-memory messages from that branch
- Not restored:
  - filesystem or git state
  - artifacts under `packages/coding-agent/src/session/artifacts.ts`
  - blob-store payloads under `packages/coding-agent/src/session/blob-store.ts`
  - prompt history rows in `packages/coding-agent/src/session/history-storage.ts`
  - auth or other agent storage in `packages/coding-agent/src/session/agent-storage.ts`
- There is no concurrent-edit reconciliation. Rewind neither merges nor reverts code or session-adjacent external state.
- Rewind is not destructive to persisted session history. `branchWithSummary()` appends a new `branch_summary` entry and moves the leaf; abandoned entries remain in the `.jsonl` log but leave the active branch.
