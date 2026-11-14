# CLI Reference

The OpenSpec CLI (`openspec`) provides terminal commands for project setup, validation, status inspection, and management. These commands complement the native OMP Skills (like `/skill:openspec-propose`) documented in [Commands](commands.md).

## Summary

| Category | Commands | Purpose |
|----------|----------|---------|
| **Setup** | `init` | Initialize project structure and configuration |
| **Stores (standalone OpenSpec repos)** | `store setup`, `store register`, `store unregister`, `store remove`, `store list`, `store doctor` | Manage stores — standalone OpenSpec repos you've registered |
| **Health** | `doctor` | Report relationship health for the resolved root |
| **Working context** | `context` | Assemble the working set (root + referenced stores) |
| **Personal worksets** | `workset create`, `workset list`, `workset open`, `workset remove` | Keep and open personal, local working views in your tool |
| **Browsing** | `list`, `view`, `show` | Explore changes and specs |
| **Validation** | `validate` | Check changes and specs for issues |
| **Lifecycle** | `archive` | Finalize completed changes |
| **Workflow** | `new change`, `status`, `instructions`, `templates`, `schemas` | Artifact-driven workflow support |
| **Schemas** | `schema init`, `schema fork`, `schema validate`, `schema which` | Create and manage custom workflows |
| **Config** | `config` | View and modify settings |
| **Utility** | `feedback` | Feedback |

---

## Human vs Agent Commands

Most CLI commands are designed for **human use** in a terminal. Some commands also support **agent/script use** via JSON output.

### Human-Only Commands

These commands are interactive and designed for terminal use:

| Command | Purpose |
|---------|---------|
| `omp openspec init` | Initialize project (interactive prompts) |
| `omp openspec view` | Interactive dashboard |
| `omp openspec workset open <name>` | Open a saved workset (editor window or terminal agent session) |
| `omp openspec config edit` | Open config in editor |
| `omp openspec feedback` | Submit feedback via GitHub |

### Agent-Compatible Commands

These commands support `--json` output for programmatic use by AI agents and scripts:

| Command | Human Use | Agent Use |
|---------|-----------|-----------|
| `omp openspec list` | Browse changes/specs | `--json` for structured data |
| `omp openspec show <item>` | Read content | `--json` for parsing |
| `omp openspec validate` | Check for issues | `--all --json` for bulk validation |
| `omp openspec status` | See artifact progress | `--json` for structured status |
| `omp openspec instructions` | Get next steps | `--json` for agent instructions |
| `omp openspec templates` | Find template paths | `--json` for path resolution |
| `omp openspec schemas` | List available schemas | `--json` for schema discovery; `--store <id>` to select a registered root |
| `omp openspec store setup <id>` | Create and register a local store | `--json` with explicit inputs for structured setup output |
| `omp openspec store register <path>` | Register an existing store | `--json` for structured registration output |
| `omp openspec store unregister <id>` | Forget a local store registration | `--json` for structured cleanup output |
| `omp openspec store remove <id>` | Delete a registered local store folder | `--yes --json` for non-interactive deletion |
| `omp openspec store list` | Browse registered stores | `--json` for structured registrations |
| `omp openspec store doctor` | Check local store setup | `--json` for structured diagnostics |
| `omp openspec new change <id>` | Create repo-local change scaffolding | `--json`, plus `--store <id>` to use a registered store as the OpenSpec root |
| `omp openspec workset create [name]` | Compose a personal working view | `--member <path> --json` for non-interactive composition |
| `omp openspec workset list` | Browse saved worksets | `--json` for structured views |
| `omp openspec workset remove <name>` | Delete a saved view | `--yes --json` for non-interactive removal |

---

## Global Options

These options work with all commands:

| Option | Description |
|--------|-------------|
| `--version`, `-V` | Show version number |
| `--no-color` | Disable color output |
| `--help`, `-h` | Display help for command |

---

## Setup Commands

### `omp openspec init`

Initialize the explicitly selected project, not Skill delivery. No standalone OpenSpec/Node installation is required.

```bash
omp openspec init [path] [--language <language>]
```

The target defaults to the current directory. Initialization creates project structure and configuration with `spec-driven` as the default schema. Existing configuration is preserved; a conflicting language request fails rather than overwriting context. Store pointers are not converted into local planning roots. Obtain explicit authorization before initializing an uninitialized project.

It does not create, update, or remove user Skills, Agent directories, legacy command files, or global prompts. All 12 Skills are already bundled with OMP and discoverable in any directory. There are no `--tools`, `--profile`, or cleanup options.

