import { getActiveChangeIds, getSpecIds } from '../../utils/item-discovery.js';
/**
 * Provides dynamic completion suggestions for OpenSpec items (changes and specs).
 * Implements a 2-second cache to avoid excessive file system operations during
 * tab completion.
 */
export class CompletionProvider {
    cacheTTLMs;
    projectRoot;
    cacheTTL;
    changeCache = null;
    specCache = null;
    schemaCache = null;
    /**
     * Creates a new completion provider
     *
     * @param cacheTTLMs - Cache time-to-live in milliseconds (default: 2000ms)
     * @param projectRoot - Project root directory (default: process.cwd())
     */
    constructor(cacheTTLMs = 2000, projectRoot = process.cwd()) {
        this.cacheTTLMs = cacheTTLMs;
        this.projectRoot = projectRoot;
        this.cacheTTL = cacheTTLMs;
    }
    /**
     * Get all active change IDs for completion
     *
     * @returns Array of change IDs
     */
    async getChangeIds() {
        const now = Date.now();
        // Check if cache is valid
        if (this.changeCache && now - this.changeCache.timestamp < this.cacheTTL) {
            return this.changeCache.data;
        }
        // Fetch fresh data
        const changeIds = await getActiveChangeIds(this.projectRoot);
        // Update cache
        this.changeCache = {
            data: changeIds,
            timestamp: now,
        };
        return changeIds;
    }
    /**
     * Get all spec IDs for completion
     *
     * @returns Array of spec IDs
     */
    async getSpecIds() {
        const now = Date.now();
        // Check if cache is valid
        if (this.specCache && now - this.specCache.timestamp < this.cacheTTL) {
            return this.specCache.data;
        }
        // Fetch fresh data
        const specIds = await getSpecIds(this.projectRoot);
        // Update cache
        this.specCache = {
            data: specIds,
            timestamp: now,
        };
        return specIds;
    }
    /**
     * Get all schema names for completion
     *
     * @returns Array of schema names
     */
    async getSchemaNames() {
        const now = Date.now();
        // Check if cache is valid
        if (this.schemaCache && now - this.schemaCache.timestamp < this.cacheTTL) {
            return this.schemaCache.data;
        }
        // Fetch fresh data. The resolver (and the yaml and zod it parses schemas
        // with) loads only here: completing changes or specs never needs it, and
        // the artifact-graph barrel would also pull in tinyglobby.
        const { listSchemas } = await import('../artifact-graph/resolver.js');
        const schemaNames = listSchemas(this.projectRoot);
        // Update cache
        this.schemaCache = {
            data: schemaNames,
            timestamp: now,
        };
        return schemaNames;
    }
    /**
     * Get both change and spec IDs for completion
     *
     * @returns Object with changeIds and specIds arrays
     */
    async getAllIds() {
        const [changeIds, specIds] = await Promise.all([
            this.getChangeIds(),
            this.getSpecIds(),
        ]);
        return { changeIds, specIds };
    }
    /**
     * Clear all cached data
     */
    clearCache() {
        this.changeCache = null;
        this.specCache = null;
        this.schemaCache = null;
    }
    /**
     * Get cache statistics for debugging
     *
     * @returns Cache status information
     */
    getCacheStats() {
        const now = Date.now();
        return {
            changeCache: {
                valid: this.changeCache !== null && now - this.changeCache.timestamp < this.cacheTTL,
                age: this.changeCache ? now - this.changeCache.timestamp : undefined,
            },
            specCache: {
                valid: this.specCache !== null && now - this.specCache.timestamp < this.cacheTTL,
                age: this.specCache ? now - this.specCache.timestamp : undefined,
            },
            schemaCache: {
                valid: this.schemaCache !== null && now - this.schemaCache.timestamp < this.cacheTTL,
                age: this.schemaCache ? now - this.schemaCache.timestamp : undefined,
            },
        };
    }
}
//# sourceMappingURL=completion-provider.js.map