# OpenSpec in OMP

OpenSpec 2.0 is bundled with OMP. No standalone OpenSpec or Node installation is required.

RFC 2119 applies to MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL. `NEVER` and `AVOID` mean `MUST NOT` and `SHOULD NOT` respectively.

## Project setup

1. You MUST identify the intended project directory before writing files.
2. You MUST obtain explicit authorization to initialize an uninitialized project. Skill discovery alone is not authorization.
3. Run `omp openspec init [path]` only for the authorized target. The default schema is `spec-driven`; use `--language <language>` when creating a language-specific config.
4. Report actual output and created project files, not assumed results.

`init` creates project structure and configuration only. It NEVER installs, updates, or cleans user Skills, Agent settings, or legacy commands. The CLI `update` and file-based `opsx` commands are removed; upgrade OMP to update bundled resources.

## Invoke a workflow

All 12 bundled Skills use OMP native discovery, completion, authorization, and on-demand reading in any directory. Invoke `/skill:openspec-propose` or `/skill:openspec-explore`; read `skill://openspec-propose` when needed. Project/user same-name overrides retain their existing precedence. See [Skill reference](docs/commands.md).

All terminal execution MUST use `omp openspec ...`; NEVER install a separate CLI, inject PATH entries, or install duplicate Skills.

## Existing projects

Existing configuration is preserved. Users MUST explicitly migrate old custom schemas such as `mini` or `omp-spec`; no bundled compatibility alias or private bridge is supplied. Inspect each active change before selecting `spec-driven`. Missing `design.md` or `tasks.md` MUST remain incomplete; changing a schema name does not complete planning. NEVER rewrite historical archives in bulk. See [Migration](docs/migration-guide.md).
