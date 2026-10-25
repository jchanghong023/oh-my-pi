#!/usr/bin/env bun
/**
 * Parent-owned generation, never runtime installation:
 *   bun packages/coding-agent/scripts/spec-driven-resources.ts --prepare
 *   bun install --cwd packages/coding-agent/src/spec-driven/vendor/staging/openspec --ignore-scripts --production
 *   bun install --cwd packages/coding-agent/src/spec-driven/vendor/staging/openspec --ignore-scripts --lockfile-only --save-text-lockfile
 *   bun packages/coding-agent/scripts/spec-driven-resources.ts --embed
 * Check in archive.generated.ts AND dependency-lock.bun with the implementation.
 * Regeneration restores the checked-in lock and requires --frozen-lockfile at install.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { extractArchive } from "@oh-my-pi/pi-utils/ar";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type {
	SpecDrivenMethodEntry,
	SpecDrivenResourceManifest,
	SpecDrivenSkillEntry,
} from "../src/spec-driven/resources";
import superpowersDescriptionSource from "../src/prompts/skills/superpowers-descriptions.md" with { type: "text" };
import openspecAdaptationSource from "../src/prompts/spec-driven-openspec.md" with { type: "text" };
import methodAdaptationSource from "../src/prompts/spec-driven-methods.md" with { type: "text" };

const vendor = path.resolve(import.meta.dir, "../src/spec-driven/vendor");
const staging = path.join(vendor, "staging");
const openspec = path.join(staging, "openspec");
const superpowers = path.join(staging, "superpowers");
const version = "1.14.3";
const revision = "2ce8aa15d05bd57213e6f746f953aafb7ded7a8b";
const superpowersVersion = "7.0.1";
const jchRevision = "d1332445063976050be7aecfcac893a9b9c2fbfd";
const jchFiles = {
	"SKILL.md": "c23875b96e374af17fd10aaa3efa7daaf4c54ad086ef47d001dc69be97e01e58",
	"agents/openai.yaml": "0c035fc04e9bd95ab107eb1232bc2df0ee61e4e74ba218cd61d80410a136fdb1",
};
type MethodPatch = { before: string; after: string } | { start: string; end?: string; body: string };
const methodAdaptation = parseYaml(methodAdaptationSource.match(/```yaml\n([\s\S]*?)\n```/)![1]!) as {
	adaptation: string;
	agents: Record<string, "task" | "reviewer">;
	methods: {
		source: "jch" | "superpowers";
		name: string;
		roles: SpecDrivenMethodEntry["role"][];
	}[];
	files: Record<string, MethodPatch[]>;
};
const superpowersSkills = [
	"brainstorming",
	"diagnosing-superpowers",
	"dispatching-parallel-agents",
	"executing-plans",
	"finishing-a-development-branch",
	"receiving-code-review",
	"requesting-code-review",
	"subagent-driven-development",
	"systematic-debugging",
	"test-driven-development",
	"using-git-worktrees",
	"using-superpowers",
	"verification-before-completion",
	"writing-plans",
	"writing-skills",
];
const superpowersDescriptions = parseYaml(superpowersDescriptionSource) as Record<string, string>;
interface RequirementsWorkflow {
	module: string;
	commandFactory: string;
	description?: string;
	replacements?: { before: string; after: string }[];
}
const requirementsAdaptation = parseYaml(openspecAdaptationSource.match(/```yaml\n([\s\S]*?)\n```/)![1]!) as {
	common: string;
	requirementsHandoff: string;
	workflows: Record<string, RequirementsWorkflow>;
	proposalInstruction: string;
	specsInstruction: string;
};
const requirementsWorkflows = Object.entries(requirementsAdaptation.workflows);
const removedWorkflowModules = [
	"new-change",
	"continue-change",
	"apply-change",
	"ff-change",
	"bulk-archive-change",
	"onboard",
	"feedback",
];
interface PackageMetadata {
	version: string;
	dist: { tarball: string; integrity: string };
}
interface UpstreamCommand {
	name: string;
	description: string;
	content: string;
}
interface Schema {
	name: string;
	description: string;
	artifacts: { id: string; requires: string[]; instruction: string }[];
	apply?: unknown;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`${response.status} downloading ${url}`);
	return new Uint8Array(await response.arrayBuffer());
}
async function unpack(bytes: Uint8Array, target: string): Promise<void> {
	const temporary = await fs.mkdtemp(path.join(vendor, ".download-"));
	try {
		await extractArchive({ bytes, format: "tar.gz" }, temporary);
		const roots = await fs.readdir(temporary);
		if (roots.length !== 1 || !roots[0]) throw new Error("Upstream archive must have one root");
		await fs.rename(path.join(temporary, roots[0]), target);
	} finally {
		await fs.rm(temporary, { recursive: true, force: true });
	}
}
async function prepare(): Promise<void> {
	if (await Bun.file(path.join(staging, "source.json")).exists())
		throw new Error(
			"Staging already prepared; reuse it for install/embed or explicitly remove only vendor/staging to prepare again",
		);
	await fs.mkdir(staging, { recursive: true });
	const metadata = JSON.parse(
		Buffer.from(await fetchBytes(`https://registry.npmjs.org/@fission-ai%2fopenspec/${version}`)).toString(),
	) as PackageMetadata;
	if (metadata.version !== version || !metadata.dist.integrity.startsWith("sha512-"))
		throw new Error("Unexpected OpenSpec release metadata");
	const bytes = await fetchBytes(metadata.dist.tarball);
	if (`sha512-${crypto.createHash("sha512").update(bytes).digest("base64")}` !== metadata.dist.integrity)
		throw new Error("OpenSpec release integrity mismatch");
	await unpack(bytes, openspec);
	await unpack(await fetchBytes(`https://codeload.github.com/obra/superpowers/tar.gz/${revision}`), superpowers);
	const plugin = await Bun.file(path.join(superpowers, ".claude-plugin/plugin.json")).json();
	if (plugin.version !== superpowersVersion) throw new Error(`Unexpected Superpowers version: ${plugin.version}`);
	const lock = path.join(vendor, "dependency-lock.bun");
	if (await Bun.file(lock).exists()) await fs.copyFile(lock, path.join(openspec, "bun.lock"));
	await Bun.write(
		path.join(staging, "source.json"),
		JSON.stringify({ integrity: metadata.dist.integrity, tarball: metadata.dist.tarball, revision }, null, 2),
	);
	console.log(`Prepared pinned sources in ${staging}`);
	console.log(
		`Install only in ${openspec}: bun install --ignore-scripts --production${(await Bun.file(lock).exists()) ? " --frozen-lockfile" : ""}`,
	);
	if (!(await Bun.file(lock).exists()))
		console.log(
			`First preparation also requires: bun install --cwd "${openspec}" --ignore-scripts --lockfile-only --save-text-lockfile`,
		);
	else console.log("The saved dependency lock was restored; use --frozen-lockfile for regeneration installs.");
	console.log(
		"Then rerun this script with --embed. No upstream hooks or automatic bootstrap extensions are activated.",
	);
}

async function collect(root: string, relative = ""): Promise<string[]> {
	const result: string[] = [];
	for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
		const name = relative ? `${relative}/${entry.name}` : entry.name;
		if (entry.name === ".git") continue;
		const stat = entry.isSymbolicLink() ? await fs.stat(path.join(root, name)) : undefined;
		if (entry.isDirectory() || stat?.isDirectory()) result.push(...(await collect(root, name)));
		else if (entry.isFile() || stat?.isFile()) result.push(name);
	}
	return result.sort();
}
function hidden(content: string): string {
	if (!content.startsWith("---\n")) throw new Error("Upstream skill is missing YAML frontmatter");
	return content.replace(/^---\n/, "---\ndisable-model-invocation: true\n");
}
function adaptSuperpowersSkill(name: string, raw: Uint8Array): Uint8Array {
	if (name === "verification-before-completion" || name === "systematic-debugging") return raw;
	const content = Buffer.from(raw).toString("utf8");
	if (name !== "writing-skills") return Buffer.from(hidden(content));
	const description = superpowersDescriptions[name];
	if (description === undefined) throw new Error("Missing Superpowers writing-skills description");
	const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/u.exec(content);
	if (!frontmatter) throw new Error("Upstream skill is missing YAML frontmatter");
	const metadata = parseYaml(frontmatter[1]!) as Record<string, unknown>;
	metadata.description = description;
	return Buffer.from(`---\n${stringifyYaml(metadata)}---${content.slice(frontmatter[0].length)}`);
}

function adaptSuperpowersAgent(relative: string, raw: Uint8Array): Uint8Array {
	const agent = methodAdaptation.agents[relative];
	if (!agent) return raw;
	const content = Buffer.from(raw).toString("utf8");
	if (!content.includes("general-purpose")) throw new Error(`Upstream dispatch agent missing: ${relative}`);
	return Buffer.from(content.replaceAll("general-purpose", agent));
}

function adaptMethodFile(relative: string, raw: Uint8Array): Uint8Array {
	const patches = methodAdaptation.files[relative];
	if (!patches) return raw;
	let content = Buffer.from(raw).toString("utf8").replace(/\r\n/g, "\n");
	for (const patch of patches) {
		const anchor = "before" in patch ? patch.before : patch.start;
		const start = content.indexOf(anchor);
		if (start < 0 || content.indexOf(anchor, start + anchor.length) >= 0)
			throw new Error(`Controlled method anchor missing or ambiguous: ${relative}: ${anchor}`);
		if ("before" in patch) {
			content = content.slice(0, start) + patch.after + content.slice(start + anchor.length);
		} else {
			const end = patch.end === undefined ? content.length : content.indexOf(patch.end, start + anchor.length);
			if (end < 0) throw new Error(`Controlled method section end missing: ${relative}: ${patch.end}`);
			content = content.slice(0, start) + patch.body + content.slice(end);
		}
	}
	return Buffer.from(content);
}

function embedMethods(entries: Record<string, Uint8Array>, executable: Set<string>): SpecDrivenMethodEntry[] {
	const originals = { ...entries };
	const methods: SpecDrivenMethodEntry[] = [];
	for (const method of methodAdaptation.methods) {
		const originalPath = `${method.source}/skills/${method.name}/SKILL.md`;
		const original = originals[originalPath];
		if (!original) throw new Error(`Missing controlled method source: ${originalPath}`);
		for (const role of method.roles) {
			const prefix = `${method.source}/methods/${role}/skills/${method.name}/`;
			const originalPrefix = `${method.source}/skills/${method.name}/`;
			for (const [relative, raw] of Object.entries(originals)) {
				if (!relative.startsWith(originalPrefix)) continue;
				const target = prefix + relative.slice(originalPrefix.length);
				entries[target] = adaptMethodFile(relative, adaptSuperpowersAgent(relative, raw));
				if (executable.has(relative)) executable.add(target);
			}
			const effectivePath = `${prefix}SKILL.md`;
			const effective = Buffer.from(entries[effectivePath]!).toString("utf8");
			entries[effectivePath] = Buffer.from(
				/^disable-model-invocation: true$/m.test(effective) ? effective : hidden(effective),
			);
			methods.push({
				source: method.source,
				name: method.name,
				role,
				path: effectivePath,
				originalPath:
					method.source === "superpowers" ? `superpowers/original-skills/${method.name}/SKILL.md` : originalPath,
				originalSha256: crypto.createHash("sha256").update(original).digest("hex"),
				sha256: crypto.createHash("sha256").update(entries[effectivePath]!).digest("hex"),
				adaptation: methodAdaptation.adaptation,
			});
		}
	}
	return methods;
}
function normalizeTar(bytes: Uint8Array): void {
	for (let offset = 0; offset + 512 <= bytes.length;) {
		const header = bytes.subarray(offset, offset + 512);
		if (header.every(byte => byte === 0)) return;
		const size = Number.parseInt(
			Buffer.from(header.subarray(124, 136)).toString("ascii").replace(/\0.*$/, "").trim() || "0",
			8,
		);
		for (const [start, width, value] of [
			[108, 8, 0],
			[116, 8, 0],
			[136, 12, 0],
		] as const) {
			header.fill(0x30, start, start + width - 1);
			header.set(Buffer.from(value.toString(8)), start + width - 2);
			header[start + width - 1] = 0;
		}
		header.fill(0x20, 148, 156);
		let checksum = 0;
		for (const byte of header) checksum += byte;
		header.set(Buffer.from(checksum.toString(8).padStart(6, "0")), 148);
		header[154] = 0;
		header[155] = 0x20;
		offset += 512 * (1 + Math.ceil(size / 512));
	}
}

function adaptOpenSpecCommandReferences(text: string): string {
	return text.replace(/(?<![\w/.-])(?<!omp )openspec (?=[a-z-])/g, "omp openspec ");
}

/**
 * Adapt archive entries, not staging: --embed always starts from the same pinned
 * offline originals, and interrupted generation cannot leave a half-adapted CLI.
 */
