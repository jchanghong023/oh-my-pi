import { InstallationResult } from '../factory.js';
/**
 * Installer for Zsh completion scripts.
 * Supports both Oh My Zsh and standard Zsh configurations.
 */
export declare class ZshInstaller {
    private readonly homeDir;
    /**
     * Markers for .zshrc configuration management
     */
    private readonly ZSHRC_MARKERS;
    constructor(homeDir?: string);
    /**
     * Check if Oh My Zsh is installed
     *
     * @returns true if Oh My Zsh is detected via $ZSH env var or directory exists
     */
    isOhMyZshInstalled(): Promise<boolean>;
    /**
     * Oh My Zsh exports its root as $ZSH; honor a custom location, or the
     * completion lands in a ~/.oh-my-zsh tree that nothing ever loads.
     */
    private ohMyZshRoot;
    /**
     * The custom dir is separately relocatable via $ZSH_CUSTOM.
     */
    private ohMyZshCustomDir;
    /**
     * Get the appropriate installation path for the completion script
     *
     * @returns Object with installation path and whether it's Oh My Zsh
     */
    getInstallationPath(): Promise<{
        path: string;
        isOhMyZsh: boolean;
    }>;
    /**
     * Backup an existing completion file if it exists
     *
     * @param targetPath - Path to the file to backup
     * @returns Path to the backup file, or undefined if no backup was needed
     */
    backupExistingFile(targetPath: string): Promise<string | undefined>;
    /**
     * Get the path to .zshrc file
     *
     * @returns Path to .zshrc
     */
    private getZshrcPath;
    /**
     * Generate .zshrc configuration content
     *
     * @param completionsDir - Directory containing completion scripts
     * @returns Configuration content
     */
    private generateZshrcConfig;
    /**
     * Configure .zshrc to enable completions
     * Only applies to standard Zsh (not Oh My Zsh)
     *
     * @param completionsDir - Directory containing completion scripts
     * @returns true if configured successfully, false otherwise
     */
    configureZshrc(completionsDir: string): Promise<boolean>;
    /**
     * Check if .zshrc has OpenSpec configuration markers
     *
     * @returns true if .zshrc exists and has markers
     */
    private hasZshrcConfig;
    /**
     * Remove .zshrc configuration
     * Used during uninstallation
     *
     * @returns true if removed successfully, false otherwise
     */
    removeZshrcConfig(): Promise<boolean>;
    /**
     * Install the completion script
     *
     * @param completionScript - The completion script content to install
     * @returns Installation result with status and instructions
     */
    install(completionScript: string): Promise<InstallationResult>;
    /**
     * Generate Oh My Zsh fpath verification guidance
     *
     * @param completionsDir - Custom completions directory path
     * @returns Array of guidance strings, or undefined if not needed
     */
    private generateOhMyZshFpathGuidance;
    /**
     * Generate user instructions for enabling completions
     *
     * @param isOhMyZsh - Whether Oh My Zsh is being used
     * @param installedPath - Path where the script was installed
     * @returns Array of instruction strings
     */
    private generateInstructions;
    /**
     * Uninstall the completion script
     *
     * @returns true if uninstalled successfully, false otherwise
     */
    uninstall(): Promise<{
        success: boolean;
        message: string;
    }>;
    /**
     * Check if completion script is currently installed
     *
     * @returns true if the completion script exists
     */
    isInstalled(): Promise<boolean>;
    /**
     * Get information about the current installation
     *
     * @returns Installation status information
     */
    getInstallationInfo(): Promise<{
        installed: boolean;
        path?: string;
        isOhMyZsh?: boolean;
    }>;
}
//# sourceMappingURL=zsh-installer.d.ts.map