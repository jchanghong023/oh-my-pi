/**
 * Spec Application Logic
 *
 * Extracted from ArchiveCommand to enable standalone spec application.
 * Applies delta specs from a change to main specs without archiving.
 */
export interface SpecUpdate {
    /** Capability id relative to the specs root, forward-slash separated (e.g. "web" or "platform/session-layout"). */
    id: string;
    /** Allowed root for the delta source. */
    sourceRoot: string;
    source: string;
    /** Allowed root for the main-spec target. */
    targetRoot: string;
    target: string;
    exists: boolean;
}
/**
 * Find all delta spec files that need to be applied from a change.
 */
export declare function findSpecUpdates(changeDir: string, mainSpecsDir: string): Promise<SpecUpdate[]>;
/**
 * Build an updated spec by applying delta operations.
 * Returns the rebuilt content and counts of operations.
 */
export declare function buildUpdatedSpec(update: SpecUpdate, changeName: string, options?: {
    silent?: boolean;
}): Promise<{
    rebuilt: string;
    counts: {
        added: number;
        modified: number;
        removed: number;
        renamed: number;
    };
    warnings: string[];
    /**
     * Every canonical `### Requirement:` block the delta could act on is gone.
     * This is only a *candidate* signal for retirement (#1302): the validator, not
     * this count, decides whether `rebuilt` is actually unwritable - it recognises
     * requirement shapes this parser sweeps into the preamble, so a spec can be
     * blockless here and still validate. See `isRetirableSpec` in archive.ts.
     */
    noRequirementBlocks: boolean;
    /**
     * Every non-blank line of the spec this merge cannot name.
     *
     * Retirement deletes the whole file, so the only safe question is whether the
     * merge can account for all of it. `extractRequirementsSection` splits a spec
     * into five slices, and auditing a subset is how this guard kept failing: for
     * seven rounds it looked for requirement-SHAPED text and was beaten by a new
     * disguise each time, and when it started asking where content landed it
     * still read only the preamble and the tail - so content simply moved into a
     * slice nobody checked, and authored prose sitting inside a removed block's
     * raw was deleted while the report said only "Purpose" was lost.
     *
     * So this accounts for the whole file: the title, the `## Purpose` section,
     * the `## Requirements` header, and, inside each requirement block, the parts
     * that make up a requirement - its header, its statement, and its scenarios'
     * bullets. Every other non-blank line is reported and refuses the retirement.
     *
     * Fails safe in every direction: a line this cannot classify counts as
     * unaccounted, which refuses rather than deletes.
     */
    unaccountedContent: string[];
}>;
/**
 * Retire a capability whose last requirement a delta removed: delete its main
 * spec and prune any directories the deletion leaves empty. Returns false when
 * there was nothing to delete.
 *
 * Gated by the caller on the change's `retire_capabilities` marker, so the one
 * archive action that removes a file from `openspec/specs/` is always something
 * the author asked for rather than something inferred from a delta's shape. The
 * file is recoverable from git, which the report names; applying REMOVED already
 * deletes requirement content from a main spec, so deleting the spec once
 * nothing is left is the same operation carried to its end rather than a new
 * kind of act.
 *
 * Only the generated `spec.md` is removed - a directory holding anything else (a
 * nested capability, a hand-kept note) is left in place.
 *
 * The target must resolve inside the selected specs root. A capability-directory
 * symlink must not turn a retirement marker into authorization to delete an
 * unrelated external file. A symlinked `spec.md` itself is safe: unlink removes
 * the link and leaves its target alone.
 *
 * Directory pruning IS bounded, by REAL paths rather than string prefixes:
 * `path.resolve` collapses `..` but does not resolve symlinks, and `readdir` and
 * `rmdir` both follow them, so a symlinked capability directory would otherwise
 * let the walk delete directories outside the specs root entirely.
 */
export declare function retireSpec(update: SpecUpdate, mainSpecsDir: string, options?: {
    silent?: boolean;
    displayPath?: string;
    beforeMutate?: () => Promise<void>;
    verifyDisplaced?: (displacedPath: string) => Promise<void>;
    deferDelete?: boolean;
}): Promise<{
    retired: boolean;
    resolvedPath?: string;
    displacedPath?: string;
}>;
export declare function finalizeRetiredSpec(target: string, displacedPath: string, mainSpecsDir: string): Promise<void>;
/**
 * Remove now-empty directories from `startDir` upward, never leaving the real
 * `boundaryDir` and never removing that directory itself.
 *
 * The boundary is a parameter rather than the specs root directly so the walk's
 * containment is stated at the call site, where the root it must not escape is
 * the thing being reasoned about.
 *
 * The guard re-runs every iteration, so stepping to the LEXICAL parent is safe:
 * a parent that is not the real one is simply re-resolved and rejected. Errors
 * are swallowed and end the walk - ENOTEMPTY and ENOENT are correct outcomes (a
 * file arriving mid-walk must win), and a permissions failure leaves an empty
 * directory behind, which the next successful archive clears.
 *
 * Not race-free: an attacker who can swap an ancestor between the check and the
 * `rmdir` could get an empty directory outside the root removed. Closing that
 * needs fd-relative syscalls Node does not expose, and it requires local write
 * access to `openspec/specs` during an archive.
 */
export declare function pruneEmptyDirs(startDir: string, boundaryDir: string): Promise<void>;
/**
 * Write an updated spec to disk.
 */
export declare function writeUpdatedSpec(update: SpecUpdate, rebuilt: string, counts: {
    added: number;
    modified: number;
    removed: number;
    renamed: number;
}, options?: {
    silent?: boolean;
    displayPath?: string;
    beforeMutate?: () => Promise<void>;
}): Promise<void>;
/**
 * Build a skeleton spec for new capabilities. When the delta spec authored a
 * `## Purpose`, carry it over instead of the TBD placeholder (#1413) - archive
 * invents the Purpose for a brand-new main spec either way, and the author's
 * own wording beats a placeholder they then have to hand-edit.
 */
export declare function buildSpecSkeleton(specFolderName: string, changeName: string, purpose?: string): string;
//# sourceMappingURL=specs-apply.d.ts.map