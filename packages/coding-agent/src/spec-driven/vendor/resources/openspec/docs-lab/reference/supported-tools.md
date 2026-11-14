# Supported tools

> Which AI coding tool this vendored OpenSpec configures, and how to invoke its skills.

This copy supports one target: **Oh My Pi** (`oh-my-pi`). The upstream
multi-tool matrix is not bundled; `openspec init` neither offers nor accepts the
removed tool ids.

## Where skills go

`openspec init` writes the skills once, to `.agents/skills/`:

```text
my-project/
├── .agents/skills/
│   ├── .openspec-target           the tools set up here (here: oh-my-pi)
│   └── openspec-propose/SKILL.md  the one copy OpenSpec manages
└── openspec/
    ├── config.yaml
    ├── specs/
    └── changes/
```

Oh My Pi reads `.agents/skills/` directly, so OpenSpec creates no tool-specific
command files and no links. `openspec update` uses `.openspec-target` to refresh
the generated skills in place.

## Support matrix

Invocations are shown for the apply workflow. Every workflow follows the same
shape, and the id is what `openspec init --tools <id>` accepts.

| Tool | `--tools` id | Skills | Skill invocation |
|---|---|---|---|
| Oh My Pi | `oh-my-pi` | `.agents/skills/` | `/openspec-apply-change` |

`--tools all` selects the same single target; `--tools none` creates only
`openspec/`. Any other id fails with `Invalid tool(s)` and writes nothing.

## Existing projects

An existing `openspec/` folder is refreshed in place; specs and changes are left
alone. Projects set up by older upstream releases may still contain files under
other tool directories. This copy does not install, migrate, or delete those
directories; remove leftovers yourself if you no longer use them.

## Next

- [Setup](../start/setup.md) — what init writes and how to adjust it.
- [CLI reference](cli.md) — `openspec init`, `openspec update`, and `--tools`.
