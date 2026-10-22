import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { availableParallelism } from "node:os";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type * as Wire from "../schema/vendor/zcode-protocol/index.js";
import type { WorkflowLaunchMeta } from "../schema/vendor/zcode-protocol-v4/workflow-row-meta.js";
import {
	readWorkflowArtifactField,
	WORKFLOW_ARTIFACT_LIMITS,
} from "../schema/vendor/zcode-protocol-v4/workflow-artifacts.js";
import type { AmendWorkflowRunSettingsPayload } from "../schema/vendor/zcode-protocol-v4/workflow-run-settings-command.js";
import {
	WORKFLOW_WORKSPACE_LIMITS,
	type V4ConversationWorkflowRunWorkspaceParams,
	type V4ConversationWorkflowRunWorkspaceResult,
	type V4ConversationWorkflowRunNodeResultParams,
	type V4ConversationWorkflowRunNodeResultResult,
} from "../schema/vendor/zcode-protocol-v4/workflow-workspace.js";
import type { ZCodeSessionManager, ZCodeSessionRecord } from "../sessions.js";
import { compileWorkflow, type CompiledWorkflow } from "./compile.js";
import { WorkflowDefinitions, validateWorkflowArgs } from "./definitions.js";
import { makeOmpWorkflowDriver, type OmpWorkflowDriver } from "./driver.js";
import { createWorkflowJournal, type OmpWorkflowJournal } from "./journal.js";
import { preflightAmendImport, buildImportedCache, rebuildImportedCacheForResume } from "./import-cache.js";
import { projectWorkflowSession, workflowEventPayload, workflowRunResumable } from "./projection.js";
import { runWorkflowScript } from "./runtime.js";
import {
	validate,
	type JsonSchema,
	type WorkflowEngine,
	type RunRecord,
	type RunSettlement,
	type RunEvent,
	type Caps,
	type ImportedRunCache,
	type CompileDiagnostic,
} from "./vendor/dynamic-workflow/index.js";

export interface ZCodeWorkflowServiceOptions {
	agentDir: string;
	manager: ZCodeSessionManager;
	catalog: (cwd: string) => Promise<readonly Model<Api>[]>;
	onChange?: (sessionId: string, runId: string) => void;
}
export interface PreparedWorkflow {
	cwd: string;
	name: string;
	scope: "project" | "global";
	path: string;
	meta: Wire.ZCodeSavedWorkflowMeta;
	script: string;
	args: Record<string, unknown>;
	compiled: CompiledWorkflow;
	catalog: readonly Model<Api>[];
}
export type WorkflowPreparation =
	| { ok: true; prepared: PreparedWorkflow }
	| {
			ok: false;
			reason: "invalid_name" | "not_found" | "invalid_args" | "compile_failed";
			message: string;
			diagnostics?: CompileDiagnostic[];
	  };
export interface WorkflowToolAdmission {
	toolCallId: string;
	inputId: string;
	signal?: AbortSignal;
	maxConcurrency?: number;
	subagentModel?: string;
}
interface ActiveWorkflow {
	parentSessionId: string;
	abort: AbortController;
	gate: WorkflowRequestGate;
	control?: Pick<WorkflowEngine, "setMaxConcurrency" | "fillHole" | "openHoles" | "filledHoles">;
	driver?: OmpWorkflowDriver;
	settled: Promise<RunSettlement>;
}
interface WorkflowLaunchOverrides {
	caps?: Caps;
	subagentModel?: Model<Api>;
	importedCache?: ImportedRunCache;
	resumedFrom?: string;
	inheritedTokens?: number;
}

