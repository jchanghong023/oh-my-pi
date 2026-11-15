# Getting Started

OpenSpec 2.0 is bundled with OMP; no standalone CLI, Node, or Skill installation is required. Initialize only when explicitly authorized to create project structure/configuration. See [Project setup](installation.md) and the [documentation home](README.md).

> **Where do I type these commands?** Two places, and mixing them up is the most common early stumble.
>
> - `omp openspec ...` commands (like `omp openspec init`) run in your **terminal**.
> - `/skill:<name>` commands (like `/skill:openspec-propose`) run in your **AI assistant's chat**, the same box where you'd ask it to write code.
>
> There's no separate "interactive mode" to start. You just type the slash command in chat and your assistant takes it from there. Full explanation: [How Commands Work](how-commands-work.md).

## Your First Five Minutes

The whole loop, with each step labeled by where it happens:

```text
TERMINAL   $ cd your-project && omp openspec init
AI CHAT      /skill:openspec-explore                    (optional: think it through first)
AI CHAT      /skill:openspec-propose add-dark-mode      (AI drafts the plan; you review it)
AI CHAT      /skill:openspec-apply-change                      (AI builds it)
AI CHAT      /skill:openspec-archive-change                    (specs updated, change filed away)
```

One explicitly authorized project initialization, then the workflow lives in chat. `init` defaults to `spec-driven` and does not install, update, or clean user Skills, Agent settings, or legacy commands. Bundled resources update only with OMP releases; CLI `update` and file-based `opsx` commands are removed. `openspec-update-change` remains a Skill for revising planning artifacts.

> **Not sure what to build yet? Start with `/skill:openspec-explore`.** It's a no-stakes thinking partner that reads your codebase, weighs options, and sharpens a fuzzy idea into a concrete plan, all before any code gets written. When the picture is clear, it hands off to `/skill:openspec-propose`. This is the single best habit for working with an AI that will otherwise confidently build the wrong thing. See the [Explore guide](explore.md).

## How It Works

OpenSpec helps you and your AI coding assistant agree on what to build before any code is written.

**Quick path (already bundled):**

```text
/skill:openspec-explore ──► /skill:openspec-propose ──► /skill:openspec-apply-change ──► /skill:openspec-sync-specs ──► /skill:openspec-archive-change
   (optional)
```

Start with `/skill:openspec-explore` when you're figuring out what to do, or jump straight to `/skill:openspec-propose` when you already know. Explore is among the bundled Skills, so it's always there when you want it.

**Incremental planning path (also bundled):**

```text
/skill:openspec-new-change ──► /skill:openspec-ff-change or /skill:openspec-continue-change ──► /skill:openspec-apply-change ──► /skill:openspec-verify-change ──► /skill:openspec-archive-change
```

All 12 OpenSpec Skills are bundled with OMP and use native discovery, completion, on-demand `skill://<name>` reads, and path authorization in any directory. Project/user same-name overrides keep their existing precedence. No profile selection or duplicate Skill installation is needed. Skill discovery does not authorize project initialization.

## What OpenSpec Creates

Initialization creates `specs/`, `changes/`, and `config.yaml`. The following illustrates a populated project after planning a change; init does not generate proposal/spec/design/task content:

```
openspec/
├── specs/              # Source of truth (your system's behavior)
│   └── <domain>/
│       └── spec.md
├── changes/            # Proposed updates (one folder per change)
│   └── <change-name>/
│       ├── proposal.md
│       ├── design.md
│       ├── tasks.md
│       └── specs/      # Delta specs (what's changing)
│           └── <domain>/
│               └── spec.md
└── config.yaml         # Project configuration, default schema: spec-driven
```

**Two key directories:**

- **`specs/`** - The source of truth. These specs describe how your system currently behaves. Organized by domain (e.g., `specs/auth/`, `specs/payments/`).

- **`changes/`** - Proposed modifications. Each change gets its own folder with all related artifacts. When a change is complete, its specs merge into the main `specs/` directory.

## Understanding Artifacts

Each change folder contains artifacts that guide the work:

| Artifact | Purpose |
|----------|---------|
| `proposal.md` | The "why" and "what" - captures intent, scope, and approach |
| `specs/` | Delta specs showing ADDED/MODIFIED/REMOVED requirements |
| `design.md` | The "how" - technical approach and architecture decisions |
| `tasks.md` | Implementation checklist with checkboxes |

**Artifacts build on each other:**

```
proposal ──► specs ──► design ──► tasks ──► implement
   ▲           ▲          ▲                    │
   └───────────┴──────────┴────────────────────┘
            update as you learn
```

You can always go back and refine earlier artifacts as you learn more during implementation.

## How Delta Specs Work

Delta specs are the key concept in OpenSpec. They show what's changing relative to your current specs.

### The Format

Delta specs use sections to indicate the type of change:

