export interface RequirementBlock {
    headerLine: string;
    name: string;
    raw: string;
}
export interface RequirementsSectionParts {
    before: string;
    headerLine: string;
    preamble: string;
    bodyBlocks: RequirementBlock[];
    after: string;
}
export declare function normalizeRequirementName(name: string): string;
/**
 * Case- and whitespace-insensitive fold of a requirement name. Requirement
 * matching itself is case-sensitive (normalizeRequirementName); this fold
 * exists only for typo detection - near-miss REMOVED, ADDED and RENAMED
 * headers and the RENAMED+REMOVED cross-section conflict - where two spellings
 * that differ only in case or interior whitespace mean a mistake, never two
 * requirements.
 */
export declare function foldRequirementName(name: string): string;
/**
 * Extracts the Requirements section from a spec file and parses requirement blocks.
 */
export declare function extractRequirementsSection(content: string): RequirementsSectionParts;
/**
 * A level-3 header inside `## ADDED`/`## MODIFIED Requirements` that is not a
 * canonical `### Requirement:` header, recorded at the moment the delta reader
 * skips over it. Surfaced as an INFO note by `validate <change>` (#498).
 */
export interface SkippedHeader {
    header: string;
    section: string;
    line: number;
}
/**
 * A `FROM:` or `TO:` line in `## RENAMED Requirements` that never formed a pair,
 * recorded at the moment the reader steps over it.
 *
 * The pair reader used to carry one mutable `{ from, to }` and drop whatever did
 * not fit: a second `FROM:` overwrote an unpaired first, a `TO:` with no pending
 * `FROM:` vanished, and a trailing `FROM:` was forgotten at the end of the
 * section. Nothing counted any of it, so a rename the author asked for could
 * silently not happen - or, when the lines interleaved, a DIFFERENT requirement
 * could be renamed under a name meant for another one.
 *
 * Recording them is what lets `validate` report the problem and `buildUpdatedSpec`
 * refuse, rather than guess a pairing and rewrite the spec from it.
 */
export interface UnpairedRename {
    side: 'FROM' | 'TO';
    name: string;
    line: number;
}
/**
 * A canonical `### Requirement:` block that sits outside every delta section -
 * under `## Notes`, under a misspelled `## Add Requirements`, or above the
 * first `## ` header entirely.
 *
 * The delta reader only ever looks inside the four delta sections, so a block
 * written anywhere else was dropped with no error, no warning and no note -
 * even though it is well formed and reads exactly like one that would apply.
 * That was the inconsistency worth closing: the ADJACENT mistake, a
 * non-canonical `###` header INSIDE a delta section, has been reported as INFO
 * since #498 (`skippedHeaders`), while the costlier one said nothing at all.
 */
export interface OrphanedRequirement {
    name: string;
    section: string | null;
    line: number;
}
/**
 * Authored text archive does not carry into the main spec: a non-delta `## `
 * section, text above the first `## `, or prose before the first requirement
 * in ADDED/MODIFIED. `section` is null for text above the first `## `.
 */
export interface UnappliedContent {
    section: string | null;
    line: number;
}
export interface DeltaPlan {
    added: RequirementBlock[];
    modified: RequirementBlock[];
    removed: string[];
    removedBlocks: RequirementBlock[];
    renamed: Array<{
        from: string;
        to: string;
    }>;
    /** FROM:/TO: lines in RENAMED that never formed a pair. */
    unpairedRenames: UnpairedRename[];
    /** Canonical requirement blocks written outside every delta section. */
    orphanedRequirements: OrphanedRequirement[];
    unappliedContent: UnappliedContent[];
    skippedHeaders: SkippedHeader[];
    sectionPresence: {
        added: boolean;
        modified: boolean;
        removed: boolean;
        renamed: boolean;
    };
}
/**
 * Parse a delta-formatted spec change file content into a DeltaPlan with raw blocks.
 */
export declare function parseDeltaSpec(content: string): DeltaPlan;
export declare function describeUnappliedContent(content: UnappliedContent, sentenceStart?: boolean): string;
/** Both directions of the scenario-name comparison, plus the two totals. */
export interface ScenarioNameDiff {
    /** Names the current block has that the incoming block does not cover. */
    missing: string[];
    /** Names the incoming block introduces that the current block does not have. */
    added: string[];
    /** Level-4 headers in the current block. */
    currentCount: number;
    /** Level-4 headers in the incoming block. */
    incomingCount: number;
}
/**
 * Compare the scenario names of a current requirement block and an incoming
 * (MODIFIED) one, in both directions.
 *
 * `missing` is the loss the guard exists to catch: a MODIFIED requirement
 * replaces the whole block, so every name there would be dropped from the main
 * spec. `added` and the two counts are reported alongside it, because they are
 * the first thing a reader checks once it fires (#1697) - a block that omits
 * two names and introduces two is shaped like a rename, one that omits two and
 * introduces none is shaped like a truncation. Neither is proof, and intent is
 * not recoverable from structure, so this decides nothing and only says what
 * the two blocks contain.
 */
export declare function diffScenarioNames(current: RequirementBlock, incoming: RequirementBlock): ScenarioNameDiff;
/**
 * Scenario names the current requirement block has and the incoming
 * (MODIFIED) block does not. A MODIFIED requirement replaces the whole block,
 * so every name reported here would be dropped from the main spec.
 *
 * The `missing` half of diffScenarioNames, which archive (refusing to apply
 * the block) and validate (reporting the same loss at authoring time, #1477)
 * both go through, so the two cannot disagree about what counts as a dropped
 * scenario.
 */
export declare function findMissingCurrentScenarios(current: RequirementBlock, incoming: RequirementBlock): string[];
/**
 * The one sentence archive and validate both append when the guard fires, so
 * the counts a reader sees cannot differ between the two commands.
 */
export declare function describeScenarioBalance(diff: ScenarioNameDiff): string;
/**
 * scenarioNameAt for header text whose leading `####` is already gone, as the
 * section parser (MarkdownParser) holds it, so `show --json` names a scenario
 * exactly as the MODIFIED loss check does.
 */
export declare function scenarioNameFromHeaderText(headerText: string): string;
//# sourceMappingURL=requirement-blocks.d.ts.map