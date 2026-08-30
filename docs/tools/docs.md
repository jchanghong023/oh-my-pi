# docs

Research persistent indexes built from external Markdown directories. This tool is available only to the bundled `doc-researcher`; main and default agents do not receive it. Users invoke research explicitly with `/doc <question>` or an affirmative prose request containing `用`、`使用`、`调用` or `让` + `文档子代理`; `/docs` opens the index-management hub. The prose trigger adds a turn-scoped routing directive without exposing `doc-researcher` in the permanent agent catalog. `/doc` reports unavailable when the active session cannot delegate through `task`.

Use `search` to discover sections/entities, `lookup` for canonical assertions, `relations` for graph traversal, `read` for verbatim stored evidence, `conflicts` for contradictory claims, and `status` for index health. Material claims should cite the index, relative source path, and line range returned by the tool.
