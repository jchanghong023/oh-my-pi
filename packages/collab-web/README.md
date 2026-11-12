# @oh-my-pi/collab-web

Browser interfaces for [omp collab sessions](../../docs/collab.md). The standalone guest app accepts a `/collab` link and shows the shared native session: streaming transcript, tool-call cards, subagent transcripts and a composer. The separate host-served Dev workbench uses the independently copied frontend in `packages/aireq-frontend` and native OMP execution, not this package's guest UI or a second agent engine.

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

### Entry, projects and layout

Run `omp dev` in the target directory, or `/dev` in an ordinary OMP session. Dev prints its complete capability URL. Non-offline entry attempts to open the loopback page; offline entry leaves browser launch manual. Copy the printed URL when needed. `OMP_AIREQ_NO_OPEN=1` explicitly suppresses the opener; it is not evidence that a browser opened.

Entry refuses unsettled ordinary native work rather than silently cancelling it. While Dev owns this instance, ordinary TUI input is disabled; enter `/dev` again to settle Dev and restore the original session. Standalone `omp dev` also accepts the exact stdin line `/dev` for graceful exit; EOF alone does not stop a detached host. Failed settlement retains ownership for an explicit retry. Exiting does not roll back Git or delete materials. Closing a browser is not exiting Dev.

Dev and WebGUI use one in-process web backend per OMP instance, with project ownership exclusion across entries/profiles. Dev's frontend is an independent copy in `packages/aireq-frontend`; Dev changes do not modify the original WebGUI frontend, ordinary OMP or standalone OpenSpec behavior.

The copied native layout has three columns: compact Release/IR/SR navigation, the conversation, and read-only formal materials. Settings retains the copied native configuration surface and adds **Dev projects and Release** (`Dev 项目与 Release`). Register an existing Git working directory on the host; registration does not create a directory or clone a repository. Select projects at the lower left, then create/select a Release. A Release groups requirements; it is not a Git branch.

An IR contains a complete requirement and one or more SRs (system requirements). Small requests still have one SR. Drafts are separate from the confirmed requirement tree. Selecting an IR shows its complete requirement and SR membership, not development stages; selecting an SR shows its actual phase and phase materials. The materials menu exposes available documents, attachments and valid reports; absent or invalidated reports are not presented as completed work. Titles, decomposition and formal content change through native AI conversation, not direct document editing.

### Requirements: local or browser intake

1. Under the selected project and Release, choose **Local new** (`本地新建`) or **Browser new** (`浏览器新建`). Local intake prepares a requirements worktree from the fetched default branch. Browser intake uses host-side draft storage without creating a Git branch, commit or development worktree; it supports a long-lived shared requirements host. Both use the same native conversation and complete IR/SR format.
2. Discuss the substantive requirement with AI, including every SR's content and acceptance criteria; existing materials are inputs to that discussion, not a shortcut past it. Formal documents remain read-only. Stop settles native work without treating an unfinished interview as approved.
3. Confirm the fixed whole IR/SR snapshot. Complete-format checks, an independent native review and explicit human confirmation must all refer to that same version before it becomes a formal confirmed group or a downloadable package. Changes invalidate prior review/confirmation and download eligibility; navigation and chat alone never approve anything.
4. A confirmed group can export an `omp-aireq-requirements` version 1 ZIP containing the complete IR, every SR, referenced materials, file digests, confirmation/review evidence and provenance. It excludes source conversations, native runtime state and credentials. Import **ZIP**, not a loose Markdown document or host-local Markdown path; unsupported versions, incomplete or altered content and unsafe archive entries are rejected.
5. Import into the intended project's Release in the developer's clone. Check project applicability yourself. The target gets its own requirements worktree and retained provenance; import/open does not resume the source chat or start AI/review. Before requirements merge, explicitly send new input to revise an imported copy in a **fresh local native requirements conversation**, seeded with the complete imported IR and all SRs. Actual changes require fresh independent review and human confirmation; the original package and source copy remain unchanged.
6. Publish the exact confirmed requirements and review files through the separate scoped commit/push action. Create the requirements PR manually and register its URL. Dev does not call a hosting-platform PR API; a recorded URL is a human declaration, not platform verification. A missing usable remote is a delivery blocker, not permission to skip the PR.
7. Record the actual requirements merge. Dev fetches the real default branch and verifies the complete confirmed authority/evidence set before freezing the **whole IR and all SRs**. Internal confirmation, push success and a PR URL do not establish merge. After freeze, requirement content and membership cannot change; no automatic source-package synchronization occurs.

