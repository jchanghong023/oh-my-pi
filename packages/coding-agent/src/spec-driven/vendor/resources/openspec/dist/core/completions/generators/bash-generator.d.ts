import { CompletionGenerator, CommandDefinition } from '../types.js';
/**
 * Generates Bash completion scripts for the OpenSpec CLI.
 * Follows Bash completion conventions using complete builtin and COMPREPLY array.
 */
export declare class BashGenerator implements CompletionGenerator {
    readonly shell: "bash";
    /**
     * Generate a Bash completion script
     *
     * @param commands - Command definitions to generate completions for
     * @returns Bash completion script as a string
     */
    generate(commands: CommandDefinition[]): string;
    /**
     * Generate completion case logic for a command
     */
    private generateCommandCase;
    /**
     * Generate argument completion (flags and positional arguments)
     */
    private generateArgumentCompletion;
    /**
     * Generate positional argument completion based on type
     */
    private generatePositionalCompletion;
    private generateIndexedPositionalCompletion;
    private generateValueFlagCases;
    private generateIndexedPositionalCase;
    /**
     * Escape command/subcommand names for safe use in Bash scripts
     */
    private escapeCommandName;
}
//# sourceMappingURL=bash-generator.d.ts.map