## Code Review Request

### Mode

{{mode}}

{{#if frozenMaterials}}
### Frozen Export Materials

<system-conventions>
RFC 2119 applies to MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL. `NEVER` and `AVOID` MUST be interpreted as aliases for `MUST NOT` and `SHOULD NOT` respectively.
</system-conventions>

- All member paths below are relative to the unpacked ZIP root, not `instructions/`.
- Frozen base: {{#if frozenMaterials.baseCommit}}`{{frozenMaterials.baseCommit}}`{{else}}empty tree{{/if}}. Frozen target: `{{frozenMaterials.targetCommit}}`.
- MUST read `manifest.json` for the selected scope, frozen identities, `changes`, `sources`, omissions and limitations.
- MUST use the complete `diff.patch` for assigned changes; embedded hunks/previews are navigation aids, not substitutes.
- MUST read source context from manifest `sources[].member`: `version: "base"` maps to `changed-files/before/<original-path>`; `version: "target"` maps to `changed-files/after/<new-path>`. Additions/deletions have only their existing side; renames use the recorded original/new paths.
- NEVER substitute the current checkout or query Git, JJ, GitHub or PR endpoints for frozen diff/source content, including historical commits and PR targets.
- Missing context or omitted payload? MUST request the matching frozen-version material from the user; NEVER infer absent content or fall back to the checkout.
- MUST apply `instructions/reviewer.md` in full, except its patch/context acquisition steps are replaced by these frozen-material rules; retain all review criteria, findings and verdict rules.

{{/if}}
### Changed Files ({{len files}} files, +{{totalAdded}}/-{{totalRemoved}} lines)

{{#if files.length}}
{{#if prDiffUrl}}
Index is the file's 1-based position in the full PR diff; excluded files leave gaps. Assign each file with its exact Diff URL below.

{{#table files headers="Index|File|+/-|Type|Diff URL"}}
{{diffIndex}} | {{path}} | +{{linesAdded}}/-{{linesRemoved}} | {{ext}} | `{{diffUrl}}`
{{/table}}
{{else}}
{{#table files headers="File|+/-|Type"}}
{{path}} | +{{linesAdded}}/-{{linesRemoved}} | {{ext}}
{{/table}}
{{/if}}
{{else}}
_No files to review._
{{/if}}

{{#if excluded.length}}
### Excluded Files ({{len excluded}})

{{#list excluded prefix="- " join="\n"}}
`{{path}}` (+{{linesAdded}}/-{{linesRemoved}}) — {{reason}}
{{/list}}
{{/if}}

### Distribution Guidelines

Use the `task` tool with `agent: "reviewer"` and a `tasks` array.
{{#when agentCount "==" 1}}Create exactly **1 reviewer task**.{{else}}Spawn **{{agentCount}} reviewer agents** in parallel.{{/when}}
{{#if frozenMaterials}}
Each reviewer task MUST receive these frozen-material rules, the ZIP root and its assigned files; use the complete `instructions/reviewer.md` with the acquisition override above.
{{/if}}
{{#if multiAgent}}
Group files by locality, e.g.:
- Same directory/module → same agent
- Related functionality → same agent
- Tests with their implementation files → same agent
{{/if}}

### Reviewer Instructions

Reviewer MUST:
1. Focus ONLY on assigned files
2. {{#if frozenMaterials}}MUST read assigned changes from the complete `diff.patch`, resolving paths and frozen identities through `manifest.json`; NEVER re-query Git or PR diffs{{else}}{{#if skipDiff}}{{#if prDiffUrl}}MUST read assigned PR file diffs using the exact Diff URL in the Changed Files table or `{{prDiffUrl}}/all`; NEVER use local `git diff`/`git show` for PR diff content{{else}}{{#if diffInstruction}}{{diffInstruction}}{{else}}MUST run `git diff`/`git show` for assigned files{{/if}}{{/if}}{{else}}MUST use diff hunks below (NEVER re-run git diff){{/if}}{{/if}}
3. {{#if frozenMaterials}}MUST read the assigned files' frozen before/after members listed in `manifest.json`; request additional matching-version context from the user if needed, NEVER use the current checkout{{else}}{{#if suppliedPatch}}NEVER read local workspace files for file context; the supplied diff may not match the checkout{{else}}{{#if prDiffUrl}}NEVER read local workspace files for PR file context; use the fetched PR diff, the exact Diff URL in the Changed Files table, or `{{prDiffUrl}}/all` only{{else}}{{#if contextInstruction}}{{contextInstruction}}{{else}}MAY read full file context as needed via `read`{{/if}}{{/if}}{{/if}}{{/if}}
4. Use incremental `yield` sections for findings and verdict fields; do NOT call a separate finding tool

{{#if skipDiff}}
### Diff Previews

_Full diff too large ({{len files}} files). Showing first ~{{linesPerFile}} lines per file._

{{#list files join="\n\n"}}
#### {{path}}

{{#codeblock lang="diff"}}
{{hunksPreview}}
{{/codeblock}}
{{/list}}
{{else}}

### Diff

<diff>
{{rawDiff}}
</diff>
{{/if}}

{{#if additionalInstructions}}
### Additional Instructions

{{additionalInstructions}}
{{/if}}
