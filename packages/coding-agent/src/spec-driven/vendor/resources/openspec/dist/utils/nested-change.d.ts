/** A namespace folder under `changes/` and the change directories buried in it. */
export interface NestedChangeFinding {
    /** The directory name directly under `changes/` that is not a change. */
    name: string;
    /**
     * Slash-separated paths of the nested change directories, relative to
     * `changes/`, sorted. Always at least one entry.
     */
    nested: string[];
}
/**
 * Reports whether the directory `changes/<name>/` is a namespace folder holding
 * one or more nested change directories rather than a change of its own.
 *
 * Returns undefined for every ordinary change, including a scaffolded one with
 * no artifacts yet: only a *nested* change directory distinguishes the two.
 */
export declare function findNestedChangesIn(changesDir: string, name: string): Promise<NestedChangeFinding | undefined>;
/**
 * The same check across every candidate directory under `changes/`, for the
 * commands that enumerate rather than resolve a single name.
 */
export declare function findNestedChanges(changesDir: string, names: string[]): Promise<NestedChangeFinding[]>;
/**
 * The stable phrase every nested-change diagnostic contains. Callers that have
 * only the rendered message - `validate`'s next-steps, which branches on the
 * exact issue it is advising about - recognise the case by this.
 */
export declare const NESTED_CHANGE_ISSUE_MARKER = "is not a change: it is a folder wrapping";
/**
 * The one explanation every surface prints, so the constraint and the way out
 * read identically wherever a user meets them.
 */
export declare function describeNestedChange(finding: NestedChangeFinding): string;
//# sourceMappingURL=nested-change.d.ts.map