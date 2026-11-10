import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { textContent } from "@oh-my-pi/pi-tui/chat/transcript-entry";
import { DEFAULT_MAX_BYTES } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { isEnoent, isRecord } from "@oh-my-pi/pi-utils";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Emitter, type Event } from "../../../../../packages/dev-frontend/packages/rpc/src/foundation";
import type {
	NativeTaskOutput,
	NativeTaskOutputContent,
	NativeTaskRun,
	NativeTaskRunsSnapshot,
	NativeTaskStatus,
} from "../../../../../packages/dev-frontend/packages/shared/src/native-task-runs";
import type { AsyncJob } from "../../async/job-manager";
import { containedRealPath } from "../../internal-urls/filesystem-resource";
import { assertNativeChat } from "./native-chat";
import type { NativeChildDirectory, OwnedNativeChild } from "./native-subagents";
import type { WebGuiMethod, WebGuiServiceContext } from "./rpc-contract";

export interface NativeTaskRunAdapter {
	readonly methods: Readonly<Record<string, WebGuiMethod>>;
	readonly onDidChange: Event<{ sessionId: string; revision: number }>;
	dispose(): void;
}

interface Invocation {
	run: NativeTaskRun;
	ownerId: string;
	result?: AgentMessage & { role: "toolResult" };
	pools: Set<string>;
	jobs: Set<string>;
	children: Set<string>;
	poolStatus?: NativeTaskStatus;
}

interface OwnedOutput {
	dto: NativeTaskOutput;
	invocation: Invocation;
	child?: OwnedNativeChild;
	file?: string;
	job?: AsyncJob;
}

function request(value: unknown): Record<string, unknown> {
	if (!isRecord(value) || typeof value.sessionId !== "string" || !value.sessionId)
		throw new TypeError("A native sessionId is required");
	return value;
}

function status(value: string): NativeTaskStatus {
	if (value === "success") return "completed";
	if (value === "aborted") return "cancelled";
	if (
		value === "pending" ||
		value === "running" ||
		value === "waiting" ||
		value === "blocked" ||
		value === "idle" ||
		value === "completed" ||
		value === "failed" ||
		value === "cancelled"
	)
		return value;
	return "unknown";
}

function aggregate(values: readonly NativeTaskStatus[]): NativeTaskStatus {
	for (const candidate of [
		"running",
		"blocked",
		"waiting",
		"pending",
		"failed",
		"cancelled",
		"unknown",
		"idle",
	] as const)
		if (values.includes(candidate)) return candidate;
	return values.length ? "completed" : "unknown";
}

function records(value: unknown): Record<string, unknown>[] {
	return Array.isArray(value) ? value.filter(isRecord) : [];
}

