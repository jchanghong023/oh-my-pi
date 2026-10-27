import { MarkdownParser, Section } from './markdown-parser.js';
import { Change, Requirement } from '../schemas/index.js';
export declare class ChangeParser extends MarkdownParser {
    private changeDir;
    constructor(content: string, changeDir: string);
    parseChangeWithDeltas(name: string): Promise<Change>;
    private parseDeltaSpecs;
    /**
     * Read requirements from a delta section, ignoring headers that are not
     * `### Requirement: <name>`.
     *
     * A delta section often carries divider headers such as
     * `### Documentation Requirements`. The base parser treats every child header
     * as a requirement, which invented a scenario-less requirement that does not
     * exist (#498): archive warned about a missing scenario, and `show --json`
     * reported an extra delta. The delta reader already skips these headers and
     * notes them, so this keeps the two readers in agreement.
     *
     * Overriding here rather than in MarkdownParser keeps main spec parsing —
     * `view`, `list`, `spec --json`, spec validation — untouched.
     */
    protected parseRequirements(section: Section): Requirement[];
    /**
     * The deltas in one spec file, read by parseDeltaSpec — the reader archive
     * applies — so what `show` reports is what archive will do. This used to be a
     * second reader that disagreed with it: a bullet-form REMOVED was invisible,
     * a repeated section header was read only once, and a RENAMED line written
     * with `*` or `+` was dropped.
     */
    private parseSpecDeltas;
    /**
     * One Requirement per block, read by the same section parser (and the
     * header filter above) as before, so text and scenarios are unchanged.
     */
    private toRequirements;
    private parseSectionsFromContent;
    private getContentUntilNextHeaderFromLines;
}
//# sourceMappingURL=change-parser.d.ts.map