function adaptOpenSpecEntries(entries: Record<string, Uint8Array>, commands: UpstreamCommand[]): UpstreamCommand[] {
	const root = "openspec/dist/";
	const readEntry = (relative: string): string => {
		const value = entries[root + relative];
		if (!value) throw new Error(`Missing pinned OpenSpec adapter target: ${relative}`);
		return Buffer.from(value).toString("utf8");
	};
	const writeEntry = (relative: string, text: string): void => {
		entries[root + relative] = Buffer.from(text);
		delete entries[root + relative + ".map"];
	};
	const replaceOnce = (relative: string, before: string, after: string): void => {
		const text = readEntry(relative);
		if (!text.includes(before) || text.indexOf(before) !== text.lastIndexOf(before))
			throw new Error(`Pinned OpenSpec adapter anchor changed: ${relative}`);
		writeEntry(relative, text.replace(before, after));
	};
	const adapted = requirementsWorkflows.map(([, workflow], index) => {
		const originalCommand = commands[index];
		if (!originalCommand) throw new Error(`Missing retained OpenSpec command factory: ${workflow.commandFactory}`);
		const adaptBody = (body: string): string => {
			for (const replacement of workflow.replacements ?? []) {
				const before = replacement.before.trimEnd();
				if (!body.includes(before) || body.indexOf(before) !== body.lastIndexOf(before))
					throw new Error(`Pinned OpenSpec ${workflow.module} command body anchor changed: ${before}`);
				body = body.replace(before, replacement.after.trimEnd());
			}
			// Remove both implementation branches, not only the currently unavailable one.
			body = body.replace(
				/\[\[opsx:if-workflow apply\]\][\s\S]*?\[\[opsx:else\]\][\s\S]*?\[\[opsx:end\]\]/g,
				requirementsAdaptation.requirementsHandoff,
			);
			return adaptOpenSpecCommandReferences(
				workflow.module === "verify-change" ? body : `${requirementsAdaptation.common.trim()}\n\n${body}`,
			).replaceAll("/opsx:", "/skill:opsx-");
		};
		const command = {
			...originalCommand,
			description: workflow.description ?? originalCommand.description,
			content: adaptBody(originalCommand.content),
		};
		writeEntry(
			`core/templates/workflows/${workflow.module}.js`,
			`export function ${workflow.commandFactory}() { return ${JSON.stringify(command)}; }\n`,
		);
		return command;
	});
	for (const name of Object.keys(entries)) {
		if (
			name.startsWith("openspec/skills/") ||
			name.startsWith("openspec/original-skills/") ||
			removedWorkflowModules.some(module => name.startsWith(`${root}core/templates/workflows/${module}.`))
		)
			delete entries[name];
	}
	for (const extension of ["js", "d.ts"]) {
		writeEntry(
			`core/templates/skill-templates.${extension}`,
			requirementsWorkflows
				.map(([, workflow]) => `export { ${workflow.commandFactory} } from './workflows/${workflow.module}.js';`)
				.join("\n") + "\n",
		);
	}
	// Init is a requirements-directory initializer. Reuse the pinned filesystem,
	// config and pointer guards without importing any integration installers.
	const initSource = readEntry("core/init.js");
	const checkedSection = (text: string, start: string, end: string): string => {
		const offset = text.indexOf(start);
		const limit = text.indexOf(end, offset + start.length);
		if (
			offset < 0 ||
			limit < 0 ||
			text.indexOf(start, offset + start.length) >= 0 ||
			text.indexOf(end, limit + end.length) >= 0
		)
			throw new Error(`Pinned OpenSpec adapter section changed: ${start}`);
		return text.slice(offset, limit);
	};
	const helperNames = [
		"validate",
		"createDirectoryStructure",
		"writeGitkeepFiles",
		"normalizeLanguage",
		"languageContext",
		"assertLanguageCanBeApplied",
		"createConfig",
		"startSpinner",
	];
	const helpers = helperNames.map(name => {
		const matches = [
			...initSource.matchAll(new RegExp(`^    (?:async )?${name}\\([^\\n]*\\) \\{\\n[\\s\\S]*?^    \\}`, "gm")),
		];
		if (matches.length !== 1) throw new Error(`Pinned OpenSpec init helper changed: ${name}`);
		return matches[0]![0];
	});
	const imports = [
		"path",
		"ora",
		"fs",
		"../utils/file-system.js",
		"./project-config.js",
		"./planning-home.js",
		"./root-selection.js",
		"./openspec-root.js",
		"./styles/palette.js",
		"./config-prompts.js",
	].map(module => {
		const matches = initSource
			.split("\n")
			.filter(line => line.startsWith("import ") && line.endsWith(`from '${module}';`));
		if (matches.length !== 1) throw new Error(`Pinned OpenSpec init import changed: ${module}`);
		return matches[0]!;
	});
	if (!/^import \{ .*OPENSPEC_DIR_NAME, .* \} from '\.\/config\.js';$/m.test(initSource))
		throw new Error("Pinned OpenSpec init directory constant import changed");
	imports.push("import { OPENSPEC_DIR_NAME } from './config.js';");
	const constants = checkedSection(
		initSource,
		"const DEFAULT_SCHEMA = 'spec-driven';",
		"const WORKFLOW_TO_SKILL_DIR = {",
	).replace("const DEFAULT_SCHEMA = 'spec-driven';", "const DEFAULT_SCHEMA = 'omp-spec';");
	const pointerGuard = checkedSection(
		initSource,
		"        const guardRoot = findRepoPlanningRootSync(projectPath);",
		"        // Pointer repos keep their local planning files untouched.",
	)
		.replaceAll("integrationsOnly", "pointerOnly")
		.replace("to install integrations.", "to initialize OpenSpec.")
		.replace(
			"                    // A valid pointer repo already has its planning root in the declared\n" +
				"                    // store. Init should still be able to install agent integrations in\n" +
				"                    // the code repo, without creating a second local planning root.\n",
			"                    // Validate the external root without creating a second local planning root.\n",
		);
	writeEntry(
		"core/init.js",
		`${imports.join("\n")}\n${constants}export class InitCommand {\n` +
			"    language;\n" +
			"    constructor(options = {}) {\n" +
			"        this.language = this.normalizeLanguage(options.language);\n" +
			"    }\n" +
			"    async execute(targetPath) {\n" +
			"        const projectPath = FileSystemUtils.canonicalizeExistingPath(targetPath);\n" +
			"        const openspecPath = path.join(projectPath, OPENSPEC_DIR_NAME);\n" +
			"        const extendMode = await this.validate(projectPath, openspecPath);\n" +
			pointerGuard +
			"        if (pointerOnly) return;\n" +
			"        await this.createDirectoryStructure(openspecPath, extendMode);\n" +
			"        await this.createConfig(openspecPath, extendMode);\n" +
			"        console.log('OpenSpec initialized.');\n" +
			"    }\n" +
			helpers.join("\n") +
			"\n}\n",
	);
	writeEntry(
		"core/init.d.ts",
		"type InitCommandOptions = { language?: string; };\n" +
			"export declare class InitCommand {\n" +
			"    private readonly language?;\n" +
			"    constructor(options?: InitCommandOptions);\n" +
			"    execute(targetPath: string): Promise<void>;\n" +
			helperNames.map(name => `    private ${name};`).join("\n") +
			"\n}\nexport {};\n",
	);
	const cliSource = readEntry("cli/index.js");
	const toolOptions = checkedSection(
		cliSource,
		"const availableToolIds = AI_TOOLS",
		"program\n    .command('init [path]')",
	);
	replaceOnce("cli/index.js", toolOptions, "");
	replaceOnce("cli/index.js", "import { AI_TOOLS, TOOL_ID_ALIASES } from '../core/config.js';\n", "");
	replaceOnce(
		"cli/index.js",
		checkedSection(
			cliSource,
			"// Hidden alias: 'experimental' -> 'init' for backwards compatibility",
			"program\n    .command('list')",
		),
		"",
	);
	for (const option of [
		"    .option('--tools <tools>', toolsOptionDescription)\n",
		"    .option('--force', 'Auto-cleanup legacy files without prompting')\n",
		"    .option('--profile <profile>', 'Override global config profile (core or custom)')\n",
		"    .option('--no-animation', 'Show a static welcome screen instead of the animated one')\n",
		"    .option('--copilot-cloud', 'Set up GitHub Copilot cloud coding-agent files without prompting')\n",
		"    .option('--no-copilot-cloud', 'Skip GitHub Copilot cloud coding-agent files without prompting')\n",
		"            tools: options?.tools,\n",
		"            force: options?.force,\n",
		"            profile: options?.profile,\n",
		"            animation: options?.animation,\n",
		"            copilotCloud: options?.copilotCloud,\n",
	])
		replaceOnce("cli/index.js", option, "");
	for (const extension of ["js", "d.ts", "js.map", "d.ts.map"]) delete entries[`${root}core/update.${extension}`];
	const registryPath = "core/completions/command-registry.js";
	const registrySource = readEntry(registryPath);
	replaceOnce(
		registryPath,
		checkedSection(registrySource, "    {\n        name: 'init',", "    {\n        name: 'version',"),
		"    {\n" +
			"        name: 'init',\n" +
			"        description: 'Initialize OpenSpec in your project',\n" +
			"        acceptsPositional: true,\n" +
			"        positionalType: 'path',\n" +
			"        positionals: [{ name: 'path', type: 'path', optional: true }],\n" +
			"        flags: [{\n" +
			"            name: 'language',\n" +
			"            description: 'Write new OpenSpec artifacts in this language',\n" +
			"            takesValue: true,\n" +
			"        }],\n" +
			"    },\n",
	);
	replaceOnce("commands/workflow/default-schema.js", "'spec-driven'", "'omp-spec'");
	// Resolve legacy graphs as an in-memory requirements projection. Never rewrite
	// their schema, metadata, or historical implementation artifacts.
	replaceOnce(
		"core/artifact-graph/resolver.js",
		"return parseSchema(content);",
		"const schema = parseSchema(content);\n" +
			"        const retained = schema.artifacts.filter(a => a.id === 'proposal' || a.id === 'specs');\n" +
			"        const ids = new Set(retained.map(a => a.id));\n" +
			"        if (retained.length !== 2 || retained.some(a => a.requires.some(id => !ids.has(id))) ||\n" +
			"            retained.some(a => a.id === 'proposal' ? a.generates !== 'proposal.md' : a.generates !== 'specs/**/*.md'))\n" +
			"            throw new Error('Incompatible requirements schema: proposal/specs cannot be isolated from implementation artifacts');\n" +
			"        const instructions = " +
			JSON.stringify({
				proposal: requirementsAdaptation.proposalInstruction,
				specs: requirementsAdaptation.specsInstruction,
			}) +
			";\n" +
			"        return { ...schema, artifacts: retained.map(a => ({ ...a, instruction: instructions[a.id] })), apply: undefined };",
	);
	// Rewrite only pinned guidance producers at generation time. Runtime JSON,
	// project context, user templates, paths, and artifact data remain untouched.
	const guidanceModules = [
		"cli/index.js",
		"core/archive.js",
		"core/change-status-policy.js",
		"core/completion-tip.js",
		"core/global-config.js",
		"core/init.js",
		"core/migration.js",
		"core/onboarding-commands.js",
		"core/references.js",
		"core/relationship-health.js",
		"core/root-selection.js",
		"core/specs-apply.js",
		"core/store/operations.js",
		"core/store/registry.js",
	];
	for (const name of Object.keys(entries)) {
		if (name.startsWith(`${root}commands/`) && name.endsWith(".js")) guidanceModules.push(name.slice(root.length));
	}
	for (const relative of guidanceModules) {
		const original = readEntry(relative);
		const adapted = adaptOpenSpecCommandReferences(original);
		if (adapted !== original) writeEntry(relative, adapted);
	}
	return adapted;
}

