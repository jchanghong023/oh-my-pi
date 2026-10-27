/**
 * GitHub Copilot Cloud Agent Support
 *
 * Generates copilot-setup-steps.yml and .github/agents/openspec.agent.md
 * when the github-copilot tool is selected during init/update.
 * These files enable the GitHub Copilot coding agent (cloud) to use the
 * OpenSpec CLI in its ephemeral dev environment.
 */
/**
 * Check if a tool list includes github-copilot.
 */
export declare function includesGitHubCopilot(toolIds: string[]): boolean;
/**
 * Generate the copilot-setup-steps.yml workflow file content.
 * This workflow pre-installs the OpenSpec CLI in the Copilot coding agent's
 * ephemeral GitHub Actions environment.
 */
export declare function generateCopilotSetupSteps(): string;
/**
 * Generate the .github/agents/openspec.agent.md custom agent file content.
 * This tells the GitHub Copilot coding agent how to use the OpenSpec CLI.
 */
export declare function generateCopilotAgentFile(): string;
/**
 * File paths (relative to project root) for the generated files.
 */
export declare const COPILOT_CLOUD_FILES: {
    readonly setupSteps: string;
    readonly agent: string;
};
/**
 * Every change the cloud-file sync makes on disk. `update --dry-run` passes a
 * recorder, so the plan comes from this same code rather than a description.
 */
export interface CopilotCloudFileOps {
    writeFile(filePath: string, content: string): Promise<void>;
    removeFile(filePath: string): Promise<void>;
}
/**
 * Reconcile Copilot cloud agent files in the project directory.
 * Creates missing files and refreshes recognized legacy generated files while
 * preserving current generated content and user customizations.
 *
 * @returns Object indicating which files were written.
 */
export declare function writeCopilotCloudFiles(projectPath: string, ops?: CopilotCloudFileOps): Promise<{
    setupStepsWritten: boolean;
    agentWritten: boolean;
}>;
/**
 * Remove copilot cloud agent files from the project directory.
 * Used when github-copilot is deselected.
 *
 * @returns Number of files removed.
 */
export declare function removeCopilotCloudFiles(projectPath: string, ops?: CopilotCloudFileOps): Promise<number>;
/**
 * Read the persisted opt-in for Copilot cloud-file generation.
 *
 * Tri-state: `true` (opted in), `false` (explicitly opted out), or `undefined`
 * (never decided). A malformed value is treated as undecided rather than an
 * error, matching how {@link readProjectConfig} degrades on bad fields.
 */
export declare function readCopilotCloudOptIn(projectPath: string): boolean | undefined;
/**
 * True when a managed Copilot cloud file (the current generation or a
 * recognized legacy one) already exists. Projects created before the opt-in
 * prompt existed are treated as implicitly opted in, so `openspec update`
 * keeps their files current instead of silently abandoning them.
 */
export declare function hasExistingManagedCloudFiles(projectPath: string): Promise<boolean>;
/**
 * Effective decision on whether to generate/refresh Copilot cloud files.
 * An explicit opt-in or opt-out always wins; when undecided, fall back to
 * whether managed files already exist (the migration path above).
 */
export declare function isCopilotCloudEnabled(projectPath: string): Promise<boolean>;
/**
 * Persist the Copilot cloud opt-in into openspec/config.yaml.
 *
 * Uses the YAML document model rather than a re-serialize so the user's
 * existing comments, ordering, and formatting survive untouched — the config
 * file is hand-authored and heavily commented, so a lossy round-trip would be
 * its own source of toil. No-op when no config file exists yet (init creates it
 * before this is called); the caller treats persistence failures as non-fatal.
 */
export declare function persistCopilotCloudOptIn(projectPath: string, value: boolean): Promise<void>;
/**
 * Return the managed cloud-file paths (relative to the project root) that
 * currently hold user-owned, non-managed content — i.e. files OpenSpec will
 * deliberately leave untouched. Used to tell an opted-in user that we preserved
 * their existing file rather than silently doing nothing, which is the honest
 * answer to "will this affect my existing Copilot cloud setup?".
 */
export declare function findUnmanagedCloudFiles(projectPath: string): Promise<string[]>;
/**
 * Return the managed cloud-file paths (relative to the project root) that
 * currently exist and hold OpenSpec-generated content. Callers report this
 * rather than the intended paths, so output never claims a file that a write
 * skipped (user already owns it) or that reconciliation removed.
 */
export declare function listManagedCloudFiles(projectPath: string): Promise<string[]>;
//# sourceMappingURL=cloud-agent.d.ts.map