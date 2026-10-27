import { CompletionGenerator, CommandDefinition } from '../types.js';
/**
 * Generates Fish completion scripts for the OpenSpec CLI.
 * Follows Fish completion conventions using the complete command.
 */
export declare class FishGenerator implements CompletionGenerator {
    readonly shell: "fish";
    /**
     * Generate a Fish completion script
     *
     * @param commands - Command definitions to generate completions for
     * @returns Fish completion script as a string
     */
    generate(commands: CommandDefinition[]): string;
    /**
     * Generate completions for a specific command
     */
    private generateCommandCompletions;
    /**
     * Generate flag completion
     */
    private generateFlagCompletion;
    /**
     * Generate positional argument completion
     */
    private generatePositionalCompletion;
    /**
     * Generate indexed positional completions.
     */
    private generateIndexedPositionalCompletions;
    /**
     * Collect the long and short names for flags that consume the next token.
     */
    private collectValueFlags;
    /**
     * Build a Fish condition that matches command words in their actual slots.
     */
    private commandPathCondition;
    /**
     * Escape description text for Fish
     */
    private escapeDescription;
}
//# sourceMappingURL=fish-generator.d.ts.map