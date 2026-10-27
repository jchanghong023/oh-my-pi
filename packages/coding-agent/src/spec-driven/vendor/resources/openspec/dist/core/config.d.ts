export declare const OPENSPEC_DIR_NAME = "openspec";
export declare const OPENSPEC_SKILL_NAMES: readonly ["openspec-explore", "openspec-new-change", "openspec-continue-change", "openspec-apply-change", "openspec-update-change", "openspec-ff-change", "openspec-sync-specs", "openspec-archive-change", "openspec-bulk-archive-change", "openspec-verify-change", "openspec-onboard", "openspec-propose"];
export declare const OPENSPEC_MARKERS: {
    start: string;
    end: string;
};
export interface OpenSpecConfig {
    aiTools: string[];
}
export interface AIToolOption {
    name: string;
    value: string;
    available: boolean;
    successLabel?: string;
    skillsDir?: string;
    legacySkillsDirs?: string[];
    globalSkillsDir?: string;
    detectionPaths?: string[];
    searchAliases?: string[];
    setupNote?: string;
    requiresIdeRestart?: boolean;
}
export declare const AI_TOOLS: AIToolOption[];
/**
 * The vendor-neutral target every assistant that is not listed above can use.
 * Named wherever a tool lookup comes up empty, so "my tool isn't here" is never
 * a dead end (#653).
 */
export declare const UNIVERSAL_TOOL_ID = "agents";
/** The universal target's entry, or undefined if it was removed from AI_TOOLS. */
export declare function getUniversalTool(): AIToolOption | undefined;
/**
 * One-line pointer at the universal target for non-interactive errors, the
 * scripted counterpart of the picker's empty-search hint. Undefined when the
 * target is not among the tools on offer, so the hint never names a choice the
 * caller cannot make.
 */
export declare function universalToolFallbackHint(offeredToolIds: string[]): string | undefined;
/**
 * Retired tool ids that still resolve, so a rebrand does not break scripted
 * `--tools` invocations. Windsurf was rebranded to Devin Desktop on
 * 2026-06-02 and its config directory moved from `.windsurf/` to `.devin/`;
 * `--tools windsurf` therefore configures `devin`.
 */
export declare const TOOL_ID_ALIASES: Record<string, string>;
/**
 * Resolves a tool id through TOOL_ID_ALIASES, leaving current ids untouched.
 */
export declare function resolveToolIdAlias(toolId: string): string;
//# sourceMappingURL=config.d.ts.map