/** Permits govern actual provider requests, not workflow nodes or session admission. */
class WorkflowRequestGate {
	#limit: number;
	#used = 0;
	readonly #waiting: Array<() => void> = [];
	constructor(limit: number) {
		this.#limit = limit;
	}
	setLimit(limit: number) {
		this.#limit = limit;
		this.#drain();
	}
	#drain() {
		while (this.#used < this.#limit && this.#waiting.length) this.#waiting.shift()!();
	}
	acquire(signal?: AbortSignal): Promise<() => void> {
		const { promise, resolve, reject } = Promise.withResolvers<() => void>();
		const abort = () => {
			const index = this.#waiting.indexOf(admit);
			if (index >= 0) this.#waiting.splice(index, 1);
			signal?.removeEventListener("abort", abort);
			reject(new Error("Workflow request cancelled"));
		};
		const admit = () => {
			signal?.removeEventListener("abort", abort);
			if (signal?.aborted) {
				abort();
				return;
			}
			this.#used++;
			let released = false;
			resolve(() => {
				if (released) return;
				released = true;
				this.#used--;
				this.#drain();
			});
		};
		if (signal?.aborted) abort();
		else if (this.#used < this.#limit) admit();
		else {
			this.#waiting.push(admit);
			signal?.addEventListener("abort", abort, { once: true });
		}
		return promise;
	}
}

/** Owns execution handles only. Definitions and the durable journal own all workflow facts. */
export class ZCodeWorkflowService {
	readonly journal: OmpWorkflowJournal;
	readonly definitions: WorkflowDefinitions;
	readonly #options: ZCodeWorkflowServiceOptions;
	readonly #active = new Map<string, ActiveWorkflow>();
	readonly #mutations = new Map<string, { controller: AbortController; done: Promise<unknown> }>();
	readonly #defaultConcurrency = Math.max(1, availableParallelism());
	#closed = false;
	constructor(options: ZCodeWorkflowServiceOptions) {
		this.#options = options;
		this.journal = createWorkflowJournal(options.agentDir);
		this.definitions = new WorkflowDefinitions({
			journal: this.journal,
			validateScript: script => {
				// Saving checks the compiler; model availability is checked against the native catalog at launch.
				const result = compileWorkflow(script);
				return result.ok ? { ok: true } : { ok: false, detail: result.message };
			},
		});
	}
	list(params: Wire.ZCodeWorkflowsListParams) {
		return this.definitions.list(params);
	}
	get(params: Wire.ZCodeWorkflowsGetParams) {
		return this.definitions.get(params);
	}
	updateMeta(params: Wire.ZCodeWorkflowsUpdateMetaParams) {
		return this.definitions.updateMeta(params);
	}
	delete(params: Wire.ZCodeWorkflowsDeleteParams) {
		return this.definitions.delete(params);
	}
	move(params: Wire.ZCodeWorkflowsMoveParams) {
		return this.definitions.move(params);
	}
	runs(params: Wire.ZCodeWorkflowsRunsParams): Wire.ZCodeWorkflowsRunsResult {
		const limit = Math.min(50, params.limit);
		const page = this.journal.listRuns({
			...(params.scope === "global" ? {} : { cwd: params.workspace.workspacePath }),
			...(params.name === undefined ? {} : { name: params.name }),
			limit: limit + 1,
		});
		return {
			runs: page.slice(0, limit).map(run => {
				const artifacts = this.journal
					.getArtifacts(run.runId)
					.slice(0, 8)
					.map(artifact => ({
						id: artifact.id,
						kind: artifact.kind,
						version: artifact.version,
						...(artifact.title === undefined ? {} : { title: artifact.title }),
						...(artifact.contentType === undefined ? {} : { contentType: artifact.contentType }),
					}));
				return {
					runId: run.runId,
					status: run.status,
					createdAt: run.createdAt,
					updatedAt: run.updatedAt,
					spentTokens: run.spentTokens,
					...(run.name === undefined ? {} : { name: run.name }),
					...(run.status === "stopped" && run.stopReason !== undefined ? { stopReason: run.stopReason } : {}),
					...(run.parentSessionId === undefined ? {} : { parentSessionId: run.parentSessionId }),
					...(run.toolCallId === undefined ? {} : { toolCallId: run.toolCallId }),
					...(run.args === undefined ? {} : { args: run.args }),
					...(run.cwd === undefined ? {} : { cwd: run.cwd }),
					...(artifacts.length ? { artifacts } : {}),
				};
			}),
			...(page.length > limit ? { truncated: true as const } : {}),
		};
	}
	save(params: Wire.ZCodeWorkflowsSaveParams) {
		return this.definitions.saveFromRun(params);
	}
	forRun(params: Wire.ZCodeWorkflowsForRunParams) {
		return this.definitions.forRun(params);
	}

	async prepareSaved(input: {
		cwd: string;
		name: string;
		scope?: "project" | "global";
		args?: Record<string, unknown>;
	}): Promise<WorkflowPreparation> {
		const found = await this.definitions.get({
			workspace: { workspacePath: input.cwd },
			name: input.name,
			scope: input.scope,
		});
		if (!found.ok)
			return {
				ok: false,
				reason: found.reason === "invalid_name" ? "invalid_name" : "not_found",
				message: found.detail ?? `Saved workflow '${input.name}' was not found.`,
			};
		const args = validateWorkflowArgs(found.meta.args, input.args);
		if (!args.ok) return { ok: false, reason: "invalid_args", message: args.errors.join("\n") };
		const catalog = await this.#options.catalog(input.cwd);
		const compiled = compileWorkflow(found.script, catalog);
		if (!compiled.ok)
			return { ok: false, reason: "compile_failed", message: compiled.message, diagnostics: compiled.diagnostics };
		return {
			ok: true,
			prepared: {
				cwd: input.cwd,
				name: found.name,
				scope: found.scope,
				path: found.path,
				meta: found.meta,
				script: found.script,
				args: args.args,
				compiled,
				catalog,
			},
		};
	}
	async prepareScript(input: {
		cwd: string;
		script: string;
		name?: string;
		args?: Record<string, unknown>;
	}): Promise<WorkflowPreparation> {
		const catalog = await this.#options.catalog(input.cwd);
		const compiled = compileWorkflow(input.script, catalog);
		if (!compiled.ok)
			return { ok: false, reason: "compile_failed", message: compiled.message, diagnostics: compiled.diagnostics };
		return {
			ok: true,
			prepared: {
				cwd: input.cwd,
				name: input.name ?? "Workflow",
				scope: "project",
				path: "",
				meta: { description: "" },
				script: input.script,
				args: input.args ?? {},
				compiled,
				catalog,
			},
		};
	}