function finiteTime(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function taskResultStatus(message: AgentMessage & { role: "toolResult" }): NativeTaskStatus {
	const details = isRecord(message.details) ? message.details : {};
	if (isRecord(details.async) && typeof details.async.state === "string") return status(details.async.state);
	const progress = records(details.progress);
	const results = records(details.results);
	const states = [
		...progress.map(item => status(typeof item.status === "string" ? item.status : "unknown")),
		...results.map(item =>
			item.aborted === true
				? ("cancelled" as const)
				: typeof item.exitCode === "number"
					? item.exitCode !== 0 || item.error
						? ("failed" as const)
						: ("completed" as const)
					: ("unknown" as const),
		),
	];
	return message.isError ? "failed" : states.length ? aggregate(states) : "completed";
}

/** Build bounded readable transcripts without serializing native accounting or binary content. */
function transcript(messages: readonly AgentMessage[]): string {
	const chunks: string[] = [];
	const marker = "\n[Native output truncated]";
	let remaining = DEFAULT_MAX_BYTES - Buffer.byteLength(marker);
	for (const message of messages) {
		const label = message.role === "toolResult" ? `tool ${message.toolName}` : message.role;
		const content = "content" in message ? textContent(message.content, "\n") : "";
		if (!content) continue;
		const bytes = Buffer.from(`${chunks.length ? "\n\n" : ""}## ${label}\n${content}`);
		if (bytes.length <= remaining) {
			chunks.push(bytes.toString("utf8"));
			remaining -= bytes.length;
		} else {
			const length = Math.max(0, remaining);
			chunks.push(new TextDecoder().decode(bytes.subarray(0, length), { stream: true }), marker);
			break;
		}
	}
	return chunks.join("");
}

/** Read-only projection of actual native invocations; no workflow registry or execution path. */
export function createNativeTaskRunAdapter(context: WebGuiServiceContext, directory: NativeChildDirectory) {
	const session = assertNativeChat(context);
	const changes = new Emitter<{ sessionId: string; revision: number }>();
	let revision = 0;
	let disposed = false;
	let binding = "";
	let unsubscribeJobs: (() => void) | undefined;
	let jobsManager = session.asyncJobManager;
	const notify = () => {
		if (!disposed) changes.fire({ sessionId: session.sessionManager.getSessionId(), revision: ++revision });
	};
	const bindJobs = () => {
		if (jobsManager === session.asyncJobManager && unsubscribeJobs) return;
		unsubscribeJobs?.();
		jobsManager = session.asyncJobManager;
		unsubscribeJobs = jobsManager?.onJobSettled(notify);
	};
	bindJobs();
	const unsubscribeMessages = session.subscribe(notify);
	const unsubscribeState = session.subscribeRunState(notify);
	const unsubscribeDirectory = directory.subscribe(notify);

	function current(expected?: string): string {
		if (disposed || assertNativeChat(context) !== session || session.isSessionTransitioning)
			throw new Error("Native task owner is unavailable");
		const manager = session.sessionManager;
		const next = JSON.stringify([manager.getSessionId(), manager.getSessionFile(), manager.getCwd()]);
		if (expected !== undefined && expected !== next) throw new Error("Native task owner changed during read");
		if (binding !== next) {
			binding = next;
			revision++;
		}
		bindJobs();
		return next;
	}

	async function project(input: unknown) {
		const args = request(input);
		const admitted = current();
		const rootId = session.sessionManager.getSessionId();
		// A directory is bound to one native root. Arbitrary historical roots are not
		// resumed or borrowed from another project's registry to satisfy a read.
		if (args.sessionId !== rootId) throw new Error("Native task reads require the current root session");
		const children: OwnedNativeChild[] = [];
		const messages = new Map<string, readonly AgentMessage[]>();
		const stream = session.agent.state.streamMessage;
		messages.set(
			rootId,
			stream && !session.messages.includes(stream) ? [...session.messages, stream] : session.messages,
		);
		const visit = async (parentId: string): Promise<void> => {
			const list = await directory.list(context, parentId);
			for (const id of list.childSessionIds) {
				const child = await directory.resolve(context, id);
				children.push(child);
				messages.set(id, await directory.messages(context, id));
				await visit(id);
			}
		};
		await visit(rootId);
		current(admitted);
		const invocations: Invocation[] = [];
		const outputs = new Map<string, OwnedOutput>();
		const byParent = new Map<string, OwnedNativeChild[]>();
		for (const child of children) {
			const siblings = byParent.get(child.parentSessionId) ?? [];
			siblings.push(child);
			byParent.set(child.parentSessionId, siblings);
		}
		for (const [ownerId, history] of messages) {
			const calls = new Map<string, Invocation>();
			const ensure = (toolCallId: string, title: string, startedAt?: number): Invocation => {
				let invocation = calls.get(toolCallId);
				if (!invocation) {
					invocation = {
						ownerId,
						pools: new Set(),
						jobs: new Set(),
						children: new Set(),
						run: {
							runId: JSON.stringify([rootId, ownerId, toolCallId]),
							sessionId: ownerId,
							toolCallId,
							title,
							status: "unknown",
							startedAt,
							actors: [],
							outputs: [],
						},
					};
					calls.set(toolCallId, invocation);
					invocations.push(invocation);
				} else if (startedAt !== undefined) invocation.run.startedAt ??= startedAt;
				return invocation;
			};
			for (const message of history) {
				if (message.role === "assistant")
					for (const part of message.content) {
						if (part.type === "toolCall" && part.name === "task") {
							const title =
								isRecord(part.arguments) && typeof part.arguments.i === "string" ? part.arguments.i : "task";
							ensure(part.id, title, finiteTime(message.timestamp));
						}
					}
				if (message.role !== "toolResult") continue;
				const details = isRecord(message.details) ? message.details : {};
				const poolEvents = records(details.statusEvents).filter(
					event =>
						event.op === "workpool" &&
						(event.action === "create" || event.action === "push") &&
						typeof event.pool === "string",
				);
				if (message.toolName !== "task" && !poolEvents.length) continue;
				// Eval calls are included only when native status events prove a pool
				// operation happened, never by searching executable source text.
				const invocation = ensure(message.toolCallId, message.toolName === "task" ? "task" : "workpool");
				invocation.result = message;
				if (message.toolName === "task") invocation.run.status = taskResultStatus(message);
				for (const event of poolEvents) invocation.pools.add(String(event.pool));
				if (isRecord(details.async) && typeof details.async.jobId === "string")
					invocation.jobs.add(details.async.jobId);
				for (const child of byParent.get(ownerId) ?? [])
					if (child.parentToolCallId === message.toolCallId) invocation.children.add(child.childSessionId);
			}
			// A live task can precede its first result/progress message.
			for (const child of byParent.get(ownerId) ?? [])
				if (child.parentToolCallId && calls.has(child.parentToolCallId))
					calls.get(child.parentToolCallId)!.children.add(child.childSessionId);
			for (const invocation of calls.values()) {
				if (!invocation.run.startedAt) {
					const assistant = history.find(
						message =>
							message.role === "assistant" &&
							message.content.some(part => part.type === "toolCall" && part.id === invocation.run.toolCallId),
					);
					invocation.run.startedAt = finiteTime(assistant?.timestamp);
				}
			}
			for (const message of history) {
				if (message.role !== "custom" || message.customType !== "irc:workpool" || !isRecord(message.details))
					continue;
				const details = message.details;
				const candidates = [...calls.values()].filter(
					call =>
						typeof details.pool === "string" &&
						call.pools.has(details.pool) &&
						(call.run.startedAt ?? call.result?.timestamp ?? Infinity) <= message.timestamp,
				);
				const invocation = candidates.at(-1);
				if (!invocation) continue;
				if (details.mode === "completed" || details.mode === "cancelled") {
					invocation.poolStatus = status(details.mode);
					invocation.run.endedAt = finiteTime(message.timestamp);
				}
				for (const child of byParent.get(ownerId) ?? [])
					if (
						child.nativeAgentId === details.to &&
						child.startedAt <= message.timestamp &&
						child.startedAt >= (invocation.run.startedAt ?? invocation.result?.timestamp ?? Infinity)
					)
						invocation.children.add(child.childSessionId);
			}
		}

		const childById = new Map(children.map(child => [child.childSessionId, child]));
		for (const invocation of invocations) {
			const run = invocation.run;
			const addOutput = (
				key: string,
				title: string,
				kind: NativeTaskOutput["kind"],
				owner: Omit<OwnedOutput, "dto" | "invocation">,
				sessionId = invocation.ownerId,
				agentId?: string,
				createdAt?: number,
			) => {
				const id = crypto
					.createHash("sha256")
					.update(JSON.stringify([run.runId, key]))
					.digest("hex");
				const dto: NativeTaskOutput = { id, sessionId, agentId, title, kind, createdAt };
				if (!outputs.has(id)) {
					outputs.set(id, { dto, invocation, ...owner });
					run.outputs.push(dto);
				}
			};
			const addChild = (id: string) => {
				const child = childById.get(id);
				if (!child || run.actors.some(actor => actor.sessionId === id)) return;
				run.actors.push({
					agentId: child.nativeAgentId,
					sessionId: id,
					parentSessionId: child.parentSessionId,
					title: child.info.title || child.summary || child.nativeAgentId,
					status: status(child.status),
					startedAt: finiteTime(child.startedAt),
					endedAt: finiteTime(child.endedAt),
				});
				addOutput(
					`transcript:${id}`,
					child.info.title || `${child.nativeAgentId} transcript`,
					"transcript",
					{ child },
					id,
					child.nativeAgentId,
					finiteTime(child.startedAt),
				);
				for (const descendant of byParent.get(id) ?? []) addChild(descendant.childSessionId);
			};
			for (const id of invocation.children) addChild(id);
			const details = invocation.result && isRecord(invocation.result.details) ? invocation.result.details : {};
			const ownerAgentId =
				invocation.ownerId === rootId ? session.getAgentId() : childById.get(invocation.ownerId)?.nativeAgentId;
			const manager = session.asyncJobManager;
			const candidateJobs = new Set(invocation.jobs);
			for (const pool of invocation.pools) candidateJobs.add(pool);
			// Only explicit invocation handles, or UUID-verified child IDs, may
			// select jobs from the bound owner's manager. Never scan a global pool.
			for (const actor of run.actors) candidateJobs.add(actor.agentId);
			const jobs: AsyncJob[] = [];
			for (const id of candidateJobs) {
				const job = manager?.getJob(id);
				if (!job || job.type !== "task" || job.ownerId !== ownerAgentId || job.startTime < (run.startedAt ?? 0))
					continue;
				if (invocation.result && !invocation.pools.size && job.startTime > invocation.result.timestamp) continue;
				if (job.agentId && !invocation.jobs.has(id) && !run.actors.some(actor => actor.agentId === job.agentId))
					continue;
				jobs.push(job);
				if (job.resultText !== undefined || job.errorText !== undefined || job.progressText !== undefined)
					addOutput(
						`job:${id}`,
						`${job.label} output`,
						"transcript",
						{ job },
						invocation.ownerId,
						job.agentId,
						finiteTime(job.endTime),
					);
			}
			if (invocation.result)
				addOutput(
					"result",
					`${run.title} tool result`,
					"transcript",
					{},
					invocation.ownerId,
					ownerAgentId,
					finiteTime(invocation.result.timestamp),
				);
			const filePaths = new Set<string>();
			if (Array.isArray(details.outputPaths))
				for (const file of details.outputPaths) if (typeof file === "string") filePaths.add(file);
			for (const result of records(details.results))
				if (typeof result.outputPath === "string") filePaths.add(result.outputPath);
			for (const file of filePaths) {
				const authorized = await authorizedFile(file, admitted);
				if (authorized) addOutput(`file:${file}`, path.basename(file), "file", { file });
			}
			if (invocation.pools.size)
				run.status =
					invocation.poolStatus ??
					(jobs.length
						? aggregate(jobs.map(job => (job.queued ? "pending" : status(job.status))))
						: invocation.result?.isError
							? "failed"
							: run.actors.length
								? aggregate(run.actors.map(actor => actor.status))
								: "unknown");
			else if (jobs.length) run.status = aggregate(jobs.map(job => (job.queued ? "pending" : status(job.status))));
			else if (run.actors.length && (!invocation.result || run.status === "running"))
				run.status = aggregate(run.actors.map(actor => actor.status));
			if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
				if (jobs.length && jobs.every(job => job.endTime !== undefined))
					run.endedAt = Math.max(...jobs.map(job => job.endTime!));
				else if (
					!invocation.pools.size &&
					invocation.result &&
					["completed", "failed", "cancelled"].includes(taskResultStatus(invocation.result))
				)
					run.endedAt = finiteTime(invocation.result.timestamp);
				else if (run.actors.length && run.actors.every(actor => actor.endedAt !== undefined))
					run.endedAt ??= Math.max(...run.actors.map(actor => actor.endedAt!));
			}
		}
		current(admitted);
		return {
			snapshot: {
				source: "omp-native-task",
				sessionId: rootId,
				revision,
				runs: invocations.map(item => item.run),
			} satisfies NativeTaskRunsSnapshot,
			outputs,
			admitted,
		};
	}

	async function authorizedFile(file: string, admitted: string): Promise<string | undefined> {
		current(admitted);
		const artifacts = session.sessionManager.getArtifactsDir();
		if (!artifacts) return undefined;
		const absolute = path.resolve(session.sessionManager.getCwd(), file);
		const relative = path.relative(artifacts, absolute);
		if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
			return undefined;
		try {
			const root = await fs.realpath(artifacts);
			const resolved = await containedRealPath(path.join(root, relative), root, "native-task", "owned-output");
			current(admitted);
			return resolved && (await fs.stat(resolved)).isFile() ? resolved : undefined;
		} catch (error) {
			if (isEnoent(error)) return undefined;
			throw error;
		}
	}

	const methods: Readonly<Record<string, WebGuiMethod>> = {
		listNativeTaskRuns: async (input: unknown) => (await project(input)).snapshot,
		readNativeTaskOutput: async (input: unknown): Promise<NativeTaskOutputContent> => {
			const args = request(input);
			if (typeof args.runId !== "string" || typeof args.outputId !== "string")
				throw new TypeError("Owned runId and outputId are required");
			const projection = await project(input);
			const output = projection.outputs.get(args.outputId);
			if (!output || output.invocation.run.runId !== args.runId) throw new Error("Native task output not found");
			let content: string;
			let format: NativeTaskOutputContent["format"] = "markdown";
			if (output.file) {
				const file = await authorizedFile(output.file, projection.admitted);
				if (!file) throw new Error("Native task output is no longer available");
				const handle = await fs.open(file, "r");
				try {
					current(projection.admitted);
					if (!(await handle.stat()).isFile()) throw new Error("Native task output is not a regular file");
					const bytes = Buffer.alloc(DEFAULT_MAX_BYTES + 1);
					let length = 0;
					while (length < bytes.length) {
						const read = await handle.read(bytes, length, bytes.length - length, length);
						current(projection.admitted);
						if (!read.bytesRead) break;
						length += read.bytesRead;
					}
					const marker = "\n[Native output truncated]";
					content =
						length > DEFAULT_MAX_BYTES
							? new TextDecoder().decode(bytes.subarray(0, DEFAULT_MAX_BYTES - Buffer.byteLength(marker)), {
									stream: true,
								}) + marker
							: bytes.subarray(0, length).toString("utf8");
				} finally {
					await handle.close();
				}
				format = path.extname(file) === ".md" ? "markdown" : "text";
			} else if (output.child) {
				content = transcript(await directory.messages(context, output.child.childSessionId));
			} else if (output.job) {
				const job = session.asyncJobManager?.getJob(output.job.id);
				if (job !== output.job) throw new Error("Native task job changed during read");
				const text = job.resultText ?? job.errorText ?? job.progressText ?? "";
				const bytes = Buffer.from(text);
				const marker = "\n[Native output truncated]";
				content =
					bytes.length > DEFAULT_MAX_BYTES
						? new TextDecoder().decode(bytes.subarray(0, DEFAULT_MAX_BYTES - Buffer.byteLength(marker)), {
								stream: true,
							}) + marker
						: text;
			} else {
				content = transcript(output.invocation.result ? [output.invocation.result] : []);
			}
			current(projection.admitted);
			return { outputId: output.dto.id, title: output.dto.title, content, format };
		},
	};
	return {
		methods,
		onDidChange: changes.event,
		dispose: () => {
			if (disposed) return;
			disposed = true;
			unsubscribeMessages();
			unsubscribeState();
			unsubscribeDirectory();
			unsubscribeJobs?.();
			changes.dispose();
		},
	};
}
