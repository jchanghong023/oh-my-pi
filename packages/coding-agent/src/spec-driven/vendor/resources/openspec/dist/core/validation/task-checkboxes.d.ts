export interface TaskCheckboxDocument {
    path: string;
    content: string;
}
export interface TaskCheckboxIssue {
    path: string;
    line: number;
    message: string;
}
/**
 * Reports tracked task files that list work as plain bullets or numbered items
 * instead of checkboxes (#354).
 *
 * Progress counts checkboxes and nothing else, so a tasks file written as a
 * bare list is worse than an empty one: `openspec list` prints "No tasks",
 * `openspec status` treats the change as having no work left, and
 * `openspec archive` has no incomplete task to warn about. The file looks
 * finished to the tool and unfinished to the reader.
 *
 * Reported only when the change's *whole* tracked set has zero checkboxes.
 * One nested tasks file of prose beside a real checklist is not the failure
 * this catches, and a change that is mid-authoring keeps its progress the
 * moment a single checkbox exists.
 *
 * The scan for the offending line looks at rendered content only: fenced
 * blocks, HTML comments, YAML front matter and top-level indented code are
 * skipped. Every one of those
 * exclusions can only *silence* a warning, never drop a real task — that is the
 * opposite trade from the task parser, where fence awareness would hide work
 * that `archive` must still refuse, and it is why the parser stays literal
 * while this scan does not.
 */
export declare function findMissingTaskCheckboxIssues(documents: readonly TaskCheckboxDocument[]): TaskCheckboxIssue[];
//# sourceMappingURL=task-checkboxes.d.ts.map