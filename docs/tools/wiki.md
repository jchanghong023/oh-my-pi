# wiki

Search persistent indexes built from Markdown directories. `wiki` is an essential read-only built-in tool: unrestricted sessions receive it by default, and non-restricted explicit tool sets that include `read` also receive `wiki`. Restricted sessions retain their exact host-provided allowlist and can use `wiki` only when it is explicitly named. `/wiki` opens the index-management hub; there is no dedicated document subagent, `/doc` research shortcut, or prose routing trigger.

Start with `status`, select one relevant index, and pass its exact name to later operations. `search` returns matching section excerpts; `read` takes a `sectionId` and returns the complete stored Markdown section. Material claims should cite the index, relative source path, exact line range, and excerpt. Imported text is self-contained: queries do not need the original Markdown files. Images, attachments, and linked resources are not imported.

Indexing uses SQLite FTS5; search reranks a bounded BM25 candidate window to prefer continuous Chinese text, complete technical names, and matching section titles. Original AND matching remains the fallback; these preferences do not filter out loose matches. It needs no model, credentials, vectors, or extraction schema, and existing databases need no rebuild. The only tool operations are `status`, `search`, and `read`.

Manage indexes through `/wiki` or `omp docs init/list/status/remove`. Import once with `omp docs init "<dir>" --name "<name>"`; removal requires `omp docs remove "<name>" --force`. There is no rebuild/update operation. The tool itself cannot import or delete indexes.
