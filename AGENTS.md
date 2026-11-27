# Development Rules

## Default Context

This repo contains multiple packages, but **`packages/coding-agent/`** is the primary focus. Unless otherwise specified, assume work refers to this package.

**Terminology**: When the user says "agent" or asks "why is agent doing X", they mean the **coding-agent package implementation**, not you (the assistant). The coding-agent is a CLI tool — questions about its behavior refer to code in `packages/coding-agent/`, not your current session.

### Package Structure

|Package|Description|
|---|---|
|`packages/ai`|Multi-provider LLM client with streaming support|
|`packages/catalog`|Model catalog: bundled models.json, provider descriptors, model identity/classification|
|`packages/agent`|Agent runtime with tool calling and state management|
|`packages/coding-agent`|Main CLI application (primary focus)|
|`packages/tui`|UI library: reactive JSX nodes, terminal and native (TSP) renderers, terminal driver, text, theme|
|`packages/natives`|Bindings for native text/image/grep operations|
|`packages/stats`|Local observability dashboard (`omp stats`)|
|`packages/omptype`|ArkType-compatible schema validation with a lazy JIT runtime|
|`packages/utils`|Shared utilities (logger, streams, temp files)|
|`crates/natives`|Rust crate for performance-critical text/grep ops|

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
  Validate new worker wiring with `omp --smoke-test`; add a sibling probe when a different module graph is not covered. `bun run ci:test:smoke` checks the source CLI; `bun run ci:test:install-methods` checks installed binaries and tarballs. Run `ci:test:*` only with explicit authorization for this task; otherwise report the unverified scope.

## Central Utilities

Before writing a helper, check whether one already exists — `packages/coding-agent/src/utils/`, `@oh-my-pi/pi-utils`, `@oh-my-pi/pi-tui`, and the domain modules next to your callsite. This applies to **everything**: VCS wrappers, formatting/truncation/path-display helpers, image handling, clipboard, streams, temp files, caching. The central versions carry hardening a fresh copy always loses (timeouts, output caps, non-interactive env, lock avoidance, caching, TUI sanitization).

- Search first: `grep` for the operation before implementing it. Two implementations of the same thing is a bug even when both work.
- Examples of the pattern: `@oh-my-pi/pi-natives/vcs` and `src/utils/active-repo-context.ts` are the only sanctioned way to run git/jj (`import * as vcs from "@oh-my-pi/pi-natives/vcs"` — never hand-spawn via `$`/`Bun.spawn`); rendering goes through the helpers in TUI Sanitization below (`replaceTabs`, `truncateToWidth`, `shortenPath`, `PREVIEW_LIMITS`) rather than ad-hoc string math.
- Missing capability? Extend the central helper (new option, new sub-function on the namespace) and call it — don't fork its logic locally.

## Bun Over Node

Use Bun APIs where they provide a cleaner alternative; fall back to `node:*` only for what Bun doesn't cover. **Never spawn shell commands for operations with proper APIs** (e.g., don't `Bun.spawnSync(["mkdir", "-p", dir])` — use `mkdirSync`).

### Quick reference

|Operation|Use|Not|
|---|---|---|
|File read/write|`Bun.file()`, `Bun.write()`|`readFileSync`, `writeFileSync`|
|Spawn process|`` $`cmd` ``|`child_process`|
|Sleep|`Bun.sleep(ms)`|`setTimeout` promise|
|Binary lookup|`$which("git")` from `@oh-my-pi/pi-utils`|`spawnSync(["which", "git"])`|
|HTTP server|`Bun.serve()`|`http.createServer()`|
|SQLite|`bun:sqlite`|`better-sqlite3`|
|Hashing|`Bun.hash()`, `Bun.password.hash(pw, "bcrypt")` / `.verify()`, WebCrypto|`node:crypto`|
|Path resolution|`import.meta.dir`, `import.meta.path`|`fileURLToPath` dance|
|JSON5|`Bun.JSON5.parse()` / `.stringify()`|`json5` package|
|JSONL|`Bun.JSONL.parse()` / `.parseChunk()`|`text.split("\n").map(JSON.parse)`|
|String width|`Bun.stringWidth(text, { countAnsiEscapeCodes: false })`|`get-east-asian-width`, custom|
|Text wrapping|`Bun.wrapAnsi(text, width, { wordWrap, hard, trim })`|custom ANSI-aware wrappers|

