import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { parse as parseYaml } from "yaml";
import { assertDevSpecSchema, runOpenSpec, runOpenSpecDirectory, type SpecDrivenProcessResult } from "./resources";
import type {
	DevMaterialRef,
	DevRequirementRecord,
	SpecArtifactPaths,
	SpecCloseProgress,
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
	archivedChangePath?: string;
}

export function hasSpecCloseSideEffects(progress?: SpecCloseProgress): boolean {
	return !!(
		progress?.synced ||
		progress?.archivedChangePath ||
		progress?.sideEffects ||
		progress?.ownership?.state === "pending"
	);
}

function isNativeSpec(file: string): boolean {
	const segments = file.split(/[\\/]/);
	return segments.length > 1 && segments.at(-1) === "spec.md" && segments.every(segment => !segment.startsWith("."));
}

/** Both the recursive pattern and previously saved native patterns represent native discovery. */
export function matchesNativeSpecPattern(pattern: string, file: string): boolean {
	const match = /^(.*\/specs\/)\*{1,2}\/spec\.md$/.exec(pattern);
	if (!match || !file.startsWith(match[1])) return false;
	const relative = file.slice(match[1].length);
	const segments = relative.split("/");
	return (
		segments.length >= 2 &&
		segments.at(-1) === "spec.md" &&
		segments.every(
			segment => segment.length > 0 && !segment.startsWith(".") && !segment.includes("*") && !segment.includes("\\"),
		)
	);
}

/** Check exact native-discovered spelling without accepting links or file aliases as authority. */
export async function existingNativeSpec(cwd: string, relative: string): Promise<boolean> {
	const segments = relative.split("/");
	if (!isNativeSpec(relative) || segments.some(segment => !segment || segment === "..")) return false;
	let current = cwd;
	try {
		for (const [index, segment] of segments.entries()) {
			if (!(await fs.readdir(current)).includes(segment)) return false;
			current = path.join(current, segment);
			const entry = await fs.lstat(current);
			if (entry.isSymbolicLink()) return false;
			if (index === segments.length - 1) return entry.isFile() && entry.nlink === 1;
			if (!entry.isDirectory()) return false;
		}
	} catch (error) {
		if (isEnoent(error) || (error as NodeJS.ErrnoException).code === "ENOTDIR") return false;
		throw error;
	}
	return false;
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

/** Match native discovery: skip dot entries and linked directories, but read linked spec files. */
async function nativeSpecsBelow(cwd: string, directory: string): Promise<string[]> {
	const root = await containedSpecPath(cwd, directory);
	const files: string[] = [];
	const walk = async (relative: string): Promise<void> => {
		for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
			if (entry.name.startsWith(".")) continue;
			const child = path.join(relative, entry.name);
			if (entry.isDirectory()) await walk(child);
			else if (entry.name === "spec.md" && relative) {
				if (entry.isSymbolicLink()) {
					try {
						if (!(await fs.stat(path.join(root, child))).isFile()) continue;
					} catch (error) {
						if (isEnoent(error)) continue;
						throw error;
					}
				} else if (!entry.isFile()) continue;
				await containedSpecPath(cwd, `${directory}/${child.replaceAll(path.sep, "/")}`);
				files.push(child);
			}
		}
	};
	await walk("");
	return files.sort();
}

/** Resolve recorded archive facts, or a unique real native destination, never a guessed date. */
export async function resolveSpecChangeDirectory(
	cwd: string,
	changeId: string,
	archivedChangePath?: string,
): Promise<string> {
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(changeId)) throw new Error("Invalid change ID");
	const active = `openspec/changes/${changeId}`;
	const archiveRoot = "openspec/changes/archive";
	if (archivedChangePath) {
		const name = archivedChangePath.slice(archiveRoot.length + 1);
		if (
			!archivedChangePath.startsWith(`${archiveRoot}/`) ||
			name.includes("/") ||
			name.includes("\\") ||
			(name !== changeId && !/^\d{4}-\d{2}-\d{2}-/.test(name)) ||
			(name !== changeId && name.slice(11) !== changeId)
		)
			throw new Error(`Invalid recorded archive path: ${archivedChangePath}`);
		await assertSpecDirectory(cwd, archivedChangePath);
		return archivedChangePath;
	}
	try {
		await assertSpecDirectory(cwd, active);
		return active;
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	let entries: string[];
	try {
		entries = await fs.readdir(await containedSpecPath(cwd, archiveRoot));
	} catch (error) {
		if (isEnoent(error)) return active;
		throw error;
	}
	const candidates = entries.filter(
		name => name === changeId || (/^\d{4}-\d{2}-\d{2}-/.test(name) && name.slice(11) === changeId),
	);
	if (candidates.length > 1) throw new Error("Cannot identify a unique native archive for the change");
	if (!candidates.length) return active;
	const directory = `${archiveRoot}/${candidates[0]}`;
	await assertSpecDirectory(cwd, directory);
	return directory;
}

