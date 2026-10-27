export declare const COMPLETION_TIP_MESSAGE = "Tip: Run 'openspec completion install' for shell completions";
export interface CompletionTipOptions {
    /**
     * Skip printing without marking the tip as seen, so it still appears on the
     * user's first later run that can safely carry it. Used for runs nobody would
     * read the tip from: JSON output, and stderr that is not a terminal.
     */
    silent?: boolean;
}
/**
 * Read the global config exactly as it sits on disk.
 *
 * Deliberately NOT `getGlobalConfig()`: that merges in defaults, and writing the
 * merged result back would stamp `profile`/`delivery` into a file the user never
 * set them in. `migrateIfNeeded` treats a raw `profile` as "already migrated",
 * so that stamp would permanently suppress the one-time profile migration and
 * cost users their installed workflow skills.
 *
 * Returns null when the file exists but cannot be read or parsed — a config we
 * cannot understand is left strictly alone rather than overwritten.
 */
export declare function readRawConfig(): Record<string, unknown> | null;
/**
 * Record the flag, re-reading the config first and replacing the file by rename.
 *
 * Deciding whether to show the tip costs a `ps` spawn and a stat, and a sibling
 * `openspec` process can write the same file in that window — on a first run
 * that is exactly when telemetry mints `anonymousId`. Re-reading here keeps the
 * write down to this one key, and the rename keeps a reader from ever seeing a
 * half-written config.
 */
export declare function markConfigFlag(key: string): Promise<void>;
/**
 * Print the completion tip once, the first time the CLI runs.
 * Never throws — a hint must not break a command.
 */
export declare function maybeShowCompletionTip(options?: CompletionTipOptions): Promise<void>;
//# sourceMappingURL=completion-tip.d.ts.map