# OMP dispatch agent mappings

The generator maps ordinary bundled Superpowers dispatch targets to OMP agent names: implementation uses `task`; code review uses `reviewer`. Upstream original bytes remain separate. Missing upstream dispatch anchors fail generation.

```yaml
agents:
  superpowers/skills/brainstorming/builder-check-prompt.md: task
  superpowers/skills/dispatching-parallel-agents/SKILL.md: task
  superpowers/skills/requesting-code-review/SKILL.md: reviewer
  superpowers/skills/requesting-code-review/code-reviewer.md: reviewer
  superpowers/skills/subagent-driven-development/implementer-prompt.md: task
  superpowers/skills/subagent-driven-development/task-reviewer-prompt.md: reviewer
  superpowers/skills/subagent-driven-development/re-review-prompt.md: reviewer
```
