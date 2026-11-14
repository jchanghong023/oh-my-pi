# Workflows

This guide covers common workflow patterns for OpenSpec and when to use each one. For basic setup, see [Getting Started](getting-started.md). For command reference, see [Commands](commands.md).

## Philosophy: Actions, Not Phases

Traditional workflows force you through phases: planning, then implementation, then done. But real work doesn't fit neatly into boxes.

OPSX takes a different approach:

```text
Traditional (phase-locked):

  PLANNING ────────► IMPLEMENTING ────────► DONE
      │                    │
      │   "Can't go back"  │
      └────────────────────┘

OPSX (fluid actions):

  proposal ──► specs ──► design ──► tasks ──► implement
```

**Key principles:**

- **Actions, not phases** - Commands are things you can do, not stages you're stuck in
- **Dependencies are enablers** - They show what's possible, not what's required next

> **Customization:** OPSX workflows are driven by schemas that define artifact sequences. See [Customization](customization.md) for details on creating custom schemas.

## Workflow at a Glance

The default workflow stays fluid: exploration and verification are optional, and
you can update planning artifacts whenever implementation reveals something new.

```mermaid
flowchart TD
    Idea["Idea or problem"] --> Explore["/skill:openspec-explore<br/>(optional)"]
    Idea --> Propose["/skill:openspec-propose"]
    Explore --> Propose
    Propose --> Review{"Planning artifacts<br/>ready?"}
    Review -->|"Refine"| Update["/skill:openspec-update-change"]
    Update --> Review
    Review -->|"Implement"| Apply["/skill:openspec-apply-change"]
    Apply -->|"Plan changed"| Update
    Apply --> Archive["/skill:openspec-archive-change"]
    Apply --> Verify["/skill:openspec-verify-change<br/>(optional, custom selection)"]
    Apply --> Sync["/skill:openspec-sync-specs<br/>(optional before archive)"]
    Verify --> Verified{"Ready to archive?"}
    Verified -->|"Fix implementation"| Apply
    Verified -->|"Revise plan"| Update
    Verified -->|"Ready"| Sync
    Verified -->|"Ready"| Archive
    Sync --> Archive
```

The AI assistant drives the workflow, while the CLI provides deterministic
scaffolding, status, and artifact instructions:

```mermaid
sequenceDiagram
    actor Human
    participant Assistant as AI assistant
    participant CLI as OpenSpec CLI
    participant Files as Planning and implementation files

    Human->>Assistant: /skill:openspec-propose "change"
    Assistant->>CLI: omp openspec new change
    CLI->>Files: Scaffold change metadata
    Assistant->>CLI: Request status and artifact instructions
    CLI-->>Assistant: Build order, paths, and templates
    Assistant->>Files: Write schema-defined planning artifacts
    Assistant-->>Human: Present artifacts for review

    Human->>Assistant: /skill:openspec-apply-change
    Assistant->>CLI: Request apply instructions
    CLI-->>Assistant: Context files and task state
    Assistant->>Files: Implement tasks and update checkboxes
    Assistant-->>Human: Report implementation status

    Human->>Assistant: /skill:openspec-archive-change
    Assistant->>CLI: Request archive inputs and artifact status
    CLI-->>Assistant: Planning paths and artifact completion
    Assistant->>Files: Read task state and compare delta specs
    opt Delta specs exist
        Assistant-->>Human: Offer to sync before archiving
        alt Sync accepted
            Human->>Assistant: Confirm sync
            Assistant->>Files: Merge delta specs into main specs
        else Sync skipped
            Human->>Assistant: Archive without syncing
        end
    end
    Assistant->>Files: Move the change into the archive
    Assistant-->>Human: Report archive location and sync result

    Note over Human,CLI: CLI alternative: omp openspec archive change-name --yes skips confirmation prompts. It still validates, then applies any delta specs and archives
```

## Two Modes

### Quick Path (all Skills bundled)

The quick path uses these already bundled Skills:
- `/skill:openspec-explore`
- `/skill:openspec-propose`
- `/skill:openspec-apply-change`
- `/skill:openspec-update-change`
- `/skill:openspec-sync-specs`
- `/skill:openspec-archive-change`

Typical flow:

```text
/skill:openspec-explore ──► /skill:openspec-propose ──► /skill:openspec-apply-change ──► /skill:openspec-sync-specs ──► /skill:openspec-archive-change
  (optional)
```

