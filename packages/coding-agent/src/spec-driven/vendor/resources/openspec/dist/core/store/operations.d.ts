import { type OpenSpecRootInspection } from '../openspec-root.js';
import { type StoreGitBackendConfig, type StorePathOptions, type StoreRegistryState } from './foundation.js';
import { type StoreDiagnostic } from './errors.js';
type PathKind = 'missing' | 'directory' | 'file' | 'other';
export interface StoreInfo {
    id: string;
    root: string;
    metadataPath?: string;
}
export interface StoreMutationResult {
    store: StoreInfo;
    /** Clone-source knowledge for human sharing guidance; never in JSON. */
    remotes?: {
        canonical?: string;
        observed?: string;
    };
    registryCommit: {
        path: string;
        registered: boolean;
        alreadyRegistered: boolean;
    };
    git: {
        isRepository: boolean;
        initialized: boolean;
        committed: boolean;
    };
    createdArtifacts: string[];
    diagnostics: StoreDiagnostic[];
}
export interface StoreCleanupResult {
    store: StoreInfo;
    registryCommit: {
        path: string;
        removed: boolean;
    };
    files: {
        deleted: boolean;
        deletedPath?: string;
        leftOnDisk?: string;
    };
    diagnostics: StoreDiagnostic[];
}
export interface StoreListResult {
    stores: StoreInfo[];
}
export interface StoreDoctorResult {
    stores: StoreInspection[];
    diagnostics: StoreDiagnostic[];
}
export interface StoreInspection extends StoreInfo {
    openspecRoot: OpenSpecRootInspection;
    metadata: {
        present: boolean | null;
        valid: boolean | null;
        id?: string;
        /** Canonical clone source from store.yaml; null when absent. */
        remote: string | null;
    };
    git: {
        isRepository: boolean | null;
        hasCommits: boolean | null;
        hasUncommittedChanges: boolean | null;
        hasRemote: boolean | null;
        /** Observed origin URL, live-probed; null when none. */
        originUrl: string | null;
    };
    diagnostics: StoreDiagnostic[];
}
export interface SetupStoreInput {
    id?: string;
    path?: string;
    initGit?: boolean;
    allowInsideGitRepository?: boolean;
    /** Canonical clone source written into store.yaml (slice 3.3). */
    remote?: string;
}
export interface RegisterExistingStoreInput {
    path?: string;
    id?: string;
    allowCreateIdentity?: boolean;
}
export interface CleanupStoreInput extends StorePathOptions {
    id: string;
}
export interface PreparedStoreCleanup extends StoreInfo, StorePathOptions {
    backend: StoreGitBackendConfig;
}
export interface PreparedStoreSetup {
    id: string;
    root: string;
    rootKind: Extract<PathKind, 'missing' | 'directory'>;
    backend?: StoreGitBackendConfig;
    registry: StoreRegistryState | null;
    remote?: string;
}
export declare function expandUserPath(inputPath: string): string;
/**
 * Resolves the effective Git mode for a prepared setup: on by default for new
 * stores, off for reruns of an already-registered store (which must stay
 * no-ops), and always honoring an explicit --init-git/--no-init-git.
 */
export declare function resolveSetupGitEnabled(prepared: PreparedStoreSetup, initGit?: boolean): boolean;
export declare function prepareStoreSetup(input: Pick<SetupStoreInput, 'id' | 'path' | 'initGit' | 'allowInsideGitRepository' | 'remote'>): Promise<PreparedStoreSetup>;
export declare function setupPreparedStore(prepared: PreparedStoreSetup, input?: Pick<SetupStoreInput, 'initGit'>): Promise<StoreMutationResult>;
export declare function setupStore(input: SetupStoreInput): Promise<StoreMutationResult>;
export declare function registerExistingStore(input: RegisterExistingStoreInput): Promise<StoreMutationResult>;
export declare function prepareStoreCleanup(input: CleanupStoreInput): Promise<PreparedStoreCleanup>;
export declare function unregisterStore(input: CleanupStoreInput): Promise<StoreCleanupResult>;
export declare function removeStore(target: PreparedStoreCleanup): Promise<StoreCleanupResult>;
export declare function listStores(): Promise<StoreListResult>;
export declare function doctorStores(id?: string): Promise<StoreDoctorResult>;
export declare function normalizeStorePathForComparison(targetPath: string): string;
export {};
//# sourceMappingURL=operations.d.ts.map