# FAQ

Quick answers to the questions people ask most. If your question is really a "something is broken" question, [Troubleshooting](troubleshooting.md) is the better page. If you want a term defined, see the [Glossary](glossary.md).

## The basics

### What is OpenSpec, in one sentence?

A lightweight layer that gets you and your AI coding assistant to agree on what to build, in writing, before any code is written.

### Why would I want that?

Because AI assistants are confident even when they're wrong. When the requirements live only in a chat thread, the AI fills gaps with guesses, and you find out after the code exists. OpenSpec moves the agreement earlier, where mistakes are cheap to fix. See [Core Concepts at a Glance](overview.md) for the full case.

### Do I have to use it for everything?

No. Use it where agreement matters, which is most non-trivial work. For a one-character typo fix, the ceremony probably isn't worth it, and that's fine.

### Can I use it on a big existing codebase, or only new projects?

Existing codebases are the main event. OpenSpec is brownfield-first: you do not document your whole app up front. You write specs only for what each change touches, and your specs fill in over time around the work you actually do. There's a dedicated guide: [Using OpenSpec in an Existing Project](existing-projects.md).

### Is it tied to one AI tool?

This bundled integration uses OMP native Skills. Upstream per-Agent installers and standalone setup are not part of it; see [Supported interface](supported-tools.md).

## Running commands

### Where do I type `/skill:openspec-propose`?

In your AI assistant's chat, not your terminal. This is the single most common point of confusion, so it has its own page: [How Commands Work](how-commands-work.md). Short version: `omp openspec ...` runs in the terminal, `/skill:<name>` runs in chat.

### How do I "start interactive mode"?

There isn't a separate mode to start. You open your AI assistant like normal and type a slash command into its chat. The slash command is how you "enter" OpenSpec. (The one genuinely interactive terminal feature is `omp openspec view`, a dashboard for browsing specs and changes.) Full explanation in [How Commands Work](how-commands-work.md).

### I typed a slash command and nothing happened. Why?

