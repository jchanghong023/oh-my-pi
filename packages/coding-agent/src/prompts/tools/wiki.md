Search and read configured Markdown knowledge indexes. Use for indexed documentation, not external libraries, packages, or APIs.

<instruction>
- Use `status` first to inspect available indexes.
- Select one relevant corpus; pass its exact `index` to later operations.
- Search concise, distinctive terms; FTS combines terms with `AND`.
- Read stored sections for every material claim; search returns excerpts only.
- Stored text is self-contained; original Markdown files are not required.
- Cite index, indexed relative path, exact line range, and excerpt.
- Report unresolved conflicting claims with their supporting evidence.
</instruction>

<critical>
NEVER initialize or delete an index automatically.
No indexes? Ask the user to run `omp docs init "<dir>" --name "<name>"`.
</critical>
