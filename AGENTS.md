# Development Rules

## Default Context

This repo contains multiple packages, but **`packages/coding-agent/`** is the primary focus. Unless otherwise specified, assume work refers to this package.

**Terminology**: When the user says "agent" or asks "why is agent doing X", they mean the **coding-agent package implementation**, not you (the assistant). The coding-agent is a CLI tool — questions about its behavior refer to code in `packages/coding-agent/`, not your current session.

### Package Structure

| Package                 | Description                                                                             |
| ----------------------- | --------------------------------------------------------------------------------------- |
| `packages/ai`           | Multi-provider LLM client with streaming support                                        |
| `packages/catalog`      | Model catalog: bundled models.json, provider descriptors, model identity/classification |
| `packages/agent`        | Agent runtime with tool calling and state management                                    |
| `packages/coding-agent` | Main CLI application (primary focus)                                                    |
| `packages/tui`          | Terminal UI library with differential rendering                                         |
| `packages/natives`      | Bindings for native text/image/grep operations                                          |
| `packages/stats`        | Local observability dashboard (`omp stats`)                                             |
| `packages/omptype`      | ArkType-compatible schema validation with a lazy JIT runtime                            |
| `packages/utils`        | Shared utilities (logger, streams, temp files)                                          |
| `crates/pi-natives`     | Rust crate for performance-critical text/grep ops                                       |
| `crates/pi-knowledge`   | Independent Rust Knowledge indexing core; `pi-natives` provides thin N-API bindings     |

**Catalog import convention**: code in this repo imports catalog _values_ (bundled models, model-thinking helpers, identity, descriptors, model manager/cache) from `@oh-my-pi/pi-catalog/<module>` — never via `@oh-my-pi/pi-ai`. The pi-ai barrel re-exports only the model/effort _types_ its own signatures use (`Model`, `Api`, `ThinkingConfig`, `Effort`, …); type-only imports of those from `@oh-my-pi/pi-ai` are fine.

## GitHub

- Before posting a GitHub comment or creating an issue, MUST show the target and proposed text and obtain user confirmation. An explicit instruction to post supplied text to a specified target already counts as confirmation.
- A request to address or fix PR feedback permits drafting replies, not posting them without confirmation. A request only to get or check comments is read-only.
- When authorized to resolve review feedback, MUST verify the fix, obtain approval for a factual reply citing the change and verification, and post it in the existing thread before resolving. NEVER resolve if the reply is unapproved or posting fails.
- Permission to work on a PR does not authorize unrelated comments or issue creation.

### Pull requests

When authorized to create or edit a contributor-submitted PR, follow the checklist below. RoboOMP-managed PRs follow their dedicated workflow and enforced body format in `python/robomp/src/prompts/system_append.md` instead.

