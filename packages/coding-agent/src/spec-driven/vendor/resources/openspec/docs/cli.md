# CLI Reference

The OpenSpec CLI (`openspec`) provides terminal commands for project setup, validation, status inspection, and management. These commands complement the native OMP Skills (like `/skill:openspec-propose`) documented in [Commands](commands.md).

## Summary

| Category | Commands | Purpose |
|----------|----------|---------|
| **Setup** | `init` | Initialize project structure and configuration |
| **Health** | `doctor` | Report local project configuration and planning-directory health |
| **Working context** | `context` | Report the local OpenSpec root or write a single-root editor workspace |
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
| `omp openspec schemas` | List available schemas | `--json` for schema discovery |
| `omp openspec new change <id>` | Create project-local change scaffolding | `--json` for structured output |
| `omp openspec doctor` | Check the local project | `--json` for root health and configuration path |
| `omp openspec context` | Inspect the local root | `--json` for structured context |
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

The target defaults to the current directory. Initialization creates project structure and configuration with `spec-driven` as the default schema. Existing configuration is preserved; a conflicting language request fails rather than overwriting context. Unsupported project `store` or `references` fields fail even when empty or null. Obtain explicit authorization before initializing an uninitialized project.

It does not create, update, or remove user Skills, Agent directories, legacy command files, or global prompts. All 12 Skills are already bundled with OMP and discoverable in any directory. There are no `--tools`, `--profile`, or cleanup options.

```text
openspec/
├── specs/
├── changes/
└── config.yaml
```

Upgrade OMP to update resources. CLI `update` and file-based `opsx` commands are removed; `openspec-update-change` remains the planning-material editing Skill.

## Project root

Root-resolving commands use the nearest ancestor project directory containing `openspec/`, including when invoked from a subdirectory. The root is the project directory, not `openspec/` itself. A nested project uses its own nearest root; adjacent projects are not searched.

Commands that allow an implicit root fall back to the current directory when none exists; `context`, `doctor`, and bulk validation require an existing root. `list` also requires a root unless the current directory has legacy `openspec/project.md`. A fallback does not authorize an agent to initialize a project.

External Stores are not supported. The `store` command and `--store` / `--store-path` options are unknown commands or options. Project `store` and `references` fields are rejected regardless of value; global `defaultStore` does not route commands. Existing external repositories and machine-local data are left untouched and are not automatically migrated.

## Doctor (local project health)

Ask "Is my setup healthy?" with a read-only check of the local project:

```bash
omp openspec doctor [--json]
```

The report identifies the project root and configuration path, checks the configuration file and planning directories, and reports diagnostics. Missing optional `specs/`, `changes/`, or `changes/archive/` directories are allowed; paths that exist but are not directories are unhealthy. Doctor never repairs files or performs Git operations. Health findings exit 0; command failures such as a missing root or invalid project configuration exit 1.

## Working context (local project)

Ask "What project am I working with?" without changing planning files:

```bash
omp openspec context [--json] [--code-workspace <path> [--force]]
```

The report contains the local root and its planning-directory diagnostics. `--code-workspace` additionally writes a VS Code workspace file containing just that project root — the only write this command performs. The parent directory must already exist, and an existing file is refused without `--force`. In JSON mode the write completes before the report is printed, so a write failure produces only the failure document.

This working context is distinct from the `context:` field in `openspec/config.yaml`, which supplies project background to instructions. For exact output shapes, see the [agent contract](agent-contract.md).


## Personal worksets

A workset is a personal, named view of the folders you work on together — a planning root plus whatever else you choose — kept on your machine and reopened by name in your tool. It is purely local: never committed, never shared, never derived from declarations, and removing one never touches a member folder.

```bash
omp openspec workset create [name] [--member <path> | --member <name>=<path>]... [--tool <id>] [--json]
omp openspec workset list [--json]
omp openspec workset open <name> [--tool <id>]
omp openspec workset remove <name> [--yes] [--json]
```

For example, keep two component repositories open together:

```bash
omp openspec workset create checkout-promo \
  --member ~/src/checkout-api \
  --member ~/src/checkout-web \
  --tool code
omp openspec workset list
omp openspec workset open checkout-promo
```

`workset ls` is an alias for `workset list`. Opening folders does not copy their source into planning context, change root selection, route tasks between repositories, or grant an agent permission to edit them.

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

All workset state lives under the global data dir's `worksets/` folder (the saved views plus generated `<name>.code-workspace` files, regenerated on every open). The data dir is `~/.local/share/openspec` on macOS and Linux, `$XDG_DATA_HOME/openspec` when set, or `%LOCALAPPDATA%\openspec` on Windows. Remove a saved view with `workset remove <name>`; member directories are never deleted.

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
| `--json` | Output JSON |

Examples:

```bash
omp openspec new change add-billing-api
omp openspec new change add-billing-api --json
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

Operation inputs are read from the resolved repo on every
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
