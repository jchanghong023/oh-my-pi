Full-text search over the indexed Markdown corpus. The index stores the documents themselves, so the result is the content: answer from it, NEVER go read the original files.

<instruction>
- `query` is a search box: type keywords or a whole question (`mbist 仿真 log 的检查项和判据有哪些`). No operators and no syntax — `AND`, `OR`, quotes and `*` are just ordinary characters, and Chinese needs no spacing.
- Results come back ranked the way a search engine ranks: the sections covering most of the query first, then progressively looser matches. The corpus is never filtered down to "all terms", so a sentence returns the best available material instead of nothing.
- The header reports how many sections match in total; a footer means this page was cut (about 20000 characters of text per call). Search again with narrower terms when you need the rest, or when the tail looks off-topic.
- Every section arrives as stored text with file path, line range, heading and sectionId — cite those.
- Report unresolved conflicting claims with their supporting evidence.
</instruction>

<critical>
NEVER initialize or delete an index automatically.
No indexes? Ask the user to run `omp docs init "<dir>" --name "<name>"`.
</critical>