```text
openspec/
├── specs/
├── changes/
└── config.yaml
```

Upgrade OMP to update resources. CLI `update` and file-based `opsx` commands are removed; `openspec-update-change` remains the planning-material editing Skill.

## Stores (standalone OpenSpec repos)

> **Beta.** Stores and the features built on them (references, working context, worksets) are new; command names, flags, file formats, and JSON output may change shape between releases. For the problem-first walkthrough, see the [stores guide](stores-beta/user-guide.md).

A store is a standalone OpenSpec repo you've registered on this machine — for example a planning repo or a contracts repo. Registering a store lets normal commands (`list`, `show`, `status`, `validate`, `new change`, `archive`, ...) act in it from anywhere by passing `--store <id>`.

### `omp openspec store setup`

Create and register a local store. With no arguments in a terminal,
OpenSpec guides the user through setup. Agents and scripts should pass explicit
inputs and use `--json`.

```bash
omp openspec store setup [id] [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--path <path>` | Folder where the store should live (for example `~/openspec/<id>`) |
| `--remote <url>` | Record the canonical remote in the new store's `store.yaml` |
| `--init-git` | Initialize a Git repository with an initial commit (default) |
| `--no-init-git` | Skip every Git action: no init, no initial commit |
| `--json` | Output JSON |

Non-interactive runs (`--json`, scripts, agents) must pass both the store id and `--path`. In an interactive terminal, setup prompts for the location with an editable suggestion in a visible, user-owned place (for example `~/openspec/<id>`); it never defaults to OpenSpec's managed data directory.

Examples:

```bash
omp openspec store setup
omp openspec store setup team-context
omp openspec store setup team-context --path ~/openspec/team-context --no-init-git
omp openspec store setup team-context --path ~/openspec/team-context --no-init-git --json
```

### `omp openspec store register`

Register an existing local store folder. During the stores beta, a root may be
registered before any changes exist, specs have been applied, or changes have
been archived; in that case `openspec/changes/`, `openspec/specs/`, and
`openspec/changes/archive/` may be absent until normal commands create them.
A config-only repo that declares `store: <id>` remains a pointer to another
store and is not registered as a store root unless that pointer is removed.

```bash
omp openspec store register [path] [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--id <id>` | Store id; defaults to store metadata or folder name |
| `--yes` | Confirm creating store identity metadata for a healthy OpenSpec root |
| `--json` | Output JSON |

### `omp openspec store unregister`

Forget a local store registration without deleting files.

```bash
omp openspec store unregister <id> [--json]
```

Use this when a store was moved, cloned somewhere else, or should no longer be
shown by OpenSpec on this machine.

### `omp openspec store remove`

Forget a local store registration and delete its local folder.

```bash
omp openspec store remove <id> [--yes] [--json]
```

`remove` shows the exact folder before deleting in an interactive terminal.
Agents, scripts, and JSON callers must pass `--yes` to confirm deletion.
OpenSpec refuses to delete a folder that does not contain matching
store metadata.

### `omp openspec store list`

List locally registered stores.

```bash
omp openspec store list [--json]
omp openspec store ls [--json]
```

### `omp openspec store doctor`

Check local store registration, metadata, and Git presence.

```bash
omp openspec store doctor [id] [--json]
```

Doctor is diagnostic-only; it reports missing roots, metadata mismatches, and invalid local registry state without modifying the store.

### Referencing stores from a project

A project repo can declare which stores its work draws on in `openspec/config.yaml`:

```yaml
schema: spec-driven
references:
  - team-context
```

From then on, `omp openspec instructions` output in that repo (both the per-artifact and `apply` surfaces, JSON and human modes) carries an index of each referenced store's specs — spec ids, a one-line summary from each spec's Purpose section, and the fetch command (`omp openspec show <spec-id> --type spec --store <id>`). The index is built live from the registered checkout on every run; spec content is never copied into the output.

References are read-only context. They never change where commands act: work stays in the repo's own root, and writing to a referenced store remains an explicit `--store` action. A reference that cannot be resolved (for example, a store not registered on this machine) degrades to a warning in the index with the exact fix, and instructions still generate. `omp openspec doctor` reports reference health in one place.

### Recording where a store is cloned from

A store can record its canonical clone source in its committed identity file, so onboarding never dead-ends at "register the store":

