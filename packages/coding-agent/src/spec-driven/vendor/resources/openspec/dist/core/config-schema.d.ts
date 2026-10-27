import { z } from 'zod';
/**
 * Zod schema for global OpenSpec configuration.
 * Uses passthrough() to preserve unknown fields for forward compatibility.
 */
export declare const GlobalConfigSchema: z.ZodObject<{
    featureFlags: z.ZodDefault<z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodBoolean>>>;
    profile: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        custom: "custom";
        core: "core";
    }>>>;
    delivery: z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        both: "both";
        skills: "skills";
        commands: "commands";
    }>>>;
    workflows: z.ZodOptional<z.ZodArray<z.ZodString>>;
    defaultStore: z.ZodOptional<z.ZodString>;
    telemetry: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$loose>>;
    completionTipSeen: z.ZodOptional<z.ZodBoolean>;
    standaloneTipSeen: z.ZodOptional<z.ZodBoolean>;
}, z.core.$loose>;
export type GlobalConfigType = z.infer<typeof GlobalConfigSchema>;
/**
 * Default configuration values.
 */
export declare const DEFAULT_CONFIG: GlobalConfigType;
/**
 * True when a dot-notation key path contains a prototype-reaching segment.
 * Callers that bypass key validation (e.g. --allow-unknown) still must not bypass this.
 */
export declare function hasUnsafeKeySegment(path: string): boolean;
/**
 * Validate a config key path for CLI set operations.
 * Unknown top-level keys are rejected unless explicitly allowed by the caller.
 */
export declare function validateConfigKeyPath(path: string): {
    valid: boolean;
    reason?: string;
};
/**
 * Get a nested value from an object using dot notation.
 *
 * @param obj - The object to access
 * @param path - Dot-separated path (e.g., "featureFlags.someFlag")
 * @returns The value at the path, or undefined if not found
 */
export declare function getNestedValue(obj: Record<string, unknown>, path: string): unknown;
/**
 * Set a nested value in an object using dot notation.
 * Creates intermediate objects as needed.
 *
 * @param obj - The object to modify (mutated in place)
 * @param path - Dot-separated path (e.g., "featureFlags.someFlag")
 * @param value - The value to set
 */
export declare function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void;
/**
 * Delete a nested value from an object using dot notation.
 *
 * @param obj - The object to modify (mutated in place)
 * @param path - Dot-separated path (e.g., "featureFlags.someFlag")
 * @returns true if the key existed and was deleted, false otherwise
 */
export declare function deleteNestedValue(obj: Record<string, unknown>, path: string): boolean;
/**
 * Coerce a string value to its appropriate type.
 * - "true" / "false" -> boolean
 * - Numeric strings -> number
 * - JSON arrays/objects -> parsed containers
 * - Everything else -> string
 *
 * @param value - The string value to coerce
 * @param forceString - If true, always return the value as a string
 * @returns The coerced value
 */
export declare function coerceValue(value: string, forceString?: boolean): string | number | boolean | unknown[] | Record<string, unknown>;
/**
 * Format a value for YAML-like display.
 *
 * @param value - The value to format
 * @param indent - Current indentation level
 * @returns Formatted string
 */
export declare function formatValueYaml(value: unknown, indent?: number): string;
/**
 * Validate a configuration object against the schema.
 *
 * @param config - The configuration to validate
 * @returns Validation result with success status and optional error message
 */
export declare function validateConfig(config: unknown): {
    success: boolean;
    error?: string;
};
//# sourceMappingURL=config-schema.d.ts.map