import { CommandAdapterRegistry } from './command-generation/index.js';
import { getInvocationForAdapter } from './command-generation/invocation.js';
/**
 * How the tool spells its OpenSpec commands: the name from the command files
 * its adapter writes, the prefix the adapter declares. Returns undefined for
 * tools with no command adapter, which have no command names to spell.
 */
export function resolveCommandInvocation(toolId) {
    const adapter = CommandAdapterRegistry.get(toolId);
    return adapter ? getInvocationForAdapter(adapter) : undefined;
}
export function resolveCommandSurfaceCapability(toolId) {
    if (CommandAdapterRegistry.has(toolId)) {
        return 'adapter-backed';
    }
    if (toolId === 'codex' || toolId === 'warp') {
        return 'skills-invocable';
    }
    return 'none';
}
export function shouldGenerateSkillsForTool(toolId, delivery) {
    return delivery !== 'commands' || resolveCommandSurfaceCapability(toolId) === 'skills-invocable';
}
export function shouldRemoveSkillsForTool(toolId, delivery) {
    return delivery === 'commands' && resolveCommandSurfaceCapability(toolId) !== 'skills-invocable';
}
export function shouldGenerateCommandsForTool(toolId, delivery) {
    return delivery !== 'skills' && resolveCommandSurfaceCapability(toolId) === 'adapter-backed';
}
export function shouldReconcileCommandFilesForTool(toolId, delivery) {
    return delivery === 'skills' && resolveCommandSurfaceCapability(toolId) === 'adapter-backed';
}
//# sourceMappingURL=command-surface.js.map