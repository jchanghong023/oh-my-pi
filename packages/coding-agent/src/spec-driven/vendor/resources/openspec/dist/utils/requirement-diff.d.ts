/** A main-spec requirement block, and how its header matched the delta's. */
export interface MatchedRequirementBlock {
    raw: string;
    /** The header name as the main spec spells it. */
    name: string;
    /**
     * False when the two headers differ only in case or interior spacing. Archive
     * matches names exactly, so an inexact match is a real problem to report even
     * though the diff below it is still the one the author meant.
     */
    exact: boolean;
}
/**
 * Find the raw markdown block for a requirement by name in a spec file.
 *
 * Delegates to extractRequirementsSection() which already handles code fences,
 * section boundaries, and requirement header parsing. We just look up by name:
 * exactly first, then falling back to the shared case/whitespace fold so a
 * header that differs only in spelling still shows its diff, flagged inexact.
 *
 * Returns null if no requirement header matches either way.
 */
export declare function extractRequirementBlock(specContent: string, requirementName: string): MatchedRequirementBlock | null;
/**
 * Compute a unified diff between a main-spec requirement block and the delta
 * block that replaces it. A null main block (new capability) diffs against the
 * empty string, so every line reads as an addition.
 *
 * Uses structuredPatch to retain unified-diff hunk ranges while omitting the
 * synthetic file headers, since the caller provides its own labeling.
 */
export declare function diffRequirementBlock(baseBlock: string | null, deltaBlock: string, label: string): string;
/**
 * Build a map from folded RENAMED TO name to the original main-spec name.
 * Renames apply in source order, so a chain such as A -> B -> C maps C back to
 * A. That is the block a later MODIFIED C replaces.
 */
export declare function buildRenameMap(renames: Array<{
    from: string;
    to: string;
}>): Map<string, string>;
//# sourceMappingURL=requirement-diff.d.ts.map