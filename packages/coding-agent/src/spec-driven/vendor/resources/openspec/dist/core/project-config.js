import { existsSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { getStoreMetadataPath } from './store/foundation.js';
export const OPERATION_IDS = ['apply', 'archive'];
const OperationConfigSchema = z.object({
    guidance: z.array(z.string()).optional(),
});
/**
 * Zod schema for project configuration.
 *
 * Purpose:
 * 1. Documentation - clearly defines the config file structure
 * 2. Type safety - TypeScript infers ProjectConfig type from schema
 * 3. Runtime validation - uses safeParse() for resilient field-by-field validation
 *
 * Why Zod over manual validation:
 * - Helps understand OpenSpec's data interfaces at a glance
 * - Single source of truth for type and validation
 * - Consistent with other OpenSpec schemas
 */
export const ProjectConfigSchema = z.object({
    // Required: which schema to use (e.g., "spec-driven", or project-local schema name)
    schema: z
        .string()
        .min(1)
        .describe('The workflow schema to use (e.g., "spec-driven")'),
    // Optional: project context (injected into all artifact instructions)
    // Max size: 50KB (enforced during parsing)
    context: z
        .string()
        .optional()
        .describe('Project context injected into all artifact instructions'),
    // Optional: per-artifact rules (additive to schema's built-in guidance)
    rules: z
        .record(z.string(), // artifact ID
    z.array(z.string()) // list of rules
    )
        .optional()
        .describe('Per-artifact rules, keyed by artifact ID'),
    // Optional: per-operation advisory guidance, kept separate from artifact rules.
    operations: z
        .object({
        apply: OperationConfigSchema.optional(),
        archive: OperationConfigSchema.optional(),
    })
        .optional()
        .describe('Per-operation advisory guidance'),
    // Note: the `references` field (id strings or {id, remote} maps) is
    // deliberately absent here — readProjectConfig parses and normalizes
    // it by hand (see DeclarationEntry below); a schema entry nothing
    // parses would only drift from the real behavior.
    // Optional: the declared default store. Only consulted by root
    // resolution when this openspec/ directory is config-only (no specs/
    // or changes/); a fallback, never an override.
    store: z
        .string()
        .optional()
        .describe('Store id used as the OpenSpec root when no local planning shape exists'),
    // Optional: GitHub Copilot integration preferences. `cloudAgent` is the
    // opt-in for generating the Copilot cloud coding-agent files (a GitHub
    // Actions workflow + agent file); absent means "not yet decided".
    githubCopilot: z
        .object({
        cloudAgent: z.boolean().optional(),
    })
        .optional()
        .describe('GitHub Copilot integration preferences'),
});
export function loadOperationInputs(projectConfig, operationId) {
    const context = projectConfig?.context !== undefined && projectConfig.context.trim().length > 0
        ? projectConfig.context
        : undefined;
    const guidance = projectConfig?.operations?.[operationId]?.guidance;
    const operationGuidance = guidance && guidance.length > 0 ? guidance : undefined;
    return {
        ...(context !== undefined ? { context } : {}),
        ...(operationGuidance !== undefined ? { operationGuidance } : {}),
    };
}
function parseOperations(raw) {
    if (raw === undefined) {
        return undefined;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        console.warn(`Invalid 'operations' field in config (must be object)`);
        return undefined;
    }
    const supported = new Set(OPERATION_IDS);
    const operations = {};
    for (const [operationId, value] of Object.entries(raw)) {
        if (!supported.has(operationId)) {
            console.warn(`Unknown operation ID '${operationId}' in config. Supported operation IDs: ${OPERATION_IDS.join(', ')}`);
            continue;
        }
        const typedOperationId = operationId;
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            console.warn(`Invalid 'operations.${operationId}' field in config (must be object), ignoring this operation`);
            continue;
        }
        const operation = value;
        const unknownFields = Object.keys(operation).filter((field) => field !== 'guidance');
        if (unknownFields.length > 0) {
            console.warn(`Unknown field(s) in 'operations.${operationId}': ${unknownFields.join(', ')}. Supported fields: guidance`);
        }
        if (operation.guidance === undefined) {
            continue;
        }
        const guidanceResult = z.array(z.string()).safeParse(operation.guidance);
        if (!guidanceResult.success) {
            console.warn(`Guidance for operation '${operationId}' must be an array of strings, ignoring this operation's guidance`);
            continue;
        }
        const guidance = guidanceResult.data.filter((entry) => entry.length > 0);
        if (guidance.length < guidanceResult.data.length) {
            console.warn(`Some guidance for operation '${operationId}' are empty strings, ignoring them`);
        }
        if (guidance.length > 0) {
            operations[typedOperationId] = { guidance };
        }
    }
    return Object.keys(operations).length > 0 ? operations : undefined;
}
/**
 * Parser for `references:` declarations: string entries or
 * {id, remote} maps, normalized to DeclarationEntry[]. Dedup keys on
 * id and keeps the first position; the first entry carrying a remote
 * supplies it (a later duplicate fills a missing remote, never
 * overrides). Invalid entries drop with a warning like other resilient
 * fields; returns undefined when the field is absent or normalizes to
 * empty.
 */
