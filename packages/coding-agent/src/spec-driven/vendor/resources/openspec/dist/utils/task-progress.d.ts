export interface ParsedTask {
    /** Checkbox state: `[x]`/`[X]` is done, every other marker (and none) is not. */
    done: boolean;
    /** Task text after the checkbox, trimmed (may be empty). */
    description: string;
}
/**
 * Parses every task line in a tasks file, in document order.
 *
 * Every line matching the pattern counts, wherever it sits - inside a code
 * fence, an HTML comment or an indented block, as before. Skipping fenced
 * checkboxes was tried and dropped: every rule for deciding which fence is
 * "real" has an input where a stray or unbalanced ``` swallows genuine tasks.
 * Counting a documented example as work is a loud, bypassable false positive;
 * losing a real task is a silent one.
 */
export declare function parseTaskLines(content: string): ParsedTask[];
export interface TaskProgress {
    total: number;
    completed: number;
}
export declare function countTasksFromContent(content: string): TaskProgress;
/**
 * Run-scoped memo mapping a schema name to its tracked-tasks `generates` glob.
 * When one command resolves progress for many changes under a constant
 * `projectRoot` — e.g. `validate --archived` over an append-only archive — this
 * avoids re-reading and re-parsing (YAML + Zod) the same `schema.yaml` once per
 * change. Keyed by schema name alone, which is safe *only* because a single run
 * holds `projectRoot` constant; never reuse one cache across differing roots.
 */
export type SchemaGlobCache = Map<string, string | undefined>;
/** Resolves the task files selected by the schema's apply tracking rule. */
export declare function resolveTaskFilesForChange(changeDir: string, projectRoot: string, schemaGlobCache?: SchemaGlobCache): string[];
export interface TaskProgressDetail extends TaskProgress {
    /**
     * Task files that exist but could not be read (any error other than ENOENT).
     * `getTaskProgressForChange` discards this list to preserve its behavior;
     * callers that must fail loudly on an unreadable tasks file — e.g.
     * `openspec validate --archived` — read it so an unreadable file is never
     * silently counted as "no tasks" (#205).
     */
    unreadable: string[];
}
/**
 * Computes a change's task progress by resolving its tracked-tasks artifact and
 * counting checkboxes across every file matched by that artifact's `generates`
 * glob — the same file-resolution `openspec status` uses to detect the tasks
 * artifact (`resolveArtifactOutputs`) — so progress is no longer blind to nested
 * `tasks.md` files (#1202). Falls back to a single top-level `tasks.md` (exactly
 * as before) when the schema is unresolvable, no tracked-tasks artifact is found,
 * or the glob matches no file. Also reports task files that exist but could not
 * be read. Per-file read errors are captured (never thrown); the only throw path
 * is a malformed/unsafe schema whose glob resolution rejects (path traversal or
 * a linked-directory cycle in `resolveArtifactOutputs`). Pass `schemaGlobCache`
 * to memoize schema→glob resolution across many changes in one run.
 */
export declare function getTaskProgressDetailForChange(changesDir: string, changeName: string, projectRoot: string, schemaGlobCache?: SchemaGlobCache): Promise<TaskProgressDetail>;
/**
 * The task-completion counter `status`, `list`, and `archive` share. Delegates
 * to `getTaskProgressDetailForChange` and drops the `unreadable` detail, so its
 * returned totals are unchanged. Throws only on the same malformed/unsafe-schema
 * glob-resolution path as that function (existing behavior; callers guard it as
 * they did before).
 */
export declare function getTaskProgressForChange(changesDir: string, changeName: string, projectRoot: string): Promise<TaskProgress>;
export declare function formatTaskStatus(progress: TaskProgress): string;
//# sourceMappingURL=task-progress.d.ts.map