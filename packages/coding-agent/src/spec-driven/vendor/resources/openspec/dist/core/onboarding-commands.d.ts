/**
 * Onboarding command hints.
 *
 * The commands shown to a user after setup must be limited to the workflows
 * their profile actually installs, otherwise we advertise slash commands that
 * were correctly never generated.
 *
 * This module decides WHICH hints to show. How each one is spelled for a given
 * tool — command, skill, or a tool-specific skill prefix — is decided by
 * src/utils/command-references.ts at the call site.
 */
import { type WorkflowId } from './profiles.js';
export type OnboardingCommand = {
    workflow: WorkflowId;
    command: string;
    description: string;
};
/**
 * Longest description the welcome screen can render. It shows these beside a
 * 24-column art column and only animates at MIN_WIDTH (60) columns or wider; a
 * longer line wraps, and the animation's cursor-up count assumes unwrapped
 * lines. See src/ui/welcome-screen.ts.
 */
export declare const DESCRIPTION_BUDGET = 17;
/**
 * Returns the onboarding hints for the installed workflows, in lifecycle order.
 * Returns an empty array when none of the onboarding workflows are installed.
 */
export declare function getOnboardingCommands(workflows: readonly string[]): OnboardingCommand[];
/**
 * Returns the note telling a user which workflows their profile left out, or
 * null when every workflow is already installed.
 *
 * Setup output otherwise never names the workflows that exist but were not
 * installed, so a user on the default profile has no way to learn that
 * `/opsx:ff` and friends are one command away. The docs say it; nobody reads
 * the docs before typing a command that isn't there.
 */
export declare function formatOptionalWorkflowsNote(installedWorkflows: readonly string[]): string[] | null;
//# sourceMappingURL=onboarding-commands.d.ts.map