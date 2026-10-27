import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { parse as parseYaml } from "yaml";
import { assertDevSpecSchema, runOpenSpec, type SpecDrivenProcessResult } from "./resources";
import type {
	SpecArtifactPaths,
	SpecDocument,
	SpecFileVersion,
	SpecRequirements,
	SpecSolution,
	SpecVersionCheck,
} from "./types";

export interface SpecArtifactStoreOptions {
	cwd: string;
	changeId: string;
	requirementsDir?: string;
	planPath?: string;
	paths?: SpecArtifactPaths;
}

export interface SpecCloseProgress {
	synced?: boolean;
	archivedChangePath?: string;
	retirementCleanup?: { paths: string[]; diagnostic: string };
}
export function artifactVersion(content: string | Uint8Array): string {
	return crypto.createHash("sha256").update(content).digest("hex");
}

/** Parse the authoritative solution bytes consistently for stage admission and material views. */
export function parseSpecSolution(document: SpecDocument): SpecSolution {
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
			throw new Error("Each solution candidate requires a nonempty whitespace-free id and nonempty title/content");
		if (ids.has(item.id)) throw new Error(`Duplicate solution candidate ID: ${item.id}`);
		ids.add(item.id);
		return { id: item.id, title: item.title, content: item.content };
	});
	if (
		!("recommendedCandidateId" in value) ||
		typeof value.recommendedCandidateId !== "string" ||
		!ids.has(value.recommendedCandidateId)
	)
		throw new Error("Solution requires a recommendedCandidateId matching a candidate ID");
	return { ...document, candidates, recommendedCandidateId: value.recommendedCandidateId };
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