```bash
omp openspec store setup team-context --path ~/openspec/team-context \
  --remote git@github.com:acme/team-context.git
```

The remote lands in `.openspec-store/store.yaml` inside the initial commit, so every clone is born knowing it. For an existing store, edit `store.yaml` by hand and commit. `store doctor` shows the recorded remote (and the checkout's observed Git origin); setup/register sharing guidance names it; and register records the checkout's origin in the machine-local registry.

A reference declaration can carry the clone source too, so a teammate who doesn't have the store yet gets a complete, pasteable fix (`git clone <remote> <path> && omp openspec store register <path> --id <id>`):

```yaml
references:
  - { id: team-context, remote: "git@github.com:acme/team-context.git" }
```

Recording a remote is not sync: OpenSpec never clones, pulls, or pushes on its own.

### Declaring a default store

A repo whose planning is fully externalized — no local `openspec/specs/` or `openspec/changes/` — can declare its store once instead of passing `--store` on every command:

```yaml
# openspec/config.yaml (the only file under openspec/)
store: team-context
```

Normal commands then resolve to the declared store automatically; the root banner and JSON `root` block report `source: "declared"` with the store id, and printed hints still carry `--store <id>`. The declaration is a fallback, never an override: explicit `--store` always wins, and a directory with real planning folders ignores the pointer (with a warning). To convert a pointer repo into a local OpenSpec root, remove the `store:` line and run `omp openspec init` — init refuses to scaffold while the declaration is present.

A machine-level variant covers every repo at once: `omp openspec config set defaultStore <id>` (see Configuration). It is consulted only after `--store`, a local root, and a project pointer have all failed to resolve; the root banner and JSON `root` block then report `source: "global_default"`.

## Doctor (relationship health)

One read-only question, one place: is the OpenSpec root healthy, and are the stores it references available on this machine?

```bash
omp openspec doctor [--store <id>] [--json]
```

The report separates root health, store metadata health (including a note when the recorded remote and the checkout's origin diverge, and a note when the store checkout has drifted behind its last-fetched upstream tracking ref), and reference health (the same diagnostics instructions show, with clone fixes for unresolved references). Health findings of any severity exit 0 — agents read the `status` arrays; only command failures (no root, unknown store) exit 1. Doctor never clones, syncs, or repairs. To get the assembled set itself rather than its health, use `omp openspec context`.

## Working context (the assembled set)

Everything this work relates to through OpenSpec declarations, in one working set: the OpenSpec root and the stores it references.

```bash
omp openspec context [--store <id>] [--json] [--code-workspace <path> [--force]]
```

The JSON brief is agent-consumable (each available referenced store carries its fetch recipe; unresolved members carry the same fixes instructions and doctor show). `--code-workspace` additionally writes a VS Code workspace file containing the root plus the available referenced stores (`ref:<id>` folders) — the one write this command performs, refused without `--force` if the file exists. Unavailable members are reported, never guessed at.

"Working context" is the assembled set; the `context:` field in `openspec/config.yaml` is project background injected into instructions — two different things. `omp openspec doctor` answers whether the set is healthy; `omp openspec context` answers what the set is.

## Personal worksets

> **Beta.** Worksets are part of the new beta surface; commands, flags, and file formats may change shape between releases. For the walkthrough, see the [stores guide](stores-beta/user-guide.md#worksets-reopen-the-folders-you-work-on-together).

A workset is a personal, named view of the folders you work on together — a planning root plus whatever else you choose — kept on your machine and reopened by name in your tool. It is purely local: never committed, never shared, never derived from declarations, and removing one never touches a member folder.

```bash
omp openspec workset create [name] [--member <path> | --member <name>=<path>]... [--tool <id>] [--json]
omp openspec workset list [--json]
omp openspec workset open <name> [--tool <id>]
omp openspec workset remove <name> [--yes] [--json]
```

`create` runs a short guided flow (or takes `--member` flags non-interactively; the first member is the primary — sessions start there). `open` launches the chosen tool: editors (VS Code, Cursor) open a window with every member and return; CLI agents (Claude Code, codex) take over this terminal as a session with every member attached and no prompt pre-filled, ending when you exit. A member folder missing at open time is skipped with a note; the rest opens. The saved tool preference is overridable per open with `--tool`.

Supporting a new tool is configuration, not code. Every tool is one of two launch styles — `workspace-file` (launched with the generated `.code-workspace`) or `attach-dirs` (one attach flag per member) — and the `openers` key in the global `config.json` (open it with `omp openspec config edit`) adds tools or adjusts built-ins per field:

```json
{
  "openers": {
    "zed": { "style": "workspace-file" },
    "claude": { "attach_flag": "--dir" }
  }
}
```

All workset state lives under the global data dir's `worksets/` folder (the saved views plus the generated `<name>.code-workspace` files, regenerated on every open); deleting that folder removes every trace.

---

## Browsing Commands

### `omp openspec list`

List changes or specs in your project.

```
omp openspec list [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--specs` | List specs instead of changes |
| `--changes` | List changes (default) |
| `--sort <order>` | Sort by `recent` (default) or `name` |
| `--json` | Output as JSON |

**Examples:**

```bash
# List all active changes
omp openspec list

# List all specs
omp openspec list --specs

# JSON output for scripts
omp openspec list --json
```

**Output (text):**

```
Changes:
  add-dark-mode     No tasks      just now
```

---

### `omp openspec view`

Display an interactive dashboard for exploring specs and changes.

```
omp openspec view
```

Opens a terminal-based interface for navigating your project's specifications and changes.

---

### `omp openspec show`

Display details of a change or spec.

```
omp openspec show [item-name] [options]
```

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `item-name` | No | Name of change or spec (prompts if omitted) |

**Options:**

| Option | Description |
|--------|-------------|
| `--type <type>` | Specify type: `change` or `spec` (auto-detected if unambiguous) |
| `--json` | Output as JSON |
| `--no-interactive` | Disable prompts |

**Change-specific options:**

| Option | Description |
|--------|-------------|
| `--deltas-only` | Show only delta specs (JSON mode) |

**Spec-specific options:**

| Option | Description |
|--------|-------------|
| `--requirements` | Show only requirements, exclude scenarios (JSON mode) |
| `--no-scenarios` | Exclude scenario content (JSON mode) |
| `-r, --requirement <id>` | Show specific requirement by 1-based index (JSON mode) |

**Examples:**

```bash
# Interactive selection
omp openspec show

# Show a specific change
omp openspec show add-dark-mode

# Show a specific spec
omp openspec show auth --type spec

# JSON output for parsing
omp openspec show add-dark-mode --json
```

---

## Validation Commands

### `omp openspec validate`

Validate changes and specs for structural issues, and check a change's MODIFIED requirements against the main specs they would replace.

```
omp openspec validate [item-name] [options]
```

A change with zero spec deltas fails validation unless its `.openspec.yaml` declares `skip_specs: true` (for pure refactors, tooling, or docs work — see [Recipe 5](examples.md#recipe-5-a-refactor-with-no-behavior-change)).

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `item-name` | No | Specific item to validate (prompts if omitted) |

**Options:**

| Option | Description |
|--------|-------------|
| `--all` | Validate all changes and specs |
| `--changes` | Validate all changes |
| `--specs` | Validate all specs |
| `--archived` | Validate that archived changes have all tasks completed (for pre-commit linting) |
| `--type <type>` | Specify type when name is ambiguous: `change` or `spec` |
| `--strict` | Enable strict validation mode |
| `--json` | Output as JSON |
| `--concurrency <n>` | Max parallel validations (default: 6, or `OPENSPEC_CONCURRENCY` env) |
| `--no-interactive` | Disable prompts |

`--archived` is its own scope: it does not validate spec deltas (already applied at archive time), it verifies that every change under `changes/archive/` has all of its `tasks.md` checkboxes ticked, exiting non-zero if any are unchecked. This catches changes that were archived with unfinished work — handy in a pre-commit hook.

**Examples:**

```bash
# Interactive validation
omp openspec validate

# Validate a specific change
omp openspec validate add-dark-mode

# Validate all changes
omp openspec validate --changes

# Validate everything with JSON output (for CI/scripts)
omp openspec validate --all --json

# Strict validation with increased parallelism
omp openspec validate --all --strict --concurrency 12

# Fail if any archived change still has unchecked tasks
omp openspec validate --archived
```

**Output (text):**

```
Validating add-dark-mode...
  ✓ proposal.md valid
  ✓ specs/ui/spec.md valid
  ⚠ design.md: missing "Technical Approach" section

1 warning found
```

**Output (JSON):**

```json
{
  "version": "1.0.0",
  "results": {
    "changes": [
      {
        "name": "add-dark-mode",
        "valid": true,
        "warnings": ["design.md: missing 'Technical Approach' section"]
      }
    ]
  },
  "summary": {
    "total": 1,
    "valid": 1,
    "invalid": 0
  }
}
```

---

## Lifecycle Commands

### `omp openspec archive`

Archive a completed change and merge delta specs into main specs.

```
omp openspec archive [change-name] [options]
```

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `change-name` | No | Change to archive (prompts if omitted; required when nothing can answer the prompt) |

**Options:**

| Option | Description |
|--------|-------------|
| `-y, --yes` | Skip confirmation prompts. Required when nothing can answer them — an AI agent, a CI job, or any run with stdin closed |
| `--skip-specs` | Skip spec updates for one archive run. A change that permanently has no spec deltas should declare `skip_specs: true` in its `.openspec.yaml` instead — it archives with no flag |
| `--no-validate` | Skip validation (requires confirmation). Also disables capability retirement — with no validator verdict, nothing is retired |

**Examples:**

```bash
# Interactive archive (asks which change, then confirms)
omp openspec archive

# Archive specific change
omp openspec archive add-dark-mode

# Archive without prompts (agents, CI, scripts)
omp openspec archive add-dark-mode --yes

# Archive a tooling change that doesn't affect specs
omp openspec archive update-ci-config --skip-specs
```

**Retire a capability:** Add the retirement marker to the change metadata:

```yaml
# openspec/changes/retire-legacy/.openspec.yaml
schema: spec-driven
retire_capabilities: true
```

Then archive the change normally:

```bash
omp openspec archive retire-legacy --yes
```

**Keep your own metadata:** a top-level key starting with a lowercase `x-` is
yours. OpenSpec never reads, writes or reports it, so `omp openspec validate
--strict` stays green on a change that carries tool-specific data:

```yaml
# openspec/changes/add-dark-mode/.openspec.yaml
schema: spec-driven
x-tracker: SB-5497
x-jiraKey: ABC-1
```

The name after the prefix is yours to choose, in any case or spelling, as long
as it is not empty and has no whitespace in it. Two limits: the prefix itself is
lowercase, so `X-Tracker` is still reported, and extensions are top-level only —
a key inside `initiative:` is rejected whatever it is called. Any other
unrecognized top-level key is still reported as having no effect.

When the change removes the capability's last requirement, OpenSpec deletes its
live `spec.md`. Other capability deltas in the same change still update their
main specs. Without the marker, archive stops before changing any files and
tells you to add it.

**What it does:**

1. Validates the change (unless `--no-validate`)
2. Prompts for confirmation (unless `--yes`)
3. Claims the archive destination before changing any main spec
4. Validates and merges the active delta specs into `openspec/specs/` — a capability whose last requirement the change removes is retired, and its spec file deleted, but only when the change's `.openspec.yaml` declares `retire_capabilities: true` next to its `schema:`
5. Moves the change folder to `openspec/changes/archive/YYYY-MM-DD-<name>/`
6. If a spec mutation or final move fails before a complete archive is secured, restores the specs and leaves or returns the change at its active path
7. If a verified fallback copy completes but staged-source cleanup fails, retains the complete archive and committed spec state for recovery

**Without a terminal:** an AI agent, a CI job, or any run with stdin closed cannot
answer step 2, so archive stops before touching anything, exits 1, and names the
command to rerun — `omp openspec archive <name> --yes`, carrying whatever other flags
you passed. Pass `--yes` (and the change name) up front to skip the round trip.

---

## Workflow Commands

These commands support the artifact-driven OPSX workflow. They're useful for both humans checking progress and agents determining next steps.

### `omp openspec new change`

Create a change directory and optional checked-in metadata in the resolved OpenSpec root.

```bash
omp openspec new change <name> [options]
```

Change names must use lowercase kebab-case: lowercase letters, numbers, and
single hyphens. They cannot contain spaces, underscores, uppercase letters,
consecutive hyphens, or leading/trailing hyphens. A leading number is allowed,
so you can prefix names to order or tier changes, for example `100-add-feature`
or `00001-add-auth`.

**Options:**

| Option | Description |
|--------|-------------|
| `--description <text>` | Description to add to `README.md` |
| `--goal <text>` | Optional goal metadata to store with the change |
| `--schema <name>` | Workflow schema to use |
| `--store <id>` | Store id to use as the OpenSpec root (a store is a standalone OpenSpec repo you've registered) |
| `--json` | Output JSON |

Examples:

```bash
omp openspec new change add-billing-api
omp openspec new change add-billing-api --store team-context --json
```

### `omp openspec status`

Display artifact completion status for a change.

```
omp openspec status [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--change <id>` | Change name (prompts if omitted) |
| `--schema <name>` | Schema override (auto-detected from change's config) |
| `--json` | Output as JSON |

**Examples:**

```bash
# Interactive status check
omp openspec status

# Status for specific change
omp openspec status --change add-dark-mode

# JSON for agent use
omp openspec status --change add-dark-mode --json
```

**Output (text):**

```
Change: add-dark-mode
Schema: spec-driven
Progress: 2/4 artifacts complete

[x] proposal
[x] specs
[ ] design
[-] tasks (blocked by: design)
```

A change that declares `skip_specs: true` shows its specs stage as `[~] specs (skipped: change declares skip_specs)` and excludes it from the progress count.

**Output (JSON):**

```json
{
  "changeName": "add-dark-mode",
  "schemaName": "spec-driven",
  "isPlanningComplete": false,
  "isComplete": false,
  "applyRequires": ["tasks"],
  "artifacts": [
    {"id": "proposal", "outputPath": "proposal.md", "status": "done", "requires": []},
    {"id": "specs", "outputPath": "specs/**/*.md", "status": "done", "requires": ["proposal"]},
    {"id": "design", "outputPath": "design.md", "status": "ready", "requires": ["proposal"]},
    {"id": "tasks", "outputPath": "tasks.md", "status": "blocked", "requires": ["specs", "design"], "missingDeps": ["design"]}
  ]
}
```

`isPlanningComplete` reports whether every non-skipped planning artifact exists;
skipped artifacts count as satisfied without being created. It does not report
whether implementation tasks are complete. `isComplete` is retained as a
compatibility alias with the same value.

Artifacts are listed in dependency order - a dependency never appears after
something that requires it - and artifacts that become ready at the same time
(spec-driven's `specs` and `design` both need only `proposal`) keep the order the
schema declares them rather than an alphabetical one. So the first `ready` entry
is the artifact to write next.

---

### `omp openspec instructions`

Get enriched instructions for creating an artifact or applying tasks. Used by AI agents to understand what to create next.

```
omp openspec instructions [artifact] [options]
```

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `artifact` | No | Artifact ID, or workflow input surface: `apply` or `archive` |

**Options:**

| Option | Description |
|--------|-------------|
| `--change <id>` | Change name (required in non-interactive mode) |
| `--schema <name>` | Schema override |
| `--json` | Output as JSON |

**Special cases:** Use `apply` to get task implementation instructions. Use
`archive` to fetch current, read-only archive inputs (`context` and
`operationGuidance`) for a valid change; it does not archive or mutate anything.

**Examples:**

```bash
# Get instructions for next artifact
omp openspec instructions --change add-dark-mode

# Get specific artifact instructions
omp openspec instructions design --change add-dark-mode

# Get apply/implementation instructions
omp openspec instructions apply --change add-dark-mode

# Get current archive operation inputs without archiving
omp openspec instructions archive --change add-dark-mode --json

# JSON for agent consumption
omp openspec instructions design --change add-dark-mode --json
```

**Output includes:**

- Template content for the artifact
- Project context from config
- Content from dependency artifacts
- Per-artifact rules from config
- Current project context and matching operation guidance for `apply`/`archive`

Operation inputs are read from the resolved repo or selected store on every
invocation. Project context is a required prompt-level input: agents read it and
apply relevant project facts, conventions, and constraints. Operation guidance is
optional additive advice: agents consider every entry and follow only entries that
are applicable and compatible with the built-in workflow. Both fields remain
separate from explicit user choices, CLI-controlled state, built-in instructions,
and artifact rules. Conflicting context is reported; conflicting or inapplicable
guidance is not followed and the reason is explained. These are behavioral
contracts for generated agents, not enforceable CLI checks. `instructions archive`
returns only the selected change, optional inputs, and root metadata; it does not
include the static archive workflow.

For an artifact skipped via `skip_specs: true`, the output is a warning only (JSON adds `skipped`/`warning` fields) — the artifact must not be created.

---

### `omp openspec templates`

Show resolved template paths for all artifacts in a schema.

```
omp openspec templates [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--schema <name>` | Schema to inspect (default: `spec-driven`) |
| `--json` | Output as JSON |

**Examples:**

```bash
# Show template paths for default schema
omp openspec templates

# Show templates for custom schema
omp openspec templates --schema my-workflow

# JSON for programmatic use
omp openspec templates --json
```

**Output (text):**

```
Schema: spec-driven

Templates:
  proposal  → ~/.openspec/schemas/spec-driven/templates/proposal.md
  specs     → ~/.openspec/schemas/spec-driven/templates/specs.md
  design    → ~/.openspec/schemas/spec-driven/templates/design.md
  tasks     → ~/.openspec/schemas/spec-driven/templates/tasks.md
```

---

### `omp openspec schemas`

List available workflow schemas with their descriptions and artifact flows.

```
omp openspec schemas [options]
```

**Options:**

| Option | Description |
|--------|-------------|
| `--json` | Output as JSON |
| `--store <id>` | Use a registered store as the OpenSpec root |

**Example:**

```bash
omp openspec schemas
```

**Output:**

```
Available schemas:

  spec-driven (package)
    The default spec-driven development workflow
    Flow: proposal → specs → design → tasks

  my-custom (project)
    Custom workflow for this project
    Flow: research → proposal → tasks
```

---

## Schema Commands

Commands for creating and managing custom workflow schemas.

### `omp openspec schema init`

Create a new project-local schema.

```
omp openspec schema init <name> [options]
```

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | Yes | Schema name (kebab-case) |

**Options:**

| Option | Description |
|--------|-------------|
| `--description <text>` | Schema description |
| `--artifacts <list>` | Comma-separated artifact IDs (default: `proposal,specs,design,tasks`) |
| `--default` | Set as project default schema |
| `--no-default` | Don't prompt to set as default |
| `--force` | Overwrite existing schema |
| `--json` | Output as JSON |

**Examples:**

```bash
# Interactive schema creation
omp openspec schema init research-first

# Non-interactive with specific artifacts
omp openspec schema init rapid \
  --description "Rapid iteration workflow" \
  --artifacts "proposal,tasks" \
  --default
```

**What it creates:**

```
openspec/schemas/<name>/
├── schema.yaml           # Schema definition
└── templates/
    ├── proposal.md       # Template for each artifact
    ├── specs.md
    ├── design.md
    └── tasks.md
```

---

### `omp openspec schema fork`

Copy an existing schema to your project for customization.

```
omp openspec schema fork <source> [name] [options]
```

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `source` | Yes | Schema to copy |
| `name` | No | New schema name (default: `<source>-custom`) |

**Options:**

| Option | Description |
|--------|-------------|
| `--force` | Overwrite existing destination |
| `--json` | Output as JSON |

**Example:**

```bash
# Fork the built-in spec-driven schema
omp openspec schema fork spec-driven my-workflow
```

---

### `omp openspec schema validate`

Validate a schema's structure and templates.

```
omp openspec schema validate [name] [options]
```

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | No | Schema to validate (validates all if omitted) |

**Options:**

| Option | Description |
|--------|-------------|
| `--verbose` | Show detailed validation steps |
| `--json` | Output as JSON |

**Example:**

```bash
# Validate a specific schema
omp openspec schema validate my-workflow

# Validate all schemas
omp openspec schema validate
```

---

### `omp openspec schema which`

Show where a schema resolves from (useful for debugging precedence).

```
omp openspec schema which [name] [options]
```

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `name` | No | Schema name |

**Options:**

| Option | Description |
|--------|-------------|
| `--all` | List all schemas with their sources |
| `--json` | Output as JSON |

**Example:**

```bash
# Check where a schema comes from
omp openspec schema which spec-driven
```

**Output:**

```
spec-driven resolves from: package
  Source: /usr/local/lib/node_modules/@fission-ai/openspec/schemas/spec-driven
```

**Schema precedence:**

1. Project: `openspec/schemas/<name>/`
2. User: `~/.local/share/openspec/schemas/<name>/`
3. Package: Built-in schemas

---

## Configuration Commands

### `omp openspec config`

View and modify global OpenSpec configuration.

```
omp openspec config <subcommand> [options]
```

**Subcommands:**

| Subcommand | Description |
|------------|-------------|
| `path` | Show config file location |
| `list` | Show all current settings |
| `get <key>` | Get a specific value |
| `set <key> <value>` | Set a value |
| `unset <key>` | Remove a key |
| `reset` | Reset to defaults |
| `edit` | Open in `$EDITOR` |
| `profile [preset]` | Configure workflow profile interactively or via preset |

**Examples:**

```bash
# Show config file path
omp openspec config path

# List all settings
omp openspec config list

# Get a specific value
omp openspec config get telemetry.enabled

# Set a value (disable anonymous usage telemetry)
omp openspec config set telemetry.enabled false

# Set a string value explicitly
omp openspec config set user.name "My Name" --string

# Remove a custom setting
omp openspec config unset user.name

# Set a machine-level default store (fallback root when no --store,
# local root, or project store: pointer resolves)
omp openspec config set defaultStore team-plans

# Reset all configuration
omp openspec config reset --all --yes

# Edit config in your editor
omp openspec config edit

# Configure profile with action-based wizard
omp openspec config profile

# Fast preset: switch workflows to core (keeps delivery mode)
omp openspec config profile core
```

**OMP privacy and profiles:** OMP forces telemetry off for bundled OpenSpec execution. Offline mode also disables explicit version-update checks. Global configuration remains available for supported settings, but delivery/profile settings do not install or filter OMP's 12 bundled Skills. There is no project-file refresh or update prompt to apply. Resources update only with OMP releases.

## Utility Commands

### `omp openspec feedback`

Submit feedback about OpenSpec. Creates a GitHub issue.

```
omp openspec feedback <message> [options]
```

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `message` | Yes | Feedback summary; long text is shortened in the issue title and preserved in the body |

**Options:**

| Option | Description |
|--------|-------------|
| `--body <text>` | Additional details included after the summary |

**Requirements:** GitHub CLI (`gh`) must be installed and authenticated.

**Example:**

```bash
omp openspec feedback "Add support for custom artifact types" \
  --body "I'd like to define my own artifact types beyond the built-in ones."
```

---

### `omp openspec completion`

The upstream completion surface is not an installer for OMP Skills. Use OMP native Skill completion for `/skill:<name>`, and `omp openspec --help` or command-specific `--help` for terminal syntax. Do not install a standalone `openspec` launcher or its shell hooks to use this integration.

# Install completions (auto-detects shell)
omp openspec completion install

# Install for specific shell
omp openspec completion install zsh

# Generate script for manual installation (bash)
omp openspec completion generate bash > ~/.bash_completion.d/openspec

# Uninstall
omp openspec completion uninstall
```

**Windows (PowerShell):** Install completions for the current PowerShell host:

```powershell
$env:PROFILE = $PROFILE
omp openspec completion install powershell
. $PROFILE
```

`$env:PROFILE` tells OpenSpec which profile to configure in this session. The
installer creates missing profile directories and adds a managed block that loads
`OpenSpecCompletion.ps1`. Reloading the profile enables completions immediately.

To uninstall from the current host, run:

```powershell
$env:PROFILE = $PROFILE
omp openspec completion uninstall powershell
```

Restart PowerShell after uninstalling to clear completions from the current session.

Completions are opt-in. The CLI mentions them once, on stderr, the first time you
run a command in an interactive terminal, and never again — it also stays quiet
if you already have completions installed. Set `OPENSPEC_NO_COMPLETIONS=1` to
suppress that tip entirely.

---

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Error (validation failure, missing files, etc.) |

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENSPEC_TELEMETRY` | Set to `0` to disable telemetry and the `openspec update` version check (overrides `telemetry.enabled` in global config) |
| `DO_NOT_TRACK` | Set to `1` to disable telemetry and the `openspec update` version check (standard DNT signal; overrides config) |
| `OPENSPEC_CONCURRENCY` | Default concurrency for bulk validation (default: 6) |
| `EDITOR` or `VISUAL` | Editor for `omp openspec config edit` |
| `NO_COLOR` | Disable color output when set |
| `OPENSPEC_NO_ANIMATION` | Disable the `omp openspec init` welcome animation when set |
| `OPENSPEC_NO_COMPLETIONS` | Set to `1` to suppress the one-time tip about shell completions |
| `OPENSPEC_NO_UPDATE_CHECK` | Disable the `openspec update` check for a newer published CLI when set (any value, including empty). Also skipped when `CI` is set (unless `false`/`0`/`no`/`off`) or `NODE_ENV=test` |
| `npm_config_registry` | Registry the `openspec update` version check asks. Must be an `http(s)` URL or it falls back to `https://registry.npmjs.org`. No `.npmrc` file is read |

---

## Related Documentation

- [Commands](commands.md) - AI slash commands (`/skill:openspec-propose`, `/skill:openspec-apply-change`, etc.)
- [Workflows](workflows.md) - Common patterns and when to use each command
- [Customization](customization.md) - Create custom schemas and templates
- [Getting Started](getting-started.md) - First-time setup guide
