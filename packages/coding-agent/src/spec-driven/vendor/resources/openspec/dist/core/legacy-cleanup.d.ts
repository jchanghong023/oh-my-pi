/**
 * Legacy cleanup module for detecting and removing OpenSpec artifacts
 * from previous init versions during the migration to the skill-based workflow.
 */
import { type WorkflowId } from './profiles.js';
/**
 * Legacy config file names from the old ToolRegistry.
 * These were config files created at project root with OpenSpec markers.
 */
export declare const LEGACY_CONFIG_FILES: readonly ["CLAUDE.md", "CLINE.md", "CODEBUDDY.md", "COSTRICT.md", "QODER.md", "IFLOW.md", "AGENTS.md", "QWEN.md"];
/**
 * Legacy slash command patterns from the old SlashCommandRegistry.
 * These map toolId to the path pattern where legacy commands were created.
 * Some tools used a directory structure, others used individual files.
 */
export declare const LEGACY_SLASH_COMMAND_PATHS: Record<string, LegacySlashCommandPattern>;
/**
 * Global legacy prompt locations that live outside the project tree and require
 * allowlisted matching instead of broad glob-based cleanup.
 */
export declare const LEGACY_GLOBAL_SLASH_COMMAND_PATHS: Record<string, LegacyGlobalPromptPattern>;
/**
 * Pattern types for legacy slash commands
 */
export interface LegacySlashCommandPattern {
    type: 'directory' | 'files';
    path?: string;
    /** For directory type: the only files in `path` that OpenSpec wrote. */
    managedFileNames?: readonly string[];
    pattern?: string | string[];
}
/**
 * Describes a managed global prompt home and the exact filenames OpenSpec is
 * allowed to treat as legacy artifacts there.
 */
export interface LegacyGlobalPromptPattern {
    managedFileNames: readonly string[];
    workflowIdsByFileName?: Readonly<Record<string, readonly WorkflowId[]>>;
    resolvePromptDir: () => string;
    replacementLabel?: string;
}
/**
 * Workflow-aware metadata for a detected global legacy prompt that is safe for
 * replacement-gated cleanup.
 */
export interface LegacyGlobalPromptMatch {
    path: string;
    toolId: string;
    managedFileName: string;
    workflowIds: readonly WorkflowId[];
    replacementLabel?: string;
}
export declare function getCodexPromptDir(): string;
/**
 * Result of legacy artifact detection
 */
export interface LegacyDetectionResult {
    /** Config files with OpenSpec markers detected */
    configFiles: string[];
    /** Config files to update (remove markers only, never delete) */
    configFilesToUpdate: string[];
    /** Legacy slash command directories found */
    slashCommandDirs: string[];
    /** Legacy slash command files found (for file-based tools) */
    slashCommandFiles: string[];
    /** Managed global command/prompt files found outside the project root */
    globalSlashCommandFiles: string[];
    /** Details for managed global command/prompt files */
    globalSlashCommandDetails?: LegacyGlobalPromptMatch[];
    /** Whether openspec/AGENTS.md exists */
    hasOpenspecAgents: boolean;
    /** Whether openspec/project.md exists (preserved, migration hint only) */
    hasProjectMd: boolean;
    /** Whether root AGENTS.md has OpenSpec markers */
    hasRootAgentsWithMarkers: boolean;
    /** Whether any legacy artifacts were found */
    hasLegacyArtifacts: boolean;
}
/**
 * Detects all legacy OpenSpec artifacts in a project.
 *
 * @param projectPath - The root path of the project
 * @returns Detection result with all found legacy artifacts
 */
export declare function detectLegacyArtifacts(projectPath: string): Promise<LegacyDetectionResult>;
/**
 * Detects legacy config files with OpenSpec markers.
 * All config files with markers are candidates for update (marker removal only).
 * Config files are NEVER deleted - they belong to the user's project root.
 *
 * @param projectPath - The root path of the project
 * @returns Object with all files found and files to update
 */
export declare function detectLegacyConfigFiles(projectPath: string): Promise<{
    allFiles: string[];
    filesToUpdate: string[];
}>;
/**
 * Detects legacy slash command directories and files.
 *
 * @param projectPath - The root path of the project
 * @returns Object with directories and individual files found
 */
export declare function detectLegacySlashCommands(projectPath: string): Promise<{
    directories: string[];
    files: string[];
}>;
/**
 * Detects legacy OpenSpec structure files (AGENTS.md and project.md).
 *
 * @param projectPath - The root path of the project
 * @returns Object with detection results for structure files
 */
export declare function detectLegacyStructureFiles(projectPath: string): Promise<{
    hasOpenspecAgents: boolean;
    hasProjectMd: boolean;
    hasRootAgentsWithMarkers: boolean;
}>;
/**
 * Checks if content contains OpenSpec markers.
 *
 * @param content - File content to check
 * @returns True if both start and end markers are present
 */
export declare function hasOpenSpecMarkers(content: string): boolean;
/**
 * Checks if file content is 100% OpenSpec content (only markers and whitespace outside).
 *
 * @param content - File content to check
 * @returns True if content outside markers is only whitespace
 */
