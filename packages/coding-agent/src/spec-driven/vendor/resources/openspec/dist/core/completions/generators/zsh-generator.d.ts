import { CompletionGenerator, CommandDefinition } from '../types.js';
/**
 * Generates Zsh completion scripts for the OpenSpec CLI.
 * Follows Zsh completion system conventions using the _openspec function.
 */
export declare class ZshGenerator implements CompletionGenerator {
    readonly shell: "zsh";
    /**
     * Generate a Zsh completion script
     *
     * @param commands - Command definitions to generate completions for
     * @returns Zsh completion script as a string
     */
    generate(commands: CommandDefinition[]): string;
    /**
     * Generate completion function for a specific command
     */
    private generateCommandFunction;
    /**
     * Generate completion function for a subcommand
     */
    private generateSubcommandFunction;
    /**
     * Generate flag specification for _arguments
     */
    private generateFlagSpec;
    /**
     * Generate positional argument specification
     */
    private generatePositionalSpec;
    private appendPositionalSpecs;
    private generatePositionalSpecs;
    private generateIndexedPositionalSpec;
    /**
     * Escape special characters in descriptions
     */
    private escapeDescription;
    /**
     * Escape special characters in values
     */
    private escapeValue;
    /**
     * Sanitize command names for use in function names
     */
    private sanitizeFunctionName;
}
//# sourceMappingURL=zsh-generator.d.ts.map