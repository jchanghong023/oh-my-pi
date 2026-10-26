import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { runOpenSpec } from "./resources";
import type { SpecArtifactPaths, SpecDocument, SpecRequirements, SpecSolution } from "./types";

export interface SpecArtifactStoreOptions {
	cwd: string;
	changeId: string;
	requirementsDir?: string;
}
export function artifactVersion(content: string): string {
	return crypto.createHash("sha256").update(content).digest("hex");
}

function inside(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
/** Resolve every existing ancestor, including Windows junctions, before creating anything. */
export async function containedSpecPath(root: string, relative: string): Promise<string> {
	if (
		!relative ||
		path.isAbsolute(relative) ||
		relative.includes("\0") ||
		relative.includes(":") ||
		relative.split(/[\\/]/).includes("..")
	)
		throw new Error(`Unsafe specification path: ${relative}`);
	const canonicalRoot = await fs.realpath(root);
	const target = path.resolve(root, relative);
	if (!inside(path.resolve(root), target)) throw new Error(`Specification path escapes root: ${relative}`);
	let ancestor = target;
	const missing: string[] = [];
	for (;;) {
		try {
			ancestor = await fs.realpath(ancestor);
			break;
		} catch (error) {
			if (!isEnoent(error)) throw error;
			missing.unshift(path.basename(ancestor));
			ancestor = path.dirname(ancestor);
		}
	}
	const canonical = path.join(ancestor, ...missing);
	if (!inside(canonicalRoot, canonical)) throw new Error(`Specification link escapes root: ${relative}`);
	return canonical;
}
async function filesBelow(root: string, prefix = ""): Promise<string[]> {
	const result: string[] = [];
	for (const entry of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
		const relative = path.join(prefix, entry.name);
		if (entry.isSymbolicLink()) throw new Error(`Linked specification entry requires explicit mapping: ${relative}`);
		if (entry.isDirectory()) result.push(...(await filesBelow(root, relative)));
		else if (entry.isFile()) result.push(relative);
	}
	return result.sort();
}
function snapshot(file: string, content: string): SpecDocument {
	return { path: file, content, version: artifactVersion(content) };
}

export class SpecArtifactStore {
	readonly cwd: string;
	readonly changeId: string;
	readonly changeDir: string;
	readonly planPath: string;
	readonly requirementsDir: string;
	readonly native: boolean;
	constructor(options: SpecArtifactStoreOptions) {
		if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.changeId)) throw new Error("Invalid change ID");
		this.cwd = path.resolve(options.cwd);
		this.changeId = options.changeId;
		this.changeDir = `openspec/changes/${options.changeId}`;
		this.planPath = `docs/superpowers/plans/${new Date().toISOString().slice(0, 10)}-${options.changeId}.md`;
		this.requirementsDir = options.requirementsDir ?? "openspec/specs";
		this.native = this.requirementsDir === "openspec/specs";
	}
	async initialize(): Promise<SpecArtifactPaths> {
		await containedSpecPath(this.cwd, this.changeDir);
		const created = await runOpenSpec(["new", "change", this.changeId], this.cwd);
		if (created.exitCode !== 0)
			throw new Error(`OpenSpec change creation failed: ${created.stdout}\n${created.stderr}`);
		return {
			requirements: [
				`${this.changeDir}/proposal.md`,
				`${this.changeDir}/specs/*/spec.md`,
				...(!this.native ? await this.#markdownPaths() : []),
			],
			solution: this.planPath.replace(/\.md$/, "-solutions.json"),
			plan: this.planPath,
			report: this.planPath.replace(/\.md$/, "-completion.md"),
		};
	}
	async #markdownPaths(): Promise<string[]> {
		const root = await containedSpecPath(this.cwd, this.requirementsDir);
		const files = (await filesBelow(root))
			.filter(file => file.endsWith(".md"))
			.map(file => `${this.requirementsDir}/${file.replaceAll(path.sep, "/")}`);
		if (!files.length) throw new Error(`No authoritative Markdown requirements: ${this.requirementsDir}`);
		return files;
	}
	async readAuthorityDocuments(): Promise<SpecDocument[]> {
		return this.native ? [] : Promise.all((await this.#markdownPaths()).map(file => this.#read(file)));
	}
	async readRequirements(signal?: AbortSignal): Promise<SpecRequirements> {
		signal?.throwIfAborted();
		const root = await containedSpecPath(this.cwd, `${this.changeDir}/specs`);
		const specs = (await filesBelow(root)).filter(file => /^[a-z0-9]+(?:-[a-z0-9]+)*[\\/]spec\.md$/.test(file));
		if (!specs.length) throw new Error("Missing native specification: specs/<capability>/spec.md");
		const paths = [
			`${this.changeDir}/proposal.md`,
			...specs.map(file => `${this.changeDir}/specs/${file.replaceAll(path.sep, "/")}`),
			...(!this.native ? await this.#markdownPaths() : []),
		];
		const result = await runOpenSpec(
			["validate", this.changeId, "--type", "change", "--strict", "--json"],
			this.cwd,
			signal,
		);
		if (result.exitCode !== 0) throw new Error(`Specification validation failed: ${result.stdout}\n${result.stderr}`);
		const files = await Promise.all(paths.map(file => this.#read(file)));
		signal?.throwIfAborted();
		return { files, version: artifactVersion(JSON.stringify(files.map(file => [file.path, file.version]))) };
	}
	async readSolution(): Promise<SpecSolution> {
		const document = await this.#read(this.planPath.replace(/\.md$/, "-solutions.json"));
		let value: unknown;
		try {
			value = JSON.parse(document.content);
		} catch {
			throw new Error(`Solution must be valid JSON: ${document.path}`);
		}
		if (
			!value ||
			typeof value !== "object" ||
			!("candidates" in value) ||
			!Array.isArray(value.candidates) ||
			!value.candidates.length
		)
			throw new Error("Solution requires at least one candidate");
		const ids = new Set<string>();
		const candidates = value.candidates.map((item: unknown) => {
			if (
				!item ||
				typeof item !== "object" ||
				!("id" in item) ||
				!("title" in item) ||
				!("content" in item) ||
				typeof item.id !== "string" ||
				!/^\S+$/.test(item.id) ||
				typeof item.title !== "string" ||
				!item.title.trim() ||
				typeof item.content !== "string" ||
				!item.content.trim()
			)
				throw new Error(
					"Each solution candidate requires a nonempty whitespace-free id and nonempty title/content",
				);
			if (ids.has(item.id)) throw new Error(`Duplicate solution candidate ID: ${item.id}`);
			ids.add(item.id);
			return { id: item.id, title: item.title, content: item.content };
		});
		return { ...document, candidates };
	}
	async readPlan(): Promise<SpecDocument> {
		return this.#read(this.planPath);
	}
	async readReport(): Promise<SpecDocument> {
		const report = await this.#read(this.planPath.replace(/\.md$/, "-completion.md"));
		if (!/^# 完成报告\s*$/m.test(report.content)) throw new Error("Completion report requires title: # 完成报告");
		for (const heading of ["完成情况", "验证结果", "未完成项"]) {
			const section = report.content.match(
				new RegExp(`^## ${heading}[^\\S\\r\\n]*\\r?\\n([\\s\\S]*?)(?=^#{1,2} |$(?![\\s\\S]))`, "m"),
			);
			if (!section?.[1]?.trim()) throw new Error(`Completion report requires nonempty section: ## ${heading}`);
		}
		return report;
	}
	/** Called only by the explicit user-acceptance lifecycle boundary. */
	async close(
		input: { specification: SpecRequirements; report: SpecDocument },
		signal?: AbortSignal,
	): Promise<{ archivedChangePath: string }> {
		signal?.throwIfAborted();
		if (
			(await this.readRequirements(signal)).version !== input.specification.version ||
			(await this.readReport()).version !== input.report.version
		)
			throw new Error("Accepted requirements or completion report changed");
		const archiveRoot = "openspec/changes/archive";
		const absoluteArchive = await containedSpecPath(this.cwd, archiveRoot);
		let before: string[] = [];
		try {
			before = await fs.readdir(absoluteArchive);
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		const result = await runOpenSpec(
			["archive", this.changeId, "--yes", "--json", ...(!this.native ? ["--skip-specs"] : [])],
			this.cwd,
			signal,
		);
		if (result.exitCode !== 0)
			throw new Error(`OpenSpec archive failed (${result.exitCode}): ${result.stderr}\n${result.stdout}`);
		signal?.throwIfAborted();
		const created = (await fs.readdir(absoluteArchive)).filter(
			name => !before.includes(name) && name.endsWith(`-${this.changeId}`),
		);
		if (created.length !== 1) throw new Error("Native archive returned no unique archived change directory");
		const archivedChangePath = `${archiveRoot}/${created[0]}`;
		const archive = await containedSpecPath(this.cwd, archivedChangePath);
		if (!(await fs.stat(archive)).isDirectory()) throw new Error("Native archived change is not a directory");
		for (const file of input.specification.files) {
			const target = file.path.startsWith(`${this.changeDir}/`)
				? `${archivedChangePath}/${path.posix.relative(this.changeDir, file.path)}`
				: file.path;
			if ((await fs.readFile(await containedSpecPath(this.cwd, target), "utf8")) !== file.content)
				throw new Error(`Archived requirement changed: ${file.path}`);
		}
		try {
			await fs.stat(await containedSpecPath(this.cwd, this.changeDir));
			throw new Error("Native archive did not retire the source change");
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		return { archivedChangePath };
	}
	async #read(file: string): Promise<SpecDocument> {
		const content = await fs.readFile(await containedSpecPath(this.cwd, file), "utf8");
		if (!content.trim()) throw new Error(`Empty specification artifact: ${file}`);
		return snapshot(file, content);
	}
}
