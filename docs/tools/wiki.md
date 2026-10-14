# wiki

> Searches the imported Markdown corpus and returns complete evidence and citations in ranked, resumable pages.

## Source
- Entry: `packages/coding-agent/src/tools/wiki.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/wiki.md`
- Key collaborators:
  - `packages/coding-agent/src/docs/service.ts` — asynchronous, cancellable index discovery and search
  - `packages/coding-agent/src/docs/engine.ts` — shared import/storage owner and mandatory native query adapter
  - `crates/pi-natives/src/wiki/` — Rust query analysis, default Markdown lexer projection, SQLite FTS5/BM25, complete ranking/cache, snapshot-compatible cursors and page hydration; async queries use the same native blocking-task mechanism as `grep`
  - `packages/coding-agent/src/docs/markdown.ts` — shared ingestion parser and heading truncation; the native query lexer preserves its default semantics
  - Index lifecycle: `omp docs init "<dir>" --name <name>` / `omp docs remove <name> --force`

The behavior authority is [Markdown document indexing](../../docs-zh-CN/requirements/fork.md#markdown-文档索引); this page describes its tool surface.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | `string` | Yes | Keywords or a whole question; results are ranked by relevance. There is no query syntax to learn: `AND`/`OR`, quotes, and wildcards are treated as plain characters. |
| `cursor` | `string` | No | Opaque continuation returned by the previous page; reuse it unchanged with the same `query`. Omit it to start a new search. |

Extra keys are ignored by execution's lenient argument validation; the advertised schema contains only `query` and optional `cursor`. Missing, non-string, empty or whitespace-only `query` fails with an error naming the received keys and showing a usage example. A supplied cursor must be a nonempty string. Queries are trimmed; a query longer than 500 characters is truncated with an ellipsis before search and echo. Continuation JSON carries that effective query.

## Analysis & Ranking
- Latin words and digits match as whole words (mixed CJK+Latin like `MBIST是什么` keeps the Latin run whole); CJK runs are segmented into adjacent bigrams, with function words dropped whole so no nonexistent combinations are produced.
- Query terms provide union recall, not an all-token filter. Technical-topic coverage, continuous phrases, substantive evidence and the section's own title determine relevance; generic wording or simply containing every token does not outrank stronger technical evidence.
- Queries longer than 32 tokens are evenly downsampled, keeping head and tail.
- Name-shaped queries such as `mbist_check.rpt`, `std::vector`, `--flag`, `foo_bar`, `E123`, `ERR-123`, `C++` and paths preserve punctuation and match case-insensitively at complete-name boundaries. Standalone non-Han identifiers/commands such as `hisms` or `scan` also express name intent; ordinary multiword text such as `git status` stays a phrase/natural-language query. Partial identifiers, namespace fragments, extensions and scattered tokens are related evidence, not complete-name hits.
- All `match=exact-name` hits precede `match=related` hits. If a recognized name has no complete hit, the result explicitly says `未找到完整名称命中`; related results may still follow.
- Ranking examines the entire matching set, with stored-text name recall supplementing FTS tokenization. There is no bounded candidate window or truncated scoring body that can make later matching evidence unreachable. BM25 breaks relevance ties.
- With several indexes configured, the tool searches all of them; the `/wiki` panel searches its selected index.

## Outputs
- `content[0].text` contains one Markdown page; calls do not stream updates.
- Each hit renders `[n] <relative path>:<start>-<end> · <heading path> · index=<name> · sha256=<document fingerprint> · sectionId=<id> · match=<exact-name|related>` followed by its complete indexed text. Cite index + path + lines; the fingerprint identifies the imported document version, while section IDs may be reused after re-import.
- The page identifies the searched imported corpus. Its footer reports total matching sections, the number carried on this page, name-match status when applicable, and either an explicit next-call JSON object or `All matching results exhausted in the searched imported corpus.`
- Normal pages target ~8,000 characters including headers, locators, bodies and continuation information, with at most 200 sections. Every page carries its first section whole even if it exceeds the target, with an oversized-section notice.
- Successive pages follow one deterministic, contiguous ranked order. The first section that does not fit is deferred, not skipped; every matching section and source locator is reachable exactly once when following cursors to exhaustion.
- Verbatim duplicate text longer than 200 characters may point to a complete hit on the same page; every duplicate retains its own full source locator and match label. A new page supplies its own complete text, never a pointer into an earlier page. Within each name-match class, distinct evidence precedes repeated sources; complete-name evidence still precedes all related hits.
- Heading-only sections retain their full indexed Markdown after `(heading only)`. New imports skip known empty converter labels `Cell`/`Row`, not one-word technical headings; legacy structural labels remain reachable and are marked `(structural label)`.
- Zero matches is a normal successful result: it reports `0 matching section(s)` in the searched imported corpus and exhaustion, not that the information does not exist elsewhere.

## Flow
1. Lazily retains an owner-scoped `DocsService` using the agent directory and session cwd; creating the service does not open the database. Session disposal or a profile/database change releases its owned resources. Missing indexes fail with the `omp docs init` usage hint.
2. Searches stored database text asynchronously, without blocking interactive input or rendering, and forwards the caller's cancellation signal. An unchanged query reuses its retained complete ranked set; bounded retention evicts whole queries, not evidence tails. Builds the page under the character target and 200-section ceiling; version, ranked matches, counts, text and provenance come from the same validated read snapshot.
3. Returns evidence and either exhaustion or continuation JSON. For example, start with `{"query":"MBIST 仿真日志"}`; follow the exact next-call JSON in the footer with unchanged query and the emitted cursor. Do not narrow or rewrite a query to retrieve its remaining pages.
4. The cursor binds the effective query, index scope and logical database version. It survives service close/reopen; malformed, mismatched or stale cursors fail rather than silently mixing index generations or returning zero matches. Restart with the original query and no cursor after an index change.
5. Query, continuation and citations use the database only: no source-file access, source freshness checks, automatic synchronization, models or vectors.
6. Every successful outward search, including continuation and zero matches, takes **at least 500ms (≥500ms, not a 500ms upper bound)**. Any remaining time after query and page-budget work is an abortable asynchronous wait, without a held database transaction. Diagnostic timing distinguishes execution work, minimum-duration wait and total outward time; errors and cancellation are not padded.

## Side Effects
- Does not import or remove indexes, modify source documents, or change session state (`approval: "read"`). Opening the local database may create its storage or migrate older searchable text from stored Markdown; queries also write bounded diagnostic logs.

## Limits & Caps
- Normal rendered page target: ~8,000 characters, including continuation information; sections per tool call: 200. These page limits do not cap the total matching set.
- Query cap: 500 characters — a longer query is truncated with an ellipsis, then searched and echoed; continuation uses the echoed effective query.
- Indexed sections are capped at 18,000 characters at ingestion. Each page's first oversized section still returns whole; later nonfitting sections become the next page's first section.
- Long lines use a 500-character overlap without splitting Unicode scalars; overlapping sections retain original byte and line ranges. Code punctuation remains searchable in code spans and fenced blocks, including blocks split across sections.
- No query operators, filters or field restrictions. The only optional input is the returned continuation cursor.

## Errors
- Missing or invalid `query`: `wiki requires a query. Received: <keys>. Example: {"query":"MBIST"}`.
- Non-string or empty supplied cursor: `wiki cursor must be a nonempty string returned by the previous page.`
- Malformed cursor: `Invalid documentation search cursor`.
- Different effective query or index scope: `Documentation search cursor does not match query or index`.
- Changed logical database version: `Stale documentation search cursor: indexed snapshot has changed`.
- No indexes configured: `No document indexes. Run: omp docs init "<dir>" --name <name>`.
- Database failures and other operational errors remain errors. Zero matches, heading-only hits and structural labels are not errors.
- Cancellation aborts the pending call promptly; it is not a zero-match result and is not automatically retried. A cancelled queued call does not cancel another active call.

## Notes
- The corpus is the Markdown snapshot imported by `omp docs init`; later source edits/additions are not included. Imports require valid UTF-8; BOM and CRLF retain correct provenance. If a newer snapshot is needed, remove then re-import manually; queries never inspect source freshness or initialize/delete indexes automatically.
- Older searchable text is automatically regenerated from stored Markdown to repair code punctuation, without reading source files or changing the database tables. Content discarded during an older import (such as a technical heading), and long lines partitioned without overlap, require remove + init to use the new ingestion rules.
- The only lifecycle commands are `omp docs init "<dir>" --name <name>` and `omp docs remove <name> --force`; there are no update/list/status/rebuild commands. The `/wiki` panel lists indexes and can initiate those two actions. In search results, `n` requests the next page and `b` returns from a section to the current result page. Loading, search/continuation, deletion and import show their current operation state; `c` or `Esc` directly cancels the pending operation without waiting for a close confirmation, and closing the panel also cancels it. A failed or cancelled continuation retains the prior result page and selected stored evidence; late replies cannot replace newer results.
- SDK owners must await `DocsService.close()` or `WikiTool.dispose()` before removing the database or its directory. Shutdown cancels pending calls immediately; its promise resolves after the owned worker exits and releases its handles.
- Legacy heading paths may be truncated to bound locators, never bodies. The `/wiki` panel opens the selected hit's stored search-result snapshot rather than resolving its `sectionId` in another index generation.
