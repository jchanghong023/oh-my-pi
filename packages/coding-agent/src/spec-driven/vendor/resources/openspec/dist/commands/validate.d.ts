import { toRootOutput } from '../core/root-selection.js';
type ItemType = 'change' | 'spec';
interface ExecuteOptions {
    all?: boolean;
    changes?: boolean;
    specs?: boolean;
    archived?: boolean;
    report?: string;
    type?: string;
    strict?: boolean;
    json?: boolean;
    noInteractive?: boolean;
    interactive?: boolean;
    concurrency?: string;
    store?: string;
    storePath?: string;
}
interface BulkItemResult {
    id: string;
    type: ItemType;
    valid: boolean;
    issues: {
        level: 'ERROR' | 'WARNING' | 'INFO';
        path: string;
        message: string;
    }[];
    durationMs: number;
}
type BulkScope = 'all' | 'changes' | 'specs' | 'archived';
interface BulkValidationResult<T extends BulkItemResult = BulkItemResult> {
    items: T[];
    summary: {
        totals: {
            items: number;
            passed: number;
            failed: number;
        };
        byType: Partial<Record<ItemType, {
            items: number;
            passed: number;
            failed: number;
        }>>;
    };
    root: ReturnType<typeof toRootOutput>;
}
/** Findings are a distinct report, not a partial full-v1 items collection. */
export declare function projectValidationFindings<T extends BulkItemResult>(full: BulkValidationResult<T>, scope: BulkScope): {
    report: {
        kind: "validation-findings";
        version: "1.0";
        scope: BulkScope;
        returnedItems: number;
        totalItems: number;
    };
    itemFindings: T[];
    summary: {
        totals: {
            items: number;
            passed: number;
            failed: number;
        };
        byType: Partial<Record<ItemType, {
            items: number;
            passed: number;
            failed: number;
        }>>;
    };
    root: import("../core/root-selection.js").RootOutput;
};
export declare class ValidateCommand {
    execute(itemName: string | undefined, options?: ExecuteOptions): Promise<void>;
    private normalizeType;
    /**
     * Resolve change IDs by directory existence within the resolved root — the
     * same rule `openspec status`/`instructions` use (`getAvailableChanges`) —
     * rather than requiring `proposal.md`. This lets `validate` resolve a
     * scaffolded or still-authoring change that the sibling commands already
     * resolve (#1182). Sorted to preserve the prior `getActiveChangeIds` ordering.
     */
    private listChangeIds;
    private runInteractiveSelector;
    private printNonInteractiveHint;
    private validateDirectItem;
    /**
     * A namespace folder wrapping nested change directories has no deltas of its
     * own and never will. The usual "add a delta spec" error points the author at
     * a directory that is not the change, so the nesting is reported instead
     * (#1846). Returns undefined for every ordinary change.
     */
    private nestedChangeReport;
    private validateByType;
    private printReport;
    private printNextSteps;
    private printFindingsReport;
    private printBulkDetails;
    private runBulkValidation;
    /**
     * Lists archived change ids from the resolved root's archive directory,
     * mirroring `getArchivedChangeIds` but store-aware (uses `root.archiveDir`
     * rather than a cwd-relative path). Directories only, hidden entries skipped.
     *
     * Only a missing archive directory (ENOENT) is an empty list; a permission
     * error, an I/O error, or an `archive` path that is a file (ENOTDIR) is a real
     * failure and must not read as "no archived changes" — that would let a
     * pre-commit lint pass without inspecting anything (#205).
     */
    private listArchivedChangeIds;
    /**
     * Validates that every archived change has all of its tasks completed.
     *
     * An archived change is expected to be finished; an archived change with
     * unchecked tasks is a real integrity problem the normal validate flow never
     * surfaces, because active-change discovery excludes the archive directory
     * (#205). Reuses the same task-progress counting `status`, `list`, and
     * `archive` rely on, so what counts as a task never forks. Changes with no
     * tasks pass (nothing to complete).
     */
    private runArchivedTaskValidation;
}
export {};
//# sourceMappingURL=validate.d.ts.map