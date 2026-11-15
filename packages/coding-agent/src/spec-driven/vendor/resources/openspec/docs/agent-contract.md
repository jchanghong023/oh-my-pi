# OpenSpec Agent Contract

Machine-readable surfaces of the bundled `omp openspec` CLI. Shapes below describe the local-project implementation; braces containing bare field names are shape notation, not literal JSON.

## 1. General conventions

- **One JSON document per supported invocation.** In `--json` mode, command payloads use stdout (2-space pretty-printed); human prose and spinners go to stderr. CLI parsing failures, including unknown commands and options, use the normal CLI error path rather than a JSON payload.
- **Local roots only.** Root output contains `path` and `source`, with no external selection fields.
- **Optional keys are generally omitted**, while command failure payloads may use explicit `null` as documented below.

## 2. The diagnostic envelope

Machine-readable diagnostics use the `OpenSpecDiagnostic` envelope:

```json
{
  "severity": "error" | "warning" | "info",
  "code": "snake_case_string",
  "message": "human sentence",
  "target": "dotted.surface (optional)",
  "fix": "one actionable sentence/command (optional)"
}
```

Diagnostics appear in health `status` arrays or as a single-element `status` array on command failure. Some commands omit optional diagnostic fields such as `target`.

## 3. Root selection and `RootOutput`

Root-resolving commands use the nearest ancestor project directory containing `openspec/` (`source: "nearest"`). `root.path` names that project directory, not the `openspec/` directory. Nested projects select their own nearest root; adjacent projects are not searched.

When no root exists, commands that permit an implicit root use the current directory (`source: "implicit"`). `doctor`, `context`, and bulk `validate` require a root. `list` also requires one unless the current directory has legacy `openspec/project.md`. An implicit root does not authorize project initialization.

External Stores are unsupported: `store`, `--store`, and `--store-path` fail as unknown commands or options, and global `defaultStore` does not route commands. Project `store` or `references` fields fail with `unsupported_project_field`, including empty or null values. Existing repositories and local data are preserved without automatic migration.

Successful JSON payloads normally embed the root; successful `schemas --json`
deliberately remains the bare array documented below:

```json
"root": { "path": "/abs/project", "source": "nearest" | "implicit" }
```

**Root-failure contract**: in JSON mode a resolution failure prints `{ ...commandNullShape, "status": [diagnostic] }` on stdout and exits 1.

## 4. Command JSON shapes

### 4.1 `list --json`
`{ "changes": [ { "name", "completedTasks", "totalTasks", "lastModified", "status": "no-tasks"|"complete"|"in-progress", "nested"?: ["<area>/<name>", ...] } ], "warnings"?: [ { "code", "name", "nested", "message" } ], "root": RootOutput }` — note the per-change `status` is a string enum here. `--specs`: `{ "specs": [ { "id", "requirementCount" } ], "root" }`.

`warnings` (omitted when empty) reports directories under `changes/` that are not changes. Today the only code is `nested_change_directory`: a namespace folder wrapping change directories, which OpenSpec cannot address because a change is always a directory directly under `changes/`. The same entry carries `nested` on the listed change, whose `status` is then meaningless. Do not treat such an entry as a change; report the message and leave the directories alone.

### 4.2 `show <item> --json`
Change: `{ "id", "title", "deltaCount", "deltas": [...], "root" }`. Spec: `{ "id", "title", "overview", "requirementCount", "requirements": [...], "metadata": { "version", "format", "sourcePath"? }, "root" }`. A requirement, in a spec or in a change delta's `requirement`/`requirements`, is `{ "name", "text", "scenarios": [ { "name", "rawText" } ] }`. A requirement `name` is its header without `Requirement:` and without a closing `#` run, the exact name archive matches MODIFIED/REMOVED/RENAMED entries against. A scenario `name` is its level-4 header without `Scenario:` and without a closing `#` run, the name the MODIFIED scenario-loss check compares.

### 4.3 `validate --json`
`{ "items": [ { "id", "type": "change"|"spec", "valid", "issues": [ { "level", "path", "message", "line"?, "column"? } ], "durationMs" } ], "summary": { "totals": {items,passed,failed}, "byType": {...} }, "version": "1.0", "root" }`. Exit 1 when any item fails.