### Process execution

Prefer Bun Shell (`` $`cmd` ``) for simple commands:

```typescript
import { $ } from "bun";

const result = await $`bun --version`.cwd(dir).quiet().nothrow();
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
- After editing rules, run `bun run gen:compat` and include `rules.json` with the `.kdl` change.

## Generated Files

**NEVER edit `packages/catalog/src/models.json` directly.** It is generated from upstream sources (stencil.so, provider catalog discovery, OpenCode docs) by `packages/catalog/scripts/generate-models.ts` and the descriptors/resolvers in `packages/catalog/src/provider-models/`. Hand-edits get overwritten on the next regen. The same applies to `packages/catalog/src/compat/rules.json`, compiled from the KDL tree by `bun run gen:compat`.

To change an entry, fix the source:

- **Model/provider policy** (identity, thinking ladders, wire quirks, modality/limit/pricing corrections, API routing, roster exclusions) → the KDL tree in `packages/catalog/src/compat/rules/` (see the section above).
- **Provider catalog entries** (default model, discovery factory/flags) → the `CATALOG_PROVIDERS` table in `packages/catalog/src/provider-models/descriptors.ts`.
- **Discovery/request plumbing** (endpoint shapes, auth, response parsing) → the mappers in `packages/catalog/src/provider-models/openai-compat.ts`.
- **Generator wiring** (upstream merges, premium multipliers, post-processing order) → `packages/catalog/scripts/generate-models.ts`.

Regenerate with `bun run gen:compat` and/or `bun run gen:models` and deliver generated files with their sources. If a commit is authorized, include both in the same commit. Regression coverage must target the **rule, descriptor or mapper**, not bundled JSON; follow [Commands](#commands) for when new tests are authorized.

## Logging and CLI Output

Code that may run while the TUI, RPC, SDK, workers, or background runtimes are active MUST NOT use `console.log`/`error`/`warn`; it corrupts rendering or protocols. Use the centralized logger:

```typescript
import { logger } from "@oh-my-pi/pi-utils";

logger.error("MCP request failed", { url, method });
logger.warn("Theme file invalid, using fallback", { path });
logger.debug("LSP fallback triggered", { reason });
```

Runtime log locations follow the [runtime spec](openspec/specs/fork-runtime/spec.md#requirement-可选性能数据根). `bun test` logs use the per-user `omp-test-logs-<uid>/` under the OS temp directory. Standalone commands that exit without entering the TUI may use `console.*` or streams for intentional output; keep structured stdout clean. Shared code must use `logger` or an explicit output sink.

## TUI Sanitization

All text displayed in tool renderers must be sanitized. Raw content (file contents, error messages, tool output) breaks terminal rendering: tabs → visual holes, long lines → overflow, paths → leak home directory.

**Rules:**

- **Tabs → spaces** via `replaceTabs()` (from `@oh-my-pi/pi-tui/text/width` or `src/utils/text-width.ts`).
- **Truncate** lines with `truncate()` (`@oh-my-pi/pi-tui/text/width`) / `truncateToWidth()` (`src/utils/text-width.ts`). Use `TRUNCATE_LENGTHS` constants (`src/utils/render-utils.ts`).
- **Shorten paths** with `shortenPath()` (`src/utils/render-utils.ts`; replaces home with `~`).
- **Preview limits** from `PREVIEW_LIMITS` (`src/utils/render-utils.ts`). No ad-hoc numbers.

**Apply to every render path**, not just the happy one:

- Success output (file previews, command output, search results).
- **Error messages** — these often embed file content (e.g., patch failure messages include unmatched lines). If a message contains file content, it needs `replaceTabs()`.
- Diff content (added and removed).
- Streaming previews.

### Streaming tool previews

Tool-call previews can have **multiple render paths**. If you add preview-only fields or depend on partially streamed args, update every path — not only the final renderer. Streamed argument buffers decode into display args via `decodeStreamedToolArgs` / `ToolArgsRevealController` (`modes/controllers/tool-args-reveal.ts`); both the live event path and transcript rebuilds must go through them — never spread provider-parsed `arguments` next to a raw `__partialJson` (parsed args lag the stream by a throttled parse window).

For the bash tool specifically:

- The pending preview may need raw `partialJson`, not just parsed `arguments`. Parsed args lag until a JSON object closes, which makes inline env assignments appear only at the end.
- Preserve preview-only fields (e.g. `__partialJson`) through `modes/controllers/event-controller.ts`, transcript rebuilds in `modes/utils/ui-helpers.ts`, and merged call/result rendering in `ui/transcript/tool-block.tsx`. Missing one path causes inconsistent previews.
- `ToolCall.#buildRenderContext()` (`ui/transcript/tool-block.tsx`) for bash must work even before a result exists — the renderer uses call args plus render context to show the command preview while streaming.
- Verify both live streaming and rebuilt transcript paths after any bash preview change. A fix in one path does not fix the other.

