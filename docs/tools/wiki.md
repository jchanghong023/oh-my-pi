# wiki

Search persistent indexes built from Markdown directories. `wiki` is an essential read-only built-in tool: unrestricted sessions receive it by default, and non-restricted explicit tool sets that include `read` also receive `wiki`. Restricted sessions retain their exact host-provided allowlist and can use `wiki` only when it is explicitly named. `/docs` opens the index-management hub; there is no dedicated document subagent, `/doc` research shortcut, or prose routing trigger.

Start with `status`, select one relevant index, and pass its exact name to later operations. Use `search` and `read` for FTS indexes; structured indexes additionally support `lookup`, `relations`, and `conflicts`. Material claims should cite the index, relative source path, exact line range, and excerpt. The tool never initializes or rebuilds indexes; when none exist, run `omp docs init "<dir>" --name "<name>" --mode fts`.
