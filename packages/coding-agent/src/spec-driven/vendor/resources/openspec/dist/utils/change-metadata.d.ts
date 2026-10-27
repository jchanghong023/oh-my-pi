import { CHANGE_METADATA_KNOWN_KEYS, type ChangeMetadata } from '../core/change-metadata/index.js';
import { type ProjectConfig } from '../core/project-config.js';
export declare const METADATA_FILENAME = ".openspec.yaml";
export { CHANGE_METADATA_KNOWN_KEYS };
/**
 * Extension keys: a top-level key starting with a lowercase `x-` belongs to a
 * tool or team that reads `.openspec.yaml` alongside OpenSpec (a tracker id, an
 * owner). OpenSpec ignores it and does not report it as unknown. As with
 * OpenAPI's `x-` extensions, the name after the prefix may use any case or
 * spelling, but must be non-empty and free of whitespace, so `x-`, `x- foo`
 * and `X-Foo` are still reported. Extensions are top-level only: a key inside
 * `initiative:` is rejected by that object's strict schema.
 */
export declare const EXTENSION_KEY_PATTERN: RegExp;
export declare function isExtensionMetadataKey(key: string): boolean;
/**
 * Unknown top-level keys on a parsed .openspec.yaml object. Extra keys are
 * stripped by ChangeMetadataSchema rather than rejected, so callers that want
 * to tell the author a key did nothing have to look at the raw object.
 * Extension keys (`x-*`) are not unknown: they are deliberately someone else's.
 */
export declare function listUnknownChangeMetadataKeys(parsed: unknown): string[];
/**
 * Human-readable warning for keys ChangeMetadataSchema strips. Names the
 * unknown keys, the keys that do exist, and (when present) why `skip_design`
 * is not `skip_specs`.
 */
export declare function formatUnknownChangeMetadataKeysMessage(keys: string[]): string;
/**
 * Non-throwing read of unknown top-level keys. Missing, unreadable, or
 * unparseable files yield no keys: those failures already have their own
 * diagnostics on the read path.
 */
export declare function readUnknownChangeMetadataKeys(changeDir: string): string[];
/**
 * Error thrown when change metadata validation fails.
 */
export declare class ChangeMetadataError extends Error {
    readonly metadataPath: string;
    readonly cause?: Error | undefined;
    constructor(message: string, metadataPath: string, cause?: Error | undefined);
}
/**
 * Validates that a schema name is valid (exists in available schemas).
 *
 * @param schemaName - The schema name to validate
 * @param projectRoot - Optional project root for project-local schema resolution
 * @returns The validated schema name
 * @throws Error if schema is not found
 */
export declare function validateSchemaName(schemaName: string, projectRoot?: string): string;
/**
 * Writes change metadata to .openspec.yaml in the change directory.
 *
 * Meant for a new file only (`createChange` refuses an existing change
 * directory). `ChangeMetadataSchema` strips unknown keys, including `x-`
 * extension keys, so a caller that rewrites an existing file must merge those
 * keys back from the raw YAML first or it silently deletes them.
 *
 * @param changeDir - The path to the change directory
 * @param metadata - The metadata to write
 * @param projectRoot - Optional project root for project-local schema resolution
 * @throws ChangeMetadataError if validation fails or write fails
 */
export declare function writeChangeMetadata(changeDir: string, metadata: ChangeMetadata, projectRoot?: string): void;
/**
 * Reads change metadata from .openspec.yaml in the change directory.
 *
 * @param changeDir - The path to the change directory
 * @param projectRoot - Optional project root for project-local schema resolution
 * @returns The validated metadata, or null if no metadata file exists
 * @throws ChangeMetadataError if the file exists but is invalid
 */
export declare function readChangeMetadata(changeDir: string, projectRoot?: string): ChangeMetadata | null;
export interface ResolveSchemaForChangeOptions {
    metadata?: ChangeMetadata | null;
    /** Pre-read project config; suppresses the fallback config read when provided. */
    projectConfig?: ProjectConfig | null;
}
/**
 * Resolves the schema for a change, with explicit override taking precedence.
 *
 * Resolution order:
 * 1. Explicit schema (if provided)
 * 2. Schema from .openspec.yaml metadata (if exists)
 * 3. Schema from openspec/config.yaml (if exists)
 * 4. Default 'spec-driven'
 *
 * @param changeDir - The path to the change directory
 * @param explicitSchema - Optional explicit schema override
 * @returns The resolved schema name
 */
export declare function resolveSchemaForChange(changeDir: string, explicitSchema?: string, projectRootOverride?: string, options?: ResolveSchemaForChangeOptions): string;
export interface MetadataMarker {
    /**
     * True when the metadata parses under ChangeMetadataSchema, sets
     * the requested boolean marker to true, and names a schema that loads.
     */
    declared: boolean;
    /**
     * Set when the marker cannot be honored: it appears in a file that
     * fails the metadata contract, or the metadata file exists but cannot be
     * read at all (so whether the marker is set cannot even be determined).
     */
    invalidReason?: string;
}
/** @deprecated Use MetadataMarker. */
export type SkipSpecsMarker = MetadataMarker;
/**
 * Non-throwing read of the skip_specs marker. The marker only counts when the
 * metadata would load for status/instructions: the file parses under
 * ChangeMetadataSchema, its schema name passes readChangeMetadata's
 * listSchemas membership check, AND the schema itself loads via resolveSchema
 * (a schema.yaml that exists but does not parse fails status just the same).
 * Validate and archive must never honor metadata the rest of the CLI rejects,
 * in either direction. The project root for schema resolution is derived from
 * changeDir exactly like resolveSchemaForChange (changeDir is
 * <root>/openspec/changes/<name> for every root type, including store roots).
 * Missing metadata means "not declared"; a marker that cannot be honored
 * yields invalidReason so callers can say why.
 */
export declare function readSkipSpecsMarker(changeDir: string): MetadataMarker;
/**
 * Non-throwing read of the retire_capabilities marker, with exactly the
 * semantics `readSkipSpecsMarker` documents above.
 *
 * Gates the one archive action that removes a file from `openspec/specs/`: when
 * a change's REMOVED entries take a capability's last requirement, archive
 * deletes the emptied main spec rather than aborting on a spec it cannot write
 * (#1302). Declared rather than inferred because the delete is recoverable only
 * from git, so it is the author's call.
 */
export declare function readRetireCapabilitiesMarker(changeDir: string): MetadataMarker;
//# sourceMappingURL=change-metadata.d.ts.map