```markdown
# Delta for Auth

## ADDED Requirements

### Requirement: Two-Factor Authentication
The system MUST require a second factor during login.

#### Scenario: OTP required
- GIVEN a user with 2FA enabled
- WHEN the user submits valid credentials
- THEN an OTP challenge is presented

## MODIFIED Requirements

### Requirement: Session Timeout
The system SHALL expire sessions after 30 minutes of inactivity.
(Previously: 60 minutes)

#### Scenario: Idle timeout
- GIVEN an authenticated session
- WHEN 30 minutes pass without activity
- THEN the session is invalidated

## REMOVED Requirements

### Requirement: Remember Me
(Deprecated in favor of 2FA)
```

### What Happens on Archive

When you archive a change:

1. **ADDED** requirements are appended to the main spec
2. **MODIFIED** requirements replace the existing version
3. **REMOVED** requirements are deleted from the main spec

The change folder moves to `openspec/changes/archive/` for audit history.

## Example: Your First Change

Let's walk through adding dark mode to an application.

### 1. Start the Change (Default)

```text
You: /skill:openspec-propose add-dark-mode

AI:  Created openspec/changes/add-dark-mode/
     ✓ proposal.md — why we're doing this, what's changing
     ✓ specs/       — requirements and scenarios
     ✓ design.md    — technical approach
     ✓ tasks.md     — implementation checklist
     Ready for implementation!
```

If you've enabled the expanded workflow profile, you can also do this as two steps: `/skill:openspec-new-change` then `/skill:openspec-ff-change` (or `/skill:openspec-continue-change` incrementally).

### 2. What Gets Created

**proposal.md** - Captures the intent:

```markdown
# Proposal: Add Dark Mode

## Intent
Users have requested a dark mode option to reduce eye strain
during nighttime usage.

## Scope
- Add theme toggle in settings
- Support system preference detection
- Persist preference in localStorage

## Approach
Use CSS custom properties for theming with a React context
for state management.
```

**specs/ui/spec.md** - Delta showing new requirements:

```markdown
# Delta for UI

## ADDED Requirements

### Requirement: Theme Selection
The system SHALL allow users to choose between light and dark themes.

#### Scenario: Manual toggle
- GIVEN a user on any page
- WHEN the user clicks the theme toggle
- THEN the theme switches immediately
- AND the preference persists across sessions

#### Scenario: System preference
- GIVEN a user with no saved preference
- WHEN the application loads
- THEN the system's preferred color scheme is used
```

**tasks.md** - Implementation checklist:

```markdown
# Tasks

## 1. Theme Infrastructure
- [ ] 1.1 Create ThemeContext with light/dark state
- [ ] 1.2 Add CSS custom properties for colors
- [ ] 1.3 Implement localStorage persistence

## 2. UI Components
- [ ] 2.1 Create ThemeToggle component
- [ ] 2.2 Add toggle to settings page
- [ ] 2.3 Update Header to include quick toggle

## 3. Styling
- [ ] 3.1 Define dark theme color palette
- [ ] 3.2 Update components to use CSS variables
```

### 3. Implement

```
You: /skill:openspec-apply-change

AI:  Working through tasks...
     ✓ 1.1 Created ThemeContext with light/dark state
     ✓ 1.2 Added CSS custom properties to globals.css
     ✓ 1.3 Implemented localStorage persistence
     ✓ 2.1 Created ThemeToggle component
     ...
     All tasks complete!
```

During implementation, if you discover the design needs adjustment, just update the artifact and continue.

### 4. Archive

```
You: /skill:openspec-archive-change

AI:  Archiving add-dark-mode...
     ✓ Merged specs into openspec/specs/ui/spec.md
     ✓ Moved to openspec/changes/archive/2025-01-24-add-dark-mode/
     Done! Ready for the next feature.
```

Your delta specs are now part of the main specs, documenting how your system works.

## Verifying and Reviewing

Use the CLI to check on your changes:

```bash
# List active changes
omp openspec list

# View change details
omp openspec show add-dark-mode

# Validate spec formatting
omp openspec validate add-dark-mode

# Interactive dashboard
omp openspec view
```

## Next Steps

- [Explore First](explore.md) - Use `/skill:openspec-explore` to think through an idea before you commit
- [Reviewing a Change](reviewing-changes.md) - What to check in the plan the AI drafts, before any code
- [Writing Good Specs](writing-specs.md) - What a strong requirement and scenario look like
- [Using OpenSpec in an Existing Project](existing-projects.md) - Start on a large brownfield codebase
- [Editing & Iterating on a Change](editing-changes.md) - Update artifacts, go back, reconcile manual edits
- [Core Concepts at a Glance](overview.md) - The whole mental model on one page
- [Examples & Recipes](examples.md) - Real changes, start to finish
- [Workflows](workflows.md) - Common patterns and when to use each command
- [Commands](commands.md) - Full reference for all slash commands
- [Concepts](concepts.md) - Deeper understanding of specs, changes, and schemas
- [Customization](customization.md) - Make OpenSpec work your way
- [Local context and worksets](cli.md#working-context-local-project) - Inspect your project or reopen folders together
- [FAQ](faq.md) and [Troubleshooting](troubleshooting.md) - When you get stuck