#### Start by exploring (the habit worth forming)

`/skill:openspec-explore` is bundled alongside all other OpenSpec Skills, not a profile-gated add-on. Use it whenever you have a problem but not yet a plan.

```text
You: /skill:openspec-explore

AI:  What would you like to explore?

You: Our search results feel stale. I'm not sure if it's caching,
     indexing, or the query itself.

AI:  Let me look... [reads the search service and cache layer]
     It's the index: it only rebuilds nightly, so edits don't show
     up until the next day. Two options: rebuild on write (simple,
     more load) or a short-TTL cache invalidation (more moving parts,
     less load). Given your write volume is low, rebuild-on-write is
     the cleaner fix. Want to scope it?

You: Yes.

You: /skill:openspec-propose rebuild-search-index-on-write
```

Explore never writes code, and writes nothing else unless you ask, or say yes when it offers. It's a free, no-stakes conversation that turns a vague worry into a precise change, so the proposal that follows is sharp. Already know exactly what you want? Skip it and go straight to `/skill:openspec-propose`. Full guide: [Explore First](explore.md).

### Expanded/Full Workflow (custom selection)

All incremental workflows (`new`, `continue`, `ff`, `verify`, `bulk-archive`, `onboard`) are already bundled as native OMP Skills. Use `/skill:openspec-new-change` or another full Skill name; no profile switch or resource refresh is needed.

## Workflow Patterns (Expanded Mode)

### Quick Feature

When you know what you want to build and just need to execute:

```text
/skill:openspec-new-change ──► /skill:openspec-ff-change ──► /skill:openspec-apply-change ──► /skill:openspec-verify-change ──► /skill:openspec-archive-change
```

**Example conversation:**

```text
You: /skill:openspec-new-change add-logout-button

AI:  Created openspec/changes/add-logout-button/
     Ready to create: proposal

You: /skill:openspec-ff-change

AI:  Creating all planning artifacts...
     ✓ proposal.md
     ✓ specs/
     ✓ design.md
     ✓ tasks.md
     Ready for implementation!

You: /skill:openspec-apply-change

AI:  Working through tasks...
     ✓ Added logout button to header
     ✓ Implemented session clearing
     ✓ Added confirmation dialog
     All tasks complete!

You: /skill:openspec-archive-change

AI:  ✓ Merged specs
     ✓ Archived change
```

**Best for:** Small to medium features, bug fixes, straightforward changes.

### Exploratory

When requirements are unclear or you need to investigate first:

```text
/skill:openspec-explore ──► /skill:openspec-new-change ──► /skill:openspec-continue-change ──► ... ──► /skill:openspec-apply-change
```

**Example conversation:**

```text
You: /skill:openspec-explore

AI:  What would you like to explore?

You: I want to improve page load performance but I'm not sure
     where the bottlenecks are.

AI:  Let me help investigate...
     [Analyzes bundle sizes, identifies slow queries, reviews
     component render patterns]

     I found three main bottlenecks:
     1. Large unoptimized images
     2. Synchronous data fetching in ProductList
     3. Re-renders from context changes

     Which would you like to address first?

You: Let's tackle the data fetching issue.

You: /skill:openspec-new-change optimize-product-list-fetching

AI:  Created change. Ready to create: proposal

You: /skill:openspec-continue-change

AI:  Creating proposal based on our exploration...
     [Writes proposal incorporating investigation insights]

     Ready to create: specs, design
     Which would you like next?

You: /skill:openspec-continue-change

AI:  Creating specs...
```

**Best for:** Performance optimization, debugging, architectural decisions, unclear requirements.

### Parallel Changes

Work on multiple changes at once:

```text
Change A: /skill:openspec-new-change ──► /skill:openspec-ff-change ──► /skill:openspec-apply-change (in progress)
                                         │
                                    context switch
                                         │
Change B: /skill:openspec-new-change ──► /skill:openspec-ff-change ──────► /skill:openspec-apply-change
```

**Example conversation:**

```text
You: I'm working on add-dark-mode but got pulled into a bug fix

You: /skill:openspec-new-change fix-login-redirect

AI:  Created openspec/changes/fix-login-redirect/

You: /skill:openspec-ff-change

AI:  ✓ Created planning artifacts

You: /skill:openspec-apply-change

AI:  Working on fix-login-redirect...
     [Implements the fix]
     All tasks complete!

You: /skill:openspec-archive-change

AI:  ✓ Archived fix-login-redirect

You: Let's get back to dark mode

You: /skill:openspec-apply-change add-dark-mode

AI:  Resuming add-dark-mode...
     Picking up at task 2.3: Update Header...
```

