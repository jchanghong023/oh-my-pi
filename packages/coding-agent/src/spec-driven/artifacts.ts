import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { writeFileAtomically } from "../utils/atomic-file";
import { ensureSpecDrivenResources, runOpenSpec } from "./resources";

export interface ArtifactSnapshot {
	path: string;
	content: string;
	version: string;
}
export interface RequirementArtifacts {
	proposal: ArtifactSnapshot;
	specs: ArtifactSnapshot[];
	checks: ArtifactSnapshot[];
	version: string;
}
export interface SpecSourceEntry {
	id: string;
	path: string;
	headingPath: string[];
	original: string;
	version: string;
	start: number;
	end: number;
}
export interface SpecSourceMap {
	version: string;
	files: ArtifactSnapshot[];
	entries: SpecSourceEntry[];
}
export type SpecPatch =
	| { operation: "modify" | "remove"; sourceId: string; replacement: string }
	| { operation: "rename"; sourceId: string; replacement: string; destinationPath?: string }
	| { operation: "add"; path: string; content: string; afterSourceId?: string };
export interface SpecPatchApproval {
	accepted: true;
	authorized: true;
	requirementsVersion: string;
	sourceMapVersion: string;
	patchVersion: string;
	reviewer: string;
	reviewEvidence: string;
	coveredSourceIds: string[];
}
export interface SpecCloseApproval {
	accepted: true;
	authorized: true;
	requirementsVersion: string;
}
export interface SpecMarkdownSync {
	patches: readonly SpecPatch[];
	sourceMap: SpecSourceMap;
	approval: SpecPatchApproval;
}
export interface SpecArtifactStoreOptions {
	cwd: string;
	changeId: string;
	requirementsDir?: string;
	changeDir?: string;
	checkPaths?: readonly string[];
}
export function artifactVersion(content: string): string {
	return crypto.createHash("sha256").update(content).digest("hex");
}
export function specPatchVersion(patches: readonly SpecPatch[]): string {
	return artifactVersion(JSON.stringify(patches));
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
async function optionalRead(file: string): Promise<string | undefined> {
	try {
		return await fs.readFile(file, "utf8");
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
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
async function removeEmptyDirectories(root: string, removed: Array<{ path: string; mode: number }>): Promise<void> {
	for (const entry of await fs.readdir(root, { withFileTypes: true })) {
		if (entry.isDirectory() && !entry.isSymbolicLink())
			await removeEmptyDirectories(path.join(root, entry.name), removed);
	}
	const mode = (await fs.stat(root)).mode;
	try {
		await fs.rmdir(root);
		removed.push({ path: root, mode });
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOTEMPTY") throw error;
	}
}
/** Preflight the complete write set; failed publication restores already-published originals. */
async function publish(
	root: string,
	changes: Map<string, string | undefined>,
	retireDirectory?: string,
): Promise<void> {
	const originals = new Map<string, { content: string | undefined; mode: number }>();
	for (const relative of changes.keys()) {
		const target = await containedSpecPath(root, relative);
		if (originals.has(target)) throw new Error(`Aliased write target: ${relative}`);
		const content = await optionalRead(target);
		originals.set(target, { content, mode: content === undefined ? 0o644 : (await fs.stat(target)).mode });
	}
	const missingDirectories = new Set<string>();
	for (const relative of changes.keys()) {
		let directory = path.dirname(await containedSpecPath(root, relative));
		while (inside(root, directory) && directory !== root) {
			try {
				await fs.stat(directory);
				break;
			} catch (error) {
				if (!isEnoent(error)) throw error;
				missingDirectories.add(directory);
				directory = path.dirname(directory);
			}
		}
	}
	const applied: string[] = [];
	const removedDirectories: Array<{ path: string; mode: number }> = [];
	try {
		for (const [relative, content] of changes) {
			const target = await containedSpecPath(root, relative);
			await fs.mkdir(path.dirname(target), { recursive: true });
			await containedSpecPath(root, relative);
			applied.push(target);
			if (content === undefined) await fs.rm(target);
			else await writeFileAtomically(target, content, originals.get(target)!.mode);
		}
		if (retireDirectory)
			await removeEmptyDirectories(await containedSpecPath(root, retireDirectory), removedDirectories);
	} catch (error) {
		const failures: unknown[] = [];
		for (const directory of removedDirectories.reverse()) {
			try {
				await fs.mkdir(directory.path, { mode: directory.mode });
			} catch (rollbackError) {
				failures.push(rollbackError);
			}
		}
		for (const target of applied.reverse()) {
			const original = originals.get(target)!;
			try {
				if (original.content === undefined) await fs.rm(target, { force: true });
				else await writeFileAtomically(target, original.content, original.mode);
			} catch (rollbackError) {
				failures.push(rollbackError);
			}
		}
		for (const directory of [...missingDirectories].sort((a, b) => b.length - a.length)) {
			try {
				await fs.rmdir(directory);
			} catch (rollbackError) {
				if (!isEnoent(rollbackError)) failures.push(rollbackError);
			}
		}
		if (failures.length)
			throw new AggregateError([error, ...failures], "Specification publication and rollback failed");
		throw error;
	}
}
function snapshot(file: string, content: string): ArtifactSnapshot {
	return { path: file, content, version: artifactVersion(content) };
}

export class SpecArtifactStore {
	readonly cwd: string;
	readonly changeId: string;
	readonly changeDir: string;
	readonly planPath: string;
	readonly requirementsDir: string;
	readonly native: boolean;
	readonly #checks: Set<string>;
	constructor(options: SpecArtifactStoreOptions) {
		if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.changeId)) throw new Error("Invalid change ID");
		this.cwd = path.resolve(options.cwd);
		this.changeId = options.changeId;
		this.changeDir = options.changeDir ?? `openspec/changes/${options.changeId}`;
		this.planPath = `${this.changeDir}/plan.md`;
		this.requirementsDir = options.requirementsDir ?? "openspec/specs";
		this.native = options.requirementsDir === undefined || options.requirementsDir === "openspec/specs";
		this.#checks = new Set(options.checkPaths ?? []);
	}
	async initialize(): Promise<void> {
		const resources = await ensureSpecDrivenResources();
		const schemaRoot = path.dirname(resources.specSchemaPath);
		const changes = new Map<string, string>();
		for (const name of await filesBelow(schemaRoot)) {
			const target = `openspec/schemas/omp-spec/${name.replaceAll(path.sep, "/")}`;
			const content = await fs.readFile(path.join(schemaRoot, name), "utf8");
			const existing = await optionalRead(await containedSpecPath(this.cwd, target));
			if (existing !== undefined && existing !== content)
				throw new Error(`Pinned schema conflicts with existing project material: ${target}`);
			changes.set(target, content);
		}
		const metadata = `${this.changeDir}/.openspec.yaml`;
		const existing = await optionalRead(await containedSpecPath(this.cwd, metadata));
		if (existing !== undefined && existing !== "schema: omp-spec\n")
			throw new Error("Change metadata selects a different schema");
		changes.set(metadata, "schema: omp-spec\n");
		await publish(this.cwd, changes);
	}
	async writeRequirements(input: {
		proposal: string;
		specs: Array<{ path: string; content: string }>;
		checks?: Array<{ path: string; content: string }>;
	}): Promise<RequirementArtifacts> {
		const changes = new Map<string, string | undefined>();
		changes.set(`${this.changeDir}/proposal.md`, input.proposal);
		for (const spec of input.specs) {
			if (!/^specs\/[a-z0-9]+(?:-[a-z0-9]+)*\/spec\.md$/.test(spec.path))
				throw new Error(`Not a specification artifact: ${spec.path}`);
			const target = `${this.changeDir}/${spec.path}`;
			if (changes.has(target)) throw new Error(`Duplicate specification: ${spec.path}`);
			changes.set(target, spec.content);
		}
		for (const check of input.checks ?? []) {
			if (!this.#checks.has(check.path) || /(?:^|\/)(?:design|tasks|plan)\.md$/.test(check.path))
				throw new Error(`Unapproved check material: ${check.path}`);
			const target = `${this.changeDir}/${check.path}`;
			if (changes.has(target)) throw new Error(`Duplicate check material: ${check.path}`);
			changes.set(target, check.content);
		}
		const specsRoot = await containedSpecPath(this.cwd, `${this.changeDir}/specs`);
		let previous: string[] = [];
		try {
			previous = await filesBelow(specsRoot);
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		for (const name of previous) {
			const relative = `specs/${name.replaceAll(path.sep, "/")}`;
			const target = `${this.changeDir}/${relative}`;
			if (/^specs\/[a-z0-9]+(?:-[a-z0-9]+)*\/spec\.md$/.test(relative) && !changes.has(target))
				changes.set(target, undefined);
		}
		await publish(this.cwd, changes);
		return this.readRequirements();
	}
	async readRequirements(): Promise<RequirementArtifacts> {
		const proposal = await this.#read(`${this.changeDir}/proposal.md`);
		const specRoot = await containedSpecPath(this.cwd, `${this.changeDir}/specs`);
		let names: string[] = [];
		try {
			names = await filesBelow(specRoot);
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		const specs = await Promise.all(
			names
				.filter(name => name.endsWith("spec.md"))
				.map(name => this.#read(`${this.changeDir}/specs/${name.replaceAll(path.sep, "/")}`)),
		);
		const checks: ArtifactSnapshot[] = [];
		for (const name of [...this.#checks].sort()) {
			const file = `${this.changeDir}/${name}`;
			const content = await optionalRead(await containedSpecPath(this.cwd, file));
			if (content !== undefined) checks.push(snapshot(file, content));
		}
		return { proposal, specs, checks, version: artifactVersion(JSON.stringify([proposal, ...specs, ...checks])) };
	}
	async writePlan(content: string): Promise<ArtifactSnapshot> {
		await publish(this.cwd, new Map([[this.planPath, content]]));
		return this.readPlan();
	}
	async readPlan(): Promise<ArtifactSnapshot> {
		return this.#read(this.planPath);
	}
	async validateRequirements(signal?: AbortSignal): Promise<{ exitCode: number; stdout: string; stderr: string }> {
		return runOpenSpec(["validate", this.changeId, "--type", "change", "--strict", "--json"], this.cwd, signal);
	}
	async prepareSourceMap(paths?: readonly string[]): Promise<SpecSourceMap> {
		const root = await containedSpecPath(this.cwd, this.requirementsDir);
		const names = paths
			? [...paths].sort()
			: (await filesBelow(root))
					.filter(name => name.endsWith(".md"))
					.map(name => `${this.requirementsDir}/${name.replaceAll(path.sep, "/")}`);
		const files: ArtifactSnapshot[] = [];
		const entries: SpecSourceEntry[] = [];
		const identities = new Set<string>();
		for (const name of names) {
			const absolute = await containedSpecPath(this.cwd, name);
			if (!inside(root, absolute) || identities.has(absolute)) throw new Error(`Invalid or aliased source: ${name}`);
			identities.add(absolute);
			const file = await this.#read(name);
			files.push(file);
			const headings: Array<{ start: number; level: number; title: string; parents: string[] }> = [];
			const stack: Array<{ level: number; title: string }> = [];
			let offset = 0;
			let fenced = false;
			for (const line of file.content.split(/(?<=\n)/)) {
				if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
				const match = !fenced && /^(#{1,6})\s+(.+?)(?:\s+#+)?\r?\n?$/.exec(line);
				if (match) {
					const level = match[1]!.length;
					while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
					const title = match[2]!;
					stack.push({ level, title });
					headings.push({ start: offset, level, title, parents: stack.map(item => item.title) });
				}
				offset += line.length;
			}
			const keys = new Set<string>();
			for (let index = 0; index < headings.length; index++) {
				const heading = headings[index]!;
				const key = JSON.stringify(heading.parents);
				if (keys.has(key)) throw new Error(`Ambiguous heading in ${name}: ${key}`);
				keys.add(key);
				const end =
					headings.slice(index + 1).find(item => item.level <= heading.level)?.start ?? file.content.length;
				const original = file.content.slice(heading.start, end);
				const stable = /(?:^|\s)([A-Z][A-Z0-9]*-\d+|AC-\d+)(?:\b)/.exec(heading.title)?.[1];
				entries.push({
					id: `${name}#${stable ?? artifactVersion(key).slice(0, 16)}`,
					path: name,
					headingPath: heading.parents,
					start: heading.start,
					end,
					original,
					version: artifactVersion(original),
				});
			}
		}
		if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error("Ambiguous source IDs");
		return { files, entries, version: artifactVersion(JSON.stringify({ files, entries })) };
	}
	async applySpecChanges(
		patches: readonly SpecPatch[],
		sourceMap: SpecSourceMap,
		approval: SpecPatchApproval,
	): Promise<ArtifactSnapshot[]> {
		const changes = await this.#prepareSpecChanges(patches, sourceMap, approval);
		await publish(this.cwd, changes);
		return [...changes]
			.filter((item): item is [string, string] => item[1] !== undefined)
			.map(([file, content]) => snapshot(file, content));
	}
	async #prepareSpecChanges(
		patches: readonly SpecPatch[],
		sourceMap: SpecSourceMap,
		approval: SpecPatchApproval,
	): Promise<Map<string, string | undefined>> {
		await this.#approve(approval);
		if (this.native) throw new Error("Native specifications require OpenSpec archive/sync semantics");
		if (
			approval.sourceMapVersion !== sourceMap.version ||
			approval.patchVersion !== specPatchVersion(patches) ||
			!approval.reviewer ||
			!approval.reviewEvidence
		)
			throw new Error("Patch review is missing or stale");
		const fresh = await this.prepareSourceMap(sourceMap.files.map(file => file.path));
		if (
			fresh.version !== sourceMap.version ||
			artifactVersion(JSON.stringify({ files: sourceMap.files, entries: sourceMap.entries })) !== sourceMap.version
		)
			throw new Error("Specification sources changed since review");
		const changes = new Map<string, string | undefined>();
		const edits = new Map<string, Array<{ start: number; end: number; text: string }>>();
		const used = new Set<string>();
		for (const patch of patches) {
			if (patch.operation === "add" && !patch.afterSourceId) {
				const target = await containedSpecPath(this.cwd, patch.path);
				const authority = await containedSpecPath(this.cwd, this.requirementsDir);
				if (
					!inside(authority, target) ||
					(await optionalRead(target)) !== undefined ||
					changes.has(patch.path) ||
					!patch.content
				)
					throw new Error(`Ambiguous new specification: ${patch.path}`);
				changes.set(patch.path, patch.content);
				continue;
			}
			const id = patch.operation === "add" ? patch.afterSourceId! : patch.sourceId;
			const entry = sourceMap.entries.find(item => item.id === id);
			if (!entry || used.has(id) || !approval.coveredSourceIds.includes(id))
				throw new Error(`Incomplete or duplicate reviewed source: ${id}`);
			used.add(id);
			if (patch.operation === "rename" && patch.destinationPath) {
				const file = sourceMap.files.find(item => item.path === entry.path)!;
				if (entry.start !== 0 || entry.end !== file.content.length || changes.has(entry.path))
					throw new Error("File rename must map the entire original document");
				const destination = await containedSpecPath(this.cwd, patch.destinationPath);
				if (
					!inside(await containedSpecPath(this.cwd, this.requirementsDir), destination) ||
					(await optionalRead(destination)) !== undefined ||
					changes.has(patch.destinationPath)
				)
					throw new Error("Rename destination exists or escapes authority");
				changes.set(entry.path, undefined);
				changes.set(patch.destinationPath, patch.replacement);
				continue;
			}
			if (patch.operation === "add" && patch.path !== entry.path)
				throw new Error("Insertion target differs from anchor");
			if (patch.operation === "remove" && patch.replacement !== "")
				throw new Error("Removal must not contain replacement text");
			const list = edits.get(entry.path) ?? [];
			list.push({
				start: patch.operation === "add" ? entry.end : entry.start,
				end: entry.end,
				text: patch.operation === "add" ? patch.content : patch.replacement,
			});
			edits.set(entry.path, list);
		}
		for (const [file, list] of edits) {
			if (changes.has(file)) throw new Error("Overlapping document operations");
			list.sort((a, b) => b.start - a.start);
			let content = sourceMap.files.find(item => item.path === file)!.content;
			let boundary = content.length + 1;
			for (const edit of list) {
				if (edit.end > boundary) throw new Error("Overlapping source sections");
				content = content.slice(0, edit.start) + edit.text + content.slice(edit.end);
				boundary = edit.start;
			}
			changes.set(file, content === "" ? undefined : content);
		}
		return changes;
	}
	/** Synchronize only the approved authority; retain the source change and its unique plan. */
	async sync(approval: SpecCloseApproval, signal?: AbortSignal, markdown?: SpecMarkdownSync): Promise<void> {
		if (!this.native) {
			await this.#approve(approval);
			await this.readPlan();
			if (!markdown) throw new Error("Markdown synchronization requires reviewed exact patches");
			const changes = await this.#prepareSpecChanges(markdown.patches, markdown.sourceMap, markdown.approval);
			signal?.throwIfAborted();
			await publish(this.cwd, changes);
			return;
		}
		await this.#close(approval, false, true, signal, markdown);
	}
	/** The default retains the original combined sync/archive behavior. */
	async archive(
		approval: SpecCloseApproval,
		signal?: AbortSignal,
		markdown?: SpecMarkdownSync,
		options?: { sync?: boolean },
	): Promise<{ archivePath: string; stdout: string }> {
		return this.#close(approval, true, options?.sync !== false, signal, markdown);
	}
	async #close(
		approval: SpecCloseApproval,
		archive: boolean,
		sync: boolean,
		signal?: AbortSignal,
		markdown?: SpecMarkdownSync,
	): Promise<{ archivePath: string; stdout: string }> {
		await this.#approve(approval);
		const plan = await this.readPlan();
		if (this.native && markdown) throw new Error("Native specifications cannot use Markdown patch synchronization");
		if (!sync && markdown) throw new Error("Archive-only cannot authorize Markdown synchronization");
		if (markdown) await this.#prepareSpecChanges(markdown.patches, markdown.sourceMap, markdown.approval);
		if (this.changeDir !== `openspec/changes/${this.changeId}`)
			throw new Error("Native archive requires the default change directory");
		const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "omp-spec-close-"));
		try {
			// Reject the root link too: containedSpecPath deliberately resolves links for read mapping.
			const lexicalRoot = path.join(this.cwd, "openspec");
			if ((await fs.lstat(lexicalRoot)).isSymbolicLink())
				throw new Error("Linked specification tree cannot be synchronized");
			const openspec = await containedSpecPath(this.cwd, "openspec");
			const before = await filesBelow(openspec);
			const baseline = new Map(
				await Promise.all(
					before.map(async name => {
						const file = path.join(openspec, name);
						const stat = await fs.stat(file);
						return [
							name,
							{ content: await fs.readFile(file, "utf8"), ino: stat.ino, dev: stat.dev, mtimeMs: stat.mtimeMs },
						] as const;
					}),
				),
			);
			await fs.cp(openspec, path.join(sandbox, "openspec"), { recursive: true });
			const stagedRoot = path.join(sandbox, "openspec");
			for (const [name, original] of baseline) {
				if ((await optionalRead(path.join(stagedRoot, name))) !== original.content)
					throw new Error(`Archive copy changed: ${name}`);
			}
			// OpenSpec has no standalone sync CLI. Its real archive performs the pinned merge
			// and validation in isolation; sync-only publishes ONLY the resulting master delta.
			const result = await runOpenSpec(
				["archive", this.changeId, "--yes", "--json", ...(!sync || !this.native ? ["--skip-specs"] : [])],
				sandbox,
				signal,
			);
			if (result.exitCode !== 0)
				throw new Error(`OpenSpec archive failed (${result.exitCode}): ${result.stderr}\n${result.stdout}`);
			signal?.throwIfAborted();
			const after = await filesBelow(stagedRoot);
			const archivePlan = after.find(
				name =>
					name.replaceAll(path.sep, "/").startsWith("changes/archive/") &&
					name.endsWith(`${this.changeId}${path.sep}plan.md`) &&
					!baseline.has(name),
			);
			if (!archivePlan || (await fs.readFile(path.join(stagedRoot, archivePlan), "utf8")) !== plan.content)
				throw new Error("OpenSpec archive did not retain the approved unique plan");
			if (JSON.stringify(await filesBelow(openspec)) !== JSON.stringify(before))
				throw new Error("Archive source file set changed");
			for (const [name, original] of baseline) {
				const file = await containedSpecPath(this.cwd, `openspec/${name}`);
				const stat = await fs.stat(file);
				if (
					stat.ino !== original.ino ||
					stat.dev !== original.dev ||
					stat.mtimeMs !== original.mtimeMs ||
					(await optionalRead(file)) !== original.content
				)
					throw new Error(`Archive source changed: ${name}`);
			}
			await this.#approve(approval);
			const changes = new Map<string, string | undefined>();
			for (const name of new Set([...before, ...after])) {
				const canonical = name.replaceAll(path.sep, "/");
				if (!archive && !canonical.startsWith("specs/")) continue;
				if (!sync && canonical.startsWith("specs/")) continue;
				const updated = after.includes(name) ? await fs.readFile(path.join(stagedRoot, name), "utf8") : undefined;
				if (baseline.get(name)?.content !== updated) changes.set(`openspec/${canonical}`, updated);
			}
			if (markdown) {
				const sourceChanges = await this.#prepareSpecChanges(
					markdown.patches,
					markdown.sourceMap,
					markdown.approval,
				);
				for (const [file, content] of sourceChanges) {
					if (changes.has(file)) throw new Error("Markdown authority overlaps native archive writes");
					changes.set(file, content);
				}
			}
			signal?.throwIfAborted();
			await publish(this.cwd, changes, archive ? this.changeDir : undefined);
			return {
				archivePath: `openspec/${path.dirname(archivePlan).replaceAll(path.sep, "/")}`,
				stdout: result.stdout,
			};
		} finally {
			await fs.rm(sandbox, { recursive: true, force: true });
		}
	}
	async #read(file: string): Promise<ArtifactSnapshot> {
		return snapshot(file, await fs.readFile(await containedSpecPath(this.cwd, file), "utf8"));
	}
	async #approve(approval: SpecCloseApproval): Promise<void> {
		if (
			approval.accepted !== true ||
			approval.authorized !== true ||
			approval.requirementsVersion !== (await this.readRequirements()).version
		)
			throw new Error("Final acceptance/close authorization is missing or stale");
	}
}
