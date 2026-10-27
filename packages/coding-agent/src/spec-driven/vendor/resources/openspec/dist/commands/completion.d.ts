interface GenerateOptions {
    shell?: string;
}
interface InstallOptions {
    shell?: string;
    verbose?: boolean;
}
interface UninstallOptions {
    shell?: string;
    yes?: boolean;
}
interface CompleteOptions {
    type: string;
}
/**
 * Command for managing shell completions for OpenSpec CLI
 */
export declare class CompletionCommand {
    private completionProvider;
    constructor();
    /**
     * Resolve shell parameter or exit with error
     *
     * @param shell - The shell parameter (may be undefined)
     * @param operationName - Name of the operation (for error messages)
     * @returns Resolved shell or null if should exit
     */
    private resolveShellOrExit;
    /**
     * Generate completion script and output to stdout
     *
     * @param options - Options for generation (shell type)
     */
    generate(options?: GenerateOptions): Promise<void>;
    /**
     * Install completion script to the appropriate location
     *
     * @param options - Options for installation (shell type, verbose output)
     */
    install(options?: InstallOptions): Promise<void>;
    /**
     * Uninstall completion script from the installation location
     *
     * @param options - Options for uninstallation (shell type, yes flag)
     */
    uninstall(options?: UninstallOptions): Promise<void>;
    /**
     * Generate completion script for a specific shell
     */
    private generateForShell;
    /**
     * Install completion script for a specific shell
     */
    private installForShell;
    /**
     * Uninstall completion script for a specific shell
     */
    private uninstallForShell;
    /**
     * Output machine-readable completion data for shell consumption
     * Format: tab-separated "id\tdescription" per line
     *
     * @param options - Options specifying completion type
     */
    complete(options: CompleteOptions): Promise<void>;
    /**
     * Normalize shell parameter to lowercase
     */
    private normalizeShell;
}
export {};
//# sourceMappingURL=completion.d.ts.map