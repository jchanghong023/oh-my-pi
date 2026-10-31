# wiki

> Searches the imported Markdown corpus by relevance (default) or explicit regular expression, returning complete evidence and citations in resumable pages.

## Source
- Entry: `packages/coding-agent/src/tools/wiki.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/wiki.md`
- Key collaborators:
  - `packages/coding-agent/src/docs/service.ts` — host adapter for owner-scoped worker IPC, cancellation, shutdown and logger context
  - `packages/coding-agent/src/docs/engine.ts` and `models.ts` — worker-side optional model request orchestration and shared reciprocal-rank fusion (RRF), alongside host path and lifecycle adapters
  - `crates/pi-natives/src/wiki/` and `crates/pi-wiki/` — native snapshot and index ownership, Markdown ingestion, full-text and grep search, complete rankings, cursors and evidence; existing Rust vector kernels provide numerical computation. Native bindings handle page budgets, evidence rendering and cancellable minimum-duration waiting.
  - Full-text and grep retain their Rust implementation; optional semantic recall and reranking use the existing TypeScript model clients and shared ranking utilities.
  - Index lifecycle: `omp docs init "<dir>" --name <name>` / `omp docs remove <name> --force`

The behavior authority is [Markdown document indexing](../../openspec/specs/wiki-index/spec.md); this page describes its tool surface.
In ordinary unrestricted sessions with `tools.xdev=true`, `wiki` is discoverable at `xd://wiki` instead of occupying a top-level tool schema. Read `xd://wiki` for its documentation and schema, then write the JSON arguments to `xd://wiki` to execute. Explicit tool lists keep the native top-level tool; `tools.xdev=false` also keeps it top-level.

Markdown ingestion and legacy searchable-text recovery use a faithful Rust port of the existing shared parser semantics, not a second parsing contract. Schema 11 repairs quoted-fence search projections from stored Markdown, including existing schema-10 indexes, without source files or a manual rebuild. Stored text, provenance, section identities and table layout are preserved; snapshot-bound ranking and cursor validation still apply. DB-only queries, the ≥500ms successful outward duration and error behavior remain unchanged.

New imports preserve code-fence context inside lists, including nested lists and lists within blockquotes, across section and overlapping long-line boundaries. Existing indexes with incorrect section boundaries are not automatically re-sliced; use the explicit remove → init lifecycle above to re-import them. Unicode-equivalent search spellings retain consistent complete-name ranking across cache reuse, eviction and reopening without changing cursor identity or the caller's displayed spelling.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | `string` | Yes | Keywords or a whole question in default search mode; a regular expression in explicit grep mode. |
| `mode` | `"search" \| "grep"` | No | Defaults to `"search"`; regex-looking input never selects grep automatically. |
| `case` | `boolean` | No | Grep only: defaults to `true` (case-sensitive); `false` ignores case. Has no effect in search mode. |
| `path` | `string` | No | Case-sensitive indexed relative path: exact file, or a directory and descendants when ending in `/`. |
| `cursor` | `string` | No | Opaque continuation returned by the previous page; reuse unchanged with the same effective query, mode, grep case and path. Omit it to start a new search. |

Extra keys are ignored by execution's lenient argument validation; recognized fields must have valid values. Missing, non-string, empty or whitespace-only `query` fails with an error naming the received keys and showing a usage example. A supplied cursor must be a nonempty string.

In default search, queries are trimmed; a query longer than 500 characters is truncated with an ellipsis before search and echo. Continuation JSON carries that effective query. Search has no Boolean, quote or wildcard syntax: `AND`/`OR`, quotes and `*` are plain characters.

In grep, leading and trailing expression spaces are preserved exactly. Empty or whitespace-only expressions fail; expressions longer than 500 UTF-16 units fail rather than being truncated. The same rules apply to the tool and core API.

Path scope is literal and applies before full-text, semantic, grep and reranking candidate limits. It covers matching paths across imported indexes, uses stored paths only and never accesses source files. Absolute paths and paths escaping the index root are invalid.

Examples:

```json
{"query":"MBIST 仿真日志"}
{"query":"^## .*MBIST","mode":"grep","case":false}
{"query":"\\bstd::vector\\b","mode":"grep"}
```

