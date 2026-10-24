import * as crypto from "node:crypto";
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { writeFileAtomically } from "../utils/atomic-file";
import { ensureSpecDrivenResources, runOpenSpec } from "./resources";
import { parseSpecPlan } from "./schemas";
import type { SpecDrivenStatus, SpecPlanDraft, SpecSolutionDraft } from "./types";
import type { TeamRunResult } from "../team/types";

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
	runId?: string;
}
interface SpecRuntimeSnapshot {
	schemaVersion: 1;
	solution?: SpecSolutionDraft;
	plan?: SpecPlanDraft & { path: string; documentVersion: string };
	status?: Omit<SpecDrivenStatus, "solution" | "plan">;
	teamResult?: TeamRunResult;
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
type PublicationIdentity = Pick<Stats, "dev" | "ino" | "mtimeMs" | "ctimeMs" | "mode" | "size">;
interface PublicationFile {
	content: string;
	identity: PublicationIdentity;
}
function sameIdentity(a: PublicationIdentity, b: PublicationIdentity): boolean {
	return (
		a.dev === b.dev &&
		a.ino === b.ino &&
		a.mtimeMs === b.mtimeMs &&
		a.ctimeMs === b.ctimeMs &&
		a.mode === b.mode &&
		a.size === b.size
	);
}
async function publicationFile(target: string): Promise<PublicationFile | undefined> {
	const before = await fs.lstat(target).catch(error => {
		if (isEnoent(error)) return undefined;
		throw error;
	});
	if (!before) return undefined;
	if (!before.isFile()) throw new Error(`Publication target is not a regular file: ${target}`);
	const content = await fs.readFile(target, "utf8");
	const identity = await fs.lstat(target);
	if (!sameIdentity(before, identity)) throw new Error(`Publication target changed while reading: ${target}`);
	return { content, identity };
}
function samePublication(a: PublicationFile | undefined, b: PublicationFile | undefined): boolean {
	return a === undefined
		? b === undefined
		: b !== undefined && a.content === b.content && sameIdentity(a.identity, b.identity);
}
/** Best-effort ownership checks, not an atomic transaction against external processes. */
async function publish(
	root: string,
	changes: Map<string, string | undefined>,
	retireDirectory?: string,
	expected?: ReadonlyMap<string, string | undefined>,
	recheck?: (published: ReadonlySet<string>) => Promise<void>,
): Promise<void> {
	const originals = new Map<string, PublicationFile | undefined>();
	const targets = new Map<string, string>();
	for (const relative of changes.keys()) {
		const target = await containedSpecPath(root, relative);
		if (originals.has(target)) throw new Error(`Aliased write target: ${relative}`);
		const original = await publicationFile(target);
		if (expected && (!expected.has(relative) || expected.get(relative) !== original?.content))
			throw new Error(`Specification source changed before publication: ${relative}`);
		originals.set(target, original);
		targets.set(relative, target);
	}
	const retired: Array<{ path: string; identity: PublicationIdentity }> = [];
	async function retirementDirectories(directory: string): Promise<void> {
		const identity = await fs.lstat(directory);
		if (!identity.isDirectory() || identity.isSymbolicLink())
			throw new Error(`Linked retirement directory: ${directory}`);
		for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
			if (entry.isDirectory()) await retirementDirectories(path.join(directory, entry.name));
		}
		retired.push({ path: directory, identity });
	}
	if (retireDirectory) await retirementDirectories(await containedSpecPath(root, retireDirectory));
	const created: Array<{ path: string; identity: PublicationIdentity }> = [];
	const removed: typeof retired = [];
	const applied: Array<{
		relative: string;
		target: string;
		content: string | undefined;
		parentIdentity: PublicationIdentity;
		published?: PublicationFile;
		confirmed: boolean;
	}> = [];
	const published = new Set<string>();
	try {
		for (const [relative, content] of changes) {
			await recheck?.(published);
			const target = await containedSpecPath(root, relative);
			if (target !== targets.get(relative)) throw new Error(`Specification target mapping changed: ${relative}`);
			const missing: string[] = [];
			let directory = path.dirname(target);
			while (directory !== root) {
				try {
					const stat = await fs.lstat(directory);
					if (!stat.isDirectory() || stat.isSymbolicLink())
						throw new Error(`Unsafe publication directory: ${directory}`);
					break;
				} catch (error) {
					if (!isEnoent(error)) throw error;
					missing.unshift(directory);
					directory = path.dirname(directory);
				}
			}
			for (const name of missing) {
				await fs.mkdir(name);
				created.push({ path: name, identity: await fs.lstat(name) });
			}
			if (
				(await containedSpecPath(root, relative)) !== target ||
				!samePublication(originals.get(target), await publicationFile(target))
			)
				throw new Error(`Specification source ownership conflict before publication: ${relative}`);
			const attempt = {
				relative,
				target,
				content,
				parentIdentity: await fs.lstat(path.dirname(target)),
				published: undefined as PublicationFile | undefined,
				confirmed: false,
			};
			applied.push(attempt);
			if (content === undefined) await fs.unlink(target);
			else await writeFileAtomically(target, content, originals.get(target)?.identity.mode ?? 0o644);
			attempt.published = await publicationFile(target);
			attempt.confirmed = attempt.published?.content === content;
			if (!attempt.confirmed) throw new Error(`Publication ownership uncertain: ${relative}`);
			published.add(relative);
		}
		for (const directory of retired) {
			await recheck?.(published);
			const current = await fs.lstat(directory.path);
			// Removing our files changes directory timestamps; inode/device still bind its owner.
			if (
				!current.isDirectory() ||
				current.isSymbolicLink() ||
				current.ino !== directory.identity.ino ||
				current.dev !== directory.identity.dev
			)
				throw new Error(`Retirement directory ownership conflict: ${directory.path}`);
			await fs.rmdir(directory.path);
			removed.push(directory);
		}
	} catch (error) {
		const failures: unknown[] = [];
		let recovery: string | undefined;
		let recoverySaved = false;
		// Persist originals and intended bytes before any rollback can discard the only copy.
		try {
			const base = await containedSpecPath(root, ".omp/spec-recovery");
			await fs.mkdir(base, { recursive: true });
			await containedSpecPath(root, ".omp/spec-recovery");
			recovery = await fs.mkdtemp(path.join(base, "publication-"));
			await fs.writeFile(
				path.join(recovery, "publication.json"),
				JSON.stringify(
					{
						format: 1,
						error: String(error),
						files: [...changes].map(([relative, content]) => ({
							path: relative,
							original: originals.get(targets.get(relative)!) ?? null,
							attempted: content ?? null,
							publication: applied.find(item => item.target === targets.get(relative)) ?? null,
						})),
						createdDirectories: created,
						removedDirectories: removed,
					},
					null,
					2,
				),
				{ flag: "wx" },
			);
			recoverySaved = true;
		} catch (recoveryError) {
			failures.push(new Error("Publication recovery material could not be fully saved", { cause: recoveryError }));
		}
		// A failed journal must not strand deleted originals. Only exclusive-create
		// restores are safe without it; preserve surviving attempted/external bytes.
		{
			const restoredDirectories = new Map<string, PublicationIdentity>();
			for (const directory of [...removed].reverse()) {
				try {
					await fs.mkdir(directory.path, { mode: directory.identity.mode });
					restoredDirectories.set(directory.path, await fs.lstat(directory.path));
				} catch (rollbackError) {
					failures.push(
						new Error(`Rollback directory ownership conflict: ${directory.path}`, { cause: rollbackError }),
					);
				}
			}
			for (const attempt of [...applied].reverse()) {
				if (!recoverySaved && attempt.content !== undefined) continue;
				try {
					const relative = attempt.relative;
					const parent = path.dirname(attempt.target);
					const parentIdentity = restoredDirectories.get(parent) ?? attempt.parentIdentity;
					const currentParent = await fs.lstat(parent);
					if (
						!currentParent.isDirectory() ||
						currentParent.isSymbolicLink() ||
						currentParent.dev !== parentIdentity.dev ||
						currentParent.ino !== parentIdentity.ino ||
						currentParent.mode !== parentIdentity.mode
					)
						throw new Error(`Rollback directory ownership conflict; preserved target: ${relative}`);
					if (
						!attempt.confirmed ||
						(await containedSpecPath(root, relative)) !== attempt.target ||
						!samePublication(attempt.published, await publicationFile(attempt.target))
					)
						throw new Error(`Rollback ownership conflict; preserved current target: ${relative}`);
					const original = originals.get(attempt.target);
					if (original === undefined) await fs.unlink(attempt.target);
					else if (attempt.content === undefined) {
						// Exclusive creation cannot overwrite an external replacement of a removed file.
						await fs.writeFile(attempt.target, original.content, { flag: "wx", mode: original.identity.mode });
					} else await writeFileAtomically(attempt.target, original.content, original.identity.mode);
				} catch (rollbackError) {
					failures.push(rollbackError);
				}
			}
			for (const directory of recoverySaved ? [...created].reverse() : []) {
				try {
					const current = await fs.lstat(directory.path);
					if (
						!current.isDirectory() ||
						current.isSymbolicLink() ||
						current.ino !== directory.identity.ino ||
						current.dev !== directory.identity.dev
					)
						throw new Error(`Rollback directory ownership conflict: ${directory.path}`);
					await fs.rmdir(directory.path);
				} catch (rollbackError) {
					failures.push(rollbackError);
				}
			}
		}
		throw new AggregateError(
			[error, ...failures],
			`Specification publication partial failure: ${error instanceof Error ? error.message : String(error)}${failures.length ? "; ownership conflict or recovery/rollback failure" : "; owned changes rolled back"}. Recovery: ${recoverySaved ? recovery : "unavailable (recovery save failed)"}${!recoverySaved && recovery ? `; incomplete material: ${recovery}` : ""}`,
		);
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
	readonly statePath: string;
	readonly requirementsDir: string;
	readonly native: boolean;
	readonly #checks: Set<string>;
	#stateWrites: Promise<void> = Promise.resolve();
	constructor(options: SpecArtifactStoreOptions) {
		if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(options.changeId)) throw new Error("Invalid change ID");
		this.cwd = path.resolve(options.cwd);
		this.changeId = options.changeId;
		this.changeDir = options.changeDir ?? `openspec/changes/${options.changeId}`;
		this.planPath = `docs/superpowers/plans/${new Date().toISOString().slice(0, 10)}-${options.changeId}.md`;
		const runId = options.runId ?? crypto.randomUUID();
		if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error("Invalid specification run ID");
		this.statePath = `.omp/spec-sessions/${runId}/state.json`;
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
		changes.set(".omp/spec-sessions/.gitignore", "*\n");
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
		return {
			proposal,
			specs,
			checks,
			version: artifactVersion(JSON.stringify([proposal, ...specs, ...checks])),
		};
	}
	async writeSolution(solution: SpecSolutionDraft): Promise<ArtifactSnapshot> {
		await this.#updateState({ solution });
		return this.readSolution();
	}
	async readSolution(): Promise<ArtifactSnapshot> {
		const { solution } = await this.#readState();
		if (!solution) throw new Error("No selected Team candidate");
		return snapshot(`${this.statePath}#/solution`, JSON.stringify(solution));
	}
	async writePlan(draft: SpecPlanDraft): Promise<ArtifactSnapshot> {
		parseSpecPlan(draft);
		const coverage = new Map<string, string[]>();
		for (const task of draft.tasks) {
			for (const requirement of task.requirementIds) {
				const tasks = coverage.get(requirement) ?? [];
				tasks.push(task.id);
				coverage.set(requirement, tasks);
			}
		}
		const cell = (value: string): string => value.replaceAll("|", "\\|").replaceAll("\n", " ");
		const rows = [...coverage].map(([id, tasks]) => `| ${cell(id)} | ${tasks.map(cell).join(", ")} |`);
		const content = `${draft.content}\n\n## Requirement coverage\n\n| Requirement | Tasks |\n| --- | --- |\n${rows.join("\n")}\n`;
		await publish(this.cwd, new Map([[this.planPath, content]]));
		await this.#updateState({ plan: { ...draft, path: this.planPath, documentVersion: artifactVersion(content) } });
		return this.readPlan();
	}
	async readPlan(): Promise<ArtifactSnapshot> {
		const plan = await this.#read(this.planPath);
		const { plan: projection } = await this.#readState();
		if (!projection) throw new Error("No machine projection for the implementation plan");
		return { ...plan, version: artifactVersion(JSON.stringify([plan, projection])) };
	}
	/** Resolve the selected-candidate JSON pointer without hashing unrelated runtime status. */
	async readDocument(file: string): Promise<ArtifactSnapshot> {
		if (file === `${this.statePath}#/solution`) return this.readSolution();
		if (file === this.planPath) return this.readPlan();
		return this.#read(file);
	}
	async saveState(status: SpecDrivenStatus): Promise<void> {
		const { solution: _solution, plan: _plan, ...stage } = status;
		await this.#updateState({ status: stage });
	}
	async saveTeamResult(teamResult: TeamRunResult): Promise<void> {
		await this.#updateState({ teamResult });
	}
	async #readState(): Promise<SpecRuntimeSnapshot> {
		const content = await optionalRead(await containedSpecPath(this.cwd, this.statePath));
		return content === undefined ? { schemaVersion: 1 } : JSON.parse(content);
	}
	async #updateState(update: Partial<SpecRuntimeSnapshot>): Promise<void> {
		const operation = this.#stateWrites.then(async () => {
			const state = { ...(await this.#readState()), ...update };
			const file = await containedSpecPath(this.cwd, this.statePath);
			await fs.mkdir(path.dirname(file), { recursive: true });
			await writeFileAtomically(file, `${JSON.stringify(state, null, 2)}\n`);
		});
		this.#stateWrites = operation.catch(() => {});
		await operation;
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
		const expected = new Map<string, string | undefined>(
			[...changes.keys()].map(file => [file, sourceMap.files.find(source => source.path === file)?.content]),
		);
		await publish(this.cwd, changes, undefined, expected, () => this.#approve(approval));
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
			const expected = new Map<string, string | undefined>(
				[...changes.keys()].map(file => [
					file,
					markdown.sourceMap.files.find(source => source.path === file)?.content,
				]),
			);
			await publish(this.cwd, changes, undefined, expected, async () => {
				signal?.throwIfAborted();
				await this.#approve(approval);
				await this.#approve(markdown.approval);
			});
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
			// These are delivery snapshots, not additional editable authorities.
			const delivery = path.join(stagedRoot, "changes", this.changeId);
			await fs.writeFile(path.join(delivery, "plan.md"), plan.content, { flag: "wx" });
			await fs.mkdir(path.join(delivery, "checks"), { recursive: true });
			await fs.writeFile(
				path.join(delivery, "checks/orchestration.json"),
				await fs.readFile(await containedSpecPath(this.cwd, this.statePath), "utf8"),
				{ flag: "wx" },
			);
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
			const expected = new Map<string, string | undefined>();
			for (const name of new Set([...before, ...after])) {
				const canonical = name.replaceAll(path.sep, "/");
				if (!archive && !canonical.startsWith("specs/")) continue;
				if (!sync && canonical.startsWith("specs/")) continue;
				const updated = after.includes(name) ? await fs.readFile(path.join(stagedRoot, name), "utf8") : undefined;
				if (baseline.get(name)?.content !== updated) {
					changes.set(`openspec/${canonical}`, updated);
					expected.set(`openspec/${canonical}`, baseline.get(name)?.content);
				}
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
					expected.set(file, markdown.sourceMap.files.find(source => source.path === file)?.content);
				}
			}
			signal?.throwIfAborted();
			await publish(this.cwd, changes, archive ? this.changeDir : undefined, expected, async published => {
				signal?.throwIfAborted();
				if ((await this.readPlan()).version !== plan.version)
					throw new Error("Approved implementation plan changed during closure");
				// The accepted composite becomes unreadable once our archive starts retiring it.
				// Remaining targets still have their individual preflight ownership checks.
				if (![...published].some(file => file.startsWith(`${this.changeDir}/`))) await this.#approve(approval);
			});
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
