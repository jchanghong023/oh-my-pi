import { type TelemetryConfig } from '../core/global-config.js';
export declare const CONFIG_DIR_NAME = "openspec";
export declare const CONFIG_FILE_NAME = "config.json";
/** Re-export shared telemetry section type (single source of truth in global-config). */
export type { TelemetryConfig };
export interface GlobalConfig {
    telemetry?: TelemetryConfig;
    [key: string]: unknown;
}
/**
 * Get the path to the global config file.
 * Follows XDG Base Directory Specification and platform conventions.
 *
 * - All platforms: $XDG_CONFIG_HOME/openspec/ if XDG_CONFIG_HOME is set
 * - Unix/macOS fallback: ~/.config/openspec/
 * - Windows fallback: %APPDATA%/openspec/
 */
export declare function getConfigPath(): string;
/**
 * Read the global config file.
 * Returns an empty object if the file doesn't exist.
 */
export declare function readConfig(): Promise<GlobalConfig>;
/**
 * Write to the global config file.
 * Preserves existing fields and merges in new values.
 */
export declare function writeConfig(updates: Partial<GlobalConfig>): Promise<void>;
/**
 * Get the telemetry config section.
 */
export declare function getTelemetryConfig(): Promise<TelemetryConfig>;
/**
 * Update the telemetry config section.
 */
export declare function updateTelemetryConfig(updates: Partial<TelemetryConfig>): Promise<void>;
//# sourceMappingURL=config.d.ts.map