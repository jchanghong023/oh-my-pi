/**
 * IDE restart hint
 *
 * Shared restart guidance for tools successfully configured by init or update.
 * The wording covers additions, updates, and removals, including an empty
 * workflow selection that removes every generated file.
 */
import type { Delivery } from '../global-config.js';
/** The surface a restart hint names. Absent when no hint is due. */
export type IdeRestartSurface = 'commands' | 'skills';
/**
 * Both conditions stay coupled to the SAME tool: its surfaces are loaded by a
 * long-running editor process (a CLI picks them up immediately, so a restart
 * line would be wrong for it — see #1067), and it supports a generated surface
 * under the active delivery. A CLI tool's commands must not determine the hint
 * for an IDE tool that only supports skills. Commands take precedence when
 * both surfaces are supported under the active delivery.
 */
export declare function resolveIdeRestartSurface(toolIds: readonly string[], delivery: Delivery): IdeRestartSurface | null;
/**
 * The restart line to print, or null when no restart is needed. Deliberately
 * not "slash commands": Amazon Q's generated files are prompt-library entries
 * invoked with `@`, so promising slash commands would be wrong for it.
 */
export declare function formatIdeRestart(toolIds: readonly string[], delivery: Delivery): string | null;
//# sourceMappingURL=ide-restart.d.ts.map