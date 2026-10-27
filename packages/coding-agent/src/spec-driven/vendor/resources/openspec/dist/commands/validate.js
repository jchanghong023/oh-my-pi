import path from 'path';
import { describeNestedChange, findNestedChangesIn, NESTED_CHANGE_ISSUE_MARKER, } from '../utils/nested-change.js';
import { Validator } from '../core/validation/validator.js';
import { VALIDATION_MESSAGES } from '../core/validation/constants.js';
import { resolveRootForCommand, toRootOutput, withStoreFlag, isStoreSelectedRoot, } from '../core/root-selection.js';
import { canRenderSpinner, isInteractive, resolveNoInteractive } from '../utils/interactive.js';
import { getSpecIds } from '../utils/item-discovery.js';
import { getAvailableChanges } from './workflow/shared.js';
import { nearestMatches } from '../utils/match.js';
import { promises as fs } from 'fs';
import { getTaskProgressDetailForChange } from '../utils/task-progress.js';
import { FileSystemUtils } from '../utils/file-system.js';
import { folderStyleNameProblem } from '../core/id.js';
/** Findings are a distinct report, not a partial full-v1 items collection. */
export function projectValidationFindings(full, scope) {
    const itemFindings = full.items.filter(item => item.issues.length > 0);
    return {
        report: {
            kind: 'validation-findings',
            version: '1.0',
            scope,
            returnedItems: itemFindings.length,
            totalItems: full.summary.totals.items,
        },
        itemFindings,
        summary: full.summary,
        root: full.root,
    };
}
export class ValidateCommand {
    async execute(itemName, options = {}) {
        const bulk = options.all || options.changes || options.specs;
        let findingsScope;
        if (options.report !== undefined) {
            const message = options.report !== 'full' && options.report !== 'findings'
                ? `Unknown validation report '${options.report}'.`
                : itemName !== undefined
                    ? 'A validation report cannot be combined with an item name.'
                    : options.archived && bulk
                        ? 'A validation report cannot combine archived and active scopes.'
                        : !options.archived && !bulk
                            ? 'A validation report requires an explicit bulk scope.'
                            : undefined;
            if (message) {
                const fix = 'Use --report full|findings with --all, --changes, --specs, or --archived, without an item name. Do not combine archived and active scopes.';
                if (options.json) {
                    console.log(JSON.stringify({ status: [{ severity: 'error', code: 'invalid_validation_report_request', message, fix }] }, null, 2));
                }
                else {
                    console.error(`Error: ${message}`);
                    console.error(`Fix: ${fix}`);
                }
                process.exitCode = 1;
                return;
            }
            if (options.report === 'findings') {
                findingsScope = options.archived ? 'archived'
                    : options.all || (options.changes && options.specs) ? 'all'
                        : options.changes ? 'changes' : 'specs';
            }
        }
        const root = await resolveRootForCommand(options, {
            json: options.json,
            ...(bulk ? { allowImplicitRoot: false } : {}),
        });
        if (!root) {
            return;
        }
        const interactive = isInteractive(options);
        // Archived-task linting is its own scope: it checks task completion of
        // already-archived changes, not delta specs (whose operations are already
        // applied). Handled before the other bulk flags so `--archived` is explicit
        // and never alters an existing invocation's behavior (#205).
        if (options.archived) {
            await this.runArchivedTaskValidation(root, {
                json: !!options.json,
                noInteractive: resolveNoInteractive(options),
                findingsScope,
            });
            return;
        }
        // Handle bulk flags first
        if (bulk) {
            await this.runBulkValidation(root, {
                changes: !!options.all || !!options.changes,
                specs: !!options.all || !!options.specs,
            }, { strict: !!options.strict, json: !!options.json, concurrency: options.concurrency, noInteractive: resolveNoInteractive(options), findingsScope });
            return;
        }
        // No item and no flags
        if (!itemName) {
            if (interactive) {
                await this.runInteractiveSelector(root, { strict: !!options.strict, json: !!options.json, concurrency: options.concurrency });
                return;
            }
            this.printNonInteractiveHint(root);
            process.exitCode = 1;
            return;
        }
        // Direct item validation with type detection or override
        const typeOverride = this.normalizeType(options.type);
        await this.validateDirectItem(root, itemName, { typeOverride, strict: !!options.strict, json: !!options.json });
    }
    normalizeType(value) {
        if (!value)
            return undefined;
        const v = value.toLowerCase();
        if (v === 'change' || v === 'spec')
            return v;
        return undefined;
    }
    /**
     * Resolve change IDs by directory existence within the resolved root — the
     * same rule `openspec status`/`instructions` use (`getAvailableChanges`) —
     * rather than requiring `proposal.md`. This lets `validate` resolve a
     * scaffolded or still-authoring change that the sibling commands already
     * resolve (#1182). Sorted to preserve the prior `getActiveChangeIds` ordering.
     */
    async listChangeIds(root) {
        const ids = await getAvailableChanges(root.path, root.changesDir);
        return ids.sort();
    }
    async runInteractiveSelector(root, opts) {
        const { select } = await import('@inquirer/prompts');
        const choice = await select({
            message: 'What would you like to validate?',
            choices: [
                { name: 'All (changes + specs)', value: 'all' },
                { name: 'All changes', value: 'changes' },
                { name: 'All specs', value: 'specs' },
                { name: 'Pick a specific change or spec', value: 'one' },
            ],
        });
        if (choice === 'all')
            return this.runBulkValidation(root, { changes: true, specs: true }, opts);
        if (choice === 'changes')
            return this.runBulkValidation(root, { changes: true, specs: false }, opts);
        if (choice === 'specs')
            return this.runBulkValidation(root, { changes: false, specs: true }, opts);
        // one
        const [changes, specs] = await Promise.all([this.listChangeIds(root), getSpecIds(root.path)]);
        const items = [];
        items.push(...changes.map(id => ({ name: `change/${id}`, value: { type: 'change', id } })));
        items.push(...specs.map(id => ({ name: `spec/${id}`, value: { type: 'spec', id } })));
        if (items.length === 0) {
            console.error('No items found to validate.');
            process.exitCode = 1;
            return;
        }
        const picked = await select({ message: 'Pick an item', choices: items });
        await this.validateByType(root, picked.type, picked.id, opts);
    }
    printNonInteractiveHint(root) {
        console.error('Nothing to validate. Try one of:');
        console.error(`  ${withStoreFlag(root, 'openspec validate --all')}`);
        console.error(`  ${withStoreFlag(root, 'openspec validate --changes')}`);
        console.error(`  ${withStoreFlag(root, 'openspec validate --specs')}`);
        console.error(`  ${withStoreFlag(root, 'openspec validate <item-name>')}`);
        console.error('Or run in an interactive terminal.');
    }
    async validateDirectItem(root, itemName, opts) {
        const [changes, specs] = await Promise.all([this.listChangeIds(root), getSpecIds(root.path)]);
        const isChange = changes.includes(itemName);
        const isSpec = specs.includes(itemName);
        const type = opts.typeOverride ?? (isChange ? 'change' : isSpec ? 'spec' : undefined);
        if (!type) {
            const suggestions = nearestMatches(itemName, [...changes, ...specs]);
            const message = suggestions.length
                ? `Unknown item '${itemName}'. Did you mean: ${suggestions.join(', ')}?`
                : `Unknown item '${itemName}'.`;
            if (opts.json) {
                console.log(JSON.stringify({ status: [{ severity: 'error', code: 'unknown_item', message }] }, null, 2));
            }
            else {
                console.error(message);
            }
            process.exitCode = 1;
            return;
        }
        if (!opts.typeOverride && isChange && isSpec) {
            if (opts.json) {
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
                console.error('Pass --type change|spec, or use: openspec change validate / openspec spec validate');
            }
            process.exitCode = 1;
            return;
        }
        await this.validateByType(root, type, itemName, opts);
    }
    /**
     * A namespace folder wrapping nested change directories has no deltas of its
     * own and never will. The usual "add a delta spec" error points the author at
     * a directory that is not the change, so the nesting is reported instead
     * (#1846). Returns undefined for every ordinary change.
     */
    async nestedChangeReport(root, id) {
        const nested = await findNestedChangesIn(root.changesDir, id);
        if (!nested)
            return undefined;
        return {
            valid: false,
            issues: [{ level: 'ERROR', path: 'file', message: describeNestedChange(nested) }],
        };
    }
    async validateByType(root, type, id, opts) {
        // `--type` skips the membership check above, so the name still has to be
        // guarded before it is joined onto a directory. `show` already rejects a
        // traversing id.
        //
        // Spec ids are nested (`specs/<area>/<capability>/spec.md`, #1353), so the
        // guard runs per segment - rejecting the whole id for containing a `/`
        // would break every nested capability, including the hint that
        // `validate --specs` prints. Change names are flat, so they keep the
        // whole-value check.
        const nameProblem = type === 'change'
            ? folderStyleNameProblem(id, 'Change name')
            : (id.split('/').map((segment) => folderStyleNameProblem(segment, 'Spec id')).find(Boolean) ?? null);
        if (nameProblem) {
            if (opts.json) {
                console.log(JSON.stringify({ status: [{ severity: 'error', code: 'invalid_item', message: nameProblem }] }, null, 2));
            }
            else {
                console.error(nameProblem);
            }
            process.exitCode = 1;
            return;
        }
        const validator = new Validator(opts.strict);
        if (type === 'change') {
            const changeDir = path.join(root.changesDir, id);
            const start = Date.now();
            const nestedReport = await this.nestedChangeReport(root, id);
            if (nestedReport) {
                this.printReport('change', id, nestedReport, Date.now() - start, opts.json, root);
                process.exitCode = 1;
                return;
            }
            const report = await validator.validateChangeDeltaSpecs(changeDir, {
                mainSpecsDir: root.specsDir,
                projectRoot: root.path,
            });
            const durationMs = Date.now() - start;
            this.printReport('change', id, report, durationMs, opts.json, root);
            // Non-zero exit if invalid (keeps enriched output test semantics)
            process.exitCode = report.valid ? 0 : 1;
            return;
        }
        const file = path.join(root.specsDir, id, 'spec.md');
        const start = Date.now();
        const report = await validator.validateSpec(file);
        const durationMs = Date.now() - start;
        this.printReport('spec', id, report, durationMs, opts.json, root);
        process.exitCode = report.valid ? 0 : 1;
    }
    printReport(type, id, report, durationMs, json, root) {
        if (json) {
            const out = { items: [{ id, type, valid: report.valid, issues: report.issues, durationMs }], summary: { totals: { items: 1, passed: report.valid ? 1 : 0, failed: report.valid ? 0 : 1 }, byType: { [type]: { items: 1, passed: report.valid ? 1 : 0, failed: report.valid ? 0 : 1 } } }, version: '1.0', root: toRootOutput(root) };
            console.log(JSON.stringify(out, null, 2));
            return;
        }
        if (report.valid) {
            console.log(`${type === 'change' ? 'Change' : 'Specification'} '${id}' is valid`);
        }
        else {
            console.error(`${type === 'change' ? 'Change' : 'Specification'} '${id}' has issues`);
        }
        for (const issue of report.issues) {
            const prefix = issue.level === 'ERROR' ? '✗' : issue.level === 'WARNING' ? '⚠' : 'ℹ';
            console.error(`${prefix} [${issue.level}] ${issue.path}: ${issue.message}`);
        }
        if (!report.valid) {
            this.printNextSteps(type, id, root, report.issues);
        }
    }
    printNextSteps(type, id, root, issues = []) {
        const bullets = [];
        // The delta-authoring bullets contradict a marker-related error ("add
        // deltas" vs "remove skip_specs or the files"), so branch on the exact
        // marker messages - the generic no-deltas guidance also mentions
        // skip_specs, which must not trigger this.
        const conflictIssue = issues.some(i => i.message.includes(VALIDATION_MESSAGES.CHANGE_SKIP_SPECS_CONFLICT));
        const invalidMarkerIssue = issues.some(i => i.message.includes(VALIDATION_MESSAGES.CHANGE_SKIP_SPECS_INVALID_METADATA));
        // A namespace folder has no deltas to author, so the delta-authoring
        // bullets below would point at a directory that is not the change (#1846).
        const nestedIssue = issues.some(i => i.message.includes(NESTED_CHANGE_ISSUE_MARKER));
        if (type === 'change' && nestedIssue) {
            bullets.push('- Move each nested change directly under openspec/changes/, folding the namespace into its name');
            bullets.push('- Only specs may be nested by domain; change directories are always flat');
        }
        else if (type === 'change' && conflictIssue) {
            bullets.push('- This change declares skip_specs (no spec deltas): delete the files under specs/, or remove skip_specs from .openspec.yaml if requirements do change');
            bullets.push('- skip_specs is only honored when .openspec.yaml is valid change metadata (schema: <name> naming a known schema is required)');
        }
        else if (type === 'change' && invalidMarkerIssue) {
            bullets.push('- Fix .openspec.yaml so the skip_specs marker can be honored (schema: <name> naming a known schema is required)');
            bullets.push('- Or remove skip_specs from .openspec.yaml and add delta specs instead');
        }
        else if (type === 'change') {
            bullets.push('- Ensure change has deltas in specs/: use headers ## ADDED/MODIFIED/REMOVED/RENAMED Requirements');
            bullets.push('- Each requirement MUST include at least one #### Scenario: block');
            bullets.push(`- Debug parsed deltas: ${withStoreFlag(root, `openspec show ${id} --json --deltas-only`)}`);
        }
        else {
            bullets.push('- Ensure spec includes ## Purpose and ## Requirements sections');
            bullets.push('- Each requirement MUST include at least one #### Scenario: block');
            bullets.push('- Re-run with --json to see structured report');
        }
        console.error('Next steps:');
        bullets.forEach(b => console.error(`  ${b}`));
    }
    printFindingsReport(full, scope, json, root) {
        const findings = projectValidationFindings(full, scope);
        if (json) {
            console.log(JSON.stringify(findings, null, 2));
            return;
        }
        console.log(`Scope: ${scope} (${findings.report.totalItems} items)`);
        if (findings.itemFindings.length === 0) {
            console.log('No item findings.');
        }
        for (const item of findings.itemFindings) {
            console.error(`${item.type}/${item.id}`);
            for (const issue of item.issues) {
                console.error(`  [${issue.level}] ${issue.path}: ${issue.message}`);
            }
        }
        const totals = findings.summary.totals;
        console.log(`Totals: ${totals.passed} passed, ${totals.failed} failed (${totals.items} items)`);
        if (scope !== 'archived')
            this.printBulkDetails(full.items, root);
    }
    printBulkDetails(results, root) {
        const firstFailure = results.find((res) => !res.valid);
        if (firstFailure) {
            const storeFlag = isStoreSelectedRoot(root) ? ` --store ${root.storeId}` : '';
            console.log(`Details: openspec validate ${firstFailure.id} --type ${firstFailure.type}${storeFlag}`);
        }
    }
    async runBulkValidation(root, scope, opts) {
        let spinner;
        if (!opts.json && isInteractive(opts) && canRenderSpinner()) {
            const { default: ora } = await import('ora');
            spinner = ora('Validating...').start();
        }
        const [changeIds, specIds] = await Promise.all([
            scope.changes ? this.listChangeIds(root) : Promise.resolve([]),
            scope.specs ? getSpecIds(root.path) : Promise.resolve([]),
        ]);
        const DEFAULT_CONCURRENCY = 6;
        const maxSuggestions = 5; // used by nearestMatches
        const concurrency = normalizeConcurrency(opts.concurrency) ?? normalizeConcurrency(process.env.OPENSPEC_CONCURRENCY) ?? DEFAULT_CONCURRENCY;
        const validator = new Validator(opts.strict);
        const queue = [];
        for (const id of changeIds) {
            queue.push(async () => {
                const start = Date.now();
                const changeDir = path.join(root.changesDir, id);
                const nestedReport = await this.nestedChangeReport(root, id);
                if (nestedReport) {
                    return {
                        id,
                        type: 'change',
                        valid: false,
                        issues: nestedReport.issues,
                        durationMs: Date.now() - start,
                    };
                }
                const report = await validator.validateChangeDeltaSpecs(changeDir, {
                    mainSpecsDir: root.specsDir,
                    projectRoot: root.path,
                });
                const durationMs = Date.now() - start;
                return { id, type: 'change', valid: report.valid, issues: report.issues, durationMs };
            });
        }
        for (const id of specIds) {
            queue.push(async () => {
                const start = Date.now();
                const file = path.join(root.specsDir, id, 'spec.md');
                const report = await validator.validateSpec(file);
                const durationMs = Date.now() - start;
                return { id, type: 'spec', valid: report.valid, issues: report.issues, durationMs };
            });
        }
        if (queue.length === 0) {
            spinner?.stop();
            const summary = {
                totals: { items: 0, passed: 0, failed: 0 },
                byType: {
                    ...(scope.changes ? { change: { items: 0, passed: 0, failed: 0 } } : {}),
                    ...(scope.specs ? { spec: { items: 0, passed: 0, failed: 0 } } : {}),
                },
            };
            if (opts.findingsScope) {
                this.printFindingsReport({ items: [], summary, root: toRootOutput(root) }, opts.findingsScope, opts.json, root);
            }
            else if (opts.json) {
                const out = { items: [], summary, version: '1.0', root: toRootOutput(root) };
                console.log(JSON.stringify(out, null, 2));
            }
            else {
                console.log('No items found to validate.');
            }
            process.exitCode = 0;
            return;
        }
        const results = [];
        let index = 0;
        let running = 0;
        let passed = 0;
        let failed = 0;
        await new Promise((resolve) => {
            const next = () => {
                while (running < concurrency && index < queue.length) {
                    const currentIndex = index++;
                    const task = queue[currentIndex];
                    running++;
                    if (spinner)
                        spinner.text = `Validating (${currentIndex + 1}/${queue.length})...`;
                    task()
                        .then(res => {
                        results.push(res);
                        if (res.valid)
                            passed++;
                        else
                            failed++;
                    })
                        .catch((error) => {
                        const message = error?.message || 'Unknown error';
                        const res = { id: getPlannedId(currentIndex, changeIds, specIds) ?? 'unknown', type: getPlannedType(currentIndex, changeIds, specIds) ?? 'change', valid: false, issues: [{ level: 'ERROR', path: 'file', message }], durationMs: 0 };
                        results.push(res);
                        failed++;
                    })
                        .finally(() => {
                        running--;
                        if (index >= queue.length && running === 0)
                            resolve();
                        else
                            next();
                    });
                }
            };
            next();
        });
        spinner?.stop();
        results.sort((a, b) => a.id.localeCompare(b.id));
        const summary = {
            totals: { items: results.length, passed, failed },
            byType: {
                ...(scope.changes ? { change: summarizeType(results, 'change') } : {}),
                ...(scope.specs ? { spec: summarizeType(results, 'spec') } : {}),
            },
        };
        if (opts.findingsScope) {
            this.printFindingsReport({ items: results, summary, root: toRootOutput(root) }, opts.findingsScope, opts.json, root);
        }
        else if (opts.json) {
            const out = { items: results, summary, version: '1.0', root: toRootOutput(root) };
            console.log(JSON.stringify(out, null, 2));
        }
        else {
            for (const res of results) {
                if (res.valid)
                    console.log(`✓ ${res.type}/${res.id}`);
                else
                    console.error(`✗ ${res.type}/${res.id}`);
                for (const issue of res.issues) {
                    const prefix = issue.level === 'ERROR' ? '✗' : issue.level === 'WARNING' ? '⚠' : 'ℹ';
                    console.error(`  ${prefix} [${issue.level}] ${issue.path}: ${issue.message}`);
                }
            }
            console.log(`Totals: ${summary.totals.passed} passed, ${summary.totals.failed} failed (${summary.totals.items} items)`);
            this.printBulkDetails(results, root);
        }
        process.exitCode = failed > 0 ? 1 : 0;
    }
    /**
     * Lists archived change ids from the resolved root's archive directory,
     * mirroring `getArchivedChangeIds` but store-aware (uses `root.archiveDir`
     * rather than a cwd-relative path). Directories only, hidden entries skipped.
     *
     * Only a missing archive directory (ENOENT) is an empty list; a permission
     * error, an I/O error, or an `archive` path that is a file (ENOTDIR) is a real
     * failure and must not read as "no archived changes" — that would let a
     * pre-commit lint pass without inspecting anything (#205).
     */
    async listArchivedChangeIds(root) {
        try {
            const entries = await fs.readdir(root.archiveDir, { withFileTypes: true });
            return entries
                .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
                .map((entry) => entry.name)
                .sort();
        }
        catch (error) {
            if (error?.code === 'ENOENT')
                return [];
            throw error;
        }
    }
    /**
     * Validates that every archived change has all of its tasks completed.
     *
     * An archived change is expected to be finished; an archived change with
     * unchecked tasks is a real integrity problem the normal validate flow never
     * surfaces, because active-change discovery excludes the archive directory
     * (#205). Reuses the same task-progress counting `status`, `list`, and
     * `archive` rely on, so what counts as a task never forks. Changes with no
     * tasks pass (nothing to complete).
     */
    async runArchivedTaskValidation(root, opts) {
        // List first (may throw on a real archive-read failure), then start the
        // spinner so a thrown error never leaves a spinner spinning.
        const ids = await this.listArchivedChangeIds(root);
        let spinner;
        if (!opts.json && isInteractive(opts) && canRenderSpinner()) {
            const { default: ora } = await import('ora');
            spinner = ora('Validating archived changes...').start();
        }
        // The archive is append-only and can hold thousands of changes; a single
        // run resolves them all under one constant projectRoot (root.path), so
        // memoize the schema→glob lookup to avoid re-parsing the same schema.yaml
        // once per change. The loop is intentionally sequential: the per-change work
        // is dominated by synchronous schema/config resolution, which a promise pool
        // cannot overlap on Node's single thread — a pool would add complexity for
        // no real gain here.
        const schemaGlobCache = new Map();
        const results = [];
        let passed = 0;
        let failed = 0;
        for (const id of ids) {
            const start = Date.now();
            const issues = [];
            try {
                // The explicit root.path override is load-bearing: an archived change
                // lives one directory deeper (changes/archive/<id>), so the default
                // "../../.." projectRoot derivation would be wrong without it.
                const progress = await getTaskProgressDetailForChange(root.archiveDir, id, root.path, schemaGlobCache);
                // A tasks file that exists but cannot be read must fail loudly, not be
                // silently counted as "no tasks" and pass. Report one issue per file,
                // pathed like every other validate issue (POSIX, root-relative).
                for (const file of progress.unreadable) {
                    issues.push({
                        level: 'ERROR',
                        path: FileSystemUtils.toPosixPath(path.relative(root.path, file)),
                        message: 'could not read task file',
                    });
                }
                const incomplete = Math.max(progress.total - progress.completed, 0);
                if (incomplete > 0) {
                    issues.push({
                        level: 'ERROR',
                        path: 'tasks.md',
                        message: `${incomplete} incomplete task${incomplete === 1 ? '' : 's'} (${progress.completed}/${progress.total} completed)`,
                    });
                }
            }
            catch (error) {
                issues.push({ level: 'ERROR', path: 'tasks.md', message: error?.message || 'Unknown error' });
            }
            const valid = issues.length === 0;
            if (valid)
                passed++;
            else
                failed++;
            results.push({ id, type: 'change', valid, issues, durationMs: Date.now() - start });
        }
        spinner?.stop();
        const summary = {
            totals: { items: results.length, passed, failed },
            byType: { change: summarizeType(results, 'change') },
        };
        if (opts.findingsScope) {
            this.printFindingsReport({ items: results, summary, root: toRootOutput(root) }, opts.findingsScope, opts.json, root);
            process.exitCode = failed > 0 ? 1 : 0;
            return;
        }
        if (opts.json) {
            const out = { items: results, summary, version: '1.0', root: toRootOutput(root) };
            console.log(JSON.stringify(out, null, 2));
            process.exitCode = failed > 0 ? 1 : 0;
            return;
        }
        if (results.length === 0) {
            console.log('No archived changes found.');
            process.exitCode = 0;
            return;
        }
        // Use the same `<type>/<id>` prefix bulk validation prints, so the plain
        // output maps to the JSON `type` ('change') and stays greppable the same way.
        for (const res of results) {
            if (res.valid) {
                console.log(`✓ change/${res.id}`);
            }
            else {
                console.error(`✗ change/${res.id}`);
                for (const issue of res.issues) {
                    const prefix = issue.level === 'ERROR' ? '✗' : issue.level === 'WARNING' ? '⚠' : 'ℹ';
                    console.error(`  ${prefix} ${issue.message}`);
                }
            }
        }
        console.log(`Totals: ${summary.totals.passed} passed, ${summary.totals.failed} failed (${summary.totals.items} items)`);
        process.exitCode = failed > 0 ? 1 : 0;
    }
}
function summarizeType(results, type) {
    const filtered = results.filter(r => r.type === type);
    const items = filtered.length;
    const passed = filtered.filter(r => r.valid).length;
    const failed = items - passed;
    return { items, passed, failed };
}
function normalizeConcurrency(value) {
    if (!value)
        return undefined;
    const n = parseInt(value, 10);
    if (Number.isNaN(n) || n <= 0)
        return undefined;
    return n;
}
function getPlannedId(index, changeIds, specIds) {
    const totalChanges = changeIds.length;
    if (index < totalChanges)
        return changeIds[index];
    const specIndex = index - totalChanges;
    return specIds[specIndex];
}
function getPlannedType(index, changeIds, specIds) {
    const totalChanges = changeIds.length;
    if (index < totalChanges)
        return 'change';
    const specIndex = index - totalChanges;
    if (specIndex >= 0 && specIndex < specIds.length)
        return 'spec';
    return undefined;
}
//# sourceMappingURL=validate.js.map