# OMP method and agent adapters

These adaptations belong to OMP, not upstream. The generator maps dispatch agents in ordinary and role-effective resources: implementation uses `task`, code review uses `reviewer`. Other method patches apply only to role-effective copies. Upstream original bytes remain separate. Section anchors are fail-closed against source drift; referenced files retain their relative layout. No solution-stage upstream method is invented.

```yaml
adaptation: omp-four-role-v1
agents:
  superpowers/skills/brainstorming/builder-check-prompt.md: task
  superpowers/skills/dispatching-parallel-agents/SKILL.md: task
  superpowers/skills/requesting-code-review/SKILL.md: reviewer
  superpowers/skills/requesting-code-review/code-reviewer.md: reviewer
  superpowers/skills/subagent-driven-development/implementer-prompt.md: task
  superpowers/skills/subagent-driven-development/task-reviewer-prompt.md: reviewer
  superpowers/skills/subagent-driven-development/re-review-prompt.md: reviewer
methods:
  - { source: jch, name: jch-grill-me, roles: [requirements] }
  - { source: superpowers, name: brainstorming, roles: [requirements] }
  - { source: superpowers, name: writing-plans, roles: [planner] }
  - { source: superpowers, name: subagent-driven-development, roles: [executor] }
  - { source: superpowers, name: test-driven-development, roles: [executor] }
  - { source: superpowers, name: systematic-debugging, roles: [executor] }
  - { source: superpowers, name: verification-before-completion, roles: [executor] }
  - { source: superpowers, name: requesting-code-review, roles: [reviewer, executor] }
files:
  jch/skills/jch-grill-me/SKILL.md:
    - before: "description: Thoroughly examine the user's plan or design through one-at-a-time questions and recommended answers, resolving each decision and its dependencies. Only explicit user invocation is allowed; do not trigger in any other situation."
      after: 'description: OMP requirements-role interview; ask the complete ready decision frontier with reasoned recommendations, write requirements, and await explicit approval. Only the current authorized requirements handoff enables this branch.'
    - before: "Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, etc.), dispatch a sub-agent to find it; don't ask the user for anything you could look up yourself. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report; ask the rest of the frontier now. The _decisions_ are the user's: put each to them and wait."
      after: "Finding _facts_ is your job, never the user's. Use currently permitted read-only tools, including Wiki and Repo, before asking factual questions; delegate read-only research only if this role's native permissions permit it. A running exploration is an unsettled prerequisite: defer only dependent questions and ask the rest of the frontier now. The _decisions_ are the user's: put each to them and wait."
    - before: "Word each question so \"yes\" accepts your recommended answer."
      after: "Word each question so \"yes\" accepts your recommended answer. Give the reason and relevant tradeoff for each recommendation. Accept numbered answers or acceptance of all recommendations in this round. A clarification of a current question remains in the same round: clarify it without reopening settled decisions or asking questions that depend on its still-unsettled answer."
    - before: "The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the user confirms you have reached a shared understanding."
      after: "When the frontier is empty, write readable OpenSpec proposal/specs through the host's requirements artifact interface: goals, scope and exclusions, constraints, stable requirement IDs, acceptance scenarios, and key decisions. Present these authoritative artifacts for explicit user approval; shared understanding or an empty frontier is not approval. NEVER add a competing requirements.md. Do not implement, select a solution, create an implementation plan, commit, or execute commands. After explicit approval, return control to the host for the real requirements-to-solution handoff; do not take over the workflow."
  jch/skills/jch-grill-me/agents/openai.yaml:
    - before: 'short_description: "Manual invocation only; examine decisions and dependencies in a plan or design one at a time"'
      after: 'short_description: "Authorized OMP requirements role; interview the complete ready frontier and write requirements for approval"'
    - before: 'default_prompt: "Use $jch-grill-me to ask one question at a time and provide a reasoned recommendation with its tradeoffs; clarify and summarize only, without executing the plan."'
      after: 'default_prompt: "Use $jch-grill-me in the authorized requirements role: ask every currently ready decision in numbered rounds with reasoned recommendations; accept numbered answers or all recommendations, clarify within the same round, defer dependent questions, and never repeat settled decisions. Find facts with permitted read-only tools. Write goals, scope, constraints, stable requirement IDs, acceptance scenarios and key decisions to OpenSpec proposal/specs; require explicit user approval and return to the host without implementation or workflow takeover."'
  superpowers/skills/brainstorming/SKILL.md:
    - start: 'description:'
      end: "---\n\n# Brainstorming"
      body: "description: Authorized OMP requirements-role exploration, coordinated with the full-frontier Grill-me interview; no solution selection or implementation.\n"
    - start: '- **Everything that matters is in the request**'
      end: '## Look Before You Ask'
      body: |
        - **Everything that matters is already confirmed:** reuse it; do not repeat a complete brainstorming interview.
        - **Something material is missing:** explore only that gap with the requirements interview below.

        You MUST remain in requirements exploration. Do not implement even a quick task, spike, prototype, or opt-out request. The host owns stage transitions. Solution comparison and implementation planning occur only after requirements approval in their own roles.

    - start: '## Your First Message'
      end: '## The Conversation'
      body: |
        ## Your First Message

        Briefly reflect the user's goals and relevant researched facts. Identify only unsettled decisions. Coordinate with the controlled jch-grill-me interview: ask the entire currently ready decision frontier in one numbered round, with a recommended answer, reason, and tradeoff for each question. Accept numbered answers or acceptance of all recommendations. Do not ask facts available through authorized read-only tools.

    - start: 'Each message ends with one question:'
      end: 'Be clear and concise.'
      body: |
        Each round includes every decision whose prerequisites are settled. Questions depending on an answer still open in this round wait for a later round. Clarify a current question within its existing round; do not reopen settled decisions or restart the interview. Use plain language matching your human partner's vocabulary.

    - start: '**How it gets made.**'
      end: '**Ground to cover.**'
      body: |
        **How it gets made.** Record confirmed requirements-level constraints and current platform, tools, materials, resources and existing-work facts. Distinguish facts from user-imposed constraints. Disclose unresolved implementation defaults only as proposals in OpenSpec proposal/specs, never as agreed decisions or choices in a design document. Defer implementation choice to the host's solution gate after requirements approval.

    - start: '**Offer recon.**'
      end: '## Play It Back'
      body: |
        **Research facts.** Use authorized read-only project, Wiki, Repo, and other tools to settle facts before asking. Do not run commands, start visual-companion servers, create prototypes, or dispatch builders in this role.

        **Separate what from how.** Explore goals, constraints, and acceptance behavior. Record user-imposed technical constraints without inventing or selecting an implementation approach. The host's solution role compares approaches after the written requirements are approved.

    - start: 'Before you send a chunk, check it:'
      body: |
        ## Written Requirements and Approval

        Once all material decisions are settled, write the authoritative OpenSpec proposal/specs: intent, goals, scope, exclusions, constraints, stable requirement IDs, observable acceptance scenarios, and key decisions. Label proposals versus confirmed decisions. Do not create requirements.md, a second design document, implementation plan, commits, builder check, or visual companion.

        Present the written requirements and wait for explicit user approval. Corrections return only affected decisions to the frontier. Do not invoke writing-plans or advance stages yourself. After approval, the host obtains this producer session's real handoff and admits the solution role.
  superpowers/skills/writing-plans/SKILL.md:
    - before: 'description: Use when you have a spec or requirements for a multi-step task, before touching code'
      after: 'description: Authorized OMP planner role; turn approved requirements and the selected solution into the unique host plan, then await its approval.'
    - start: '**Context:**'
      end: '## File Structure'
      body: |
        **Authority:** Read the approved requirements, selected solution verbatim, adoption conditions, and real predecessor handoff. Reuse their decisions; do not restart brainstorming or choose another solution.

        **Output:** Return one complete structured plan through the host's plan interface for the supplied uniquePlanPath under docs/superpowers/plans/YYYY-MM-DD-<feature-name>.md. The host stores machine task projections and approvals in its runtime JSON, NEVER Markdown comments. Do not create another plan, commit, run commands, create worktrees, or implement. Include stable parent-task IDs, acceptance coverage, dependencies, exact interfaces, and native workspace/integration intent. Task-local refinements retain their parent IDs and cannot create another completion ledger.

    - before: '> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.'
      after: '> **For agentic workers:** The host owns approval, native execution and task status. The executor may implement directly or delegate natively using authorized controlled methods. Checkboxes are presentation, never completion evidence.'
    - start: '## Execution Handoff'
      body: |
        ## Execution Handoff

        Preserve the author self-review above. Return the unique plan to the host with requirements/solution version bindings and all adoption conditions covered. Present it for explicit developer approval and wait; do not start execution yourself. On /dev revise-plan <plan-version> <instructions...>, revise only the plan from the supplied amendment and previous plan; preserve approved requirements, selected solution, and unchanged valid work/evidence. The host revokes old plan approval and acceptance; the reviewed replacement requires fresh plan approval before execution. The host owns execution and the planner-to-executor handoff. Each review seat defaults to repairLimit=2; revision counts consumed repairs. Open findings remain blockers.
  superpowers/skills/subagent-driven-development/SKILL.md:
    - before: 'description: Use when executing implementation plans with independent tasks in the current session'
      after: 'description: Authorized OMP executor method; implement or delegate native parent tasks with host-owned evidence and bounded independent review.'
    - before: 'Execute plan by dispatching a fresh implementer subagent per task, a task review (spec compliance + code quality) after each, and a broad whole-branch review at the end.'
      after: 'Execute the approved plan as the execution main agent: implement directly or dispatch native subagents under stable parent tasks. Require task review (spec compliance + code quality) and a final overall review, using the host-owned evidence and completion gates.'
    - before: '**Core principle:** Fresh subagent per task + task review (spec + quality) + broad final review = high quality, fast iteration'
      after: '**Core principle:** Native execution + independent task review (spec + quality) + overall review; host evidence determines completion.'
    - start: '**Rulings, not stalls.**'
      end: '## The Process'
      body: |
        **Decisions within authority.** Settle ordinary implementation choices, task-local refinements, and approved native integration without repeated approval. Run only the exact approved validation command by its validationId; a different command requires a revised, approved plan. Requirements changes return to requirements approval; core solution changes return to solution selection; material parent-task contract changes use /dev revise-plan <plan-version> <instructions...> and fresh plan approval. Destructive, security-sensitive, external, or otherwise unauthorized operations require their own authorization. Do not expand permission through Goal, delegation, or a ruling.

        The host owns the only task state, review seats, review-round counters, and approval versions. A child report or model claim cannot advance them. Native Task provides concurrency, isolation, lifecycle and results; this method does not install a second scheduler or force delegation.

    - start: "```dot\ndigraph process"
      end: '## Setup'
      body: |
        1. Read approved documents and enter a ready stable parent task through spec_task.
        2. Implement directly or delegate through native Task with current parent binding.
        3. Integrate native sources through spec_task; parallel-source success is not integrated-target verification.
        4. Capture exact approved validation commands through spec_verify by validationId and preserve raw output and input identity.
        5. Use the host's one task-review seat with its current repairLimit (default 2); revision counts consumed repairs.
        6. Request checkpoint; only host checks can mark complete. Open findings, parked work, checkboxes, and model success are not completion.
        7. After all pre-acceptance tasks, perform overall review and wait for final user acceptance. See references/final-review.md.

    - start: 'Ensure the work happens in an isolated workspace:'
      end: 'Read the plan once,'
      body: |
        Use the approved native workspace and integration strategy; do not force a linked worktree or a second worktree workflow. The host's task/evidence state is authoritative. Optional task briefs, reports, diffs and ledgers are supporting evidence, not a completion database. Read [references/resuming.md](references/resuming.md) before resuming; revalidate current inputs, approvals, parent task, review seat and counters. Never recover success from git log or a ledger alone, and never delete the only raw evidence.

    - start: 'Read the plan once,'
      end: '## Model Selection'
      body: |
        Read the approved plan and its requirements/solution bindings once. Keep parent IDs stable through refinements, redispatch and recovery. Read [references/preflight.md](references/preflight.md) before first implementation; return material contract conflicts to the corresponding host gate rather than ruling away approval.

    - start: '## Model Selection'
      end: '## The Task Loop'
      body: |
        ## Model Selection

        Reuse configured native model selection and team.members where applicable. Do not invent another model router. Each review seat defaults to repairLimit=2; revision counts consumed repairs. Only the developer's explicit /dev extend-review <review-id> <revision> <repair-limit> adds one round to an exhausted current seat. It preserves seat/finding IDs, counters and open issues; it never passes review or grants write/command permissions. Recovery, replacement sessions, Goal, and redispatch never reset identity or counters. This does not increase Team discussion budgets.

    - before: "Record BASE (`git rev-parse HEAD`) before dispatching — the review package\nand fix-round diffs need it."
      after: "Read the approved parent-task object in the supplied plan and its approved documents before implementation or delegation. Use spec_task status for progress and native sources; call spec_task start only to open direct inline implementation, not before native delegation. Native delegation names the approved parent task and host hooks admit it. The trusted Git service owns baseline and commit facts; never run Git, manufacture missing facts, or require an actor-readable baseline before starting."
    - before: "- **Task brief:** before dispatching an implementer, run this skill's\n  `bash scripts/task-brief PLAN_FILE N` — it extracts the task's full text to a\n  uniquely named file and prints the path. Compose the dispatch so the\n  brief stays the single source of\n  requirements. Your dispatch should contain: (1) one line on where this\n  task fits in the project; (2) the brief path, introduced as \"read this\n  first — it is your requirements, with the exact values to use verbatim\";\n  (3) interfaces and decisions from earlier tasks that the brief cannot\n  know; (4) your resolution of any ambiguity you noticed in the brief;\n  (5) the report-file path and report contract. Exact values (numbers,\n  magic strings, signatures, test cases) appear only in the brief. Never\n  make a subagent read the whole plan file."
      after: "- **Task brief:** use the approved parent-task object from the supplied plan as the authoritative brief, including its exact instructions, owned paths and validation obligations. Native delegation carries its stable task ID, exact task contract, relevant approved global constraints, project context, interfaces and settled decisions, and the reporting contract. Read approved documents at supplied paths; never generate a brief with shell scripts or require a nonexistent brief-file path. Missing approved contract facts block dispatch. Do not make a child read unrelated plan tasks."
    - before: "- **Report file:** name the implementer's report file after the brief\n  (brief `…/task-N-brief.md` → report `…/task-N-report.md`) and put it in\n  the dispatch prompt. The implementer writes the full report there and\n  returns only status, commits, a one-line test summary, and concerns."
      after: "- **Report:** retain the actual native child result and host execution/validation records under the approved parent task. Existing report artifacts are supporting evidence when supplied; no brief-derived report path is required. Report actual status, changed work, verification evidence and concerns without manufacturing commit facts."
    - before: "**DONE:** Generate the review package (`bash scripts/review-package PLAN_FILE BASE HEAD`, from this skill's directory — it prints the unique file path it wrote; BASE is the commit you recorded before dispatching the implementer — never `HEAD~1`, which silently drops all but the last commit of a multi-commit task), then dispatch the task reviewer with the printed path."
      after: "**DONE:** Read the report and current spec_task status; obtain authorized missing validation through spec_verify, then request the host checkpoint. The host seals the integrated inputs and creates the review record/package and commit facts through its trusted Git service, using the complete recorded task baseline rather than only the last commit. The host admits the existing task-review seat. Missing required facts or readable review inputs remain blocked; never generate substitutes or dispatch another reviewer."
    - before: "- Hand the reviewer its diff as a file: run this skill's\n  `bash scripts/review-package PLAN_FILE BASE HEAD` and pass the reviewer the file path\n  it prints (or, without bash: `git log --oneline`, `git diff --stat`,\n  and `git diff -U10` for the range, redirected to one uniquely named\n  file). The output never enters your own context, and the reviewer sees\n  the commit list, stat summary, and full diff with context in one Read\n  call. Use the BASE you recorded before dispatching the implementer —\n  never `HEAD~1`, which silently truncates multi-commit tasks. Never\n  dispatch a task reviewer without a diff file."
      after: "- Use spec_task status for progress and existing reports/native evidence when supplied. The host checkpoint seals inputs and supplies the existing review seat with structured approved task, execution, validation records and commits, including the exact reviewPackage content and trusted base/head facts. Do not assemble paths or dispatch review inputs yourself. Never invoke bash, Git or packaging scripts to recreate these facts. Missing or stale required inputs are evidence gaps for the host, not a pre-checkpoint requirement to produce a diff."
    - before: "- **Reviewer inputs:** the task reviewer gets three paths — the same brief\n  file, the report file, and the review package — plus the global\n  constraints that bind the task."
      after: "- **Reviewer inputs:** the host supplies the existing review seat with the approved task object, plan and specification, execution, records and commits/reviewPackage content. Existing report artifacts are supporting evidence when supplied; do not assemble paths or dispatch those inputs yourself."
    - before: "- The global-constraints block you hand the reviewer is its attention\n  lens. Copy the binding requirements verbatim from the plan's Global\n  Constraints section or the spec: exact values, exact formats, and the\n  stated relationships between components (\"same layout as X\", \"matches\n  Y\")."
      after: "- The global constraints supplied in the approved plan and specification are the reviewer's attention lens. Read binding requirements verbatim: exact values, exact formats and stated relationships between components (\"same layout as X\", \"matches Y\"). The host supplies these inputs; the executor does not dispatch a review prompt."
    - before: 'Template: [task-reviewer-prompt.md](task-reviewer-prompt.md)'
      after: 'Host review-seat method: [task-reviewer-prompt.md](task-reviewer-prompt.md); not an executor dispatch instruction.'
    - before: "- Record the implementer's agent identity from the dispatch result —\n  fix-loop rounds 1-3 resume this agent."
      after: '- Record native source identity and stable parent-task binding for integration and evidence; use the existing review seat within its current repairLimit, default 2.'
    - before: '- Never dispatch multiple implementation subagents in parallel (conflicts).'
      after: '- Use native parallelism only for independent authorized slices; reconcile shared interfaces and integrate their recorded sources into the approved target before validation.'
    - start: '### 5. Complete the task'
      end: '## Common Rationalizations'
      body: |
        ### 5. Complete the task

        Request the host checkpoint only after implementation, required current evidence, approved native integration, Git obligations and clean independent task review. The host, not a ledger line, checkbox, parked ruling or final model message, records completion. Unresolved findings or exhausted review rounds leave the parent task blocked. Preserve task-local records before any cleanup.

        ## Final Review

        Read [references/final-review.md](references/final-review.md). Overall review and current required evidence precede final user acceptance. Acceptance precedes approved synchronization/archive cleanup; those cleanup tasks cannot be prerequisites for acceptance.

    - before: '| "Close enough on spec compliance" | Reviewer found spec gaps = not done. Fix or hit the cap and adjudicate — those are the only exits. |'
      after: '| "Close enough on spec compliance" | Open required findings block completion, including after the current repairLimit is exhausted. |'
    - before: '| "I''ll fix it myself, dispatching is overhead" | Controller fixes pollute your context and skip review. Resume the implementer. |'
      after: '| "I fixed it myself, no review needed" | Direct implementation is allowed; independent review and evidence are still required. |'
    - before: '| "This finding is obviously wrong, I''ll drop it" | You adjudicate only at the cap, and every ruling is a ledger entry. Silent discards are forbidden. |'
      after: '| "This finding is obviously wrong, I''ll drop it" | Record evidence and obtain the existing reviewer seat''s resolution; do not silently discard findings or approve yourself. |'
  superpowers/skills/subagent-driven-development/references/fix-loop.md:
    - start: 'Before the loop starts, two routes leave it immediately:'
      end: 'Everything else enters the loop.'
      body: |
        Before the loop starts, classify findings without changing approval authority:

        - Record minor supporting observations in task-local evidence for the existing review seat to consider. They are not controller rulings, completion evidence, or permission to bypass required review.
        - For a plan-mandated finding or one conflicting with the approved plan, preserve the finding and supporting observations. Route material requirement, core solution or parent-task contract conflicts to the corresponding existing host approval gate before acting. Do not self-approve, dismiss the finding because the plan mandates it, or bypass the existing review seat. Ordinary authorized task-local refinements retain the approved contract and review obligations.

    - start: 'Everything else enters the loop.'
      body: |
        Everything else enters the existing parent task's host-owned review loop. Initial review has repairLimit=2 by default; revision counts consumed fix/re-review rounds. Only the developer's explicit /dev extend-review <review-id> <revision> <repair-limit> adds one round to an exhausted current seat; never create a fresh seat or reset counters across redispatch, recovery or Goal. A round is one fix wave plus scoped re-review by the same logical seat. Extension preserves findings and does not pass review, expand permissions or increase Team budgets.

        Send findings verbatim with the original brief, report and parent ID. The executor may fix directly or use native subagents. Run only authorized covering validations whose evidence is missing or invalidated; retain valid evidence for unchanged inputs. Append actual commands, output paths, exit codes, input identities and limitations before re-review.

        Read spec_task status for progress and existing reports/native evidence when supplied. Request checkpoint for the host to seal changed inputs and supply the existing seat with the approved task object, previous findings, execution, records and commits/reviewPackage content with trusted Git facts; never assemble review paths, dispatch another reviewer or run packaging scripts, bash or Git. Missing or stale required inputs are host evidence gaps, not permission to manufacture facts. The host uses [re-review-prompt.md](../re-review-prompt.md) in the existing seat. Re-review judges each finding and any regression in the fix; unrelated observations are recorded without expanding scope.

        After each round retain its actual number and result in host state and supporting reports. If required findings remain when revision reaches repairLimit, stop this parent task as blocked with all evidence intact. Explicit extension permits one more round of the same work within existing permissions; while awaiting acceptance, remain read-only until the developer requests repair. Parking, severity relabeling, a new child or self-ruling cannot mark it complete. Material plan changes require a revised, approved plan; requirement and solution changes retain their own gates.
  superpowers/skills/subagent-driven-development/references/final-review.md:
    - start: '# Final Review and Finish'
      body: |
        # Final Review and Acceptance

        Use the approved integrated target and complete original branch base, not the last commit. Read spec_task status, approved requirements, solution, plan, existing reports, raw validation records, unresolved findings and integration provenance. Request the host checkpoint to seal inputs and create the overall review record/package and trusted Git facts for its one overall-review seat. Consume the readable existing package and evidence; never generate them with scripts, bash or Git or manufacture missing facts. Missing or stale required inputs block review. Use the controlled requesting-code-review [template](../../requesting-code-review/code-reviewer.md).

        Apply the same review-seat repairLimit and explicit one-round extension rules as [fix-loop.md](fix-loop.md); do not reset counters or silently park required findings. Required open findings or missing/currently invalid evidence block delivery. Revalidate affected inputs after fixes; unchanged valid evidence need not be rerun.

        Before any cleanup, persist task-local raw output, content identities, review packages, findings and decisions through the host evidence service; then publish verification.md from those records. A save failure blocks success and cleanup of the only evidence. Reports, checkboxes, ledger lines, parked work, native Goal completion and model claims cannot complete the run.

        When pre-acceptance tasks, required current verification and overall review satisfy the host gates, stop adding execution work and present the result for final user acceptance. Only after acceptance perform separately approved synchronization/archive cleanup. Do not invoke finishing-a-development-branch, merge/publish, or delete this evidence workspace automatically. The host owns acceptance, transition and cleanup authority.
  superpowers/skills/subagent-driven-development/references/resuming.md:
    - start: '# Resuming From an Existing Ledger'
      body: |
        # Resuming From Live Host State

        Part of the controlled subagent-driven-development method. Resume only within an existing live host run using its current task and evidence state. A ledger, if supplied, is optional supporting evidence, never recovery or approval authority. This reference does not authorize cold process recovery or reconstruction of a lost run.

        Read only records belonging to this live run and current approved documents. Revalidate current content identity, approvals, native integration and required evidence before relying on completion. Keep stable parent IDs, review seat, revision and repairLimit (default 2). Only an explicit developer extension adds one repair round without clearing findings or counters. A replacement actor session or Goal restart never resets these. If the host run or a required binding is unavailable or stale, report blocked rather than reconstructing authorization from a ledger, git history, parked report, checkbox or prose. Preserve other runs and all unique evidence.
  superpowers/skills/subagent-driven-development/references/handling-reports.md:
    - before: '4. If the plan itself is wrong, rule on the correction, ledger it, and re-dispatch with the ruling carried in the dispatch'
      after: '4. If the plan itself is wrong, distinguish ordinary task-local refinement from a material parent-task contract change; route material changes to the host plan gate before re-dispatch. Requirements or core solution changes return to their own gates.'
    - before: '3. If the task is too large, break it into smaller pieces'
      after: '3. Refine into task-local pieces under the same stable parent task; do not replace its acceptance contract, review seat or round counter'
  superpowers/skills/subagent-driven-development/references/preflight.md:
    - start: 'Write the table to the ledger.'
      body: |
        Save the table as task-local supporting evidence, not another task-state authority. Settle ordinary implementation details within the approved contract. Requirements, core solution, or material parent-task contract conflicts return to their respective host gates before implementation. Do not use a ruling to override approval. Keep all stable parent IDs and review counters.
  superpowers/skills/subagent-driven-development/references/batching.md:
    - start: '**Batch small same-shape work.**'
      body: |
        Batch small same-shape edits within a stable parent task when native scheduling makes that useful. Independent parent tasks may share a worker only if each retains its own binding, required evidence, integration record, review seat, revision and repairLimit (default 2). Do not merge their acceptance gates, reset or self-extend budgets, invent a second scheduler, or treat a combined worker report as completion.
  superpowers/skills/subagent-driven-development/implementer-prompt.md:
    - before: '    4. Commit your work'
      after: '    4. Perform only the Git operations authorized by the host assignment'
    - before: "    While iterating, run the focused test for what you're changing; run the\n    full suite once before committing, not after every edit."
      after: '    Run only validations authorized by the host assignment; if the controller owns verification, do not run them yourself. Preserve actual task-local evidence and report unrun checks as UNVERIFIED. Do not demand a full suite outside approved scope.'
    - before: '    fresh reviewer against your diff. A reviewer you spawn duplicates'
      after: '    reviewer in the existing stable review seat against your diff. A reviewer you spawn duplicates'
    - before: '    Fix them, re-run the tests that cover the amended code, and append a fix'
      after: '    Fix within the existing host repairLimit, obtain exact approved covering validation by ID, and append a fix'
  superpowers/skills/subagent-driven-development/task-reviewer-prompt.md:
    - before: "Use this template when dispatching a task reviewer subagent. The reviewer\nreads the task's diff once and returns two verdicts: spec compliance and\ncode quality."
      after: "Use this template within the existing host-owned task-review seat. Read the host-supplied frozen task diff and return spec compliance and code quality judgments; never dispatch another reviewer."
    - before: '    Read the task brief: [BRIEF_FILE]'
      after: '    Read the approved parent-task object supplied in the host review input; its instructions, ownedPaths and validation obligations are the authoritative brief.'
    - before: "    Read the implementer's report: [REPORT_FILE]"
      after: '    Inspect host-supplied execution and records; read any supplied implementer report as a claim, not independent evidence.'
    - before: "    **Diff file:** [DIFF_FILE]\n\n    Read the diff file once — it contains the commit list, a stat summary,\n    and the full diff with surrounding context, and it is your view of the\n    change."
      after: "    **Review package:** use the reviewPackage content supplied in commits, with its recorded base/head and task binding. Read the exact package once as the view of the change; a separate diff-file path is not required."
    - before: "- `[BRIEF_FILE]` — REQUIRED: the task brief file (`bash scripts/task-brief PLAN N`\n  prints the path; same file the implementer worked from)"
      after: "- Approved task brief — the task object already supplied in the host review input, not a generated file or path."
    - before: "- `[REPORT_FILE]` — REQUIRED: the file the implementer wrote its detailed\n  report to"
      after: "- Execution evidence — the supplied execution and records; existing report artifacts are optional supporting claims, not required paths."
    - before: "- `[DIFF_FILE]` — REQUIRED: the path the controller wrote the review\n  package to (`bash scripts/review-package PLAN_FILE BASE HEAD` prints the unique\n  path it wrote; the package never enters the controller's context)"
      after: "- Review package — the reviewPackage content in host-supplied commits; do not generate it or require an additional path."
    - start: '    If the diff file is missing, fetch the diff yourself:'
      end: '    Do not crawl the broader codebase.'
      body: |
            If required reviewPackage content is missing, report an evidence gap to the host; a separate diff-file path is not required. Do not execute commands or regenerate evidence.

    - start: '    ## Tests'
      end: '    ## Part 1: Spec Compliance'
      body: |
            ## Tests

            This is the host's existing independent review seat with repairLimit=2 by default; revision counts consumed repairs, and only explicit developer extension adds one round without resetting findings or counters. You MUST remain read-only and NEVER run commands or tests; inspect provided native evidence and source with authorized read-only tools. Evidence gaps are findings, not permission to rerun suites. Report exact requirements, file references, raw output paths and unresolved uncertainty. Never infer success from model reports, parked findings, checkboxes or a ledger.

  superpowers/skills/subagent-driven-development/re-review-prompt.md:
    - before: "Use this template when dispatching a re-review after a fix round. The\nre-reviewer verifies the findings were addressed and checks the fix diff for\nnew breakage. It is not a fresh review — the full review already happened."
      after: "Use this template within the existing host-owned review seat after a fix round; never dispatch another reviewer. Verify findings and the host-supplied fix diff for new breakage, not a fresh broad review."
    - before: '    Read the task brief: [BRIEF_FILE]'
      after: '    Read the approved parent-task object already supplied in the host review input as the authoritative brief.'
    - before: "    Read the implementer's report (fix reports are appended at the end):\n    [REPORT_FILE]"
      after: '    Inspect the host-supplied execution and records for the fix; read any existing fix report as supporting claims only.'
    - before: "    **Diff file:** [DIFF_FILE]\n\n    Read the diff file once — it contains the fix commits, a stat summary,\n    and the fix diff with surrounding context. Do not re-run git commands."
      after: "    **Review package:** inspect the host-supplied commits/reviewPackage content and previous review to judge the fix against the previous reviewed inputs. Read its exact diff once; no additional file path or regenerated diff is required. Do not run Git commands."
    - before: '- `[BRIEF_FILE]` — the task brief file (same file the implementer worked from)'
      after: '- Approved task brief — the task object already supplied in the host review input, not a generated file or path.'
    - before: "- `[REPORT_FILE]` — the implementer's report file (fix reports appended)"
      after: '- Execution evidence — host-supplied execution and records, plus existing fix reports when supplied.'
    - before: '- `[DIFF_FILE]` — the path `bash scripts/review-package PLAN_FILE FIX_BASE HEAD` printed'
      after: '- Review package — host-supplied commits/reviewPackage content; never run a script or manufacture a package/path.'
    - start: '    If the diff file is missing, fetch the diff yourself:'
      end: '    ## You Do Not Dispatch Subagents'
      body: |
            If required reviewPackage content is missing, report an evidence gap to the host; a separate diff-file path is not required. Your review is read-only: do not mutate files, execute commands or regenerate evidence.

    - start: '    ## Tests'
      end: '    ## Output Format'
      body: |
            ## Tests

            Read actual native records covering the fix and their relevant input identities. Treat model reports as claims. You MUST remain read-only and NEVER execute commands or tests. Missing or stale records are findings for the host. Reuse unchanged valid records; do not force reruns. This is the existing seat's scoped re-review within its current repairLimit (default 2); explicit developer extension adds one round without resetting revision, findings or permissions. Replacement sessions, Goal and redispatch never reset counters.

  superpowers/skills/subagent-driven-development/scripts/review-package:
    - start: 'if [ $# -eq 4 ]; then'
      end: "{\n  echo \"# Review package:"
      body: |
        # Preserve task-local review evidence; never overwrite an existing package.
        if [ $# -eq 4 ]; then
          out=$4
        else
          dir=$("${BASH:-bash}" "$(cd "$(dirname "$0")" && pwd)/sdd-workspace" "$plan")
          out="$dir/review-$(git rev-parse --short "$base")..$(git rev-parse --short "$head").diff"
        fi
        if [ -e "$out" ]; then
          echo "refusing to overwrite review evidence: $out" >&2
          exit 3
        fi
        set -o noclobber

  superpowers/skills/test-driven-development/SKILL.md:
    - before: 'description: Use when implementing any feature or bugfix, before writing implementation code'
      after: 'description: Authorized OMP executor TDD; preserve real red/green proof within approved validation scope and current input identity.'
    - start: '**Exceptions (ask your human partner):**'
      end: '## The Iron Law'
      body: |
        **Scope:** Follow the approved task's test obligations and project authorization. Documentation-only, generated or configuration work uses its specified verification, not a manufactured software-test obligation. Reuse already observed valid RED evidence and unchanged valid GREEN evidence; missing proof remains UNVERIFIED. A worker must not run checks reserved to its controller.

    - start: 'Write code before the test? Delete it.'
      end: '## Red-Green-Refactor'
      body: |
        A behavioral change needs real failing-test evidence before implementation. If that proof is missing, report the gap and establish a safe minimal reproducer without destroying unrelated or pre-existing work. Do not claim RED from a fabricated failure or infer GREEN from source changes. Preserve the task's raw records before cleanup.

    - start: '**"Other tests" means the project''s suite, not just your file.**'
      end: '### REFACTOR - Clean Up'
      body: |
        **Other tests:** Run the approved affected checks, including the specified real-entry acceptance obligations. Do not demand or run a full project suite outside authorization. Reuse valid records for unchanged inputs; after relevant changes obtain new evidence for affected obligations. Report every observed failure and every unrun required boundary. A narrow passing test cannot be relabeled whole-project coverage.

    - before: '**All of these mean: Delete code. Start over with TDD.**'
      after: '**All of these require honest missing-proof reporting and a safe minimal failing-test demonstration; never destroy unrelated or pre-existing work.**'
    - before: '| "Deleting X hours is wasteful" | Sunk cost fallacy — that time is already spent either way. The real choice: rewrite with TDD (high confidence) vs. keep it and bolt tests on after (low confidence, likely bugs). Keeping code you can''t trust is the waste. |'
      after: '| "Missing RED is harmless" | Missing RED is an evidence gap; obtain a safe real reproducer and report its limits without deleting unrelated work. |'
    - before: '| "Keep as reference, write tests first" | You''ll adapt it. That''s testing after. Delete means delete. |'
      after: '| "Keep as reference, write tests first" | Never mislabel tests-after as tests-first. Preserve existing work and report the actual sequence. |'
    - before: "Can't check all boxes? You skipped TDD. Start over."
      after: 'A checkbox is not evidence or completion. Missing required proof blocks the host checkpoint; report the precise gap and obtain authorized affected verification without discarding existing work.'
    - before: '- [ ] All tests pass'
      after: '- [ ] All approved required tests have current valid passing evidence; unrun boundaries remain explicit'
    - before: "No exceptions without your human partner's permission."
      after: 'Use the exact host-approved validation command by validationId; changing it requires a revised, approved plan, not a model-selected equivalent.'
  superpowers/skills/verification-before-completion/SKILL.md:
    - before: 'description: Use when about to claim work is complete, fixed, or passing, before committing or creating PRs - requires running verification commands and confirming output before making any success claims; evidence before assertions always'
      after: 'description: Authorized OMP executor evidence gate; use current native records, preserve raw proof, and never substitute model success for host completion.'
    - before: 'NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE'
      after: 'NO COMPLETION CLAIMS WITHOUT CURRENT VALID VERIFICATION EVIDENCE'
    - before: "If you haven't run the verification command in this message, you cannot claim it passes."
      after: 'Use actual native records bound to relevant content and execution conditions. Reuse valid unchanged evidence; rerun affected obligations only when missing or invalidated and authorized. A command need not be rerun in this message. Never elevate source-only review, child reports or model claims to successful verification.'
    - before: '2. RUN: Execute the FULL command (fresh, complete)'
      after: '2. OBTAIN: Read valid complete native evidence, or execute the exact approved affected command by validationId if its evidence is absent or invalidated'
    - before: '| Tests pass | Test command output: 0 failures | Previous run, "should pass" |'
      after: '| Tests pass | Current native command output and input identity: 0 failures | Stale run, model assertion, "should pass" |'
    - before: '| Agent completed | VCS diff shows changes | Agent reports "success" |'
      after: '| Agent completed | Host checkpoint: integrated target, required current evidence, Git obligations and clean review | VCS changes, agent reports "success", checkbox, parked finding |'
    - before: '| Requirements met | Line-by-line checklist | Tests passing |'
      after: '| Requirements met | Acceptance coverage, current native records and independent review | Tests alone, checklist alone |'
    - before: '| "Partial check is enough" | Partial proves nothing |'
      after: '| "Partial check proves everything" | Report only the approved scope actually evidenced; never expand its coverage claim |'
    - before: '| "Should work now" | RUN the verification |'
      after: '| "Should work now" | Obtain actual current valid evidence for the exact claim |'
    - before: '✅ Agent reports success → Check VCS diff → Verify changes → Report actual state'
      after: '✅ Agent reports success → Inspect integrated-target changes and current native records → Host checkpoint → Report actual state'
    - before: '- Relying on partial verification'
      after: '- Presenting scoped verification as proof of unexercised boundaries'
    - start: '## When To Apply'
      body: |
        ## Evidence, Acceptance and Cleanup

        Apply before any completion, fixed or passing claim. Use the host's current task/evidence state, not a new ledger. Verification uses only exact approved validation commands by ID; command changes require plan revision and approval. Each review seat defaults to repairLimit=2; revision counts consumed repairs. Only explicit developer extension adds one round without clearing findings or granting permissions. Required unresolved findings block completion even at the limit.

        Persist original task-local command output, exit codes, input identities and review records before publishing verification.md or cleanup. If persistence fails, do not claim success or remove the only records. Parallel source success is not integrated-target success. Final overall review and current required evidence precede final user acceptance; approved synchronization/archive happens only after acceptance. Never take over host transitions, merge/publish, or turn Goal completion into acceptance.
  superpowers/skills/systematic-debugging/SKILL.md:
    - before: 'description: Use when encountering any bug, test failure, or unexpected behavior, before proposing fixes'
      after: 'description: Authorized OMP executor root-cause method; investigate real evidence before a scoped fix without exceeding host review or validation authority.'
    - before: '   - Can you trigger it reliably?'
      after: '   - Use the observed report as evidence; reproduce only to answer a concrete unresolved question within current authorization.'
    - before: '   - If < 3: Return to Phase 1, re-analyze with new information'
      after: '   - Within the current host review round: Return to Phase 1 with concrete new evidence; diagnosis never resets the stable review seat or round counter.'
    - before: '   - **If ≥ 3: STOP and question the architecture (step 5 below)**'
      after: '   - **The host review repairLimit defaults to 2; unresolved findings at that limit block the parent task unless the developer explicitly extends the current seat by one round.** Investigate architecture within that boundary (step 5 below).'
    - before: '   - DON''T attempt Fix #4 without architectural discussion'
      after: '   - Do not extend or reset the host review cap through debugging attempts, redispatch or Goal.'
    - before: '   **Discuss with your human partner before attempting more fixes**'
      after: '   **Route a material requirements, core solution, or parent-task contract change to its host gate. Settle ordinary authorized implementation details without another user approval; exhausted review rounds remain blocked.**'
  superpowers/skills/requesting-code-review/SKILL.md:
    - before: 'description: Use when completing tasks, implementing major features, or before merging to verify work meets requirements'
      after: 'description: Authorized OMP independent review method; use the existing read-only review seat, current evidence and host repairLimit, default 2.'
    - before: "Dispatch a code reviewer subagent to catch issues before they cascade. The reviewer gets precisely crafted context for evaluation — never your session's history."
      after: "Use the existing host-owned independent review seat to catch issues before they cascade. Read its supplied approved task facts and frozen review inputs, never the executor's session history. Do not dispatch another reviewer."
    - before: '| "I''ll just review the diff myself instead of dispatching a reviewer" | You''re the coordinator — reviewing the diff inline burns the context window you need to keep driving the work. Dispatch a reviewer subagent: the diff and the evaluation live in its context, and only the findings come back to you. |'
      after: '| "Self-review can replace the host review seat" | Independent review is required in the existing host-owned seat. Neither executor self-review nor dispatching another reviewer replaces it. |'
    - start: '## When to Request Review'
      end: '## Common Rationalizations'
      body: |
        ## Host-Owned Review

        Review the assigned node only. Use the existing stable review seat with its current repairLimit (default 2); revision counts consumed repair rounds. Only explicit developer extension adds one round while preserving findings and counters. Never dispatch another reviewer, run commands, implement fixes, expand scope, self-extend or reset counters, park required findings as complete, or take over execution. The host owns model selection and transition decisions.

        Read approved requirements, selected solution, plan, exact task brief, integrated-target review package, report and native validation records with permitted read-only tools. Use [code-reviewer.md](code-reviewer.md). Check spec compliance and quality separately. Treat model reports as claims; trace file evidence and original command output. Missing evidence remains a finding; do not run tests yourself. A final review covers the integrated result, not parallel sources alone.

        Return findings with severity, exact file references, the violated obligation and concrete evidence; distinguish unknowns. Resolve challenges with technical evidence in the same seat. Required unresolved findings at the current repairLimit block delivery, not an invitation to start another review loop. Explicit extension never passes review or grants permissions. Never claim implementation complete or user acceptance on behalf of the host.

  superpowers/skills/requesting-code-review/code-reviewer.md:
    - before: 'Use this template when dispatching a code reviewer subagent.'
      after: 'Use this template within the existing host-owned code-review seat; never dispatch another reviewer.'
    - start: '    ## Git Range to Review'
      end: '    ## The spec is a vision document'
      body: |
            ## Frozen Review Inputs

            Read the frozen reviewPackage content in the host-supplied commits, with its recorded base, head, task binding and integrated-target evidence. Read the supplied approved task, plan, specification, execution and records; no separately assembled review-package or brief-file path is required. Use permitted read-only source tools to inspect referenced files. Do not run Git or other commands, regenerate the package, or infer an absent diff; report missing or stale inputs as evidence gaps to the host.

    - start: '    ## The spec is a vision document'
      end: '    ## Declined to judge'
      body: |
            ## Review Authority

            You are the existing host-owned read-only review seat. Judge the assigned approved requirements, solution and parent-task contract, without inventing scope or authorizing new behavior. Its repairLimit defaults to 2; revision counts consumed repairs. Only explicit developer extension adds one round without clearing findings or counters; replacement sessions never reset them. Report uncertainty and material contract defects to the host. Never dispatch agents, execute commands, implement changes, or claim host completion.

    - before: '    Your review is read-only on this checkout. Do not mutate the working tree, the index, HEAD, or branch state in any way. Use tools like `git show`, `git diff`, and `git log` to inspect history. If you need a working copy of a different revision, check it out into a separate temporary directory (e.g. `git worktree add /tmp/review-[SHA] [SHA]`) — never move HEAD on this checkout.'
      after: '    Your review is read-only. Use the supplied exact review package and native evidence plus authorized read-only source tools; no commands, tests, worktrees or mutations. Missing evidence is a finding for the host, not permission to regenerate it.'
    - start: '    ## Output Format'
      end: '    ## Critical Rules'
      body: |
            ## Output Format

            Return the host SPEC_REVIEW_SCHEMA object:
            - verdict: pass | revise | clarify. Use revise for required findings; clarify when missing evidence or an unresolved question prevents judgment; pass only with no required findings or unresolved evidence gaps.
            - summary: technical assessment covering spec compliance and quality separately; include strengths and any supporting recommendations without expanding scope.
            - findings: [{id, severity: blocking | important | minor, issue, evidence, taskIds}]. Give exact file:line and violated obligation in evidence; bind findings to stable parent-task IDs.
            - resolutions: [{findingId, resolved, evidence}] for findings considered in this review/re-review.
            - questions: unresolved questions requiring host clarification.
            - evidenceChecks: [{recordId, behavior, valid, reason}] for supplied native evidence checked; missing records remain explicit findings/questions, not fabricated record IDs.

            A pass is a review result only, never host completion, merge authorization or user acceptance.

    - before: "- `[BASE_SHA]` — starting commit\n- `[HEAD_SHA]` — ending commit"
      after: '- Review inputs — host-supplied commits/reviewPackage content and recorded base/head facts, approved task, plan, specification, execution and records; no additional package-path placeholder'
    - before: '**Reviewer returns:** Strengths, Issues (Critical / Important / Minor), Recommendations, Assessment'
      after: '**Reviewer returns:** The host SPEC_REVIEW_SCHEMA object: verdict, summary, findings, resolutions, questions and evidenceChecks. No merge authorization.'
    - start: '## Example Output'
      body: |
        ## Example Output

        ```json
        {
          "verdict": "revise",
          "summary": "Spec compliance: required CLI help and date validation are missing. Quality: the inspected implementation has clear module boundaries; current test evidence is incomplete.",
          "findings": [
            {
              "id": "F1",
              "severity": "important",
              "issue": "Required CLI help text is missing.",
              "evidence": "index-conversations:1-31 has no --help case required by the supplied task brief.",
              "taskIds": ["T001"]
            },
            {
              "id": "F2",
              "severity": "important",
              "issue": "Invalid dates silently return no results instead of the required validation error.",
              "evidence": "search.ts:25-27 does not validate the ISO date required by the supplied task brief.",
              "taskIds": ["T001"]
            }
          ],
          "resolutions": [],
          "questions": ["Supply the current native test records bound to the frozen integrated target; test success cannot be inferred from source."],
          "evidenceChecks": []
        }
        ```
```
