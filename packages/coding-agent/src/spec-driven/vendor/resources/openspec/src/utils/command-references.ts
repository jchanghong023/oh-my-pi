/**
 * Command Reference Utilities
 *
 * Utilities for transforming command references to tool-specific formats.
 */

// Type-only imports: a value import would close a module cycle
// (command-generation imports this file). Callers resolve the concrete
// capability and invocation style and pass them in.
import type { CommandSurfaceCapability } from '../core/command-surface.js';
import type { CommandInvocation } from '../core/command-generation/invocation.js';
// Value import of a pure, dependency-free helper: invocation.ts imports only
// `path` and a type, so this does not close the cycle the note above guards.
import { formatCommandInvocation } from '../core/command-generation/invocation.js';

/**
 * Rewrites the canonical `/opsx:<command>` references that command bodies and
 * skill templates are authored with into the form one tool actually registers
 * — `/opsx-<command>` for tools that name the command by filename,
 * `@opsx-<command>` for Amazon Q's prompt library.
 *
 * Only known command ids are rewritten, matching how
 * `transformToSkillReferences` leaves unrecognized references alone, so a
 * mistyped or invented `/opsx:<something>` is left as written rather than
 * silently reshaped into a command that does not exist either.
 *
 * @param text - The text containing command references
 * @param invocation - The tool's invocation, from resolveCommandInvocation()
 * @returns Text with command references spelled the tool's way
 *
 * @example
 * transformCommandInvocations('/opsx:new', { style: 'flat', prefix: '/' }) // '/opsx-new'
 * transformCommandInvocations('/opsx:new', { style: 'flat', prefix: '@' }) // '@opsx-new'
 */
export function transformCommandInvocations(
  text: string,
  invocation: CommandInvocation
): string {
  return text.replace(/\/opsx:([a-z-]+)/g, (match, commandId: string) =>
    commandId in COMMAND_TO_SKILL_NAME
      ? formatCommandInvocation(invocation, commandId)
      : match
  );
}

/**
 * Maps command short names to their skill names.
 * Keep in sync with WORKFLOW_TO_SKILL_DIR, which exists in both
 * src/core/profile-sync-drift.ts (exported) and src/core/init.ts (local copy).
 */
const COMMAND_TO_SKILL_NAME: Record<string, string> = {
  'explore': 'openspec-explore',
  'new': 'openspec-new-change',
  'continue': 'openspec-continue-change',
  'apply': 'openspec-apply-change',
  'update': 'openspec-update-change',
  'ff': 'openspec-ff-change',
  'sync': 'openspec-sync-specs',
  'archive': 'openspec-archive-change',
  'bulk-archive': 'openspec-bulk-archive-change',
  'verify': 'openspec-verify-change',
  'onboard': 'openspec-onboard',
  'propose': 'openspec-propose',
};

function replaceCommandsWithSkillReferences(text: string, prefix: string): string {
  return text.replace(/\/opsx:([a-z-]+)/g, (match, commandId: string) => {
    const skillName = COMMAND_TO_SKILL_NAME[commandId];
    return skillName === undefined ? match : `${prefix}${skillName}`;
  });
}

/**
 * The wording of the one shared copy in `.agents/skills/`, which the target
 * reads: `/opsx:<command>` becomes the bare skill name (`openspec-propose`).
 */
export function transformToSharedSkillReferences(text: string): string {
  return replaceCommandsWithSkillReferences(text, '');
}

/**
 * Transforms command references to skill references using the default `/`
 * invocation prefix. Converts `/opsx:<command>` patterns to
 * `/openspec-<skill>` so that generated skills do not reference commands
 * that were never generated.
 *
 * Unknown command references are left unchanged.
 *
 * @param text - The text containing command references
 * @returns Text with command references transformed to skill references
 *
 * @example
 * transformToSkillReferences('/opsx:apply') // returns '/openspec-apply-change'
 * transformToSkillReferences('Use /opsx:archive next') // returns 'Use /openspec-archive-change next'
 */
export function transformToSkillReferences(text: string): string {
  return replaceCommandsWithSkillReferences(text, '/');
}

/** The vendored copy has one target, which invokes skills as `/openspec-*`. */
export function getSkillReferenceTransformer(_toolId: string): (text: string) => string {
  return transformToSkillReferences;
}

/**
 * Selects the command-reference transformer for a skill generation target.
 *
 * OpenSpec 2.0 generates no command files, so every skill refers to the other
 * workflows as skills. A skill never points at an `/opsx:*` command that does
 * not exist.
 *
 * @param toolId - The AI tool identifier (e.g., 'oh-my-pi')
 * @param _delivery - The `delivery` setting, which no longer changes anything
 * @param _capability - The tool's command surface capability, likewise
 * @param _invocation - How the tool's commands were invoked, likewise
 * @returns The transformer to pass to generateSkillContent
 */
export function getTransformerForTool(
  toolId: string,
  _delivery: 'both' | 'skills' | 'commands',
  _capability: CommandSurfaceCapability,
  _invocation: CommandInvocation | undefined
): ((text: string) => string) | undefined {
  return getSkillReferenceTransformer(toolId);
}
