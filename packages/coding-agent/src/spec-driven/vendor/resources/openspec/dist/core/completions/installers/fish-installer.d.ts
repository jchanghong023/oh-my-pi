import { InstallationResult } from '../factory.js';
/**
 * Installer for Fish completion scripts.
 * Fish automatically loads completions from ~/.config/fish/completions/
 */
export declare class FishInstaller {
    private readonly homeDir;
    constructor(homeDir?: string);
    /**
     * Get the installation path for Fish completions
     *
     * @returns Installation path
     */
    getInstallationPath(): string;
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
     * Install the completion script
     *
     * @param completionScript - The completion script content to install
     * @returns Installation result with status and instructions
     */
    install(completionScript: string): Promise<InstallationResult>;
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
//# sourceMappingURL=fish-installer.d.ts.map