## Commands

- MUST run requested project commands with their existing defaults. NEVER append flags or positional arguments unless the user explicitly requests those arguments.
- Unless the user explicitly requests WSL for the current task, agents and subagents MUST run tests natively on the current host and NEVER invoke WSL or a WSL-backed runner.
- Run only affected existing tests unless the user requests broader coverage. NEVER add tests for a bug fix unless the user explicitly requests them. On Windows, skip only tests with a documented platform restriction.
- Prefer explicit, scoped tests, such as `bun test ./packages/<package>/test/<file>.test.ts`. For broader local validation, use `bun run check` (static checks), `bun run test:ts` (TypeScript suites), `bun run test` (TypeScript and the upstream Rust task), or the applicable `bun run ci:test:*` entrypoint. Run broad suites only when explicitly authorized for this task; see [verification requirements](openspec/specs/fork-maintenance/spec.md#requirement-使用上游验证入口).
- NEVER commit unless asked.
- Never use `tsc`/`npx tsc` for monorepo typechecking; use `bun run check:ts` or the package's `check:types` script.
- Use `bun run test:rs` for Rust workspace tests (Nextest and Cargo doctests). The upstream Rust task may skip when Git shows no Rust-affecting changes; a skip is not a pass. Do not run `cargo test` directly.
- Merge commits (maintainer merges of PRs) follow: `Merge PR #<number>: <conventional PR subject> (@<author>)` — e.g. `Merge PR #6386: feat(catalog): add native Meta Model API provider (@eggpeat)`.

## Rust Build Profiles

Profiles live in the root `Cargo.toml`; `.cargo/config.toml` carries the settings Cargo.toml cannot express. Both are committed, so no local `~/.cargo/config.toml` is required.

|Profile|Use|
|---|---|
|`dev`|Default. Line tables for our crates, no debuginfo for deps, deps at `opt-level = 2`.|
|`release`|Shipping build: fat LTO, 1 codegen unit, stripped.|
|`local`|Fast local release iteration: no LTO, 16 codegen units, incremental.|
|`profiling`|`release` codegen with symbols kept, for `perf`/`samply`/`Instruments`.|
|`ci`|Thin LTO, no debuginfo, stripped.|

**Never set `split-debuginfo = "off"` on a profile with debuginfo.** On Mach-O, debug information remains in the object files; use `"unpacked"` to retain file and line information. The `ci` profile may use `"off"` only because `debug = false`.

Keep the toolchain-sensitive `embed-metadata = false` setting in `.cargo/config.toml` aligned with `rust-toolchain.toml`. Do not set `panic = "abort"` on `dev`; the test profile ignores it and rebuilds dependencies.

## Testing Guidance

Test an observable contract, not implementation shape. Name what the consumer would see if the test failed: a wrong result, missing state transition, broken wire format, or incorrect error. A regression test must trigger the original failure path and assert the corrected outcome.

### Good vs. bad test filter

- Cover distinct transformations, boundaries, or consumer paths. Use exact bytes, ordering, metadata, or absence only when a consumer depends on them. For large or cyclic inputs, assert a bounded result, surfaced error, or state change.
- Do not substitute passthroughs, default literals, boilerplate, fixture echoes, object existence, or mere execution for a consumer assertion. Do not duplicate coverage across rows or abstraction levels. Smoke tests must catch failures that narrower tests cannot; compile-time guarantees belong in type checks or type tests.
- Keep tests full-suite safe. Avoid file-wide mutations of Bun APIs, platform values, or environment variables. Never use `mock.module()`; prefer per-test `vi.spyOn()` and restore mocks in `afterEach`.
- Never assert on source text. Test behavior through the normal entry point; enforce structural invariants with type checks or lint rules. Assertions on files the feature produces are valid.
- Run focused upstream tests for the changed behavior. Keep fork coverage discoverable in the relevant upstream suite; do not add a fork-specific runner, path, allowlist, or entry point.

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

**Attribution:**

- Internal (from issues): `Fixed foo bar ([#123](https://github.com/can1357/oh-my-pi/issues/123))`.
- External contributions: `Added feature X ([#456](https://github.com/can1357/oh-my-pi/pull/456) by [@username](https://github.com/username))`.

## Releasing

Fork releases require explicit user authorization and use only [`bun run cnb`](openspec/specs/fork-runtime/spec.md#requirement-cnb-精确输入缓存与四附件交付). Do not publish to GitHub Releases or use the upstream `bun run release` script. Installation and updates use CNB only. OMP does not check for updates at startup; manual checks and updates are available only outside `OMP_OFFLINE`.

## Fork Requirements and Additional Runbooks

- [已批准需求](openspec/specs/)是 fork 权威；[待定变更](openspec/changes/)尚未批准。[项目定位](openspec/specs/fork-runtime/spec.md#requirement-项目定位与使用场景)、[维护约束](openspec/specs/fork-maintenance/spec.md)、[验证要求](openspec/specs/fork-maintenance/spec.md#requirement-按风险选择验证和报告证据)、[上游基线](openspec/specs/fork-upstream-baseline/spec.md)；适用的 fork 约束优先于上游通用约定。
- `docs/` MUST 与上游保持一致；只通过上游同步更新，NEVER 在该目录内新增、修改、移动或删除 fork 内容。Fork 专用指南放在 `docs-zh-CN/`，仍须遵守文档授权规则。
- **文档变更须先确认。** 不得自行向需求文档或 `AGENTS.md` 添加需求、规则或其他内容。新增、修改、移动或删除任何文档（含需求文档、`AGENTS.md`、README、指南和 changelog）前，MUST 先取得用户对目标文档及变更范围的明确确认。代码改动授权或文档同步要求不等于文档写入授权；未经确认只读核对并报告，不改文件。获准后只改确认范围内的必要内容。功能改动仍须核对[内网快启](docs-zh-CN/quick-start-intranet.md)，确认后只同步受影响的用法和限制，不复写规格。
- `OMP_OFFLINE` 是公司内网标记，不是宿主探测。不得据此扩大工具、URL 或审批限制，也不得推断内网 Git API 不可用或已获写入授权；见[运行规格](openspec/specs/fork-runtime/spec.md)。
- OpenSpec 使用 `omp openspec ...`，无需独立 OpenSpec／Node；未初始化项目 MUST 先取得显式初始化授权。内置 OpenSpec 与 Superpowers 的交付和使用边界见[编排规格](openspec/specs/spec-driven-orchestration/spec.md)。
- `ask` 沿用上游 HTML 表单及宿主协议，不保留 `questions[]`；活跃 `/goal-autopilot` 的例外见[上游继承边界](openspec/specs/fork-maintenance/spec.md#requirement-上游继承行为与本地差异边界)。
- [个人命令规格](openspec/specs/personal-commands/spec.md)维护 `/workspace`、`/sketch`、Developer Test Agent、`/todoloop`、`/collab2` 等行为。`/workspace` 不是沙箱或审批模式；`/collab2` 只用于可信隔离内网。
- Firefox 测试 MUST 使用本机真实 Firefox、Selenium＋geckodriver 与临时隔离 profile。记录实际版本及验证范围；NEVER 换用兼容实现、自动安装浏览器／驱动或改个人配置。本机验证不等于公司实机验证。
- [OpenWiki](openspec/specs/openwiki/spec.md) 子模块源码、技能或资源依赖变化后 MUST 运行 `bun run gen:openwiki-resources`，不得使用指纹不符的旧资源。
- 父仓静态检查与测试发现 MUST 排除 `vendor/openwiki` 子模块；框架专项测试和 fork 合同测试遵循[验证要求](openspec/specs/fork-maintenance/spec.md#requirement-使用上游验证入口)。
- Fork 本地构建、CNB／WSL 前置条件及性能采集见[工程笔记](openspec/fork-engineering-notes.md)。
- 子级规则：[python/robomp/AGENTS.md](python/robomp/AGENTS.md)。
