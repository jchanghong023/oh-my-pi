import { existsSync, readFileSync } from 'fs';
import path, { join } from 'path';
import { MarkdownParser } from '../core/parsers/markdown-parser.js';
import { Validator } from '../core/validation/validator.js';
import { isInteractive } from '../utils/interactive.js';
import { getSpecIds } from '../utils/item-discovery.js';
import { discoverSpecFiles } from '../utils/spec-discovery.js';
import { assertDiscoveredSpecFile } from '../utils/spec-path-containment.js';
const SPECS_DIR = 'openspec/specs';
function assertSpecPath(specsDir, specPath) {
    const relativePath = path.relative(path.resolve(specsDir), path.resolve(specPath));
    if (relativePath === '..' ||
        relativePath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativePath)) {
        throw new Error(`Path is outside the allowed directory: ${specPath}`);
    }
    assertDiscoveredSpecFile(specsDir, specPath);
}
function parseSpecFromFile(specsDir, specPath, specId) {
    assertSpecPath(specsDir, specPath);
    const content = readFileSync(specPath, 'utf-8');
    const parser = new MarkdownParser(content);
    return parser.parseSpec(specId);
}
function validateRequirementIndex(spec, requirementOpt) {
    if (!requirementOpt)
        return undefined;
    const index = Number.parseInt(requirementOpt, 10);
    if (!Number.isInteger(index) || index < 1 || index > spec.requirements.length) {
        throw new Error(`Requirement ${requirementOpt} not found`);
    }
    return index - 1; // convert to 0-based
}
function filterSpec(spec, options) {
    const requirementIndex = validateRequirementIndex(spec, options.requirement);
    const includeScenarios = options.scenarios !== false && !options.requirements;
    const filteredRequirements = (requirementIndex !== undefined
        ? [spec.requirements[requirementIndex]]
        : spec.requirements).map(req => ({
        name: req.name,
        text: req.text,
        scenarios: includeScenarios ? req.scenarios : [],
    }));
    const metadata = spec.metadata ?? { version: '1.0.0', format: 'openspec' };
    return {
        name: spec.name,
        overview: spec.overview,
        requirements: filteredRequirements,
        metadata,
    };
}
/**
 * Print the raw markdown content for a spec file without any formatting.
 * Raw-first behavior ensures text mode is a passthrough for deterministic output.
 */
function printSpecTextRaw(specsDir, specPath) {
    assertSpecPath(specsDir, specPath);
    const content = readFileSync(specPath, 'utf-8');
    console.log(content);
}
export class SpecCommand {
    specsDir;
    rootPath;
    // rootPath is set only by root-aware callers (top-level `show`); the
    // deprecated noun-form commands stay cwd-based.
    constructor(rootPath) {
        this.rootPath = rootPath;
        this.specsDir = rootPath ? join(rootPath, 'openspec', 'specs') : SPECS_DIR;
    }
    async show(specId, options = {}) {
        if (!specId) {
            const canPrompt = isInteractive(options);
            const specIds = await getSpecIds(this.rootPath ?? process.cwd());
            if (canPrompt && specIds.length > 0) {
                const { select } = await import('@inquirer/prompts');
                specId = await select({
                    message: 'Select a spec to show',
                    choices: specIds.map(id => ({ name: id, value: id })),
                });
            }
            else {
                throw new Error('Missing required argument <spec-id>');
            }
        }
        const specPath = join(this.specsDir, specId, 'spec.md');
        assertSpecPath(this.specsDir, specPath);
        if (!existsSync(specPath)) {
            // Root-aware callers get the absolute path; the cwd-based noun form
            // keeps its historical forward-slash relative message on all platforms.
            const displayPath = this.rootPath ? specPath : `openspec/specs/${specId}/spec.md`;
            throw new Error(`Spec '${specId}' not found at ${displayPath}`);
        }
        if (options.json) {
            if (options.requirements && options.requirement) {
                throw new Error('Options --requirements and --requirement cannot be used together');
            }
            const parsed = parseSpecFromFile(this.specsDir, specPath, specId);
            const filtered = filterSpec(parsed, options);
            const output = {
                id: specId,
                title: parsed.name,
                overview: parsed.overview,
                requirementCount: filtered.requirements.length,
                requirements: filtered.requirements,
                metadata: parsed.metadata ?? { version: '1.0.0', format: 'openspec' },
                ...(options.rootOutput ? { root: options.rootOutput } : {}),
            };
            console.log(JSON.stringify(output, null, 2));
            return;
        }
        printSpecTextRaw(this.specsDir, specPath);
    }
}
export async function specShowCommand(specId, options) {
    try {
        const cmd = new SpecCommand();
        await cmd.show(specId, options);
    }
    catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
        process.exitCode = 1;
    }
}
export async function specListCommand(options) {
    try {
        if (!existsSync(SPECS_DIR)) {
            console.log('No items found');
            return;
        }
        const discovered = await discoverSpecFiles(SPECS_DIR);
        const specs = discovered
            .map(({ id, specFile }) => {
            try {
                assertSpecPath(SPECS_DIR, specFile);
                const spec = parseSpecFromFile(SPECS_DIR, specFile, id);
                return {
                    id,
                    title: spec.name,
                    requirementCount: spec.requirements.length
                };
            }
            catch {
                return {
                    id,
                    title: id,
                    requirementCount: 0
                };
            }
        })
            .sort((a, b) => a.id.localeCompare(b.id));
        if (options.json) {
            console.log(JSON.stringify(specs, null, 2));
        }
        else {
            if (specs.length === 0) {
                console.log('No items found');
                return;
            }
            if (!options.long) {
                specs.forEach(spec => console.log(spec.id));
                return;
            }
            specs.forEach(spec => {
                console.log(`${spec.id}: ${spec.title} [requirements ${spec.requirementCount}]`);
            });
        }
    }
    catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
        process.exitCode = 1;
    }
}
export async function specValidateCommand(specId, options) {
    try {
        if (!specId) {
            const canPrompt = isInteractive(options);
            const specIds = await getSpecIds();
            if (canPrompt && specIds.length > 0) {
                const { select } = await import('@inquirer/prompts');
                specId = await select({
                    message: 'Select a spec to validate',
                    choices: specIds.map(id => ({ name: id, value: id })),
                });
            }
            else {
                throw new Error('Missing required argument <spec-id>');
            }
        }
        const specPath = join(SPECS_DIR, specId, 'spec.md');
        assertSpecPath(SPECS_DIR, specPath);
        if (!existsSync(specPath)) {
            throw new Error(`Spec '${specId}' not found at openspec/specs/${specId}/spec.md`);
        }
        const validator = new Validator(options.strict);
        assertSpecPath(SPECS_DIR, specPath);
        const report = await validator.validateSpec(specPath);
        if (options.json) {
            console.log(JSON.stringify(report, null, 2));
        }
        else {
            if (report.valid) {
                console.log(`Specification '${specId}' is valid`);
            }
            else {
                console.error(`Specification '${specId}' has issues`);
                report.issues.forEach(issue => {
                    const label = issue.level === 'ERROR' ? 'ERROR' : issue.level;
                    const prefix = issue.level === 'ERROR' ? '✗' : issue.level === 'WARNING' ? '⚠' : 'ℹ';
                    console.error(`${prefix} [${label}] ${issue.path}: ${issue.message}`);
                });
            }
        }
        process.exitCode = report.valid ? 0 : 1;
    }
    catch (error) {
        console.error(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
        process.exitCode = 1;
    }
}
//# sourceMappingURL=spec.js.map