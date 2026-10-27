import type { RootOutput } from '../core/root-selection.js';
export declare class ChangeCommand {
    private converter;
    private rootPath?;
    constructor(rootPath?: string);
    private getChangesPath;
    private getSpecsPath;
    /**
     * Show a change proposal.
     * - Text mode: raw markdown passthrough (no filters)
     * - JSON mode: minimal object with deltas; --deltas-only returns same object with filtered deltas
     *   Note: --requirements-only is deprecated alias for --deltas-only
     * - --diff: per-requirement diffs of the delta specs against the main specs,
     *   appended in text mode and attached to MODIFIED deltas in JSON mode
     */
    show(changeName?: string, options?: {
        json?: boolean;
        requirementsOnly?: boolean;
        deltasOnly?: boolean;
        diff?: boolean;
        noInteractive?: boolean;
        rootOutput?: RootOutput;
    }): Promise<void>;
    /**
     * Read every delta spec under the change and pair each requirement with its
     * counterpart in the main spec. Text mode and JSON mode both render from this
     * one pass, so the two surfaces cannot drift apart.
     */
    private collectSpecDiffs;
    /**
     * Attach `diff` (or `warning`) to every MODIFIED delta in the JSON payload.
     * Mutates the deltas array in place.
     *
     * The parsed Delta objects carry the requirement body in `description`, not
     * the header name, so they are matched to parsed blocks by capability and
     * source order: ChangeParser emits one Delta per MODIFIED block in that order.
     */
    private enrichDeltasWithDiffs;
    /**
     * Text mode: per-requirement diffs of the delta specs against the main specs.
     */
    private showSpecDiffs;
    private printDiffText;
    /**
     * List active changes.
     * - Text default: IDs only; --long prints minimal details (title, counts)
     * - JSON: array of { id, title, deltaCount, taskStatus }, sorted by id
     */
    list(options?: {
        json?: boolean;
        long?: boolean;
    }): Promise<void>;
    validate(changeName?: string, options?: {
        strict?: boolean;
        json?: boolean;
        noInteractive?: boolean;
    }): Promise<void>;
    private extractTitle;
    private printNextSteps;
}
//# sourceMappingURL=change.d.ts.map