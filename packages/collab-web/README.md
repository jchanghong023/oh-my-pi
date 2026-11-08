# @oh-my-pi/collab-web

Browser interfaces for [omp collab sessions](../../docs/collab.md) and the host-served Dev workbench. The standalone guest app accepts a `/collab` link and shows the shared native session: streaming transcript, tool-call cards, subagent transcripts and a composer. The Dev workbench reuses these components and native execution; it is not a second chat or workflow engine.

## Standalone guest quick start

```sh
# dev server (Bun HTML dev server with HMR) — http://localhost:3000
bun run dev

# offline demo: local relay + scripted mock host; prints a ws://localhost link
bun run mock-host
```

Host a session from any omp instance (`/collab`, or `/collab ws://localhost:7466` to use the mock relay), then paste the printed link into the connect screen. Deep links work too: `http://localhost:3000/#<roomId>.<key>` auto-connects on load.

## Standalone guest build & deploy

```sh
bun run build   # static site in dist/
```

`dist/` is a fully static SPA — host it anywhere. JS/CSS bundles are content-hashed; favicons, `manifest.webmanifest`, `robots.txt`, `sitemap.xml`, and `og-image.png` come from `public/` and are emitted at the site root under stable names (canonical URL: `https://my.omp.sh/`). Two runtime requirements:

