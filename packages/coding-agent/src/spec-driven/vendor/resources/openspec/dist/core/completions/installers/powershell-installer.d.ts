import { InstallationResult } from '../factory.js';
/**
 * Installer for PowerShell completion scripts.
 * Works with both Windows PowerShell 5.1 and PowerShell Core 7+
 */
export declare class PowerShellInstaller {
    private readonly homeDir;
    /**
     * Markers for PowerShell profile configuration management
     */
    private readonly PROFILE_MARKERS;
    constructor(homeDir?: string);
    /**
     * Detect the encoding of a file by inspecting its BOM (Byte Order Mark).
     * Returns the Node.js BufferEncoding and the raw BOM bytes to preserve on write.
     */
    private detectEncoding;
    /**
     * Read a profile file, preserving its encoding metadata for round-trip writes.
     * Throws if the file uses UTF-16 BE (unsupported by Node).
     */
    private readProfileFile;
    /**
     * Write a profile file, preserving the original BOM and encoding.
     */
    private writeProfileFile;
    /**
     * Get PowerShell profile path
     * Prefers $PROFILE environment variable, falls back to platform defaults
     *
     * @returns Profile path
     */
    getProfilePath(): string;
    /**
     * Get all PowerShell profile paths to configure.
     * On Windows, returns both PowerShell Core and Windows PowerShell 5.1 paths.
     * On Unix, returns PowerShell Core path only.
     */
    private getAllProfilePaths;
    /**
     * Get the installation path for the completion script
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
     * Generate PowerShell profile configuration content
     *
     * @param scriptPath - Path to the completion script
     * @returns Configuration content
     */
    private generateProfileConfig;
    /**
     * Configure PowerShell profile to source the completion script
     *
     * @param scriptPath - Path to the completion script
     * @returns true if configured successfully, false otherwise
     */
    configureProfile(scriptPath: string): Promise<boolean>;
    /**
     * Remove PowerShell profile configuration
     * Used during uninstallation
     *
     * @returns true if removed successfully, false otherwise
     */
    removeProfileConfig(): Promise<boolean>;
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
//# sourceMappingURL=powershell-installer.d.ts.map