### 4.4 `status --json`
`{ "changeName", "schemaName", "planningHome"?: { "kind": "repo", "root", "changesDir", "defaultSchema" }, "changeRoot", "artifactPaths": { "<id>": {outputPath, resolvedOutputPath, existingOutputPaths} }, "nextSteps": ["..."], "actionContext": { "mode": "repo-local", "sourceOfTruth": "repo", "planningArtifacts", "allowedEditRoots", "constraints" }, "isPlanningComplete", "isComplete", "applyRequires", "artifacts": [ {id, outputPath, status: "done"|"skipped"|"ready"|"blocked", requires, missingDeps?} ], "root" }`. `allowedEditRoots` contains the resolved project root; `constraints` scopes planning artifacts and implementation edits to that project. `planningArtifacts` lists artifact ids. Use the returned paths rather than assuming the startup directory is the root. `isPlanningComplete` means every non-skipped planning artifact exists; skipped artifacts count as satisfied without being created. It does not mean implementation tasks are complete. `isComplete` is retained as a compatibility alias with the same value. Each artifact's `requires` is its direct dependency ids (present for every status, so the transitive required set is computable even when the artifact is `done`); `missingDeps` appears only when `blocked`. The `artifacts` array is in dependency order, with the schema's `artifacts:` declaration order breaking ties between artifacts that become ready at the same time (never alphabetical), so the first `ready` entry is the artifact to write next; `missingDeps` uses that same order. `"skipped"` marks an artifact whose `generates` path is under `specs/` in a change whose `.openspec.yaml` declares `skip_specs: true`; it satisfies dependencies but must not be created. No active changes: `{ "changes": [], "message", "root" }`, exit 0.

`--all` (batch, mutually exclusive with `--change` — combining them is an error with the `{ "changes": [], "root": null, "status": [d] }` null-shape): `{ "changes": [ <per-change status object, no per-change root>, ... ], "root" }`, sorted by change name. A change that fails to load contributes `{ "changeName", "status": [d] }` in place; the sweep continues, preserves the complete envelope, and exits 1 in both text and JSON modes. An invalid `--schema` fails the whole invocation with the null-shape, even when no changes exist.

### 4.5 `instructions <artifact> --json`
`{ "changeName", "artifactId", "schemaName", "changeDir", "planningHome"?, "outputPath", "resolvedOutputPath", "existingOutputPaths", "description", "instruction"?, "context"?, "rules"?, "skipped"?, "warning"?, "template", "dependencies": [{id,done,path,description,skipped?}], "unlocks", "root" }`. `unlocks` lists the artifacts this one makes ready, in the schema's declaration order (the same order `status` recommends them). `"skipped": true` (with `"warning"`) appears when the change declares `skip_specs: true` and this artifact is skipped — do not create its files. A dependency entry with `skipped: true` is satisfied without files — do not try to read its paths.