/** Stage writes cannot follow aliases, even when their targets remain inside the workspace. */
export async function assertSpecWritePath(root: string, relative: string): Promise<void> {
	await containedSpecPath(root, relative);
	const base = path.resolve(root);
	const target = path.resolve(base, relative);
	for (let current = target; current !== base; current = path.dirname(current)) {
		try {
			const entry = await fs.lstat(current);
			if (entry.isSymbolicLink()) throw new Error(`Linked stage document path is not writable: ${relative}`);
			if (current === target && (!entry.isFile() || entry.nlink !== 1))
				throw new Error(`Stage document must be an unlinked regular file: ${relative}`);
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
	}
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

/** Enumerate formal materials without validating or changing the workflow. */
export async function formalMaterialPaths(
	cwd: string,
	paths: SpecArtifactPaths,
	changeId: string,
	archivedChangePath?: string,
): Promise<string[]> {
	const changeDir = `openspec/changes/${changeId}`;
	const relocate = (file: string) =>
		archivedChangePath && file.startsWith(`${changeDir}/`)
			? `${archivedChangePath}/${file.slice(changeDir.length + 1)}`
			: file;
	const requirements: string[] = [];
	for (const file of paths.requirements) {
		if (file !== `${changeDir}/specs/*/spec.md`) {
			requirements.push(relocate(file));
			continue;
		}
		const directory = relocate(`${changeDir}/specs`);
		try {
			const root = await containedSpecPath(cwd, directory);
			requirements.push(
				...(await filesBelow(root))
					.filter(entry => /^[^\\/]+[\\/]spec\.md$/.test(entry))
					.map(entry => `${directory}/${entry.replaceAll(path.sep, "/")}`),
			);
		} catch (error) {
			if (!isEnoent(error) && (error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error;
		}
	}
	return [...new Set(requirements), paths.solution, paths.plan, paths.report];
}

export class SpecArtifactStore {
	readonly cwd: string;
	readonly changeId: string;
	readonly changeDir: string;
	readonly planPath: string;
	readonly requirementsDir: string;
	readonly native: boolean;
	readonly paths?: SpecArtifactPaths;
	constructor(options: SpecArtifactStoreOptions) {
		if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.changeId)) throw new Error("Invalid change ID");
		this.cwd = path.resolve(options.cwd);
		this.changeId = options.changeId;
		this.changeDir = `openspec/changes/${options.changeId}`;
		this.paths = options.paths;
		this.planPath =
			options.paths?.plan ??
			options.planPath ??
			`docs/superpowers/plans/${new Date().toISOString().slice(0, 10)}-${options.changeId}.md`;
		this.requirementsDir = options.requirementsDir ?? "openspec/specs";
		this.native = this.requirementsDir === "openspec/specs";
	}
	async initialize(): Promise<SpecArtifactPaths> {
		if (this.paths) {
			for (const file of [...this.paths.requirements, this.paths.solution, this.paths.plan, this.paths.report])
				await containedSpecPath(this.cwd, file);
			return structuredClone(this.paths);
		}
		await assertDevSpecSchema(this.cwd);
		// Native `new change` also creates a project config when one is absent.
		// Dev owns only this change, so create its native metadata without initializing the project.
		const changesDir = await containedSpecPath(this.cwd, "openspec/changes");
		await fs.mkdir(changesDir, { recursive: true });
		const changeDir = await containedSpecPath(this.cwd, this.changeDir);
		await fs.mkdir(changeDir);
		const now = new Date();
		const created = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
		await fs.writeFile(path.join(changeDir, ".openspec.yaml"), `schema: omp-spec\ncreated: ${created}\n`, {
			flag: "wx",
		});
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
	async #assertOwnSchema(signal?: AbortSignal): Promise<void> {
		let metadata: string;
		try {
			metadata = await fs.readFile(await containedSpecPath(this.cwd, `${this.changeDir}/.openspec.yaml`), "utf8");
		} catch (error) {
			if (isEnoent(error)) return;
			throw error;
		}
		let value: unknown;
		try {
			value = parseYaml(metadata);
		} catch {
			// Let the native command handle pre-existing invalid metadata.
			return;
		}
		if (
			value &&
			typeof value === "object" &&
			"schema" in value &&
			typeof value.schema === "string" &&
			value.schema.replace(/\.ya?ml$/, "") === "omp-spec"
		)
			await assertDevSpecSchema(this.cwd, signal);
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
		const directory = `${this.changeDir}/specs`;
		const root = await containedSpecPath(this.cwd, directory);
		let entries: string[];
		try {
			entries = await filesBelow(root);
		} catch (error) {
			if (!isEnoent(error) || (error as NodeJS.ErrnoException).path !== root) throw error;
			throw new Error(`缺少需求规格，请补齐后重试 /dev next。路径：${directory}/*/spec.md；原因：${error.message}`, {
				cause: error,
			});
		}
		const specs = entries.filter(file => /^[a-z0-9]+(?:-[a-z0-9]+)*[\\/]spec\.md$/.test(file));
		if (!specs.length)
			throw new Error(
				`缺少需求规格，请补齐后重试 /dev next。路径：${directory}/*/spec.md；原因：目录中没有有效规格文件`,
			);
		const paths = [
			`${this.changeDir}/proposal.md`,
			...specs.map(file => `${this.changeDir}/specs/${file.replaceAll(path.sep, "/")}`),
			...(!this.native ? await this.#markdownPaths() : []),
		];
		await this.#assertOwnSchema(signal);
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
		const document = await this.#read(this.paths?.solution ?? this.planPath.replace(/\.md$/, "-solutions.json"));
		return parseSpecSolution(document);
	}
	async readPlan(): Promise<SpecDocument> {
		return this.#read(this.planPath);
	}
	async readReport(): Promise<SpecDocument> {
		const report = await this.#read(this.paths?.report ?? this.planPath.replace(/\.md$/, "-completion.md"), true);
		if (!/^# 完成报告\s*$/m.test(report.content)) throw new Error("Completion report requires title: # 完成报告");
		for (const heading of ["完成情况", "验证结果", "未完成项"]) {
			const section = report.content.match(
				new RegExp(`^## ${heading}[^\\S\\r\\n]*\\r?\\n([\\s\\S]*?)(?=^#{1,2} |$(?![\\s\\S]))`, "m"),
			);
			if (!section?.[1]?.trim()) throw new Error(`Completion report requires nonempty section: ## ${heading}`);
		}
		return report;
	}
	/** Byte checks deliberately do not parse or validate artifacts, including during ordinary conversation. */
	async checkVersions(files: readonly SpecFileVersion[], archivedChangePath?: string): Promise<SpecVersionCheck> {
		if (!files.length) return { matches: true, changed: [] };
		const archive = archivedChangePath ?? (await this.#findArchive(files));
		const result = await this.#checkVersionsAt(files, archive);
		const approved = new Set(files.map(file => file.path));
		const requirementPaths = this.paths?.requirements ?? [
			`${this.changeDir}/proposal.md`,
			`${this.changeDir}/specs/*/spec.md`,
		];
		const isRequirement = (file: string) =>
			file === `${this.changeDir}/proposal.md` ||
			file.startsWith(`${this.changeDir}/specs/`) ||
			(!this.native && file.startsWith(`${this.requirementsDir}/`) && file.endsWith(".md")) ||
			requirementPaths.includes(file);
		// A solution-only check is not a requirements approval; no baseline exists yet.
		if (files.some(file => isRequirement(file.path))) {
			try {
				const materials = await formalMaterialPaths(
					this.cwd,
					{
						requirements: requirementPaths,
						solution: "",
						plan: "",
						report: "",
					},
					this.changeId,
					archive,
				);
				const current = new Set(
					[...materials.slice(0, -3), ...(!this.native ? await this.#markdownPaths() : [])].map(file =>
						archive && file.startsWith(`${archive}/`)
							? `${this.changeDir}/${file.slice(archive.length + 1)}`
							: file,
					),
				);
				for (const file of current)
					if (!approved.has(file))
						result.changed.push({ path: file, reason: `Unapproved requirements artifact added: ${file}` });
			} catch (error) {
				result.changed.push({
					path: this.requirementsDir,
					reason: `Cannot enumerate approved requirements: ${error instanceof Error ? error.message : error}`,
				});
			}
		}
		return { matches: result.changed.length === 0, changed: result.changed };
	}
	async #checkVersionsAt(files: readonly SpecFileVersion[], archivedChangePath?: string): Promise<SpecVersionCheck> {
		const changed: SpecVersionCheck["changed"] = [];
		for (const file of files) {
			const target =
				archivedChangePath && file.path.startsWith(`${this.changeDir}/`)
					? `${archivedChangePath}/${file.path.slice(this.changeDir.length + 1)}`
					: file.path;
			try {
				const bytes = await fs.readFile(await containedSpecPath(this.cwd, target));
				if (artifactVersion(bytes) !== file.version)
					changed.push({ path: file.path, reason: `Accepted artifact changed: ${target}` });
			} catch (error) {
				changed.push({ path: file.path, reason: `${target}: ${error instanceof Error ? error.message : error}` });
			}
		}
		return { matches: changed.length === 0, changed };
	}
	/** Find an already completed native archive without assuming the current date or recreating the change. */
	async #findArchive(files: readonly SpecFileVersion[]): Promise<string | undefined> {
		try {
			await fs.stat(await containedSpecPath(this.cwd, this.changeDir));
			return undefined;
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		const archiveRoot = "openspec/changes/archive";
		let names: string[];
		try {
			names = await fs.readdir(await containedSpecPath(this.cwd, archiveRoot));
		} catch (error) {
			if (isEnoent(error)) return undefined;
			throw error;
		}
		const candidates = names
			.filter(
				name => name === this.changeId || (/^\d{4}-\d{2}-\d{2}-/.test(name) && name.slice(11) === this.changeId),
			)
			.map(name => `${archiveRoot}/${name}`);
		const requirements = files.filter(file => file.path.startsWith(`${this.changeDir}/`));
		if (!requirements.length) return undefined;
		const matches: string[] = [];
		for (const candidate of candidates)
			if ((await this.#checkVersionsAt(requirements, candidate)).matches) matches.push(candidate);
		if (matches.length === 1) return matches[0];
		// A unique native destination must still be checked, not treated as missing when its bytes changed.
		if (!matches.length && candidates.length === 1) return candidates[0];
		if (candidates.length) throw new Error("Cannot identify a unique native archive for the accepted change");
		return undefined;
	}
	/** The native archive owns its validation, sync transaction, rollback and directory relocation. */
	async close(
		input: {
			acceptedVersions: readonly SpecFileVersion[];
			progress?: SpecCloseProgress;
			onProgress?: (progress: SpecCloseProgress) => void | Promise<void>;
		},
		signal?: AbortSignal,
	): Promise<{ archivedChangePath: string }> {
		signal?.throwIfAborted();
		const progress = input.progress ?? {};
		const publish = async () => input.onProgress?.({ ...progress });
		if (!progress.archivedChangePath) {
			const recovered = await this.#findArchive(input.acceptedVersions);
			if (recovered) {
				progress.archivedChangePath = recovered;
				progress.synced = true;
				await publish();
			}
		}
		const check = await this.checkVersions(input.acceptedVersions, progress.archivedChangePath);
		if (!check.matches) throw new Error(check.changed.map(file => file.reason).join("\n"));
		if (progress.retirementCleanup) {
			const { paths, diagnostic } = progress.retirementCleanup;
			if (!paths.length) throw new Error(diagnostic);
			for (const file of paths) {
				try {
					await fs.lstat(await containedSpecPath(this.cwd, file));
				} catch (error) {
					if (isEnoent(error)) continue;
					throw error;
				}
				throw new Error(`${diagnostic}\nRetirement recovery path still requires explicit cleanup: ${file}`);
			}
			delete progress.retirementCleanup;
			await publish();
		}
		if (!progress.archivedChangePath) {
			await this.#assertOwnSchema(signal);
			let result: SpecDrivenProcessResult | undefined;
			let failure: unknown;
			try {
				result = await runOpenSpec(
					[
						"archive",
						this.changeId,
						"--yes",
						"--json",
						...(!this.native || progress.synced ? ["--skip-specs"] : []),
					],
					this.cwd,
					signal,
				);
			} catch (error) {
				failure = error;
			}
			// Use the native result before any post-archive verification can fail.
			let archived: string | undefined;
			if (result?.exitCode === 0) {
				try {
					const value: unknown = JSON.parse(result.stdout);
					if (value && typeof value === "object" && "archive" in value) {
						const archive = value.archive;
						if (archive && typeof archive === "object" && "path" in archive && typeof archive.path === "string") {
							const relative = path
								.relative(this.cwd, path.resolve(this.cwd, archive.path))
								.replaceAll(path.sep, "/");
							if (relative.startsWith("openspec/changes/archive/") && !relative.split("/").includes(".."))
								archived = relative;
						}
					}
				} catch {
					// A failed/lost response is recoverable from the native destination, not a guessed date.
				}
			}
			// Even a nonzero exit can follow a completed native move (e.g. retirement cleanup failed).
			archived ??= await this.#findArchive(input.acceptedVersions);
			if (result && result.exitCode !== 0) {
				try {
					const value = JSON.parse(result.stdout) as { status?: { code?: string; message?: string }[] };
					const cleanup = value.status?.find(item => item.code === "archive_retirement_cleanup_failed");
					if (cleanup) {
						const diagnostic = cleanup.message ?? "Native archive retirement cleanup failed";
						const paths = [...diagnostic.matchAll(/Could not finalize the retirement backup at (.*?) \(/g)]
							.map(match => path.relative(this.cwd, path.resolve(this.cwd, match[1]!)).replaceAll(path.sep, "/"))
							.filter(
								file =>
									file.startsWith("openspec/specs/") && /\/spec\.md\.openspec-retire-[a-f0-9-]+$/.test(file),
							);
						progress.retirementCleanup = { paths: [...new Set(paths)], diagnostic };
					}
				} catch {
					// Non-JSON diagnostics retain the ordinary native failure below.
				}
			}
			if (archived) {
				progress.archivedChangePath = archived;
				progress.synced = true;
				await publish();
			}
			if (failure) throw failure;
			if (result && result.exitCode !== 0)
				throw new Error(`OpenSpec archive failed (${result.exitCode}): ${result.stderr}\n${result.stdout}`);
			if (!progress.archivedChangePath)
				throw new Error("Native archive returned no unique archived change directory");
		}
		signal?.throwIfAborted();
		const verified = await this.checkVersions(input.acceptedVersions, progress.archivedChangePath);
		if (!verified.matches) throw new Error(verified.changed.map(file => file.reason).join("\n"));
		return { archivedChangePath: progress.archivedChangePath };
	}
	async #read(file: string, report = false): Promise<SpecDocument> {
		const resolved = await containedSpecPath(this.cwd, file);
		let bytes: Buffer;
		try {
			bytes = await fs.readFile(resolved);
		} catch (error) {
			if (!report || !isEnoent(error)) throw error;
			throw new Error(`缺少完成报告，请补齐后重试 /dev next。路径：${file}；原因：${error.message}`, {
				cause: error,
			});
		}
		const content = bytes.toString("utf8");
		if (!content.trim()) throw new Error(`Empty specification artifact: ${file}`);
		return { path: file, content, version: artifactVersion(bytes) };
	}
}
