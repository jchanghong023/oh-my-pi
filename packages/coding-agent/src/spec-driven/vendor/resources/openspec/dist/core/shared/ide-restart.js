/**
 * IDE restart hint
 *
 * Shared restart guidance for tools successfully configured by init or update.
 * The wording covers additions, updates, and removals, including an empty
 * workflow selection that removes every generated file.
 */
import { AI_TOOLS } from '../config.js';
import { shouldGenerateCommandsForTool, shouldGenerateSkillsForTool, } from '../command-surface.js';
function isIdeResident(toolId) {
    return Boolean(AI_TOOLS.find((tool) => tool.value === toolId)?.requiresIdeRestart);
}
/**
 * Both conditions stay coupled to the SAME tool: its surfaces are loaded by a
 * long-running editor process (a CLI picks them up immediately, so a restart
 * line would be wrong for it — see #1067), and it supports a generated surface
 * under the active delivery. A CLI tool's commands must not determine the hint
 * for an IDE tool that only supports skills. Commands take precedence when
 * both surfaces are supported under the active delivery.
 */
export function resolveIdeRestartSurface(toolIds, delivery) {
    const ideTools = [...new Set(toolIds)].filter(isIdeResident);
    if (ideTools.some((toolId) => shouldGenerateCommandsForTool(toolId, delivery))) {
        return 'commands';
    }
    if (ideTools.some((toolId) => shouldGenerateSkillsForTool(toolId, delivery))) {
        return 'skills';
    }
    return null;
}
/**
 * The restart line to print, or null when no restart is needed. Deliberately
 * not "slash commands": Amazon Q's generated files are prompt-library entries
 * invoked with `@`, so promising slash commands would be wrong for it.
 */
export function formatIdeRestart(toolIds, delivery) {
    const surface = resolveIdeRestartSurface(toolIds, delivery);
    return surface
        ? `Restart your IDE to refresh ${surface}.`
        : null;
}
//# sourceMappingURL=ide-restart.js.map