	async start(record: ZCodeSessionRecord, prepared: PreparedWorkflow, launchInputId?: string) {
		if (this.#closed) throw new Error("Workflow service is closed");
		if (record.cwd !== prepared.cwd) throw new Error("Workflow parent workspace mismatch");
		const runId = randomUUID();
		const toolCallId = `launch-${randomUUID()}`;
		const inputId = launchInputId ?? randomUUID();
		const launch: WorkflowLaunchMeta = {
			runId,
			toolCallId,
			name: prepared.name.slice(0, 200),
			...(prepared.path && prepared.path.length <= 1024 ? { path: prepared.path, scope: prepared.scope } : {}),
			script: prepared.script.slice(0, 256_000),
			description: prepared.meta.description.slice(0, 500),
			...(Object.keys(prepared.args).length && JSON.stringify(prepared.args).length <= 4096
				? { args: prepared.args }
				: {}),
		};
		this.#launch(record, prepared, { runId, toolCallId, inputId });
		// Engine creation is synchronous up to its first world await, including durable createRun.
		if (!this.journal.getRun(runId)) {
			await this.#active.get(runId)?.settled;
			throw new Error("Workflow execution did not create its durable run");
		}
		return { runId, toolCallId, inputId, launch };
	}
	async submit(record: ZCodeSessionRecord, prepared: PreparedWorkflow, admission: WorkflowToolAdmission) {
		if (record.cwd !== prepared.cwd) throw new Error("Workflow parent workspace mismatch");
		if (!admission.toolCallId || !admission.inputId)
			throw new Error("Workflow tool admission requires canonical tool and input references");
		admission.signal?.throwIfAborted();
		const maxConcurrency = admission.maxConcurrency ?? this.#defaultConcurrency;
		if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) throw new Error("Invalid workflow concurrency");
		const subagentModel = this.#resolveModel(admission.subagentModel, prepared.catalog);
		const runId = randomUUID();
		this.#launch(
			record,
			prepared,
			{ runId, toolCallId: admission.toolCallId, inputId: admission.inputId },
			undefined,
			{ caps: { maxConcurrency }, subagentModel },
		);
		await Promise.resolve();
		if (admission.signal?.aborted) {
			await this.cancel(record.id, runId);
			admission.signal.throwIfAborted();
		}
		if (!this.journal.getRun(runId)) {
			await this.#active.get(runId)?.settled;
			throw new Error("Workflow execution did not create its durable run");
		}
		return { runId, toolCallId: admission.toolCallId, inputId: admission.inputId };
	}