function parseDeclarationList(raw) {
    const fieldName = 'references';
    if (raw === undefined) {
        return undefined;
    }
    if (!Array.isArray(raw)) {
        console.warn(`Invalid '${fieldName}' field in config (must be an array of store ids)`);
        return undefined;
    }
    const byId = new Map();
    let droppedEntries = false;
    let droppedRemotes = false;
    for (const entry of raw) {
        let declaration = null;
        if (typeof entry === 'string') {
            declaration = { id: entry };
        }
        else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
            const candidate = entry;
            if (typeof candidate.id === 'string') {
                declaration = { id: candidate.id };
                if (typeof candidate.remote === 'string' && candidate.remote.length > 0) {
                    declaration.remote = candidate.remote;
                }
                else if (candidate.remote !== undefined) {
                    droppedRemotes = true; // remote dropped, id kept
                }
            }
        }
        if (!declaration) {
            droppedEntries = true;
            continue;
        }
        const existing = byId.get(declaration.id);
        if (!existing) {
            byId.set(declaration.id, declaration);
        }
        else if (existing.remote === undefined && declaration.remote !== undefined) {
            existing.remote = declaration.remote;
        }
    }
    if (droppedEntries) {
        console.warn(`Some '${fieldName}' entries are invalid, ignoring them`);
    }
    if (droppedRemotes) {
        console.warn(`Some '${fieldName}' remotes are not non-empty strings; the ids are kept without a clone source`);
    }
    return byId.size > 0 ? [...byId.values()] : undefined;
}
export const MAX_CONTEXT_SIZE = 50 * 1024; // 50KB hard limit, shared with the references index
/**
 * Build the warning for an artifact whose `rules:` list is not an array of
 * strings. Names the offending index and what YAML actually produced there, so
 * a config that silently loses an entire rule set can be fixed without
 * bisecting the list by hand. A bare `-` item containing an unquoted ": " is the
 * common cause: YAML reads it as a mapping, so the hint points at quoting.
 */
