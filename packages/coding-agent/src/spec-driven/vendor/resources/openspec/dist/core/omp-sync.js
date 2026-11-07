import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { Validator } from './validation/validator.js';
import { syncSpecDirectory, planSpecDirectorySync } from './archive.js';
import { loadChangeContext, generateInstructions } from './artifact-graph/index.js';
import { loadRootConfigContext } from '../commands/workflow/instructions.js';

// Private host process seam; not registered as an OpenSpec command.
const [action, encoded] = process.argv.slice(2);
let input;
const saveReceipt = async value => {
    if (!input.receiptPath) return;
    const temporary = `${input.receiptPath}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(value), { flag: 'wx' });
    await fs.rename(temporary, input.receiptPath);
};
try {
    input = JSON.parse(encoded);
    if (action === 'plan-directory') {
        console.log(JSON.stringify(await planSpecDirectorySync(input)));
    } else if (action === 'instructions-directory') {
        const root = {
            path: input.projectRoot,
            changesDir: `${input.projectRoot}/openspec/changes`,
            specsDir: `${input.projectRoot}/openspec/specs`,
            archiveDir: `${input.projectRoot}/openspec/changes/archive`,
            source: 'project',
        };
        const options = await loadRootConfigContext(root);
        const context = loadChangeContext(input.projectRoot, input.changeName, input.schema, {
            changeDir: input.changeDir, projectConfig: options.projectConfig,
        });
        console.log(JSON.stringify(generateInstructions(context, input.artifactId, input.projectRoot, options)));
    } else if (action === 'validate-directory') {
        const validator = new Validator(true);
        const report = input.artifact === 'proposal'
            ? await validator.validateChange(join(input.changeDir, 'proposal.md'))
            : await validator.validateChangeDeltaSpecs(input.changeDir, {
                projectRoot: input.projectRoot, mainSpecsDir: input.mainSpecsDir,
            });
        if (input.artifact === 'proposal') {
            // Match archive's proposal-only projection. The legacy change schema
            // also checks delta requirement bodies and mislabels valid names-only
            // REMOVED entries; the separate delta validator owns those rules.
            report.issues = report.issues.filter(issue => !/^deltas\.\d+\.requirements?\./.test(issue.path));
            report.summary = { errors: 0, warnings: 0, info: 0 };
            for (const issue of report.issues) {
                if (issue.level === 'ERROR') report.summary.errors++;
                else if (issue.level === 'WARNING') report.summary.warnings++;
                else if (issue.level === 'INFO') report.summary.info++;
            }
            report.valid = report.summary.errors === 0 && report.summary.warnings === 0;
        }
        console.log(JSON.stringify(report));
        if (!report.valid) process.exitCode = 1;
    } else if (action === 'sync-directory') {
        await saveReceipt({ binding: input.binding, state: 'started', input: {
            expectedTargets: input.expectedTargets, expectedSources: input.expectedSources,
        } });
        const result = await syncSpecDirectory(input);
        await saveReceipt({ binding: input.binding, state: 'completed', result });
        console.log(JSON.stringify({ result }));
    } else {
        throw new Error(`Unknown internal OpenSpec directory action: ${action}`);
    }
} catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failure = { message, progress: error?.progress ?? {}, targets: input?.expectedTargets ?? [] };
    if (message.includes('Rollback also failed:') && !failure.progress.sideEffects) {
        failure.progress.sideEffects = {
            paths: (input?.expectedTargets ?? []).map(file => file.path),
            expectedVersions: input?.expectedTargets ?? [],
            diagnostic: message,
        };
    }
    if (action === 'sync-directory' && input) {
        try { await saveReceipt({ binding: input.binding, state: 'failed', failure }); }
        catch (receiptError) {
            failure.message += ` Could not persist sync recovery: ${receiptError instanceof Error ? receiptError.message : String(receiptError)}`;
        }
    }
    console.log(JSON.stringify({ failure }));
    process.exitCode = 1;
}
