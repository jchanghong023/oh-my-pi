---
name: jch-grill-todo
description: Explicit invocation only. Interview the user to agreement, then ask whether to generate a complete, self-contained .todo.md Markdown task file. Clarify and generate the file without executing the tasks.
disable-model-invocation: true
---

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round: number each question and give your recommended answer. Then wait for the user's answers before the next round.

Format a round like so:

```
❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>

---

❓ **Q2** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>
```

Word each question so "yes" accepts your recommended answer.

Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, etc.), dispatch a sub-agent with a fresh context window to find it; don't ask the user for anything you could look up yourself. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report; ask the rest of the frontier now. The _decisions_ are the user's: put each to them and wait.

The interview phase is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the user confirms you have reached a shared understanding. After confirmation, ask whether to generate a `.todo.md` Markdown task file.

<system-conventions>
RFC 2119 applies to MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL. NEVER and AVOID mean MUST NOT and SHOULD NOT.
</system-conventions>

## Generate only with permission

- Generation declined? Stop without writing.
- Target: `.todo.md` in the current working directory. MUST resolve its actual path. Before writing, recheck existence; an existing file requires separate overwrite permission. Declined? Preserve it; NEVER merge old tasks or silently choose another filename.
- Material decisions changed? MUST reopen affected branches and renew agreement and generation permission.
- Before generation permission, MUST remain read-only. NEVER modify other project files or execute the plan.

## Complete Markdown task file

MUST write a real, self-contained Markdown file, usable without the interview transcript. Include:

- Confirmed objective, scope, exclusions, permissions, decisions, tradeoffs and prerequisites.
- Verified source/material paths and current behavior; distinguish facts from agreed assumptions. NEVER fabricate paths, APIs, commands or results.
- Dependency-ordered tasks with concrete targets, required changes, observable outcomes and completion criteria; no placeholders or critical design decisions left open.
- Minimal sufficient verification commands and expected results allowed by project/user rules, including required documentation/specification updates.
- Preserve unrelated changes; mark tasks complete only after required work and verification succeed; report blockers without marking unfinished work complete.

MUST use same-level `##` task groups and ordinary `- [ ]` tasks. First checkbox immediately follows its group's heading; shared context contains no checkboxes. Details use indented continuation text, not nested checkboxes or code-fenced tasks. MUST state dependencies between groups.

MUST verify the file was written and follows the Markdown structure above. File generation does not prove the tasks were implemented or their acceptance checks passed.

MUST deliver the actual file path and checks performed, then stop. NEVER execute the tasks or launch another session automatically.
