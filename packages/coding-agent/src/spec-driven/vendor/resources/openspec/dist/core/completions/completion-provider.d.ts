/**
 * Provides dynamic completion suggestions for OpenSpec items (changes and specs).
 * Implements a 2-second cache to avoid excessive file system operations during
 * tab completion.
 */
export declare class CompletionProvider {
    private readonly cacheTTLMs;
    private readonly projectRoot;
    private readonly cacheTTL;
    private changeCache;
    private specCache;
    private schemaCache;
    /**
     * Creates a new completion provider
     *
     * @param cacheTTLMs - Cache time-to-live in milliseconds (default: 2000ms)
     * @param projectRoot - Project root directory (default: process.cwd())
     */
    constructor(cacheTTLMs?: number, projectRoot?: string);
    /**
     * Get all active change IDs for completion
     *
     * @returns Array of change IDs
     */
    getChangeIds(): Promise<string[]>;
    /**
     * Get all spec IDs for completion
     *
     * @returns Array of spec IDs
     */
    getSpecIds(): Promise<string[]>;
    /**
     * Get all schema names for completion
     *
     * @returns Array of schema names
     */
    getSchemaNames(): Promise<string[]>;
    /**
     * Get both change and spec IDs for completion
     *
     * @returns Object with changeIds and specIds arrays
     */
    getAllIds(): Promise<{
        changeIds: string[];
        specIds: string[];
    }>;
    /**
     * Clear all cached data
     */
    clearCache(): void;
    /**
     * Get cache statistics for debugging
     *
     * @returns Cache status information
     */
    getCacheStats(): {
        changeCache: {
            valid: boolean;
            age?: number;
        };
        specCache: {
            valid: boolean;
            age?: number;
        };
        schemaCache: {
            valid: boolean;
            age?: number;
        };
    };
}
//# sourceMappingURL=completion-provider.d.ts.map