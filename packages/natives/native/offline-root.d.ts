import type { Stats } from "node:fs";

export const DEFAULT_CONFIG_DIR_NAME: string;
export function resolvePersistentRoot(env?: Record<string, string | undefined>): string;
export function normalizeProfileName(profile: string | undefined): string | undefined;
export function resolveAbsoluteDir(value: string | undefined): string | undefined;
export function resolveNativesDirOverride(): string | undefined;
export function resolveXdgRoot(value: string | undefined, profile?: string): string | undefined;
export function resolveLinuxPrivateCacheRoot(): string | undefined;
export function getPrivateNativeCacheUid(directory: string, privateCacheRoot: string | undefined): number | undefined;
export function resolveCacheRoot(profile?: string): string | undefined;

export class UnsafeLinuxCacheError extends Error {
	constructor(entryPath: string, expected: string, kind?: string);
}

export function lstatIfPresent(entryPath: string): Stats | undefined;
export function isPrivateCacheDirectory(stat: Stats | undefined, uid: number): boolean;
export function preparePrivateCacheDirectory(
	trustedParent: string,
	targetDir: string,
	uid: number,
	options?: { create?: boolean; kind?: string },
): Stats | undefined;
export function prepareLinuxPrivateCacheDirectory(
	targetDir: string,
	uid: number,
	options?: { create?: boolean; kind?: string },
): Stats | undefined;
