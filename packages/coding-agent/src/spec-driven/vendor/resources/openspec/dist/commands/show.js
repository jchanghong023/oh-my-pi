import { isInteractive } from '../utils/interactive.js';
import { getActiveChangeIds, getSpecIds } from '../utils/item-discovery.js';
import { resolveRootForCommand, toRootOutput, withStoreFlag, isStoreSelectedRoot, } from '../core/root-selection.js';
import { ChangeCommand } from './change.js';
import { SpecCommand } from './spec.js';
import { nearestMatches } from '../utils/match.js';
const CHANGE_FLAG_KEYS = new Set(['deltasOnly', 'requirementsOnly', 'diff']);
const SPEC_FLAG_KEYS = new Set(['requirements', 'scenarios', 'requirement']);
export class ShowCommand {
    async execute(itemName, options = {}) {
        const root = await resolveRootForCommand(options, { json: options.json });
        if (!root) {
            return;
        }
        const interactive = isInteractive(options);
        const typeOverride = this.normalizeType(options.type);
        if (!itemName) {
            if (interactive) {
                const { select } = await import('@inquirer/prompts');
                const type = await select({
                    message: 'What would you like to show?',
                    choices: [
                        { name: 'Change', value: 'change' },
                        { name: 'Spec', value: 'spec' },
                    ],
                });
                await this.runInteractiveByType(type, options, root);
                return;
            }
            this.printNonInteractiveHint(root);
            process.exitCode = 1;
            return;
        }
        await this.showDirect(itemName, { typeOverride, options, root });
    }
    normalizeType(value) {
        if (!value)
            return undefined;
        const v = value.toLowerCase();
        if (v === 'change' || v === 'spec')
            return v;
        return undefined;
    }
    delegateOptions(root, options) {
        return {
            ...options,
            ...(options.json ? { rootOutput: toRootOutput(root) } : {}),
        };
    }
    async runInteractiveByType(type, options, root) {
        const { select } = await import('@inquirer/prompts');
        if (type === 'change') {
            const changes = await getActiveChangeIds(root.path);
            if (changes.length === 0) {
                console.error('No changes found.');
                process.exitCode = 1;
                return;
            }
            const picked = await select({ message: 'Pick a change', choices: changes.map(id => ({ name: id, value: id })) });
            const cmd = new ChangeCommand(root.path);
            await cmd.show(picked, this.delegateOptions(root, options));
            return;
        }
        const specs = await getSpecIds(root.path);
        if (specs.length === 0) {
            console.error('No specs found.');
            process.exitCode = 1;
            return;
        }
        const picked = await select({ message: 'Pick a spec', choices: specs.map(id => ({ name: id, value: id })) });
        const cmd = new SpecCommand(root.path);
        await cmd.show(picked, this.delegateOptions(root, options));
    }
    async showDirect(itemName, params) {
        const root = params.root;
        // Optimize lookups when type is pre-specified
        let isChange = false;
        let isSpec = false;
        let changes = [];
        let specs = [];
        if (params.typeOverride === 'change') {
            changes = await getActiveChangeIds(root.path);
            isChange = changes.includes(itemName);
        }
        else if (params.typeOverride === 'spec') {
            specs = await getSpecIds(root.path);
            isSpec = specs.includes(itemName);
        }
        else {
            [changes, specs] = await Promise.all([getActiveChangeIds(root.path), getSpecIds(root.path)]);
            isChange = changes.includes(itemName);
            isSpec = specs.includes(itemName);
        }
        const resolvedType = params.typeOverride ?? (isChange ? 'change' : isSpec ? 'spec' : undefined);
        if (!resolvedType) {
            const suggestions = nearestMatches(itemName, [...changes, ...specs]);
            const message = suggestions.length
                ? `Unknown item '${itemName}'. Did you mean: ${suggestions.join(', ')}?`
                : `Unknown item '${itemName}'.`;
            if (params.options.json) {
                console.log(JSON.stringify({ status: [{ severity: 'error', code: 'unknown_item', message }] }, null, 2));
            }
            else {
                console.error(message);
            }
            process.exitCode = 1;
            return;
        }
        if (!params.typeOverride && isChange && isSpec) {
            if (params.options.json) {
                console.log(JSON.stringify({
                    status: [
                        {
                            severity: 'error',
                            code: 'ambiguous_item',
                            message: `Ambiguous item '${itemName}' matches both a change and a spec.`,
                            fix: 'Pass --type change|spec.',
                        },
                    ],
                }, null, 2));
                process.exitCode = 1;
                return;
            }
            console.error(`Ambiguous item '${itemName}' matches both a change and a spec.`);
            // The noun-form commands are cwd-based and cannot reach a selected store.
            if (isStoreSelectedRoot(root)) {
                console.error('Pass --type change|spec.');
            }
            else {
                console.error('Pass --type change|spec, or use: openspec change show / openspec spec show');
            }
            process.exitCode = 1;
            return;
        }
        this.warnIrrelevantFlags(resolvedType, params.options);
        if (resolvedType === 'change') {
            const cmd = new ChangeCommand(root.path);
            await cmd.show(itemName, this.delegateOptions(root, params.options));
            return;
        }
        const cmd = new SpecCommand(root.path);
        await cmd.show(itemName, this.delegateOptions(root, params.options));
    }
    printNonInteractiveHint(root) {
        console.error('Nothing to show. Try one of:');
        console.error(`  ${withStoreFlag(root, 'openspec show <item>')}`);
        if (isStoreSelectedRoot(root)) {
            // The noun-form commands are cwd-based and cannot reach a selected store.
            console.error(`  ${withStoreFlag(root, 'openspec show <item> --type change')}`);
            console.error(`  ${withStoreFlag(root, 'openspec show <item> --type spec')}`);
        }
        else {
            console.error('  openspec change show');
            console.error('  openspec spec show');
        }
        console.error('Or run in an interactive terminal.');
    }
    warnIrrelevantFlags(type, options) {
        const irrelevant = [];
        // --no-scenarios makes commander default `scenarios` to true, so its
        // presence alone does not mean the user passed it — only false does.
        const isUserProvided = (k) => k === 'scenarios' ? options[k] === false : k in options;
        if (type === 'change') {
            for (const k of SPEC_FLAG_KEYS)
                if (isUserProvided(k))
                    irrelevant.push(k);
        }
        else {
            for (const k of CHANGE_FLAG_KEYS)
                if (isUserProvided(k))
                    irrelevant.push(k);
        }
        if (irrelevant.length > 0) {
            console.error(`Warning: Ignoring flags not applicable to ${type}: ${irrelevant.join(', ')}`);
            return true;
        }
        return false;
    }
}
//# sourceMappingURL=show.js.map