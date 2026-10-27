import * as os from 'node:os';
import { asErrorMessage, emitFailure, printJson } from './shared-output.js';
import * as path from 'node:path';
import { StoreError, doctorStores, listStores, prepareStoreSetup, prepareStoreCleanup, registerExistingStore, removeStore, resolveSetupGitEnabled, setupPreparedStore, unregisterStore, validateStoreId, } from '../core/store/index.js';
import { isInteractive } from '../utils/interactive.js';
function toStoreOutput(store) {
    return {
        id: store.id,
        root: store.root,
        ...(store.metadataPath ? { metadata_path: store.metadataPath } : {}),
    };
}
function toMutationOutput(result) {
    return {
        store: toStoreOutput(result.store),
        registry: {
            path: result.registryCommit.path,
            registered: result.registryCommit.registered,
            already_registered: result.registryCommit.alreadyRegistered,
        },
        git: {
            is_repository: result.git.isRepository,
            initialized: result.git.initialized,
            committed: result.git.committed,
        },
        created_files: result.createdArtifacts,
        status: result.diagnostics,
    };
}
function toCleanupOutput(result) {
    return {
        store: toStoreOutput(result.store),
        registry: {
            path: result.registryCommit.path,
            removed: result.registryCommit.removed,
        },
        files: {
            deleted: result.files.deleted,
            deleted_path: result.files.deletedPath ?? null,
            left_on_disk: result.files.leftOnDisk ?? null,
        },
        status: result.diagnostics,
    };
}
function toListOutput(result) {
    return {
        stores: result.stores.map(toStoreOutput),
        status: [],
    };
}
function toOpenSpecRootOutput(root) {
    return {
        present: root.present,
        config: root.config,
        specs: root.specs,
        changes: root.changes,
        archive: root.archive,
        healthy: root.healthy,
        status: root.diagnostics,
    };
}
function toDoctorStoreOutput(store) {
    return {
        ...toStoreOutput(store),
        openspec_root: toOpenSpecRootOutput(store.openspecRoot),
        metadata: store.metadata,
        git: {
            is_repository: store.git.isRepository,
            has_commits: store.git.hasCommits,
            has_uncommitted_changes: store.git.hasUncommittedChanges,
            has_remote: store.git.hasRemote,
            origin_url: store.git.originUrl,
        },
        status: store.diagnostics,
    };
}
function toDoctorOutput(result) {
    return {
        stores: result.stores.map(toDoctorStoreOutput),
        status: result.diagnostics,
    };
}
function formatPathForHuman(targetPath) {
    const home = os.homedir();
    const normalizedHome = path.resolve(home);
    const normalizedTarget = path.resolve(targetPath);
    if (normalizedTarget === normalizedHome)
        return '~';
    if (normalizedTarget.startsWith(`${normalizedHome}${path.sep}`)) {
        return `~${path.sep}${path.relative(normalizedHome, normalizedTarget)}`;
    }
    return targetPath;
}
async function promptStoreId() {
    const { input } = await import('@inquirer/prompts');
    return input({
        message: 'Store name',
        required: true,
        validate(value) {
            try {
                validateStoreId(value);
                return true;
            }
            catch (error) {
                return asErrorMessage(error);
            }
        },
    });
}
async function promptStorePath(id) {
    const { input } = await import('@inquirer/prompts');
    // Suggest a visible, user-owned location — never the managed XDG data dir.
    const defaultPath = ['~', 'openspec', id].join('/');
    return input({
        message: 'Where should this store live?',
        default: defaultPath,
        prefill: 'editable',
        required: true,
    });
}
async function resolveSetupInput(id, options) {
    const interactive = !options.json && isInteractive();
    if (!id && !interactive) {
        throw new StoreError('Pass a store name.', 'store_setup_id_required', {
            target: 'store.id',
            fix: 'openspec store setup <id> --path ~/openspec/<id> --json',
        });
    }
    if (options.path === undefined && !interactive) {
        throw new StoreError('Pass --path with the folder where this store should live.', 'store_setup_path_required', {
            target: 'store.root',
            fix: `openspec store setup ${id ?? '<id>'} --path ~/openspec/${id ?? '<id>'}`,
        });
    }
    const resolvedId = id ? validateStoreId(id) : await promptStoreId();
    const promptedPath = options.path === undefined
        ? await promptStorePath(resolvedId)
        : undefined;
    return {
        id: resolvedId,
        path: options.path ?? promptedPath,
        ...(options.remote !== undefined ? { remote: options.remote } : {}),
    };
}
async function prepareSetupInput(input, options) {
    return prepareStoreSetup({
        ...input,
        ...(options.initGit !== undefined ? { initGit: options.initGit } : {}),
    });
}
async function confirmSetup(prepared, initGit) {
    const { confirm } = await import('@inquirer/prompts');
    console.log('');
    console.log('OpenSpec will create:');
    console.log('');
    console.log(`  Store: ${prepared.id}`);
    console.log(`  Location: ${formatPathForHuman(prepared.root)}`);
    console.log(`  Git: ${initGit ? 'initialized' : 'not initialized'}`);
    console.log('');
    const confirmed = await confirm({
        message: 'Create this store?',
        default: true,
    });
    if (!confirmed) {
        throw new StoreError('Store setup cancelled.', 'store_setup_cancelled', {
            target: 'store.root',
            fix: 'Rerun setup when you are ready.',
        });
    }
}
async function confirmRemove(id, root, options) {
    if (options.yes)
        return;
    if (options.json || !isInteractive()) {
        throw new StoreError('Pass --yes to delete store files non-interactively.', 'store_remove_confirmation_required', {
            target: 'store.root',
            fix: `openspec store remove ${id} --yes`,
        });
    }
    const { confirm } = await import('@inquirer/prompts');
    const confirmed = await confirm({
        message: `Delete local store folder ${formatPathForHuman(root)}?`,
        default: false,
    });
    if (!confirmed) {
        throw new StoreError('Store remove cancelled.', 'store_remove_cancelled', {
            target: 'store.root',
            fix: 'Run "openspec store unregister <id>" if you only want to forget the local registration.',
        });
    }
}
function isRegisterIdentityConfirmationError(error) {
    return (error instanceof StoreError &&
        error.diagnostic.code === 'store_register_identity_confirmation_required');
}
async function confirmRegisterConversion(error) {
    const { confirm } = await import('@inquirer/prompts');
    const confirmed = await confirm({
        message: asErrorMessage(error),
        default: false,
    });
    if (!confirmed) {
        throw new StoreError('Store register cancelled.', 'store_register_cancelled', {
            target: 'store.metadata',
            fix: 'Rerun register when you are ready to create store identity metadata.',
        });
    }
}
function printMutationHuman(title, payload, remotes) {
    if (!payload.store || !payload.registry || !payload.git) {
        return;
    }
    console.log(`${title}: ${payload.store.id}`);
    console.log(`Location: ${formatPathForHuman(payload.store.root)}`);
    console.log('OpenSpec root: ready');
    console.log(`Registry: ${payload.registry.already_registered ? 'already registered' : 'registered'}`);
    for (const status of payload.status) {
        console.log(`${status.severity === 'error' ? 'Issue' : 'Note'}: ${status.message}`);
    }
    console.log('');
    console.log('Next: run normal OpenSpec commands against this store, for example:');
    console.log(`  openspec new change <change-id> --store ${payload.store.id}`);
    if (payload.git.is_repository) {
        const shareRemote = remotes?.canonical ?? remotes?.observed;
        console.log(shareRemote
            ? `Share it: teammates clone ${shareRemote} and run openspec store register <path>.`
            : 'Share this store by committing and pushing it like any Git repo.');
    }
}
function printCleanupHuman(title, payload) {
    if (!payload.store || !payload.registry || !payload.files) {
        return;
    }
    console.log(`${title}: ${payload.store.id}`);
    if (payload.files.deleted_path) {
        console.log(`Deleted: ${formatPathForHuman(payload.files.deleted_path)}`);
    }
    else if (payload.files.left_on_disk) {
        console.log(`Files kept at: ${formatPathForHuman(payload.files.left_on_disk)}`);
    }
    else if (!payload.files.deleted) {
        console.log(`Files were already missing: ${formatPathForHuman(payload.store.root)}`);
    }
    for (const status of payload.status) {
        console.log(`${status.severity === 'error' ? 'Issue' : 'Note'}: ${status.message}`);
    }
}
function printListHuman(payload) {
    if (payload.stores.length === 0) {
        console.log('No stores registered.');
        console.log('');
        console.log('Next:');
        console.log('  openspec store setup team-context --path ~/openspec/team-context');
        console.log('  openspec store register /path/to/store');
        return;
    }
    console.log(`OpenSpec stores (${payload.stores.length})`);
    console.log('');
    console.log(`${'ID'.padEnd(16)}Location`);
    for (const store of payload.stores) {
        console.log(`${store.id.padEnd(16)}${store.root}`);
    }
}
function formatMetadataHuman(store) {
    if (store.metadata.valid)
        return 'ok';
    if (store.metadata.present === false)
        return 'missing';
    if (store.metadata.present === null)
        return 'unknown';
    return 'invalid';
}
function formatDoctorGitHuman(store) {
    if (store.git.is_repository === null)
        return 'unknown';
    if (!store.git.is_repository)
        return 'not detected';
    const fact = (value, yes, no) => value === null ? 'unknown' : value ? yes : no;
    return `repository detected (commits: ${fact(store.git.has_commits, 'yes', 'none')}, uncommitted changes: ${fact(store.git.has_uncommitted_changes, 'yes', 'no')}, remote: ${fact(store.git.has_remote, 'yes', 'none')})`;
}
function formatOpenSpecRootHuman(store) {
    if (store.openspec_root.healthy)
        return 'ok';
    if (store.openspec_root.present === false)
        return 'missing';
    if (store.openspec_root.present === null)
        return 'unknown';
    return 'incomplete';
}
function printDoctorHuman(payload) {
    if (payload.stores.length === 0) {
        console.log('No stores registered.');
        return;
    }
    console.log('Store doctor');
    for (const store of payload.stores) {
        console.log('');
        console.log(store.id);
        console.log(`  Location: ${store.root}`);
        console.log(`  OpenSpec root: ${formatOpenSpecRootHuman(store)}`);
        console.log(`  Metadata: ${formatMetadataHuman(store)}`);
        const remoteLine = store.metadata.remote ?? store.git.origin_url;
        if (remoteLine) {
            console.log(`  Remote: ${remoteLine}`);
        }
        console.log(`  Git: ${formatDoctorGitHuman(store)}`);
        if (store.status.length === 0) {
            console.log('  Issues: none');
            continue;
        }
        console.log('  Issues:');
        for (const status of store.status) {
            console.log(`    - ${status.message}`);
            if (status.fix) {
                console.log(`      Fix: ${status.fix}`);
            }
        }
    }
}
export class StoreCommand {
    async setup(id, options = {}) {
        try {
            const setupInput = await resolveSetupInput(id, options);
            const prepared = await prepareSetupInput(setupInput, options);
            const initGit = resolveSetupGitEnabled(prepared, options.initGit);
            if (!options.json && isInteractive()) {
                await confirmSetup(prepared, initGit);
            }
            const result = await setupPreparedStore(prepared, { initGit });
            const payload = toMutationOutput(result);
            if (options.json) {
                printJson(payload);
                return;
            }
            printMutationHuman('Store ready', payload, result.remotes);
        }
        catch (error) {
            this.handleFailure(options.json, { store: null, registry: null, git: null, created_files: [], status: [] }, error);
        }
    }
    async register(inputPath, options = {}) {
        try {
            let result;
            try {
                result = await registerExistingStore({
                    path: inputPath,
                    id: options.id,
                    allowCreateIdentity: options.yes,
                });
            }
            catch (error) {
                if (!isRegisterIdentityConfirmationError(error) || options.json || !isInteractive()) {
                    throw error;
                }
                await confirmRegisterConversion(error);
                result = await registerExistingStore({
                    path: inputPath,
                    id: options.id,
                    allowCreateIdentity: true,
                });
            }
            const payload = toMutationOutput(result);
            if (options.json) {
                printJson(payload);
                return;
            }
            printMutationHuman('Store registered', payload, result.remotes);
        }
        catch (error) {
            this.handleFailure(options.json, { store: null, registry: null, git: null, created_files: [], status: [] }, error);
        }
    }
    async unregister(id, options = {}) {
        try {
            const payload = toCleanupOutput(await unregisterStore({ id }));
            if (options.json) {
                printJson(payload);
                return;
            }
            printCleanupHuman('Unregistered store', payload);
        }
        catch (error) {
            this.handleFailure(options.json, { store: null, registry: null, files: null, status: [] }, error);
        }
    }
    async remove(id, options = {}) {
        try {
            const target = await prepareStoreCleanup({ id });
            await confirmRemove(target.id, target.root, options);
            const payload = toCleanupOutput(await removeStore(target));
            if (options.json) {
                printJson(payload);
                return;
            }
            printCleanupHuman('Removed store', payload);
        }
        catch (error) {
            this.handleFailure(options.json, { store: null, registry: null, files: null, status: [] }, error);
        }
    }
    async list(options = {}) {
        try {
            const payload = toListOutput(await listStores());
            if (options.json) {
                printJson(payload);
                return;
            }
            printListHuman(payload);
        }
        catch (error) {
            this.handleFailure(options.json, { stores: [], status: [] }, error);
        }
    }
    async doctor(id, options = {}) {
        try {
            const payload = toDoctorOutput(await doctorStores(id));
            if (options.json) {
                printJson(payload);
                return;
            }
            printDoctorHuman(payload);
        }
        catch (error) {
            this.handleFailure(options.json, { stores: [], status: [] }, error);
        }
    }
    handleFailure(json, payload, error) {
        emitFailure(json, payload, error, 'store_error');
    }
}
//# sourceMappingURL=store.js.map