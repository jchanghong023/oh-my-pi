export const DEFAULT_CONFIG_DIR_NAME: string;
export function resolvePersistentRoot(env?: Record<string, string | undefined>): string;
export function normalizeProfileName(profile: string | undefined): string | undefined;
export function resolveAbsoluteDir(value: string | undefined): string | undefined;
export function resolveXdgRoot(value: string | undefined, profile?: string): string | undefined;
