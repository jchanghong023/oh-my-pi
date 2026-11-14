# Migrating to OpenSpec 2.0 in OMP

OMP bundles the CLI and all 12 native Skills. Use `omp openspec ...` in the terminal and `/skill:<name>` in chat. No separate OpenSpec/Node installation or per-Agent setup is required. The old CLI `update` and `opsx` file commands are removed; `openspec-update-change` remains a planning-material Skill.

## Before You Begin

Initialization only creates project structure/configuration, defaults to `spec-driven`, and preserves existing configuration. It does not install or clean user Skills, legacy commands, Agent settings, or marker blocks. Resources update only with OMP releases. Project/user same-name Skill overrides retain their existing precedence.

Users must explicitly migrate old custom schemas such as `mini` and `omp-spec`. There is no bundled alias or private bridge. Inspect `openspec/config.yaml`, each active change's `.openspec.yaml`, and actual artifacts before changing a schema reference. The default `spec-driven` graph requires proposal, specs, design, and tasks; a renamed schema is not completed planning. Missing `design.md` or `tasks.md` must remain incomplete until real materials are authored and reviewed. Do not fabricate completion or disable validation. Historical archives remain untouched; other projects are not automatically migrated.

Existing specs and active changes remain valuable. Review useful `openspec/project.md` context for explicit migration to config as described below. Do not delete user files or rewrite project rules as a side effect of init.

## Migrating project.md to config.yaml

The old `openspec/project.md` was a freeform markdown file for project context. The new `openspec/config.yaml` is structured and—critically—**injected into every planning request** so your conventions are always present when the AI works.

### Before (project.md)

```markdown
# Project Context

This is a TypeScript monorepo using React and Node.js.
We use Jest for testing and follow strict ESLint rules.
Our API is RESTful and documented in docs/api.md.

## Conventions

- All public APIs must maintain backwards compatibility
- New features should include tests
- Use Given/When/Then format for specifications
```

### After (config.yaml)

```yaml
schema: spec-driven

context: |
  Tech stack: TypeScript, React, Node.js
  Testing: Jest with React Testing Library
  API: RESTful, documented in docs/api.md
  We maintain backwards compatibility for all public APIs

rules:
  proposal:
    - Include rollback plan for risky changes
  specs:
    - Use Given/When/Then format for scenarios
    - Reference existing patterns before inventing new ones
  design:
    - Include sequence diagrams for complex flows
```

### Key Differences

| project.md | config.yaml |
|------------|-------------|
| Freeform markdown | Structured YAML |
| One blob of text | Separate context and per-artifact rules |
| Unclear when it's used | Context appears in ALL artifacts; rules appear in matching artifacts only |
| No schema selection | Explicit `schema:` field sets default workflow |

### What to Keep, What to Drop

When migrating, be selective. Ask yourself: "Does the AI need this for *every* planning request?"

**Good candidates for `context:`**
- Tech stack (languages, frameworks, databases)
- Key architectural patterns (monorepo, microservices, etc.)
- Non-obvious constraints ("we can't use library X because...")
- Critical conventions that often get ignored

**Move to `rules:` instead**
- Artifact-specific formatting ("use Given/When/Then in specs")
- Review criteria ("proposals must include rollback plans")
- These only appear for the matching artifact, keeping other requests lighter

**Leave out entirely**
- General best practices the AI already knows
- Verbose explanations that could be summarized
- Historical context that doesn't affect current work

### Migration Steps

1. **Create config.yaml** (if not already created by init):
   ```yaml
   schema: spec-driven
   ```

2. **Add your context** (be concise—this goes into every request):
   ```yaml
   context: |
     Your project background goes here.
     Focus on what the AI genuinely needs to know.
   ```

3. **Add per-artifact rules** (optional):
   ```yaml
   rules:
     proposal:
       - Your proposal-specific guidance
     specs:
       - Your spec-writing rules
   ```

4. **Delete project.md** once you've moved everything useful.

**Don't overthink it.** Start with the essentials and iterate. If you notice the AI missing something important, add it. If context feels bloated, trim it. This is a living document.

### Need Help? Use This Prompt

If you're unsure how to distill your project.md, ask your AI assistant:

