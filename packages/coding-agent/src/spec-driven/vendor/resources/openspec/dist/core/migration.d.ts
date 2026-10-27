/**
 * Migration Utilities
 *
 * One-time migration logic for existing projects when profile system is introduced.
 * Called by both init and update commands before profile resolution.
 */
import { type AIToolOption } from './config.js';
import { type Delivery, type GlobalConfig, type Profile } from './global-config.js';
import { type FileView } from './file-view.js';
export interface LegacyToolRoot {
    /** Former tool root, e.g. '.kimi' */
    root: string;
    /**
     * Whether leaving this root requires the user's say-so. False when the old
     * product is gone and its directory is certainly dead. True when the old
     * location may still be the live one for somebody.
     */
    needsConsent: boolean;
    /** Migrations that need a freshly generated destination run afterward. */
    timing?: 'before-generation' | 'after-generation';
}
/**
 * Former tool roots whose OpenSpec-managed content belongs under the tool's
 * current skillsDir. User files are never touched.
 */
export declare const LEGACY_TOOL_ROOTS: Record<string, LegacyToolRoot[]>;
export interface LegacyToolMigration {
    toolId: string;
    /** Legacy tool root, e.g. '.windsurf' */
    from: string;
    /** Current tool root, e.g. '.devin' */
    to: string;
    /** Skill directories that moved, or would move */
    skillDirs: number;
    /** Command files that moved, or would move */
    commandFiles: number;
    /**
     * OpenSpec-managed files left under the legacy root because the copy there
     * differs materially from the one that survives, so it is reported rather
     * than dropped.
     */
    keptInPlace: number;
    /** Whether this move needs the user's consent first */
    needsConsent: boolean;
}
/** One file a legacy-root migration would move or drop. */
export interface LegacyMigrationFileOp {
    toolId: string;
    source: string;
    destination: string;
    disposition: 'move' | 'drop';
    /** Whether an interactive run asks before this move */
    needsConsent: boolean;
}
/**
 * Reports the OpenSpec content sitting under each tool's legacy root, without
 * moving anything. Callers use this to ask before a move that needs consent.
 */
export declare function findLegacyToolMigrations(projectPath: string, timing?: 'before-generation' | 'after-generation'): LegacyToolMigration[];
/**
 * Lists, file by file, what `migrateLegacyToolDirs` would move or drop, without
 * touching anything. Consent-gated roots are included: a non-interactive run
 * moves them without asking. `view` decides what already sits at each
 * destination, so a dry run can plan against files it has not written.
 */
export declare function planLegacyToolMigrations(projectPath: string, timing: 'before-generation' | 'after-generation', toolIds: string[] | undefined, view: FileView): LegacyMigrationFileOp[];
/**
 * Moves OpenSpec-managed skill directories (openspec-*) and command files
 * (opsx-*) from a tool's legacy root to its current one. When the destination
 * already exists the legacy copy is removed instead. Legacy directories are
 * deleted only when left empty, so user files under the old location — a
 * hand-written Cascade workflow next to the generated ones — are preserved.
 *
 * @param projectPath - Project root
 * @param toolIds - Restrict the move to these tools; omit to move every tool
 *        whose legacy root needs no consent
 */
export declare function migrateLegacyToolDirs(projectPath: string, toolIds?: string[], timing?: 'before-generation' | 'after-generation'): LegacyToolMigration[];
/**
 * Summarizes what a migration moved, e.g. "6 skills and 6 commands".
 */
export declare function describeLegacyMigration(migration: LegacyToolMigration): string;
/**
 * Names OpenSpec-managed files the move deliberately left behind, so a user
 * who customized one knows there are now two copies to reconcile.
 */
export declare function keptInPlaceNotice(migration: LegacyToolMigration): string | undefined;
/**
 * Whether a migration has anything to move, as opposed to only files left in
 * place. Callers use this to avoid offering a move of nothing.
 */
export declare function hasMovableContent(migration: LegacyToolMigration): boolean;
/**
 * Explains why a consent-gated move is being offered, in the user's terms.
 * Keyed by tool so the reason is specific rather than a generic "files moved".
 */
export declare function legacyMigrationNotice(migration: LegacyToolMigration): string;
/**
 * Scans installed workflow files across all detected tools and returns
 * the union of installed workflow IDs.
 */
export declare function scanInstalledWorkflows(projectPath: string, tools: AIToolOption[], view?: FileView): string[];
/**
 * Performs one-time migration if the global config does not yet have a profile field.
 * Called by both init and update before profile resolution.
 *
 * - If no profile field exists and workflows are installed: sets profile to 'custom'
 *   with the detected workflows, preserving the user's existing setup.
 * - If no profile field exists and no workflows are installed: no-op (defaults apply).
 * - If profile field already exists: no-op.
 */
export declare function computeProfileMigration(projectPath: string, tools: AIToolOption[], view?: FileView): ProfileMigration | null;
export type ProfileMigration = {
    profile: Profile;
    workflows: string[];
    delivery?: Delivery;
};
/** The global config the one-time profile migration saves. */
export declare function applyProfileMigration(migration: ProfileMigration): GlobalConfig;
export declare function migrateIfNeeded(projectPath: string, tools: AIToolOption[]): void;
//# sourceMappingURL=migration.d.ts.map