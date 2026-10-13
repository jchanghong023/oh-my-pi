Full-text search over the indexed Markdown corpus. The index stores the documents themselves, so the result is the content: answer from it, NEVER go read the original files.

<instruction>
- `query` is a search box: type keywords or a whole question (`mbist 仿真 log 的检查项和判据有哪些`). No operators and no syntax — `AND`, `OR`, quotes and `*` are just ordinary characters, and Chinese needs no spacing.
- Results rank the strongest evidence first, then related sections. Technical names retain punctuation: `mbist_check.rpt`, `std::vector`, `--flag`, `C++`. `match=exact-name` identifies complete-name evidence; `match=related` does not. `未找到完整名称命中` means no exact-name hit in this imported corpus.
- The footer reports total matches and either exhaustion or continuation JSON. More results? You MUST call `wiki` with that cursor and the unchanged query until enough evidence is retrieved; NEVER narrow or rewrite the query to fetch the remaining sections. Normal pages target ~8000 characters; the first oversized section remains complete.
- Every section arrives as stored text with index name, file path, line range, heading, document sha256 and sectionId. Cite index + path + lines; the document fingerprint identifies the imported version, while sectionId can change after re-import.
- Duplicate text MAY become a pointer only to a full hit on the same page; every source locator remains citable. A new page supplies its own complete text.
- `0 matches` is successful search of the imported corpus, not proof the information does not exist elsewhere.
- The corpus is a snapshot taken by `omp docs init`: files changed or added since then are not in it. When results look stale, tell the user to re-import the directory — do not go read the original files.
- Report unresolved conflicting claims with their supporting evidence.
</instruction>

<critical>
NEVER initialize or delete an index automatically.
No indexes? Ask the user to run `omp docs init "<dir>" --name "<name>"`.
</critical>
