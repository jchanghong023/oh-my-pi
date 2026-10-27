/**
 * Supported shell types for completion generation
 */
export type SupportedShell = 'zsh' | 'bash' | 'fish' | 'powershell';
/**
 * Result of shell detection
 */
export interface ShellDetectionResult {
    /** The detected shell if supported, otherwise undefined */
    shell: SupportedShell | undefined;
    /** The raw shell name detected (even if unsupported), or undefined if nothing detected */
    detected: string | undefined;
}
/**
 * Detects the current user's shell based on the parent process and environment
 *
 * @returns Detection result with supported shell and raw detected name
 */
export declare function detectShell(): ShellDetectionResult;
//# sourceMappingURL=shell-detection.d.ts.map