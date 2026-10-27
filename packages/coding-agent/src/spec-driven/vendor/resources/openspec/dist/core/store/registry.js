import * as fs from 'node:fs/promises';
import { getStoreMetadataPath, getStoreMetadataDir, listStoreRegistryEntries, readStoreRegistryState, readOptionalStoreMetadataState, resolveGitStoreBackendConfig, updateStoreRegistryState, validateStoreId, writeStoreMetadataState, } from './foundation.js';
import { StoreError } from './errors.js';
import * as path from 'node:path';
import { FileSystemUtils } from '../../utils/file-system.js';
export function getStoreRootForBackend(backend) {
    switch (backend.type) {
        case 'git':
            return backend.local_path;
    }
}
function normalizePathForComparison(targetPath) {
    try {
        return FileSystemUtils.canonicalizeExistingPath(targetPath);
    }
    catch {
        // Nonexistent (e.g. stale) paths still deserve a resolved compare;
        // aligns with the operations.ts sibling fallback.
        return path.resolve(targetPath);
    }
}
export function assertNoRegisteredStoreConflict(registry, id, backend) {
    const nextPath = normalizePathForComparison(getStoreRootForBackend(backend));
    for (const entry of listStoreRegistryEntries(registry ?? { version: 1, stores: {} })) {
        const entryPath = normalizePathForComparison(getStoreRootForBackend(entry.backend));
        if (entry.id === id && entryPath === nextPath) {
            continue;
        }
        if (entry.id === id) {
            throw new StoreError(`Store '${id}' is already registered at ${getStoreRootForBackend(entry.backend)}. One checkout per store id is supported on this machine.`, 'store_id_conflict', {
                target: 'store.id',
                fix: `Use the existing registration, or run openspec store unregister ${id} first to switch this id to a different checkout.`,
            });
        }
        if (entryPath === nextPath) {
            throw new StoreError(`Store path is already registered as '${entry.id}'.`, 'store_path_conflict', {
                target: 'store.root',
                fix: `Use the existing '${entry.id}' registration or choose a different path.`,
            });
        }
    }
}
function withRegisteredStore(registry, id, backend) {
    assertNoRegisteredStoreConflict(registry, id, backend);
    const stores = {
        ...(registry?.stores ?? {}),
        [id]: {
            backend,
        },
    };
    return {
        version: 1,
        stores: Object.fromEntries(Object.entries(stores).sort(([leftId], [rightId]) => leftId.localeCompare(rightId))),
    };
}
function getRegisteredStoreOrThrow(registry, id) {
    const entry = registry?.stores[id];
    if (!entry) {
        throw new StoreError(`Unknown store '${id}'`, 'store_not_found', {
            target: 'store.id',
            fix: 'Run openspec store list to see registered stores.',
        });
    }
    return {
        id,
        backend: entry.backend,
    };
}
/** Same checkout: type, canonical path, and branch — remote excluded. */
function sameCheckout(actual, expected) {
    return (actual.type === expected.type &&
        normalizePathForComparison(actual.local_path) ===
            normalizePathForComparison(expected.local_path) &&
        actual.branch === expected.branch);
}
function storeBackendsMatch(actual, expected) {
    return sameCheckout(actual, expected) && actual.remote === expected.remote;
}
function assertExpectedRegisteredBackend(id, actual, expected) {
    if (!expected || storeBackendsMatch(actual, expected))
        return;
    throw new StoreError(`Store '${id}' changed before cleanup completed.`, 'store_registry_changed', {
        target: 'store.registry',
        fix: 'Retry the cleanup command after reviewing the current store registration.',
    });
}
function withoutRegisteredStore(registry, id, expectedBackend) {
    const removed = getRegisteredStoreOrThrow(registry, id);
    assertExpectedRegisteredBackend(id, removed.backend, expectedBackend);
    const stores = { ...(registry?.stores ?? {}) };
    delete stores[id];
    return {
        removed,
        next: {
            version: 1,
            stores: Object.fromEntries(Object.entries(stores).sort(([leftId], [rightId]) => leftId.localeCompare(rightId))),
        },
    };
}
async function ensureStoreMetadata(storeRoot, id, options) {
    const metadata = await readOptionalStoreMetadataState(storeRoot);
    if (!metadata) {
        if (!options.writeIfMissing) {
            throw new StoreError(`Registered store '${id}' is missing metadata at ${getStoreMetadataPath(storeRoot)}`, 'store_metadata_missing', {
                target: 'store.metadata',
                fix: `Create ${getStoreMetadataPath(storeRoot)} or rerun "openspec store register <path>".`,
            });
        }
        await writeStoreMetadataState(storeRoot, {
            version: 1,
            id,
        });
        return true;
    }
    if (metadata.id !== id) {
        throw new StoreError(`Store metadata id '${metadata.id}' does not match registered id '${id}'`, 'store_metadata_id_mismatch', {
            target: 'store.metadata',
            fix: 'Repair the local registry or store metadata so the ids match.',
        });
    }
    return false;
}
export async function commitStoreRegistration(input) {
    const id = validateStoreId(input.id);
    const backend = input.backend;
    const storeRoot = getStoreRootForBackend(backend);
    let metadataCreated = false;
    let isRerun = false;
    let registryUpdated = false;
    try {
        metadataCreated = await ensureStoreMetadata(storeRoot, id, {
            writeIfMissing: input.writeMetadataIfMissing,
        });
        const registry = await readStoreRegistryState({
            globalDataDir: input.globalDataDir,
        });
        const existing = registry?.stores[id];
        const existingBackend = existing?.backend;
        // Same checkout = a rerun for an already-registered store (the 1.3
        // reporting contract), whether or not the observed remote changed;
        // only a remote change needs the registry write (the refresh).
        isRerun = existingBackend !== undefined && sameCheckout(existingBackend, backend);
        const upToDate = isRerun && existingBackend !== undefined && storeBackendsMatch(existingBackend, backend);
        if (!upToDate) {
            await updateStoreRegistryState((registry) => withRegisteredStore(registry, id, backend), { globalDataDir: input.globalDataDir });
            registryUpdated = true;
        }
    }
    catch (error) {
        if (metadataCreated) {
            // A concurrent registration may have read our metadata as
            // pre-existing and committed against it - never delete metadata a
            // committed registry entry depends on.
            const current = await readStoreRegistryState({
                globalDataDir: input.globalDataDir,
            }).catch(() => null);
            if (!current?.stores[id]) {
                await fs.rm(getStoreMetadataPath(storeRoot), { force: true });
                await fs.rmdir(getStoreMetadataDir(storeRoot)).catch(() => undefined);
            }
        }
        throw error;
    }
    return {
        id,
        storeRoot,
        backend,
        metadataCreated,
        registryUpdated,
        alreadyRegistered: isRerun,
    };
}
export async function registerStore(input) {
    const id = validateStoreId(input.id);
    const backend = await resolveGitStoreBackendConfig({
        localPath: input.localPath,
        ...(input.remote !== undefined ? { remote: input.remote } : {}),
        ...(input.branch !== undefined ? { branch: input.branch } : {}),
    }, input.cwd);
    const storeRoot = getStoreRootForBackend(backend);
    const committed = await commitStoreRegistration({
        id,
        backend,
        writeMetadataIfMissing: true,
        ...(input.globalDataDir ? { globalDataDir: input.globalDataDir } : {}),
    });
    return {
        id: committed.id,
        storeRoot: committed.storeRoot,
        backend: committed.backend,
    };
}
/**
 * One registry read serving every consumer in a command.
 */
