import type { ChangeMetadata } from '../core/change-metadata/index.js';
/**
 * Options for creating a change.
 */
export interface CreateChangeOptions {
    /** The workflow schema to use (default: 'spec-driven') */
    schema?: string;
    /** Default schema to use when no explicit schema or project config is present */
    defaultSchema?: string;
    /** Directory that should contain the change directories */
    changesDir?: string;
    /** Additional metadata to persist in the change's .openspec.yaml */
    metadata?: Partial<Pick<ChangeMetadata, 'goal' | 'affected_areas' | 'initiative'>>;
}
/**
 * Result of creating a change.
 */
export interface CreateChangeResult {
    /** The schema that was actually used (resolved from options, config, or default) */
    schema: string;
    /** Absolute path to the created change directory */
    changeDir: string;
}
/**
 * Result of validating a change name.
 */
export interface ValidationResult {
    valid: boolean;
    error?: string;
}
/**
 * Validates that a change name follows kebab-case conventions.
 *
 * Uses OpenSpec's shared kebab-id grammar (the same one store ids and change
 * metadata ids use), so a change name may:
 * - Start with a lowercase letter or a digit
 * - Contain only lowercase letters, numbers, and hyphens
 * - Not start or end with a hyphen
 * - Not contain consecutive hyphens
 *
 * A leading digit is allowed so ordering conventions like `100-add-feature` or
 * `00001-add-auth` work; archive already treats such prefixes as a supported
 * convention (see ARCHIVE_DATE_PREFIX_PATTERN).
 *
 * @param name - The change name to validate
 * @returns Validation result with `valid: true` or `valid: false` with an error message
 *
 * @example
 * validateChangeName('add-auth') // { valid: true }
 * validateChangeName('100-add-feature') // { valid: true }
 * validateChangeName('Add-Auth') // { valid: false, error: '...' }
 */
export declare function validateChangeName(name: string): ValidationResult;
/**
 * Creates a new change directory with metadata file.
 *
 * @param projectRoot - The root directory of the project (where `openspec/` lives)
 * @param name - The change name (must be valid kebab-case)
 * @param options - Optional settings for the change
 * @throws Error if the change name is invalid
 * @throws Error if the schema name is invalid
 * @throws Error if the change directory already exists
 *
 * @returns Result containing the resolved schema name
 *
 * @example
 * // Creates openspec/changes/add-auth/ with default schema
 * const result = await createChange('/path/to/project', 'add-auth')
 * console.log(result.schema) // 'spec-driven' or value from config
 *
 * @example
 * // Creates openspec/changes/add-auth/ with custom schema
 * const result = await createChange('/path/to/project', 'add-auth', { schema: 'my-workflow' })
 * console.log(result.schema) // 'my-workflow'
 */
export declare function createChange(projectRoot: string, name: string, options?: CreateChangeOptions): Promise<CreateChangeResult>;
//# sourceMappingURL=change-utils.d.ts.map