### SR development and delivery

Choose a pending SR in a frozen IR and explicitly start development. Dev creates an independent development worktree from the current fetched default branch and supplies the complete frozen requirements. Only **one developing SR per project** is allowed across all Releases, branches and worktrees. Waiting for PR review still holds that slot.

The four phases are **solution → planning → executing → PR**:

- **Solution:** native AI produces the complete technical solution; explicitly approve its exact material version and round.
- **Planning:** produce and explicitly approve the complete development plan against the approved solution.
- **Executing:** perform the real implementation and validation. Completion, UT and ST are separate real reports, retaining failures, unrun checks and limitations. Report text is not proof that a check ran. Explicit approval binds the current complete report set; there is no separate tester-testing phase.
- **PR:** review delivery materials and actual source/test/report changes. Commit/push is a separate explicitly scoped operation using the selected paths and exact file versions; it preserves unrelated staging and reports save, commit and push independently. A failed push retains the successful commit. Create the code PR manually, then register its URL after the actual committed/pushed state is checked.

Human PR/status marks are not implicit commit/push consent. Merge/end checks the actual fetched default branch against the committed source, tests and material changes, including deletions and modes. Only verified code merge ends this SR and releases the project slot. Completion does not delete branches/worktrees, clean files, archive OpenSpec or start post-merge repair/testing; those remain outside this Dev flow.

**Back** is an explicit workflow mutation, unlike viewing old materials. It settles the root and all recursive native work first, preserves code, files and native history, and invalidates affected approvals and downstream reports. Returning from PR to executing is ordinary pre-merge repair with a new round, not a separate repair phase. Failed settlement does not advance the workflow. Completed/merged work cannot be reopened for post-merge editing here.

Delete is limited to an unfrozen IR whose SRs have never started. It settles work and hides the group with a retained deletion record; documents, code, Git history, branches/worktrees, package provenance and native history remain. A previously registered PR may need manual external closure. Delete never rolls changes back or cancels a platform PR.

### Views, persistence and native boundaries

The viewed requirement/phase and actual execution phase are separate. Refreshing, switching projects, selecting historical materials or reopening a page only reads/rebinds current facts; it never approves, resends input, creates a requirement or starts a model. Each page is bound to the exact project, IR/SR, native session, phase and round; stale actions and late events cannot mutate another selection. Unknown submission outcomes must be reconciled from operation receipts, not automatically resent.

Formal requirements and review evidence live under `docs/aireq/requirements/` and `docs/aireq/reviews/`; technical materials and retained material history live under `docs/aireq/development/`. Shared workflow facts and recoverable operation receipts use atomic JSON under the repository's Git common directory (`omp-aireq-workflow-v1`), not Git-tracked runtime records or a Dev SQLite database. Chat remains in native OMP history; Dev does not copy transcripts into business records or ZIPs. Existing native SQLite-backed capabilities keep their own scope.

Shared/NFS storage supports sequential host handoff only. An unknown, crashed or foreign previous owner is a blocker, not proof that a local lock may be stolen. Actual NFS behavior requires separate evidence; a local filesystem run does not establish cross-host safety.

Models, tools, Skills, MCP, extensions, questions, approvals, subagents, Team and Goal stay native on the OMP host. The copied chat and settings retain native capability/error semantics, not fabricated availability. Frozen requirements, restricted folders and phase-specific write scopes apply to tools and recursive agents as well as the browser. The retired terminal sub-actions, loose-Markdown intake, eight-stage state and old Dev-state migration are not compatibility paths.

### Network and lifecycle boundary

- Non-offline service binds loopback. With `OMP_OFFLINE=1`, it binds all interfaces and prints actual loopback and discovered intranet URLs, including the capability prefix. Printing a URL does not prove firewall or remote-browser reachability.
- Keep the complete capability URL private. Dev uses its capability-relative HTTP/WS endpoints, browser cookie, page binding and host/origin/network checks; it does not mount the original WebGUI's routes. This is not SSO or authenticated user identity.
- Native collaboration is an explicit join/leave operation through the existing username/link mechanism, separate from local IR/SR session binding. Opening a page is not joining a room, usernames are routing/display names, and joining does not automatically switch the selected development actor.
- Offline browsers use same-origin HTTP/WS; native Collab relay/encryption stays on the host. This does not change the standalone GuestClient's secure-context and relay requirements above or bypass native tool/confirmation boundaries.
- Closing, refreshing, leaving or losing a browser connection releases only its connection/subscription. Background native work needs the OMP host alive. Reconnection reads facts and receipts without replaying prompts, tools, answers or approvals. Explicit Stop and host exit settle native work.

