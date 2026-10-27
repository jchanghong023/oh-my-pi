export declare const STORE_METADATA_DIR_NAME = ".openspec-store";
export declare const STORE_METADATA_FILE_NAME = "store.yaml";
export declare const STORES_DIR_NAME = "stores";
export declare const STORE_REGISTRY_FILE_NAME = "registry.yaml";
export interface StorePathOptions {
    globalDataDir?: string;
}
export interface StoreGitBackendConfig {
    type: 'git';
    local_path: string;
    remote?: string;
    branch?: string;
}
export type StoreBackendConfig = StoreGitBackendConfig;
export interface StoreRegistryEntryState {
    backend: StoreBackendConfig;
}
export interface StoreRegistryState {
    version: 1;
    stores: Record<string, StoreRegistryEntryState>;
}
export interface StoreRegistryEntry {
    id: string;
    backend: StoreBackendConfig;
}
export interface StoreMetadataState {
    version: 1;
    id: string;
    /** Canonical clone source, team-authored. Optional (slice 3.3). */
    remote?: string;
}
export interface ResolveGitStoreBackendInput {
    localPath: string;
    remote?: string;
    branch?: string;
}
export declare function getStoresDir(options?: StorePathOptions): string;
export declare function getStoreRegistryPath(options?: StorePathOptions): string;
export declare function getStoreMetadataDir(storeRoot: string): string;
export declare function getStoreMetadataPath(storeRoot: string): string;
export declare function validateStoreId(id: string): string;
export declare function isValidStoreId(id: string): boolean;
export declare function parseStoreRegistryState(content: string): StoreRegistryState;
export declare function parseStoreMetadataState(content: string): StoreMetadataState;
export declare function serializeStoreRegistryState(state: StoreRegistryState): string;
export declare function serializeStoreMetadataState(state: StoreMetadataState): string;
export declare function listStoreRegistryEntries(registry: StoreRegistryState): StoreRegistryEntry[];
export declare function isStoreRoot(candidateRoot: string): Promise<boolean>;
export declare function readStoreRegistryState(options?: StorePathOptions): Promise<StoreRegistryState | null>;
export declare function writeStoreRegistryState(state: StoreRegistryState, options?: StorePathOptions): Promise<void>;
export declare function updateStoreRegistryState(updater: (state: StoreRegistryState | null) => StoreRegistryState | Promise<StoreRegistryState>, options?: StorePathOptions): Promise<StoreRegistryState>;
export declare function readStoreMetadataState(storeRoot: string): Promise<StoreMetadataState>;
export declare function readOptionalStoreMetadataState(storeRoot: string): Promise<StoreMetadataState | null>;
export declare function writeStoreMetadataState(storeRoot: string, state: StoreMetadataState): Promise<void>;
export declare function resolveGitStoreBackendConfig(input: ResolveGitStoreBackendInput, cwd?: string): Promise<StoreGitBackendConfig>;
//# sourceMappingURL=foundation.d.ts.map