	#launch(
		record: ZCodeSessionRecord,
		prepared: PreparedWorkflow,
		ids: { runId: string; toolCallId: string; inputId: string },
		previous?: RunRecord,
		overrides: WorkflowLaunchOverrides = {},
	) {
		if (this.#closed) throw new Error("Workflow service is closed");
		if (this.#active.has(ids.runId)) throw new Error("Workflow run is already active");
		const abort = new AbortController();
		const completion = Promise.withResolvers<RunSettlement>();
		const handle: ActiveWorkflow = {
			parentSessionId: record.id,
			abort,
			settled: completion.promise,
			gate: new WorkflowRequestGate(
				overrides.caps?.maxConcurrency ?? previous?.caps.maxConcurrency ?? this.#defaultConcurrency,
			),
		};
		this.#active.set(ids.runId, handle);
		const bindings = Object.fromEntries(
			[...prepared.compiled.modelBindings].map(([name, model]) => [name, `${model.provider}/${model.id}`]),
		);
		const execution = runWorkflowScript({
			scriptText: prepared.script,
			lowered: prepared.compiled.lowered,
			scriptHash: prepared.compiled.scriptHash,
			runId: ids.runId,
			cwd: prepared.cwd,
			name: prepared.name,
			parentSessionId: record.id,
			toolCallId: ids.toolCallId,
			args: prepared.args,
			caps: overrides.caps ?? previous?.caps ?? { maxConcurrency: this.#defaultConcurrency },
			askSpecs: prepared.compiled.askSpecs,
			sitePhases: prepared.compiled.sitePhases,
			signal: abort.signal,
			importedCache: overrides.importedCache,
			resumedFrom: overrides.resumedFrom,
			inheritedTokens: overrides.inheritedTokens,
			validate: (schema, value) => validate(schema as JsonSchema, value),
			control: {
				bind: engine => {
					handle.control = engine;
				},
			},
			...(previous
				? {}
				: {
						launch: {
							inputId: ids.inputId,
							phaseNames: prepared.compiled.phases.phaseNames,
							holes: prepared.compiled.phases.holes,
							modelBindings: bindings,
							...(overrides.subagentModel
								? { subagentModel: `${overrides.subagentModel.provider}/${overrides.subagentModel.id}` }
								: {}),
						},
					}),
			makeDriver: sink => {
				const driver = makeOmpWorkflowDriver(record, sink, this.journal, {
					runId: ids.runId,
					sessions: this.#options.manager,
					modelBindings: prepared.compiled.modelBindings,
					modelCatalog: prepared.catalog,
					subagentModel: overrides.subagentModel,
					admitRequest: signal => handle.gate.acquire(signal),
					signal: abort.signal,
					emit: () => this.#changed(record.id, ids.runId),
				});
				handle.driver = driver;
				return driver;
			},
		});
		void execution.then(completion.resolve, completion.reject);
		void handle.settled
			.finally(async () => {
				handle.driver?.dispose();
				await handle.driver?.closed;
				if (this.#active.get(ids.runId) === handle) this.#active.delete(ids.runId);
				this.#changed(record.id, ids.runId);
			})
			.catch(() => {
				/* failure is durable in the runner journal; never reinterpret it as success */
			});
		this.#changed(record.id, ids.runId);
	}
	#changed(sessionId: string, runId: string) {
		this.#options.onChange?.(sessionId, runId);
	}
	#owned(sessionId: string, runId: string) {
		const run = this.journal.getRun(runId);
		if (!run || run.parentSessionId !== sessionId)
			throw new Error(`Workflow run '${runId}' does not belong to session '${sessionId}'`);
		return run;
	}
	owns(sessionId: string, runId: string) {
		return this.journal.getRun(runId)?.parentSessionId === sessionId;
	}
	projection(sessionId: string) {
		return projectWorkflowSession(this.journal, sessionId, this.#defaultConcurrency);
	}
	listRuns(sessionId: string, query: { limit?: number } = {}) {
		return {
			runs: this.journal
				.listRuns({ parentSessionId: sessionId, limit: Math.min(64, query.limit ?? 64) })
				.map(run => ({
					runId: run.runId,
					...(run.toolCallId ? { toolCallId: run.toolCallId } : {}),
					label: (run.name ?? run.runId).slice(0, 160),
					updatedAt: run.updatedAt,
					status: run.status,
					...(run.stopReason ? { stopReason: run.stopReason } : {}),
					...(run.resumedFrom ? { resumedFrom: run.resumedFrom } : {}),
					...(run.supersededBy ? { supersededBy: run.supersededBy } : {}),
					...(run.failure
						? { failureCode: run.failure.code, failureMessage: run.failure.message.slice(0, 2048) }
						: {}),
					resumable: workflowRunResumable(run),
				})),
		};
	}
	getRun(sessionId: string, runId: string) {
		return this.#owned(sessionId, runId);
	}
	getRunNodes(sessionId: string, runId: string) {
		this.#owned(sessionId, runId);
		return this.journal.getNodes(runId);
	}
	getRunActors(sessionId: string, runId: string) {
		this.#owned(sessionId, runId);
		return this.journal.getActors(runId);
	}
	getRunEvents(sessionId: string, runId: string, query: { afterSequence?: number; limit?: number } = {}) {
		this.#owned(sessionId, runId);
		const limit = Math.min(256, query.limit ?? 128);
		const page = this.journal.getEvents(runId, {
			types: "all",
			reportItems: "all",
			afterSequence: query.afterSequence,
			limit: limit + 1,
		});
		return { events: page.slice(0, limit).map(workflowEventPayload), hasMore: page.length > limit };
	}
	getRunArtifacts(sessionId: string, runId: string) {
		this.#owned(sessionId, runId);
		return {
			artifacts: this.journal.getArtifacts(runId).map(latest => {
				const versions = this.journal
					.getNodes(runId, { kinds: ["artifact"], withResult: true })
					.filter(node => node.status === "completed" && node.artifactId === latest.id)
					.map(node => node.result)
					.filter(
						(value): value is typeof latest => typeof value === "object" && value !== null && "version" in value,
					)
					.sort((a, b) => a.version - b.version);
				return {
					id: latest.id,
					kind: latest.kind,
					// 产物目录也必须携带最新版本；只有 versions 会导致公开 schema 拒绝整个查询。
					version: latest.version,
					...(latest.title ? { title: latest.title } : {}),
					...(latest.description ? { description: latest.description } : {}),
					...(latest.contentType ? { contentType: latest.contentType } : {}),
					...(latest.sourcePath ? { sourcePath: latest.sourcePath } : {}),
					...(latest.spec === undefined ? {} : { spec: latest.spec }),
					versions: versions.map(
						({ id: _id, kind: _kind, primary: _primary, spec: _spec, ...version }) => version,
					),
					itemCount: this.journal
						.getNodes(runId, { kinds: ["report"], withResult: false })
						.filter(node => node.artifactId === latest.id).length,
					...(latest.primary ? { primary: true } : {}),
				};
			}),
		};
	}
	getArtifact(sessionId: string, runId: string, artifactId: string, version?: number) {
		this.#owned(sessionId, runId);
		const artifact = this.journal.getArtifact(runId, artifactId, version);
		if (!artifact) throw new Error("Workflow artifact not found");
		return artifact;
	}
	async artifactRead(input: {
		sessionId: string;
		runId: string;
		artifactId: string;
		version: number;
		offset: number;
		limit: number;
	}) {
		const artifact = this.getArtifact(input.sessionId, input.runId, input.artifactId, input.version);
		if (!artifact.uri?.startsWith("artifact://"))
			throw new Error("Workflow artifact has no native content reference");
		const parent =
			this.#options.manager.get(input.sessionId) ?? (await this.#options.manager.resume(input.sessionId));
		const path = await parent.session.sessionManager.getArtifactPath(artifact.uri.slice("artifact://".length));
		if (path === null) throw new Error("Workflow artifact content was not found");
		const file = await open(path, "r");
		try {
			const stat = await file.stat();
			const bytes = Buffer.alloc(Math.min(512 * 1024, input.limit, Math.max(0, stat.size - input.offset)));
			const read = await file.read(bytes, 0, bytes.length, input.offset);
			const end = input.offset + read.bytesRead;
			return {
				dataBase64: bytes.subarray(0, read.bytesRead).toString("base64"),
				mediaType: artifact.contentType ?? "application/octet-stream",
				totalBytes: stat.size,
				nextOffset: end < stat.size ? end : null,
			};
		} finally {
			await file.close();
		}
	}
	artifactData(input: {
		sessionId: string;
		runId: string;
		artifactId: string;
		afterSequence?: number;
		limit?: number;
		fields?: string[];
	}) {
		this.#owned(input.sessionId, input.runId);
		const page = this.journal.listArtifactItems(input.runId, input.artifactId, {
			afterSequence: input.afterSequence,
			limit: Math.min(500, input.limit ?? 200),
		});
		if (!input.fields) return page;
		return {
			...page,
			items: page.items.map(({ item, ...reference }) => {
				const fields: Record<string, unknown> = {};
				for (const field of input.fields!) {
					const value = readWorkflowArtifactField(item, field);
					if (value === undefined) continue;
					const serialized = JSON.stringify(value);
					fields[field] =
						Buffer.byteLength(serialized, "utf8") <= WORKFLOW_ARTIFACT_LIMITS.maxFieldValueBytes
							? value
							: serialized.slice(0, WORKFLOW_ARTIFACT_LIMITS.maxFieldValueBytes / 4);
				}
				return { ...reference, item: undefined, fields };
			}),
		};
	}
	control(sessionId: string, runId: string, input: { maxConcurrency: number }) {
		this.#owned(sessionId, runId);
		if (!Number.isSafeInteger(input.maxConcurrency) || input.maxConcurrency < 1)
			throw new Error("Invalid workflow concurrency");
		const handle = this.#active.get(runId);
		if (!handle?.control || handle.parentSessionId !== sessionId) throw new Error("Workflow run is not active");
		const changed = handle.control.setMaxConcurrency(input.maxConcurrency);
		handle.gate.setLimit(this.journal.getRun(runId)!.caps.maxConcurrency);
		this.#changed(sessionId, runId);
		return { changed, maxConcurrency: this.journal.getRun(runId)!.caps.maxConcurrency };
	}
	#runLaunch(runId: string): Extract<RunEvent, { type: "run-launched" }> | undefined {
		const event = this.journal.getEvents(runId, { types: ["run-launched"], reportItems: "all", limit: 1 })[0]?.event;
		return event?.type === "run-launched" ? event : undefined;
	}
	#cacheDeps() {
		return {
			journal: this.journal,
			actorTranscriptStore: {
				messages: async ({ sessionID }: { sessionID: string }) =>
					(await this.#options.manager.read(sessionID)).messages,
			},
		};
	}
	#resolveModel(name: string | undefined, catalog: readonly Model<Api>[]) {
		if (name === undefined) return undefined;
		const model = catalog.find(
			candidate => `${candidate.provider}/${candidate.id}`.toLowerCase() === name.toLowerCase(),
		);
		if (!model)
			throw Object.assign(new Error(`Workflow model '${name}' is unavailable in the native catalog`), {
				reason: "model_unavailable",
			});
		return model;
	}
	#withMutation<T>(runId: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
		if (this.#closed) return Promise.reject(new Error("Workflow service is closed"));
		if (this.#mutations.has(runId)) return Promise.reject(new Error("Workflow run control is busy"));
		const controller = new AbortController();
		const done = Promise.resolve().then(() => operation(controller.signal));
		this.#mutations.set(runId, { controller, done });
		void done
			.finally(() => {
				if (this.#mutations.get(runId)?.done === done) this.#mutations.delete(runId);
			})
			.catch(() => {});
		return done;
	}
	amend(record: ZCodeSessionRecord, input: AmendWorkflowRunSettingsPayload, launchInputId?: string) {
		return this.#withMutation(input.workId, signal => this.#amend(record, input, signal, launchInputId));
	}
	async #amend(
		record: ZCodeSessionRecord,
		input: AmendWorkflowRunSettingsPayload,
		signal: AbortSignal,
		launchInputId?: string,
	) {
		const run = this.#owned(record.id, input.workId);
		if (run.stopReason === "superseded")
			throw Object.assign(new Error("Workflow run has already been superseded"), { reason: "not_configurable" });
		if (run.scriptText === undefined)
			throw Object.assign(new Error("Workflow run script is missing"), { reason: "script_missing" });
		const catalog = await this.#options.catalog(record.cwd);
		const previousModel = this.#runLaunch(run.runId)?.subagentModel;
		const nextModel = input.subagentModel === undefined ? previousModel : (input.subagentModel ?? undefined);
		const subagentModel = this.#resolveModel(nextModel, catalog);
		const nextConcurrency =
			input.maxConcurrency === undefined
				? run.caps.maxConcurrency
				: (input.maxConcurrency ?? this.#defaultConcurrency);
		if (!Number.isSafeInteger(nextConcurrency) || nextConcurrency < 1)
			throw new Error("Invalid workflow concurrency");
		const modelChanged = nextModel !== previousModel;
		const boundChanged = nextConcurrency !== run.caps.maxConcurrency;
		if (!modelChanged && !boundChanged)
			throw Object.assign(new Error("Workflow settings are unchanged"), { reason: "unchanged" });
		const compiled = compileWorkflow(run.scriptText, catalog);
		if (!compiled.ok) throw Object.assign(new Error(compiled.message), { reason: "compile_failed" });
		signal.throwIfAborted();
		const toolCallId = `settings-${randomUUID()}`;
		const inputId = launchInputId ?? randomUUID();
		const changes: NonNullable<WorkflowLaunchMeta["amend"]> = {
			...(modelChanged ? { subagentModel: { from: previousModel, to: nextModel } } : {}),
			...(boundChanged
				? {
						maxConcurrency: {
							from: run.caps.maxConcurrency === this.#defaultConcurrency ? undefined : run.caps.maxConcurrency,
							to: nextConcurrency === this.#defaultConcurrency ? undefined : nextConcurrency,
						},
					}
				: {}),
			ceiling: this.#defaultConcurrency,
		};
		if (!modelChanged && this.#active.has(run.runId)) {
			this.control(record.id, run.runId, { maxConcurrency: nextConcurrency });
			return {
				runId: run.runId,
				toolCallId,
				inputId,
				launch: {
					runId: run.runId,
					toolCallId,
					name: run.name,
					amend: changes,
				} satisfies WorkflowLaunchMeta,
			};
		}
		const preflight = preflightAmendImport(this.journal, run.runId);
		if (!preflight.ok)
			throw Object.assign(new Error(`Workflow amendment rejected: ${preflight.reason}`), {
				reason: preflight.reason === "run_not_found" ? "not_found" : preflight.reason,
			});
		const active = this.#active.get(run.runId);
		if (active) {
			active.abort.abort("user");
			await active.settled;
			await active.driver?.closed;
		}
		const imported = await buildImportedCache(
			this.#cacheDeps(),
			run.runId,
			active?.driver ? { quietSessions: new Set(active.driver.quietSessionIds) } : undefined,
		);
		if (!imported.ok)
			throw Object.assign(new Error(`Workflow amendment cache rejected: ${imported.reason}`), {
				reason: imported.reason,
			});
		signal.throwIfAborted();
		const runId = randomUUID();
		const prepared: PreparedWorkflow = {
			cwd: record.cwd,
			name: run.name ?? run.runId,
			scope: "project",
			path: "",
			meta: { description: "" },
			script: run.scriptText,
			args: run.args ?? {},
			compiled,
			catalog,
		};
		this.#launch(record, prepared, { runId, toolCallId, inputId }, undefined, {
			caps: { maxConcurrency: nextConcurrency },
			subagentModel,
			importedCache: imported.cache,
			resumedFrom: run.runId,
			inheritedTokens: this.journal.getRun(run.runId)!.spentTokens,
		});
		if (!this.journal.getRun(runId))
			throw Object.assign(new Error("Amended workflow was not admitted"), { reason: "start_failed" });
		if (active) {
			this.journal.updateRunStatus(run.runId, "stopped", { stopReason: "superseded", supersededBy: runId });
			this.journal.appendEvent(run.runId, {
				type: "run-settled",
				status: "stopped",
				stopReason: "superseded",
				supersededBy: runId,
			});
			this.#changed(record.id, run.runId);
		}
		return {
			runId,
			toolCallId,
			inputId,
			...(active ? { supersededRunId: run.runId } : {}),
			launch: {
				runId,
				toolCallId,
				name: run.name,
				script: run.scriptText,
				amend: { ...changes, predecessorRunId: run.runId },
			} satisfies WorkflowLaunchMeta,
		};
	}
	workspace(input: V4ConversationWorkflowRunWorkspaceParams): V4ConversationWorkflowRunWorkspaceResult {
		this.#owned(input.sessionId, input.runId);
		const page = this.journal.getWorkspaceNodes(input.runId, { limit: WORKFLOW_WORKSPACE_LIMITS.maxNodes + 1 });
		return {
			nodes: page.slice(0, WORKFLOW_WORKSPACE_LIMITS.maxNodes).map(node => ({
				siteId: node.siteId,
				ordinal: node.ordinal,
				kind: node.kind as "world-read" | "world-run",
				status: node.status,
				...(node.input
					? {
							op: node.input.op,
							args: node.input.args,
							...(node.input.truncated ? { inputTruncated: true as const } : {}),
						}
					: {}),
				...(node.error ? { error: { code: node.error.code, message: node.error.message.slice(0, 2000) } } : {}),
				...(node.resultBytes === undefined
					? {}
					: {
							summary: {
								resultBytes: node.resultBytes,
								...(node.resultCount === undefined ? {} : { resultCount: node.resultCount }),
								...(node.exitCode === undefined ? {} : { exitCode: node.exitCode }),
								...(node.stdoutBytes === undefined ? {} : { stdoutBytes: node.stdoutBytes }),
								...(node.stderrBytes === undefined ? {} : { stderrBytes: node.stderrBytes }),
							},
						}),
				createdAt: node.createdAt,
				updatedAt: node.updatedAt,
			})),
			...(page.length > WORKFLOW_WORKSPACE_LIMITS.maxNodes ? { truncated: true } : {}),
		};
	}
	nodeResult(input: V4ConversationWorkflowRunNodeResultParams): V4ConversationWorkflowRunNodeResultResult {
		if (!this.owns(input.sessionId, input.runId)) throw new Error("Workflow node not found");
		const node = this.journal.getNode(input.runId, input.siteId, input.ordinal, { withResult: true });
		if (!node || (node.kind !== "world-read" && node.kind !== "world-run"))
			throw new Error("Workflow node not found");
		const totalBytes = node.result === undefined ? 0 : Buffer.byteLength(JSON.stringify(node.result), "utf8");
		const maxBytes = Math.min(
			WORKFLOW_WORKSPACE_LIMITS.resultMaxBytes,
			input.maxBytes ?? WORKFLOW_WORKSPACE_LIMITS.resultMaxBytes,
		);
		return {
			status: node.status,
			totalBytes,
			truncated: totalBytes > maxBytes,
			...(node.result === undefined ? {} : { result: boundNodeResult(node.result, maxBytes) }),
			...(node.error ? { error: { code: node.error.code, message: node.error.message.slice(0, 2000) } } : {}),
		};
	}
	resume(record: ZCodeSessionRecord, runId: string, admissionSignal?: AbortSignal) {
		return this.#withMutation(runId, signal =>
			this.#resume(record, runId, admissionSignal ? AbortSignal.any([signal, admissionSignal]) : signal),
		);
	}
	async #resume(record: ZCodeSessionRecord, runId: string, signal: AbortSignal) {
		const run = this.#owned(record.id, runId);
		if (!workflowRunResumable(run) || this.#active.has(runId) || !run.scriptText)
			throw new Error("Workflow run cannot be resumed");
		const catalog = await this.#options.catalog(record.cwd);
		const compiled = compileWorkflow(run.scriptText, catalog);
		if (!compiled.ok) throw new Error(compiled.message);
		const prepared: PreparedWorkflow = {
			cwd: record.cwd,
			name: run.name ?? runId,
			scope: "project",
			path: "",
			meta: { description: "" },
			script: run.scriptText,
			args: run.args ?? {},
			compiled,
			catalog,
		};
		const priorLaunch = this.#runLaunch(runId);
		const subagentModel = this.#resolveModel(priorLaunch?.subagentModel, catalog);
		const imported = run.resumedFrom
			? await rebuildImportedCacheForResume(this.#cacheDeps(), { runId, predecessorRunId: run.resumedFrom })
			: undefined;
		if (run.resumedFrom && !imported) throw new Error("Workflow resume could not reconstruct its predecessor cache");
		signal.throwIfAborted();
		this.#launch(
			record,
			prepared,
			{ runId, toolCallId: run.toolCallId ?? `resume-${randomUUID()}`, inputId: randomUUID() },
			run,
			{ subagentModel, importedCache: imported, resumedFrom: run.resumedFrom },
		);
		if (signal.aborted) {
			await this.cancel(record.id, runId);
			signal.throwIfAborted();
		}
		return { runId, toolCallId: run.toolCallId };
	}
	async cancel(sessionId: string, runId: string) {
		if (!this.journal.getRun(runId)) return false;
		this.#owned(sessionId, runId);
		this.#mutations.get(runId)?.controller.abort();
		const handle = this.#active.get(runId);
		if (!handle || handle.parentSessionId !== sessionId) return false;
		handle.abort.abort("user");
		await handle.settled;
		await handle.driver?.closed;
		if (this.#active.get(runId) === handle) this.#active.delete(runId);
		return true;
	}
	async cancelSession(sessionId: string) {
		await Promise.all(
			[...this.#active]
				.filter(([, handle]) => handle.parentSessionId === sessionId)
				.map(([runId]) => this.cancel(sessionId, runId)),
		);
	}
	async dispose() {
		if (this.#closed) return;
		this.#closed = true;
		const handles = [...this.#active.values()];
		for (const handle of handles) handle.abort.abort("interrupted");
		await Promise.allSettled(
			handles.map(async handle => {
				await handle.settled;
				await handle.driver?.closed;
			}),
		);
		for (const mutation of this.#mutations.values()) mutation.controller.abort();
		await Promise.allSettled([...this.#mutations.values()].map(mutation => mutation.done));
		this.journal.close();
	}
}

/** Original dynamic-workflow-run-workspace.ts audit result shapes and byte budgets. */
function boundNodeResult(result: unknown, maxBytes: number): unknown {
	const serialized = JSON.stringify(result) ?? "null";
	if (Buffer.byteLength(serialized, "utf8") <= maxBytes) return result;
	const truncate = (text: string, budget: number) => {
		if (Buffer.byteLength(text, "utf8") <= budget) return text;
		return new TextDecoder("utf8").decode(Buffer.from(text, "utf8").subarray(0, Math.max(0, budget)), {
			stream: true,
		});
	};
	if (typeof result === "string") return truncate(result, maxBytes);
	if (Array.isArray(result)) {
		const kept: unknown[] = [];
		let used = 2;
		for (const item of result) {
			const bytes = Buffer.byteLength(JSON.stringify(item) ?? "null", "utf8") + 1;
			if (used + bytes > maxBytes) break;
			kept.push(item);
			used += bytes;
		}
		return kept;
	}
	if (
		result &&
		typeof result === "object" &&
		"exitCode" in result &&
		"stdout" in result &&
		"stderr" in result &&
		typeof result.stdout === "string" &&
		typeof result.stderr === "string"
	) {
		const overhead = Buffer.byteLength(JSON.stringify({ ...result, stdout: "", stderr: "" }), "utf8");
		const budget = Math.max(0, maxBytes - overhead);
		const stderrBudget = Math.min(
			Buffer.byteLength(result.stderr, "utf8"),
			Math.max(budget >> 1, budget - Buffer.byteLength(result.stdout, "utf8")),
		);
		return {
			...result,
			stdout: truncate(result.stdout, budget - stderrBudget),
			stderr: truncate(result.stderr, stderrBudget),
		};
	}
	return truncate(serialized, maxBytes);
}
