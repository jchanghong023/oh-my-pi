import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { artifactVersion, containedSpecPath } from "./artifacts";
import { recordSpecCommand } from "./execution-tools";
import type {
	SpecDrivenStatus,
	SpecEvidenceBinding,
	SpecEvidenceInputs,
	SpecInputIdentity,
	SpecRunContext,
	SpecToolRecord,
} from "./types";

function below(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

/** Per actual actor/workspace ownership; not a result cache or a model-writable ledger. */
export class SpecEvidenceService {
	readonly #cwd: string;
	#changeDir: string;
	readonly #owner: Readonly<SpecEvidenceBinding>;
	readonly #run: Readonly<{ runId: string; generation: number }>;
	readonly #captures = new Map<string, SpecInputIdentity>();
	readonly #baselines = new Map<string, SpecInputIdentity>();
	readonly #records = new Map<string, SpecToolRecord>();
	#actualWorkspace: string | undefined;

	constructor(options: {
		cwd: string;
		changeDir: string;
		owner: SpecEvidenceBinding;
		run: { runId: string; generation: number };
	}) {
		if (!path.isAbsolute(options.cwd) || !path.isAbsolute(options.changeDir))
			throw new Error("Evidence cwd and changeDir must be absolute");
		if (path.resolve(options.owner.workspace) !== path.resolve(options.cwd))
			throw new Error("Evidence owner must identify the actual workspace");
		if (
			!path.isAbsolute(options.owner.workspace) ||
			!options.owner.actorId.trim() ||
			!options.owner.specificationVersion.trim() ||
			!options.owner.planVersion.trim() ||
			!options.run.runId.trim() ||
			!Number.isSafeInteger(options.run.generation) ||
			options.run.generation < 0
		)
			throw new Error("Evidence requires actual actor, approved versions, and run ownership");
		this.#cwd = path.resolve(options.cwd);
		this.#changeDir = path.resolve(options.changeDir);
		this.#owner = Object.freeze({ ...options.owner });
		this.#run = Object.freeze({ ...options.run });
	}

	#assertContext(context: SpecRunContext, admission = false): void {
		if (
			context.runId !== this.#run.runId ||
			!Number.isSafeInteger(context.generation) ||
			(admission ? context.generation !== this.#run.generation : context.generation < this.#run.generation)
		)
			throw new Error("Evidence belongs to a different run or inadmissible generation");
	}

	async #outputs(): Promise<{ changeDir: string; checks: string }> {
		// The trusted change directory may be outside a native isolated workspace.
		await fs.mkdir(this.#changeDir, { recursive: true });
		const changeDir = await fs.realpath(this.#changeDir);
		this.#changeDir = changeDir;
		const checks = await containedSpecPath(changeDir, "checks");
		await fs.mkdir(checks, { recursive: true });
		return { changeDir, checks };
	}

	async #snapshot(inputs: SpecEvidenceInputs, context: SpecRunContext): Promise<SpecInputIdentity> {
		this.#assertContext(context);
		if (!inputs.validationId.trim() || !inputs.inputPaths.length)
			throw new Error("Evidence requires an obligation and nonempty input selectors");
		const cwd = await fs.realpath(this.#cwd);
		this.#actualWorkspace = cwd;
		// Establish excluded outputs before observing parent directory membership.
		const { changeDir, checks } = await this.#outputs();
		const report = path.join(changeDir, "verification.md");
		const entries: SpecInputIdentity["entries"] = [];
		const selected = [...new Set(inputs.inputPaths.map(value => value.replaceAll("\\", "/")))].sort();
		const visited = new Set<string>();
		const active = new Set<string>();
		const excluded = (absolute: string) => below(checks, absolute) || absolute === report;
		const visit = async (relative: string, explicit = false): Promise<void> => {
			const absolute = await containedSpecPath(cwd, relative);
			if (excluded(absolute)) {
				// 显式批准的输入不能因输出排除而悄悄缩减；只有父目录遍历可跳过生成物。
				if (explicit) throw new Error(`Generated evidence output cannot be explicitly selected: ${relative}`);
				return;
			}
			if (visited.has(relative)) return;
			visited.add(relative);
			let stat;
			try {
				stat = await fs.stat(absolute);
			} catch (error) {
				if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
				entries.push({ path: relative, canonicalPath: absolute, kind: "missing" });
				return;
			}
			if (stat.isFile()) {
				const bytes = await fs.readFile(absolute);
				entries.push({
					path: relative,
					canonicalPath: absolute,
					kind: "file",
					digest: createHash("sha256").update(bytes).digest("hex"),
				});
			} else if (stat.isDirectory()) {
				if (active.has(absolute)) throw new Error(`Cyclic evidence input: ${relative}`);
				active.add(absolute);
				const members: string[] = [];
				for (const name of (await fs.readdir(absolute)).sort()) {
					const child = path.posix.join(relative, name);
					if (!excluded(await containedSpecPath(cwd, child))) members.push(name);
				}
				entries.push({ path: relative, canonicalPath: absolute, kind: "directory", members });
				for (const name of members) await visit(path.posix.join(relative, name));
				active.delete(absolute);
			} else {
				throw new Error(`Unsupported evidence input: ${relative}`);
			}
		};
		for (const relative of selected) await visit(relative, true);
		entries.sort((left, right) => left.path.localeCompare(right.path));
		const identity: SpecInputIdentity = {
			id: `inputs-${crypto.randomUUID()}`,
			runId: context.runId,
			generation: context.generation,
			binding: { ...this.#owner, workspace: cwd },
			inputPaths: selected,
			entries,
			version: artifactVersion(JSON.stringify(entries)),
			complete: entries.length > 0 && entries.every(entry => entry.kind !== "missing"),
		};
		this.#captures.set(identity.id, structuredClone(identity));
		return identity;
	}

	async capture(inputs: SpecEvidenceInputs, context: SpecRunContext): Promise<SpecInputIdentity> {
		this.#assertContext(context, true);
		context.signal.throwIfAborted();
		const identity = await this.#snapshot(inputs, context);
		this.#baselines.set(inputs.validationId, structuredClone(identity));
		return identity;
	}

	async revalidate(context: SpecRunContext): Promise<{ taskIds: string[]; reasons: string[]; overall: boolean }> {
		this.#assertContext(context);
		const reasons: string[] = [];
		for (const [validationId, before] of this.#baselines) {
			try {
				const after = await this.#snapshot({ validationId, inputPaths: before.inputPaths }, context);
				if (!before.complete || !after.complete || before.version !== after.version)
					reasons.push(`${validationId}: selected input content or membership changed, or inputs are missing`);
			} catch (error) {
				reasons.push(
					`${validationId}: inputs could not be revalidated (${error instanceof Error ? error.message : String(error)})`,
				);
			}
		}
		return {
			taskIds: reasons.length && this.#owner.taskId !== null ? [this.#owner.taskId] : [],
			reasons,
			overall: reasons.length > 0 && this.#owner.taskId === null,
		};
	}

	/** Runs the real native command; there is deliberately no insert-success API. */
	async recordCommand(
		input: {
			command: string;
			toolCallId: string;
			inputPaths: readonly string[];
			obligation: NonNullable<SpecToolRecord["obligation"]>;
		},
		context: SpecRunContext,
	): Promise<SpecToolRecord> {
		this.#assertContext(context, true);
		const inputs = { inputPaths: input.inputPaths, validationId: input.obligation.validationId };
		let before = true;
		const cwd = await fs.realpath(this.#cwd);
		this.#actualWorkspace = cwd;
		const { checks } = await this.#outputs();
		const record = await recordSpecCommand({
			cwd,
			command: input.command,
			toolCallId: input.toolCallId,
			artifactDir: checks,
			context,
			obligation: input.obligation,
			evidence: {
				binding: { ...this.#owner, workspace: cwd },
				capture: async () => {
					if (before) {
						before = false;
						return this.capture(inputs, context);
					}
					return this.#snapshot(inputs, context);
				},
			},
		});
		this.#records.set(record.id, structuredClone(record));
		return record;
	}

	async read(ids: readonly string[], context: SpecRunContext): Promise<SpecToolRecord[]> {
		this.#assertContext(context);
		const result: SpecToolRecord[] = [];
		for (const id of ids) {
			const record = this.#records.get(id);
			if (!record) throw new Error(`Unknown runner evidence: ${id}`);
			const { checks } = await this.#outputs();
			const relative = path.relative(checks, record.artifact.path);
			if ((await containedSpecPath(checks, relative)) !== record.artifact.path)
				throw new Error(`Raw evidence is outside its owner's checks directory: ${id}`);
			const content = await fs.readFile(record.artifact.path, "utf8");
			if (artifactVersion(content) !== record.artifact.version) throw new Error(`Raw evidence changed: ${id}`);
			const { artifact: _artifact, ...raw } = record;
			if (content !== JSON.stringify(raw)) throw new Error(`Raw evidence does not match its observation: ${id}`);
			result.push(structuredClone(record));
		}
		return result;
	}

	/** Host-only relocation after the actual archive operation; observations remain unchanged. */
	async relocateOutputs(archiveDir: string, context: SpecRunContext): Promise<void> {
		this.#assertContext(context);
		if (!path.isAbsolute(archiveDir)) throw new Error("Archived evidence directory must be absolute");
		const archive = await fs.realpath(archiveDir);
		if (!(await fs.stat(archive)).isDirectory()) throw new Error("Archived evidence target must be a directory");
		const checks = await containedSpecPath(archive, "checks");
		if (!(await fs.stat(checks)).isDirectory()) throw new Error("Archived evidence checks must be a directory");
		const relocated = new Map<string, string>();
		for (const record of this.#records.values()) {
			const relative = path.relative(path.join(this.#changeDir, "checks"), record.artifact.path);
			if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`))
				throw new Error(`Original evidence locator is outside its checks directory: ${record.id}`);
			const target = await containedSpecPath(checks, relative);
			const content = await fs.readFile(target, "utf8");
			const { artifact: _artifact, ...raw } = record;
			if (artifactVersion(content) !== record.artifact.version || content !== JSON.stringify(raw))
				throw new Error(`Archived raw evidence changed: ${record.id}`);
			relocated.set(record.id, target);
		}
		// Verify the complete destination before changing any locator; never recreate the retired source tree.
		this.#changeDir = archive;
		for (const [id, target] of relocated) this.#records.get(id)!.artifact.path = target;
	}

	/** A detached projection only; callers cannot add observations to this service. */
	async exportSnapshot(context: SpecRunContext) {
		this.#assertContext(context);
		const { changeDir } = await this.#outputs();
		const owner = { ...this.#owner, workspace: this.#actualWorkspace ?? this.#cwd };
		const records = await this.read([...this.#records.keys()], context);
		const captures = [...this.#captures.values()];
		const assertOwnership = (value: { runId: string; generation: number; binding: SpecEvidenceBinding | null }) => {
			if (
				value.runId !== this.#run.runId ||
				!Number.isSafeInteger(value.generation) ||
				value.generation < this.#run.generation ||
				value.generation > context.generation ||
				!value.binding ||
				JSON.stringify(value.binding) !== JSON.stringify(owner)
			)
				throw new Error("Evidence observation has inconsistent run or owner");
		};
		for (const capture of captures) assertOwnership(capture);
		for (const record of records) {
			assertOwnership(record);
			if (record.generation !== this.#run.generation || record.args.cwd !== owner.workspace)
				throw new Error(`Command observation has inconsistent generation or cwd: ${record.id}`);
			for (const identity of [record.inputsBefore, record.inputsAfter]) {
				if (identity) {
					assertOwnership(identity);
					if (!this.#captures.has(identity.id)) throw new Error(`Unknown command input identity: ${identity.id}`);
				}
			}
		}
		return { changeDir, run: { ...this.#run }, owner, captures: structuredClone(captures), records };
	}

	async flush(status: SpecDrivenStatus, context: SpecRunContext): Promise<void> {
		await aggregateSpecEvidence([this], status, context);
	}
}

/** Publishes one projection of all actual owners, only after originals have been saved and checked. */
export async function aggregateSpecEvidence(
	services: readonly SpecEvidenceService[],
	status: SpecDrivenStatus,
	context: SpecRunContext,
): Promise<void> {
	if (!services.length) throw new Error("Evidence aggregation requires an actual owner");
	if (status.generation !== context.generation) throw new Error("Evidence status belongs to a different generation");
	const snapshots = [];
	for (const service of new Set(services)) snapshots.push(await service.exportSnapshot(context));
	const changeDir = snapshots[0].changeDir;
	if (snapshots.some(snapshot => snapshot.changeDir !== changeDir || snapshot.run.runId !== context.runId))
		throw new Error("Evidence aggregation requires the same actual run and target change directory");
	const checks = await containedSpecPath(changeDir, "checks");
	const records = snapshots.flatMap(snapshot => snapshot.records);
	const observations = new Map<string, SpecToolRecord>();
	for (const record of records) {
		if (observations.has(record.id)) throw new Error(`Duplicate evidence observation: ${record.id}`);
		observations.set(record.id, record);
	}
	for (const task of status.tasks) {
		for (const record of task.records) {
			const observed = observations.get(record.id);
			if (!observed || !isDeepStrictEqual(observed, record) || record.binding?.taskId !== task.id)
				throw new Error(`Task status contains unverified or differently owned evidence: ${task.id}/${record.id}`);
		}
	}
	const reviewPaths: string[] = [];
	for (const review of status.reviewArtifacts ?? []) {
		const target = await containedSpecPath(changeDir, review.path);
		if (!below(checks, target) || target === checks)
			throw new Error(`Reviewer original is outside checks: ${review.slotId}`);
		const content = await fs.readFile(target, "utf8");
		if (artifactVersion(content) !== review.version) throw new Error(`Reviewer original changed: ${review.slotId}`);
		reviewPaths.push(target);
	}
	const reviews = {
		stages: status.reviews,
		tasks: status.tasks.map(task => ({ taskId: task.id, review: task.review, repairReview: task.repairReview })),
		artifacts: status.reviewArtifacts ?? null,
	};
	const commits = status.tasks.map(task => ({ taskId: task.id, ranges: task.commits }));
	const rawName = `evidence-${crypto.randomUUID()}.json`;
	const rawPath = await containedSpecPath(checks, rawName);
	const raw = JSON.stringify(
		{ run: { runId: context.runId, generation: context.generation }, snapshots, status, reviews, commits },
		null,
		2,
	);
	try {
		await fs.writeFile(rawPath, raw, { flag: "wx" });
		if ((await fs.readFile(rawPath, "utf8")) !== raw) throw new Error("Saved aggregate bytes differ from originals");
	} catch (error) {
		throw new Error("Evidence originals could not be saved or verified; previous verification report retained", {
			cause: error,
		});
	}
	const link = (target: string) => path.relative(changeDir, target).split(path.sep).map(encodeURIComponent).join("/");
	// JSON projection preserves supplied facts without turning missing approvals or reviews into success.
	const section = (title: string, value: unknown): string[] => {
		const json = JSON.stringify(value, null, 2);
		const fence = "`".repeat(Math.max(3, ...[...json.matchAll(/`+/g)].map(match => match[0].length + 1)));
		return [`## ${title}`, "", `${fence}json`, json, fence, ""];
	};
	const lines = [
		"# Verification",
		"",
		`Observed phase: ${status.phase}; paused: ${status.paused}.`,
		`Run: ${context.runId}; generation: ${context.generation}.`,
		`[Combined raw observations, status, reviews and commits](${link(rawPath)})`,
		"",
		...section(
			"Owners and source generations",
			snapshots.map(snapshot => ({ run: snapshot.run, owner: snapshot.owner })),
		),
		"## Actual commands",
		"",
	];
	for (const record of records) {
		const stable =
			record.inputsBefore?.complete &&
			record.inputsAfter?.complete &&
			record.inputsBefore.version === record.inputsAfter.version;
		lines.push(
			`- [${record.id}](${link(record.artifact.path)}): ${record.result.status}; exit ${record.result.exitCode ?? "unknown"}; inputs ${stable ? "unchanged at command observation" : "unqualified"}.`,
			...section(`Command ${record.id}`, {
				owner: record.binding,
				runId: record.runId,
				generation: record.generation,
				toolCallId: record.toolCallId,
				args: record.args,
				obligation: record.obligation,
				startedAt: record.startedAt,
				finishedAt: record.finishedAt,
				conditions: record.conditions,
				result: { status: record.result.status, exitCode: record.result.exitCode, isError: record.result.isError },
			}),
		);
	}
	lines.push(
		...section("Task and requirement mappings", {
			requirements: status.specification?.requirements ?? null,
			planVersion: status.plan?.version ?? null,
			tasks:
				status.plan?.tasks.map(task => ({
					id: task.id,
					title: task.title,
					requirementIds: task.requirementIds,
					dependencies: task.dependencies,
					conditionIds: task.conditionIds,
					validation: task.validation,
				})) ?? null,
			finalValidation: status.plan?.finalValidation ?? null,
		}),
		...section(
			"Current task status",
			status.tasks.map(task => ({
				id: task.id,
				status: task.status,
				specificationVersion: task.specificationVersion,
				planVersion: task.planVersion,
				execution: task.execution,
				validatedIds: task.validatedIds,
				recordIds: task.records.map(record => record.id),
				committedExecutionIds: task.committedExecutionIds,
			})),
		),
		...section("Review findings and resolutions", reviews),
		...section("Raw reviewer observations", status.reviewArtifacts ?? null),
		...reviewPaths.map((target, index) => `- [Reviewer original ${index + 1}](${link(target)})`),
		"",
		...section("Source and target commit ranges", commits),
		...section("Source and target observations", status.executionEvidence ?? null),
		...section("Git baseline and current observations", status.gitEvidence ?? null),
		...section("Acceptance and closure facts", {
			phase: status.phase,
			paused: status.paused,
			blockedReason: status.blockedReason ?? null,
			specificationApproval: status.specificationApproval ?? null,
			planApproval: status.planApproval ?? null,
			acceptanceVersion: status.acceptanceVersion ?? null,
			finalApproval: status.finalApproval ?? null,
			pendingClosure: status.pendingClosure,
			plannedClosure: status.plan?.closure ?? null,
			questions: status.questions,
		}),
		"## Evidence boundaries",
		"",
		"Commands and raw output are observations, not independent review or acceptance. Unchanged inputs describe the command observation, not a new current-content qualification. Current task, review, commit, acceptance and closure facts above are supplied trusted status, not inferred success. Missing facts remain unknown. Shell/runtime paths and host runtime version are recorded; child tool versions, inherited environment semantics and undisclosed dependencies are unknown. Missing or changing selected inputs cannot qualify current content. Historical raw records are retained after invalidation. No real-model quality or external-environment claim is made.",
		"",
	);
	const report = await containedSpecPath(changeDir, "verification.md");
	const temporary = await containedSpecPath(checks, `report-${crypto.randomUUID()}.tmp`);
	await fs.writeFile(temporary, lines.join("\n"), { flag: "wx" });
	await fs.rename(temporary, report);
}
