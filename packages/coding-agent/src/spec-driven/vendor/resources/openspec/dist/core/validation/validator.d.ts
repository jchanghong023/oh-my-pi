import { ValidationReport } from './types.js';
export declare class Validator {
    private strictMode;
    constructor(strictMode?: boolean);
    validateSpec(filePath: string): Promise<ValidationReport>;
    /**
     * Validate spec content from a string (used for pre-write validation of rebuilt specs)
     */
    validateSpecContent(specName: string, content: string): Promise<ValidationReport>;
    validateChange(filePath: string): Promise<ValidationReport>;
    /**
     * Validate delta-formatted spec files under a change directory.
     * Enforces:
     * - At least one delta across all files
     * - ADDED/MODIFIED: each requirement has at least one scenario; missing
     *   English SHALL/MUST keywords are guidance unless strict mode is enabled
     * - REMOVED: names only; no scenario/description required
     * - RENAMED: pairs well-formed
     * - No duplicates within sections; no cross-section conflicts per spec
     *
     * When `options.mainSpecsDir` is given, MODIFIED blocks are also checked
     * against the current main specs for scenario loss (#1477), and merge
     * conflicts are reported as INFO without changing the verdict (#1112).
     * When `options.projectRoot` is given, the schema's tracked task files are
     * checked for ambiguous numbering (#1520). Omitting either
     * option keeps existing library and archive callers behaving as before.
     */
    validateChangeDeltaSpecs(changeDir: string, options?: {
        mainSpecsDir?: string;
        projectRoot?: string;
    }): Promise<ValidationReport>;
    /**
     * Lints the change's task files.
     *
     * Two checks with deliberately different reach. Checkbox formatting is read
     * from whatever the change's own schema declares as its tracked task output,
     * because every schema's progress, apply and archive behavior is computed by
     * counting checkboxes in exactly those files. Numbering stays scoped to the
     * built-in `spec-driven` schema, whose template is the one that numbers tasks
     * in the first place.
     *
     * The checkbox check never falls back to a bare top-level `tasks.md`: a file
     * no artifact declares is not a tracked task list, and warning about its
     * formatting would be a guess about a file the tool does not read.
     */
    private collectTaskFileIssues;
    /**
     * Reads task files into change-relative documents, counting the ones that
     * exist but could not be read. A file that is simply absent is not counted:
     * the resolver only returns files it found, so the remaining read failures
     * are permissions and I/O, and a check that reasons over the whole set needs
     * to know its evidence was incomplete.
     */
    private readTaskDocuments;
    /**
     * Names a task file relative to its change, POSIX-separated.
     *
     * Both sides are canonicalized first. `resolveArtifactOutputs` hands back real
     * paths, while `changeDir` carries whatever spelling the caller resolved, and
     * the two can differ without being apart: on Windows a short 8.3 alias
     * (`RUNNER~1`) against its expanded form turned `tasks.md` into a
     * `../../../..`-prefixed absolute path in the report, and a symlinked project
     * directory does the same elsewhere. Canonicalizing recovers the real
     * relationship. The Windows CI job is the regression guard — the mismatch
     * cannot be staged on POSIX, where the spawned CLI's `process.cwd()` is
     * already physical.
     *
     * A path that still escapes would be a resolver bug rather than a spelling
     * difference, but the report must never leak an absolute filesystem path, so
     * the file name stands in.
     */
    private taskDocumentPath;
    /**
     * True when the change resolves to the package's own `spec-driven` schema. A
     * project schema that merely reuses the name is not it, so checks written
     * against the built-in template never fire on someone else's task format.
     */
    private usesBuiltInSpecDrivenSchema;
    /**
     * Report MODIFIED requirements whose block omits a scenario the main spec
     * still carries. Uses the same comparison archive applies, so validate can
     * only report what archive would refuse.
     *
     * Silent when the main spec or the requirement header is absent: applying a
     * MODIFIED against a base that is not there yet is a different failure (a
     * sister change still in flight is the legitimate case), and archive is the
     * gate for it. A spec that exists but cannot be read is not absent, though —
     * archive aborts on it, so reporting it beats calling the change valid.
     */
    private findScenarioLossIssues;
    private formatInvalidMarkerMessage;
    private convertZodErrors;
    private applySpecRules;
    private applyChangeRules;
    private enrichTopLevelError;
    private extractNameFromPath;
    /**
     * Dry-run archive's merge builder without writing its result. Reusing the
     * builder preserves its already-synced delta rules instead of duplicating them.
     * INFO leaves the verdict unchanged: a missing target can be a typo or a
     * requirement introduced by a sibling change that has not archived yet.
     * This does not run archive's later merged-spec validation or retirement checks.
     */
    private findArchiveBlockers;
    private createReport;
    isValid(report: ValidationReport): boolean;
    private extractRequirementText;
    private containsShallOrMust;
    /**
     * Build a message for a requirement block whose body lacks SHALL/MUST.
     *
     * When the SHALL/MUST keyword already appears in the requirement header (e.g.
     * `### Requirement: The system SHALL ...`) the original generic error
     * ("must contain SHALL or MUST") is confusing because the keyword is visibly
     * present in the spec. Per the OpenSpec conventions the keyword has to live
     * on the requirement body line (the line right after the header), so we point
     * the author at that exact fix when the keyword is found in the header only.
     */
    private buildMissingShallOrMustMessage;
    private countScenarios;
    /**
     * Why a requirement with a visible scenario header still has no scenario:
     * the header has no body, and the spec path archive validates against does
     * not count it. Empty when the block has no bare scenario header.
     */
    private emptyScenarioHint;
    private formatSectionList;
}
//# sourceMappingURL=validator.d.ts.map