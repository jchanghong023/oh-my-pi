/**
 * Tool Detection Utilities
 *
 * Shared utilities for detecting tool configurations and version status.
 */
import { type Delivery } from '../global-config.js';
import { type FileView } from '../file-view.js';
/**
 * Names of skill directories created by openspec init.
 */
export declare const SKILL_NAMES: readonly ["openspec-explore", "openspec-new-change", "openspec-continue-change", "openspec-apply-change", "openspec-update-change", "openspec-ff-change", "openspec-sync-specs", "openspec-archive-change", "openspec-bulk-archive-change", "openspec-verify-change", "openspec-onboard", "openspec-propose"];
export type SkillName = (typeof SKILL_NAMES)[number];
/**
 * IDs of command templates created by openspec init.
 */
export declare const COMMAND_IDS: readonly ["explore", "new", "continue", "apply", "update", "ff", "sync", "archive", "bulk-archive", "verify", "onboard", "propose"];
export type CommandId = (typeof COMMAND_IDS)[number];
/**
 * Status of skill configuration for a tool.
 */
export interface ToolSkillStatus {
    /** Whether the tool has any skills configured */
    configured: boolean;
    /** Whether all skills are configured */
    fullyConfigured: boolean;
    /** Number of skills currently configured */
    skillCount: number;
}
/**
 * Version information for a tool's skills.
 */
export interface ToolVersionStatus {
    /** The tool ID */
    toolId: string;
    /** The tool's display name */
    toolName: string;
    /** Whether the tool has any skills or commands configured */
    configured: boolean;
    /**
     * The generatedBy version recorded in the tool's skill files. For a tool that
     * has commands but no skills, the current version when the command files match
     * what would be generated now. Null when neither says the files are current.
     */
    generatedByVersion: string | null;
    /** Whether the tool needs updating (version mismatch or missing) */
    needsUpdate: boolean;
}
/**
 * Gets the list of tools with skillsDir configured.
 */
export declare function getToolsWithSkillsDir(): string[];
/**
 * Checks which skill files exist for a tool.
 */
export declare function getToolSkillStatus(projectRoot: string, toolId: string, view?: FileView): ToolSkillStatus;
/**
 * Checks whether a tool has at least one generated OpenSpec command file.
 */
export declare function toolHasAnyConfiguredCommand(projectPath: string, toolId: string, view?: FileView): boolean;
/**
 * Checks whether command files for a tool on disk match current generated command contents.
 *
 * Command files carry no version stamp, so content equality is the only available
 * "is this current?" signal for a commands-only install.
 */
export declare function areCommandFilesUpToDate(projectRoot: string, toolId: string, options?: {
    workflows?: readonly string[];
    /** The tree to read; the disk unless an update is planning. */
    view?: FileView;
}): boolean;
/**
 * Gets the skill status for all tools with skillsDir configured.
 */
export declare function getToolStates(projectRoot: string): Map<string, ToolSkillStatus>;
/**
 * Extracts the generatedBy version from a skill file's YAML frontmatter.
 * Returns null if the field is not found or the file doesn't exist.
 */
export declare function extractGeneratedByVersion(skillFilePath: string, view?: FileView): string | null;
/**
 * Gets version status for a tool by reading its skill files, falling back to a
 * command-content fingerprint for installs that have commands but no skills.
 */
export declare function getToolVersionStatus(projectRoot: string, toolId: string, currentVersion: string, options?: {
    workflows?: readonly string[];
    /** The tree to read; the disk unless an update is planning. */
    view?: FileView;
    /** Effective delivery; read from the global config when omitted. */
    delivery?: Delivery;
}): ToolVersionStatus;
/**
 * Gets all configured tools in the project (configured via skills or commands).
 */
export declare function getConfiguredTools(projectRoot: string, view?: FileView): string[];
/**
 * Gets version status for all configured tools.
 */
export declare function getAllToolVersionStatus(projectRoot: string, currentVersion: string): ToolVersionStatus[];
//# sourceMappingURL=tool-detection.d.ts.map