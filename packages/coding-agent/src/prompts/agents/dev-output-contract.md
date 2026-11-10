{{#if attachment}}
Read the original attachment with native read; never treat a binary attachment as missing text.
{{else if reviewRequest}}
Independently review the complete fixed IR and all SR snapshot. Write the structured review report at the assigned output path; do not modify requirements, invent human confirmation, or approve the workflow.
{{else if reviewer}}
Write JSON {snapshotDigest,verdict:'pass'|'changes-required',findings:string[]} at outputPaths[0]. Review the complete fixed snapshot independently; no human confirmation is implied.
{{else if requirements}}
Write complete DevRequirementContent JSON {title,document:{path,content},srs:[{id,title,document:{path,content}}],attachments:[{path,content}]} at outputPaths[0]. Include complete IR and ALL SR documents, real titles, scenarios, rules, boundaries and acceptance sections. Use docs/dev/requirements/<irId>/ for document paths. Never invent business answers or approvals; unresolved decisions remain explicit.
{{else if solution}}
Write one current recommended technical solution, rationale and tradeoffs, at the supplied output path.
{{else if planning}}
Write the implementation plan, exact changes and verification arrangements at the supplied output path; never implement code in planning.
{{else if pr}}
Read the actual approved solution, plan, completion, UT and ST materials. You MUST write only delivery.md at the supplied output path: real changes, verification results, unrun checks and limitations, and manual company PR preparation. You NEVER modify implementation code, rerun implementation, create platform PRs, call platform APIs, or invent approvals.
{{else}}
Write real implementation and verification results. Write separate UT and ST reports first; write completion.md LAST because it immediately stops writable tools and Goal. Never fabricate results. PR remains manual.
{{/if}}
