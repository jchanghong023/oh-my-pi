/**
 * Profile System
 *
 * Defines workflow profiles that control which workflows are installed.
 * Profiles determine WHICH workflows; delivery (in global config) determines HOW.
 */
import type { Profile } from './global-config.js';
/**
 * Core workflows included in the 'core' profile.
 * These provide the streamlined experience for new users.
 */
export declare const CORE_WORKFLOWS: readonly ["propose", "explore", "apply", "update", "sync", "archive"];
/**
 * All available workflows in the system.
 */
export declare const ALL_WORKFLOWS: readonly ["propose", "explore", "new", "continue", "apply", "update", "ff", "sync", "archive", "bulk-archive", "verify", "onboard"];
export type WorkflowId = (typeof ALL_WORKFLOWS)[number];
export type CoreWorkflowId = (typeof CORE_WORKFLOWS)[number];
/**
 * Resolves which workflows should be active for a given profile configuration.
 *
 * - 'core' profile always returns CORE_WORKFLOWS
 * - 'custom' profile returns the provided customWorkflows and required dependencies
 */
export declare function getProfileWorkflows(profile: Profile, customWorkflows?: string[]): readonly string[];
//# sourceMappingURL=profiles.d.ts.map