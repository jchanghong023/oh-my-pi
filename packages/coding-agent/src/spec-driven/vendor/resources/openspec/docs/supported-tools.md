# Supported Tools

This vendored OpenSpec copy configures one AI coding tool: **Oh My Pi** (`oh-my-pi`). `openspec init` offers that target only; other assistant integrations from upstream are not bundled.

## How It Works

`openspec init` writes OpenSpec's skills to the shared Agent Skills folder:

```text
.agents/skills/
├── .openspec-target              # records the tools set up in this project
└── openspec-<workflow>/SKILL.md
```

Oh My Pi reads `.agents/skills/` directly, so no tool-specific command files or links are created. `openspec update` reads `.openspec-target` and refreshes the same files in place.

By default, OpenSpec uses the `core` profile, which includes:

- `propose`
- `explore`
- `apply`
- `update`
- `sync`
- `archive`

Enable the expanded workflows (`new`, `continue`, `ff`, `verify`, `bulk-archive`, `onboard`) with `openspec config profile`, then run `openspec update`.

## How To Invoke

Skills are invoked by name:

```text
/openspec-propose "your idea"
/openspec-apply-change
/openspec-archive-change
```

The exact hint printed after `openspec init` is authoritative for the current project.

## Tool Directory Reference

| Tool (ID) | Skills path | Command files |
|---|---|---|
| Oh My Pi (`oh-my-pi`) | `.agents/skills/openspec-*/SKILL.md` | Not generated (skills-only) |

## Tool Selection

`openspec init --tools <ids>` accepts:

- `oh-my-pi`
- `all` (currently the same single target)
- `none` (create `openspec/` only)

Any other tool id is rejected with an explicit `Invalid tool(s)` error; it is not mapped to Oh My Pi.
