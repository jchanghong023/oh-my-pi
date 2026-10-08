Search the current repository's local index for text or Python symbols; `status` reports coverage without scanning files.

<instruction>
- Pass `query` to search indexed text: `{"query":"Widget"}`. Optionally narrow by file or directory with `path`. Use `{"action":"symbol","query":"Widget.render"}` for Python definitions, or `{"action":"status"}` for index details.
- Each page contains up to 20 hits. Pass the returned cursor with the SAME action, query, and path to continue. Restart from page one when rejected as stale after an index update.
- Results identify indexed relative paths and original line ranges. MUST `read` the current file before editing or relying on an indexed excerpt; known paths SHOULD be read directly, not searched again.
- `status`/coverage warnings distinguish known pending paths, failures, and unchecked external changes. An index hit is a lead, not proof of current content or complete scope. For exhaustive search, use `grep` over current files.
- Missing index? Open `/repo` to build one only at the user's request; use `read`/`grep` meanwhile. No hits? Refine the query or use `grep`; missing index and no hits are different.
- This index has no graph: NEVER infer callers, dependencies, impact, or absence of references from search/symbol results.
</instruction>

<critical>
NEVER initialize, rebuild, reconcile, or delete an index with this read-only tool.
MUST use current-file reads for edits and `grep` for exhaustive conclusions.
</critical>
