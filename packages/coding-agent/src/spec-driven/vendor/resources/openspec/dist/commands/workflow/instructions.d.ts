/**
 * Instructions Command
 *
 * Generates enriched instructions for creating artifacts or applying tasks.
 * Includes both artifact instructions and apply instructions.
 */
import { type ArtifactInstructions } from '../../core/artifact-graph/index.js';
import { type PlanningHome } from '../../core/planning-home.js';
import { type ReferenceIndexEntry } from '../../core/references.js';
import { type ProjectConfig } from '../../core/project-config.js';
import { type ApplyInstructions, type ArchiveInstructions } from './shared.js';
export interface InstructionsOptions {
    change?: string;
    schema?: string;
    store?: string;
    storePath?: string;
    json?: boolean;
}
export interface ApplyInstructionsOptions {
    change?: string;
    schema?: string;
    store?: string;
    storePath?: string;
    json?: boolean;
}
export type ArchiveInstructionsOptions = ApplyInstructionsOptions;
export declare function instructionsCommand(artifactId: string | undefined, options: InstructionsOptions): Promise<void>;
export declare function printInstructionsText(instructions: ArtifactInstructions, isBlocked: boolean): void;
export interface GenerateApplyInstructionsOptions {
    planningHome?: PlanningHome;
    references?: ReferenceIndexEntry[];
    projectConfig?: ProjectConfig | null;
}
/**
 * Generates apply instructions for implementing tasks from a change.
 * Schema-aware: reads apply phase configuration from schema to determine
 * required artifacts, tracking file, and instruction.
 */
export declare function generateApplyInstructions(projectRoot: string, changeName: string, schemaName?: string, options?: GenerateApplyInstructionsOptions): Promise<ApplyInstructions>;
export declare function applyInstructionsCommand(options: ApplyInstructionsOptions): Promise<void>;
export declare function printApplyInstructionsText(instructions: ApplyInstructions): void;
export declare function generateArchiveInstructions(changeName: string, projectConfig: ProjectConfig | null): ArchiveInstructions;
export declare function archiveInstructionsCommand(options: ArchiveInstructionsOptions): Promise<void>;
export declare function printArchiveInstructionsText(instructions: ArchiveInstructions): void;
//# sourceMappingURL=instructions.d.ts.map