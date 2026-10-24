Run a current approved validation obligation by `validationId`; the host enforces task scope and project authorization.

- `stage: "red"`: test the target behavior before the first production edit.
- `stage: "green"`: verify implemented behavior against current inputs.
- Omit `command` to run the approved command.
- Equivalent invocation? Supply both `command` and a nonempty `reason`; preserve the original obligation. Independent review checks equivalence, not your assertion.
- The result records approved and actual commands, reason, exit code, output, timing and evidence artifacts. A nonzero exit alone does not prove meaningful RED; cancelled, unknown or null exits never prove GREEN.
- You NEVER supply success records or bypass required validations, TDD, review or host approval gates. This tool grants no new TDD exemption, scope, push, final merge or user acceptance authority.