## Default Search: Analysis & Ranking
- Latin words and digits match as whole words (mixed CJK+Latin like `MBIST是什么` keeps the Latin run whole); CJK runs are segmented into adjacent bigrams, with function words dropped whole so no nonexistent combinations are produced.
- Full-text query terms provide union recall, not an all-token filter. Technical-topic coverage, continuous phrases, substantive evidence and the section's own title determine full-text relevance; generic wording or simply containing every token does not outrank stronger technical evidence.
- Queries longer than 32 tokens are evenly downsampled, keeping head and tail.
- Name-shaped queries such as `mbist_check.rpt`, `std::vector`, `--flag`, `foo_bar`, `E123`, `ERR-123`, `C++` and paths preserve punctuation and match case-insensitively at complete-name boundaries. Standalone non-Han identifiers/commands such as `hisms` or `scan` also express name intent; ordinary multiword text such as `git status` stays a phrase/natural-language query. Partial identifiers, namespace fragments, extensions and scattered tokens are related evidence, not complete-name hits.
- All `match=exact-name` hits precede `match=related` hits. If a recognized name has no complete hit, the result explicitly says `未找到完整名称命中`; related results may still follow.
- The full-text branch ranks the entire matching set, with stored-text name recall supplementing FTS tokenization. Semantic candidate and rerank windows cannot make later full-text evidence unreachable. BM25 breaks full-text relevance ties.
- With several indexes configured, the tool searches all of them; the `/wiki` panel searches its selected index.
- With a configured, available Embedding model and compatible vectors prepared for the selected corpus, default search automatically combines full-text and semantic candidates using RRF. Invalid query vectors cause full-text fallback; incompatible stored vector generations are excluded individually while other valid indexes can still contribute semantic candidates.
- An independently configured, available Reranker can reorder a bounded candidate window after either full-text or hybrid ranking. It only reorders within the existing match category; neither it nor fusion changes evidence, match categories or complete-name priority.
- All full-text matches remain pageable; semantic recall is limited to this search's candidate set and does not enumerate every potentially related section. Optional model failures preserve the full-text or pre-rerank basis; user cancellation ends the call instead of falling back.
- Embedding reuses `mnemopi.embeddingModel`, `mnemopi.embeddingApiUrl` and `mnemopi.embeddingApiKey` and their existing environment/company configuration rules; it does not require enabling the memory system. `mnemopi.noEmbeddings` and `MNEMOPI_NO_EMBEDDINGS` disable the embedding path under the existing configuration precedence, without disabling reranking. Reranking is separately optional via `wiki.reranker.model`, `wiki.reranker.baseUrl` and `wiki.reranker.apiKey`. No model is downloaded automatically, and an explicitly different endpoint does not receive a company-only token.
- `init` prepares optional vectors within the hidden import before publication. A complete full-text import remains usable if vector preparation fails; cancellation or full-text failure does not publish a partial index. Existing full-text-only indexes continue to work; to prepare vectors for one, explicitly remove and re-import it with Embedding available. Queries never build or backfill corpus vectors.

## Explicit Grep
- Grep does not resolve or call Embedding or Reranker models.
- `mode:"grep"` scans the selected imported corpus's database-stored original raw Markdown, not normalized searchable text, FTS candidates or source files. There is no filesystem grep or filesystem grep's 4 MiB file cap.
- Expressions compile with Rust regex first, then PCRE2 when Rust does not support the expression. If neither accepts it, the call fails with an invalid-regex error; there is no escape repair or literal fallback.
- Matching is per original line. Stored adjacent or overlapping slices of one document are reconstructed and deduplicated so artificial section boundaries do not become `^`/`$`, and a single-line match spanning slices is not lost. Every stored section intersecting the match's byte range is reachable.
- There is no cross-line mode, Boolean query language or exact occurrence count. `AND`/`OR`/`NOT` are not Boolean operators; regex groups, `|` and boundaries have the engines' regex meanings.
- Only actual matching sections are returned with `match=regex`, in deterministic index/document/section-ordinal source order. Grep performs no relevance ranking or technical-name classification: structured hits use `matchKind="regex"`, no `technicalName`, and `exactNameMatches=0`.
- The scan covers the full selected corpus; candidate windows, stored slice boundaries, section overlap and page budgets do not limit recall. Total matches count matching sections, not regex occurrences.

