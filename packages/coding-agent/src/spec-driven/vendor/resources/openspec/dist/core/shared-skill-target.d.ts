import { type AIToolOption } from './config.js';
import { type FileView } from './file-view.js';
/** Reads a valid-looking marker value without letting linked roots escape. */
export declare function readSharedSkillTarget(projectPath: string, skillsDir: string, view?: FileView): string | undefined;
/** Whether a tool still has an allowlisted managed skill under an old root. */
export declare function hasLegacySkills(projectPath: string, tool: AIToolOption, view?: FileView): boolean;
/**
 * Chooses the one selected tool that may render each physical skills root.
 * Command files are not part of this arbitration: tools that share a skills
 * root can still write their own command surface elsewhere under that root.
 *
 * Existing compatible owners win. On a new root, prefer a skills-native
 * renderer over an adapter-backed renderer because its references remain
 * usable by every consumer of the shared tree. Codex is the best fresh owner
 * because its renderer includes both Codex and generic skill invocation forms.
 */
export declare function resolveSharedSkillWriters(projectPath: string, tools: AIToolOption[], view?: FileView): Set<string>;
/**
 * A shared skill root can only hold one rendered variant of each skill.
 * Keep the writer recorded so later updates do not infer every tool that
 * happens to use the same directory.
 */
export declare function reconcileSharedSkillTargets(projectPath: string, tools: AIToolOption[], view?: FileView): AIToolOption[];
/**
 * Returns whether a tool is the active writer for its physical skills root.
 * Non-shared roots are always active.
 */
export declare function isSharedSkillTargetActive(projectPath: string, toolId: string, view?: FileView): boolean;
/**
 * The tool that already owns `toolId`'s shared skills root, when a DIFFERENT
 * one does. Returns the owner's tool id only when the root already carries an
 * ownership signal (a marker or generated skills) AND reconciliation resolves
 * it to another tool. An empty or unclaimed root returns undefined, so a
 * genuine first-time legacy upgrade — e.g. a Codex-only user with no `.agents`
 * yet — is never reported as owned.
 */
export declare function sharedSkillRootOwner(projectPath: string, toolId: string): string | undefined;
/**
 * Whether generating `toolId` into its shared skills root would clobber a tree
 * a DIFFERENT tool already owns — the guard the legacy-upgrade path uses before
 * writing skills. See {@link sharedSkillRootOwner} for the ownership rules.
 */
export declare function sharedSkillRootOwnedByOther(projectPath: string, toolId: string): boolean;
/**
 * Path of the owner marker for a tool's shared skills root, or null when the
 * tool has no shared root to mark. Lets a caller write the marker itself —
 * `update` routes it through its write seam so a dry run can list it.
 */
export declare function sharedSkillTargetMarkerPath(projectPath: string, toolId: string): string | null;
export declare function writeSharedSkillTarget(projectPath: string, toolId: string): void;
//# sourceMappingURL=shared-skill-target.d.ts.map