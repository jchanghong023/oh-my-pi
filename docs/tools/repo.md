# repo

> Read-only search of the current repository's local file-content and Python-symbol index. Manage the index yourself with `/repo`; the agent tool never builds or deletes it.

## Scope and lifecycle

- The root is the canonical Git worktree root, or the canonical session working directory outside Git. Each root has its own SQLite index under the user's agent directory (`repo/<SHA-256-of-root>.db`); worktrees and non-Git directories do not share an index. `/repo` shows the root before you start a build. There is no automatic initial build and no `omp repo` CLI command group.
- Open `/repo` in the interactive TUI: `b` builds a missing index (confirm with `y`), `u` updates an existing index by fully reconciling the tree, `r` rebuilds (confirm with `y`), `d` deletes only the index (confirm with `y`), `c` cancels active indexing, and `Esc` closes the panel. While an operation is active, `Esc` asks whether to cancel and close; during deletion it asks whether to close after deletion. Decline a confirmation with `n` or `Esc`. The panel displays progress, failures, coverage, and the last full check.
- Enumeration follows the usual file-search ignore rules. Symlinks, files over 2 MiB, binary/invalid UTF-8 files and unreadable files are excluded or reported. The index holds a snapshot of file text, paths, categories and Python module/class/function/method locations; it is not live source. Reconciliation re-enumerates and reads the full scope, including untracked files and same-size/same-mtime changes. A failed or cancelled update/rebuild keeps the previous usable generation; deletion does not delete source files.

## Inputs

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `action` | `"status" \| "search" \| "symbol"` | Yes | `status` checks stored coverage without scanning the tree; `search` finds indexed file text; `symbol` finds indexed Python symbol names and qualified names. |
| `query` | `string` | For `search` and `symbol` | Search text or symbol name; nonblank after trimming, at most 500 characters. Omit for `status`. |
| `path` | `string` | No | Exact relative file path, or directory prefix (`src` matches paths under `src/`, not `src2/`); not an arbitrary filename substring. Used for queries, not `status`. |
| `category` | `"source" \| "test" \| "config" \| "other"` | No | Filter by the indexer's conservative file classification, not a claim about file contents. Used for queries. |
| `limit` | `number` | No | Results per page; default 20, clamped to 1–50. Used for queries. |
| `cursor` | `string` | No | Continuation token from the preceding query page. Use the same action, query, path and category. |

For example, call `{"action":"search","query":"Widget","path":"src","category":"source"}`, `{"action":"symbol","query":"Widget.render","limit":20}`, or `{"action":"status"}`. Unexpected input fields are rejected.

## Matching and results

- Text search favors a full identifier/literal match (with word boundaries ranked above a substring), and can recall files via split word tokens when the full phrase is absent. Queries shorter than three Unicode code points use an indexed-text substring fallback. Punctuation and quotes are literal text, not regex operators or a query language. Case matching uses JavaScript Unicode `toLowerCase()` rather than locale-specific rules. Symbol search matches substrings of Python names and qualified names; exact names rank first. A result reports a relative path, category and original line range, plus a bounded text snippet or Python symbol kind/name/qualified name/signature.
- The tool returns one page with coverage and warnings. `Next cursor` signals more results; pagination is tied to the index generation. If a cursor becomes stale after an update, restart from page one. Invalid or mismatched cursors error rather than silently changing pages. Individual fields (including paths, snippets and signatures) can be truncated; `Fields truncated` identifies affected fields, and a truncated path may not work as a locator.
- `status` reports whether an index exists, generation, counts, known pending paths, failures/exclusions, uncertainty, and last full check; it does not inspect all source files. Known-path updates and a full-scope check are different: search/symbol process pending known edits before querying, while `u` re-enumerates and verifies the full tree. Coverage distinguishes `incomplete` from `complete`, and checked from `unchecked`; successful tool edits can update known paths automatically, but external commands and unobserved changes may leave the full scope unchecked until `u` reconciles it. Parse errors retain the file's indexed text while omitting obsolete Python symbols and recording a failure. Missing index, zero hits, incomplete coverage and errors are distinct states; neither a hit nor an absent hit proves the current file contents or exhaustive absence.

Read a known source path directly before editing or relying on its contents. For missing indexes use `read`/`grep` while the user decides whether to build; for exhaustive/current-file conclusions use `grep`. The index provides no dependency graph, call graph or impact analysis.

## Source

- Tool and schema: `packages/coding-agent/src/tools/repo.ts`
- Model-facing guidance: `packages/coding-agent/src/prompts/tools/repo.md`
- Index and panel: `packages/coding-agent/src/repo/service.ts`, `packages/coding-agent/src/modes/components/repo-hub.ts`
