import { ArtifactGraph } from './graph.js';
import { type ActionContext, type PlanningHomeSummary } from '../change-status-policy.js';
import { type ProjectConfig } from '../project-config.js';
import type { ReferenceIndexEntry } from '../references.js';
import type { PlanningHome } from '../planning-home.js';
import type { ChangeMetadata } from '../change-metadata/index.js';
import type { CompletedSet } from './types.js';
/**
 * Error thrown when loading a template fails.
 */
export declare class TemplateLoadError extends Error {
    readonly templatePath: string;
    constructor(message: string, templatePath: string);
}
/**
 * Change context containing graph, completion state, and metadata.
 */
export interface ChangeContext {
    /** The artifact dependency graph */
    graph: ArtifactGraph;
    /** Set of completed artifact IDs */
    completed: CompletedSet;
    /** Schema name being used */
    schemaName: string;
    /** Change name */
    changeName: string;
    /** Path to the change directory */
    changeDir: string;
    /** Project root directory */
    projectRoot: string;
    /** Resolved planning home for this change */
    planningHome?: PlanningHome;
    /** Parsed change metadata, when present */
    metadata?: ChangeMetadata;
    /** Non-fatal metadata diagnostics for text and JSON command surfaces */
    warnings?: string[];
    /**
     * Artifact IDs counted as complete only because the change declares
     * skip_specs, not because their files exist. Kept separate so status can
     * render them as skipped rather than done.
     */
    skippedArtifacts?: Set<string>;
}
export interface LoadChangeContextOptions {
    changeDir?: string;
    planningHome?: PlanningHome;
    /** Pre-read project config; suppresses schema resolution's fallback config read. */
    projectConfig?: ProjectConfig | null;
}
/**
 * Enriched instructions for creating an artifact.
 */
export interface ArtifactInstructions {
    /** Change name */
    changeName: string;
    /** Artifact ID */
    artifactId: string;
    /** Schema name */
    schemaName: string;
    /** Full path to change directory */
    changeDir: string;
    /** Resolved planning home for this change */
    planningHome?: PlanningHomeSummary;
    /** Output path pattern (e.g., "proposal.md") */
    outputPath: string;
    /** Absolute output path or glob pattern resolved under the change directory */
    resolvedOutputPath: string;
    /** Existing concrete output files for this artifact */
    existingOutputPaths: string[];
    /** Artifact description */
    description: string;
    /** Guidance on how to create this artifact (from schema instruction field) */
    instruction: string | undefined;
    /** Project context from config (constraints/background for AI, not to be included in output) */
    context: string | undefined;
    /** Artifact-specific rules from config (constraints for AI, not to be included in output) */
    rules: string[] | undefined;
    /** Referenced-store index (read-only upstream context; omitted when no references are declared) */
    references?: ReferenceIndexEntry[];
    /** Template content (structure to follow - this IS the output format) */
    template: string;
    /** Dependencies with completion status and paths */
    dependencies: DependencyInfo[];
    /** Artifacts that become available after completing this one */
    unlocks: string[];
    /** True when the change declares skip_specs and this artifact is skipped */
    skipped?: boolean;
    /** Present only when skipped: tells the consumer not to create the artifact */
    warning?: string;
    /** Non-fatal metadata diagnostics */
    warnings?: string[];
}
/**
 * Warning attached to instructions for an artifact skipped via skip_specs.
 * Carried in the JSON payload too, so agents driving the CLI with --json see
 * the same do-not-create signal as the text output.
 */
export declare const SKIP_SPECS_INSTRUCTIONS_WARNING: string;
/**
 * Dependency information including path and description.
 */
export interface DependencyInfo {
    /** Artifact ID */
    id: string;
    /** Whether the dependency is completed */
    done: boolean;
    /** Relative output path of the dependency (e.g., "proposal.md") */
    path: string;
    /** Description of the dependency artifact */
    description: string;
    /** True when the dependency is satisfied via skip_specs - no files exist to read */
    skipped?: boolean;
}
/**
 * Status of a single artifact in the workflow.
 */
export interface ArtifactStatus {
    /** Artifact ID */
    id: string;
    /** Output path pattern */
    outputPath: string;
    /** Status: done, skipped (via skip_specs), ready, or blocked */
    status: 'done' | 'skipped' | 'ready' | 'blocked';
    /** Artifact IDs this artifact directly requires (its `requires` edges).
     * Present for every status so callers can compute the transitive required
     * set even when the artifact is already `done` (file-existence status does
     * not imply its dependencies exist). */
    requires: string[];
    /** Missing dependencies (only for blocked) */
    missingDeps?: string[];
}
/**
 * Formatted change status.
 */
export interface ChangeStatus {
    /** Change name */
    changeName: string;
    /** Schema name */
    schemaName: string;
    /** Planning home facts (generated skills derive the archive dir
     * from planningHome.changesDir - a published agent contract). */
    planningHome?: PlanningHomeSummary;
    /** Full path to the change root */
    changeRoot: string;
    /** Absolute artifact path details keyed by artifact ID */
    artifactPaths: Record<string, ArtifactPathSummary>;
    /** Plain-language next steps for users and agents */
    nextSteps: string[];
    /** Machine-readable action constraints for agents */
    actionContext: ActionContext;
    /** Whether all planning artifacts are complete */
    isPlanningComplete: boolean;
    /** Compatibility alias for isPlanningComplete */
    isComplete: boolean;
    /** Artifact IDs required before apply phase (from schema's apply.requires) */
    applyRequires: string[];
    /** Status of each artifact */
    artifacts: ArtifactStatus[];
    /** Non-fatal metadata diagnostics */
    warnings?: string[];
}
export interface ArtifactPathSummary {
    outputPath: string;
    resolvedOutputPath: string;
    existingOutputPaths: string[];
}
/**
 * Loads a template from a schema's templates directory.
 *
 * @param schemaName - Schema name (e.g., "spec-driven")
 * @param templatePath - Relative path within the templates directory (e.g., "proposal.md")
 * @param projectRoot - Optional project root for project-local schema resolution
 * @returns The template content
 * @throws TemplateLoadError if the template cannot be loaded
 */
export declare function loadTemplate(schemaName: string, templatePath: string, projectRoot?: string): string;
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
export declare function loadChangeContext(projectRoot: string, changeName: string, schemaName?: string, options?: LoadChangeContextOptions): ChangeContext;
/**
 * Generates enriched instructions for creating an artifact.
 *
 * Instruction injection order:
 * 1. <context> - Project context from config (if present)
 * 2. <rules> - Artifact-specific rules from config (if present)
 * 3. <template> - Schema's template content
 *
 * @param context - Change context
 * @param artifactId - Artifact ID to generate instructions for
 * @param projectRoot - Project root directory (for reading config)
 * @returns Enriched artifact instructions
 * @throws Error if artifact not found
 */
export interface GenerateInstructionsOptions {
    /** Pre-read project config; suppresses the internal read (no double read). */
    projectConfig?: ProjectConfig | null;
    /** Referenced-store index assembled at the command boundary. */
    references?: ReferenceIndexEntry[];
}
export declare function generateInstructions(context: ChangeContext, artifactId: string, projectRoot?: string, options?: GenerateInstructionsOptions): ArtifactInstructions;
/**
 * Formats the status of all artifacts in a change.
 *
 * @param context - Change context
 * @returns Formatted change status
 */
export declare function formatChangeStatus(context: ChangeContext, options?: {
    storeId?: string;
    implementationRoot?: string;
}): ChangeStatus;
//# sourceMappingURL=instruction-loader.d.ts.map