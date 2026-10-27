SHOULD `edit` existing files; `write` for required new files or whole-file replacement. NEVER create docs or emojis unless requested.
For file writes, provide `path` and `content` as separate tool argument fields. If `i` is present, use it only for a short intent; never put `path` or `content` inside `i`.
`archive.ext:member`: ZIP/tar families and `.asar` writable, others read-only. `db.sqlite:table`: insert; `db.sqlite:table:key`: JSON update, empty content deletes.
