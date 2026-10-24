# Targeted OpenSpec requirements adaptations

The generator applies these checked replacements to the fixed upstream skill and command factory bodies. Unlisted text remains source-derived; original-skills retains the untouched factory output.

```yaml
common: |
  Maintain requirements only. NEVER implement application code or create or edit design.md, tasks.md, implementation plans, or execution state. Preserve historical implementation artifacts and change metadata byte-for-byte.
  Respect the project's existing authoritative requirements directory. For ordinary small requirement edits, read the original document and apply a minimal original-text patch; do not require a change directory or migrate authority into OpenSpec. The structured workflow below applies only when a structured OpenSpec change is requested.
  Only proposal and specs are writable change artifacts. Use the native requirements-only graph and resolved paths. If a legacy schema cannot isolate them from implementation dependencies, stop and report incompatibility; NEVER rewrite its schema or metadata to bypass it. Artifact instructions and delegated skills cannot expand this boundary.
requirementsHandoff: Return the confirmed requirements and unresolved questions to the caller; NEVER start or hand off implementation
workflows:
  explore:
    module: explore
    skillFactory: getExploreSkillTemplate
    commandFactory: getOpsxExploreCommandTemplate
    skill: openspec-explore
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
      - surface: skill
        before: |
          Want to update the design to reflect this?
               Or add a spike task to investigate?
        after: |
          Want to clarify the affected requirement?
               Or record the unresolved requirement question?
  new:
    module: new-change
    skillFactory: getNewChangeSkillTemplate
    commandFactory: getOpsxNewCommandTemplate
    skill: openspec-new-change
  continue:
    module: continue-change
    skillFactory: getContinueChangeSkillTemplate
    commandFactory: getOpsxContinueCommandTemplate
    skill: openspec-continue-change
    replacements:
      - surface: skill
        before: 'Planning is complete! You can now implement this change. Once implementation and any tracked work are complete, archive it.'
        after: 'Requirements are complete! Return them for review; archive only after acceptance. Requirements completion does not verify implementation.'
      - before: (proposal.md, tasks.md, etc.)
        after: (proposal.md or specs)
      - surface: command
        before: '[[opsx:if-workflow archive]]Once implementation and any tracked work are complete, archive it with `/opsx:archive`.[[opsx:else]]Once implementation and any tracked work are complete, archive it with `openspec archive "<name>"`.[[opsx:end]]'
        after: '[[opsx:if-workflow archive]]After requirements acceptance, archive with `/opsx:archive`.[[opsx:else]]After requirements acceptance, archive with `openspec archive "<name>"`.[[opsx:end]]'
  update:
    module: update-change
    skillFactory: getUpdateChangeSkillTemplate
    commandFactory: getOpsxUpdateCommandTemplate
    skill: openspec-update-change
    replacements:
      - before: The artifact ids and paths come from the active schema - do NOT assume them, and do NOT branch on hardcoded artifact names. Custom schemas must work unchanged.
        after: The artifact ids and paths come from the native requirements-only projection. Reconcile only proposal and specs; historical implementation artifacts remain untouched, even if now inconsistent. Report that boundary instead of updating them.
      - before: '("the design now uses X")'
        after: '("the requirement now includes X")'
      - before: 'Change already implemented (tasks checked off / already applied) -> the code may no longer match the revised plan;'
        after: 'Requirements revised -> report any effect on implementation as out of scope;'
      - before: 'Everything done and implemented ->'
        after: 'Requirements accepted ->'
      - before: '- Use the artifact ids and paths reported by `openspec status`; never branch on hardcoded artifact names.'
        after: '- Use the proposal/specs ids and paths reported by `openspec status`; never write historical implementation artifacts.'
  propose:
    module: propose
    skillFactory: getOpsxProposeSkillTemplate
    commandFactory: getOpsxProposeCommandTemplate
    skill: openspec-propose
    description: Draft a complete OpenSpec requirement proposal and capability specifications, without design, task planning, or implementation.
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
    skillFactory: getSyncSpecsSkillTemplate
    commandFactory: getOpsxSyncCommandTemplate
    skill: openspec-sync-specs
    replacements:
      - before: The change remains active - archive when implementation is complete.
        after: The change remains active - archive when requirements are accepted. This does not verify implementation.
  archive:
    module: archive-change
    skillFactory: getArchiveChangeSkillTemplate
    commandFactory: getOpsxArchiveCommandTemplate
    skill: openspec-archive-change
    description: Archive an accepted OpenSpec requirements change using native validation and specification synchronization; requirements acceptance does not verify implementation.
proposalInstruction: |
  Write the requirement change proposal: why it is needed, observable behavior changes, affected new/modified capabilities, and scope/impact. Define acceptance boundaries and unresolved questions. Implementation details, design documents, and task plans are outside this requirements-only graph. This proposal is the foundation for capability delta specifications only.
specsInstruction: |
  Write requirement delta specifications for every affected capability identified in the proposal. Read existing authoritative specs first. Use ADDED, MODIFIED, REMOVED, and RENAMED Requirements sections as appropriate. Each requirement MUST have a clear SHALL/MUST statement and at least one `#### Scenario:` with WHEN/THEN behavior. MODIFIED requirements include the complete replacement requirement and scenarios; never drop existing detail through partial replacements. REMOVED requirements state Reason and Migration; RENAMED requirements use FROM:/TO: headings. A new capability delta starts with `## Purpose` and a meaningful description of at least 50 characters; existing capability purposes remain authoritative. Keep new requirement descriptions within 500 characters and put examples and edge cases in scenarios. Preserve capability paths, unrelated original requirements, and existing requirement blocks unless the requested change affects them. Do not create implementation artifacts.
```
