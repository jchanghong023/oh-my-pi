/**
 * Called by the standalone binary's entry point. That copy has no package
 * manager behind it, so a package-manager command is the wrong upgrade advice.
 */
export declare function markStandaloneBinary(executablePath: string): void;
/** The standalone binary's own path, or null when running from a package. */
export declare function getStandaloneBinaryPath(): string | null;
/**
 * The registry to ask. A configured registry is honored only over TLS: a
 * cleartext hop would aim the request at a link-local or internal address and
 * let anyone on the path choose the "newer version" answer.
 *
 * A rejected registry disables the check rather than falling back to public
 * npm. Falling back would send a request an organization on an internal mirror
 * deliberately avoided, and would then report a version resolved against a
 * registry the eventual `npm install -g` does not use.
 */
export declare function registryUrl(): string | null;
/**
 * Compares two semver-ish versions. Returns 1 when a > b, -1 when a < b, 0
 * otherwise. Prereleases sort below their release (1.7.0-beta.1 < 1.7.0).
 */
export declare function compareVersions(a: string, b: string): number;
export type CliUpdateStatus = 'available' | 'current' | 'disabled' | 'offline';
export interface CliUpdateCheck {
    status: CliUpdateStatus;
    latest: string | null;
}
/**
 * Checks the registry while preserving enough detail for callers to explain
 * why no newer version was reported. Never throws.
 */
export declare function checkForCliUpdate(): Promise<CliUpdateCheck>;
/**
 * Returns the published version when the installed CLI is behind it, otherwise
 * null. Kept as the compatibility surface used by `openspec update`.
 */
export declare function getAvailableCliUpdate(): Promise<string | null>;
/**
 * Directory the running CLI was loaded from, or null when it cannot be
 * resolved. Shown in the upgrade hint so anyone who upgraded but still runs an
 * old binary — a stale pnpm/volta/npx shim, or two installs on PATH — can see
 * which copy is actually answering.
 */
export declare function getInstallDir(): string | null;
/**
 * True when the running CLI resolves from a `node_modules` belonging to the
 * project being updated or any ancestor of it — the hoisted-root layout npm and
 * pnpm workspaces produce. Anchored on the target path rather than the working
 * directory, since `openspec update <path>` and running from a sub-package are
 * both normal. Never throws: process.cwd() fails when the directory has been
 * deleted, and a wrong upgrade hint must not take down a successful update.
 */
export declare function isProjectLocalInstall(installDir: string | null, projectPath?: string): boolean;
/**
 * True for the throwaway caches npx/pnpm dlx/bunx unpack into. Telling those
 * users to install globally would create the second copy on PATH they were
 * deliberately avoiding.
 */
export declare function isEphemeralRunnerInstall(installDir: string | null): boolean;
/**
 * Directories npm installs global packages into. Derived from the running node
 * rather than by shelling out to `npm prefix -g`, which would cost more than
 * the version check itself. Only a hint: `process.execPath` is realpath'd, so
 * on Homebrew it lands in the Cellar rather than the brew prefix — which is
 * why the install's own layout is the primary signal below.
 */
export declare function npmGlobalRoots(): string[];
/**
 * The prefix of an npm global install, read from the install's own shape:
 * `<prefix>/lib/node_modules/<pkg>` on POSIX, `<prefix>/node_modules/<pkg>` on
 * Windows. Self-describing, so it holds for Homebrew, nvm, Debian and anywhere
 * else npm's prefix is not derivable from the node binary. Null when the
 * layout does not match.
 */
export declare function npmPrefixFromInstallDir(installDir: string | null): string | null;
/**
 * True only when npm itself owns this copy. Everything else — a pnpm, bun,
 * yarn or volta global — would be made worse by `npm install -g`, which adds a
 * second copy that may not even be the one on PATH.
 */
export declare function isNpmGlobalInstall(installDir: string | null, roots?: string[]): boolean;
/**
 * True when the CLI is running from a clone rather than an install. Upgrade
 * advice is meaningless there: the version is whatever the branch says.
 */
export declare function isSourceCheckout(installDir: string | null): boolean;
export type PackageManager = 'npm' | 'pnpm' | 'bun' | 'yarn' | 'volta';
export type InstallScope = 'global' | 'project' | 'temporary' | 'source' | 'standalone';
export interface CliInstallInfo {
    location: string | null;
    packageManager: PackageManager | null;
    scope: InstallScope | null;
}
/**
 * The package manager that owns this copy, so the printed command is one the
 * user's setup will actually honor.
 */
