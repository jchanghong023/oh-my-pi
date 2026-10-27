/**
 * Update Command
 *
 * Refreshes OpenSpec skills and commands for configured tools.
 * Supports profile-aware updates, delivery changes, migration, and smart update detection.
 */
import { type FileView } from './file-view.js';
import { type UpdatePlan } from './update-plan.js';
/**
 * Options for the update command.
 */
export interface UpdateCommandOptions {
    /** Force update even when tools are up to date */
    force?: boolean;
    /**
     * Record what the update would change and write nothing. Set by `plan()`;
     * callers use that instead of passing this directly.
     */
    dryRun?: boolean;
}
/**
 * Scans installed workflow artifacts (skills and managed commands) across all configured tools.
 * Returns the union of detected workflow IDs that match ALL_WORKFLOWS.
 *
 * Wrapper around the shared migration module's scanInstalledWorkflows that accepts tool IDs.
 */
export declare function scanInstalledWorkflows(projectPath: string, toolIds: string[], view?: FileView): string[];
export declare class UpdateCommand {
    private readonly force;
    private readonly dryRun;
    private recorder;
    private ops;
    constructor(options?: UpdateCommandOptions);
    /**
     * Reports what `execute` would add, change or delete, writing nothing.
     *
     * Same code path as the real update: the plan is recorded by the write seam
     * the generation loop already goes through, so it cannot drift from it.
     */
    plan(projectPath: string): Promise<UpdatePlan>;
    /** Prints progress on a real run, stays quiet while planning. */
    private log;
    /** A spinner on a real run, a no-op while planning. */
    private startSpinner;
    /**
     * Refreshes OpenSpec skills and commands for all configured tools,
     * regenerating artifacts according to the effective profile and delivery mode.
     *
     * @param projectPath - Path to the project root containing the openspec directory
     */
    execute(projectPath: string): Promise<void>;
    /**
     * Records the shared-skills-root owner through the write seam, so a dry run
     * lists the marker file a real update would write.
     */
    private writeSharedSkillTarget;
    /**
     * Where a real update throws for failed tools, it also stops. A dry run
     * stops at the same point - so it plans nothing the real update would not
     * reach - but returns instead of throwing: the failures are already in the
     * plan, and the caller still gets every change planned before them.
     *
     * @returns whether the update stops here.
     */
    private stopIfUpdateFailed;
    /** The tree as the real update would see it at this point. */
    private get view();
    /** The update's write seam, in the shape modules with their own writers take. */
    private fileOps;
    /**
     * Plans the moves out of former tool roots that a non-interactive update
     * makes, against the tree as planned so far.
     */
    private planLegacyToolMoves;
    private syncCopilotCloudFiles;
    /**
     * Tools whose SKILL.md bodies no longer match what this CLI generates.
     *
     * Skill freshness was decided solely by the `generatedBy:` line, so a body
     * edited after generation — a "helpful" PR touching `.claude/skills/**`, a
     * dotfile sync, another agent — left `update` reporting the install healthy.
     * Command files never had that gap: `areCommandFilesUpToDate` content-
     * compares them, and the same comparison belongs on the higher-authority
     * surface. A missing skill file is left to the profile-sync check, which
     * already knows what a partial install means.
     */
    private findToolsWithDriftedSkills;
    /**
     * Display message when all tools are up to date.
     */
    private displayUpToDateMessage;
    /**
     * Display the update plan showing which tools need updating.
     */
    private displayUpdatePlan;
    /**
     * Shows manual setup notes for configured tools that need extra
     * configuration before they pick up generated files.
     */
    private displaySetupNotes;
    /**
     * Detects new tool directories that aren't currently configured and displays a hint.
     */
    private detectNewTools;
    /**
     * Prints the profile notes, in order, with one pointer at
     * `openspec config profile` rather than three.
     *
     * Every note is evaluated: reading them as one short-circuited `||` chain
     * would swallow whichever ran second.
     */
    private displayProfileNotes;
    /**
     * Displays a note about extra workflows installed that aren't in the current profile.
     */
    private displayExtraWorkflowsNote;
    /**
     * Point out core workflows a custom profile is missing, so releases that
     * grow CORE_WORKFLOWS stay discoverable. Keep custom profiles user-owned;
     * do not mutate them.
     */
    private displayMissingCoreWorkflowsNote;
    /**
     * Fallback pointer to the workflows the profile leaves out.
     *
     * `update` already points at `openspec config profile` when files drift from
     * the profile, and when a custom profile is missing core workflows. Neither
     * fires for the default `core` profile, so the user `update` is most likely
     * to be helping — the one who ran it because a command they read about never
     * appeared — learns nothing (#1076). This covers that gap.
     *
     * Silent when another note already pointed at the same command, and when no
     * configured tool can receive a workflow surface under the active delivery:
     * adding workflows would write nothing there.
     */
    private displayOptionalWorkflowsNote;
    /**
     * Removes skill directories for workflows when delivery changed to commands-only.
     * Returns the number of directories removed.
     */
    private removeSkillDirs;
    /**
     * Removes skill directories for workflows that are no longer selected in the active profile.
     * Returns the number of directories removed.
     */
    private removeUnselectedSkillDirs;
    /**
     * Removes command files for workflows when delivery changed to skills-only.
     * Returns the number of files removed.
     */
    private removeCommandFiles;
    /**
     * Removes command files for workflows that are no longer selected in the active profile.
     * Returns the number of files removed.
     */
    private removeUnselectedCommandFiles;
    /**
     * Offers to move OpenSpec content out of a renamed tool's former directory
     * when the old location might still be the live one — today, Windsurf's
     * `.windsurf/` after the Devin Desktop rebrand.
     *
     * Interactive runs are asked, because nothing on disk distinguishes a user
     * who took the rebrand from one still on a pre-rebrand Windsurf build that
     * reads only `.windsurf/`. `--force` and non-interactive runs migrate, which
     * is what an unattended upgrade wants.
     */
    /** Surfaces files the move left behind rather than overwriting. */
    private reportKeptInPlace;
    private offerConsentedLegacyMigrations;
    /**
     * Detect and handle legacy OpenSpec artifacts.
     * Unlike init, update warns but continues if legacy files found in non-interactive mode.
     * Returns array of tool IDs that were newly configured during legacy upgrade.
     */
    private handleLegacyCleanup;
    /**
     * Cleans approved repo-local legacy artifacts before configured tools refresh.
     */
    private performImmediateLegacyCleanup;
    /**
     * Cleans approved global Codex prompts after configured tools refresh so newly
     * installed replacement skills can retire their prompts in the same run.
     */
    private performDeferredGlobalPromptCleanup;
    /**
     * Perform cleanup of legacy artifacts.
     */
    private performLegacyCleanup;
    /**
     * Upgrades unconfigured legacy tools into the skills-based setup and carries
     * workflow overrides for migrations that should mirror legacy Codex prompts.
     */
    private upgradeLegacyTools;
}
//# sourceMappingURL=update.d.ts.map