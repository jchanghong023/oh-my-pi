# OpenSpec availability in OMP

OMP includes OpenSpec **2.0.0**, its CLI, `spec-driven` schema, and all **12 Skills**. No standalone OpenSpec package, global launcher, Node installation, or additional Skill installation is required. Resources update only with OMP releases; offline execution does not download, build, or update them.

## Initialize a project

After explicitly choosing to initialize the project:

```bash
cd your-project
omp openspec init
# Or select another target and a language for a new config:
omp openspec init ./my-project --language zh-CN
```

Initialization creates project structure and configuration using `spec-driven` by default. Existing configuration is preserved; conflicting language requests fail rather than overwrite context. `init` does not install, refresh, or delete any user Skills, Agent directories, command files, or global prompt files. There is no tool-selection or cleanup step.

Skills are discoverable in any directory before initialization. Discovery does not authorize creating `openspec/`; request explicit initialization when the selected workflow requires an initialized project.

## How to invoke

In OMP chat use `/skill:openspec-explore` or `/skill:openspec-propose <goal>`. All 12 Skills use native discovery/completion and on-demand `skill://<name>` reads with normal path authorization. Project/user same-name resources keep their existing override precedence. See [Supported interface](supported-tools.md) and [Skill reference](commands.md).

In the terminal always use `omp openspec ...`, including `omp openspec --help`. No external `openspec` command is needed. The old CLI `update` and file-based `opsx` commands are removed. The `openspec-update-change` Skill remains available for editing planning artifacts; it is not an installer.

## Updating and retiring use

Upgrade OMP to receive new bundled resources. No per-project resource refresh is required. To stop using OpenSpec in a project, leave its versioned specifications and history intact unless the user explicitly requests their removal; do not remove unrelated or same-name user Skills.

Old custom schemas (`mini`, `omp-spec`, or others) require an explicit user migration. No compatibility alias is bundled. Review active changes and report missing design/tasks as incomplete; preserve historical archives. See [Migration guide](migration-guide.md).