export declare function isOnlyOpenSpecContent(content: string): boolean;
/**
 * Removes the OpenSpec marker block from file content.
 * Only removes markers that are on their own lines (ignores inline mentions).
 * Cleans up double blank lines that may result from removal.
 *
 * @param content - File content with OpenSpec markers
 * @returns Content with marker block removed
 */
export declare function removeMarkerBlock(content: string): string;
/**
 * Result of cleanup operation
 */
export interface CleanupResult {
    /** Files that were deleted entirely */
    deletedFiles: string[];
    /** Replacement labels for deleted files when cleanup knows the new surface */
    deletedFileReplacementLabels?: Record<string, string>;
    /** Files that had marker blocks removed */
    modifiedFiles: string[];
    /** Directories that were deleted */
    deletedDirs: string[];
    /** Entries left in a legacy command directory because OpenSpec did not write them */
    keptFiles?: string[];
    /** Whether project.md exists and needs manual migration */
    projectMdNeedsMigration: boolean;
    /** Error messages if any operations failed */
    errors: string[];
}
/**
 * Cleans up legacy OpenSpec artifacts from a project.
 * Preserves openspec/project.md (shows migration hint instead of deleting).
 *
 * @param projectPath - The root path of the project
 * @param detection - Detection result from detectLegacyArtifacts
 * @returns Cleanup result with summary of actions taken
 */
/**
 * Every change cleanup makes on disk. `update --dry-run` passes a recorder, so
 * the plan comes from this same code rather than a description of it.
 */
export interface LegacyCleanupOps {
    writeFile(filePath: string, content: string): Promise<void>;
    removeFile(filePath: string): Promise<void>;
    /** Removes a directory already known to be empty. */
    removeEmptyDirectory(dirPath: string): Promise<void>;
}
export declare function cleanupLegacyArtifacts(projectPath: string, detection: LegacyDetectionResult, ops?: LegacyCleanupOps): Promise<CleanupResult>;
/**
 * Generates a cleanup summary message for display.
 *
 * @param result - Cleanup result from cleanupLegacyArtifacts
 * @returns Formatted summary string for console output
 */
export declare function formatCleanupSummary(result: CleanupResult): string;
/**
 * Generates a detection summary message for display before cleanup.
 * Groups files by action type: removals, updates, and manual migration.
 *
 * @param detection - Detection result from detectLegacyArtifacts
 * @returns Formatted summary string showing what was found
 */
export declare function formatDetectionSummary(detection: LegacyDetectionResult): string;
/**
 * Generates a summary for managed global prompt files whose cleanup must wait
 * until replacement skills are installed.
 */
export declare function formatDeferredGlobalPromptSummary(detection: LegacyDetectionResult): string;
/**
 * Extract tool IDs from detected legacy artifacts.
 * Uses LEGACY_SLASH_COMMAND_PATHS to map paths back to tool IDs.
 *
 * @param detection - Detection result from detectLegacyArtifacts
 * @returns Array of tool IDs that had legacy artifacts
 */
export declare function getToolsFromLegacyArtifacts(detection: LegacyDetectionResult): string[];
/**
 * Normalizes global Codex prompt matches so callers can rely on workflow-aware
 * metadata even when older detection results only carry file paths.
 */
export declare function getLegacyGlobalPromptMatches(detection: LegacyDetectionResult): LegacyGlobalPromptMatch[];
/**
 * Collects workflow IDs inferred from detected legacy global prompts for a
 * specific tool.
 */
export declare function getLegacyWorkflowIdsForTool(detection: LegacyDetectionResult, toolId: string): WorkflowId[];
/**
 * Returns a detection snapshot with global Codex prompt cleanup removed so
 * callers can safely perform the immediate, non-deferred cleanup pass.
 */
export declare function omitGlobalLegacyPromptFiles(detection: LegacyDetectionResult): LegacyDetectionResult;
/**
 * Returns a detection snapshot with the repo-local slash-command artifacts of
 * the given tools removed. The legacy-upgrade path uses this to skip cleaning a
 * tool's legacy files when its replacement was deliberately NOT written — e.g. a
 * Codex upgrade suppressed because the shared `.agents` root is already owned by
 * another tool. Deleting the legacy prompt without writing its replacement would
 * violate the cleanup contract ("remove X because replacement Y now exists") and
 * strip the tool's only OpenSpec integration.
 */
export declare function omitToolLegacyArtifacts(detection: LegacyDetectionResult, toolIds: readonly string[]): LegacyDetectionResult;
/**
 * Builds a detection snapshot containing only the selected global Codex prompt
 * matches for replacement-gated cleanup.
 */
export declare function pickGlobalLegacyPromptFiles(detection: LegacyDetectionResult, filePaths: readonly string[]): LegacyDetectionResult;
/**
 * Generates a migration hint message for project.md.
 * This is shown when project.md exists and needs manual migration to config.yaml.
 *
 * @returns Formatted migration hint string for console output
 */
export declare function formatProjectMdMigrationHint(): string;
//# sourceMappingURL=legacy-cleanup.d.ts.map