- MUST read `CONTRIBUTING.md` and `.github/PULL_REQUEST_TEMPLATE.md` first. Preserve the template sections and checklist, including when shortening an existing description.
- MUST obtain at least one sentence written by the contributor in their own words explaining what changed and why, as required by `CONTRIBUTING.md`. If it is missing, ask the contributor; NEVER generate a substitute. Preserve that sentence during edits.
- For user-facing changes, MUST follow the [Changelog](#changelog) attribution rules. Internal issue fixes keep their issue links. For external contributions, add the PR link and contributor credit after GitHub assigns the number, then push the entry before marking the changelog checklist item complete.
- MUST read back the published PR description after creating or editing it. Check only verified checklist items; explain skipped or inapplicable checks in `Testing`.

## Code Quality

- No `any` unless absolutely necessary.
- **NEVER use `ReturnType<>`** — use the actual type name.
- **NEVER use inline imports** — no `await import()`, no `import("pkg").Type` in type positions, no dynamic type imports. Always top-level.
- Check `node_modules` for external API types instead of guessing.
- **Barrel exports**: prefer `export * from "./module"` over named re-exports, including `export type { ... } from`. In pure `index.ts` barrels, use star re-exports even for single-specifier cases. If stars create ambiguity, remove the redundant export path; do not keep duplicates.
- **Class privacy**: use ES `#private` fields; leave externally accessible members bare. **No `private`/`protected`/`public` keyword on fields or methods**, except on **constructor parameter properties** where TypeScript requires it (e.g. `constructor(private readonly session: ToolSession)`).
- **Promises**: use `Promise.withResolvers()` instead of `new Promise((resolve, reject) => ...)`.
- **Prompts**: never build prompts in code (no inline strings, template literals, or concatenation). Prompts live in static `.md` files; use Handlebars for dynamic content. Import them via `import content from "./prompt.md" with { type: "text" }` — not `readFile`.
- **Judge questions**: one JSON file per feature (`src/prompts/judge/<feature>.json`) maps question ids to `{ instructions, criteria? }`. Load it with `judgeQuestions(file)` from `@oh-my-pi/pi-ai`; fill Handlebars instructions with `renderQuestion(question, context)`. `criteria` sets the kind: a list of levels → score, omitted or `true`/`false` keys only → yes/no, any other labels → choice (`{}` when the caller supplies the labels). Choice labels and answer types come from the JSON keys.
- **Worker scripts**: workers re-enter the CLI entrypoint; never spawn separate worker entry modules. `cli.ts` declares itself as the worker host at startup (`declareWorkerHostEntry()` from `@oh-my-pi/pi-utils/env`) and dispatches hidden argv selectors (`__omp_worker_stats_sync`, `__omp_worker_tab`, `__omp_worker_js_eval`, `__omp_worker_tiny_inference`) before loading the command registry. Spawn sites use:
  ```ts
  import { workerHostEntry } from "@oh-my-pi/pi-utils";
  const hostEntry = workerHostEntry();
  const worker = hostEntry
  	? new Worker(hostEntry, { type: "module", argv: ["__omp_worker_<name>"] })
  	: new Worker(new URL("./<worker>.ts", import.meta.url).href, { type: "module" });
  ```
  When the process was started from the omp CLI — source `cli.ts`, npm-bundle `dist/cli.js`, or compiled binary — `workerHostEntry()` is `Bun.main` and the worker re-enters the single entry module, so no per-worker `--compile` entrypoints or bundle entries exist. Outside a CLI host (`bun test`, SDK embedding, standalone `omp-stats`) it returns `null` and the direct-module fallback loads the worker source. New worker kinds MUST add their selector to the dispatch table in `cli.ts` and keep the fallback branch.
  History: `with { type: "file" }` only copied the entry as a raw asset (workers crashed silently in compiled binaries — issues #1011, #1027), and the later literal-path + extra-entrypoint pattern required keeping spawn literals and two build scripts in sync (issue #1150). The smoke probe below is the live validation of this contract.
  Validate any new worker with the dedicated smoke probe: `omp --smoke-test` spawns the stats sync worker and the tiny-model subprocess, pings them, and exits — it's wired into `ci:test:smoke` and `scripts/install-tests/run-ci.sh` so binary, source-link, and tarball installs all exercise it. Add a sibling smoke if the new worker is on a different module graph.

## Central Utilities

Before writing a helper, check whether one already exists — `packages/coding-agent/src/utils/`, `@oh-my-pi/pi-utils`, `@oh-my-pi/pi-tui`, and the domain modules next to your callsite. This applies to **everything**: VCS wrappers, formatting/truncation/path-display helpers, image handling, clipboard, streams, temp files, caching. The central versions carry hardening a fresh copy always loses (timeouts, output caps, non-interactive env, lock avoidance, caching, TUI sanitization).

- Search first: `grep` for the operation before implementing it. Two implementations of the same thing is a bug even when both work.
- Examples of the pattern: `@oh-my-pi/pi-natives/vcs` and `src/utils/active-repo-context.ts` are the only sanctioned way to run git/jj (`import * as vcs from "@oh-my-pi/pi-natives/vcs"` — never hand-spawn via `$`/`Bun.spawn`); rendering goes through the helpers in TUI Sanitization below (`replaceTabs`, `truncateToWidth`, `shortenPath`, `PREVIEW_LIMITS`) rather than ad-hoc string math.
- Missing capability? Extend the central helper (new option, new sub-function on the namespace) and call it — don't fork its logic locally.

## Bun Over Node

Use Bun APIs where they provide a cleaner alternative; fall back to `node:*` only for what Bun doesn't cover. **Never spawn shell commands for operations with proper APIs** (e.g., don't `Bun.spawnSync(["mkdir", "-p", dir])` — use `mkdirSync`).

### Quick reference

| Operation       | Use                                       | Not                                |
| --------------- | ----------------------------------------- | ---------------------------------- |
| File read/write | `Bun.file()`, `Bun.write()`               | `readFileSync`, `writeFileSync`    |
| Spawn process   | `` $`cmd` ``, `Bun.spawn()`               | `child_process`                    |
| Sleep           | `Bun.sleep(ms)`                           | `setTimeout` promise               |
| Binary lookup   | `$which("git")` from `@oh-my-pi/pi-utils` | `spawnSync(["which", "git"])`      |
| HTTP server     | `Bun.serve()`                             | `http.createServer()`              |
| SQLite          | `bun:sqlite`                              | `better-sqlite3`                   |
| Hashing         | `Bun.hash()`, `Bun.password.*`, WebCrypto | `node:crypto`                      |
| Path resolution | `import.meta.dir`, `import.meta.path`     | `fileURLToPath` dance              |
| JSON5           | `Bun.JSON5.parse()` / `.stringify()`      | `json5` package                    |
| JSONL           | `Bun.JSONL.parse()` / `.parseChunk()`     | `text.split("\n").map(JSON.parse)` |
| String width    | `Bun.stringWidth()`                       | `get-east-asian-width`, custom     |
| Text wrapping   | `Bun.wrapAnsi()`                          | custom ANSI-aware wrappers         |

### Process execution

Prefer Bun Shell (`` $`cmd` ``) for simple commands:

```typescript
import { $ } from "bun";

const result = await $`git status`.cwd(dir).quiet().nothrow();
if (result.exitCode === 0) {
	const text = result.text();
}

$`do-stuff ${tmpFile}`.quiet().nothrow(); // fire and forget
```

Methods: `.quiet()`, `.nothrow()`, `.text()`, `.cwd(path)`.

Use `Bun.spawn`/`Bun.spawnSync` only for: long-running processes (LSP, kernels), streaming stdin/stdout/stderr (SSE, JSON-RPC), or process control (signals, kill, complex lifecycle).

When using `pipe` mode, cast the stream:

```typescript
const child = Bun.spawn(["cmd"], { stdout: "pipe", stderr: "pipe" });
const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
```

### Node module imports

Always use **namespace imports** for `node:fs`, `node:path`, `node:os`:

```typescript
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
```

- Async-only file → `node:fs/promises`.
- Needs both sync and async → `node:fs`, then `fs.promises.xxx` for async.

### File I/O

Prefer Bun:

```typescript
const text = await Bun.file(path).text();
const data = await Bun.file(path).json();
await Bun.write(path, data); // auto-creates parent dirs
```

Use `node:fs/promises` for directory ops (`fs.mkdir`, `fs.rm`, `fs.readdir`) — Bun has no native directory APIs. Avoid sync APIs in async flows; use sync only when forced by a synchronous interface.

**Anti-patterns:**

- `existsSync`/`readFileSync`/`writeFileSync` in async code → `Bun.file()` APIs.
- `mkdir(dirname(path), …)` before `Bun.write(path, …)` → redundant; `Bun.write` handles it.
- `if (await file.exists()) { await file.json() }` → two syscalls plus race. Use try-catch with `isEnoent`:
  ```typescript
  import { isEnoent } from "@oh-my-pi/pi-utils";
  try {
  	return await Bun.file(path).json();
  } catch (err) {
  	if (isEnoent(err)) return null;
  	throw err;
  }
  ```
- Multiple `Bun.file(path)` handles for the same path (including across `checkX`/`loadX` helpers).
- `Buffer.from(await Bun.file(x).arrayBuffer())` → `await fs.readFile(path)`.
- Existence check + try-catch around the same read → drop the existence check.

### Streams

Prefer centralized helpers:

```typescript
import { readStream, readLines } from "./utils/stream";
const text = await readStream(child.stdout);
for await (const line of readLines(stream)) {
	/* ... */
}
```

Manual reader loops only when the protocol requires it (SSE, streaming JSON-RPC).

### Misc

- **Sleep**: `await Bun.sleep(ms)`, never `new Promise(r => setTimeout(r, ms))`.
- **Password hashing**: `Bun.password.hash(pw, "bcrypt")` / `Bun.password.verify(pw, hash)`.
- **String width**: `Bun.stringWidth(text, { countAnsiEscapeCodes?: false })`.
- **Wrapping**: `Bun.wrapAnsi(text, width, { wordWrap, hard, trim })`.

## Model/Provider Policy Lives in KDL

**NEVER hard-code model- or provider-conditional policy in TypeScript.** No `id.includes("claude")`, no model-name regexes, no per-model lookup tables (effort ladders, pricing, context windows, modalities, API routing, quirk flags). All of it belongs in the KDL rule tree at `packages/catalog/src/compat/rules/`, compiled by `bun run gen:compat` into the committed `rules.json` and resolved at build time via `resolveModelPolicy`/`buildModel`.

Ownership strata (see `src/compat/rules/README.md`):

- `taxonomy/*.kdl` — identity: class membership, families, revision extraction, reviewed overrides, suffix collapse.
- `classes/*.kdl` — model-lineage truths (behavior inherent to a model line, on any host).
- `providers/*.kdl` — deployment contracts (behavior a host imposes), plus documented exact-id residue.
- `runtime/behavior.kdl` — heuristics that run before/outside exact model lookup (`api-routes`, `model-limits`, `exclude-models`, `pricing-peer`, hosted defaults).

Rules for TS code:

- Branching on model identity in TS is allowed **only** through structured facts from `classifyModel()` (`class`/`family`/`revision`/effort facts) — never through string matching on ids, and prefer a KDL axis when one can express the policy.
- Discovery mappers map authoritative upstream fields as reported; seed neutral values only for fields the upstream omits or misreports **and** KDL explicitly owns via a correction axis (`input-modalities`, `cost-patch`, `limits-patch`, `context-window-floor`, thinking axes). Assert rule-owned corrections through `buildModel`; raw discovery specs remain the right assertion surface for parsing/normalization contracts.
- An id that no selector can isolate gets an exact-id `models` residue rule with a comment — never a special case in TS.
- Equal-rank rule overlaps throw `AmbiguousOverlapError` at resolve time; fix with an explicit `priority=` in KDL, not code.
- After editing rules: `bun run gen:compat` and commit `rules.json` alongside the `.kdl` change.

## Generated Files

**NEVER edit `packages/catalog/src/models.json` directly.** It is generated from upstream sources (stencil.so, provider catalog discovery, OpenCode docs) by `packages/catalog/scripts/generate-models.ts` and the descriptors/resolvers in `packages/catalog/src/provider-models/`. Hand-edits get overwritten on the next regen. The same applies to `packages/catalog/src/compat/rules.json`, compiled from the KDL tree by `bun run gen:compat`.

To change an entry, fix the source:

- **Model/provider policy** (identity, thinking ladders, wire quirks, modality/limit/pricing corrections, API routing, roster exclusions) → the KDL tree in `packages/catalog/src/compat/rules/` (see the section above).
- **Provider catalog entries** (default model, discovery factory/flags) → the `CATALOG_PROVIDERS` table in `packages/catalog/src/provider-models/descriptors.ts`.
- **Discovery/request plumbing** (endpoint shapes, auth, response parsing) → the mappers in `packages/catalog/src/provider-models/openai-compat.ts`.
- **Generator wiring** (upstream merges, premium multipliers, post-processing order) → `packages/catalog/scripts/generate-models.ts`.

Regenerate with `bun run gen:compat` and/or `bun run gen:models` and commit the generated files alongside the source change. Add a regression test against the **rule/descriptor/mapper**, not the bundled JSON, so it survives upstream metadata shifts.

## Logging and CLI Output

Code that may run while the TUI, RPC, SDK, workers, or background runtimes are active MUST NOT use `console.log`/`error`/`warn`; it corrupts rendering or protocols. Use the centralized logger:

```typescript
import { logger } from "@oh-my-pi/pi-utils";

logger.error("MCP request failed", { url, method });
logger.warn("Theme file invalid, using fallback", { path });
logger.debug("LSP fallback triggered", { reason });
```

Logs go to `~/.omp/logs/omp.YYYY-MM-DD.log` with automatic rotation; `bun test` processes write theirs to a per-user `omp-test-logs-<uid>/` under the OS temp dir instead. Standalone CLI commands that exit without entering the TUI MAY use `console.*` or process streams for intentional user-facing output. Keep structured stdout clean. This exception is semantic, not filename-based; shared code must use `logger` or an explicit output sink.

## TUI Sanitization

All text displayed in tool renderers must be sanitized. Raw content (file contents, error messages, tool output) breaks terminal rendering: tabs → visual holes, long lines → overflow, paths → leak home directory.

**Rules:**

- **Tabs → spaces** via `replaceTabs()` (from `@oh-my-pi/pi-tui` or `../tools/render-utils`).
- **Truncate** lines with `truncateToWidth()` / `ui.truncate()`. Use `TRUNCATE_LENGTHS` constants.
- **Shorten paths** with `shortenPath()` (replaces home with `~`).
- **Preview limits** from `PREVIEW_LIMITS`. No ad-hoc numbers.

**Apply to every render path**, not just the happy one:

- Success output (file previews, command output, search results).
- **Error messages** — these often embed file content (e.g., patch failure messages include unmatched lines). If a message contains file content, it needs `replaceTabs()`.
- Diff content (added and removed).
- Streaming previews.

### Streaming tool previews

Tool-call previews can have **multiple render paths**. If you add preview-only fields or depend on partially streamed args, update every path — not only the final renderer. Streamed argument buffers decode into display args via `decodeStreamedToolArgs` / `ToolArgsRevealController` (`modes/controllers/tool-args-reveal.ts`); both the live event path and transcript rebuilds must go through them — never spread provider-parsed `arguments` next to a raw `__partialJson` (parsed args lag the stream by a throttled parse window).

For the bash tool specifically:

- The pending preview may need raw `partialJson`, not just parsed `arguments`. Parsed args lag until a JSON object closes, which makes inline env assignments appear only at the end.
- Preserve preview-only fields (e.g. `__partialJson`) through `event-controller.ts`, transcript rebuilds in `ui-helpers.ts`, and merged call/result rendering in `tool-execution.ts`. Missing one path causes inconsistent previews.
- `ToolExecutionComponent.#buildRenderContext()` for bash must work even before a result exists — the renderer uses call args plus render context to show the command preview while streaming.
- Verify both live streaming and rebuilt transcript paths after any bash preview change. A fix in one path does not fix the other.

## Commands

- MUST run requested project commands with their existing defaults. NEVER append flags or positional arguments unless the user explicitly requests those arguments.
- `跑 full` / `运行 fulltest` means `bun run fulltest`; `跑 fast` means `bun run fastcheck`. NEVER infer `--full` or other flags from command names or words such as “完整” and “全量”.
- NEVER commit unless asked.
- Never use `tsc`/`npx tsc` — always `bun check`.
- NEVER run `cargo test` directly for Rust tests — use `bun run test:rs`. Cargo and Nextest select all of `pi-knowledge` and the `pi-natives` namespace `knowledge::`; scope is `rust-fork-features`. The independent `pi-knowledge` doctest stage runs `cargo test -p pi-knowledge --doc --no-fail-fast`; the native `cdylib` has no doctests. `fulltest` and `slowtest` test fork features, not the entire workspace; static checks and compilation retain their full scope.
- Merge commits (maintainer merges of PRs) follow: `Merge PR #<number>: <conventional PR subject> (@<author>)` — e.g. `Merge PR #6386: feat(catalog): add native Meta Model API provider (@eggpeat)`.
## Rust Build Profiles

Profiles live in the root `Cargo.toml`; `.cargo/config.toml` carries the settings Cargo.toml cannot express. Both are committed, so no local `~/.cargo/config.toml` is required.

| Profile | Use |
| --- | --- |
| `dev` | Default. Line tables for our crates, no debuginfo for deps, deps at `opt-level = 2`. |
| `release` | Shipping build: fat LTO, 1 codegen unit, stripped. |
| `local` | Fast local release iteration: thin LTO, 16 codegen units, incremental. |
| `profiling` | `release` codegen with symbols kept, for `perf`/`samply`/Instruments. |
| `ci` | Thin LTO, no debuginfo, stripped. |

**Never set `split-debuginfo = "off"` on a profile that has debuginfo.** On Mach-O the linker never merges DWARF into the executable — it writes a debug map (`N_OSO`) pointing at the `.o` files, and `"unpacked"` is what keeps those files. With `"off"` every backtrace frame in our own crates silently loses `file:line`; the `panicked at foo.rs:3` header still prints (that is `#[track_caller]`, not debuginfo), which makes the loss easy to miss. `ci` may use `"off"` only because it sets `debug = false`.

`embed-metadata = false` (in `.cargo/config.toml`) keeps crate metadata in `.rmeta` instead of duplicating it into every rlib — measured 196 MB → 130 MB on a reqwest-sized graph at identical build times. Its accepted spelling is toolchain-coupled; keep it in sync with `rust-toolchain.toml`.

Rejected, with measurements, so nobody re-litigates them: **sccache** (cannot cache incremental, bin, or proc-macro crates — measured slower than not using it), **mold** (ELF-only; no Mach-O support), and **`panic = "abort"` on `dev`** (Cargo ignores `panic` for the test profile, so the whole dep graph builds twice — 131 MB → 214 MB).

## Testing Guidance

Test the contract the system exposes — not the easiest internal detail to assert.

- Every new test must defend one **concrete, externally observable contract**: behavior, output shape, state transition, error mapping, or a regression-prone parsing boundary. If you cannot name the contract, do not add the test.

### Good vs. bad test filter

- **Name the failure mode.** Every test MUST state what a consumer observes if it regresses. Cannot name one? NEVER add it.
- **Good: transformation.** One fixture MAY prove parse/render/normalize/encode/resolve behavior when output is computed, not echoed.
- **Good: branch or boundary.** Distinct inputs, empty values, malformed input, version/provider routing, and state transitions MUST prove distinct outcomes.
- **Good: external contract.** Exact bytes/shape MAY be asserted when a provider, parser, protocol, or persisted consumer reads them.
- **Good: precedence or negative contract.** Keep explicit `false`/override-wins assertions and required absence only when they prevent a documented leak, downgrade, 400, or incompatible wire field.
- **Good: regression.** A repro MUST trigger the prior real failure path and assert the corrected observable result.
- **Bad: static echo.** NEVER test a constructor/builder merely copied a fixture or baked constant into an in-memory config/metadata field.
- **Bad: success passthrough.** NEVER assert `fn(x) === x` when `x` was already supplied/declared valid; assert a transform, rejection, or downstream effect instead.
- **Bad: wording/defaults.** NEVER assert prompt/UI boilerplate, a default literal, object existence, non-empty output, or length growth without a consumer contract.
- **Bad: duplicate rows.** Parameterized/loop rows MUST each cover a distinct branch, provider/model path, or consumer contract; delete same-path duplicates.
- **Metadata exception.** Exact metadata, identity, ordering, or `undefined` MAY remain only when a downstream consumer depends on it and the test establishes branch, precedence, negative-contract, wire, or regression evidence.
- **Termination exception.** For cyclic/large inputs, assert a bounded output, surfaced error, or state change; bare `not.toThrow()` is insufficient.
- No placeholder tests, tautologies, or "the code ran" assertions (`expect(true).toBe(true)`, bare `not.toThrow()`, non-empty string checks, length-grew checks, "prompt exists" checks without semantic assertion).
- Prefer contract-level tests over implementation details. Avoid asserting internal helper wiring, field assignment, singleton identity, incidental ordering, prompt boilerplate, or passthrough option forwarding unless another component depends on that exact detail.
- Don't duplicate coverage across abstraction levels. If an integration test already proves the behavior, drop the narrower unit test that restates it through mocks.
- Tests **must be full-suite safe**, not just file-local safe. No long-lived file-wide mutations of `Bun.*`, `process.platform`, `process.env`, or `Bun.env` when a narrower seam exists. Prefer per-test `vi.spyOn(...)` with `vi.restoreAllMocks()` in `afterEach`. A test that passes alone but poisons later files is broken.
- **Never use `mock.module()`**. Bun's `mock.module()` mutates the global module registry and leaks across files ([oven-sh/bun#12823](https://github.com/oven-sh/bun/issues/12823)). Use `spyOn` on the imported module object instead. For pass deps, import the pass and spy on `.run`. For package deps, namespace-import and spy on the exported function.
- For lifecycle/stateful code, prefer one test per invariant or transition over several tiny tests asserting one field each from the same transition.
- For error handling, trigger the real failure path and assert the surfaced contract — don't instantiate error classes directly or inspect internal metadata.
- Smoke tests are acceptable only when they catch a failure mode narrower tests would miss. "Package boots" or "command starts" alone is not enough.
- Assert exact strings, ordering, and formatting only when downstream code parses or depends on the exact bytes. Otherwise assert semantic content.
- Compile-time guarantees → type checks/type tests, not runtime placeholders.
- **Never source-grep.** A test that reads an implementation file (`.ts`/`.rs`/build script) and asserts on its _text_ — `expect(src).toContain("someCall()")`, `.toMatch(/import .../)`, `.not.toContain("oldName")`, or "comment must say X" — is banned. It tests how code _looks_, not what it _does_: it breaks on harmless refactors (comment reflow, rename, import reorder) and passes while the behavior is broken. Assert the observable contract instead (run the code, check output/state/error), use the runtime smoke probe for wiring you cannot exercise in-process, and enforce structural invariants (no value-import of X, no self-import) with a type test or an oxlint rule — never a string scan of the source. (Reading a file your code _wrote_ — apply-patch result, generated bundle, temp fixture — and asserting on that output is fine; that is behavior, not a source grep.)
- Don't add tests for tiny low-risk changes unless they protect a real contract or fix a regression-prone edge case.
- Prefer focused package-local verification for the changed area.

## Changelog

Location: `packages/*/CHANGELOG.md` (per package).

**Format** — sections under `## [Unreleased]`:

- `### Breaking Changes` (first if present)
- `### Added`
- `### Changed`
- `### Fixed`
- `### Removed`

**Rules:**

- New entries always go under `## [Unreleased]`.
- Entries are one line, brief, and user-facing: lead with what the user will see or can now do. Root-cause narration and implementation detail belong in the commit/PR, not the changelog.
- Never modify already-released sections (e.g., `## [0.12.2]`) — they are immutable.
- Don't flag changelog section order or formatting in reviews or PRs — `bun run release` runs `fix-changelogs` which normalizes everything automatically.

**Attribution:**

- Internal (from issues): `Fixed foo bar ([#123](https://github.com/can1357/oh-my-pi/issues/123))`.
- External contributions: `Added feature X ([#456](https://github.com/can1357/oh-my-pi/pull/456) by [@username](https://github.com/username))`.

## Releasing

Fork releases require explicit user authorization and use the manual CI workflow on `main` as specified in [fork-runtime](openspec/specs/fork-runtime/spec.md). Do not use the upstream `bun run release` script for fork releases.

## Fork Requirements and Additional Runbooks

- [已批准需求](openspec/specs/)是 fork 的权威需求目录；[待定变更](openspec/changes/)尚未批准。[项目定位](openspec/specs/fork-product-scope/spec.md)、[维护约束](openspec/specs/fork-maintenance/spec.md)、[验证门禁](openspec/specs/fork-verification-gates/spec.md)和[上游基线](openspec/specs/fork-upstream-baseline/spec.md)分别维护相关约束；适用的 fork 约束优先于上游通用约定。
- [个人命令](openspec/specs/personal-commands/spec.md)维护 fork 内置斜杠命令及其行为边界。
- `/loopgoal` 复用 `/loop`，仅增加固定目标提示词包装及最终回复精确为 `无` 时停止；参数、上下文策略、首轮提交、调度与暂停恢复均沿用 Loop，不另设压缩阈值或准备流程，不接入 Goal 管理。提示词位于 `packages/coding-agent/src/prompts/loop-goal.md`，共享语义位于 `packages/coding-agent/src/modes/loop-goal.ts`，详见[个人命令](openspec/specs/personal-commands/spec.md)。
- AIReq 最新规则已由用户确认并同步到 [需求提案](openspec/specs/aireq-requirement-intake/spec.md)、[工作台](openspec/specs/aireq-browser-workbench/spec.md)及[原生编排](openspec/specs/spec-driven-orchestration/spec.md)；完整说明见 [AIReq 流程](docs-zh-CN/spec-driven-orchestration.md)。同仓库单 IR、默认最多两个依赖就绪 SR 并行，首个 SR 启动冻结；SR 代码／测试／规格同 PR，IR 验收后最终修复／归档 PR，归档不再同步规格。旧计划冲突条款不再适用；本次仅文档更新，未改原型与代码，不代表实现完成。其他待定变更不因此获批。
- AIReq 新定位为需求澄清、需求管理与进度跟踪，不参与编码。本步仅调整文档和设置原型：项目只配置 Git 仓库及默认分支，Release 继承，不再要求本地／个人开发目录；删除计划／执行 Agent 设置，IR 验收设置替换为需求分析，方案 Agent 保留于提案。进度必须有百分比与遗留问题，0%～99%只由AI分析，AI最高99%；只有AI已分析到99%、开发分支非空且已合入后，人工才可确认到100%，禁止其他人工百分比。其他旧开发流程文档与原型待逐步对齐，不因设置改动实施真实 Git 或后端；详见[工作台设置规则](openspec/specs/aireq-browser-workbench/spec.md)。
- AIReq 正式需求原型在“自动化”下提供大表格入口，不再显示左侧正式需求树或 AI 会话；选中 IR／SR 仅在同页右侧展开报告／材料标签，不跳详情页，需求提案保持三栏。IR 进度为全部 SR 的算术平均值，管理员按工号分配唯一 IR 负责人；本轮仅文档与原型，复用 ZCode 控件，不接真实后端、Git 或模型。最新展示与进度规则见[工作台](openspec/specs/aireq-browser-workbench/spec.md)。
- AIReq 正式需求表格 MUST 提供“开发分支”列，展开 IR 后所有访问者均可直接查看、点击或键盘复制各 SR 完整分支名；复用需求分析的复制及提示组件，成功／失败明确反馈，复制不触发行选择或 Git。优先使用平台 SR 分支映射，其次使用当前分析关联分支，NEVER 用执行历史或猜测名称；无关联明确显示，不提供空值复制。
- AIReq 网页工作台 MUST 一次性完成替换，只处理新建需求；保留并复用原生 Agent 和底层能力，NEVER 保留旧 AIReq 模式、兼容入口、双轨运行或旧流程迁移／恢复。
- AIReq 提案仅有提交人，不设负责人、开发人员或计划起止时间。方案 Agent 逐 SR 生成工期预估及假设，与依赖共同放入同一 Change 的 `sr-dependencies.json`：每个稳定 SR ID 记录 `estimate: { workingDays: 正数工作日, assumptions: 非空依据与不确定项 }` 及 `prerequisites`，覆盖全部 SR，无依赖为空数组。可并行关系由图推导，预估不直接相加为 IR 总工期；人通过方案对话让 AI 修改，不编辑文件。JSON 与 `design.md` 同轮生成、更新、失效、确认并提交 Git；缺失、无效或过期时不沿用旧确认、提交或自动转正。`design.md` 仅引用 JSON，SR `spec.md` 不重复维护。转正保留 Git 内预估和依赖，再按正式规则安排负责人、SR 开发人员与起止时间；正式安排属数据库元数据，不从预估自动换算。本轮只改文档和内存原型，不代表真实文件生成或后端已实现。
- AIReq 右侧选中 `sr-dependencies.json` MUST 复用现有图画布及控件展示只读 SR 依赖图，不展示 JSON 正文；节点为稳定 ID／标题，箭头从前置 SR 指向依赖方，支持缩放、平移及点击连线查看原因，独立 SR 保留节点，缺失／无效／过期材料报错而不绘制旧图。
- AIReq 提案方案有效完成后，材料顶部提供“技术方案／SR 依赖／工期预估”。预估逐 SR 只读展示工作日与假设，依赖图节点显示相同预估；提案不提供人员或日期编辑。正式需求才使用人员与排期控件，保留原有工号校验、人工记录、冲突提醒及 IR 时间汇总。
- AIReq 提案方案完成并人工确认后，平台才创建提案分支、提交推送并通过公司内网 Git API 自动创建 MR，记录编号／地址／分支／状态；人工在 Git 平台评审和合并。后台定时查询 MR，核验提案分支实际合入默认分支且 IR／全部 SR／方案文档完整后自动转正式需求，不要求手填 MR 链接、人工通知或确认合入；转正后创建并推送各 SR 分支，固定需求并开始进度跟踪。本步只改文档和独立原型，五秒内存检查演示不代表真实后台或 Git 已实现；旧个人目录入库及人工核验按钮规则不再适用。
- AIReq MUST 是显式启用的独立功能模块；`/aireq` 进入后当前 TUI 只接受再次 `/aireq` 退出，NEVER 与网页并行执行普通命令或输入。退出 MUST 先结清 AIReq 工作再恢复原普通会话，不取消需求或回滚 Git；关闭页面不退出。未开启时不启动 AIReq 服务／任务或改写其状态；借用资源不得污染普通 OMP，共享接口只保留确实必要且默认不启用的能力，配置继续沿用原方式。
- WebGUI 提供 `/webgui`／`omp webgui`，沿用 AIReq 的 TUI 独占门禁，不改原始 TUI 输入、旁观与恢复逻辑。每个 OMP 进程独立持有随机端口的 Web 服务，同进程项目复用；AIReq 直接挂载原生 HTTP／WS，WebGUI 提供静态资源和 RPC，NEVER 引入独立 worker、常驻 Vite、内部 HTTP、Relay 或桌面远控。外部云中转不属于 OMP 内置能力，只透明转发 HTTP／WS，不改变同源、Host、Origin 或对端准入。
- WebGUI 只保留手机低带宽远程聊天与子代理进度：项目选择／打开／创建、显式新建或继续原生会话、基础聊天、最近 5 条会话、子代理状态／进度／只读记录。聊天使用会话当前模型，输入框旁保留会话临时选模与思考等级切换；全局模型／Provider 配置、设置页、文件与图片上传、`@` 文件上下文、文件／Git 面板与自动刷新、终端／白板／计划／Workflow、命令面板、插件市场、定时任务、Skill／原生命令入口、PDF／Office／Mermaid／公式、通知／帮助／社区、Bots／CUA／Browser Use／远控全部删除。NEVER 以隐藏入口、空实现或统一不可用提示代替删除。首屏按约 3 MB/s 云中转设计：压缩后初始 JavaScript+CSS ≤ 1.5 MiB，单个懒加载块 ≤ 1 MiB，不预取全量语法／图标／PDF／Office 资源；外部云中转只透明转发 HTTP／WS，OMP 不内置 Relay，也不放宽同源／Host／Origin／对端准入。
- 独立 `omp webgui` 启动时不自动创建 Agent、占用项目或调用模型；网页显式选择／打开／创建项目及新建／继续会话后 MUST 使用同进程原生会话直接开发，允许多个独立会话并行，不另建 ZCode 执行器。历史只读不切换执行会话；显式跨目录续聊按目标真实目录取得项目准入，不切走其他运行会话。同一真实项目根跨进程／profile／配置根仅一个 AIReq 或 WebGUI owner，同进程会话共享项目占用。退出 MUST 先结清本实例全部自有会话及递归子工作，再释放资源／服务／占用并恢复普通终端；失败保持锁定可重试，不关闭其他实例、不错误销毁借用的原 TUI 会话；关网页不退出。AIReq 保留完整随机能力地址；最新长期共享 Web 部署的多人访问以 AIReq 最新规则为准，原非 offline 仅本机假设不作为该部署约束；WebGUI 访问边界不变。
- WebGUI MUST 不影响正常 OMP／TUI；未显式启用时不启动网页资源或绑定网页交互，新增共享参数默认保持原生行为。借用 TUI 会话退出后 MUST 恢复真实工具／扩展 UI、审批、输入及草稿，不销毁原会话；按[非干扰需求](openspec/specs/personal-commands/spec.md)验证普通入口与进入／退出后的行为。
- WebGUI 不提供设置页：设置页签、身份入口设置按钮、设置快捷键、命令面板设置命令与全部设置分区（模型／Provider、用户级 AGENTS、Skill／插件／命令／Hooks／记忆／子智能体／项目／归档）均已删除，NEVER 以空分区、占位页或隐藏入口代替。聊天内会话临时选模与思考等级、真实原生工具执行、审批与错误提示保持。
- AIReq 设置只保留有真实管理能力的页面：个人工具仅外观，平台配置为 AIReq 项目与 Release、模型设置、个性化、技能。MUST NOT 保留浏览器控制、电脑控制、键盘快捷键、插件、子智能体等仅展示、无真实管理的分区，也不得以空页、占位页或禁用控件代替删除；不恢复内嵌浏览器、Browser Use、系统授权或协议能力。
- WebGUI 源码位于 `packages/coding-agent/src/webgui/`，前端入口为 `vendor/zcode-frontend/preview/`。`bun run build:webgui` 构建前端，正式二进制与 npm 构建通过 `scripts/generate-webgui-resources.ts` 携带同一份指纹校验资源，构建只包含聊天与子代理实际引用资源；运行时不依赖源码目录、Vite 或下载。源码检出需先准备依赖。AIReq／WebGUI 的 Firefox 目标为 128 系列，本机已安装版本为 128.14.0，不再以 68 为目标；版本查询不构成功能验收。Chromium、Firefox 128、手机实机和发行产物必须分别验证，不相互代称通过。
- Firefox 浏览器测试 MUST 使用 Selenium＋geckodriver 驱动本机真实 Firefox，并使用隔离临时 profile；NEVER 以 Chromium、兼容模式或自写 Marionette 驱动替代。记录实际浏览器版本与验证范围，不自动安装浏览器／驱动，不修改个人浏览器配置。
- 原生 TUI `/sketch`：`packages/coding-agent/src/sketch/` 及 `packages/coding-agent/src/slash-commands/builtin-sketch.ts`；资源静态内嵌，以 Firefox 128 原生能力为基线，不再兼容 52。画布工作区铺满窗口，支持缩放和平移，视野操作不改变完整 PNG 附件尺寸；本机验证不等于公司实机验证。
- offline 的 `/aireq`、`/webgui`、`/sketch` 及独立 `omp aireq`／`omp webgui` 不自动启动浏览器；显示完整地址供手动打开，保留 Linux offline 地址复制。非 offline 与普通链接／文件打开沿用原行为，详见[运行约定](openspec/specs/fork-runtime/spec.md)。
- offline 内网用户名协作：`packages/coding-agent/src/collab/intranet.ts`（门禁、登录名、入口与查找）、`packages/coding-agent/src/collab/relay-server.ts`（内置 Relay）；[本次变更需求](openspec/changes/add-intranet-username-collab/specs/)覆盖协作、运行与命令边界，[内网快速指南](docs-zh-CN/quick-start-intranet.md)提供普通 WS 直连部署入口。仅 offline 启用；非 offline 保持既有协作与安全策略。
- Developer Test Agent 内置资源位于 `packages/coding-agent/src/extensibility/plugins/bundled/developer-test-agent/`；其命令和技能使用 OMP 原生接口，业务流程边界见[个人命令](openspec/specs/personal-commands/spec.md)。
- [OpenWiki](openspec/specs/openwiki/spec.md) 通过 `vendor/openwiki` 子模块维护；`omp openwiki` 默认使用 OMP 的 `default` 模型，内置 `openwiki_*` 查询工具只读。修改子模块源码、技能或资源依赖后运行 `bun run gen:openwiki-resources`；资源指纹不匹配时不得使用旧资源。
- 父仓静态检查与测试发现 MUST 排除 `vendor/openwiki` 子模块；OMP 宿主集成测试不受此限制。
- [python/robomp/AGENTS.md](python/robomp/AGENTS.md) 是 GitHub triage/fix bot 子树的架构、命令、开发约定及验证规则。

<!-- OPENWIKI:START -->
## OpenWiki

This repository has a generated `openwiki/` knowledge base. Use it as optional context when investigating unfamiliar architecture or behavior, or when source inspection leaves an important uncertainty. Use `openwiki_search` and `openwiki_read` to find relevant sections; if those tools are unavailable, consult `openwiki/quickstart.md` and its links. Source code and tests are authoritative when the Wiki is outdated.
<!-- OPENWIKI:END -->

- AIReq “需求分析”工作页（原“需求进度分析”）位于主页侧栏正式需求上方，不再作为设置分区；Skill 设计位于自动化下方。两页均复用原生导航及阅读／表格控件，模型与个性化中的 Agent 配置保留在设置中，业务权限和原生后台行为不因页面迁移改变；本轮只改文档及独立原型。

- 公司 offline 内网 Git 平台能力以用户 2026-11-12 实测为准：支持查询／创建 PR／MR，克隆→改代码→push→建 MR→放弃→删分支链路已跑通。AIReq 提案按“确认材料→创建分支并提交推送→自动创建 MR→人工评审、合并→后台定时核验并转正”，不再要求手工建 MR／填链接。此事实不扩展为自动编码、合并或清理分支授权；本轮仅文档与原型内存演示，不实现真实接口、不运行测试。

- 正式SR必须已有平台分配的非空开发分支，缺失属于异常，前端不得以分析分支、旧执行分支或猜测名称兜底。正式需求表格只提供固定112px复制入口；删除“名称列固定／隐藏列数”和前后列按钮整行，正文铺满剩余面板并保留12／16px左右间距。人工进度只允许99%且已合入时确认到100%，IR仍为SR平均；原型后端同样校验。

- AIReq 技术方案、SR 依赖与工期预估均由方案 Agent 在对话中生成及更新，不提供生成／重新生成按钮；人只讨论补充、核对及逐文件确认。材料更新使旧确认失效，保留确认后建分支、推送、自动建 MR 的流程。本轮仅需求文档和原型，不实现真实模型／Git 接入，不运行测试。