**Best for:** Parallel work streams, urgent interrupts, team collaboration.

When you have multiple completed changes, use `/skill:openspec-bulk-archive-change`:

```text
You: /skill:openspec-bulk-archive-change

AI:  Found 3 completed changes:
     - add-dark-mode (all tasks done)
     - fix-login-redirect (all tasks done)
     - update-footer (all tasks done)

     Checking for spec conflicts...
     ⚠ add-dark-mode and update-footer both touch specs/ui/

     Inspecting codebase to resolve...
     Both changes are implemented. Will apply in chronological order.

     Archive all 3 changes?

You: Yes

AI:  ✓ Archived add-dark-mode
     ✓ Archived fix-login-redirect
     ✓ Archived update-footer
     Specs merged in order: add-dark-mode → update-footer
```

Bulk archive detects when multiple changes touch the same specs and resolves conflicts by checking what's actually implemented.

### Completing a Change

The recommended completion flow:

```text
/skill:openspec-apply-change ──► /skill:openspec-verify-change ──► /skill:openspec-archive-change
                    │                 │
              validates          prompts to sync
              implementation     if needed
```

#### Verify: Check Your Work

`/skill:openspec-verify-change` validates implementation against your artifacts across three dimensions:

```text
You: /skill:openspec-verify-change

AI:  Verifying add-auth...

     COMPLETENESS
     ✓ All 12 tasks in tasks.md are checked
     ✓ All requirements in specs have corresponding code
     ⚠ Scenario "Session timeout after inactivity" not tested

     CORRECTNESS
     ✓ Implementation matches spec intent
     ✓ Edge cases from scenarios are handled
     ✓ Error states match spec definitions

     COHERENCE
     ✓ Design decisions reflected in code structure
     ✓ Naming conventions consistent with design.md
     ⚠ Design mentions "event-driven" but implementation uses polling

     SUMMARY
     ─────────────────────────────
     Critical issues: 0
     Warnings: 2
     Ready to archive: Yes (with warnings)

     Recommendations:
     1. Add test for session timeout scenario
     2. Consider refactoring to event-driven as designed, or update design.md
```

**What verify checks:**

| Dimension | What it validates |
|-----------|------------------|
| Completeness | All tasks done, all requirements implemented, scenarios covered |
| Correctness | Implementation matches spec intent, edge cases handled |
| Coherence | Design decisions reflected in code, patterns consistent |

Verify won't block archive, but it surfaces issues you might want to address first.

#### Archive: Finalize the Change

`/skill:openspec-archive-change` completes the change and moves it to the archive:

```text
You: /skill:openspec-archive-change

AI:  Archiving add-auth...

     Artifact status:
     ✓ proposal.md exists
     ✓ specs/ exists
     ✓ design.md exists
     ✓ tasks.md exists (12/12 tasks complete)

     Delta specs: Not yet synced to main
     → Would you like to sync now?

You: Yes

AI:  ✓ Synced specs to openspec/specs/auth/spec.md
     ✓ Moved to openspec/changes/archive/2025-01-24-add-auth/

     Change archived successfully.
```

Archive will prompt if specs aren't synced. It won't block on incomplete tasks, but it will warn you.

## When to Use What

### `/skill:openspec-ff-change` vs `/skill:openspec-continue-change`

| Situation | Use |
|-----------|-----|
| Clear requirements, ready to build | `/skill:openspec-ff-change` |
| Exploring, want to review each step | `/skill:openspec-continue-change` |
| Want to iterate on proposal before specs | `/skill:openspec-continue-change` |
| Time pressure, need to move fast | `/skill:openspec-ff-change` |
| Complex change, want control | `/skill:openspec-continue-change` |

**Rule of thumb:** If you can describe the full scope upfront, use `/skill:openspec-ff-change`. If you're figuring it out as you go, use `/skill:openspec-continue-change`.

### When to Update vs Start Fresh

A common question: when is updating an existing change okay, and when should you start a new one?

**Update the existing change when:**

