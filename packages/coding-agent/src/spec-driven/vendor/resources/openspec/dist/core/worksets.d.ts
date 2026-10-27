import { StoreError } from './store/errors.js';
/**
 * Personal worksets (slice 7.1): purely local, manually composed,
 * named working views. The whole feature's state lives under
 * <globalDataDir>/worksets/ - the saved-views file plus the generated
 * .code-workspace files - so deleting that one directory removes
 * every trace. Nothing here is committed, shared, or derived from
 * declarations, and nothing is ever written into a member folder.
 */
export declare const WORKSETS_DIR_NAME = "worksets";
export declare const WORKSETS_FILE_NAME = "worksets.yaml";
export interface WorksetPathOptions {
    globalDataDir?: string;
}
export interface WorksetMember {
    /** Display label; the .code-workspace folder name. */
    name: string;
    /** Absolute path to the member directory. */
    path: string;
}
export interface Workset {
    name: string;
    /** Preferred opener id; validated only at open time. */
    tool?: string;
    /** Ordered; the first member is the primary (session cwd). */
    members: WorksetMember[];
}
export interface WorksetsState {
    version: 1;
    worksets: Record<string, {
        tool?: string;
        members: WorksetMember[];
    }>;
}
export declare function getWorksetsDir(options?: WorksetPathOptions): string;
export declare function getWorksetsFilePath(options?: WorksetPathOptions): string;
export declare function getWorksetCodeWorkspacePath(name: string, options?: WorksetPathOptions): string;
export declare function validateWorksetName(name: string): string;
/**
 * Returns a problem description for a member list, or null when valid.
 * Shared by the file parser (wrapping as invalid_workset_file) and the
 * compose flow (wrapping as workset_member_invalid).
 */
export declare function memberListProblem(members: WorksetMember[]): string | null;
export declare function memberLabelProblem(label: string): string | null;
export declare function parseWorksetsState(content: string, options?: WorksetPathOptions): WorksetsState;
export declare function serializeWorksetsState(state: WorksetsState, options?: WorksetPathOptions): string;
/** Absent file reads as the empty state; a corrupt file throws. */
export declare function readWorksetsState(options?: WorksetPathOptions): Promise<WorksetsState>;
export declare function updateWorksetsState(updater: (state: WorksetsState) => WorksetsState | Promise<WorksetsState>, options?: WorksetPathOptions): Promise<WorksetsState>;
/**
 * Lock-scoped read without a write-back of the saved-views file.
 * `open` uses this to read the state and regenerate the derived
 * .code-workspace coherently; the lock is released before any spawn.
 */
export declare function withWorksetsLock<T>(fn: (state: WorksetsState) => T | Promise<T>, options?: WorksetPathOptions): Promise<T>;
export declare function worksetNotFoundError(name: string, state: WorksetsState): StoreError;
export declare function withWorkset(state: WorksetsState, workset: Workset): WorksetsState;
export declare function withoutWorkset(state: WorksetsState, name: string): WorksetsState;
/**
 * Removes a saved workset and its derived .code-workspace under one
 * lock. The derived-file cleanup runs AFTER the durable write (a
 * failed write must not have already destroyed the artifact); a
 * never-opened workset has no file - ENOENT is fine.
 */
export declare function removeWorkset(name: string, options?: WorksetPathOptions): Promise<void>;
export declare function listWorksets(state: WorksetsState): Workset[];
export declare function getWorkset(state: WorksetsState, name: string): Workset | null;
/**
 * The generated .code-workspace content: members in saved order with
 * their saved names, absolute paths, two-space JSON, trailing newline
 * (the working-set builder's conventions).
 */
export declare function buildWorksetCodeWorkspaceJson(members: WorksetMember[]): string;
//# sourceMappingURL=worksets.d.ts.map