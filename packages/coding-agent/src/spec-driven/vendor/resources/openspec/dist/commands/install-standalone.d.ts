import { type CliInstallInfo } from '../core/version-check.js';
export interface InstallTarget {
    dir: string;
    name: string;
}
/**
 * Where the installer will put the binary. Mirrors install.sh and install.ps1,
 * and is passed to them explicitly so both sides agree. The standalone binary
 * reinstalls itself where it is, under its own name.
 */
export declare function resolveInstallTarget(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, standalonePath?: string | null): InstallTarget;
/** The command that removes a package-manager install, or null when there is nothing to remove. */
export declare function removeCommandFor(install: CliInstallInfo): string | null;
/**
 * Checks a download source given through the environment. Release files and
 * SHA256SUMS come from the same place, so a remote plain-HTTP source could
 * swap both: only https, or http to this machine. The host is parsed, not
 * prefix-matched, and a user part (http://localhost:80@evil.example/) is
 * refused.
 */
export declare function checkSource(label: string, value: string): string;
/** Where the installer script comes from: OPENSPEC_DOWNLOAD_URL when set (mirrors, tests), else main. */
export declare function installerBase(env?: NodeJS.ProcessEnv): string;
export declare function installStandalone(options?: {
    version?: string;
}): Promise<void>;
//# sourceMappingURL=install-standalone.d.ts.map