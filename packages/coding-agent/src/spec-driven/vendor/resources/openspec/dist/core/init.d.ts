/**
 * Init Command
 *
 * Sets up OpenSpec with Agent Skills and /opsx:* slash commands.
 * This is the unified setup command that replaces both the old init and experimental commands.
 */
type InitCommandOptions = {
    tools?: string;
    language?: string;
    force?: boolean;
    interactive?: boolean;
    profile?: string;
    /** Commander's --no-animation flag: false disables the welcome animation. */
    animation?: boolean;
    /**
     * Explicit opt-in/out for GitHub Copilot cloud coding-agent files.
     * `--copilot-cloud` sets true, `--no-copilot-cloud` sets false; undefined
     * leaves the decision to config, migration, or an interactive prompt.
     */
    copilotCloud?: boolean;
};
export declare class InitCommand {
    private readonly toolsArg?;
    private readonly language?;
    private readonly force;
    private readonly interactiveOption?;
    private readonly profileOverride?;
    private readonly animation;
    private readonly copilotCloudOption?;
    constructor(options?: InitCommandOptions);
    execute(targetPath: string): Promise<void>;
    private validate;
    private canPromptInteractively;
    /**
     * Decide whether to generate GitHub Copilot cloud files, and whether to
     * persist that decision. Precedence:
     *   1. `--copilot-cloud` / `--no-copilot-cloud` flag (explicit this run)
     *   2. persisted opt-in in config.yaml
     *   3. managed files already present (migration for pre-opt-in projects)
     *   4. interactive confirm (default No)
     *   5. non-interactive with no signal: skip, and don't persist a default
     *
     * @returns `write` — generate the files this run; `persist` — value to write
     *   back to config (undefined = leave config untouched); `optedOut` — the user
     *   explicitly declined, so any already-generated managed files should be
     *   removed; `skippedUndecided` — selected but no signal and couldn't ask, so
     *   the caller can hint that the opt-in exists.
     */
    private resolveCopilotCloudDecision;
    private resolveProfileOverride;
    /**
     * Resolves the workflows the effective profile installs, so onboarding output
     * only mentions commands that will actually exist.
     */
    private getActiveWorkflows;
    /**
     * Cleans repo-local legacy artifacts immediately and defers global Codex prompt
     * cleanup until replacement skills have been installed.
     */
    private handleLegacyCleanup;
    /**
     * Applies the safe subset of legacy cleanup that does not depend on newly
     * generated Codex skills.
     */
    private performImmediateLegacyCleanup;
    /**
     * Removes only the legacy global Codex prompts whose workflows now have
     * replacement skills in the project.
     */
    private finalizeDeferredLegacyCleanup;
    /**
     * Reads the currently installed workflow IDs for a single tool from the
     * generated skill layout on disk.
     */
    private getInstalledWorkflowsForTool;
    private performLegacyCleanup;
    private getSelectedTools;
    private resolveToolsArg;
    private validateTools;
    private createDirectoryStructure;
    private writeGitkeepFiles;
    /**
     * Generates skill files and slash commands for each selected tool,
     * honoring the configured delivery mode (skills, commands, or both).
     *
     * @param projectPath - Absolute path to the project root
     * @param tools - Selected tools with their skill directory metadata
     * @returns Created, refreshed, and failed tools plus removed artifact counts
     */
    private generateSkillsAndCommands;
    private normalizeLanguage;
    private languageContext;
    private assertLanguageCanBeApplied;
    private createConfig;
    private displaySuccessMessage;
    private startSpinner;
    private removeSkillDirs;
    private removeCommandFiles;
}
export {};
//# sourceMappingURL=init.d.ts.map