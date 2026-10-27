import type { Delivery } from './global-config.js';
import { ALL_WORKFLOWS } from './profiles.js';
import { type FileView } from './file-view.js';
type WorkflowId = (typeof ALL_WORKFLOWS)[number];
/**
 * Maps workflow IDs to their skill directory names.
 */
export declare const WORKFLOW_TO_SKILL_DIR: Record<WorkflowId, string>;
/**
 * Returns tools that are configured via either skills or commands.
 */
export declare function getConfiguredToolsForProfileSync(projectPath: string, view?: FileView): string[];
/**
 * Detects if a single tool has profile/delivery drift against the desired state.
 *
 * This function covers:
 * - required artifacts missing for selected workflows
 * - artifacts that should not exist for the selected delivery mode
 * - artifacts for workflows that were deselected from the current profile
 */
export declare function hasToolProfileOrDeliveryDrift(projectPath: string, toolId: string, desiredWorkflows: readonly string[], delivery: Delivery, view?: FileView): boolean;
/**
 * Returns configured tools that currently need a profile/delivery sync.
 */
export declare function getToolsNeedingProfileSync(projectPath: string, desiredWorkflows: readonly string[], delivery: Delivery, configuredTools?: readonly string[], view?: FileView): string[];
/**
 * Detects whether the current project has any profile/delivery drift.
 */
export declare function hasProjectConfigDrift(projectPath: string, desiredWorkflows: readonly string[], delivery: Delivery): boolean;
export {};
//# sourceMappingURL=profile-sync-drift.d.ts.map