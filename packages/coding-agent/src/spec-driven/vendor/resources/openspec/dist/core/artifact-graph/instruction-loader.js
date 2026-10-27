import * as fs from 'node:fs';
import * as path from 'node:path';
import { getSchemaDir, resolveSchema, listSchemasWithInfo } from './resolver.js';
import { ArtifactGraph } from './graph.js';
import { detectCompleted } from './state.js';
import { isSpecsArtifactPath, resolveArtifactOutputPath, resolveArtifactOutputs, } from './outputs.js';
import { formatUnknownChangeMetadataKeysMessage, readChangeMetadata, readUnknownChangeMetadataKeys, resolveSchemaForChange, } from '../../utils/change-metadata.js';
import { FileSystemUtils } from '../../utils/file-system.js';
import { buildActionContext, buildNextSteps, summarizePlanningHome, } from '../change-status-policy.js';
import { readProjectConfig, validateConfigRules } from '../project-config.js';
// Session-level cache for validation warnings (avoid repeating same warnings)
const shownWarnings = new Set();
/**
 * Error thrown when loading a template fails.
 */
export class TemplateLoadError extends Error {
    templatePath;
    constructor(message, templatePath) {
        super(message);
        this.templatePath = templatePath;
        this.name = 'TemplateLoadError';
    }
}
/**
 * Warning attached to instructions for an artifact skipped via skip_specs.
 * Carried in the JSON payload too, so agents driving the CLI with --json see
 * the same do-not-create signal as the text output.
 */
export const SKIP_SPECS_INSTRUCTIONS_WARNING = 'This change declares skip_specs: true in .openspec.yaml (no spec-level behavior changes), so this artifact is skipped.\n' +
    'Do not create spec files - they will conflict with that marker. If requirements now change, remove skip_specs from .openspec.yaml and rerun this command.';
/**
 * Loads a template from a schema's templates directory.
 *
 * @param schemaName - Schema name (e.g., "spec-driven")
 * @param templatePath - Relative path within the templates directory (e.g., "proposal.md")
 * @param projectRoot - Optional project root for project-local schema resolution
 * @returns The template content
 * @throws TemplateLoadError if the template cannot be loaded
 */
export function loadTemplate(schemaName, templatePath, projectRoot) {
    const schemaDir = getSchemaDir(schemaName, projectRoot);
    if (!schemaDir) {
        throw new TemplateLoadError(`Schema '${schemaName}' not found`, templatePath);
    }
    const templatesDir = path.join(schemaDir, 'templates');
    const templatePathOnDisk = path.join(templatesDir, templatePath);
    try {
        FileSystemUtils.assertPathWithin(templatesDir, templatePathOnDisk);
    }
    catch (error) {
        throw new TemplateLoadError(error instanceof Error ? error.message : String(error), templatePathOnDisk);
    }
    if (!fs.existsSync(templatePathOnDisk)) {
        throw new TemplateLoadError(`Template not found: ${templatePathOnDisk}`, templatePathOnDisk);
    }
    const fullPath = FileSystemUtils.canonicalizeExistingPath(templatePathOnDisk);
    try {
        return fs.readFileSync(fullPath, 'utf-8');
    }
    catch (err) {
        const ioError = err instanceof Error ? err : new Error(String(err));
        throw new TemplateLoadError(`Failed to read template: ${ioError.message}`, fullPath);
    }
}
/**
 * Loads change context combining graph and completion state.
 *
 * Schema resolution order:
 * 1. Explicit schemaName parameter (if provided)
 * 2. Schema from .openspec.yaml metadata (if exists in change directory)
 * 3. Default 'spec-driven'
 *
 * @param projectRoot - Project root directory
 * @param changeName - Change name
 * @param schemaName - Optional schema name override. If not provided, auto-detected from metadata.
 * @returns Change context with graph, completed set, and metadata
 */
