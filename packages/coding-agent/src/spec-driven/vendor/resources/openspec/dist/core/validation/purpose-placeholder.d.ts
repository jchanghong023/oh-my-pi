/**
 * Detects a `## Purpose` that is still a placeholder, rather than one somebody
 * wrote.
 *
 * When a delta introduces a capability with no usable `## Purpose`, archive
 * stamps the placeholder into the new main spec. That text is over
 * `MIN_PURPOSE_LENGTH`, so the brevity check cannot reach it: the one rule that
 * exists to catch a Purpose nobody wrote is satisfied by the exact string
 * meaning nobody wrote one. Nothing else reads it afterwards, so the capability
 * keeps a to-do in it while every command reports success.
 *
 * Two things count, and deliberately nothing else:
 *
 * - the placeholder this tool generates, recognised through the same constants
 *   the writer composes it from, wherever it sits in the Purpose - nobody types
 *   that sentence by accident;
 * - a `TBD` or `TODO` **opening** the Purpose, which is the marker left behind
 *   when someone is told to leave "a brief TBD placeholder" and never comes
 *   back. Which of the two words got typed says nothing about whether the
 *   Purpose was written, so both are read the same way.
 *
 * A marker inside a sentence is left alone. "The retry budget is TBD pending
 * benchmarks" is a real Purpose with an open question in it, and reporting it
 * would teach people to ignore the warning - which costs more than the findings
 * it would add.
 *
 * Fenced code inside the Purpose is quoted material rather than the Purpose
 * speaking, so it is read out first. Without that, a Purpose documenting the
 * sentence archive writes is reported as being that sentence: a document about
 * the placeholder, failing for carrying one.
 */
export interface PurposePlaceholderIssue {
    /** 1-based line of the placeholder text, when it can be located. */
    line?: number;
}
/**
 * Reports the Purpose of a main spec as an unwritten placeholder, or null when
 * it reads as authored content.
 *
 * An empty Purpose is not reported here - `SPEC_PURPOSE_EMPTY` already covers
 * it, and reporting both would put two findings on one line. That falls out of
 * the two rules rather than needing a case of its own.
 */
export declare function findPurposePlaceholderIssue(overview: string, content?: string): PurposePlaceholderIssue | null;
//# sourceMappingURL=purpose-placeholder.d.ts.map