import { InstallationResult } from '../factory.js';
/**
 * Installer for Bash completion scripts.
 * Supports bash-completion package and standalone installations.
 */
export declare class BashInstaller {
    private readonly homeDir;
    /**
     * Markers for .bashrc configuration management
     */
    private readonly BASHRC_MARKERS;
    constructor(homeDir?: string);
    /**
     * Check if bash-completion is installed
     *
     * @returns true if bash-completion directories exist
     */
    isBashCompletionInstalled(): Promise<boolean>;
    /**
     * Get the appropriate installation path for the completion script
     *
     * @returns Installation path
     */
    getInstallationPath(): Promise<string>;
    /**
     * Check if a completion script is currently installed.
     * Mirrors ZshInstaller.isInstalled so callers can ask any installer.
     *
     * @returns true if the completion script exists
     */
    isInstalled(): Promise<boolean>;
    /**
     * Backup an existing completion file if it exists
     *
     * @param targetPath - Path to the file to backup
     * @returns Path to the backup file, or undefined if no backup was needed
     */
    backupExistingFile(targetPath: string): Promise<string | undefined>;
    /**
     * Get the path to .bashrc file
     *
     * @returns Path to .bashrc
     */
    private getBashrcPath;
    /**
     * Generate .bashrc configuration content
     *
     * @param completionsDir - Directory containing completion scripts
     * @returns Configuration content
     */
    private generateBashrcConfig;
    /**
     * Configure .bashrc to enable completions
     *
     * @param completionsDir - Directory containing completion scripts
     * @returns true if configured successfully, false otherwise
     */
    configureBashrc(completionsDir: string): Promise<boolean>;
    /**
     * Remove .bashrc configuration
     * Used during uninstallation
     *
     * @returns true if removed successfully, false otherwise
     */
    removeBashrcConfig(): Promise<boolean>;
    /**
     * Install the completion script
     *
     * @param completionScript - The completion script content to install
     * @returns Installation result with status and instructions
     */
    install(completionScript: string): Promise<InstallationResult>;
    /**
     * Generate user instructions for enabling completions
     *
     * @param installedPath - Path where the script was installed
     * @returns Array of instruction strings
     */
    private generateInstructions;
    /**
     * Uninstall the completion script
     *
     * @param options - Optional uninstall options
     * @param options.yes - Skip confirmation prompt (handled by command layer)
     * @returns Uninstallation result
     */
    uninstall(options?: {
        yes?: boolean;
    }): Promise<{
        success: boolean;
        message: string;
    }>;
}
//# sourceMappingURL=bash-installer.d.ts.map