```
I'm migrating from OpenSpec's old project.md to the new config.yaml format.

Here's my current project.md:
[paste your project.md content]

Please help me create a config.yaml with:
1. A concise `context:` section (this gets injected into every planning request, so keep it tight—focus on tech stack, key constraints, and conventions that often get ignored)
2. `rules:` for specific artifacts if any content is artifact-specific (e.g., "use Given/When/Then" belongs in specs rules, not global context)

Leave out anything generic that AI models already know. Be ruthless about brevity.
```

The AI will help you identify what's essential vs. what can be trimmed.

---

## The New Commands

All 12 native Skills are bundled; the groups below describe workflow styles, not installation profiles.

**Quick path:**

| Command | Purpose |
|---------|---------|
| `/skill:openspec-propose` | Create a change and generate planning artifacts in one step |
| `/skill:openspec-explore` | Think through ideas with no structure |
| `/skill:openspec-apply-change` | Implement tasks from tasks.md |
| `/skill:openspec-update-change` | Revise a change's planning artifacts and keep them coherent |
| `/skill:openspec-sync-specs` | Merge delta specs into main specs |
| `/skill:openspec-archive-change` | Finalize and archive the change |

**Incremental path:**

| Command | Purpose |
|---------|---------|
| `/skill:openspec-new-change` | Start a new change scaffold |
| `/skill:openspec-continue-change` | Create the next artifact (one at a time) |
| `/skill:openspec-ff-change` | Fast-forward—create planning artifacts at once |
| `/skill:openspec-verify-change` | Validate implementation matches specs |
| `/skill:openspec-bulk-archive-change` | Archive multiple changes at once |
| `/skill:openspec-onboard` | Guided end-to-end onboarding workflow |

All 12 OpenSpec Skills are bundled with OMP and use native discovery, completion, on-demand `skill://<name>` reads, and path authorization in any directory. Project/user same-name overrides keep their existing precedence. No profile selection or duplicate Skill installation is needed. Skill discovery does not authorize project initialization.

### Command Mapping from Legacy

| Legacy | OPSX Equivalent |
|--------|-----------------|
| `/openspec:proposal` | `/skill:openspec-propose` (default) or `/skill:openspec-new-change` then `/skill:openspec-ff-change` (expanded) |
| `/openspec:apply` | `/skill:openspec-apply-change` |
| `/openspec:archive` | `/skill:openspec-archive-change` |

### New Capabilities

These capabilities are part of the expanded workflow command set.

**Granular artifact creation:**
```
/skill:openspec-continue-change
```
Creates one artifact at a time based on dependencies. Use this when you want to review each step.

**Exploration mode:**
```
/skill:openspec-explore
```
Think through ideas with a partner before committing to a change.

---

## Understanding the New Architecture

### From Phase-Locked to Fluid

The legacy workflow forced linear progression:

```
┌──────────────┐      ┌──────────────┐      ┌──────────────┐
│   PLANNING   │ ───► │ IMPLEMENTING │ ───► │   ARCHIVING  │
│    PHASE     │      │    PHASE     │      │    PHASE     │
└──────────────┘      └──────────────┘      └──────────────┘

If you're in implementation and realize the design is wrong?
Too bad. Phase gates don't let you go back easily.
```

OPSX uses actions, not phases:

```
         ┌───────────────────────────────────────────────┐
         │           ACTIONS (not phases)                │
         │                                               │
         │     new ◄──► continue ◄──► apply ◄──► archive │
         │      │          │           │             │   │
         │      └──────────┴───────────┴─────────────┘   │
         │                    any order                  │
         └───────────────────────────────────────────────┘
```

### Dependency Graph

Artifacts form a directed graph. Dependencies are enablers, not gates:

```
                        proposal
                       (root node)
                            │
              ┌─────────────┴─────────────┐
              │                           │
              ▼                           ▼
           specs                       design
        (requires:                  (requires:
         proposal)                   proposal)
              │                           │
              └─────────────┬─────────────┘
                            │
                            ▼
                         tasks
                     (requires:
                     specs, design)
```

When you run `/skill:openspec-continue-change`, it checks what's ready and offers the next artifact. You can also create multiple ready artifacts in any order.

### Skills vs Commands

All 12 OpenSpec Skills are bundled with OMP and use native discovery, completion, on-demand `skill://<name>` reads, and path authorization in any directory. Project/user same-name overrides keep their existing precedence. No profile selection or duplicate Skill installation is needed. Skill discovery does not authorize project initialization.

