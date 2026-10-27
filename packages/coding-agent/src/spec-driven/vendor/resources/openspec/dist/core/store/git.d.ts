/**
 * Bounds every read-only git probe. Without a timeout a wedged network mount, an
 * fsmonitor daemon, or a credential/GPG prompt hangs the CLI forever; without a
 * raised maxBuffer a very large dirty tree makes `git status --porcelain` throw
 * ENOBUFS, which the probes below would otherwise report as "no git facts".
 * A probe writes nothing, so a hard kill is safe.
 */
export declare const GIT_EXEC_OPTIONS: {
    readonly encoding: "utf8";
    readonly timeout: 15000;
    readonly killSignal: "SIGKILL";
    readonly maxBuffer: number;
};
/**
 * Writes get their own bounds, and deliberately NOT SIGKILL: git traps SIGTERM
 * to remove `.git/index.lock` on its way out, and a signal it cannot catch
 * leaves that lock behind - every later git command in the user's store then
 * fails with "Another git process seems to be running", including the
 * best-effort unstage below. The timeout is also far longer, because a signed
 * commit can legitimately sit waiting on pinentry or a hardware key.
 */
export declare const GIT_WRITE_EXEC_OPTIONS: {
    readonly encoding: "utf8";
    readonly timeout: 120000;
    readonly maxBuffer: number;
};
export declare function isGitRepositoryAtRoot(storeRoot: string): Promise<boolean>;
export declare function initGitRepository(storeRoot: string): Promise<boolean>;
/**
 * `git var` resolves identity exactly as `git commit` would (config, env vars,
 * auto-detection), so this fails precisely when the initial commit would.
 */
export declare function assertGitCommitIdentity(probeCwd: string): Promise<void>;
/**
 * Index-preserving initial commit: the pathspec on `git commit` keeps files
 * the user had already staged out of setup's commit and leaves them staged.
 * Pathspecs may be files or directories.
 */
export declare function commitStoreFiles(storeRoot: string, id: string, pathspecs: string[]): Promise<boolean>;
/**
 * A probe that hit a resource limit rather than an ordinary Git answer: the
 * command was killed by the timeout above, or its output exceeded maxBuffer.
 * Both produce the same `null` as "not a repository", so without this the CLI
 * would quietly stop reporting facts it is capable of reporting.
 */
export declare function isProbeResourceFailure(error: unknown): boolean;
export declare function gitHasCommits(storeRoot: string): Promise<boolean | null>;
export declare function gitHasUncommittedChanges(storeRoot: string): Promise<boolean | null>;
export declare function gitHasRemote(storeRoot: string): Promise<boolean | null>;
/**
 * The configured origin URL, read from local Git config only — never a
 * network touch. Null when there is no repository or no origin.
 */
export declare function gitOriginUrl(storeRoot: string): Promise<string | null>;
export interface GitTrackingDrift {
    ahead: number;
    behind: number;
}
/**
 * Ahead/behind counts of HEAD against its configured upstream tracking
 * ref, read from local refs only — no fetch, no network. The comparison
 * is therefore against the current local upstream ref (typically last
 * updated by fetch, but it may be a local branch), not the live remote.
 * Null when there is no repository, no upstream, a detached HEAD, or Git
 * is unavailable: the absence of a comparison is not drift.
 */
export declare function gitTrackingDrift(storeRoot: string): Promise<GitTrackingDrift | null>;
export declare function gitDirectoryHasTrackedFiles(storeRoot: string, relativeDir: string): Promise<boolean | null>;
//# sourceMappingURL=git.d.ts.map