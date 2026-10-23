Run a validation already approved in the current task plan by `validationId`.

- `stage: "red"`: run the target behavior test before production edits.
- `stage: "green"`: run the same validation after implementation.
- Commands are resolved by the host; you cannot supply or change them.
- The result records the actual command, exit code, output, timing and evidence artifact. A nonzero exit alone does not prove a valid TDD red result.