export function loadChangeContext(projectRoot, changeName, schemaName, options = {}) {
    const changeDir = FileSystemUtils.canonicalizeExistingPath(options.changeDir ?? path.join(projectRoot, 'openspec', 'changes', changeName));
    const metadata = readChangeMetadata(changeDir, projectRoot) ?? undefined;
    const unknownMetadataKeys = readUnknownChangeMetadataKeys(changeDir);
    const warnings = unknownMetadataKeys.length > 0
        ? [formatUnknownChangeMetadataKeysMessage(unknownMetadataKeys)]
        : [];
    const resolvedSchemaName = resolveSchemaForChange(changeDir, schemaName, projectRoot, {
        metadata: metadata ?? null,
        projectConfig: options.projectConfig,
    });
    const schema = resolveSchema(resolvedSchemaName, projectRoot);
    const graph = ArtifactGraph.fromSchema(schema);
    const completed = detectCompleted(graph, changeDir);
    // A change that declares skip_specs has no spec deltas by design, so
    // artifacts generating into specs/ count as complete; otherwise the graph
    // would block their dependents (e.g. tasks) on files that must not exist.
    // Tracked separately so status renders them as skipped, not done.
    const skippedArtifacts = new Set();
    if (metadata?.skip_specs) {
        for (const artifact of graph.getAllArtifacts()) {
            if (isSpecsArtifactPath(artifact.generates) && !completed.has(artifact.id)) {
                completed.add(artifact.id);
                skippedArtifacts.add(artifact.id);
            }
        }
    }
    return {
        graph,
        completed,
        schemaName: resolvedSchemaName,
        changeName,
        changeDir,
        projectRoot,
        ...(options.planningHome ? { planningHome: options.planningHome } : {}),
        ...(metadata ? { metadata } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(skippedArtifacts.size > 0 ? { skippedArtifacts } : {}),
    };
}
export function generateInstructions(context, artifactId, projectRoot, options = {}) {
    const artifact = context.graph.getArtifact(artifactId);
    if (!artifact) {
        throw new Error(`Artifact '${artifactId}' not found in schema '${context.schemaName}'`);
    }
    const templateContent = loadTemplate(context.schemaName, artifact.template, context.projectRoot);
    const dependencies = getDependencyInfo(artifact, context.graph, context.completed, context.skippedArtifacts);
    const unlocks = getUnlockedArtifacts(context.graph, artifactId);
    // Use projectRoot from context if not explicitly provided
    const effectiveProjectRoot = projectRoot ?? context.projectRoot;
    // Use the pre-read config when provided; otherwise read it here.
    let projectConfig = options.projectConfig ?? null;
    if (options.projectConfig === undefined && effectiveProjectRoot) {
        try {
            projectConfig = readProjectConfig(effectiveProjectRoot);
        }
        catch {
            // If config read fails, continue without config
        }
    }
    // Validate rules artifact IDs if config has rules (only once per session).
    // The rules map is global while each change can use a different schema, so a
    // key is only "unknown" when it matches no artifact in ANY available schema.
    if (projectConfig?.rules) {
        const validArtifactIds = new Set(listSchemasWithInfo(effectiveProjectRoot ?? undefined).flatMap((s) => s.artifacts));
        const warnings = validateConfigRules(projectConfig.rules, validArtifactIds);
        // Show each unique warning only once per session
        for (const warning of warnings) {
            if (!shownWarnings.has(warning)) {
                console.warn(warning);
                shownWarnings.add(warning);
            }
        }
    }
    // Extract context and rules as separate fields (not prepended to template)
    const configContext = projectConfig?.context?.trim() || undefined;
    const rulesForArtifact = projectConfig?.rules && Object.hasOwn(projectConfig.rules, artifactId)
        ? projectConfig.rules[artifactId]
        : undefined;
    const configRules = rulesForArtifact && rulesForArtifact.length > 0 ? rulesForArtifact : undefined;
    return {
        changeName: context.changeName,
        artifactId: artifact.id,
        schemaName: context.schemaName,
        changeDir: context.changeDir,
        planningHome: summarizePlanningHome(context.planningHome),
        outputPath: artifact.generates,
        resolvedOutputPath: resolveArtifactOutputPath(context.changeDir, artifact.generates),
        existingOutputPaths: resolveArtifactOutputs(context.changeDir, artifact.generates),
        description: artifact.description,
        instruction: artifact.instruction,
        context: configContext,
        rules: configRules,
        ...(options.references !== undefined ? { references: options.references } : {}),
        ...(context.warnings ? { warnings: context.warnings } : {}),
        ...(context.skippedArtifacts?.has(artifact.id)
            ? { skipped: true, warning: SKIP_SPECS_INSTRUCTIONS_WARNING }
            : {}),
        template: templateContent,
        dependencies,
        unlocks,
    };
}
/**
 * Gets dependency info including paths and descriptions.
 */
function getDependencyInfo(artifact, graph, completed, skippedArtifacts) {
    return artifact.requires.map(id => {
        const depArtifact = graph.getArtifact(id);
        return {
            id,
            done: completed.has(id),
            path: depArtifact?.generates ?? id,
            description: depArtifact?.description ?? '',
            ...(skippedArtifacts?.has(id) ? { skipped: true } : {}),
        };
    });
}
/**
 * Gets artifacts that become available after completing the given artifact.
 *
 * `getAllArtifacts()` already yields the schema's declaration order, so the list
 * is returned as collected: sorting it alphabetically would have `unlocks` name
 * the artifacts in a different order than `status` recommends them.
 */
function getUnlockedArtifacts(graph, artifactId) {
    const unlocks = [];
    for (const artifact of graph.getAllArtifacts()) {
        if (artifact.requires.includes(artifactId)) {
            unlocks.push(artifact.id);
        }
    }
    return unlocks;
}
/**
 * Formats the status of all artifacts in a change.
 *
 * @param context - Change context
 * @returns Formatted change status
 */
export function formatChangeStatus(context, options = {}) {
    // Load schema to get apply phase configuration
    const schema = resolveSchema(context.schemaName, context.projectRoot);
    const applyRequires = schema.apply?.requires ?? schema.artifacts.map(a => a.id);
    const artifacts = context.graph.getAllArtifacts();
    const ready = new Set(context.graph.getNextArtifacts(context.completed));
    const blocked = context.graph.getBlocked(context.completed);
    const artifactPaths = {};
    const artifactStatuses = artifacts.map(artifact => {
        artifactPaths[artifact.id] = {
            outputPath: artifact.generates,
            resolvedOutputPath: resolveArtifactOutputPath(context.changeDir, artifact.generates),
            existingOutputPaths: resolveArtifactOutputs(context.changeDir, artifact.generates),
        };
        if (context.skippedArtifacts?.has(artifact.id)) {
            return {
                id: artifact.id,
                outputPath: artifact.generates,
                status: 'skipped',
                requires: artifact.requires,
            };
        }
        if (context.completed.has(artifact.id)) {
            return {
                id: artifact.id,
                outputPath: artifact.generates,
                status: 'done',
                requires: artifact.requires,
            };
        }
        if (ready.has(artifact.id)) {
            return {
                id: artifact.id,
                outputPath: artifact.generates,
                status: 'ready',
                requires: artifact.requires,
            };
        }
        return {
            id: artifact.id,
            outputPath: artifact.generates,
            status: 'blocked',
            requires: artifact.requires,
            missingDeps: blocked[artifact.id] ?? [],
        };
    });
    // Sort by build order for consistent output
    const buildOrder = context.graph.getBuildOrder();
    const orderMap = new Map(buildOrder.map((id, idx) => [id, idx]));
    artifactStatuses.sort((a, b) => (orderMap.get(a.id) ?? 0) - (orderMap.get(b.id) ?? 0));
    const isComplete = context.graph.isComplete(context.completed);
    const artifactIds = artifactStatuses.map((artifact) => artifact.id);
    return {
        changeName: context.changeName,
        schemaName: context.schemaName,
        planningHome: summarizePlanningHome(context.planningHome),
        changeRoot: context.changeDir,
        artifactPaths,
        isPlanningComplete: isComplete,
        isComplete,
        applyRequires,
        nextSteps: buildNextSteps({
            changeName: context.changeName,
            artifactStatuses,
            allArtifactsComplete: isComplete,
            ...(options.storeId ? { storeId: options.storeId } : {}),
        }),
        actionContext: buildActionContext({
            projectRoot: context.projectRoot,
            artifactIds,
            ...(options.storeId
                ? {
                    store: {
                        id: options.storeId,
                        ...(options.implementationRoot
                            ? { implementationRoot: options.implementationRoot }
                            : {}),
                    },
                }
                : {}),
        }),
        artifacts: artifactStatuses,
        ...(context.warnings ? { warnings: context.warnings } : {}),
    };
}
//# sourceMappingURL=instruction-loader.js.map