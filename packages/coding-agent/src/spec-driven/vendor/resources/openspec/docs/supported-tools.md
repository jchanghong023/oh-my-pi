# Supported OMP interface

This vendored OpenSpec 2.0 integration uses OMP native Skills, not per-Agent installers or generated command files.

## How To Invoke

All 12 Skills are bundled and discoverable in any directory:

| OMP chat invocation | Purpose |
|---|---|
| `/skill:openspec-explore` | Explore ideas and requirements |
| `/skill:openspec-propose` | Draft a complete change plan |
| `/skill:openspec-new-change` | Scaffold a change |
| `/skill:openspec-continue-change` | Create the next ready artifact |
| `/skill:openspec-ff-change` | Create planning artifacts together |
| `/skill:openspec-update-change` | Revise existing planning artifacts |
| `/skill:openspec-apply-change` | Implement tasks |
| `/skill:openspec-verify-change` | Compare implementation and artifacts |
| `/skill:openspec-sync-specs` | Sync delta specifications |
| `/skill:openspec-archive-change` | Archive a change |
| `/skill:openspec-bulk-archive-change` | Archive multiple changes |
| `/skill:openspec-onboard` | Guided workflow tutorial |

OMP handles native discovery, completion, path authorization, and on-demand reads via `skill://<name>` (for example `skill://openspec-explore`). Project/user same-name overrides keep their existing precedence. No `core`/expanded profile selection is required to expose these Skills. Superpowers and JCH keep their own discovery rules.

## Project and terminal interface

Run terminal operations through `omp openspec ...`. `omp openspec init [path]` initializes project structure and configuration only; it does not install, update, or clean any user Skill or command. Skill availability does not implicitly authorize project initialization. Resources update with OMP releases, without standalone Node/OpenSpec installation.

Legacy `opsx` file commands and CLI `update` are removed. Use the Skill names above; `openspec-update-change` revises planning materials and remains supported.
