/**
 * Shared, fence-aware requirement-reading helpers.
 *
 * The requirement reader used to be implemented twice — once for main specs
 * (`MarkdownParser.parseRequirements`) and once for change deltas
 * (`Validator.extractRequirementText` / `countScenarios`) — and the two drifted
 * apart. These helpers are the single source of truth for requirement-body
 * extraction, scenario counting, and `SHALL`/`MUST` detection in
 * `validate <change>`, `validate <spec>`, and `archive`.
 */
export { buildCodeFenceMask } from './code-fence.js';
/**
 * A level-4 header. Deliberately matches ANY `####` header, not only
 * `#### Scenario:` — the spec path treats every level-4 child of a requirement
 * as a scenario, so the delta counter must too (parity). The delta/loss path
 * reuses this exact constant via `scenarioHeaderAt` in requirement-blocks.ts;
 * keep both paths on it rather than reintroducing a separate `Scenario:` regex.
 * A header alone is not yet a scenario on either path: see hasScenarioBody.
 */
export declare const SCENARIO_HEADER: RegExp;
/**
 * Whether a scenario's body has content. The spec path
 * (`MarkdownParser.parseScenarios`) drops a scenario whose body is empty, so
 * the delta counter must too (parity): otherwise `validate` accepts a
 * requirement whose only scenario is a bare header, and archive rejects it when
 * it validates the rebuilt spec.
 */
export declare function hasScenarioBody(body: string): boolean;
/**
 * The one predicate for normative-keyword detection. Matches `SHALL` or `MUST`
 * as whole words so the change-delta reader and the schema-based reader accept
 * and reject identical text.
 */
export declare function containsShallOrMust(text: string): boolean;
/**
 * Extract the full requirement body from the lines that follow a
 * `### Requirement:` header (the lines may include scenarios and fenced code).
 *
 * Captures every body line from the start up to the first header found on a
 * non-fenced line — usually the first `#### Scenario:`, but also a stray `###`
 * divider the delta reader absorbed into the block — skipping blank lines and
 * any line inside a fenced code block. `**metadata**:` lines are skipped only
 * when other body text remains: a requirement written entirely as
 * `**Constraint**: The system MUST ...` keeps that line as its body. Captured
 * lines are trimmed and joined with newlines so a requirement whose text wraps
 * across lines — or whose `SHALL`/`MUST` lands on a later line — is read in
 * full.
 */
export declare function extractRequirementBody(bodyLines: string[]): string;
/**
 * Parser/display fallback for a requirement block with no body text. This is
 * what lets a bare `### The system SHALL ...` header remain readable on the
 * spec path (the title is the requirement). Validator body-keyword checks for
 * canonical `### Requirement:` blocks use `extractRequirementBody` directly so
 * a keyword that appears only in the header still receives the #1156/#1280
 * body-keyword hint.
 */
export declare function extractRequirementText(headerTitle: string, bodyLines: string[]): string;
/**
 * Count the real scenarios in a requirement block: `#### ` headers on non-fenced
 * lines whose body has content. A `#### Scenario:` that lives inside a fenced
 * example is not a real scenario and is not counted.
 */
export declare function countScenarios(bodyLines: string[]): number;
/** Count the `#### ` headers in a requirement block that have no body under them. */
export declare function countEmptyScenarios(bodyLines: string[]): number;
//# sourceMappingURL=requirement-text.d.ts.map