## Outputs
- `content[0].text` contains one Markdown page; calls do not stream updates.
- Each hit renders `[n] <relative path>:<start>-<end> · <heading path> · index=<name> · sha256=<document fingerprint> · sectionId=<id> · match=<exact-name|related|regex>` followed by its complete indexed text. Cite index + path + lines; the fingerprint identifies the imported document version, while section IDs may be reused after re-import.
- The page identifies the searched imported corpus. Its footer reports the result-set section count and the number carried on this page, and ends with either an explicit next-call JSON object for more results or result-set exhaustion. For hybrid search the set is all full-text matches plus this search's semantic candidates, deduplicated; exhaustion does not mean all semantically related sections have been found.
- Each page reports the actual full-text, hybrid or grep retrieval and whether reranking was applied; an unrecoverable legacy state is marked unknown. Cached pages and continuations retain the original result's status.
- Normal pages target ~4,000 characters including headers, locators, bodies and continuation information, with at most 10 sections. Every page carries its first section whole even if it exceeds the target, with an oversized-section notice.
- When results remain, the footer lists up to 10 unexpanded source hints (index, path, line range and heading) in result order, plus counts of remaining, previewed and unlisted sections. Hints are not full evidence and do not advance the cursor; retrieve the full section before citing it. Hint locators may be truncated, and hints may be omitted when the page budget is exhausted, including by an oversized first section.
- Successive pages follow one fixed, contiguous order: the final ranking in search, source order in grep. The first section that does not fit is deferred, not skipped; every section in the actual result set and its source locator is reachable exactly once when following valid cursors to exhaustion.
- Verbatim duplicate text longer than 200 characters may point to a complete hit on the same page; every duplicate retains its own full source locator and match label. A new page supplies its own complete text, never a pointer into an earlier page. The full-text baseline ranks distinct evidence before repeated sources within each name-match class; complete-name evidence precedes all related hits, including after fusion or reranking. Grep keeps source order.
- Heading-only sections retain their full indexed Markdown after `(heading only)`. New imports skip known empty converter labels `Cell`/`Row`, not one-word technical headings; legacy structural labels remain reachable and are marked `(structural label)`.
- Zero matches is a normal successful result: it reports `0 matching section(s)` in the searched imported corpus and exhaustion, not that the information does not exist elsewhere.

## Flow
1. Lazily retains an owner-scoped `DocsService` using the agent directory and session cwd; creating the service does not open the database. Session disposal or a profile/database change releases its owned resources. Missing indexes fail with the `omp docs init` usage hint.
2. Searches stored database text asynchronously, without blocking interactive input or rendering, and forwards the caller's cancellation signal through database scanning and page completion. An unchanged query reuses its retained complete result set, keyed by effective query (the exact expression in grep), mode, effective grep case, scope and validated database snapshot; bounded retention evicts whole queries, not evidence tails. Retention does not use a time TTL in place of real database-version validation. Import/remove, SQL or FTS changes, external commits, database replacement and service reopen trigger snapshot revalidation rather than stale or mixed evidence reuse. Builds the page under the character target and 10-section ceiling; version, matches, counts, text and provenance come from the same validated read snapshot.
3. Returns evidence and either exhaustion or continuation JSON. If more results remain, refine the query or path for the task instead of blindly repeating keywords; omit the cursor for a new query. To traverse the existing set, follow the continuation JSON with unchanged query, mode, effective case and path.
4. The cursor binds the effective query, mode, effective grep case, index scope/path and logical database version. Changing grep mode or case cannot resume an existing cursor; search ignores `case` and preserves valid old full-text cursor identity. Full-text and grep cursors survive cache eviction and service close/reopen when the snapshot is unchanged. Hybrid or reranked continuation must reuse or legally reproduce its original ranking context; if that context is lost, restart the query without the cursor. Malformed, mismatched or stale cursors fail rather than mixing rankings or index generations. Continuations revalidate the snapshot; pages do not keep a read transaction open between calls.
5. Evidence and citations come from the database only: no source-file access, source freshness checks or automatic synchronization. Default search may call configured optional models; grep never does.
6. Every successful outward search in either mode, including continuation and zero matches, takes **at least 500ms (≥500ms, not a 500ms upper bound)**. Any remaining time after query and page-budget work is an abortable asynchronous wait, without a held database transaction. Diagnostic timing distinguishes execution work, minimum-duration wait and total outward time; errors and cancellation are not padded.

