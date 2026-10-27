import { GlobalConfig } from '../core/global-config.js';
import type { Profile, Delivery } from '../core/global-config.js';
/**
 * Splits an EDITOR or VISUAL value into a program and its arguments without
 * running a shell, so `;`, `|`, `$VAR`, `~` and backticks are plain characters.
 * Double quotes group words. On POSIX, single quotes group words too and a
 * backslash escapes the next character (inside double quotes only `"` and `\`).
 * On Windows a backslash is a path separator and a single quote is a plain
 * character. Returns null when a quote is left open.
 */
export declare function splitEditorCommand(value: string, platform?: NodeJS.Platform): string[] | null;
interface ProfileState {
    profile: Profile;
    delivery: Delivery;
    workflows: string[];
}
interface ProfileStateDiff {
    hasChanges: boolean;
    lines: string[];
}
interface WorkflowPromptMeta {
    name: string;
    description: string;
}
export declare const WORKFLOW_PROMPT_META: Record<string, WorkflowPromptMeta>;
/**
 * Resolve the effective current profile state from global config defaults.
 */
export declare function resolveCurrentProfileState(config: GlobalConfig): ProfileState;
/**
 * Derive profile type from selected workflows.
 */
export declare function deriveProfileFromWorkflowSelection(selectedWorkflows: string[]): Profile;
/**
 * Format a compact workflow summary for the profile header.
 */
export declare function formatWorkflowSummary(workflows: readonly string[], profile: Profile): string;
/**
 * Build a user-facing diff summary between two profile states.
 */
export declare function diffProfileState(before: ProfileState, after: ProfileState): ProfileStateDiff;
export declare function configPathCommand(): void;
export declare function configListCommand(options: {
    json?: boolean;
}): void;
export declare function configGetCommand(key: string): void;
export declare function configSetCommand(key: string, value: string, options: {
    string?: boolean;
    allowUnknown?: boolean;
}): void;
export declare function configUnsetCommand(key: string): void;
export declare function configResetCommand(options: {
    all?: boolean;
    yes?: boolean;
}): Promise<void>;
export declare function configEditCommand(): Promise<void>;
export declare function configProfileCommand(preset?: string): Promise<void>;
export {};
//# sourceMappingURL=config.d.ts.map