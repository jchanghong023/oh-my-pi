# OpenSpec Documentation

This offline documentation describes OpenSpec 2.0 bundled with OMP. Upstream documentation may include standalone installation and other-Agent delivery that are not part of this integration.

Welcome. This is the home for everything OpenSpec.

OpenSpec helps you and your AI coding assistant **agree on what to build before any code is written.** You describe the change, the AI drafts a short spec and a task list, you both look at the same plan, and then the work happens. No more discovering halfway through that the AI built the wrong thing.

If you read nothing else, read these two pages:

1. [Getting Started](getting-started.md): initialize a project explicitly and ship your first change.
2. [How Commands Work](how-commands-work.md): where you actually type `/skill:openspec-propose` (hint: in your AI chat, not the terminal). This trips up almost everyone once.

That second one matters more than it looks. OpenSpec has two halves: a command line tool you run in your terminal, and slash commands you give to your AI assistant. Knowing which is which saves you the most common moment of confusion.

> **The best habit to build first: when you're not sure what to build, start with `/skill:openspec-explore`.** It's a no-stakes thinking partner that reads your code, weighs options, and sharpens a fuzzy idea into a concrete plan before any code gets written. The [Explore First](explore.md) guide makes the case.

## Pick your path

**I'm brand new.** Start with [Getting Started](getting-started.md), then skim the [Core Concepts at a Glance](overview.md). When something feels mysterious, the [FAQ](faq.md) and [Glossary](glossary.md) are nearby.

**I have a problem but not a plan.** This is the common case, and it has a dedicated answer: [Explore First](explore.md). Use `/skill:openspec-explore` to think it through with the AI before committing to anything.

**I have a big existing codebase.** You don't document all of it. [Using OpenSpec in an Existing Project](existing-projects.md) shows how to start on real, brownfield code without boiling the ocean.

**I just want to get it working.** OMP already includes the CLI and all 12 Skills. Read [Project setup](installation.md), explicitly initialize the intended project with `omp openspec init`, then use native `/skill:<name>` invocations as described in [How Commands Work](how-commands-work.md).

**I learn by example.** The [Examples & Recipes](examples.md) page walks through real changes start to finish: a small feature, a bug fix, a refactor, an exploration.

**The AI just drafted a plan — now what?** Read it. [Reviewing a Change](reviewing-changes.md) shows the two-minute pass that catches a wrong turn while it's still cheap, and [Writing Good Specs](writing-specs.md) covers what a plan worth approving is made of.

**I work on a team.** [OpenSpec on a Team](team-workflow.md) shows how a change maps onto a branch and a pull request, and how teammates review a plan before the code.

**I'm coming from the old workflow.** The [Migration Guide](migration-guide.md) explains what changed and why, and promises your existing work is safe.

**I want to bend it to my team's process.** [Customization](customization.md) covers project config, custom schemas, and shared context.

**Something's broken.** [Troubleshooting](troubleshooting.md) collects the failures people actually hit, with fixes.

## The whole map

### Start here

| Doc | What it gives you |
|-----|-------------------|
| [Getting Started](getting-started.md) | Initialize explicitly and run your first change end to end |
| [Explore First](explore.md) | Use `/skill:openspec-explore` to think through an idea before you commit |
| [How Commands Work](how-commands-work.md) | Where slash commands run, what "interactive mode" means, terminal vs chat |
| [Core Concepts at a Glance](overview.md) | The whole mental model on one page: specs, changes, deltas, archive |
| [Project setup](installation.md) | Bundled resources, native discovery, initialization, and OMP upgrades |

### Use it day to day

| Doc | What it gives you |
|-----|-------------------|
| [Workflows](workflows.md) | Common patterns and when to reach for each command |
| [Examples & Recipes](examples.md) | Full walkthroughs of real changes, copy-pasteable |
| [Writing Good Specs](writing-specs.md) | What a strong requirement and scenario look like, and how to right-size a change |
| [Reviewing a Change](reviewing-changes.md) | The two-minute pass on a drafted plan before any code is written |
| [OpenSpec on a Team](team-workflow.md) | How changes fit branches, pull requests, and review |
| [Using OpenSpec in an Existing Project](existing-projects.md) | Adopting OpenSpec on a large brownfield codebase |
| [Editing & Iterating on a Change](editing-changes.md) | Update artifacts, go back, reconcile manual edits |
| [Commands](commands.md) | Reference for every `/skill:openspec-*` slash command |
| [CLI](cli.md) | Reference for `omp openspec ...` terminal operations |

### Understand it deeply

| Doc | What it gives you |
|-----|-------------------|
| [Concepts](concepts.md) | The long-form explanation of specs, changes, artifacts, schemas, and archive |
| [OPSX Workflow](opsx.md) | Why the workflow is fluid instead of phase-locked, plus an architecture deep dive |
| [Glossary](glossary.md) | Every term defined in one place |

### Make it yours

| Doc | What it gives you |
|-----|-------------------|
| [Customization](customization.md) | Project config, custom schemas, shared context |
| [Multi-Language](multi-language.md) | Generate artifacts in languages other than English |
| [Supported interface](supported-tools.md) | All 12 native OMP Skill names and invocation rules |
| [Community Showcase](community.md) | Projects and resources built with and for OpenSpec |

### When you need help

| Doc | What it gives you |
|-----|-------------------|
| [FAQ](faq.md) | Quick answers to the questions people ask most |
| [Troubleshooting](troubleshooting.md) | Concrete fixes for concrete failures |
| [Migration Guide](migration-guide.md) | Moving from the legacy workflow to OPSX |

### Coordinate across repos (beta)

| Doc | What it gives you |
|-----|-------------------|
| [Stores: User Guide](stores-beta/user-guide.md) | Plan in its own repo when your work spans repos or teams |
| [Agent Contract](agent-contract.md) | The machine-readable CLI surfaces agents drive |

## The thirty-second version

```text
1. Initialize     cd your-project && omp openspec init
2. Explore        (in OMP chat)  /skill:openspec-explore       (optional)
3. Propose        (in OMP chat)  /skill:openspec-propose add-dark-mode
4. Build          (in OMP chat)  /skill:openspec-apply-change
5. Archive        (in OMP chat)  /skill:openspec-archive-change
```

Initialization happens in the terminal only after explicit authorization and does not install or clean user Skills or commands. The remaining steps happen in OMP chat. All 12 Skills are discoverable in any directory, support native completion and `skill://<name>` reads, and preserve project/user same-name override precedence. No separate Node/OpenSpec install is needed; resources update with OMP releases, not CLI `update`. Legacy `opsx` file commands are removed.

## Where else to get help

- **Discord:** [discord.gg/YctCnvvshC](https://discord.gg/YctCnvvshC) for questions, ideas, and help.
- **GitHub Issues:** [github.com/Fission-AI/OpenSpec/issues](https://github.com/Fission-AI/OpenSpec/issues) for bugs and feature requests.
- **`omp openspec feedback "your message"`** sends feedback straight from your terminal (it opens a GitHub issue).

Found something in these docs that's wrong, stale, or confusing? That's a bug — open a [docs issue](https://github.com/Fission-AI/OpenSpec/issues/new?template=docs.yml).
