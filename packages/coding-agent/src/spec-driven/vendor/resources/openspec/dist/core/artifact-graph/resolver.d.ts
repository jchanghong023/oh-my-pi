import * as fs from 'node:fs';
import type { SchemaYaml } from './types.js';
/**
 * Error thrown when loading a schema fails.
 */
export declare class SchemaLoadError extends Error {
    readonly schemaPath: string;
    readonly cause?: Error | undefined;
    constructor(message: string, schemaPath: string, cause?: Error | undefined);
}
/**
 * Points the built-in schemas at another directory. The standalone binary has
 * no package directory on disk, so it passes a function that extracts its
 * embedded schemas; it runs only when a command first needs them.
 */
export declare function setPackageSchemasDir(resolveDir: () => string): void;
/**
 * Gets the package's built-in schemas directory path.
 * Uses import.meta.url to resolve relative to the current module.
 */
export declare function getPackageSchemasDir(): string;
/**
 * Gets the user's schema override directory path.
 */
export declare function getUserSchemasDir(): string;
/**
 * Gets the project-local schemas directory path.
 * @param projectRoot - The project root directory
 * @returns The path to the project's schemas directory
 */
export declare function getProjectSchemasDir(projectRoot: string): string;
export declare function isSchemaDir(parentDir: string, entry: fs.Dirent): boolean;
/**
 * Resolves a schema name to its directory path.
 *
 * Resolution order (when projectRoot is provided):
 * 1. Project-local: <projectRoot>/openspec/schemas/<name>/schema.yaml
 * 2. User override: ${XDG_DATA_HOME}/openspec/schemas/<name>/schema.yaml
 * 3. Package built-in: <package>/schemas/<name>/schema.yaml
 *
 * When projectRoot is not provided, only user override and package built-in are checked
 * (backward compatible behavior).
 *
 * @param name - Schema name (e.g., "spec-driven")
 * @param projectRoot - Optional project root directory for project-local schema resolution
 * @returns The path to the schema directory, or null if not found
 */
export declare function getSchemaDir(name: string, projectRoot?: string): string | null;
/**
 * Resolves a schema name to a SchemaYaml object.
 *
 * Resolution order (when projectRoot is provided):
 * 1. Project-local: <projectRoot>/openspec/schemas/<name>/schema.yaml
 * 2. User override: ${XDG_DATA_HOME}/openspec/schemas/<name>/schema.yaml
 * 3. Package built-in: <package>/schemas/<name>/schema.yaml
 *
 * When projectRoot is not provided, only user override and package built-in are checked
 * (backward compatible behavior).
 *
 * @param name - Schema name (e.g., "spec-driven")
 * @param projectRoot - Optional project root directory for project-local schema resolution
 * @returns The resolved schema object
 * @throws Error if schema is not found in any location
 */
export declare function resolveSchema(name: string, projectRoot?: string): SchemaYaml;
/**
 * Lists all available schema names.
 * Combines project-local, user override, and package built-in schemas.
 *
 * @param projectRoot - Optional project root directory for project-local schema resolution
 */
export declare function listSchemas(projectRoot?: string): string[];
/**
 * Schema info with metadata (name, description, artifacts).
 */
export interface SchemaInfo {
    name: string;
    description: string;
    artifacts: string[];
    source: 'project' | 'user' | 'package';
}
/**
 * Lists all available schemas with their descriptions and artifact lists.
 * Useful for agent skills to present schema selection to users.
 *
 * @param projectRoot - Optional project root directory for project-local schema resolution
 */
export declare function listSchemasWithInfo(projectRoot?: string): SchemaInfo[];
//# sourceMappingURL=resolver.d.ts.map