## Side Effects
- Does not import or remove indexes, modify source documents, or change session state (`approval: "read"`). Opening the local database may create its storage or migrate older searchable text from stored Markdown; queries also write bounded diagnostic logs.

## Limits & Caps
- Normal rendered page target: ~4,000 characters, including continuation information; sections per tool call: 10. These page limits do not cap the total matching set.
- Query cap: default search truncates queries longer than 500 characters with an ellipsis, then searches and echoes the effective query; grep rejects expressions longer than 500 UTF-16 units and preserves all expression spaces.
- Indexed sections are capped at 18,000 characters at ingestion. Each page's first oversized section still returns whole; later nonfitting sections become the next page's first section.
- Long lines use a 500-character overlap without splitting Unicode scalars; overlapping sections retain original byte and line ranges. Code punctuation remains searchable in code spans and fenced blocks, including blocks split across sections.
- Query connections request memory-mapped reads of up to 500 MiB per database file, subject to SQLite/platform limits. Processes reading the same file can reuse operating-system file pages without enlarging their private SQLite page caches. Ranking/parsed objects remain owner-local; the mapping range is not a process or machine-wide RAM limit, and shutdown releases the mapping handles.
- Default search has no Boolean query operators or field restrictions. The optional `path` limits the stored corpus; explicit grep adds regex syntax, not Boolean or cross-line syntax.

## Errors
- Missing or invalid `query`: `wiki requires a query. Received: <keys>. Example: {"query":"MBIST"}`.
- Non-string or empty supplied cursor: `wiki cursor must be a nonempty string returned by the previous page.`
- Invalid supplied `mode` or non-Boolean supplied `case`: argument error; unrelated extra keys remain ignored.
- Invalid grep expression or more than 500 UTF-16 units: error, never a literal fallback, truncated expression or zero-match result.
- Malformed cursor: `Invalid documentation search cursor`.
- Different effective query, mode, effective grep case or index scope/path: cursor mismatch error (`Documentation search cursor does not match query or index`).
- Changed logical database version: `Stale documentation search cursor: indexed snapshot has changed`.
- No indexes configured: `No document indexes. Run: omp docs init "<dir>" --name <name>`.
- Database failures and other operational errors remain errors. Zero matches, heading-only hits and structural labels are not errors.
- Cancellation aborts the pending call promptly; it is not a zero-match result and is not automatically retried. A cancelled queued call does not cancel another active call.

## Notes
- The corpus is the Markdown snapshot imported by `omp docs init`; later source edits/additions are not included. Imports require valid UTF-8; BOM and CRLF retain correct provenance. If a newer snapshot is needed, remove then re-import manually; queries never inspect source freshness or initialize/delete indexes automatically.
- Older searchable text is automatically regenerated from stored Markdown to repair code punctuation, without reading source files or changing the database tables. Content discarded during an older import (such as a technical heading), and long lines partitioned without overlap, require remove + init to use the new ingestion rules.
- The only lifecycle commands are `omp docs init "<dir>" --name <name>` and `omp docs remove <name> --force`; there are no update/list/status/rebuild commands. The `/wiki` panel lists indexes and can initiate those two actions. It searches only the selected index: `/` starts default relevance search and `g` opens `Grep (regex)` input. RPC wiki dialogs expose the separate `Grep document indexes` action rather than inferring regex from the query. These interactive grep actions preserve the raw expression and use `mode:"grep"`, `case:true` on every page; use the tool/API's `case:false` for case-insensitive grep. In results, `n` requests the next page and `b` returns from a section to the current result page. Loading, search/grep/continuation, deletion and import show their current operation state; `c` or `Esc` directly cancels the pending operation without waiting for a close confirmation, and closing the panel also cancels it. A failed or cancelled continuation retains the prior result page and selected stored evidence; late replies cannot replace newer results.
- SDK owners must await `DocsService.close()` or `WikiTool.dispose()` before removing the database or its directory. Shutdown cancels pending calls immediately; its promise resolves after the owned worker exits and releases its handles.
- Legacy heading paths may be truncated to bound locators, never bodies. The `/wiki` panel opens the selected hit's stored search-result snapshot rather than resolving its `sectionId` in another index generation.