export async function readRegistrySnapshot(options = {}) {
    try {
        const registry = await readStoreRegistryState(options);
        return {
            entries: registry ? listStoreRegistryEntries(registry) : [],
            unreadable: false,
        };
    }
    catch {
        return { entries: null, unreadable: true };
    }
}
export async function listRegisteredStores(options = {}) {
    const registry = await readStoreRegistryState(options);
    if (!registry) {
        return [];
    }
    return listStoreRegistryEntries(registry).map((entry) => ({
        ...entry,
        storeRoot: getStoreRootForBackend(entry.backend),
    }));
}
export async function getRegisteredStore(input) {
    const id = validateStoreId(input.id);
    const registry = await readStoreRegistryState({
        globalDataDir: input.globalDataDir,
    });
    const entry = getRegisteredStoreOrThrow(registry, id);
    assertExpectedRegisteredBackend(id, entry.backend, input.expectedBackend);
    return {
        ...entry,
        storeRoot: getStoreRootForBackend(entry.backend),
    };
}
export async function unregisterStoreRegistration(input) {
    const id = validateStoreId(input.id);
    let removed;
    await updateStoreRegistryState(async (registry) => {
        const result = withoutRegisteredStore(registry, id, input.expectedBackend);
        const removedEntry = {
            ...result.removed,
            storeRoot: getStoreRootForBackend(result.removed.backend),
        };
        const remaining = listStoreRegistryEntries(result.next).map((entry) => ({
            ...entry,
            storeRoot: getStoreRootForBackend(entry.backend),
        }));
        await input.beforeCommit?.(removedEntry, remaining);
        removed = result.removed;
        return result.next;
    }, { globalDataDir: input.globalDataDir });
    if (!removed) {
        throw new StoreError(`Unknown store '${id}'`, 'store_not_found', {
            target: 'store.id',
            fix: 'Run openspec store list to see registered stores.',
        });
    }
    return {
        ...removed,
        storeRoot: getStoreRootForBackend(removed.backend),
    };
}
export async function resolveRegisteredStore(input) {
    const id = validateStoreId(input.id);
    const registry = await readStoreRegistryState({
        globalDataDir: input.globalDataDir,
    });
    if (!registry) {
        throw new StoreError('No store registry found', 'no_store_registry', {
            target: 'store.id',
            fix: 'Register a store with openspec store register <path>, then select it with --store <id>.',
        });
    }
    const entry = getRegisteredStoreOrThrow(registry, id);
    const backend = entry.backend;
    const storeRoot = getStoreRootForBackend(backend);
    await ensureStoreMetadata(storeRoot, id, { writeIfMissing: false });
    return {
        id,
        storeRoot,
        backend,
    };
}
//# sourceMappingURL=registry.js.map