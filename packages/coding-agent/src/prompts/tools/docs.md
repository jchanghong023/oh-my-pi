Research persistent indexes built from external Markdown directories.

<instruction>
- Start with `search` for discovery; use `lookup` to resolve a canonical entity and its assertions.
- When multiple indexes exist, choose one relevant index and pass it to every research operation; never blend corpora implicitly.
- Check `status.mode`: FTS indexes support section `search`/`read`; only structured indexes support meaningful `lookup`/`relations`/`conflicts`.
- Use `relations` to traverse dependencies, order, inputs/outputs, versions, tests, and membership.
- Use `read` for stored verbatim evidence. Cite index, relative path, and line range for every material claim.
- Use `conflicts` before reconciling defaults, requirements, relation targets, or version claims. Report unresolved alternatives; NEVER guess.
- Use `status` when an expected corpus is absent. A failed rebuild leaves the previous generation active; report the exact `omp docs reinit <name>` action.
- Ambiguous search hit? Compare canonical lookups and evidence before answering.
</instruction>

<critical>
Stored evidence remains readable after its source directory disappears.
NEVER present an uncited structured assertion as document fact.
No indexes? Tell the user: `omp docs init <dir> --name <name>`.
</critical>