function describeRulesShapeError(artifactId, rules) {
    const base = `Rules for '${artifactId}' must be an array of strings, ignoring this artifact's rules`;
    if (!Array.isArray(rules)) {
        return `${base}. rules.${artifactId} is ${describeYamlType(rules)}`;
    }
    const bad = rules
        .map((rule, index) => ({ rule, index }))
        .filter(({ rule }) => typeof rule !== 'string');
    if (bad.length === 0) {
        return base;
    }
    // Name every offending index with its own shape, so a mixed list does not
    // have to be re-bisected one item at a time.
    const details = bad
        .map(({ rule, index }) => `rules.${artifactId}[${index}] is ${describeYamlType(rule)}`)
        .join('; ');
    // A bare `-` item with an unquoted ": " is the common cause: YAML reads it as
    // a mapping. Say so rather than leaving the reader to work out the quoting.
    const hasMapping = bad.some(({ rule }) => rule !== null && typeof rule === 'object' && !Array.isArray(rule));
    const hint = hasMapping
        ? ' — an unquoted ": " makes YAML read the item as a key/value pair; quote the whole scalar to keep it a string.'
        : '';
    return `${base}. ${details}${hint}`;
}
/** Name a YAML value's shape in a warning, e.g. "a mapping" or "a number". */
function describeYamlType(value) {
    if (value === null)
        return 'null';
    if (Array.isArray(value))
        return 'a nested list';
    const type = typeof value;
    if (type === 'object')
        return 'a mapping';
    if (type === 'number' || type === 'boolean')
        return `a ${type}`;
    return `a ${type}`;
}
/**
 * Read and parse openspec/config.yaml from project root.
 * Uses resilient parsing - validates each field independently using Zod safeParse.
 * Returns null if file doesn't exist.
 * Returns partial config if some fields are invalid (with warnings).
 *
 * Performance note (Jan 2025):
 * Benchmarks showed direct file reads are fast enough without caching:
 * - Typical config (1KB): ~0.5ms per read
 * - Large config (50KB): ~1.6ms per read
 * - Missing config: ~0.01ms per read
 * Config is read 1-2 times per command (schema resolution + instruction loading),
 * adding ~1-3ms total overhead. Caching would add complexity (mtime checks,
 * invalidation logic) for negligible benefit. Direct reads also ensure config
 * changes are reflected immediately without stale cache issues.
 *
 * @param projectRoot - The root directory of the project (where `openspec/` lives)
 * @returns Parsed config or null if file doesn't exist
 */
export function readProjectConfig(projectRoot) {
    const configPath = resolveConfigFilePath(projectRoot);
    if (configPath === null) {
        return null; // No config is OK
    }
    try {
        const content = readFileSync(configPath, 'utf-8');
        const raw = parseYaml(content);
        if (!raw || typeof raw !== 'object') {
            console.warn(`openspec/config.yaml is not a valid YAML object`);
            return null;
        }
        const config = {};
        // Parse schema field using Zod
        const schemaField = z.string().min(1);
        const schemaResult = schemaField.safeParse(raw.schema);
        if (schemaResult.success) {
            config.schema = schemaResult.data;
        }
        else if (raw.schema !== undefined) {
            console.warn(`Invalid 'schema' field in config (must be non-empty string)`);
        }
        // Parse context field with size limit
        if (raw.context !== undefined) {
            const contextField = z.string();
            const contextResult = contextField.safeParse(raw.context);
            if (contextResult.success) {
                const contextSize = Buffer.byteLength(contextResult.data, 'utf-8');
                if (contextSize > MAX_CONTEXT_SIZE) {
                    console.warn(`Context too large (${(contextSize / 1024).toFixed(1)}KB, limit: ${MAX_CONTEXT_SIZE / 1024}KB)`);
                    console.warn(`Ignoring context field`);
                }
                else {
                    config.context = contextResult.data;
                }
            }
            else {
                console.warn(`Invalid 'context' field in config (must be string)`);
            }
        }
        // Parse rules field using Zod
        if (raw.rules !== undefined) {
            const rulesField = z.record(z.string(), z.array(z.string()));
            // First check if it's an object structure (guard against null since typeof null === 'object')
            if (typeof raw.rules === 'object' && raw.rules !== null && !Array.isArray(raw.rules)) {
                // Artifact ids are intentionally not restricted to the built-in naming
                // convention, so keys such as "constructor" remain valid for custom
                // schemas. A null-prototype map preserves those keys as data without
                // letting "__proto__" mutate the lookup object's prototype.
                const parsedRules = Object.create(null);
                let hasValidRules = false;
                for (const [artifactId, rules] of Object.entries(raw.rules)) {
                    const rulesArrayResult = z.array(z.string()).safeParse(rules);
                    if (rulesArrayResult.success) {
                        // Filter out empty strings
                        const validRules = rulesArrayResult.data.filter((r) => r.length > 0);
                        if (validRules.length > 0) {
                            parsedRules[artifactId] = validRules;
                            hasValidRules = true;
                        }
                        if (validRules.length < rulesArrayResult.data.length) {
                            console.warn(`Some rules for '${artifactId}' are empty strings, ignoring them`);
                        }
                    }
                    else {
                        console.warn(describeRulesShapeError(artifactId, rules));
                    }
                }
                if (hasValidRules) {
                    config.rules = parsedRules;
                }
            }
            else {
                console.warn(`Invalid 'rules' field in config (must be object)`);
            }
        }
        const operations = parseOperations(raw.operations);
        if (operations) {
            config.operations = operations;
        }
        const references = parseDeclarationList(raw.references);
        if (references) {
            config.references = references;
        }
        // Parse store pointer field: a string, or dropped with a warning.
        // (Root resolution does NOT use this parse — it uses readStorePointer
        // below, which errors on malformed pointers instead of dropping.)
        if (raw.store !== undefined) {
            if (typeof raw.store === 'string') {
                config.store = raw.store;
            }
            else {
                console.warn(`Warning: ignoring invalid store: field in ${configPathForWarnings(projectRoot)} (must be a single store id string).`);
            }
        }
        // Parse githubCopilot preferences (only cloudAgent is recognized today).
        if (raw.githubCopilot !== undefined) {
            if (typeof raw.githubCopilot === 'object' &&
                raw.githubCopilot !== null &&
                !Array.isArray(raw.githubCopilot)) {
                const cloudAgent = raw.githubCopilot.cloudAgent;
                if (typeof cloudAgent === 'boolean') {
                    config.githubCopilot = { cloudAgent };
                }
                else if (cloudAgent !== undefined) {
                    console.warn(`Invalid 'githubCopilot.cloudAgent' field in config (must be a boolean)`);
                }
            }
            else {
                console.warn(`Invalid 'githubCopilot' field in config (must be an object)`);
            }
        }
        // Return partial config even if some fields failed
        return Object.keys(config).length > 0 ? config : null;
    }
    catch (error) {
        console.warn(`Warning: could not parse ${configPathForWarnings(projectRoot)} (${error instanceof Error ? error.message.split('\n')[0] : String(error)}); ignoring it.`);
        return null;
    }
}
function configPathForWarnings(projectRoot) {
    return resolveConfigFilePath(projectRoot) ?? path.join(projectRoot, 'openspec', 'config.yaml');
}
/**
 * Validate artifact IDs in rules against the artifacts of every available
 * schema. The `rules:` map is global, but each change can use a different
 * schema, so a key is only unknown when it matches no artifact in ANY schema.
 * Returns warnings for keys that are unknown everywhere.
 *
 * @param rules - The rules object from config
 * @param validArtifactIds - Set of valid artifact IDs across all schemas
 * @returns Array of warning messages for unknown artifact IDs
 */
