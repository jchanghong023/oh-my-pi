import { formatPatch, OMIT_HEADERS, structuredPatch } from 'diff';
import { extractRequirementsSection, foldRequirementName, normalizeRequirementName, } from '../core/parsers/requirement-blocks.js';
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
export function extractRequirementBlock(specContent, requirementName) {
    const parts = extractRequirementsSection(specContent);
    const targetName = normalizeRequirementName(requirementName);
    const foldedTarget = foldRequirementName(targetName);
    let folded = null;
    for (const block of parts.bodyBlocks) {
        const name = normalizeRequirementName(block.name);
        if (name === targetName) {
            return { raw: block.raw, name, exact: true };
        }
        if (!folded && foldRequirementName(name) === foldedTarget) {
            folded = { raw: block.raw, name, exact: false };
        }
    }
    return folded;
}
/**
 * Compute a unified diff between a main-spec requirement block and the delta
 * block that replaces it. A null main block (new capability) diffs against the
 * empty string, so every line reads as an addition.
 *
 * Uses structuredPatch to retain unified-diff hunk ranges while omitting the
 * synthetic file headers, since the caller provides its own labeling.
 */
export function diffRequirementBlock(baseBlock, deltaBlock, label) {
    const base = ensureTrailingNewline(baseBlock ?? '');
    const delta = ensureTrailingNewline(deltaBlock);
    const patch = structuredPatch(label, label, base, delta);
    return formatPatch(patch, OMIT_HEADERS).trimEnd();
}
function ensureTrailingNewline(s) {
    return s.endsWith('\n') ? s : s + '\n';
}
/**
 * Build a map from folded RENAMED TO name to the original main-spec name.
 * Renames apply in source order, so a chain such as A -> B -> C maps C back to
 * A. That is the block a later MODIFIED C replaces.
 */
export function buildRenameMap(renames) {
    const map = new Map();
    for (const r of renames) {
        const from = foldRequirementName(r.from);
        const original = map.get(from) ?? normalizeRequirementName(r.from);
        map.delete(from);
        map.set(foldRequirementName(r.to), original);
    }
    return map;
}
//# sourceMappingURL=requirement-diff.js.map