async function embed(): Promise<void> {
	const source = await Bun.file(path.join(staging, "source.json")).json();
	if (source.revision !== revision) throw new Error("Staging source revision mismatch");
	const lock = path.join(openspec, "bun.lock");
	if (!(await Bun.file(lock).exists()) || !(await fs.stat(path.join(openspec, "node_modules"))).isDirectory())
		throw new Error("Parent must install staged CLI dependencies first");
	await fs.copyFile(lock, path.join(vendor, "dependency-lock.bun"));
	// Execute only the pinned upstream template factories, under an explicit package boundary.
	const templateRunner = path.join(staging, "templates.mjs");
	await Bun.write(
		templateRunner,
		`import { ${requirementsWorkflows.map(([, workflow]) => workflow.commandFactory).join(", ")} } from './openspec/dist/core/templates/skill-templates.js';\nconsole.log(JSON.stringify([${requirementsWorkflows.map(([, workflow]) => `${workflow.commandFactory}()`).join(", ")}]));\n`,
	);
	const child = Bun.spawn([process.execPath, templateRunner], {
		cwd: staging,
		env: { ...process.env, BUN_BE_BUN: "1", DO_NOT_TRACK: "1", OPENSPEC_TELEMETRY: "0" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [output, error, exit] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exit !== 0) throw new Error(`Pinned command generation failed: ${error}`);
	const commands = JSON.parse(output) as UpstreamCommand[];
	if (commands.length !== requirementsWorkflows.length) throw new Error("Expected retained OpenSpec commands");
	const entries: Record<string, Uint8Array> = {};
	const skills: SpecDrivenSkillEntry[] = [];
	const executable = new Set<string>();
	for (const [prefix, root] of [
		["openspec", openspec],
		["superpowers", superpowers],
	] as const) {
		for (const relative of await collect(root)) {
			const file = path.join(root, relative);
			const bytes = new Uint8Array(await fs.readFile(file));
			entries[`${prefix}/${relative}`] = bytes;
			if ((await fs.stat(file)).mode & 0o111 || Buffer.from(bytes.subarray(0, 2)).toString() === "#!")
				executable.add(`${prefix}/${relative}`);
		}
	}
	for (const [relative, digest] of Object.entries(jchFiles)) {
		const raw = new Uint8Array(await fs.readFile(path.join(vendor, "jch-grill-me", relative)));
		if (crypto.createHash("sha256").update(raw).digest("hex") !== digest)
			throw new Error(`Pinned JCH source digest mismatch: ${relative}`);
		entries[`jch/skills/jch-grill-me/${relative}`] = raw;
	}
	skills.push({ source: "jch", name: "jch-grill-me", path: "jch/skills/jch-grill-me/SKILL.md" });
	const methods = embedMethods(entries, executable);
	for (const [index, command] of adaptOpenSpecEntries(entries, commands).entries()) {
		if (!command.content || !command.description) throw new Error("Invalid pinned upstream command template");
		const name = `opsx-${requirementsWorkflows[index]![0]}`;
		const relative = `openspec/skills/${name}/SKILL.md`;
		const body = command.content.replace(
			/\[\[opsx:if-workflow ([a-z-]+)\]\]([\s\S]*?)\[\[opsx:else\]\]([\s\S]*?)\[\[opsx:end\]\]/g,
			(_match, id: string, installed: string, missing: string) =>
				requirementsWorkflows.some(([workflow]) => workflow === id) ? installed : missing,
		);
		if (body.includes("[[opsx:")) throw new Error(`Unresolved OpenSpec command conditional: ${name}`);
		entries[relative] = Buffer.from(
			`---\n${stringifyYaml({ name, description: command.description })}---\n\n${body}`,
		);
		skills.push({ source: "openspec", name, path: relative });
	}
	for (const name of superpowersSkills) {
		const relative = `superpowers/skills/${name}/SKILL.md`;
		const raw = entries[relative];
		if (!raw) throw new Error(`Missing upstream Superpowers skill ${name}`);
		entries[`superpowers/original-skills/${name}/SKILL.md`] = raw;
		entries[relative] = adaptSuperpowersSkill(name, raw);
		skills.push({ source: "superpowers", name, path: relative });
	}
	for (const relative of Object.keys(methodAdaptation.agents)) {
		const raw = entries[relative];
		if (!raw) throw new Error(`Missing upstream Superpowers dispatch resource: ${relative}`);
		entries[relative] = adaptSuperpowersAgent(relative, raw);
	}
	const schema = parseYaml(
		await fs.readFile(path.join(openspec, "schemas/spec-driven/schema.yaml"), "utf8"),
	) as Schema;
	schema.name = "omp-spec";
	schema.description = "OMP requirements-only proposal and specification artifacts";
	schema.artifacts = schema.artifacts.filter(artifact => artifact.id === "proposal" || artifact.id === "specs");
	delete schema.apply;
	if (schema.artifacts.length !== 2) throw new Error("Upstream schema does not contain proposal/specs");
	for (const artifact of schema.artifacts) {
		artifact.instruction =
			artifact.id === "proposal"
				? requirementsAdaptation.proposalInstruction
				: requirementsAdaptation.specsInstruction;
	}
	// Both the dedicated OMP schema and the upstream built-in default are
	// requirements-only. Project-local legacy schemas are projected at load time.
	for (const name of ["omp-spec", "spec-driven"]) {
		entries[`openspec/schemas/${name}/schema.yaml`] = Buffer.from(stringifyYaml({ ...schema, name }));
		for (const template of ["proposal.md", "spec.md"]) {
			const original = await Bun.file(path.join(openspec, "schemas/spec-driven/templates", template)).text();
			entries[`openspec/schemas/${name}/templates/${template}`] = Buffer.from(
				adaptOpenSpecCommandReferences(original),
			);
		}
		for (const template of ["design.md", "tasks.md"])
			delete entries[`openspec/schemas/${name}/templates/${template}`];
	}
	entries["omp-spec/schema.yaml"] = Buffer.from(stringifyYaml(schema));
	for (const template of ["proposal.md", "spec.md"])
		entries[`omp-spec/templates/${template}`] = entries[`openspec/schemas/omp-spec/templates/${template}`]!;
	// Bash scripts use `node`; route that command to the same embedded Bun runtime.
	entries["omp-runtime/node"] = Buffer.from(
		'#!/usr/bin/env bash\nset -e\nruntime="$OMP_BUN_EXECUTABLE"\nif command -v cygpath >/dev/null 2>&1; then runtime="$(cygpath -u "$runtime")"; fi\nexport BUN_BE_BUN=1\nexec "$runtime" "$@"\n',
	);
	executable.add("omp-runtime/node");
	const manifest: SpecDrivenResourceManifest = {
		openspec: { version, integrity: source.integrity },
		superpowers: { version: superpowersVersion, revision },
		jch: { revision: jchRevision },
		methods,
		skills,
		files: Object.keys(entries)
			.sort()
			.map(name => ({
				path: name,
				sha256: crypto.createHash("sha256").update(entries[name]!).digest("hex"),
				executable: executable.has(name),
			})),
	};
	entries["manifest.json"] = Buffer.from(JSON.stringify(manifest, null, 2));
	const sorted: Record<string, Uint8Array> = {};
	for (const name of Object.keys(entries).sort()) sorted[name] = entries[name]!;
	const tar = await new Bun.Archive(sorted).bytes();
	normalizeTar(tar);
	const archive = Bun.gzipSync(tar, { level: 9 });
	const sha = crypto.createHash("sha256").update(archive).digest("hex");
	await Bun.write(
		path.join(vendor, "archive.generated.ts"),
		`// Generated by scripts/spec-driven-resources.ts; pinned upstream originals + minimal OMP adapters.\nimport type { SpecDrivenResourceManifest } from '../resources';\nexport const archiveSha256 = ${JSON.stringify(sha)};\nexport const resourceManifest: SpecDrivenResourceManifest = ${JSON.stringify(manifest)};\nexport const archiveBase64 = ${JSON.stringify(Buffer.from(archive).toString("base64"))};\n`,
	);
	await Bun.write(path.join(vendor, "inventory.json"), JSON.stringify(manifest, null, 2));
	await fs.rm(templateRunner);
	// Staging must not expose upstream examples to the package TypeScript source graph.
	await fs.rm(staging, { recursive: true, force: true });
	console.log(`Embedded ${manifest.files.length} complete files, ${skills.length} skills; archive SHA256 ${sha}`);
}

if (import.meta.main) {
	if (process.argv.slice(2).join(" ") === "--prepare") await prepare();
	else if (process.argv.slice(2).join(" ") === "--embed") await embed();
	else
		throw new Error(
			"Expected exactly --prepare or --embed (dependency installation is a separate parent-owned step)",
		);
}
