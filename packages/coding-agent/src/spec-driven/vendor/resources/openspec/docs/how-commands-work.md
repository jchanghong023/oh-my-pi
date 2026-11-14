# How Commands Work

OpenSpec has two interfaces in OMP: Skills in chat and CLI operations in the terminal. They use the same project artifacts, not separate workflow state.

## The two halves

| Where | Example | Role |
|---|---|---|
| Terminal | `omp openspec init` | Initialize an explicitly selected project |
| Terminal | `omp openspec status --change add-dark-mode --json` | Inspect artifact progress |
| OMP chat | `/skill:openspec-explore` | Investigate before choosing a plan |
| OMP chat | `/skill:openspec-propose add-dark-mode` | Draft planning artifacts |
| OMP chat | `/skill:openspec-apply-change add-dark-mode` | Implement tasks |
| OMP chat | `/skill:openspec-archive-change add-dark-mode` | Review sync and archive |

There is no separate OpenSpec chat mode to start. A Skill supplies workflow instructions to the current OMP assistant; it is not an independent executable. Terminal commands inspect or change project state directly and support structured output where documented.

## Native Skill discovery

All 12 OpenSpec Skills ship with OMP and are discoverable/completable in any directory. OMP reads their bodies on demand through `skill://<name>` and applies normal path authorization. Project/user same-name overrides keep their existing precedence. Skill discovery does not require `init`, install duplicate files, or authorize writing a project.

Use `/skill:<name>` in chat, such as `/skill:openspec-propose`. Legacy `opsx` file commands are removed; other assistants' command syntax and installation directories are not part of this integration. See [Skill reference](commands.md) for all workflows.

## Project setup and resources

When a workflow requires an uninitialized project, obtain explicit authorization and run `omp openspec init [path]`. It creates project structure/configuration, defaults to `spec-driven`, and preserves existing config. It never installs, refreshes, or cleans user Skills, Agent settings, or legacy commands.

There is no standalone OpenSpec/Node requirement and no CLI `update`. Bundled resources update only with OMP releases. `openspec-update-change` remains a Skill for editing change materials, not updating installed files.

## A clean first run

```text
TERMINAL   $ cd your-project
TERMINAL   $ omp openspec init          (explicit project initialization)
OMP CHAT     /skill:openspec-explore    (optional)
OMP CHAT     /skill:openspec-propose add-dark-mode
             Review proposal, specs, design, and tasks.
OMP CHAT     /skill:openspec-apply-change add-dark-mode
             Review implementation and test evidence.
OMP CHAT     /skill:openspec-verify-change add-dark-mode
OMP CHAT     /skill:openspec-archive-change add-dark-mode
```

For incremental planning, use `openspec-new-change` then `openspec-continue-change` or `openspec-ff-change`; all are already bundled. Missing required artifacts remain incomplete, and archiving is not proof of software acceptance.

## Troubleshooting

If a Skill is missing, check the OMP version and bundled-resource error, native Skill settings, and project/user same-name overrides. Do not regenerate user Skill files with `init`; see [Troubleshooting](troubleshooting.md). Existing custom schemas need [explicit migration](migration-guide.md), not a compatibility alias.

## Related

- [Getting started](getting-started.md)
- [CLI reference](cli.md)
- [Supported interface](supported-tools.md)