export function validateConfigRules(rules, validArtifactIds) {
    const warnings = [];
    for (const artifactId of Object.keys(rules)) {
        if (!validArtifactIds.has(artifactId)) {
            const validIds = Array.from(validArtifactIds).sort().join(', ');
            warnings.push(`Unknown artifact ID in rules: "${artifactId}". ` +
                `It matches no artifact in any available schema. Known artifact IDs: ${validIds}`);
        }
    }
    return warnings;
}
/**
 * Suggest valid schema names when user provides invalid schema.
 * Uses fuzzy matching to find similar names.
 *
 * @param invalidSchemaName - The invalid schema name from config
 * @param availableSchemas - List of available schemas with their type (built-in or project-local)
 * @returns Error message with suggestions and available schemas
 */
export function suggestSchemas(invalidSchemaName, availableSchemas) {
    // Simple fuzzy match: Levenshtein distance
    function levenshtein(a, b) {
        const matrix = [];
        for (let i = 0; i <= b.length; i++) {
            matrix[i] = [i];
        }
        for (let j = 0; j <= a.length; j++) {
            matrix[0][j] = j;
        }
        for (let i = 1; i <= b.length; i++) {
            for (let j = 1; j <= a.length; j++) {
                if (b.charAt(i - 1) === a.charAt(j - 1)) {
                    matrix[i][j] = matrix[i - 1][j - 1];
                }
                else {
                    matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
                }
            }
        }
        return matrix[b.length][a.length];
    }
    // Find closest matches (distance <= 3)
    const suggestions = availableSchemas
        .map((s) => ({ ...s, distance: levenshtein(invalidSchemaName, s.name) }))
        .filter((s) => s.distance <= 3)
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 3);
    const builtIn = availableSchemas.filter((s) => s.isBuiltIn).map((s) => s.name);
    const projectLocal = availableSchemas.filter((s) => !s.isBuiltIn).map((s) => s.name);
    let message = `Schema '${invalidSchemaName}' not found in openspec/config.yaml\n\n`;
    if (suggestions.length > 0) {
        message += `Did you mean one of these?\n`;
        suggestions.forEach((s) => {
            const type = s.isBuiltIn ? 'built-in' : 'project-local';
            message += `  - ${s.name} (${type})\n`;
        });
        message += '\n';
    }
    message += `Available schemas:\n`;
    if (builtIn.length > 0) {
        message += `  Built-in: ${builtIn.join(', ')}\n`;
    }
    if (projectLocal.length > 0) {
        message += `  Project-local: ${projectLocal.join(', ')}\n`;
    }
    else {
        message += `  Project-local: (none found)\n`;
    }
    message += `\nFix: Edit openspec/config.yaml and change 'schema: ${invalidSchemaName}' to a valid schema name`;
    return message;
}
/**
 * Warning-silent targeted read of the `store:` pointer. Used by root
 * resolution (which must not re-emit the resilient parser's field
 * warnings) and by `openspec init`'s pointer guard. Unlike
 * `readProjectConfig`, a malformed value is REPORTED, not dropped —
 * a dropped pointer would silently flip where work lands.
 */
