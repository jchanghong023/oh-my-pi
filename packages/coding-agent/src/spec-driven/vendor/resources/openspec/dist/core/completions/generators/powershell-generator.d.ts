import { CompletionGenerator, CommandDefinition } from '../types.js';
/**
 * Generates PowerShell completion scripts for the OpenSpec CLI.
 * Uses Register-ArgumentCompleter for command completion.
 */
export declare class PowerShellGenerator implements CompletionGenerator {
    readonly shell: "powershell";
    private stripTrailingCommaFromLastLine;
    /**
     * Generate a PowerShell completion script
     *
     * @param commands - Command definitions to generate completions for
     * @returns PowerShell completion script as a string
     */
    generate(commands: CommandDefinition[]): string;
    /**
     * Generate completion case for a command
     */
    private generateCommandCase;
    /**
     * Generate argument completion (flags and positional)
     */
    private generateArgumentCompletion;
    private generateIndexedPositionalCompletion;
    private generateValueFlags;
    private escapeRegex;
    /**
     * Generate positional argument completion
     */
    private generatePositionalCompletion;
    /**
     * Escape description text for PowerShell
     */
    private escapeDescription;
}
//# sourceMappingURL=powershell-generator.d.ts.map