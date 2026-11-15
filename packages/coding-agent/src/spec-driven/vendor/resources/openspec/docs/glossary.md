# Glossary

Every OpenSpec term in one place, defined in plain language. Skim it once and the rest of the docs read faster.

Terms are grouped by topic, then alphabetized within each group.

## The core nouns

**Spec.** A document describing how part of your system behaves. Specs live in `openspec/specs/`, are organized by domain, and are made of requirements and scenarios. The spec is the agreed-upon answer to "what does this software do?" See [Concepts](concepts.md#specs).

**Source of truth.** The `openspec/specs/` directory as a whole. It holds the current, agreed-upon behavior of your system. Changes propose edits to it; archiving applies them.

**Change.** One unit of work, packaged as a folder under `openspec/changes/<name>/`. A change holds everything about that work: its proposal, design, tasks, and the spec edits it introduces. One change, one feature or fix.

**Artifact.** A document inside a change. The standard artifacts are the proposal, the delta specs, the design, and the tasks. They're created in dependency order and feed into each other.

**Delta spec.** A spec inside a change that describes only what's changing, using `ADDED`, `MODIFIED`, and `REMOVED` sections, rather than restating the entire spec. This is what lets OpenSpec edit existing systems cleanly. See [Concepts](concepts.md#delta-specs).

**Domain.** A logical grouping for specs, like `auth/`, `payments/`, or `ui/`. You choose domains that match how you think about your system.

## Inside a spec

**Requirement.** A single behavior the system must have, usually written with an RFC 2119 keyword: "The system SHALL expire sessions after 30 minutes." Requirements state the *what*, not the *how*.

**Scenario.** A concrete, testable example of a requirement in action, typically in Given/When/Then form. Scenarios make a requirement verifiable: you could write an automated test from one.

**RFC 2119 keywords.** The words MUST, SHALL, SHOULD, and MAY, which carry standardized meaning about how strict a requirement is. MUST and SHALL are absolute. SHOULD is recommended with room for exceptions. MAY is optional. The name comes from the internet standards document that defined them.

## The artifacts

**Proposal (`proposal.md`).** The *why* and *what* of a change: its intent, scope, and high-level approach. The first artifact you create.

**Design (`design.md`).** The *how*: technical approach, architecture decisions, and the files you expect to touch. Required by the default `spec-driven` artifact graph.

**Tasks (`tasks.md`).** The implementation checklist, with checkboxes. The AI works through it during `/skill:openspec-apply-change` and checks items off as it goes.

## The lifecycle

**Archive.** The act of finishing a change. Its delta specs merge into the main specs, and the change folder moves to `openspec/changes/archive/YYYY-MM-DD-<name>/`. After archiving, your specs describe the new reality. See [Concepts](concepts.md#archive).

**Sync.** Merging a change's delta specs into the main specs *without* archiving the change. Usually automatic (archive offers to do it), but available on its own as `/skill:openspec-sync-specs` for long-running changes. See [Commands](commands.md#skillopenspec-sync-specs).

## Workflow and commands

**OPSX.** The upstream name for the fluid artifact workflow. OMP exposes it through native `/skill:<name>` invocations, not legacy file commands. See [Workflow](opsx.md).

**Slash command.** A command you type into your AI assistant's chat, like `/skill:openspec-propose`. Slash commands drive the workflow. They are not terminal commands. See [How Commands Work](how-commands-work.md).

**Explore (`/skill:openspec-explore`).** The thinking-partner command. It reads your codebase, compares options, and clarifies a fuzzy idea into a concrete plan. It never writes code, and writes nothing else unless you ask it to capture the exploration as a change, or say yes when it offers. The recommended starting point whenever you have a problem but not yet a plan. See [Explore First](explore.md).

**CLI.** The `omp openspec ...` terminal interface. It initializes projects, lists and validates changes, opens the dashboard, and archives. No standalone OpenSpec or Node installation is required. See [CLI](cli.md).

**Skill.** Workflow instructions bundled with OMP. All 12 OpenSpec Skills use native discovery/completion in any directory and on-demand `skill://<name>` reads with normal authorization. Project/user same-name overrides retain their existing precedence.

**Command file.** The retired per-Agent file delivery mechanism. OMP does not install or register these files and does not clean existing user copies.

**Profile.** An upstream global workflow preference. It does not install or filter the 12 native Skills bundled in OMP; quick and incremental paths are both available.

**Delivery.** OMP ships the CLI, schema, and all Skills together. Update OMP to update resources; initialization only configures a project.

## Customization

**Schema.** The definition of which artifacts a workflow has and how they depend on one another. The built-in default is `spec-driven` (proposal → specs → design → tasks). You can fork it or write your own. See [Customization](customization.md#custom-schemas).

**Template.** A Markdown file inside a schema that shapes what the AI generates for a given artifact. Editing a template changes the AI's output immediately, with no rebuild.

**Project config (`openspec/config.yaml`).** Per-project settings: the default schema, the `context:` injected into every planning request, and per-artifact `rules:`. The easiest way to teach OpenSpec about your stack and conventions. See [Customization](customization.md#project-configuration).

**Context injection.** Putting project background in `config.yaml`'s `context:` field so it's automatically added to every artifact the AI generates. More reliable than hoping the AI reads a separate file.

**Dependency graph.** The directed graph formed by artifact `requires:` relationships. It's a DAG (directed acyclic graph: arrows only point forward, never in a loop), and OpenSpec uses it to know what you can create next.

**Enablers, not gates.** The principle that artifact dependencies show what becomes *possible* next, not what's *required* next. You can revisit and edit any artifact at any time. See [Core Concepts at a Glance](overview.md#enablers-not-gates).

## Local working views

**Working context.** What `omp openspec context` reports for the current project: its local OpenSpec root and planning-directory diagnostics. It can also write a single-root editor workspace. See [CLI Reference](cli.md#working-context-local-project).

**Workset.** A personal, machine-local set of folders you open together. Created explicitly with `omp openspec workset create`; these local paths are not shared project state and removing a workset never removes its member folders. See [Personal worksets](cli.md#personal-worksets).

## See also

- [Core Concepts at a Glance](overview.md): the five ideas, on one page
- [Concepts](concepts.md): the long-form explanation
- [How Commands Work](how-commands-work.md): slash commands versus the CLI
