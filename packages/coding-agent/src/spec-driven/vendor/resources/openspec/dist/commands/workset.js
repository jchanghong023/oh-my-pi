/**
 * The `workset` command group (slice 7.1): compose, keep, and open
 * personal working views. A workset is purely local and personal -
 * never committed, never shared, never derived from declarations, and
 * never a membership truth. Opening hands the view to the user's tool:
 * editors get the generated .code-workspace; CLI agents take over this
 * terminal with every member attached and no starter prompt.
 */
import * as os from 'node:os';
import { createRequire } from 'node:module';
import { buildWorksetCodeWorkspaceJson, getWorkset, getWorksetCodeWorkspacePath, listWorksets, readWorksetsState, removeWorkset, updateWorksetsState, validateWorksetName, withWorkset, withWorksetsLock, worksetNotFoundError, } from '../core/worksets.js';
import { buildLaunchCommand, findOpener, isOpenerCommandAvailable, isOpenerEnabled, listOpenerChoices, mergeOpenerTable, } from '../core/openers.js';
import { pathIsDirectory, writeFileAtomically } from '../core/file-state.js';
import { getGlobalConfig, getGlobalConfigPath, } from '../core/global-config.js';
import { StoreError } from '../core/store/errors.js';
import { isInteractive } from '../utils/interactive.js';
import { asErrorMessage, emitFailure, isPromptCancellationError, printJson, } from './shared-output.js';
import { finalizeWorkset, firstInstalledAlternative, formatMemberRows, noToolInstalledError, resolveMemberFlags, toolUnavailableError, toolUnknownError, } from './workset-input.js';
import { composeInteractively, confirmRemoveInteractively, promptOpenNow, promptToolFromChoices, } from './workset-prompts.js';
// cross-spawn is CJS with no types and only `workset open` needs it -
// loaded lazily so every other CLI invocation skips its module graph.
let cachedSpawn;
function defaultSpawn() {
    if (cachedSpawn === undefined) {
        const require = createRequire(import.meta.url);
        cachedSpawn = require('cross-spawn');
    }
    return cachedSpawn;
}
function readOpenerTable() {
    return mergeOpenerTable(getGlobalConfig().openers, getGlobalConfigPath());
}
function worksetCliOpenerDisabledError(opener, name) {
    return new StoreError(`Opening a workset in ${opener.label} is temporarily disabled while CLI-agent opening is reworked. Worksets open in an IDE for now.`, 'workset_cli_opener_disabled', {
        target: 'workset.tool',
        fix: `Open in VS Code or Cursor: openspec workset open ${name} --tool code`,
    });
}
/**
 * Spawns the opener with this terminal's stdio. Resolves with the
 * child's exit facts (never rejects for a nonzero exit - for a
 * terminal handoff, the session is the command); rejects with
 * workset_launch_failed only when the spawn itself fails. While the
 * child runs, SIGINT/SIGTERM are ignored in this parent: the terminal
 * delivers Ctrl-C to the child, and the parent must survive to report
 * the child's real exit facts (the 128+n contract).
 */