async function assertSpecDirectory(cwd: string, relative: string): Promise<void> {
	await containedSpecPath(cwd, relative);
	const base = path.resolve(cwd);
	const target = path.resolve(base, relative);
	for (let current = target; current !== base; current = path.dirname(current)) {
		const entry = await fs.lstat(current);
		if (entry.isSymbolicLink() || !entry.isDirectory())
			throw new Error(`Specification directory must not follow links: ${relative}`);
	}
}

/** Enumerate formal materials without validating or changing the workflow. */
export async function formalMaterialPaths(
	cwd: string,
	paths: SpecArtifactPaths,
	changeId: string,
	archivedChangePath?: string,
): Promise<string[]> {
	const changeDir = `openspec/changes/${changeId}`;
	const actual = await resolveSpecChangeDirectory(cwd, changeId, archivedChangePath);
	const relocate = (file: string) =>
		file.startsWith(`${changeDir}/`) ? `${actual}/${file.slice(changeDir.length + 1)}` : file;
	const requirements: string[] = [];
	for (const file of paths.requirements) {
		if (file !== `${changeDir}/specs/*/spec.md` && file !== `${changeDir}/specs/**/spec.md`) {
			requirements.push(relocate(file));
			continue;
		}
		const directory = relocate(`${changeDir}/specs`);
		try {
			requirements.push(
				...(await nativeSpecsBelow(cwd, directory)).map(entry => `${directory}/${entry.replaceAll(path.sep, "/")}`),
			);
		} catch (error) {
			if (!isEnoent(error) && (error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error;
		}
	}
	return [
		...(paths.business ? [paths.business] : []),
		...new Set(requirements),
		paths.solution,
		paths.plan,
		paths.report,
	];
}

export class SpecArtifactStore {
	readonly cwd: string;
	readonly changeId: string;
	readonly changeDir: string;
	readonly planPath: string;
	readonly requirementsDir: string;
	readonly native: boolean;
	readonly paths?: SpecArtifactPaths;
	readonly archivedChangePath?: string;
	constructor(options: SpecArtifactStoreOptions) {
		if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.changeId)) throw new Error("Invalid change ID");
		this.cwd = path.resolve(options.cwd);
		this.changeId = options.changeId;
		this.changeDir = `openspec/changes/${options.changeId}`;
		this.paths = options.paths;
		this.archivedChangePath = options.archivedChangePath;
		this.planPath =
			options.paths?.plan ??
			options.planPath ??
			`docs/superpowers/plans/${new Date().toISOString().slice(0, 10)}-${options.changeId}.md`;
		this.requirementsDir = options.requirementsDir ?? "openspec/specs";
		this.native = this.requirementsDir === "openspec/specs";
	}
	async resolveChangeDirectory(): Promise<string> {
		return resolveSpecChangeDirectory(this.cwd, this.changeId, this.archivedChangePath);
	}
	async initialize(businessPath?: string): Promise<SpecArtifactPaths> {
		const archived = (await this.resolveChangeDirectory()) !== this.changeDir;
		if (archived && this.paths) return structuredClone(this.paths);
		if (businessPath !== undefined) {
			if (!/\.md$/i.test(businessPath)) throw new Error("业务文档必须是 Markdown 文件");
			const normalized = path
				.relative(this.cwd, path.resolve(this.cwd, businessPath))
				.replaceAll("\\", "/")
				.toLowerCase();
			if (
				normalized.startsWith("openspec/") ||
				[this.planPath, this.planPath.replace(/\.md$/, "-completion.md")].some(
					file => file.toLowerCase() === normalized,
				)
			)
				throw new Error("业务文档不能使用开发规格、计划或完成报告路径");
			await assertSpecWritePath(this.cwd, businessPath);
			return {
				business: businessPath.replaceAll("\\", "/"),
				requirements: [`${this.changeDir}/proposal.md`, `${this.changeDir}/specs/**/spec.md`],
				solution: this.planPath.replace(/\.md$/, "-solutions.json"),
				plan: this.planPath,
				report: this.planPath.replace(/\.md$/, "-completion.md"),
			};
		}
		if (this.paths) {
			for (const file of [
				...(this.paths.business ? [this.paths.business] : []),
				...this.paths.requirements,
				this.paths.solution,
				this.paths.plan,
				this.paths.report,
			])
				await containedSpecPath(this.cwd, file);
			if (!this.paths.business) return structuredClone(this.paths);
			try {
				await fs.access(await containedSpecPath(this.cwd, `${this.changeDir}/.openspec.yaml`));
				return structuredClone(this.paths);
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
		}
		if (!archived) {
			await assertDevSpecSchema(this.cwd);
			// Native `new change` also creates a project config when one is absent.
			// Dev owns only this change, so create its native metadata without initializing the project.
			const changesDir = await containedSpecPath(this.cwd, "openspec/changes");
			await fs.mkdir(changesDir, { recursive: true });
			const changeDir = await containedSpecPath(this.cwd, this.changeDir);
			await fs.mkdir(changeDir, { recursive: !!this.paths?.business });
			const now = new Date();
			const created = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
			await fs.writeFile(path.join(changeDir, ".openspec.yaml"), `schema: omp-spec\ncreated: ${created}\n`, {
				flag: "wx",
			});
			if (this.paths) return structuredClone(this.paths);
		}
		return {
			requirements: [
				`${this.changeDir}/proposal.md`,
				`${this.changeDir}/specs/**/spec.md`,
				...(!this.native ? await this.#markdownPaths() : []),
			],
			solution: this.planPath.replace(/\.md$/, "-solutions.json"),
			plan: this.planPath,
			report: this.planPath.replace(/\.md$/, "-completion.md"),
		};
	}
	async readBusiness(file = this.paths?.business): Promise<SpecDocument> {
		if (!file) throw new Error("尚未指定业务文档路径");
		await assertSpecWritePath(this.cwd, file);
		const document = await this.#read(file);
		if (!/^#\s+\S+/m.test(document.content)) throw new Error(`业务文档缺少需求名称：${file}`);
		for (const heading of [
			"基本信息",
			"业务背景与目标",
			"实际使用场景与现状",
			"期望结果",
			"业务规则与边界",
			"典型例子",
			"业务验收预期",
			"待确认事项",
			"资料来源",
			"业务确认与交接",
		]) {
			const section = new RegExp(`^##\\s+${heading}\\s*\\r?\\n([\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))`, "m").exec(
				document.content,
			);
			if (!section?.[1].trim()) throw new Error(`业务文档缺少非空章节「${heading}」：${file}`);
		}
		return document;
	}
	async #assertOwnSchema(signal?: AbortSignal): Promise<void> {
		let metadata: string;
		try {
			metadata = await fs.readFile(
				await containedSpecPath(this.cwd, `${await this.resolveChangeDirectory()}/.openspec.yaml`),
				"utf8",
			);
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
		const changeDir = await this.resolveChangeDirectory();
		const directory = `${changeDir}/specs`;
		const root = await containedSpecPath(this.cwd, directory);
		let entries: string[];
		try {
			entries = await nativeSpecsBelow(this.cwd, directory);
		} catch (error) {
			if (!isEnoent(error) || (error as NodeJS.ErrnoException).path !== root) throw error;
			throw new Error(`缺少需求规格，请补齐后重试 /dev next。路径：${directory}/*/spec.md；原因：${error.message}`, {
				cause: error,
			});
		}
		const specs = entries.filter(isNativeSpec);
		if (!specs.length)
			throw new Error(
				`缺少需求规格，请补齐后重试 /dev next。路径：${directory}/*/spec.md；原因：目录中没有有效规格文件`,
			);
		const paths = [
			`${changeDir}/proposal.md`,
			...specs.map(file => `${changeDir}/specs/${file.replaceAll(path.sep, "/")}`),
			...(!this.native ? await this.#markdownPaths() : []),
		];
		await this.#assertOwnSchema(signal);
		const result =
			changeDir === this.changeDir
				? await runOpenSpec(["validate", this.changeId, "--type", "change", "--strict", "--json"], this.cwd, signal)
				: await runOpenSpecDirectory(
						"validate-directory",
						{
							changeDir: await containedSpecPath(this.cwd, changeDir),
							projectRoot: this.cwd,
							mainSpecsDir: await containedSpecPath(this.cwd, "openspec/specs"),
						},
						this.cwd,
						signal,
					);
		if (result.exitCode !== 0) throw new Error(`Specification validation failed: ${result.stdout}\n${result.stderr}`);
		// Native `validate --type change` only validates delta specs. Dev also owns
		// the proposal artifact, so use the existing native proposal validator.
		const proposal = await runOpenSpecDirectory(
			"validate-directory",
			{
				changeDir: await containedSpecPath(this.cwd, changeDir),
				artifact: "proposal",
			},
			this.cwd,
			signal,
		);
		if (proposal.exitCode !== 0)
			throw new Error(`Proposal validation failed: ${proposal.stdout}\n${proposal.stderr}`);
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
		const actual = await resolveSpecChangeDirectory(
			this.cwd,
			this.changeId,
			archivedChangePath ?? this.archivedChangePath,
		);
		const archive =
			archivedChangePath ??
			this.archivedChangePath ??
			(await this.#findArchive(files)) ??
			(actual === this.changeDir ? undefined : actual);
		const result = await this.#checkVersionsAt(files, archive);
		const logical = (file: string) =>
			archive && file.startsWith(`${archive}/`) ? `${this.changeDir}/${file.slice(archive.length + 1)}` : file;
		const approved = new Set(files.map(file => logical(file.path)));
		const requirementPaths = this.paths?.requirements ?? [
			`${this.changeDir}/proposal.md`,
			`${this.changeDir}/specs/**/spec.md`,
		];
		const isRequirement = (file: string) =>
			file === `${this.changeDir}/proposal.md` ||
			file.startsWith(`${this.changeDir}/specs/`) ||
			(!this.native && file.startsWith(`${this.requirementsDir}/`) && file.endsWith(".md")) ||
			requirementPaths.includes(file);
		// A solution-only check is not a requirements approval; no baseline exists yet.
		if (files.some(file => isRequirement(logical(file.path)))) {
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
			archivePlan?: string;
		},
		signal?: AbortSignal,
	): Promise<{ archivedChangePath: string }> {
		signal?.throwIfAborted();
		const progress = input.progress ?? {};
		const publish = async () => input.onProgress?.({ ...progress });
		if (progress.sideEffects) {
			const { diagnostic, expectedVersions } = progress.sideEffects;
			if (!expectedVersions?.length) throw new Error(diagnostic);
			for (const expected of expectedVersions) {
				let actual: string | null;
				try {
					actual = artifactVersion(await fs.readFile(await containedSpecPath(this.cwd, expected.path)));
				} catch (error) {
					if (!isEnoent(error)) throw error;
					actual = null;
				}
				if (actual !== expected.version) throw new Error(diagnostic);
			}
			delete progress.sideEffects;
			await publish();
			throw new Error("Native rollback was restored; a new explicit sync operation is required");
		}
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
		if (progress.archiveCleanup) {
			const { path: source, diagnostic } = progress.archiveCleanup;
			try {
				await fs.lstat(await containedSpecPath(this.cwd, source));
				throw new Error(`${diagnostic}\nArchive source still requires explicit cleanup: ${source}`);
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
			delete progress.archiveCleanup;
			await publish();
		}
		if (!progress.archivedChangePath) {
			await this.#assertOwnSchema(signal);
			// Only the main specs corresponding to accepted deltas can be mutated by native sync.
			const targets =
				this.native && !progress.synced
					? input.acceptedVersions
							.map(file => file.path)
							.filter(
								file =>
									file.startsWith(`${this.changeDir}/specs/`) &&
									isNativeSpec(file.slice(`${this.changeDir}/specs/`.length)),
							)
							.map(file => `openspec/specs/${file.slice(`${this.changeDir}/specs/`.length)}`)
					: [];
			const fingerprint = async (file: string): Promise<string | null> => {
				try {
					return artifactVersion(await fs.readFile(await containedSpecPath(this.cwd, file)));
				} catch (error) {
					if (isEnoent(error)) return null;
					throw error;
				}
			};
			const before = await Promise.all(targets.map(fingerprint));
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
					{ archivePlan: input.archivePlan },
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
			// Even a nonzero exit can follow a completed native move.
			archived ??= await this.#findArchive(input.acceptedVersions);
			if (result && result.exitCode !== 0) {
				try {
					const value = JSON.parse(result.stdout) as { status?: { code?: string; message?: string }[] };
					const diagnostics = value.status ?? [];
					const cleanup = diagnostics.find(item => item.code === "archive_retirement_cleanup_failed");
					if (cleanup) {
						const diagnostic = cleanup.message ?? "Native archive retirement cleanup failed";
						const paths = [
							...diagnostic.matchAll(
								/Could not finalize the retirement backup at (.+?spec\.md\.openspec-retire-[a-f0-9-]+) \(/g,
							),
						]
							.map(match => path.relative(this.cwd, path.resolve(this.cwd, match[1]!)).replaceAll(path.sep, "/"))
							.filter(file => file.startsWith("openspec/specs/") && !file.split("/").includes(".."));
						progress.retirementCleanup = { paths: [...new Set(paths)], diagnostic };
					}
					for (const item of diagnostics) {
						const diagnostic = item.message ?? "";
						const move = diagnostic.match(
							/Copied ([\s\S]+?) to ([\s\S]+?), but could not remove the source at ([\s\S]+?) completely \(/,
						);
						if (move && move[1] === move[3]) {
							const source = path.relative(this.cwd, path.resolve(this.cwd, move[3]!)).replaceAll(path.sep, "/");
							const destination = path
								.relative(this.cwd, path.resolve(this.cwd, move[2]!))
								.replaceAll(path.sep, "/");
							const validSource =
								source === this.changeDir || /^openspec\/changes\/\.openspec-move-[a-f0-9-]+$/.test(source);
							const validDestination =
								destination.startsWith("openspec/changes/archive/") && !destination.split("/").includes("..");
							if (
								validSource &&
								validDestination &&
								(await this.#checkVersionsAt(input.acceptedVersions, destination)).matches
							) {
								archived = destination;
								progress.archiveCleanup = { path: source, diagnostic };
							}
						}
					}
					const rollback = diagnostics.find(item => item.message?.includes("Rollback also failed:"));
					if (rollback) {
						const changed: string[] = [];
						for (let i = 0; i < targets.length; i++) {
							try {
								if ((await fingerprint(targets[i]!)) !== before[i]) changed.push(targets[i]!);
							} catch {
								// An unreadable target cannot be proven restored.
								changed.push(targets[i]!);
							}
						}
						progress.sideEffects = {
							paths: changed.length ? changed : targets,
							diagnostic: rollback.message!,
							expectedVersions: targets.map((file, index) => ({ path: file, version: before[index] ?? null })),
						};
					}
				} catch {
					// Non-JSON diagnostics retain the ordinary native failure below.
				}
			}
			if (archived) {
				progress.archivedChangePath = archived;
				progress.synced = true;
				delete progress.sideEffects;
			}
			if (archived || progress.sideEffects || progress.retirementCleanup || progress.archiveCleanup) {
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
		const directory = await this.resolveChangeDirectory();
		if (file.startsWith(`${this.changeDir}/`)) file = `${directory}/${file.slice(this.changeDir.length + 1)}`;
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

/** The recorded archive location remains authoritative even during source-cleanup recovery. */
function recordedArchive(record: DevRequirementRecord): string | undefined {
	for (const revision of [...record.syncRevisions].reverse()) {
		const archive = revision.archivedChangePath ?? revision.progress.archivedChangePath;
		if (archive) return archive;
	}
	return undefined;
}

export async function resolveDevMaterials(cwd: string, record: DevRequirementRecord): Promise<DevMaterialRef[]> {
	const active = `openspec/changes/${record.changeId}`;
	const actual = await resolveSpecChangeDirectory(cwd, record.changeId, recordedArchive(record));
	const relocate = (file: string) =>
		file.startsWith(`${active}/`) ? `${actual}/${file.slice(active.length + 1)}` : file;
	const logical = (file: string) =>
		file.startsWith(`${actual}/`) ? `${active}/${file.slice(actual.length + 1)}` : file;
	const byPath = new Map<string, Omit<DevMaterialRef, "version">>();
	for (const ref of record.materials) {
		const file = relocate(ref.path);
		byPath.set(file, { id: ref.id, kind: ref.kind, path: file });
	}
	const business = `docs/business-requirements/${record.changeId}.md`;
	if (![...byPath.values()].some(ref => ref.kind === "business"))
		byPath.set(business, { id: "business", kind: "business", path: business });
	const proposal = `${actual}/proposal.md`;
	if (!byPath.has(proposal)) byPath.set(proposal, { id: "proposal", kind: "proposal", path: proposal });
	try {
		for (const file of await nativeSpecsBelow(cwd, `${actual}/specs`)) {
			const relative = `${actual}/specs/${file.replaceAll(path.sep, "/")}`;
			if (!byPath.has(relative))
				byPath.set(relative, { id: `delta:${file.replaceAll(path.sep, "/")}`, kind: "delta", path: relative });
		}
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	const generated: Array<{ kind: "solution" | "plan" | "report"; suffix: string }> = [
		{ kind: "solution", suffix: `-${record.changeId}-solutions.json` },
		{ kind: "plan", suffix: `-${record.changeId}.md` },
		{ kind: "report", suffix: `-${record.changeId}-completion.md` },
	];
	const missingKinds = generated.filter(item => ![...byPath.values()].some(ref => ref.kind === item.kind));
	if (missingKinds.length) {
		const directory = "docs/superpowers/plans";
		let entries: string[] = [];
		try {
			entries = await fs.readdir(await containedSpecPath(cwd, directory));
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		for (const item of missingKinds) {
			const matches = entries.filter(
				name => name.endsWith(item.suffix) && /^\d{4}-\d{2}-\d{2}$/.test(name.slice(0, -item.suffix.length)),
			);
			if (matches.length > 1) throw new Error(`Ambiguous owned ${item.kind} materials for ${record.changeId}`);
			if (!matches.length) continue;
			const file = `${directory}/${matches[0]}`;
			await assertSpecWritePath(cwd, file);
			byPath.set(file, { id: item.kind, kind: item.kind, path: file });
		}
	}
	const materials: DevMaterialRef[] = [];
	for (const ref of byPath.values()) {
		const file = logical(ref.path);
		const allowed =
			ref.kind === "business"
				? file === business
				: ref.kind === "proposal"
					? file === `${active}/proposal.md`
					: ref.kind === "delta"
						? file.startsWith(`${active}/specs/`) && isNativeSpec(file.slice(`${active}/specs/`.length))
						: file.startsWith("docs/superpowers/plans/") &&
							!file.slice("docs/superpowers/plans/".length).includes("/") &&
							file.endsWith(
								ref.kind === "solution"
									? `-${record.changeId}-solutions.json`
									: ref.kind === "report"
										? `-${record.changeId}-completion.md`
										: `-${record.changeId}.md`,
							);
		if (!allowed) throw new Error(`Material is outside its owned path: ${ref.path}`);
		try {
			const bytes = await fs.readFile(await containedSpecPath(cwd, ref.path));
			materials.push({ ...ref, version: artifactVersion(bytes) });
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
	}
	return materials;
}

export async function readDevMaterial(
	cwd: string,
	record: DevRequirementRecord,
	materialId: string,
): Promise<SpecDocument> {
	const ref = (await resolveDevMaterials(cwd, record)).find(material => material.id === materialId);
	if (!ref) throw new Error(`Unknown or missing requirement material: ${materialId}`);
	const bytes = await fs.readFile(await containedSpecPath(cwd, ref.path));
	return { path: ref.path, content: bytes.toString("utf8"), version: artifactVersion(bytes) };
}

export async function importDevBusiness(
	cwd: string,
	record: DevRequirementRecord,
	source: { kind: "upload"; name: string; bytes: Uint8Array } | { kind: "host-path"; path: string },
): Promise<SpecDocument> {
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(record.changeId)) throw new Error("Invalid change ID");
	const name = source.kind === "upload" ? source.name : source.path;
	if (!/\.md$/i.test(name) || /^[a-z][a-z0-9+.-]*:\/\//i.test(name))
		throw new Error("业务文档导入仅支持 Markdown 文件，不支持 URL");
	// External paths are read-only inputs, never passed to internal containment or cancellation.
	if (source.kind === "host-path" && !(await fs.stat(path.resolve(cwd, source.path))).isFile())
		throw new Error("业务文档导入源必须是普通文件");
	const bytes = source.kind === "upload" ? source.bytes : await fs.readFile(path.resolve(cwd, source.path));
	const file = `docs/business-requirements/${record.changeId}.md`;
	await assertSpecWritePath(cwd, file);
	const target = await containedSpecPath(cwd, file);
	await fs.mkdir(path.dirname(target), { recursive: true });
	await assertSpecWritePath(cwd, file);
	await fs.writeFile(target, bytes, { flag: "wx" });
	// Admission uses the one readBusiness template validator only when the person clicks Next.
	return {
		path: file,
		content: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8"),
		version: artifactVersion(bytes),
	};
}