- **Secure context**: room keys are unwrapped with WebCrypto (`crypto.subtle`), which browsers expose only on `https://` or `localhost`.
- **Relay reachability**: the client connects straight to the relay over WebSocket (`wss://` for anything that isn't localhost). The default relay is `wss://my.omp.sh`; bare `<roomId>.<key>` links resolve against it (legacy `<roomId>#<key>` and `%23`-mangled links still parse).

The room key never leaves the URL fragment — it is not sent to the relay or any server.

## Dev browser workbench

**Integration status:** the workbench cutover is implemented. Targeted Win32 x64/Bun 1.4.4 verification covers the actual dark browser layout, native interactions, eight-stage workflow, ordinary OMP isolation and actual npm/binary embedded UI. See the [plan evidence ledger](../../docs/superpowers/plans/2026-11-07-replace-dev-tui-with-browser-workbench.md#actual-evidence-ledger--2026-11-07-handoff) for exact results and reused passes. Local model/Forge fixtures do not constitute real-provider, real-credential, desktop-opener or other-platform acceptance.

Run `omp dev` in the target directory, or `/dev` in an ordinary OMP session. The host opens a browser and prints its actual complete capability URL; if opening the browser fails, copy that URL manually. `/dev` refuses entry while ordinary native work is unsettled: stop it explicitly or wait, rather than silently cancelling it. After entry, the current TUI accepts no ordinary input or commands; only another `/dev` exits Dev. Exit uses native stop/settlement before restoring the original ordinary session, without cancelling the requirement, reverting Git or deleting materials. Closing the page does not exit Dev or unlock ordinary TUI operation. Reopening a page does not create a requirement or start a model; browser Dev and ordinary TUI are never operated concurrently. Old `/dev new`, `next`, `back`, `drop`, `business`, `finish-business` and `config` terminal actions are not compatibility aliases. Ordinary TUI capabilities remain separate.

Automatic browser opening targets the loopback URL; printed intranet URLs are for other participants. For explicitly headless acceptance, `OMP_DEV_NO_OPEN=1` skips the desktop opener without claiming that a browser was opened. Composer drafts and attachments are consumed only after accepted submission; an unknown guest admission result retains them and must not trigger automatic resend.

The workbench displays requirements, eight stages, read-only real materials and native session interactions:

The Dev page uses a three-column layout (requirement list, read-only materials, shared conversation); on narrow screens, switch between Materials and Conversation in the header. The paperclip in the conversation attaches images; Markdown import remains a separate requirement action. When the active native session advertises a model, its name and effort appear beside Send, and an available `/model` command opens native model selection for that session rather than changing global defaults.

The same workbench tab remembers the selected requirement and viewed stage across refresh, separately from its real execution stage. Restoring a view reads/subscribes to current host facts only; it never resubmits input or approvals. Saved views are isolated by workbench entry. To reimport an existing business document, explicitly confirm replacement of the displayed demand-owned copy before either uploading Markdown or importing a host-local path. Confirmation binds the current material version; external originals remain unchanged.


The Dev page uses Firefox 68's default-enabled native capabilities as both its minimum runtime and browser technology ceiling. All browsers receive one locally embedded classic-script/CSS payload; there are no polyfills, API shims, browser-specific fallbacks, legacy builds or modern-only enhancement paths. The complete dependency graph is compiled for Firefox 68 without runtime polyfill injection. Layout, stages and business interactions remain unchanged. Chinese text uses installed system fonts; no additional CJK font is bundled.

Acceptance requires this machine's installed Firefox 68 serving the actual production payload over HTTP(S) with an isolated temporary profile and default capability/security settings. Build success, source checks and modern browsers do not replace that run. Record exact executable/version/channel, OS, URL and observed workflows; desktop input and Chinese IME remain unverified unless separately observed.

The latest fixes were exercised on Windows 11 x64 with `C:\Program Files (x86)\Mozilla Firefox\firefox.exe`, Firefox 68.0.2 release (build 20190813150448), using an isolated headless profile and default capability/TLS settings. `bun run gen:dev-workbench` exited 0; the real `bun packages/coding-agent/src/cli.ts dev` host served the single four-file production payload. Observed: refresh restored the selected requirement and independently viewed planning stage while its real business stage, record version and absent native runtime stayed unchanged; unchecked or cancelled replacement preserved the original; confirmed upload and host-path replacement both succeeded without altering external source bytes. The packaged PNG favicon returned HTTP 200, with no root `/favicon.ico` request.

The temporary production entry was `http://127.0.0.1:64943/69d1daf1e3af7c9e4d2675680e6e74f2a62c7eaeb859d6046488cc8da9adbf2e/`; verification services and profiles are removed after the run. All 107 focused tests in five files and both package type checks passed (exit 0). Scoped lint exited 0 with one `unicorn/no-useless-spread` warning at `packages/coding-agent/src/dev-workbench/server.ts:554`, outside the import change. This run did not exercise Chinese IME, real desktop input, full eight-stage completion or packaged binaries.

The browser E2E suite uses the installed Microsoft Edge 156.0.4314.58; its results apply to that suite and host, not to company hardware.

1. Business requirements: chat, upload Markdown or import an OMP-host-local Markdown path. An existing document can go directly through Next's template check without a business conversation. No URL downloads or Word/PDF conversion.
2. Development requirements.
3. Technical solutions: show every complete candidate and recommendation; choose explicitly when there are multiple candidates.
4. Development plan.
5. Development and UT: Next confirms the report and hands off to ST, without archiving or ending the requirement.
6. ST: a person marks completion, retaining failures, unrun checks and limitations. There is no additional “all ST passed” gate.
7. Submission and PR: explicitly confirm native spec synchronization/archive; separately mark PR submitted and actual merge. Archive is not completion and merge is not inferred from a successful push.
8. Tester testing: after merge, update only this requirement's record; a person marks tested to finish and make it read-only. Fixes use linked new requirements, not code edits in the merged requirement.

These are eight business stages, not eight agents: the existing business, requirements, solution, planning and execution roles remain. Navigation and ordinary chat do not approve materials or advance stages. Back invalidates relevant confirmations without reverting files or Git. Business-only local writing does not create a Git development record or require a delivery/acceptance state; development starts a new requirement by importing its Markdown.

Development uses one slot per canonical Git root and existing branch, with no automatic worktree or per-requirement branch. Waiting for PR review still holds the slot; a person-confirmed real merge, or fully settled cancellation and rollback, releases it. Merged testing can coexist with later development but cannot write other repository files. Deleting an unmerged requirement cancels its PR and reverses all owned committed, staged and unstaged changes while preserving unrelated content and history; conflicts remain blocked rather than being overwritten.

Human marks, testing-state changes and fix links preview and confirm the scoped record commit/push in the same operation. The host supplies operation IDs and confirmation tokens, binds the actual versions and Git target, and reports save, commit and push separately. A failed push retains the successful commit; reconnecting queries facts instead of repeating it. Push ancestry containing unapproved changes, unavailable native/Forge capabilities or an infeasible existing target is a real blocker, not permission to create branches, force-push or bypass PRs. Minimal business records live in `docs/dev-requirements/<requirementId>.json`; native chat and connection/runtime state are not copied into Git.

### Network and native collaboration boundary

- Non-offline workbench service binds loopback only. With `OMP_OFFLINE=1`, it binds all interfaces and prints actual loopback and discovered intranet addresses with the assigned port and capability prefix. Network/firewall reachability is not guaranteed by printing an address.
- Offline browsers use same-origin ordinary HTTP/WS to the workbench. Existing native Collab transport performs relay lookup and encryption on the OMP host; it does not require remote-browser `crypto.subtle` or `crypto.randomUUID`, a new relay, certificates or SSO. The standalone GuestClient's secure-context and remote-WSS requirements above remain unchanged.
- Opening a page is not joining a room. Join explicitly by the existing username/link mechanism; usernames are routing/display names, not authenticated identities. Guests participate in the same native session, do not take over the host's guest state and do not automatically follow another stage/agent.
- Offline participants may use all workbench operations, but native deny rules, restricted folders, tool/stage write scope and human confirmations still apply. Non-offline invitation, view/write and command boundaries are not upgraded.
- Closing, refreshing, leaving or losing a browser connection only releases that subscription/guest. The OMP host must remain alive for background agents, tools, Team and Goal to continue. Reconnection reads snapshots and operation results without replaying prompts, tool calls, UI answers or confirmations. Explicit Stop and host shutdown use native settlement.

### Embedded UI resources

The workbench is served by OMP, not by this package's guest dev server. Source preparation uses the repository-root `bun run gen:dev-workbench`; npm bundles and standalone binaries embed the same content-addressed UI payload through the existing build chain. Serving a request does not compile the frontend or fetch CDN assets. A missing payload is a preparation error, not a demo-page fallback.

Source acceptance and packaged acceptance are separate. The explicit `packages/coding-agent/scripts/verify-dev-workbench-package.ts` program requires `--npm-entry`, `--binary` and `--assets-manifest` for this build's real artifacts; it is not part of default test discovery or `fulltest --full`, does not build/release automatically and cannot substitute source results for packaged evidence.

## Architecture

- `src/lib/` — vendored wire codec (`codec.ts` AES-256-GCM, `link.ts` envelope + link grammar), `socket.ts` reconnecting relay socket, `client.ts` guest session store (`GuestClient` + immutable snapshots for `useSyncExternalStore`). Shared protocol shapes come from `@oh-my-pi/pi-wire`.
- `src/components/` — `transcript/` (entries, markdown, tool cards), `agents/` (panel + transcript drawer), `shell/` (connect screen, header, composer, banners, toasts).
- `src/tool-render/` — per-tool React renderers shared with coding-agent HTML session exports: one view per built-in tool, common `ToolView` chrome, theme-adaptive `tv-` design tokens, and an `<omp-tool-view>` web-component wrapper. The `ToolRenderHost` seam lets hosts wire agent-id chips to a sub-session view (drawer here, sidebar navigation in exports).
- `scripts/` — `local-relay.ts` (content-blind relay on `Bun.serve`), `mock-host.ts` + `fixture.ts` (scripted host for offline dev), `build-export-viewer.ts` (bundles the tool/trace renderers, React, export shell and styles for embedding in standalone HTML exports).
- `src/dev-workbench/` and `dev-workbench.html` — host-served requirement/stage/material/session UI and same-origin control client; business and execution authority remain in coding-agent.

The standalone GuestClient has no coding-agent runtime dependency and shares protocol shapes through `@oh-my-pi/pi-wire`; sealed-frame interop remains covered by `test/codec.test.ts`. The separate Dev entry may consume coding-agent's shared business types with type-only imports, never its Node/native implementation in the browser. Native models, tools, MCP, extensions, approvals, Team and Goal stay on the OMP host; browser components do not grant permissions or declare execution success.
