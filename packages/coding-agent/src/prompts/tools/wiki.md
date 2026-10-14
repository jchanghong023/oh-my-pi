Search the indexed Markdown corpus by relevance (default) or explicit regular expression. The index stores the documents themselves, so the result is the content: answer from it, NEVER go read the original files.

<instruction>
- Default `mode:"search"`: `query` is a search box for keywords or a whole question (`mbist 仿真 log 的检查项和判据有哪些`). No operators or query syntax in this mode — `AND`, `OR`, quotes and `*` are ordinary characters; Chinese needs no spacing. Regex-looking input NEVER enables grep automatically; `case` has no effect in search mode.
- Search results rank the strongest evidence first, then related sections. Technical names retain punctuation: `mbist_check.rpt`, `std::vector`, `--flag`, `C++`. `match=exact-name` identifies complete-name evidence; `match=related` does not. `未找到完整名称命中` means no exact-name hit in this imported corpus.
- Explicit `mode:"grep"`: `query` is a regular expression over each original line of database-stored raw Markdown; `case` defaults to `true` (case-sensitive), `false` ignores case. Example: `{"query":"^## .*MBIST","mode":"grep","case":false}`.
- Grep uses Rust regex, then PCRE2 for unsupported expressions; invalid expressions error, NEVER escape-repair or fall back to literal matching. Original line boundaries survive stored slices and overlaps; artificial section edges are not `^`/`$`. No cross-line matching, Boolean query language or exact occurrence counts.
- Grep preserves leading/trailing expression spaces. Blank expressions error; more than 500 UTF-16 units errors, NEVER truncates. Default search still trims and truncates long queries to its echoed effective query.
- Grep returns only `match=regex` sections in fixed index/document/section source order, without related or complete-name classification. Every stored section intersecting a match remains reachable; section totals are not occurrence counts.
- The footer reports total matches and either exhaustion or continuation JSON. More results? You MUST call `wiki` with the emitted cursor and unchanged query, mode and effective case until enough evidence is retrieved; NEVER narrow or rewrite the query to fetch remaining sections. Grep continuation includes `query`, `mode:"grep"`, `case` and `cursor`. Normal pages target ~8000 characters; the first oversized section remains complete.
- Every section arrives as stored text with index name, file path, line range, heading, document sha256 and sectionId. Cite index + path + lines; the document fingerprint identifies the imported version, while sectionId can change after re-import.
- Duplicate text MAY become a pointer only to a full hit on the same page; every source locator remains citable. A new page supplies its own complete text.
- `0 matches` is successful search of the imported corpus in either mode, not proof the information does not exist elsewhere. Invalid queries/cursors, missing indexes and database failures remain errors; cancellation is not zero matches.
- The corpus is a snapshot taken by `omp docs init`: files changed or added since then are not in it. When results look stale, tell the user to re-import the directory — do not go read the original files.
- Report unresolved conflicting claims with their supporting evidence.
</instruction>

<critical>
NEVER initialize or delete an index automatically.
No indexes? Ask the user to run `omp docs init "<dir>" --name "<name>"`.
</critical>