export declare function detectPackageManager(installDir: string | null): PackageManager;
/** Describes the running copy without guessing when its owner is ambiguous. */
export declare function getCliInstallInfo(installDir?: string | null, projectPath?: string): CliInstallInfo;
/** Returns a safe update command only for an install with known global ownership. */
export declare function getCliUpdateCommand(install: CliInstallInfo): string | null;
/** Builds the concise human-readable form of the version report. */
export declare function buildVersionReportLines(version: string, install: CliInstallInfo, update?: CliUpdateCheck, command?: string | null): string[];
/**
 * Builds the hint, with the upgrade command chosen for how this copy of the CLI
 * was installed. Pure so every branch is assertable.
 */
export declare function buildCliUpdateLines(latestVersion: string, installDir: string | null, projectPath: string, options?: {
    withCommand?: boolean;
}): string[];
/**
 * The upgrade command for however this copy was installed, plus the reminder
 * that instruction files come from the CLI and so need a second pass.
 */
export declare function buildUpgradeCommandLines(installDir: string | null, projectPath: string): string[];
/**
 * Whether we can run the upgrade for the user instead of only printing it.
 *
 * Only an npm-owned global install qualifies, because `npm install -g` is the
 * only command we run: a pnpm/bun/yarn/volta global would get a second copy
 * that may not be the one on PATH, a project dependency belongs to that
 * project's package manager, an npx/dlx cache has nothing to upgrade, and a
 * source checkout is not an install at all.
 *
 * A non-default registry is also disqualifying. `npm install -g` resolves
 * against whatever `npm_config_registry` says, which npm may have read from a
 * cloned repository's .npmrc — so such a registry may still inform the check,
 * but must never be the thing that offers to install a global package.
 */
export declare function canSelfUpgrade(installDir: string | null, projectPath: string): boolean;
/**
 * Whether to offer the upgrade rather than just print the command. Kept here,
 * as a pure function of the environment, because the interesting mistakes live
 * in this decision: offering where `npm install -g` cannot help, or asking a
 * question no one can answer.
 */
export declare function shouldOfferUpgrade(params: {
    installDir: string | null;
    projectPath: string;
    interactive: boolean;
    stdoutIsTty: boolean;
}): boolean;
/**
 * The `openspec` npm installs alongside its global package, so the upgrade can
 * be handed to the copy npm just wrote rather than to whatever PATH resolves.
 * Null when it cannot be found, in which case PATH is the only option left.
 */
export declare function upgradedBinPath(roots?: string[], installDir?: string | null): string | null;
/**
 * Asks a CLI binary its version. Used to confirm an upgrade actually landed:
 * `npm install -g` exits 0 even when it installed nothing, so its exit code
 * alone cannot justify telling the user they are on a new version.
 */
export declare function readCliVersion(binPath: string): Promise<string | null>;
export type UpgradeOutcome = 'upgraded' | 'declined' | 'failed' | 'cancelled' | 'not-on-path';
/**
 * Offers to run the upgrade and reports what actually happened. The version is
 * read back from the installed binary rather than assumed, so "upgraded" is a
 * fact and a PATH that still answers with the old copy is caught here instead
 * of silently doing nothing.
 */
export declare function offerCliUpgrade(latestVersion: string): Promise<UpgradeOutcome>;
/**
 * Runs `openspec update` again with the CLI that was just installed — this
 * process is still the old code, so it cannot write the new workflows itself.
 * Resolves the exit code to pass along; when no `openspec` is on PATH the
 * upgrade still landed but nothing was regenerated, so it says so and
 * resolves 0 rather than reporting a failure the upgrade did not have.
 */
export declare function rerunUpdateWithUpgradedCli(projectPath: string, options?: {
    force?: boolean;
    binPath?: string;
}): Promise<number>;
/**
 * Prints the upgrade hint. Instruction files are generated by the installed
 * CLI, so "up to date" only ever means "matches this CLI" — without this note
 * a stale install looks like a successful update.
 */
export declare function displayCliUpdateNote(latestVersion: string, projectPath?: string, options?: {
    withCommand?: boolean;
}): void;
/**
 * Prints just the manual command, for when the offer was declined or failed.
 */
export declare function displayUpgradeCommand(projectPath?: string): void;
//# sourceMappingURL=version-check.d.ts.map