Use `/skill:<name>` in OMP chat, not the terminal. Check native Skill settings, bundled resources, and project/user same-name overrides. All 12 Skills are already available without init; initialization never generates Skill or command files. See [Troubleshooting](troubleshooting.md#commands-dont-show-up).

### Why is the syntax `/skill:openspec-propose` in one tool and `/skill:openspec-propose` in another?

OMP uses `/skill:openspec-propose` and other full Skill names. Legacy per-tool file commands are removed; see [How to invoke](supported-tools.md#how-to-invoke).

### What's the difference between a skill and a command?

An OMP Skill is bundled workflow guidance read on demand via `skill://<name>`. A terminal command is an operation under `omp openspec ...`. OMP does not generate or register legacy `opsx` command files.

## The workflow

### Where should I start if I'm not sure what to build?

With `/skill:openspec-explore`. It's a no-stakes thinking partner that reads your codebase, lays out options, and turns a fuzzy problem into a concrete plan, all before any code gets written. It's among the bundled Skills, so it's always available. When the plan is clear, it hands off to `/skill:openspec-propose`. This is the single best habit to form, because it stops an eager AI from confidently building the wrong thing. See [Explore First](explore.md).

### What's the simplest possible flow?

```text
/skill:openspec-explore (optional)   then   /skill:openspec-propose <what you want>   then   /skill:openspec-apply-change   then   /skill:openspec-archive-change
```

Explore to think it through, propose to draft the plan, apply to build it, archive to file it away. Skip explore when you already know exactly what you want.

### What's the difference between `/skill:openspec-propose` and `/skill:openspec-new-change`?

`/skill:openspec-propose` is the default one-step command: it creates the change and drafts all the planning artifacts at once. `/skill:openspec-new-change` is part of the expanded command set and only scaffolds an empty change, leaving you to create artifacts one at a time with `/skill:openspec-continue-change` (or all at once with `/skill:openspec-ff-change`). Use propose unless you want step-by-step control. See [Commands](commands.md).

### What are `core` and expanded profiles?

All 12 OpenSpec Skills are bundled with OMP and use native discovery, completion, on-demand `skill://<name>` reads, and path authorization in any directory. Project/user same-name overrides keep their existing precedence. No profile selection or duplicate Skill installation is needed. Skill discovery does not authorize project initialization.

The quick and incremental paths are workflow choices, not installation requirements.

### Do I need to run `/skill:openspec-sync-specs`?

Usually not. Sync merges a change's delta specs into your main specs, and `/skill:openspec-archive-change` will offer to do it for you. Run sync manually only when you want the specs merged before archiving, for example on a long-running change. See [Commands](commands.md#skillopenspec-sync-specs).

### How do I edit a proposal, spec, or task after I've started?

Just edit the file. Every artifact is plain Markdown in `openspec/changes/<name>/`, and there's no locked phase or special edit mode. Change it by hand, or ask your AI to revise it ("update the design to use a queue"), then keep going. The AI always works from the current file contents. Full guide: [Editing & Iterating on a Change](editing-changes.md).

### Can I go back and change the plan after implementing some of it?

Yes, at any time. The workflow is fluid, so review and editing aren't phases you get locked out of. Edit the artifact, then continue. If you want a structured check that the code still matches the plan, run `/skill:openspec-verify-change`. See [Editing & Iterating on a Change](editing-changes.md#how-do-i-go-back-to-review-after-implementing).

### I edited the code by hand. How do I reconcile it with the spec?

Bring them back in sync before you archive, since archiving makes your specs the record of truth. If the code is now correct, update the delta spec to match what you shipped; if the spec is correct, keep building until the code agrees. `/skill:openspec-verify-change` surfaces the mismatches. See [Editing & Iterating on a Change](editing-changes.md#i-edited-the-code-by-hand-how-do-i-reconcile-that-with-openspec).

### When should I update an existing change versus start a new one?

Update when it's the same work, refined. Start fresh when the intent fundamentally changed or the scope exploded into different work. There's a decision flowchart and examples in [Workflows](workflows.md#when-to-update-vs-start-fresh).

### What if my session runs out of context, or requirements change mid-implementation?

This is where specs earn their keep. Because the plan lives in files (not only in chat history), you can clear your context, start a fresh AI session, and pick up with `/skill:openspec-apply-change`; it reads the artifacts and resumes from the first unchecked task. If requirements change, edit the artifacts to match the new reality and continue. Keeping a clean context window also produces better results; clear it before implementation.

### Should I commit the `openspec/` folder to git?

Yes. Your specs, active changes, and archive are part of your project's history. Commit them like any other source. The archive in particular becomes a durable record of why your system works the way it does.

## Specs and changes

### What goes in a spec versus a design?

A spec describes observable behavior: what the system does, its inputs, outputs, and error conditions. A design describes how you'll build it: the technical approach, architecture decisions, file changes. If implementation could change without changing externally visible behavior, it belongs in the design, not the spec. [Concepts](concepts.md#what-a-spec-is-and-is-not) goes deeper.

### What's a delta spec?

A spec that describes only what's changing, using `ADDED`, `MODIFIED`, and `REMOVED` sections, rather than restating the whole spec. It's how OpenSpec handles edits to existing systems cleanly. See [Concepts](concepts.md#delta-specs).

### Where do archived changes go?

To `openspec/changes/archive/YYYY-MM-DD-<name>/`, with all change artifacts preserved. The change moves out of your active list. A change that explicitly declares `retire_capabilities: true` can also delete a main capability spec when it removes that capability's final requirement.

## Configuration and customization

### How do I tell the AI about my tech stack?

Put it in `openspec/config.yaml` under `context:`. That text is injected into every planning request, so the AI always knows your stack and conventions. See [Customization](customization.md#project-configuration).

### Can I generate specs in a language other than English?

Yes. Add a language instruction to your config's `context:`. [Multi-Language](multi-language.md) has copy-paste snippets for several languages.

### Can I change the workflow itself?

Yes, with custom schemas. A schema defines which artifacts exist and how they depend on each other. Fork the default with `omp openspec schema fork spec-driven my-workflow`, then edit it. See [Customization](customization.md#custom-schemas).

## Models, privacy, and upgrades

### Which AI model should I use?

OpenSpec works best with high-reasoning models. The README recommends models like Codex 5.5 and Opus 4.7 for both planning and implementation. Also keep your context window clean: clear it before implementation for best results.

### Does OpenSpec collect data?

OMP disables OpenSpec telemetry for both terminal and captured execution. Offline mode additionally disables explicit version-update checks; no automatic resource download or update is performed.

### How do I upgrade?

Upgrade OMP. The bundled CLI, schema, and Skills update together; there is no per-project CLI `update` step.

### How do I uninstall OpenSpec?

It is bundled with OMP, not separately installed. Stop invoking it if unwanted. Preserve project specs/history and user Skills unless the user explicitly requests their removal; see [Availability](installation.md#updating-and-retiring-use).

## Getting help

### Where do I ask questions or report bugs?

- **Discord:** [discord.gg/YctCnvvshC](https://discord.gg/YctCnvvshC)
- **GitHub Issues:** [github.com/Fission-AI/OpenSpec/issues](https://github.com/Fission-AI/OpenSpec/issues)
- **From your terminal:** `omp openspec feedback "your message"` opens a GitHub issue for you.

### These docs are wrong or confusing. What do I do?

Tell us. Open a [docs issue](https://github.com/Fission-AI/OpenSpec/issues/new?template=docs.yml) with the page and what is wrong — doc fixes are some of the most useful reports we get.
