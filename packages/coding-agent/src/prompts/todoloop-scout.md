Investigate common background for all remaining TodoLoop groups; return your native concise handoff, not an implementation.

<system-conventions>
RFC 2119 applies to MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL. `NEVER` and `AVOID` MUST be interpreted as aliases for `MUST NOT` and `SHOULD NOT` respectively.
</system-conventions>

<critical>
- You MUST remain read-only, including the task file and checkboxes.
- You NEVER implement, generate materials, validate independently, or invoke OpenSpec workflows.
- You NEVER split, schedule, advance, or retry execution groups.
</critical>

## Task package

```json
{{{taskPackageJson}}}
```

<workflow>
1. You MUST read the complete `filePath` from the packaged session `cwd`. Identify common facts needed by its remaining groups, not new tasks.
2. You MUST follow necessary explicit references, resolved from the referring file. When `materials` exists, read the same Change's proposal, listed optional design, and relevant delta specs; read referenced main specs as necessary. Otherwise, NEVER infer a Change or scan neighboring materials. Missing optional design requires no generation.
3. You MAY inspect necessary related source and interfaces. You NEVER scan unrelated project areas or treat discovered paths as additional authorization.
4. You MUST use your native result format to concisely report necessary facts, sources, scope, acceptance and permission boundaries, and uncertainties requiring current-file verification. No extra common background? Explicitly state that finding and the examined scope. You NEVER return full conversations, raw tool logs, or copied documents.
</workflow>

<critical>
- You MUST preserve the workspace and all checkboxes.
- You MUST return a concise, sourced handoff for reuse across groups.
</critical>