- Same intent, refined execution
- Scope narrows (MVP first, rest later)
- Learning-driven corrections (codebase isn't what you expected)
- Design tweaks based on implementation discoveries

**Start a new change when:**

- Intent fundamentally changed
- Scope exploded to different work entirely
- Original change can be marked "done" standalone
- Patches would confuse more than clarify

```text
                     ┌─────────────────────────────────────┐
                     │     Is this the same work?          │
                     └──────────────┬──────────────────────┘
                                    │
                 ┌──────────────────┼──────────────────┐
                 │                  │                  │
                 ▼                  ▼                  ▼
          Same intent?      >50% overlap?      Can original
          Same problem?     Same scope?        be "done" without
                 │                  │          these changes?
                 │                  │                  │
       ┌────────┴────────┐  ┌──────┴──────┐   ┌───────┴───────┐
       │                 │  │             │   │               │
      YES               NO YES           NO  NO              YES
       │                 │  │             │   │               │
       ▼                 ▼  ▼             ▼   ▼               ▼
    UPDATE            NEW  UPDATE       NEW  UPDATE          NEW
```

**Example: "Add dark mode"**

- "Need to also support custom themes" → New change (scope exploded)
- "System preference detection is harder than expected" → Update (same intent)
- "Let's ship toggle first, add preferences later" → Update then archive, then new change

## Best Practices

### Keep Changes Focused

One logical unit of work per change. If you're doing "add feature X and also refactor Y", consider two separate changes.

**Why it matters:**
- Easier to review and understand
- Cleaner archive history
- Can ship independently
- Simpler rollback if needed

### Use `/skill:openspec-explore` for Unclear Requirements

Before committing to a change, explore the problem space:

```text
You: /skill:openspec-explore

AI:  What would you like to explore?

You: How should we handle rate limiting for our API?

AI:  Let me investigate your current setup and options...
     [Researches codebase, considers patterns]

     I see three approaches we could take:
     1. Middleware-based (simple, per-endpoint)
     2. Redis-backed (scalable, shared state)
     3. Token bucket per user (fair, complex)

     Your current stack suggests #1 or #2. What's your scale?
```

Exploration clarifies thinking before any code gets written.

### Verify Before Archiving

Use `/skill:openspec-verify-change` to check implementation matches artifacts:

```text
You: /skill:openspec-verify-change

AI:  Verifying add-dark-mode...

     ✓ All tasks in tasks.md are checked
     ✓ Requirements in specs have corresponding code
     ✓ Design decisions are reflected in implementation

     Ready to archive!
```

Catches mismatches before you close out the change.

### Name Changes Clearly

Good names make `omp openspec list` useful:

```text
Good:                          Avoid:
add-dark-mode                  feature-1
fix-login-redirect             update
optimize-product-query         changes
implement-2fa                  wip
```

## Command Quick Reference

For full command details and options, see [Commands](commands.md).

| Command | Purpose | When to Use |
|---------|---------|-------------|
| `/skill:openspec-propose` | Create change + planning artifacts | Fast default path (`core` profile) |
| `/skill:openspec-explore` | Think through ideas with the AI | Start here when unsure: unclear requirements, investigation, comparing options |
| `/skill:openspec-new-change` | Start a change scaffold | Expanded mode, explicit artifact control |
| `/skill:openspec-continue-change` | Create next artifact | Expanded mode, step-by-step artifact creation |
| `/skill:openspec-ff-change` | Create all planning artifacts | Expanded mode, clear scope |
| `/skill:openspec-apply-change` | Implement tasks | Ready to write code |
| `/skill:openspec-verify-change` | Validate implementation | Expanded mode, before archiving |
| `/skill:openspec-sync-specs` | Merge delta specs | Expanded mode, optional |
| `/skill:openspec-archive-change` | Complete the change | All work finished |
| `/skill:openspec-bulk-archive-change` | Archive multiple changes | Expanded mode, parallel work |

## Next Steps

- [Writing Good Specs](writing-specs.md) - What a strong requirement and scenario look like, and how to right-size a change
- [Reviewing a Change](reviewing-changes.md) - The two-minute pass on a drafted plan before any code
- [OpenSpec on a Team](team-workflow.md) - How changes fit branches and pull requests
- [Commands](commands.md) - Full command reference with options
- [Concepts](concepts.md) - Deep dive into specs, artifacts, and schemas
- [Customization](customization.md) - Create custom workflows
