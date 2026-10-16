export const DEFAULT_CONFIG_DIR_NAME: string;
export interface OfflineShmState {
	persistentRoot: string;
	runtimeRoot: string;
	domainId: string;
}
export function resolvePersistentRoot(env?: Record<string, string | undefined>): string;
export function getOfflineShmState(env?: Record<string, string | undefined>): OfflineShmState | undefined;
export function ensureOfflineShmDirectory(relative?: string): string | undefined;
export function assertOfflineShmPath(destination: string, env?: Record<string, string | undefined>): void;
export function initializeOfflineShmEnvironment(relativeRoot?: string): string | undefined;
