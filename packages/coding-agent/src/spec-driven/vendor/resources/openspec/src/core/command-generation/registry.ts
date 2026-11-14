/**
 * Command Adapter Registry
 *
 * Centralized registry for tool command adapters. The vendored copy ships only
 * the host's adapter; the upstream tree's other adapters were removed with it.
 */

import type { ToolCommandAdapter } from './types.js';
import { ohMyPiAdapter } from './adapters/oh-my-pi.js';

/**
 * Registry for looking up tool command adapters.
 */
export class CommandAdapterRegistry {
  private static adapters: Map<string, ToolCommandAdapter> = new Map();

  // Static initializer - register built-in adapters
  static {
    CommandAdapterRegistry.register(ohMyPiAdapter);
  }

  /**
   * Register a tool command adapter.
   * @param adapter - The adapter to register
   */
  static register(adapter: ToolCommandAdapter): void {
    CommandAdapterRegistry.adapters.set(adapter.toolId, adapter);
  }

  /**
   * Get an adapter by tool ID.
   * @param toolId - The tool identifier (e.g., 'oh-my-pi')
   * @returns The adapter for that tool, or undefined
   */
  static get(toolId: string): ToolCommandAdapter | undefined {
    return CommandAdapterRegistry.adapters.get(toolId);
  }

  /**
   * Get all registered adapters.
   * @returns Array of all registered adapters
   */
  static getAll(): ToolCommandAdapter[] {
    return Array.from(CommandAdapterRegistry.adapters.values());
  }

  /**
   * Check if an adapter is registered for a tool.
   * @param toolId - The tool identifier
   * @returns True if an adapter exists for the tool
   */
  static has(toolId: string): boolean {
    return CommandAdapterRegistry.adapters.has(toolId);
  }
}