export function launchOpenerCommand(command, options = {}) {
    const spawnFn = options.spawnFn ?? defaultSpawn();
    return new Promise((resolve, reject) => {
        const launchFailure = (error) => new StoreError(`Could not launch ${command.label}: ${asErrorMessage(error)}`, 'workset_launch_failed', {
            target: 'workset.tool',
            fix: `Check that '${command.executable}' runs from this terminal, or pass --tool with another installed tool.`,
        });
        let child;
        try {
            child = spawnFn(command.executable, command.args, {
                cwd: command.cwd,
                stdio: 'inherit',
                shell: false,
            });
        }
        catch (error) {
            // Some spawn failures throw synchronously (platform-dependent);
            // they are the same launch failure.
            reject(launchFailure(error));
            return;
        }
        const ignoreSignal = () => undefined;
        process.on('SIGINT', ignoreSignal);
        process.on('SIGTERM', ignoreSignal);
        const cleanup = () => {
            process.removeListener('SIGINT', ignoreSignal);
            process.removeListener('SIGTERM', ignoreSignal);
        };
        child.on('error', (error) => {
            cleanup();
            reject(launchFailure(error));
        });
        child.on('close', (code, signal) => {
            cleanup();
            resolve({ code, signal });
        });
    });
}
/** 130 for SIGINT, 143 for SIGTERM - the shell's 128+n convention. */
export function exitCodeForLaunch(result) {
    if (result.signal !== null) {
        const signalNumber = os.constants.signals[result.signal];
        return 128 + (signalNumber ?? 1);
    }
    return result.code ?? 0;
}
export class WorksetCommand {
    async create(name, options = {}) {
        try {
            const interactive = !options.json && isInteractive();
            let workset;
            let table;
            if (interactive) {
                table = readOpenerTable();
                workset = await composeInteractively(name, { memberFlags: options.member ?? [], tool: options.tool }, table);
            }
            else {
                workset = await this.composeFromFlags(name, options);
            }
            await updateWorksetsState((state) => withWorkset(state, workset));
            if (options.json) {
                printJson({ workset, status: [] });
                return;
            }
            console.log('');
            console.log(`Saved workset '${workset.name}' (${workset.members.length} member${workset.members.length === 1 ? '' : 's'}) to your machine.`);
            if (interactive && workset.tool !== undefined && table !== undefined) {
                const label = findOpener(table, workset.tool)?.label ?? workset.tool;
                let openNow = false;
                try {
                    openNow = await promptOpenNow(label);
                }
                catch (error) {
                    // The workset is already durably saved: Ctrl-C here declines
                    // the offer, it does not cancel the create.
                    if (!isPromptCancellationError(error)) {
                        throw error;
                    }
                }
                if (openNow) {
                    console.log('');
                    await this.open(workset.name, {});
                    return;
                }
            }
            console.log(`Open it any time with: openspec workset open ${workset.name}`);
        }
        catch (error) {
            emitFailure(options.json, { workset: null, status: [] }, error, 'workset_error');
        }
    }
    async composeFromFlags(name, options) {
        if (!name) {
            throw new StoreError('Pass a workset name.', 'workset_name_required', {
                target: 'workset.name',
                fix: 'openspec workset create <name> --member <path>',
            });
        }
        validateWorksetName(name);
        const memberFlags = options.member ?? [];
        if (memberFlags.length === 0) {
            throw new StoreError('Pass at least one member folder.', 'workset_members_required', {
                target: 'workset.member',
                fix: `openspec workset create ${name} --member <path> --member <name>=<path>`,
            });
        }
        const members = await resolveMemberFlags(memberFlags);
        // The opener table is read only when a tool is actually named - a
        // tool-less scripted create must not fail on unrelated config rows.
        const table = options.tool !== undefined ? readOpenerTable() : [];
        if (options.tool !== undefined) {
            const chosen = findOpener(table, options.tool);
            if (chosen !== null && !isOpenerEnabled(chosen)) {
                throw worksetCliOpenerDisabledError(chosen, name);
            }
        }
        return finalizeWorkset(name, members, options.tool, table);
    }
    async list(options = {}) {
        try {
            const state = await readWorksetsState();
            const worksets = listWorksets(state);
            if (options.json) {
                printJson({ worksets, status: [] });
                return;
            }
            if (worksets.length === 0) {
                console.log('No worksets saved. Create one with: openspec workset create');
                return;
            }
            // The table is consulted only to render tool labels.
            const table = worksets.some((workset) => workset.tool !== undefined)
                ? readOpenerTable()
                : [];
            for (const workset of worksets) {
                const toolLabel = workset.tool !== undefined
                    ? `  (opens in ${findOpener(table, workset.tool)?.label ?? workset.tool})`
                    : '';
                console.log(`${workset.name}${toolLabel}`);
                for (const row of formatMemberRows(workset.members)) {
                    console.log(`  ${row}`);
                }
            }
        }
        catch (error) {
            emitFailure(options.json, { worksets: [], status: [] }, error, 'workset_error');
        }
    }
    async open(name, options = {}) {
        let prepared;
        try {
            if (options.json) {
                throw new StoreError('workset open hands this terminal to the chosen tool and has no JSON mode.', 'workset_open_json_unsupported', {
                    target: 'workset.tool',
                    fix: 'Inspect worksets with: openspec workset list --json',
                });
            }
            // Regenerate the derived file FIRST (under the lock), so every
            // cannot-drive failure below can name an existing, current file.
            prepared = await withWorksetsLock(async (state) => {
                const workset = getWorkset(state, name);
                if (workset === null) {
                    throw worksetNotFoundError(name, state);
                }
                const checks = await Promise.all(workset.members.map(async (member) => ({
                    member,
                    exists: await pathIsDirectory(member.path),
                })));
                const surviving = checks
                    .filter((check) => check.exists)
                    .map((check) => check.member);
                const skipped = checks
                    .filter((check) => !check.exists)
                    .map((check) => check.member);
                if (surviving.length === 0) {
                    throw new StoreError(`No member folder of workset '${name}' exists on this machine.`, 'workset_no_members_available', {
                        target: 'workset.member',
                        fix: `Recompose it: openspec workset remove ${name} --yes && openspec workset create ${name} --member <path>`,
                    });
                }
                const codeWorkspacePath = getWorksetCodeWorkspacePath(name);
                await writeFileAtomically(codeWorkspacePath, buildWorksetCodeWorkspaceJson(surviving));
                return { workset, surviving, skipped, codeWorkspacePath };
            });
            for (const member of prepared.skipped) {
                console.error(`Skipped '${member.name}' (${member.path} is not available).`);
            }
            if (prepared.workset.members[0] !== prepared.surviving[0]) {
                const primary = prepared.surviving[0];
                console.error(`Using '${primary.name}' (${primary.path}) as the primary for this open.`);
            }
            const table = readOpenerTable();
            const toolId = options.tool ?? prepared.workset.tool;
            let opener;
            if (toolId !== undefined) {
                const found = findOpener(table, toolId);
                if (found === null) {
                    throw toolUnknownError(toolId, table);
                }
                if (!isOpenerEnabled(found)) {
                    throw worksetCliOpenerDisabledError(found, name);
                }
                if (!isOpenerCommandAvailable(found.command)) {
                    throw toolUnavailableError(found, table, name);
                }
                opener = found;
            }
            else {
                if (!isInteractive()) {
                    throw new StoreError(`Workset '${name}' has no saved tool.`, 'workset_tool_required', {
                        target: 'workset.tool',
                        fix: `openspec workset open ${name} --tool <id>`,
                    });
                }
                // The prompt offers only available openers, so the selection
                // needs no second scan.
                const available = listOpenerChoices(table).filter((choice) => choice.available);
                if (available.length === 0) {
                    throw noToolInstalledError(table, name);
                }
                const selectedId = await promptToolFromChoices(available);
                opener = available.find((choice) => choice.opener.id === selectedId).opener;
            }
            const launch = buildLaunchCommand(opener, {
                members: prepared.surviving,
                codeWorkspacePath: prepared.codeWorkspacePath,
            });
            if (opener.style === 'workspace-file') {
                console.log(`Opening '${name}' in ${opener.label} (a window opens; this command returns).`);
            }
            else {
                console.log(`Handing this terminal to ${opener.label} for '${name}' (the session ends when you exit).`);
            }
            let result;
            try {
                result = await launchOpenerCommand(launch);
            }
            catch (error) {
                // Make the launch-failure fix pasteable when an alternative is
                // installed (the launcher itself does not know the table).
                if (error instanceof StoreError &&
                    error.diagnostic.code === 'workset_launch_failed') {
                    const alternative = firstInstalledAlternative(table, opener.id);
                    if (alternative !== null) {
                        throw new StoreError(error.message, 'workset_launch_failed', {
                            target: 'workset.tool',
                            fix: `Run: openspec workset open ${name} --tool ${alternative}`,
                        });
                    }
                }
                throw error;
            }
            const exitCode = exitCodeForLaunch(result);
            if (exitCode !== 0) {
                process.exitCode = exitCode;
            }
        }
        catch (error) {
            emitFailure(options.json, { status: [] }, error, 'workset_error');
            // Never strand the user: once the derived file is regenerated,
            // every failure (except a prompt cancellation) carries the
            // manual route - the file path plus the members it contains.
            if (!options.json &&
                prepared !== undefined &&
                !isPromptCancellationError(error)) {
                console.error('Open manually:');
                console.error(`  Workspace file: ${prepared.codeWorkspacePath}`);
                console.error('  Members:');
                for (const row of formatMemberRows(prepared.surviving)) {
                    console.error(`    ${row}`);
                }
            }
        }
    }
    async remove(name, options = {}) {
        try {
            if (!options.yes) {
                // The pre-read serves the not-found priority and the confirm
                // display; the --yes path skips it (removeWorkset re-checks
                // under the lock anyway).
                const state = await readWorksetsState();
                const workset = getWorkset(state, name);
                if (workset === null) {
                    throw worksetNotFoundError(name, state);
                }
                if (options.json || !isInteractive()) {
                    throw new StoreError('Pass --yes to remove a workset non-interactively.', 'workset_remove_confirmation_required', {
                        target: 'workset.name',
                        fix: `openspec workset remove ${name} --yes`,
                    });
                }
                const confirmed = await confirmRemoveInteractively(workset);
                if (!confirmed) {
                    throw new StoreError('Workset remove cancelled.', 'workset_remove_cancelled', {
                        target: 'workset.name',
                        fix: 'Rerun remove when you are ready.',
                    });
                }
            }
            await removeWorkset(name);
            if (options.json) {
                printJson({ removed: { name }, status: [] });
                return;
            }
            console.log(`Removed workset '${name}'. Member folders were not touched.`);
        }
        catch (error) {
            emitFailure(options.json, { removed: null, status: [] }, error, 'workset_error');
        }
    }
}
//# sourceMappingURL=workset.js.map