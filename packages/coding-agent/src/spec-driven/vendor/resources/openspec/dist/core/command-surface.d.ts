import { type CommandInvocation } from './command-generation/invocation.js';
import type { Delivery } from './global-config.js';
export type CommandSurfaceCapability = 'adapter-backed' | 'skills-invocable' | 'none';
/**
 * How the tool spells its OpenSpec commands: the name from the command files
 * its adapter writes, the prefix the adapter declares. Returns undefined for
 * tools with no command adapter, which have no command names to spell.
 */
export declare function resolveCommandInvocation(toolId: string): CommandInvocation | undefined;
export declare function resolveCommandSurfaceCapability(toolId: string): CommandSurfaceCapability;
export declare function shouldGenerateSkillsForTool(toolId: string, delivery: Delivery): boolean;
export declare function shouldRemoveSkillsForTool(toolId: string, delivery: Delivery): boolean;
export declare function shouldGenerateCommandsForTool(toolId: string, delivery: Delivery): boolean;
export declare function shouldReconcileCommandFilesForTool(toolId: string, delivery: Delivery): boolean;
//# sourceMappingURL=command-surface.d.ts.map