/**
 * Shared fenced-code-block detection for the Markdown parsers.
 *
 * Several parsers need to ignore Markdown structure (headers, requirement
 * blocks, scenarios, delta sections) that appears inside fenced code blocks.
 * Keeping this logic in one place avoids the drift that previously left
 * `requirement-blocks.ts` treating fenced `### Requirement:` lines as real
 * requirements during validation and archiving.
 */
/**
 * Builds a per-line mask where `true` marks a line that is part of a fenced
 * code block (including the opening and closing fence lines themselves).
 */
export declare function buildCodeFenceMask(lines: string[]): boolean[];
//# sourceMappingURL=code-fence.d.ts.map