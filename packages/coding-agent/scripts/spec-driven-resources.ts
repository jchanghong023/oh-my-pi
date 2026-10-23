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
import type { SpecDrivenResourceManifest, SpecDrivenSkillEntry } from "../src/spec-driven/resources";

const vendor = path.resolve(import.meta.dir, "../src/spec-driven/vendor");
const staging = path.join(vendor, "staging");
const openspec = path.join(staging, "openspec");
const superpowers = path.join(staging, "superpowers");
const version = "1.14.3";
const revision = "2ce8aa15d05bd57213e6f746f953aafb7ded7a8b";
const superpowersVersion = "7.0.1";
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
const factories = [
	"getExploreSkillTemplate",
	"getNewChangeSkillTemplate",
	"getContinueChangeSkillTemplate",
	"getApplyChangeSkillTemplate",
	"getUpdateChangeSkillTemplate",
	"getFfChangeSkillTemplate",
	"getSyncSpecsSkillTemplate",
	"getArchiveChangeSkillTemplate",
	"getBulkArchiveChangeSkillTemplate",
	"getVerifyChangeSkillTemplate",
	"getOnboardSkillTemplate",
	"getOpsxProposeSkillTemplate",
	"getFeedbackSkillTemplate",
];
interface PackageMetadata {
	version: string;
	dist: { tarball: string; integrity: string };
}
interface UpstreamSkill {
	name: string;
	description: string;
	instructions: string;
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
		`import { ${factories.join(", ")} } from './openspec/dist/core/templates/skill-templates.js';\nconsole.log(JSON.stringify([${factories.map(name => `${name}()`).join(", ")} ]));\n`,
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
	if (exit !== 0) throw new Error(`Pinned skill generation failed: ${error}`);
	const templates = JSON.parse(output) as UpstreamSkill[];
	if (templates.length !== 13) throw new Error("Expected all 13 OpenSpec skills");
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
	for (const template of templates) {
		if (!/^[a-z0-9-]+$/.test(template.name) || !template.instructions || !template.description)
			throw new Error("Invalid pinned upstream skill template");
		const raw = `---\nname: ${template.name}\ndescription: ${JSON.stringify(template.description)}\n---\n\n${template.instructions}\n`;
		entries[`openspec/original-skills/${template.name}/SKILL.md`] = Buffer.from(raw);
		const relative = `openspec/skills/${template.name}/SKILL.md`;
		entries[relative] = Buffer.from(hidden(raw).replace(/(?<![\w/.-])openspec (?=[a-z-])/g, "omp openspec "));
		skills.push({ source: "openspec", name: template.name, path: relative });
	}
	for (const name of superpowersSkills) {
		const relative = `superpowers/skills/${name}/SKILL.md`;
		const raw = entries[relative];
		if (!raw) throw new Error(`Missing upstream Superpowers skill ${name}`);
		entries[`superpowers/original-skills/${name}/SKILL.md`] = raw;
		if (name !== "verification-before-completion" && name !== "systematic-debugging")
			entries[relative] = Buffer.from(hidden(Buffer.from(raw).toString("utf8")));
		skills.push({ source: "superpowers", name, path: relative });
	}
	const schema = parseYaml(
		await fs.readFile(path.join(openspec, "schemas/spec-driven/schema.yaml"), "utf8"),
	) as Schema;
	schema.name = "omp-spec";
	schema.description = "OMP requirements-only proposal and specification artifacts";
	schema.artifacts = schema.artifacts.filter(artifact => artifact.id === "proposal" || artifact.id === "specs");
	delete schema.apply;
	const proposal = schema.artifacts.find(artifact => artifact.id === "proposal");
	if (!proposal || schema.artifacts.length !== 2) throw new Error("Upstream schema does not contain proposal/specs");
	// Requirement phase has no implementation artifacts: remove the upstream handoff only.
	proposal.instruction = proposal.instruction
		.replace(
			"implementation details belong in design.md.",
			"implementation details are outside this requirements-only phase.",
		)
		.replace(
			"This is the foundation - specs, design, and tasks all build on this.",
			"This is the foundation for the specification artifacts.",
		);
	for (const artifact of schema.artifacts)
		artifact.instruction = artifact.instruction.replace(/(?<![\w/.-])openspec (?=[a-z-])/g, "omp openspec ");
	entries["omp-spec/schema.yaml"] = Buffer.from(stringifyYaml(schema));
	for (const template of ["proposal.md", "spec.md"])
		entries[`omp-spec/templates/${template}`] = await Bun.file(
			path.join(openspec, "schemas/spec-driven/templates", template),
		).bytes();
	// Bash scripts use `node`; route that command to the same embedded Bun runtime.
	entries["omp-runtime/node"] = Buffer.from(
		'#!/usr/bin/env bash\nset -e\nruntime="$OMP_BUN_EXECUTABLE"\nif command -v cygpath >/dev/null 2>&1; then runtime="$(cygpath -u "$runtime")"; fi\nexport BUN_BE_BUN=1\nexec "$runtime" "$@"\n',
	);
	executable.add("omp-runtime/node");
	const manifest: SpecDrivenResourceManifest = {
		openspec: { version, integrity: source.integrity },
		superpowers: { version: superpowersVersion, revision },
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
	// Staging is not a distribution convention: the statically imported module contains everything.
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