OMP does not register legacy `opsx` file commands, install duplicate Skills, or clean old tool directories. Use `/skill:<name>`; no per-Agent setup is required.

## Continuing Existing Changes

Review each in-progress change against its selected schema before continuing. Legacy custom schemas require explicit migration, and missing required artifacts remain incomplete.

**Have an active change from the legacy workflow?**

```
/skill:openspec-apply-change add-my-feature
```

OPSX reads the existing artifacts and continues from where you left off.

**Want to add more artifacts to an existing change?**

```
/skill:openspec-continue-change add-my-feature
```

Shows what's ready to create based on what already exists.

**Need to see status?**

```bash
omp openspec status --change add-my-feature
```

---

## The New Config System

### config.yaml Structure

```yaml
# Required: Default schema for new changes
schema: spec-driven

# Optional: Project context (max 50KB)
# Injected into ALL artifact instructions
context: |
  Your project background, tech stack,
  conventions, and constraints.

# Optional: Per-artifact rules
# Only injected into matching artifacts
rules:
  proposal:
    - Include rollback plan
  specs:
    - Use Given/When/Then format
  design:
    - Document fallback strategies
  tasks:
    - Break into 2-hour maximum chunks
```

### Schema Resolution

When determining which schema to use, OPSX checks in order:

1. **CLI flag**: `--schema <name>` (highest priority)
2. **Change metadata**: `.openspec.yaml` in the change directory
3. **Project config**: `openspec/config.yaml`
4. **Default**: `spec-driven`

### Available Schemas

| Schema | Artifacts | Best For |
|--------|-----------|----------|
| `spec-driven` | proposal → specs → design → tasks | Most projects |

List all available schemas:

```bash
omp openspec schemas
```

### Custom Schemas

Create your own workflow:

```bash
omp openspec schema init my-workflow
```

Or fork an existing one:

```bash
omp openspec schema fork spec-driven my-workflow
```

See [Customization](customization.md) for details.

---

## Troubleshooting

### "Legacy files detected in non-interactive mode"

OMP initialization no longer scans or cleans legacy Agent files. Do not pass cleanup flags. If this error comes from an external installation, use the bundled `omp openspec` entry instead.

### Commands not appearing after migration

Check OMP native discovery settings and same-name project/user overrides; do not install or regenerate Skills.

### "Unknown artifact ID in rules"

Check that your `rules:` keys match your schema's artifact IDs:

- **spec-driven**: `proposal`, `specs`, `design`, `tasks`

Run this to see valid artifact IDs:

```bash
omp openspec schemas --json
```

### Config not being applied

1. Ensure the file is at `openspec/config.yaml` (not `.yml`)
2. Validate YAML syntax
3. Config changes take effect immediately—no restart needed

### project.md not migrated

The system intentionally preserves `project.md` because it may contain your custom content. Review it manually, move useful parts to `config.yaml`, then delete it.

### Want to see what would be cleaned up?

Nothing is cleaned up by OMP initialization. Any user-approved retirement of old files is separate from project configuration migration.

## Quick Reference

### Files After Migration

Only explicitly migrated project configuration and change metadata need change. Specs, actual active artifacts, user Skills, Agent rules, and historical archives are preserved. OMP supplies Skills from its bundled resources rather than creating project Skill folders.

### What's Gone

Bundled compatibility schemas (`mini`/`omp-spec`), private bridges, CLI `update`, and legacy `opsx` file commands are not part of the supported interface. Existing user files are not automatically deleted.

### Command Cheatsheet

```text
/skill:openspec-propose      Start quickly (default core profile)
/skill:openspec-apply-change        Implement tasks
/skill:openspec-archive-change      Finish and archive

# Incremental workflow (already bundled):
/skill:openspec-new-change          Scaffold a change
/skill:openspec-continue-change     Create next artifact
/skill:openspec-ff-change           Create planning artifacts
```

---

## Getting Help

- **Discord**: [discord.gg/YctCnvvshC](https://discord.gg/YctCnvvshC)
- **GitHub Issues**: [github.com/Fission-AI/OpenSpec/issues](https://github.com/Fission-AI/OpenSpec/issues)
- **Documentation**: [docs/opsx.md](opsx.md) for the full OPSX reference
