/**
 * Global configuration for telemetry state.
 * Stores anonymous ID and notice-seen flag in the platform-appropriate config directory.
 */
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { GLOBAL_CONFIG_DIR_NAME, GLOBAL_CONFIG_FILE_NAME, getGlobalConfigDir, isConfigRootObject, unreadableGlobalConfigMessage, } from '../core/global-config.js';
// Constants
export const CONFIG_DIR_NAME = GLOBAL_CONFIG_DIR_NAME;
export const CONFIG_FILE_NAME = GLOBAL_CONFIG_FILE_NAME;
function getConfigDir() {
    return getGlobalConfigDir();
}
function getLegacyConfigPath() {
    return path.join(os.homedir(), '.config', CONFIG_DIR_NAME, CONFIG_FILE_NAME);
}
async function readConfigFile(configPath) {
    try {
        const content = await fs.readFile(configPath, 'utf-8');
        const parsed = JSON.parse(content);
        // Valid JSON that is not an object carries no settings to merge into, and
        // spreading it would replace the file (a string even spreads to numeric
        // character keys). Same predicate the rest of the CLI refuses to save over.
        if (!isConfigRootObject(parsed)) {
            return { status: 'invalid', config: {} };
        }
        return { status: 'ok', config: parsed };
    }
    catch (error) {
        if (error.code === 'ENOENT') {
            return { status: 'missing' };
        }
        // If parse fails or another read error occurs, ignore the file.
        return { status: 'invalid', config: {} };
    }
}
async function writeConfigFile(configPath, config) {
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n');
}
function hasMissingTelemetryFields(config) {
    const telemetry = config.telemetry;
    return (!telemetry ||
        telemetry.anonymousId === undefined ||
        telemetry.noticeSeen === undefined);
}
function mergeLegacyTelemetry(config, legacyConfig) {
    const legacyTelemetry = legacyConfig.telemetry;
    if (!legacyTelemetry) {
        return undefined;
    }
    const currentTelemetry = config.telemetry ?? {};
    const shouldMigrate = (currentTelemetry.anonymousId === undefined && legacyTelemetry.anonymousId !== undefined) ||
        (currentTelemetry.noticeSeen === undefined && legacyTelemetry.noticeSeen !== undefined);
    if (!shouldMigrate) {
        return undefined;
    }
    return {
        ...config,
        telemetry: {
            ...legacyTelemetry,
            ...currentTelemetry,
        },
    };
}
async function migrateLegacyTelemetryConfig(configPath, config, persist) {
    const legacyConfigPath = getLegacyConfigPath();
    if (path.resolve(configPath) === path.resolve(legacyConfigPath) || !hasMissingTelemetryFields(config)) {
        return config;
    }
    const legacyRead = await readConfigFile(legacyConfigPath);
    if (legacyRead.status !== 'ok') {
        return config;
    }
    const migrated = mergeLegacyTelemetry(config, legacyRead.config);
    if (!migrated) {
        return config;
    }
    if (persist) {
        try {
            await writeConfigFile(configPath, migrated);
        }
        catch {
            // Preserve telemetry for this run even if the one-time migration cannot be persisted.
        }
    }
    return migrated;
}
/**
 * Get the path to the global config file.
 * Follows XDG Base Directory Specification and platform conventions.
 *
 * - All platforms: $XDG_CONFIG_HOME/openspec/ if XDG_CONFIG_HOME is set
 * - Unix/macOS fallback: ~/.config/openspec/
 * - Windows fallback: %APPDATA%/openspec/
 */
export function getConfigPath() {
    const configDir = getConfigDir();
    return path.join(configDir, CONFIG_FILE_NAME);
}
/**
 * Read the global config file.
 * Returns an empty object if the file doesn't exist.
 */
export async function readConfig() {
    const configPath = getConfigPath();
    const read = await readConfigFile(configPath);
    const config = read.status === 'ok' ? read.config : {};
    return migrateLegacyTelemetryConfig(configPath, config, read.status !== 'invalid');
}
/**
 * Write to the global config file.
 * Preserves existing fields and merges in new values.
 */
export async function writeConfig(updates) {
    const configPath = getConfigPath();
    // Never write over a file that did not parse: the merge below would start
    // from an empty object and replace every setting in it with these updates.
    if ((await readConfigFile(configPath)).status === 'invalid') {
        throw new Error(unreadableGlobalConfigMessage(configPath));
    }
    // Read existing config and merge
    const existing = await readConfig();
    const merged = { ...existing, ...updates };
    // Deep merge for telemetry object
    if (updates.telemetry && existing.telemetry) {
        merged.telemetry = { ...existing.telemetry, ...updates.telemetry };
    }
    await writeConfigFile(configPath, merged);
}
/**
 * Get the telemetry config section.
 */
export async function getTelemetryConfig() {
    const config = await readConfig();
    return config.telemetry ?? {};
}
/**
 * Update the telemetry config section.
 */
export async function updateTelemetryConfig(updates) {
    const existing = await getTelemetryConfig();
    await writeConfig({
        telemetry: { ...existing, ...updates },
    });
}
//# sourceMappingURL=config.js.map