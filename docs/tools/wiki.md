# wiki

> Searches the indexed Markdown corpus and returns the matching section text — ranked, deduplicated, and budgeted.

## Source
- Entry: `packages/coding-agent/src/tools/wiki.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/wiki.md`
- Key collaborators:
  - `packages/coding-agent/src/docs/service.ts` — index discovery and search
  - `packages/coding-agent/src/docs/markdown.ts` — section shape classification and heading truncation
  - Index lifecycle: `omp docs init "<dir>" --name <name>` / `omp docs remove <name> --force`

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | `string` | Yes | Keywords or a whole question; results are ranked by relevance. There is no query syntax to learn: `AND`/`OR`, quotes, and wildcards are treated as plain characters. |

Extra keys are ignored rather than rejected (lenient argument validation); a missing or empty `query` fails with an error naming the keys that actually arrived plus a usage example. A `query` longer than 500 characters is truncated (with an ellipsis) before it is searched and echoed, so the echo can never outgrow the page it asks for.

## Analysis & Ranking
- Latin words and digits match as whole words (mixed CJK+Latin like `MBIST是什么` keeps the Latin run whole); CJK runs are segmented into adjacent bigrams, with function words dropped whole so no nonexistent combinations are produced.
- Multiple query terms combine as a union, not a filter — the more terms a section matches, the higher it ranks.
- Queries longer than 32 tokens are evenly downsampled, keeping head and tail, so trailing technical points of a requirement sentence survive.
- Ranking precedence: the query appearing literally in the heading → literally in the body (`std::vector` beats scattered `vector std`) → all tokens present → BM25 within the same tier.
- With several indexes configured, one query covers all of them.

## Outputs
- Single-shot result; `content[0].text` is one page of Markdown built from the matched sections.
- Each hit renders a header line `[n] <relative path>:<start>-<end> · <heading path> · sectionId=<id>` followed by the section's full text.
- The page opens with the total hit count and closes with a footer reporting how many sections were skipped for size and how many duplicate hits were collapsed.
- A page carries at most ~20,000 characters (≈10–12k tokens on this corpus) and 200 sections; the best hit is always carried in full even when it alone exceeds the budget.
- Cross-document verbatim duplicate sections (longer than ~200 characters) appear once; later copies collapse to a pointer line. Structural labels such as `#### Cell` are skipped. Sections whose heading is the content return as "(heading only …)".
- The tool does not stream updates.

## Flow
1. Instantiates `DocsService` from the agent directory and session cwd; if no index exists, fails with the `omp docs init` usage hint instead of searching.
2. Runs the ranked search with the 200-section ceiling; zero matches fail with the advice to use one distinctive term rather than a sentence.
3. Builds the page: classifies each hit's shape, collapses duplicates, charges headers against the same character budget as bodies, and never drops the best hit for size.
4. If every match is a stub, the call still answers with the locating headers instead of failing.

## Side Effects
- None on disk or session state; the tool is read-only (`approval: "read"`).

## Limits & Caps
- Page budget: ~20,000 characters, the opening header line included; sections per call: 200.
- Query cap: 500 characters — a longer query is truncated, then searched and echoed.
- Indexed sections are capped at 18,000 characters at ingestion, so any hit can be returned whole.
- Search semantics are fixed (union of terms, whole-word Latin, CJK bigrams); there are no operators, filters, or field restrictions.

## Errors
- Missing `query`: `wiki requires a query. Received: <keys>. Example: {"query":"MBIST"}`.
- No indexes configured: `No document indexes. Run: omp docs init "<dir>" --name <name>`.
- No section matches: `No section matches "<query>". Use one distinctive term rather than a sentence.`
- Matches carry no body text at all: `Sections matching "<query>" carry no body text.`

## Notes
- The corpus is a snapshot taken by `omp docs init`: source files changed or added since that import are not in it. Re-import the directory to pick them up.
- The corpus is maintained by the two index commands; the `/wiki` panel lists existing indexes and can initiate both actions, while this tool only reads.
- Heading paths are truncated when a legacy index stored a whole document as one heading, so headers cannot spend the page budget they exist to describe.