### Embedded UI resources and acceptance limits

Run repository-root `bun run gen:aireq-workbench` to prepare the copied frontend's production resources. OMP serves the same content-addressed ESM, worker, CSS, font, icon, WASM and public-asset set for all browsers; npm and standalone binary builds embed that production set through the build chain. There is no classic-script/four-file compatibility bundle, runtime frontend compilation, CDN fetch or demo-page fallback. Missing resources are a preparation error. Repository gate commands use their existing defaults: `bun run fastcheck` and `bun run fulltest`.

Firefox 128's default-enabled native capabilities are the minimum runtime and browser technology ceiling. There are no legacy polyfills, API shims, browser-specific fallbacks or alternate legacy builds. Firefox acceptance requires an already-installed Firefox 128, Python Selenium and an existing geckodriver, driving the actual production payload over HTTP(S) in an isolated temporary profile with default capability/security settings. Use `FIREFOX_EXECUTABLE`, `GECKODRIVER_EXECUTABLE` and `PYTHON_EXECUTABLE` to select installed prerequisites; nothing downloads a browser or driver automatically. Record the exact browser executable/version/channel, driver, OS, URL and workflows. Source/build success or a Chrome/Edge run cannot replace that Firefox evidence.

This section describes the current contract, not blanket acceptance results. Source runs, npm artifacts, standalone binaries, phone browsers, desktop opening/input, Chinese IME, company hardware and NFS each need their own observed evidence. Real-provider/live workflow acceptance is separate from fixtures and controlled local Git remotes; neither proves hosting-platform or company approval. The [older plan evidence ledger](../../docs/superpowers/plans/2026-11-07-replace-dev-tui-with-browser-workbench.md#actual-evidence-ledger--2026-11-07-handoff) is **historical only**, not proof of this replacement flow.

Packaged acceptance is separate from source acceptance. `packages/coding-agent/scripts/verify-aireq-workbench-package.ts` requires this build's real `--npm-entry`, `--binary` and `--assets-manifest`; it does not build/release automatically and is not default test discovery. Do not substitute source resources or previous artifact results for the artifacts being delivered.

## Architecture

- `src/lib/` — vendored wire codec (`codec.ts` AES-256-GCM, `link.ts` envelope + link grammar), `socket.ts` reconnecting relay socket, `client.ts` guest session store (`GuestClient` + immutable snapshots for `useSyncExternalStore`). Shared protocol shapes come from `@oh-my-pi/pi-wire`.
- `src/components/` — `transcript/` (entries, markdown, tool cards), `agents/` (panel + transcript drawer), `shell/` (connect screen, header, composer, banners, toasts).
- `src/tool-render/` — per-tool React renderers shared with coding-agent HTML session exports: one view per built-in tool, common `ToolView` chrome, theme-adaptive `tv-` design tokens, and an `<omp-tool-view>` web-component wrapper. The `ToolRenderHost` seam lets hosts wire agent-id chips to a sub-session view (drawer here, sidebar navigation in exports).
- `scripts/` — `local-relay.ts` (content-blind relay on `Bun.serve`), `mock-host.ts` + `fixture.ts` (scripted host for offline dev), `build-export-viewer.ts` (bundles the tool/trace renderers, React, export shell and styles for embedding in standalone HTML exports).
- `../aireq-frontend/` — independently copied native browser frontend, adapted only there for Dev navigation, materials, chat and settings; `../coding-agent/src/aireq-workbench/` owns the host, workflow authority, native bindings and embedded-resource delivery. The standalone guest app does not build or serve this entry.

The standalone GuestClient has no coding-agent runtime dependency and shares protocol shapes through `@oh-my-pi/pi-wire`; sealed-frame interop remains covered by `test/codec.test.ts`. Dev's separate copied frontend may use coding-agent's neutral workflow types, never its Node/native implementation in the browser. Native models, tools, MCP, extensions, approvals, Team and Goal stay on the OMP host; browser components do not grant permissions or declare execution success.
