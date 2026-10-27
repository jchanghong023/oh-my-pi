import { type StoreDiagnostic } from './store/errors.js';
import { listStoreRegistryEntries } from './store/foundation.js';
import { type ResolvedOpenSpecRoot } from './root-selection.js';
import { type DeclarationEntry } from './project-config.js';
export interface ReferenceSpecEntry {
    id: string;
    summary: string;
}
export interface ReferenceIndexEntry {
    store_id: string;
    root?: string;
    specs?: ReferenceSpecEntry[];
    fetch?: string;
    status: StoreDiagnostic[];
}
/**
 * Tolerant first-Purpose-line extraction. parseSpec() throws on specs
 * without Purpose/Requirements sections; the index must never fail on an
 * imperfect upstream spec, so this scans for the heading directly —
 * fence-aware, so `## Purpose` inside a code block never matches, and
 * tolerant of CommonMark closing hashes (`## Purpose ##`).
 */
export declare function extractFirstPurposeLine(markdown: string): string;
export declare function fetchRecipe(storeId: string): string;
/**
 * Pure renderer for the artifact-instructions XML block. Also the byte
 * budget's measuring stick (it is the larger rendering).
 */
export declare function renderReferencedStoresBlock(entries: ReferenceIndexEntry[]): string;
/** Pure renderer for the apply-instructions markdown section. */
export declare function renderReferencedStoresSection(entries: ReferenceIndexEntry[]): string;
/**
 * Strings rendered into agent guidance can come from cloned content
 * (spec directory names, Purpose lines, config-declared remotes). One
 * line in, one line out: control characters and newlines must never
 * let hostile content forge instruction lines (slice 6.1 hardening).
 */
export declare function sanitizeInline(value: string, maxLength?: number): string;
/**
 * Neutralize the envelope's own tags - opening and closing - in repo-supplied
 * text, so it cannot close the block that frames it as data nor forge a new
 * block that carries authority.
 *
 * Deliberately narrow: only this fixed vocabulary is touched. Escaping every
 * angle bracket also works, but it mangles ordinary content for everyone.
 * OpenSpec's own spec-driven schema writes `### Requirement: <name>` and
 * `openspec show "<spec-id>"`; custom templates carry `<details>`; and
 * `context:` routinely holds `R&D`, `pnpm build && pnpm test` or
 * `Result<T, E>`. All of those would reach the agent entity-encoded - a real
 * cost paid by every user, against a threat only these tags can carry.
 */
export declare function escapeEnvelopeTags(value: string): string;
/**
 * Attribute values are ids and directory names, never prose, so escaping every
 * metacharacter here costs nothing and stops a quote from closing the
 * attribute and forging siblings on the tag.
 */
export declare function escapeEnvelopeAttribute(value: string): string;
export interface AssembleReferenceIndexInput {
    references: DeclarationEntry[];
    resolvedRoot: ResolvedOpenSpecRoot;
    globalDataDir?: string;
    /**
     * Health mode (3.6): false skips the spec-file reads AND the byte
     * budget — entries carry no `specs`/`fetch` keys at all, and the
     * content-only truncation diagnostic can never appear.
     */
    includeSpecs?: boolean;
    /**
     * Pre-read registry entries (3.6): `[]` = registry empty or absent,
     * `null` = unreadable, undefined = read internally as before.
     * (Mirrors the internal post-read variable — never inject a raw
     * read result: a healthy-absent registry reads as null.)
     */
    registryEntries?: ReturnType<typeof listStoreRegistryEntries> | null;
}
/**
 * Builds the referenced-store index. One registry read per call; one
 * level deep (a referenced store's own references are never followed);
 * self-references omitted; every failure degrades to a warning entry.
 */
export declare function assembleReferenceIndex(input: AssembleReferenceIndexInput): Promise<ReferenceIndexEntry[]>;
//# sourceMappingURL=references.d.ts.map