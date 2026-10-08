Full-text search over the indexed Markdown corpus. The index stores the documents themselves, so the result is the content: answer from it, NEVER go read the original files.

<instruction>
- `query` is a search box: type keywords or a whole question (`mbist 仿真 log 的检查项和判据有哪些`). No operators and no syntax — `AND`, `OR`, quotes and `*` are just ordinary characters, and Chinese needs no spacing.
- Results come back ranked the way a search engine ranks: the sections covering most of the query first, then progressively looser matches. The corpus is never filtered down to "all terms", so a sentence returns the best available material instead of nothing.
- The header reports how many sections match in total; a footer reports a cut page, collapsed duplicates, or a legacy hit carried whole beyond the ~20000-character target. Search again with narrower terms when there is more content to retrieve.
- Every section arrives as stored text with index name, file path, line range, heading, document sha256 and sectionId. Cite index + path + lines; the document fingerprint identifies the imported version, while sectionId can change after re-import.
- The corpus is a snapshot taken by `omp docs init`: files changed or added since then are not in it. When results look stale, tell the user to re-import the directory — do not go read the original files.
- Report unresolved conflicting claims with their supporting evidence.
</instruction>

<critical>
NEVER initialize or delete an index automatically.
No indexes? Ask the user to run `omp docs init "<dir>" --name "<name>"`.
</critical>
