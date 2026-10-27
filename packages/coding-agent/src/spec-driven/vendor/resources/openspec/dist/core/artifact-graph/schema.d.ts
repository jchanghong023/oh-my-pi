import { type SchemaYaml } from './types.js';
export declare class SchemaValidationError extends Error {
    constructor(message: string);
}
/**
 * Loads and validates an artifact schema from a YAML file.
 */
export declare function loadSchema(filePath: string): SchemaYaml;
/**
 * Parses and validates an artifact schema from YAML content.
 */
export declare function parseSchema(yamlContent: string): SchemaYaml;
/**
 * Describes an `apply.tracks` value that is not exactly equal to any artifact's
 * `generates` value, or returns undefined when there is nothing to report.
 *
 * The tracked-tasks lookups select the artifact whose `generates` string equals
 * `tracks`, so this is a progress-discovery problem, not a claim that nothing
 * produces the file: a glob `generates: tasks/*.md` really does generate
 * `tracks: tasks/main.md`, yet the strings differ, so the lookup still misses.
 * Either way apply keeps working (it reads the path directly), but `openspec
 * list` and `openspec status` fall back to counting the top-level `tasks.md`,
 * and apply's remedy cannot name an artifact to build. A typo such as
 * `task.md` is the other usual cause.
 */
export declare function findApplyTracksWarning(schema: SchemaYaml): string | undefined;
//# sourceMappingURL=schema.d.ts.map