export function readStorePointer(projectRoot) {
    const configPath = resolveConfigFilePath(projectRoot);
    if (configPath === null) {
        return { filePath: null };
    }
    try {
        const raw = parseYaml(readFileSync(configPath, 'utf-8'));
        // Empty, comments-only, or non-mapping configs carry no pointer;
        // they are imperfect, not malformed (readProjectConfig owns the
        // field warnings for those).
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            return { filePath: configPath };
        }
        const value = raw.store;
        if (value === undefined) {
            return { filePath: configPath };
        }
        if (typeof value === 'string') {
            return { value, filePath: configPath };
        }
        return { malformed: 'non_string', filePath: configPath };
    }
    catch {
        return { malformed: 'unparseable', filePath: configPath };
    }
}
/** Shared .yaml/.yml probe used by readProjectConfig and readStorePointer. */
export function resolveConfigFilePath(projectRoot) {
    const yamlPath = path.join(projectRoot, 'openspec', 'config.yaml');
    if (existsSync(yamlPath)) {
        return yamlPath;
    }
    const ymlPath = path.join(projectRoot, 'openspec', 'config.yml');
    return existsSync(ymlPath) ? ymlPath : null;
}
/** Human rendering of a malformed pointer reason, shared by every surface. */
export function storePointerProblem(reason) {
    return reason === 'unparseable'
        ? 'the config file could not be read as YAML'
        : 'the store key must be a single store id string';
}
/**
 * One classification for "real root vs config-only pointer dir", shared
 * by root resolution and the init pointer guard so they can never
 * disagree (slice 3.2).
 *
 * A specs/ or changes/ directory carrying store metadata is a store at
 * the recommended `~/openspec/<id>` layout whose id is `specs` or
 * `changes`, not planning content of the directory above it. Counting it
 * would make $HOME the phantom root the qualifying walk exists to prevent.
 */
export function classifyOpenSpecDir(projectRoot) {
    const openspecDir = path.join(projectRoot, 'openspec');
    const hasPlanningShape = isPlanningDirectorySync(path.join(openspecDir, 'specs')) ||
        isPlanningDirectorySync(path.join(openspecDir, 'changes'));
    return { hasPlanningShape, pointer: readStorePointer(projectRoot) };
}
function isPlanningDirectorySync(candidatePath) {
    return isDirectorySync(candidatePath) && !existsSync(getStoreMetadataPath(candidatePath));
}
function isDirectorySync(candidatePath) {
    try {
        return statSync(candidatePath).isDirectory();
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=project-config.js.map