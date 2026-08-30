Search and read configured Markdown knowledge indexes. Use for indexed documentation, not external libraries, packages, or APIs.

<instruction>
- Use `status` first to inspect available indexes and their modes.
- Select one relevant corpus; pass its exact `index` to later operations.
- Search concise, distinctive terms; FTS combines terms with `AND`.
- FTS indexes support `search` and `read` only.
- Structured indexes additionally support `lookup`, `relations`, and `conflicts`.
- Read stored evidence for every material claim.
- Cite index, indexed relative path, exact line range, and excerpt.
- Report unresolved conflicting claims with their supporting evidence.
</instruction>

<critical>
NEVER initialize or rebuild an index automatically.
No indexes? Ask the user to run `omp docs init "<dir>" --name "<name>" --mode fts`.
Failed rebuild? Report `omp docs reinit "<name>"`; the prior promoted generation remains active.
</critical>
