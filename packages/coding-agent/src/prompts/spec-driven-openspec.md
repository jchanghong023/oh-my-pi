# Targeted OpenSpec requirements adaptations

The generator applies these checked replacements to fixed upstream factory bodies. Unlisted text remains source-derived. OpenSpec is distributed as six builtin `opsx-*` skills with Chinese descriptions. Names and descriptions enter the model's default skill catalog only when the session working directory directly contains an `openspec/` directory; bodies are read on demand without prior explicit invocation there. Elsewhere these skills remain manual-only. `/skill:opsx-*` remains available; `/dev` phase restrictions still apply. Init/update never install project-local skills or command templates.

```yaml
common: |
  Maintain requirements only. NEVER implement application code or create or edit design.md, tasks.md, implementation plans, or execution state. Preserve historical implementation artifacts and change metadata byte-for-byte.
  Respect the project's existing authoritative requirements directory. For ordinary small requirement edits, read the original document and apply a minimal original-text patch; do not require a change directory or migrate authority into OpenSpec. The structured workflow below applies only when a structured OpenSpec change is requested.
  Only proposal and specs are writable change artifacts. Use the native requirements-only graph and resolved paths. If a legacy schema cannot isolate them from implementation dependencies, stop and report incompatibility; NEVER rewrite its schema or metadata to bypass it. Artifact instructions and delegated skills cannot expand this boundary.
  OpenSpec is an independent requirements lifecycle. Requirements acceptance means accepted requirements, not implemented or tested software. NEVER require /spec, OMP controller state, approval versions, implementation plans, Team, sourceMap, or exact-patch APIs. Documentation-only requirements work does not require software tests.
requirementsHandoff: Requirements are ready for review; implementation is outside this workflow.
workflows:
  explore:
    module: explore
    commandFactory: getOpsxExploreCommandTemplate
    description: 研究项目与问题，澄清需求和验收边界；不实施代码。
    replacements:
      - before: The work happens from that change, never from explore mode.
        after: Requirements work continues in that change; implementation is outside this workflow.
      - before: (proposals, designs, specs)
        after: (proposals and specs)
      - before: '| Design decision made       | `design.md`                       |'
        after: '| Requirement decision made  | `specs/<capability-path>/spec.md` |'
      - before: '| New work identified        | `tasks.md`                        |'
        after: '| New requirement identified | `specs/<capability-path>/spec.md` |'
      - before: '"That''s a design decision. Capture it in design.md?"'
        after: '"That changes a requirement. Capture it in specs?"'
      - before: '"Updated the design with these decisions"'
        after: '"Updated the requirements with these decisions"'
  update:
    module: update-change
    commandFactory: getOpsxUpdateCommandTemplate
    description: 修订或继续已有 OpenSpec 需求变更，补齐已确认范围内的提案与能力规格；不实施代码。
    replacements:
      - before: Revise a change's existing planning artifacts and keep them coherent. Never edit code.
        after: Revise or resume an existing requirements change. Reconcile existing proposal and specs and complete requested missing requirement artifacts within confirmed scope. NEVER edit implementation code or historical design/tasks.
      - before: '[[opsx:if-workflow continue]]This workflow revises artifacts that already exist; `/opsx:continue` is what creates the ones that do not.[[opsx:else]]This workflow revises artifacts that already exist; it never creates missing ones. When an artifact is missing, `openspec status --change "<name>" --json` names the next one and `openspec instructions "<artifact-id>" --change "<name>" --json` explains how to write it.[[opsx:end]]'
        after: This workflow also resumes unfinished changes. Use native status and artifact instructions to create confirmed missing proposal/specs in dependency order; NEVER hand off missing requirement artifacts to another workflow.
      - before: The artifact ids and paths come from the active schema - do NOT assume them, and do NOT branch on hardcoded artifact names. Custom schemas must work unchanged.
        after: The artifact ids and paths come from the native requirements-only projection. Reconcile only proposal and specs; historical implementation artifacts remain untouched, even if now inconsistent. Report that boundary instead of updating them.
      - before: 'The files to edit are `artifactPaths.<id>.existingOutputPaths` - the concrete files that exist on disk, already glob-expanded for glob artifacts (e.g. `specs/**/*.md`), plus any confirmed concrete path allowed under a partly populated glob artifact (step 4). Do NOT write to `resolvedOutputPath`: for a glob artifact it is still the glob pattern, not a real file.'
        after: 'Existing files come from `artifactPaths.<id>.existingOutputPaths`. New requirement files use confirmed concrete paths allowed by native artifact instructions and `artifactPaths.<id>.outputPath`, including empty and partly populated artifacts (step 4). NEVER write to a glob `resolvedOutputPath`.'
      - before: '("the design now uses X")'
        after: '("the requirement now includes X")'
      - before: '- Read the artifact(s) the request touches and the change''s other existing artifacts.'
        after: '- Read the requested requirement artifacts and existing proposal/specs. Use project requirements authority and relevant source context to ground scope and acceptance scenarios; NEVER reconcile historical design/tasks.'
      - before: 'Build order is a useful reading order, not a constraint on which artifacts may be revised.'
        after: 'Existing requirement artifacts may be revised in either direction; missing artifacts MUST be created in native dependency order.'
      - before: 'Propose revisions to files that already exist (`existingOutputPaths`). If an artifact has no existing output files and status `ready` or `blocked`, note it and [[opsx:if-workflow continue]]point the user to `/opsx:continue` to create them[[opsx:else]]point the user to `openspec instructions "<artifact-id>" --change "<name>" --json` for how to create them[[opsx:end]]. Leave `skipped` artifacts untouched; do not treat them as missing or defer them to the continue workflow.'
        after: 'Propose revisions to existing proposal/specs and completion of requested missing requirement artifacts. Walk the `requires` edges in `openspec status --change "<name>" --json` transitively, including edges on `done` artifacts: file-existence status does not prove dependencies exist. Include a missing proposal prerequisite before specs when within the confirmed requirement scope; if a prerequisite is outside that scope, obtain explicit confirmation before any dependent write. NEVER write a blocked dependent before its non-skipped prerequisites exist. Leave `skipped` artifacts untouched and NEVER create design/tasks or implementation dependencies; report incompatible graphs instead.'
      - before: 'A glob artifact (e.g. `specs/**/*.md`) is marked `done` after at least one file matches, and the continue workflow only handles `ready` artifacts. When reconciliation identifies a missing file for a glob artifact whose `existingOutputPaths` is non-empty:'
        after: 'A glob artifact (e.g. `specs/**/*.md`) is marked `done` after one match, so also identify requested missing capability files under partly populated specs. For every missing proposal/specs file, whether its artifact is empty or partly populated:'
      - before: 'Run `openspec instructions "<artifact-id>" --change "<name>" --json` and use its `instruction` and `template`. Treat `context` and `rules` as constraints; do not copy them into the file. If instructions report `skipped: true`, do not create the file. Read current dependency files from disk; if a required non-skipped dependency is missing, stop and ask the user to restore it first.'
        after: 'Run `openspec instructions "<artifact-id>" --change "<name>" --json` and use its `instruction` and `template`. Treat `context` and `rules` as constraints, not file content. If instructions report `skipped: true`, NEVER create the file. Read current dependency files from disk. Draft missing in-scope proposal/specs prerequisites first using their own native instructions; create them only in step 5 after confirmation, refresh status, and then obtain dependent instructions. Out-of-scope or incompatible prerequisites block the dependent, not unrelated confirmed work.'
      - before: 'Choose a concrete path inside `changeRoot` that matches `artifactPaths.<id>.outputPath` and does not already exist. Verify it remains inside `changeRoot` after resolving any symlinked parent directories. The glob `resolvedOutputPath` is not a valid target.'
        after: 'Choose a concrete path inside the selected-store-aware `changeRoot` that matches `artifactPaths.<id>.outputPath` and native instructions and does not already exist. Resolve symlinked parents and verify containment inside that `changeRoot`; NEVER fall back to a repo-local root or write a glob `resolvedOutputPath`.'
      - before: 'After confirmation, immediately before creation, refresh status and instructions. Verify the artifact is still in scope, not skipped, and partially populated; repeat the concrete-path checks above.'
        after: 'After confirmation, immediately before each creation, refresh native status and instructions. Verify the artifact remains in confirmed scope, not skipped, and all non-skipped `requires` prerequisites exist on disk; NEVER write while blocked. Repeat selected-store root and concrete-path containment checks. A changed draft, dependency, or path requires reconciling and confirming the affected scope again.'
      - before: '- If the change is already coherent, say so and propose no revisions.'
        after: '- If existing requirements are coherent and every requested non-skipped requirement artifact exists, say so and propose no revisions. Coherence alone does not complete an unfinished change.'
      - before: '- Show each proposed revision and why - including the requested edit drafted in step 4. Write only after the user confirms.'
        after: '- Show each proposed requirement revision or creation, exact concrete paths, missing prerequisites, and why, including step 4 drafts. Write only within explicit user-confirmed requirements scope. Apply confirmed missing prerequisites before their dependents; refresh status and instructions between creations. A rejected prerequisite blocks dependent creation; NEVER silently expand scope.'
      - before: |
          6. **Point to the next step (guidance only - NEVER act on it)**
             - Artifacts with empty `existingOutputPaths` and status `ready` or `blocked` -> [[opsx:if-workflow continue]]suggest `/opsx:continue` to create them[[opsx:else]]run `openspec status --change "<name>" --json` for the next artifact and point the user to `openspec instructions "<artifact-id>" --change "<name>" --json` for how to create it[[opsx:end]].
             - Change already implemented (tasks checked off / already applied) -> the code may no longer match the revised plan; [[opsx:if-workflow apply]]suggest `/opsx:apply` to carry the delta into code[[opsx:else]]say that the code may need updating and offer to carry the delta into it[[opsx:end]].
             - Everything done and implemented -> [[opsx:if-workflow archive]]suggest `/opsx:archive`[[opsx:else]]suggest archiving with `openspec archive "<name>"`[[opsx:end]].
        after: |
          6. **Report requirement readiness (guidance only)**
             - Refresh native status and check requested concrete requirement files, including missing files under a `done` glob artifact. Complete confirmed in-scope missing proposal/specs through steps 4–5 before returning; report rejected or out-of-scope prerequisites and incompatible graphs precisely.
             - Unfinished work can resume with `/opsx:update <name>`; NEVER create a second change merely to finish missing artifacts.
             - Requirements ready for review -> report readiness, not implementation completion. After explicit requirements acceptance, suggest `/opsx:archive`; NEVER implement or alter historical implementation state.
      - before: '- Any file created under a glob artifact that was already partially populated'
        after: '- Every proposal/specs file created, including missing files under partly populated glob artifacts'
      - before: '- [[opsx:if-workflow continue]]Anything deferred to `/opsx:continue` (artifacts with no files yet and status `ready` or `blocked`, never `skipped` artifacts)[[opsx:else]]Anything deferred because it does not exist yet (artifacts with no files and status `ready` or `blocked`, never `skipped` artifacts)[[opsx:end]]'
        after: '- Any requested requirement artifact left incomplete, its exact prerequisite or confirmation blocker, and how `/opsx:update <name>` resumes it; skipped artifacts are not missing'
      - before: '- Planning artifacts only - NEVER edit implementation code. If the revised plan implies code changes, [[opsx:if-workflow apply]]stop and point to `/opsx:apply`[[opsx:else]]stop and say that the revised plan now implies code changes; implementing them is a separate step[[opsx:end]].'
        after: '- Requirements only. NEVER edit implementation code, design/tasks, metadata, or implementation state. Report implementation implications as out of scope.'
      - before: '- Use the artifact ids and paths reported by `openspec status`; never branch on hardcoded artifact names.'
        after: '- Use native proposal/specs ids, `requires` edges, and selected-store paths reported by `openspec status`; NEVER write historical implementation artifacts.'
      - before: '- Edit only the concrete files in `existingOutputPaths`, plus any confirmed concrete path allowed under a partly populated glob artifact (step 4); never write to a glob `resolvedOutputPath`.'
        after: '- Edit only native concrete proposal/specs files and explicitly confirmed missing requirement paths allowed by step 4, including empty or partly populated artifacts. NEVER write a glob `resolvedOutputPath` or escape the selected `changeRoot`.'
      - before: '- Do not advance the build frontier: if an artifact has empty `existingOutputPaths` and status `ready` or `blocked`, [[opsx:if-workflow continue]]that is `/opsx:continue`''s job[[opsx:else]]creating them is a separate step, outside this workflow[[opsx:end]]. Leave `skipped` artifacts untouched. The only new-file scope is a confirmed concrete path under a glob artifact whose `existingOutputPaths` is non-empty.'
        after: '- Complete confirmed missing proposal/specs using native instructions and `requires` dependency order. NEVER create skipped artifacts, blocked dependents, historical design/tasks, or files outside confirmed requirements scope.'
      - before: '[[opsx:if-workflow new]]recommend starting fresh with `/opsx:new` (the "Update vs. Start Fresh" heuristic)[[opsx:else]]ask for a distinct unused change name and recommend `openspec new change "<new-change-name>"` instead (the "Update vs. Start Fresh" heuristic)[[opsx:end]]'
        after: 'recommend `/opsx:propose` with a distinct unused change name for the intentionally different requirements; ordinary missing artifacts belong in this existing change'
  propose:
    module: propose
    commandFactory: getOpsxProposeCommandTemplate
    description: 为新需求生成 OpenSpec 提案与能力规格；不生成设计、任务计划或代码。
    replacements:
      - before: Wait for a new user request after the artifacts are presented; then start the apply workflow.
        after: Return requirements for review; implementation is outside this workflow, including on a later request.
      - before: |
          - design.md (how)
          - tasks.md (implementation steps)
        after: ''
      - before: When the user is ready to implement, they must start the apply workflow explicitly.
        after: Requirements completion is not implementation completion; return the requirements to the caller.
      - before: '- `applyRequires`: array of artifact IDs needed before implementation (e.g., `["tasks"]`)'
        after: '- Only proposal and specs belong to the required set; implementation readiness is outside this graph'
      - before: Ground scope, approach, and tasks in what you find.
        after: Ground requirement scope and acceptance scenarios in what you find.
      - before: 'Do this discovery now, rather than leaving generic "explore the codebase" or "make a plan" tasks for implementation. Keep any necessary follow-up investigation specific to an unresolved question.'
        after: Do this discovery now; keep any necessary follow-up investigation specific to an unresolved requirement question.
      - before: '**Continue until every artifact in the required set exists (not just `apply.requires`)**'
        after: '**Continue until every requirement artifact in the required set exists**'
      - before: 'The required set is `applyRequires` plus every artifact reachable from those by following the `requires` edges in `status --json` - walk them transitively (spec-driven closes over proposal, specs, design, tasks). Leave artifacts outside that set alone'
        after: The required set is proposal and specs, using their native requires edges in status --json. Leave every historical implementation artifact alone
      - before: '`status` is file-existence only, so an `applyRequires` artifact reading `done` does NOT mean its dependencies exist - writing `tasks.md` early marks `tasks` done while `specs` was never written. Use each artifact''s `requires` edges, not its `status`, to build the required set: a `done` artifact still lists what it depends on'
        after: '`status` is file-existence only: a `done` artifact still lists what it depends on. Verify proposal and specs exist using their native dependency edges, not implementation readiness'
      - before: 'Spec-driven''s `design.md` qualifies; `specs` qualifies only via the `skipped` status above, never by your own judgment.'
        after: '`specs` qualifies only via the `skipped` status above, never by your own judgment.'
      - before: 'All artifacts needed for implementation are ready.'
        after: 'The requirement artifacts are ready for review; implementation is not verified.'
      - before: 'After presenting the artifacts, stop and wait for a new user request to start the apply workflow'
        after: After presenting the requirement artifacts, stop and return them to the caller; NEVER start an implementation workflow
      - before: '- Create every artifact the apply phase transitively depends on, not just the ids listed in `apply.requires`'
        after: '- Create proposal and specs in native dependency order; no implementation artifacts'
  sync:
    module: sync-specs
    commandFactory: getOpsxSyncCommandTemplate
    description: 将 OpenSpec 变更中的增量规格同步到项目已有的正式需求；不归档、不宣称实现通过验收。
    replacements:
      - before: |
          The JSON includes `planningHome.root`. Main specs live under `<planningHome.root>/openspec/specs/` — use that (store-aware) root for every main-spec path below, not a hardcoded repo path. When a store is selected it points at the store, not the current repository.
        after: |
          The JSON includes `planningHome.root`; preserve that store-aware root for native OpenSpec paths.

             Resolve the authoritative requirements destination before assessing or writing specs:
             - Read applicable project instructions and the user's explicit requirements-authority choice. Existing authoritative Markdown outside `openspec/specs/` (for example `docs/requirements/`) selects the external-Markdown branch. NEVER create a parallel authority in `openspec/specs/`.
             - Otherwise use the native branch at `<planningHome.root>/openspec/specs/<capability-path>/spec.md`, preserving complete capability paths and selected-store scope.
             - If the authority is missing, conflicting, or ambiguous, ask the user to resolve it before writing. A selected store resolves OpenSpec paths; it does not silently override the project's declared requirements authority.
      - before: |
          Then sync only the named paths and leave the remaining delta specs untouched:
             bulk archive excludes a delta whose implementation it could not find, and
             syncing it anyway would write a main spec the caller deliberately withheld.
        after: |
          Then sync only the named paths and leave the remaining delta specs untouched.
             NEVER widen a caller's confirmed requirements scope.
      - before: |
          For each capability delta spec path selected in step 3 — the full `existingOutputPaths` list, or the narrowed subset when a caller supplied one (these may belong to a selected store, not the repo):
        after: |
          **External-Markdown branch:** This is an agent-driven original-text editing workflow, not a programmatic Markdown merger.
             - Read every selected delta and the authoritative documents. Map each ADDED, MODIFIED, REMOVED, or RENAMED requirement to an exact document path, existing heading, and original text. For ADDED requirements, identify the exact insertion heading and surrounding original text; for a new document, obtain explicit confirmation of its path and authoritative role.
             - Show the requirement-to-document mapping and intended original-text patches before writes. Resolve missing or ambiguous targets, conflicting deltas, and unconfirmed scope with the user before any write. A prior explicit confirmation of these exact patches is sufficient; NEVER invent a missing MODIFIED/RENAMED target.
             - Apply only the confirmed requirements changes. Merge scenarios semantically, preserving unaffected scenarios, ordering, formatting, headings, and unrelated text. REMOVED deletes only the confirmed requirement text; RENAMED changes only the mapped name and confirmed references. NEVER apply native capability-file retirement rules to an external document or rewrite it into the native Main Spec Format Reference.
             - Reread every written document and compare against its original text and confirmed patches. Verify every selected delta's intended requirement/scenario outcome and exact preservation of all unrelated content. Re-running must produce no additional change. Report mismatches and stop; NEVER claim sync succeeded with unresolved differences.
             - Do not write mirror specs under `openspec/specs/`. Native `validate --specs` cannot validate external Markdown; do not use it as evidence for these documents. After the content checks, proceed directly to step 6.

             **Native branch only:** The remainder of step 4, step 5, and the Main Spec Format Reference apply only when native OpenSpec specs are authoritative. Preserve the existing semantic merge, Purpose, missing-capability, scenario-preservation, and capability-retirement rules below.

             For each capability delta spec path selected in step 3 — the full `existingOutputPaths` list, or the narrowed subset when a caller supplied one (these may belong to a selected store, not the repo):
      - before: |
          **Main Spec Format Reference**

          Main specs are what the delta merges INTO.
        after: |
          **Main Spec Format Reference (native branch only)**

          Main specs are what the delta merges INTO.
      - before: '- Never copy a delta file into a main spec as-is - merge its content so the main spec keeps the Main Spec Format Reference structure, with no delta operation headers'
        after: '- Never copy a delta file into authoritative requirements as-is. Native specs keep the Main Spec Format Reference; external Markdown keeps its existing document structure and confirmed original-text patches.'
      - before: '- A MODIFIED block carries the whole requirement - body plus every scenario that survives the change. `openspec validate` and `openspec archive` both reject one that drops a scenario the main spec still has.'
        after: '- A MODIFIED block carries the whole requirement, including every surviving scenario. Preserve unaffected scenarios in both branches. Native validation checks OpenSpec files only; external Markdown requires the explicit reread and original-text comparison above.'
      - before: The change remains active - archive when implementation is complete.
        after: The change remains active - archive when requirements are accepted. This does not verify implementation.
  archive:
    module: archive-change
    commandFactory: getOpsxArchiveCommandTemplate
    description: 使用原生校验与规格同步归档已接受的 OpenSpec 需求变更；归档不代表软件实现通过验收。
    replacements:
      - before: Archive a completed change in the experimental workflow.
        after: Archive an accepted requirements change. Requirements acceptance does not establish implementation delivery.
      - before: |
          **If delta specs exist:**
             - Compare each delta spec with its corresponding main spec at `<planningHome.root>/openspec/specs/<capability-path>/spec.md` (use the store-aware `planningHome.root` from step 2, not a hardcoded repo path)
        after: |
          **If delta specs exist, resolve requirements authority first:**
             - Use applicable project instructions and the user's explicit authority choice. Existing authoritative Markdown outside `openspec/specs/` selects the external-Markdown branch. If authority is unclear or conflicting, ask before writes; NEVER silently relocate authority, including when a store is selected.
             - External-Markdown assessment: read all deltas and authoritative documents; map each requirement to exact document + heading + original text (ADDED uses an exact insertion heading and surrounding text). Show intended original-text patches and resolve missing/ambiguous targets and scope before writes. Mark unresolved mappings sync-blocked; determine whether confirmed changes are needed or already present. NEVER create mirror native specs.
             - Native assessment only: compare each delta with `<planningHome.root>/openspec/specs/<capability-path>/spec.md`, using the store-aware root. The following missing-spec and retirement bullets apply only to this native branch; external Markdown retains its own document structure and is never retired using native capability-file rules.
      - before: |
          After the sync writes each main spec, verify its structure against the canonical sync contract:
        after: |
          **External-Markdown post-sync verification:** Reread every written authoritative document. Check each selected delta against its exact mapped heading and confirmed original-text patch; verify intended requirement/scenario outcomes and exact preservation of unrelated text, unaffected scenarios, ordering, formatting, and headings. A second assessment must find nothing left to apply. Any unresolved mapping, difference, or incomplete sync MUST stop archive. No native mirror files, native formatting conversion, software tests, or /spec APIs are required. After successful checks, proceed directly to step 5; the remaining native structure/comparison checks below do not apply to external Markdown.

             **Native branch only:** After the sync writes each main spec, verify its structure against the canonical sync contract:
      - before: |
          Create an `archive` directory under `planningHome.changesDir` if it doesn't exist:
             ```bash
             mkdir -p "<planningHome.changesDir>/archive"
             ```

             Generate the target name: use the change name as-is when it already starts with a `YYYY-MM-DD-` prefix; otherwise prepend the current date as `YYYY-MM-DD-<change-name>`. Never stack a second date (same rule as `openspec archive`).

             **Check if target already exists:**
             - If yes: Fail with error, suggest renaming existing archive or using different date
             - If no: Move `changeRoot` to the archive directory

             ```bash
             mv "<changeRoot>" "<planningHome.changesDir>/archive/<target-name>"
             ```
        after: |
          After any requested inline sync has finished and its branch-specific verification passed, run the native archive command:
             ```bash
             openspec archive "<name>" --skip-specs --yes
             ```
             Append the selected `--store <id>` when applicable. Use this command for every archive route: already synced, user chose to skip sync, no delta specs, and external-Markdown authority. `--skip-specs` prevents a second native merge or a parallel authority; it does not disable native archive validation. `--yes` follows the explicit choices already collected above.

             Retain native validation. NEVER pass `--no-validate`, hand-create archive directories, or move `changeRoot` yourself. Artifact existence/status is not validation. A nonzero exit means the change was NOT archived: report the CLI error, leave the change active, and do not emit a completion summary. Only a zero exit permits step 6; use the archive path actually reported by the CLI.
      - before: '- Don''t block archive on warnings - just inform and confirm'
        after: '- Advisory warnings require informed user confirmation; native archive validation failures block archiving even after confirmation.'
      - before: |
          **Output On Success**

          ```markdown
          ## Archive Complete

          **Change:** <change-name>
          **Schema:** <schema-name>
          **Archived to:** the archive path derived from `planningHome.changesDir`/<target-name>/
        after: |
          **Output On Success**

          ```markdown
          ## Archive Complete

          **Change:** <change-name>
          **Schema:** <schema-name>
          **Archived to:** <path reported by successful native archive>
      - before: |
          **Output On Success (No Delta Specs)**

          ```markdown
          ## Archive Complete

          **Change:** <change-name>
          **Schema:** <schema-name>
          **Archived to:** the archive path derived from `planningHome.changesDir`/<target-name>/
        after: |
          **Output On Success (No Delta Specs)**

          ```markdown
          ## Archive Complete

          **Change:** <change-name>
          **Schema:** <schema-name>
          **Archived to:** <path reported by successful native archive>
      - before: |
          **Output On Success With Warnings**

          ```markdown
          ## Archive Complete (with warnings)

          **Change:** <change-name>
          **Schema:** <schema-name>
          **Archived to:** the archive path derived from `planningHome.changesDir`/<target-name>/
        after: |
          **Output On Success With Warnings**

          ```markdown
          ## Archive Complete (with warnings)

          **Change:** <change-name>
          **Schema:** <schema-name>
          **Archived to:** <path reported by successful native archive>
      - before: |
          **Output On Error (Archive Exists)**

          ```markdown
          ## Archive Failed

          **Change:** <change-name>
          **Target:** the archive path derived from `planningHome.changesDir`/<target-name>/
        after: |
          **Output On Error (Archive Exists)**

          ```markdown
          ## Archive Failed

          **Change:** <change-name>
          **Target:** <conflicting target reported by native archive>
  verify:
    module: verify-change
    commandFactory: getOpsxVerifyCommandTemplate
    description: 对照 OpenSpec 变更产物核对实际实现与验证证据，报告缺失和不一致；不修改代码或批准状态。
proposalInstruction: |
  Write the requirement change proposal: why it is needed, observable behavior changes, affected new/modified capabilities, and scope/impact. Define acceptance boundaries and unresolved questions. Implementation details, design documents, and task plans are outside this requirements-only graph. This proposal is the foundation for capability delta specifications only.
specsInstruction: |
  Write requirement delta specifications for every affected capability identified in the proposal. Read existing authoritative specs first. Use ADDED, MODIFIED, REMOVED, and RENAMED Requirements sections as appropriate. Each requirement MUST have a clear SHALL/MUST statement and at least one `#### Scenario:` with WHEN/THEN behavior. MODIFIED requirements include the complete replacement requirement and scenarios; never drop existing detail through partial replacements. REMOVED requirements state Reason and Migration; RENAMED requirements use FROM:/TO: headings. A new capability delta starts with `## Purpose` and a meaningful description of at least 50 characters; existing capability purposes remain authoritative. Keep new requirement descriptions within 500 characters and put examples and edge cases in scenarios. Preserve capability paths, unrelated original requirements, and existing requirement blocks unless the requested change affects them. Do not create implementation artifacts.
```
