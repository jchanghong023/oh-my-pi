/**
 * Shared OpenSpec root resolution for normal commands.
 *
 * Normal commands (`new change`, `status`, `instructions`, `list`, `show`,
 * `validate`, `archive`) resolve one OpenSpec root through this module:
 *
 * - `--store <id>` selects a registered store's root.
 * - Without `--store`, the nearest ancestor containing `openspec/` wins.
 *   Leftover workspace view state is never considered a root here.
 * - With no nearest root, a global `defaultStore` (if set) is the last
 *   machine-level fallback before the selection hint error.
 * - With no nearest root and no default, registered stores produce a
 *   selection hint error; otherwise commands may treat the current
 *   directory as an implicit root.
 *
 * Diagnostic codes reuse the store taxonomy where an error passes
 * through unchanged (`invalid_store_id`, metadata parse failures);
 * resolver-specific failures use the normal-command codes below
 * (`unknown_store`, `no_registered_stores`, `store_identity_mismatch`,
 * `unhealthy_store_root`, `store_path_not_supported`,
 * `invalid_store_pointer`, `no_root_with_registered_stores`,
 * `no_openspec_root`).
 */
import { type PlanningHome } from './planning-home.js';
export type OpenSpecRootSource = 'store' | 'declared' | 'global_default' | 'nearest' | 'implicit';
export interface StoreSelectorOptions {
    store?: string;
    storePath?: string;
}
export interface ResolveOpenSpecRootOptions extends StoreSelectorOptions {
    startPath?: string;
    allowImplicitRoot?: boolean;
    globalDataDir?: string;
}
export interface ResolvedOpenSpecRoot {
    path: string;
    changesDir: string;
    specsDir: string;
    archiveDir: string;
    defaultSchema: 'spec-driven';
    source: OpenSpecRootSource;
    storeId?: string;
}
export interface RootSelectionDiagnostic {
    severity: 'error';
    code: string;
    message: string;
    target?: string;
    fix?: string;
}
export declare class RootSelectionError extends Error {
    readonly diagnostic: RootSelectionDiagnostic;
    constructor(message: string, code: string, options?: {
        target?: string;
        fix?: string;
    });
}
export declare function isRootSelectionError(error: unknown): error is RootSelectionError;
/**
 * The metadata-identity and root-health stages of registered-store
 * resolution, as a non-throwing result. `resolveStoreRoot` maps each
 * failure kind to its established error; the reference index assembler
 * maps them to warnings. One shared inspection path — never fork it.
 */
export type RegisteredStoreInspection = {
    kind: 'ok';
    canonicalRoot: string;
} | {
    kind: 'metadata_error';
    error: unknown;
} | {
    kind: 'metadata_missing';
    metadataPath: string;
} | {
    kind: 'metadata_id_mismatch';
    actualId: string;
} | {
    kind: 'unhealthy_root';
    problems: string;
};
export declare function inspectRegisteredStore(id: string, storeRoot: string): Promise<RegisteredStoreInspection>;
export declare function resolveOpenSpecRoot(options?: ResolveOpenSpecRootOptions): Promise<ResolvedOpenSpecRoot>;
export interface RootOutput {
    path: string;
    source: OpenSpecRootSource;
    store_id?: string;
}
export declare function toRootOutput(root: ResolvedOpenSpecRoot): RootOutput;
/**
 * A store-selected root — explicit `--store`, a declared pointer, or the
 * global default. Cross-root behavior (absolute paths, --store hints,
 * suppressed noun-form suggestions) keys on this, never on `source` directly.
 */
export declare function isStoreSelectedRoot(root: ResolvedOpenSpecRoot): root is ResolvedOpenSpecRoot & {
    storeId: string;
};
/**
 * The project on the current path whose `store:` pointer names `storeId`,
 * as a canonical path (the root walk resolves aliases). Null when the
 * nearest root is a real planning root or points at a different store.
 */
export declare function findDeclaringProjectRoot(storeId: string, startPath?: string): string | null;
/**
 * Human-mode verification signal for a selected store. Written to stderr so
 * raw-Markdown and agent-consumed stdout payloads stay clean.
 */
export declare function emitStoreRootBanner(root: ResolvedOpenSpecRoot): void;
/**
 * Keeps follow-up command hints inside the selected store: a hint a user can
 * paste verbatim must carry `--store <id>` when a store was selected.
 */
export declare function withStoreFlag(root: ResolvedOpenSpecRoot, command: string): string;
/**
 * Compatibility bridge for workflow code that still expects a PlanningHome.
 * The planning home is always repo-shaped.
 */
export declare function toPlanningHome(root: ResolvedOpenSpecRoot): PlanningHome;
/**
 * CLI adapter shared by the supported commands. In JSON mode a resolution
 * failure is reported as a machine-readable payload on stdout (no human prose
 * or blank lines) with a non-zero exit code; the caller must return when this
 * resolves to null. In human mode the error propagates to the command's
 * standard error handling so message text and exit behavior stay consistent.
 */
export declare function resolveRootForCommand(selector: StoreSelectorOptions, output?: {
    json?: boolean;
    failurePayload?: Record<string, unknown>;
    /** Commands that require an existing root set this to false. */
    allowImplicitRoot?: boolean;
}): Promise<ResolvedOpenSpecRoot | null>;
//# sourceMappingURL=root-selection.d.ts.map