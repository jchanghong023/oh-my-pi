import * as nodeFs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { folderStyleNameProblem, isKebabId, KEBAB_ID_DESCRIPTION, KEBAB_ID_FIX, } from '../id.js';
import { getGlobalDataDir } from '../global-config.js';
import { FileSystemUtils } from '../../utils/file-system.js';
import { acquireFileLock, isNodeErrorCode, makeLockErrorFactory, pathIsDirectory, pathIsFile, releaseFileLock, writeFileAtomically, } from '../file-state.js';
import { formatZodIssues } from '../zod-issues.js';
import { StoreError } from './errors.js';
const fs = nodeFs.promises;
export const STORE_METADATA_DIR_NAME = '.openspec-store';
export const STORE_METADATA_FILE_NAME = 'store.yaml';
export const STORES_DIR_NAME = 'stores';
export const STORE_REGISTRY_FILE_NAME = 'registry.yaml';
function joinStorePath(basePath, ...segments) {
    return FileSystemUtils.joinPath(basePath, ...segments);
}
export function getStoresDir(options = {}) {
    return joinStorePath(options.globalDataDir ?? getGlobalDataDir(), STORES_DIR_NAME);
}
export function getStoreRegistryPath(options = {}) {
    return joinStorePath(getStoresDir(options), STORE_REGISTRY_FILE_NAME);
}
export function getStoreMetadataDir(storeRoot) {
    return joinStorePath(storeRoot, STORE_METADATA_DIR_NAME);
}
export function getStoreMetadataPath(storeRoot) {
    return joinStorePath(getStoreMetadataDir(storeRoot), STORE_METADATA_FILE_NAME);
}
export function validateStoreId(id) {
    const folderProblem = folderStyleNameProblem(id, 'Store id');
    if (folderProblem !== null) {
        throw new StoreError(folderProblem, 'invalid_store_id', {
            target: 'store.id',
            fix: KEBAB_ID_FIX,
        });
    }
    if (!isKebabId(id)) {
        throw new StoreError(`Store id ${KEBAB_ID_DESCRIPTION}`, 'invalid_store_id', {
            target: 'store.id',
            fix: KEBAB_ID_FIX,
        });
    }
    return id;
}
export function isValidStoreId(id) {
    try {
        validateStoreId(id);
        return true;
    }
    catch {
        return false;
    }
}
function isFileNotFoundError(error) {
    return isNodeErrorCode(error, 'ENOENT');
}
function normalizeExistingPathForStorage(existingPath) {
    return FileSystemUtils.canonicalizeExistingPath(existingPath);
}
function nonEmptyOptionalString() {
    return z.string().min(1).optional();
}
const GitBackendConfigSchema = z.object({
    type: z.literal('git'),
    local_path: z.string().min(1),
    remote: nonEmptyOptionalString(),
    branch: nonEmptyOptionalString(),
}).strict();
const RegistryEntrySchema = z.object({
    backend: GitBackendConfigSchema,
}).strict();
const RegistryStateSchema = z.object({
    version: z.literal(1),
    stores: z.record(z.string(), RegistryEntrySchema),
    // Legacy code-checkout map data is tolerated on read and dropped on
    // the next write.
    repos: z.unknown().optional(),
}).strict();
const MetadataStateSchema = z.object({
    version: z.literal(1),
    id: z.string(),
    remote: nonEmptyOptionalString(),
}).strict();
function storeStateDiagnostic(label) {
    if (label.includes('metadata')) {
        return {
            code: 'invalid_store_metadata',
            target: 'store.metadata',
            fix: 'Repair .openspec-store/store.yaml.',
        };
    }
    return {
        code: 'invalid_store_registry',
        target: 'store.registry',
        fix: `Repair or remove ${getStoreRegistryPath({})}.`,
    };
}
function invalidStoreStateError(label, message) {
    const diagnostic = storeStateDiagnostic(label);
    return new StoreError(`Invalid ${label}: ${message}`, diagnostic.code, {
        target: diagnostic.target,
        fix: diagnostic.fix,
    });
}
function parseYamlObject(content, label) {
    try {
        return parseYaml(content);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw invalidStoreStateError(label, message);
    }
}
function assertValidStoreIds(ids, label) {
    for (const id of ids) {
        if (!isKebabId(id)) {
            throw invalidStoreStateError(label, `'${id}': ${KEBAB_ID_DESCRIPTION}`);
        }
    }
}
export function parseStoreRegistryState(content) {
    const raw = parseYamlObject(content, 'store registry state');
    const result = RegistryStateSchema.safeParse(raw);
    if (!result.success) {
        throw invalidStoreStateError('store registry state', formatZodIssues(result.error));
    }
    assertValidStoreIds(Object.keys(result.data.stores), 'store id');
    return {
        version: 1,
        stores: result.data.stores,
    };
}
export function parseStoreMetadataState(content) {
    const raw = parseYamlObject(content, 'store metadata state');
    const result = MetadataStateSchema.safeParse(raw);
    if (!result.success) {
        throw invalidStoreStateError('store metadata state', formatZodIssues(result.error));
    }
    validateStoreId(result.data.id);
    return {
        version: 1,
        id: result.data.id,
        ...(result.data.remote !== undefined ? { remote: result.data.remote } : {}),
    };
}
export function serializeStoreRegistryState(state) {
    const result = RegistryStateSchema.safeParse(state);
    if (!result.success) {
        throw invalidStoreStateError('store registry state', formatZodIssues(result.error));
    }
    assertValidStoreIds(Object.keys(result.data.stores), 'store id');
    return stringifyYaml({
        version: 1,
        stores: result.data.stores,
    });
}
export function serializeStoreMetadataState(state) {
    const result = MetadataStateSchema.safeParse(state);
    if (!result.success) {
        throw invalidStoreStateError('store metadata state', formatZodIssues(result.error));
    }
    validateStoreId(result.data.id);
    return stringifyYaml({
        version: 1,
        id: result.data.id,
        ...(result.data.remote !== undefined ? { remote: result.data.remote } : {}),
    });
}
export function listStoreRegistryEntries(registry) {
    return Object.entries(registry.stores)
        .map(([id, store]) => ({ id, backend: store.backend }))
        .sort((a, b) => a.id.localeCompare(b.id));
}
export async function isStoreRoot(candidateRoot) {
    return pathIsFile(getStoreMetadataPath(candidateRoot));
}
export async function readStoreRegistryState(options = {}) {
    const registryPath = getStoreRegistryPath(options);
    if (!(await pathIsFile(registryPath))) {
        return null;
    }
    return parseStoreRegistryState(await fs.readFile(registryPath, 'utf-8'));
}
export async function writeStoreRegistryState(state, options = {}) {
    await writeFileAtomically(getStoreRegistryPath(options), serializeStoreRegistryState(state));
}
const storeRegistryLockError = makeLockErrorFactory({
    createSubject: 'the registry lock file',
    busyMessage: 'Store registry is busy.',
    code: 'store_registry_busy',
    target: 'store.registry',
});
export async function updateStoreRegistryState(updater, options = {}) {
    const registryPath = getStoreRegistryPath(options);
    const lockPath = `${registryPath}.lock`;
    const lock = await acquireFileLock({
        lockPath,
        errorFor: storeRegistryLockError,
    });
    try {
        const next = await updater(await readStoreRegistryState(options));
        await writeStoreRegistryState(next, options);
        return next;
    }
    finally {
        await releaseFileLock(lock, lockPath);
    }
}
export async function readStoreMetadataState(storeRoot) {
    return parseStoreMetadataState(await fs.readFile(getStoreMetadataPath(storeRoot), 'utf-8'));
}
export async function readOptionalStoreMetadataState(storeRoot) {
    try {
        return await readStoreMetadataState(storeRoot);
    }
    catch (error) {
        if (isFileNotFoundError(error)) {
            return null;
        }
        throw error;
    }
}
export async function writeStoreMetadataState(storeRoot, state) {
    await FileSystemUtils.writeFile(getStoreMetadataPath(storeRoot), serializeStoreMetadataState(state));
}
export async function resolveGitStoreBackendConfig(input, cwd = process.cwd()) {
    if (input.localPath.length === 0) {
        throw new Error('Store local path must not be empty.');
    }
    const resolvedPath = path.isAbsolute(input.localPath)
        ? path.resolve(input.localPath)
        : path.resolve(cwd, input.localPath);
    if (!(await pathIsDirectory(resolvedPath))) {
        throw new Error(`Store local path does not exist: ${input.localPath}`);
    }
    if (input.remote !== undefined && input.remote.length === 0) {
        throw new Error('Store backend remote must not be empty when provided.');
    }
    if (input.branch !== undefined && input.branch.length === 0) {
        throw new Error('Store branch must not be empty when provided.');
    }
    return {
        type: 'git',
        local_path: normalizeExistingPathForStorage(resolvedPath),
        ...(input.remote ? { remote: input.remote } : {}),
        ...(input.branch ? { branch: input.branch } : {}),
    };
}
//# sourceMappingURL=foundation.js.map