import { type StoreBackendConfig, type StoreGitBackendConfig, type StorePathOptions, type StoreRegistryEntry, type StoreRegistryState } from './foundation.js';
export interface RegisterStoreInput extends StorePathOptions {
    id: string;
    localPath: string;
    remote?: string;
    branch?: string;
    cwd?: string;
}
export interface ResolveRegisteredStoreInput extends StorePathOptions {
    id: string;
}
export interface GetRegisteredStoreInput extends ResolveRegisteredStoreInput {
    expectedBackend?: StoreGitBackendConfig;
}
export interface UnregisterStoreInput extends StorePathOptions {
    id: string;
    expectedBackend?: StoreGitBackendConfig;
    /** Runs under the registry lock, with the registrations that will remain. */
    beforeCommit?: (entry: RegisteredStoreEntry, remaining: RegisteredStoreEntry[]) => Promise<void>;
}
export type ListRegisteredStoresOptions = StorePathOptions;
export interface RegisteredStoreEntry extends StoreRegistryEntry {
    storeRoot: string;
}
export interface ResolvedStore {
    id: string;
    storeRoot: string;
    backend: StoreGitBackendConfig;
}
export interface StoreRegistrationCommit extends ResolvedStore {
    metadataCreated: boolean;
    registryUpdated: boolean;
    alreadyRegistered: boolean;
}
export interface CommitStoreRegistrationInput extends StorePathOptions {
    id: string;
    backend: StoreGitBackendConfig;
    writeMetadataIfMissing: boolean;
}
export declare function getStoreRootForBackend(backend: StoreBackendConfig): string;
export declare function assertNoRegisteredStoreConflict(registry: StoreRegistryState | null, id: string, backend: StoreGitBackendConfig): void;
export declare function commitStoreRegistration(input: CommitStoreRegistrationInput): Promise<StoreRegistrationCommit>;
export declare function registerStore(input: RegisterStoreInput): Promise<ResolvedStore>;
export interface RegistrySnapshot {
    /** null = the registry is unreadable; [] = empty or absent. */
    entries: StoreRegistryEntry[] | null;
    unreadable: boolean;
}
/**
 * One registry read serving every consumer in a command.
 */
export declare function readRegistrySnapshot(options?: {
    globalDataDir?: string;
}): Promise<RegistrySnapshot>;
export declare function listRegisteredStores(options?: ListRegisteredStoresOptions): Promise<RegisteredStoreEntry[]>;
export declare function getRegisteredStore(input: GetRegisteredStoreInput): Promise<RegisteredStoreEntry>;
export declare function unregisterStoreRegistration(input: UnregisterStoreInput): Promise<RegisteredStoreEntry>;
export declare function resolveRegisteredStore(input: ResolveRegisteredStoreInput): Promise<ResolvedStore>;
//# sourceMappingURL=registry.d.ts.map