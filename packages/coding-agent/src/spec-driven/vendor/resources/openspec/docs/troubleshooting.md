# Troubleshooting

Concrete fixes for concrete problems. Each entry names a symptom, explains the likely cause in a sentence, and gives you the fix. If you don't see your issue here, the [FAQ](faq.md) may help, and the [Discord](https://discord.gg/YctCnvvshC) definitely will.

## Installation and setup

Use `omp openspec --help` and `omp openspec --version`, not a separate `openspec` executable. OMP supplies the runtime and resources; no standalone Node/OpenSpec installation is required. Missing or invalid bundled resources require a valid OMP release (or resource preparation in a source checkout), not an online download at runtime.

`omp openspec init [path]` initializes project structure/configuration only after explicit authorization. It defaults to `spec-driven`, preserves existing configuration, and never installs, updates, or cleans user Skills, Agent directories, or old commands. CLI `update` and `opsx` file commands are removed.

## Commands don't show up

All 12 Skills are natively discoverable in any directory without init. Invoke `/skill:openspec-propose`, not legacy command syntax. Check OMP native Skill settings, bundled resources, and project/user same-name overrides. Read `skill://openspec-propose` on demand using normal authorization. Do not copy or regenerate Skill files; upgrade OMP to update bundled resources. Superpowers and JCH retain their existing discovery rules.

## Working with changes

### "Change not found"

The command couldn't tell which change you meant. Name it explicitly, or check what exists:

```bash
omp openspec list                    # see active changes
/skill:openspec-apply-change add-dark-mode        # name the change in chat
```

Also confirm you're in the right project directory.

### "No artifacts ready"

Every artifact is either already created or blocked waiting on a dependency. See what's blocking:

```bash
omp openspec status --change <name>
```

Then create the missing dependency first. Remember the order: proposal enables specs and design; specs and design together enable tasks.

### `omp openspec validate` reports warnings or errors

Validation checks your specs and changes for structural problems. Read the message: it names the file and the issue.

```bash
omp openspec validate <name>           # validate one item
omp openspec validate --all            # validate everything
omp openspec validate --all --strict   # stricter checks, good for CI
omp openspec validate --archived       # fail if archived changes have unchecked tasks
```

Common causes are a missing required section (like a spec with no scenarios) or a malformed delta header. Fix the file and re-run. The [CLI reference](cli.md#openspec-validate) documents the output format.

One message deserves its own note:

```text
MODIFIED "<requirement>" omits scenario(s) the current spec still has: "<scenario>"
```

A `MODIFIED` requirement replaces the whole requirement block, so it has to carry every scenario that survives the change, not only the ones you edited. Copy the named scenarios from `openspec/specs/<capability-path>/spec.md` back into the delta, preserving any domain directories in the path. This often appears on an older change after someone else's change added a scenario to the same requirement — archive refuses that change either way, and validation now says so before you implement it.

### The AI created incomplete or wrong artifacts

The AI didn't have enough context. A few levers help:

- Add project context in `openspec/config.yaml` so your stack and conventions are injected into every request. See [Customization](customization.md#project-configuration).
- Add per-artifact `rules:` for guidance that only applies to, say, specs.
- Give a more detailed description when you propose.
- Use the expanded `/skill:openspec-continue-change` to create one artifact at a time and review each, instead of `/skill:openspec-ff-change` doing them all at once.

### Archive won't finish, or warns about incomplete tasks

Archive won't *block* on incomplete tasks, but it warns you, because archiving usually means the work is done. If tasks remain on purpose (you're filing a partial change), proceed. Otherwise finish the tasks first. Archive will also offer to sync your delta specs into the main specs if you haven't synced yet; say yes unless you have a reason not to.

### "User force closed the prompt with 0 null"

Something ran `omp openspec archive` where nothing can answer a question — an AI agent calling it from a tool, a CI job, or any shell with stdin closed. Archive asks up to three confirmations, and an unanswerable one used to fail with that raw message.

Pass `--yes` to answer them up front:

```bash
omp openspec archive <change-name> --yes
```

Keep any flags you were already passing — `--skip-specs` and `--no-validate` change what archive does, so a bare `--yes` rerun is not the same command. Current versions name the flag for you and print a `Fix:` line you can paste. If you meant to pick from a list, pass the change name explicitly: the picker needs an answer too.

If you instead ran archive with its output redirected to a file or captured by a tool and *did* pipe an answer (`printf 'y\n' | omp openspec archive …`), older versions wrote terminal escape codes into that capture while drawing the prompt — in some environments enough to bloat the file badly. Current versions read the confirmation prompts as plain text whenever stdout is not a terminal, and a no-argument `omp openspec archive` (which would otherwise draw an interactive change picker) asks you to pass a change name up front instead of rendering a menu into the capture. Either way, redirected and agent runs stay clean; passing `--yes` (with a change name) skips the prompts entirely.

## Configuration

### My `config.yaml` isn't being applied

Three usual suspects:

1. **Wrong filename.** It must be `openspec/config.yaml`, not `.yml`.
2. **Invalid YAML.** Run it through any YAML validator; the CLI also reports syntax errors with line numbers.
3. **You expected a restart.** You don't need one. Config changes take effect immediately.

### "Unknown artifact ID in rules: X"

A key under `rules:` doesn't match any artifact in your schema. For the default `spec-driven` schema the valid IDs are `proposal`, `specs`, `design`, `tasks`. To see the IDs for any schema:

```bash
omp openspec schemas --json
```

### "Context too large"

The `context:` field is capped at 50KB, on purpose, because it's injected into every request. Summarize it, or link out to longer docs instead of pasting them. Lean context also produces better, faster results.

### "Schema not found"

The schema name you referenced doesn't exist. List what's available and check spelling:

```bash
omp openspec schemas                    # list available schemas
omp openspec schema which <name>        # see where a schema resolves from
omp openspec schema init <name>         # create a custom one
```

See [Customization](customization.md#custom-schemas).

## Migration from the legacy workflow

### "Legacy files detected in non-interactive mode"

OMP does not clean legacy files during init. Use the bundled `omp openspec` entry; do not pass cleanup flags or delete user Agent settings.

### Commands didn't appear after migrating

Use native `/skill:<name>` invocation and inspect OMP Skill settings and same-name overrides. Initialization does not generate command files; see [Supported interface](supported-tools.md).

### My old `project.md` wasn't migrated

That's intentional. OpenSpec never deletes `project.md` automatically because it may hold context you wrote. Move the useful parts into `config.yaml`'s `context:` section, then delete it yourself. The [Migration Guide](migration-guide.md#migrating-projectmd-to-configyaml) walks through this, including a prompt you can hand to your AI to do the distilling.

## Still stuck?

- **Discord:** [discord.gg/YctCnvvshC](https://discord.gg/YctCnvvshC)
- **GitHub Issues:** [github.com/Fission-AI/OpenSpec/issues](https://github.com/Fission-AI/OpenSpec/issues)
- **From your terminal:** `omp openspec feedback "what went wrong"` opens an issue for you.

When you report a problem, include your OpenSpec version (`omp openspec --version`), your Node version (`node --version`), your AI tool, and the exact command and output. It makes help much faster.