### 4.6 `instructions apply --json`
`{ "changeName", "changeDir", "schemaName", "contextFiles": { "<artifactId>": ["/abs", ...] }, "progress": {total,complete,remaining}, "tasks": [{id,description,done}], "state": "blocked"|"all_done"|"ready", "missingArtifacts"?, "missingPrerequisites"?, "warnings"?, "instruction", "context"?, "operationGuidance"?, "root" }`. `missingArtifacts` is what apply blocks on (the schema's `apply.requires`); `missingPrerequisites` is everything still to build before apply can run, in build order - the transitive closure of those requires, so it can be the longer list. `warnings` lists non-blocking problems with the change itself - today, a change that is ready to implement with no delta specs and no `skip_specs: true`, the state `omp openspec validate` rejects. Both optional root fields (`context`, `operationGuidance`) are read from the resolved local root on every invocation. `context` is a required prompt-level input whose relevant project facts, conventions, and constraints must be applied; `operationGuidance` is advisory input whose entries are followed only when applicable and compatible with the built-in workflow. Both remain separate from state, tasks, progress, context files, and the built-in instruction.

### 4.7 `instructions archive --json`
`{ "changeName", "context"?, "operationGuidance"?, "root" }`. Requires a valid `--change` in the resolved local project root and uses the same required-context/advisory-guidance semantics as apply. This is a read-only runtime-input surface: it does not return the static archive workflow, inspect or merge delta specs, write main specs, or move the change.

### 4.8 `new change <name> --json`
Success: `{ "change": { "id", "path", "metadataPath", "schema" }, "root" }`. Failure: `{ "change": null, "status": [d] }`, exit 1.

### 4.9 `archive <name> --json`
Success: `{ "archive": { "change", "archivedAs": "YYYY-MM-DD-name", "path", "specsUpdated", "totals"?, "warnings"? }, "root" }`. Failure: `{ "archive": null, "root"?, "status": [d] }`, exit 1. `specsUpdated` is true only when at least one spec file was written or retired (a capability whose last requirement the change removed has its spec deleted, which requires `retire_capabilities: true` in the change's `.openspec.yaml`; every retirement is named in `warnings`, with a pasteable Git recovery command only when the spec lived in the caller's checkout); an already-synced change archives with all-zero totals and the skips listed in `warnings`. JSON mode is strictly non-interactive: every prompt point becomes an `archive_*` code.

- **`archive: null`**: the command failed. This is not a guarantee that files are unchanged.
- **`archive_retirement_cleanup_failed`**: the change was archived, but retirement backup verification or cleanup failed. A listed backup path may have changed or disappeared. The message can also report a staged source left by a failed fallback-copy cleanup. Inspect the current archive and all reported recovery paths before cleanup. Preserve any needed content. Retrying archive does not clean up these paths.
- **`archive_error`**: the fallback diagnostic does not identify whether files changed. Inspect the change, archive, and affected specs before retrying.

### 4.10 `doctor --json`
`{ "root": { "path", "source", "healthy", "status": [] }, "configPath" }`. Reports the local project root, resolved configuration path, and planning-directory health. Health findings of any severity exit 0. Failure payload: `{ "root": null, "status": [d] }`, exit 1.

### 4.11 `context --json`
`{ "root": { "path", "source", "role": "openspec_root" }, "status": [] }`. `status` contains local planning-directory diagnostics. `--code-workspace <path>` writes `{ "folders": [{ "name": "<project basename>", "path": "<absolute project root>" }] }`; the parent directory must exist and overwriting requires `--force`. In JSON mode the write runs before printing so stdout holds exactly one document even on write failure. Failure: `{ "root": null, "status": [d] }`, exit 1.

### 4.12 `schemas --json` / `templates --json`
`schemas`: success remains a bare array `[ {name, description, artifacts, source} ]`; it resolves the local project root. Root-selection failure: `{ "schemas": [], "root": null, "status": [d] }`, exit 1. `templates`: keyed object `{ "<artifactId>": {path, source} }`, still cwd-based with no root/status keys.

## 5. Exit-code contract

| Situation | Exit | Stdout |
|---|---|---|
| Success, incl. health findings (doctor/context) | 0 | the payload |
| Command failure in supported `--json` mode | 1 | one JSON document with `status: [d]` and the command's failure shape |
| `validate` with failing items | 1 | full report |
| Unknown command or option | Nonzero | normal CLI parsing error, not a diagnostic JSON envelope |

## 6. Diagnostic code catalog

### Resolution
`no_openspec_root`, `unsupported_project_field`.

### OpenSpec-root health (error, no fix)
`openspec_project_root_missing`, `openspec_project_root_not_directory`, `openspec_root_missing`, `openspec_root_not_directory`, `openspec_config_missing`, `openspec_config_not_file`, `openspec_specs_not_directory`, `openspec_changes_not_directory`, `openspec_archive_not_directory`. Optional `openspec/specs/`, `openspec/changes/`, and `openspec/changes/archive/` directories may be absent in a healthy root; they are health errors only when present but not directories.

### Archive (JSON mode)
`archive_change_name_required`, `archive_change_not_found`, `archive_change_symlink`, `archive_validation_failed`, `archive_confirmation_required`, `archive_tasks_incomplete`, `archive_spec_update_failed`, `archive_spec_validation_failed`, `archive_target_exists`, `archive_retirement_cleanup_failed`, `archive_error`.

### Context writes
`context_file_exists`, `context_output_dir_missing`.

### Fallbacks
`doctor_failed`, `context_failed`, `change_error`, `archive_error`.

## Surface differences

- `list --json` reuses the `status` key as a string enum per change.
- Only `validate` output carries a `version` field.
- `templates` is cwd-based rather than root-resolving.
- Deprecated noun forms (`change`/`spec` subcommands) emit unenveloped payloads without `root`/`status`.
