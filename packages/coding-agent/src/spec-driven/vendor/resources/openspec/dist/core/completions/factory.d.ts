import { CompletionGenerator } from './types.js';
import { SupportedShell } from '../../utils/shell-detection.js';
/**
 * Common installation result interface
 */
export interface InstallationResult {
    success: boolean;
    installedPath?: string;
    backupPath?: string;
    message: string;
    instructions?: string[];
    warnings?: string[];
    isOhMyZsh?: boolean;
    zshrcConfigured?: boolean;
    bashrcConfigured?: boolean;
    profileConfigured?: boolean;
}
/**
 * Interface for completion installers
 */
export interface CompletionInstaller {
    install(script: string): Promise<InstallationResult>;
    uninstall(): Promise<{
        success: boolean;
        message: string;
    }>;
    /**
     * True when a completion script file is present at the install path.
     *
     * Deliberately just the script: bash and PowerShell also need a sourcing
     * line in the user's profile, and `install()` adds that on a best-effort
     * basis (it is skipped by OPENSPEC_NO_AUTO_CONFIG=1 or an unwritable
     * profile, printing manual instructions instead). Someone in that state has
     * already met the installer, so callers that use this to decide whether to
     * *advertise* completions should not advertise again.
     */
    isInstalled(): Promise<boolean>;
}
/**
 * Factory for creating completion generators and installers
 * This design makes it easy to add support for additional shells
 */
export declare class CompletionFactory {
    private static readonly SUPPORTED_SHELLS;
    /**
     * Create a completion generator for the specified shell
     *
     * @param shell - The target shell
     * @returns CompletionGenerator instance
     * @throws Error if shell is not supported
     */
    static createGenerator(shell: SupportedShell): CompletionGenerator;
    /**
     * Create a completion installer for the specified shell
     *
     * @param shell - The target shell
     * @returns CompletionInstaller instance
     * @throws Error if shell is not supported
     */
    static createInstaller(shell: SupportedShell): CompletionInstaller;
    /**
     * Check if a shell is supported
     *
     * @param shell - The shell to check
     * @returns true if the shell is supported
     */
    static isSupported(shell: string): shell is SupportedShell;
    /**
     * Get list of all supported shells
     *
     * @returns Array of supported shell names
     */
    static getSupportedShells(): SupportedShell[];
}
//# sourceMappingURL=factory.d.ts.map