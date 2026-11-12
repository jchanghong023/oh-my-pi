import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { textContent } from "@oh-my-pi/pi-tui/chat/transcript-entry";
import { isEnoent, isRecord, normalizePathForComparison } from "@oh-my-pi/pi-utils";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
	ZCodeSessionEndedSubagent,
	ZCodeSessionRunningSubagent,
	ZCodeSessionSubagentsResult,
} from "../../../../../packages/aireq-frontend/packages/shared/src/zcode-protocol";
import type { SubagentProjectionState } from "../../../../../packages/aireq-frontend/packages/shared/src/zcode-protocol-v4/snapshot";
import { isAdvisorTranscriptName } from "../../advisor/transcript-recorder";
import { readRpcSubagentTranscript } from "../../modes/rpc/rpc-subagents";
import type { AgentRef, AgentRegistryApi } from "../../registry/agent-registry";
import { sessionFileBelongsToRoot } from "../../registry/persisted-agents";
import type { AgentSession } from "../../session/agent-session";
import type { AgentSessionHandle } from "../../session/agent-session-handle";
import { normalizeAssistantUsage, readSessionHeaderId } from "../../session/session-loader";
import { readSessionInfo, type SessionInfo } from "../../session/session-listing";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL, TASK_SUBAGENT_PROGRESS_CHANNEL } from "../../task/types";
import { assertNativeChat } from "./native-chat";
import type { WebGuiServiceContext } from "./rpc-contract";

export interface NativeChildProgress {
	readonly currentTool?: string;
	readonly lastIntent?: string;
	readonly completionPercent?: number;
	readonly tokens?: number;
	readonly cost?: number;
	readonly durationMs?: number;
}

export interface OwnedNativeChild {
	readonly childSessionId: string;
	readonly rootSessionId: string;
	readonly parentSessionId: string;
	readonly nativeAgentId: string;
	readonly nativeParentAgentId: string | undefined;
	/** Absent for disk-only history without a matching current native ref. */
	readonly generation?: number;
	readonly parentToolCallId?: string;
	readonly sessionFile: string;
	readonly session: AgentSessionHandle | null;
	readonly info: SessionInfo;
	readonly status: ZCodeSessionRunningSubagent["status"] | ZCodeSessionEndedSubagent["status"];
	readonly subagentType: string;
	readonly summary?: string;
	readonly startedAt: number;
	readonly endedAt?: number;
	readonly progress?: NativeChildProgress;
}

export interface NativeChildChange {
	readonly rootSessionId: string;
	readonly sessionIds: readonly string[];
}

interface ChildObservation {
	generation: number;
	file: string;
	sessionId?: string;
	toolCallId?: string;
	agent?: string;
	summary?: string;
	status?: "started" | "completed" | "failed" | "aborted";
	endedAt?: number;
	progress?: NativeChildProgress;
}

interface ChildLink {
	toolCallId: string;
	timestamp: number;
	agent?: string;
	summary?: string;
	status?: "success" | "failed" | "cancelled";
}

/** Native task details use results[].id and progress[].id, never conversation UUIDs. */
function taskLinks(messages: readonly AgentMessage[]): Map<string, ChildLink> {
	const links = new Map<string, ChildLink>();
	for (const message of messages) {
		if (message.role !== "toolResult" || !isRecord(message.details)) continue;
		for (const key of ["progress", "results"]) {
			const items = message.details[key];
			if (!Array.isArray(items)) continue;
			for (const item of items) {
				if (!isRecord(item) || typeof item.id !== "string") continue;
				const link: ChildLink = {
					toolCallId: message.toolCallId,
					timestamp: message.timestamp,
					agent: typeof item.agent === "string" ? item.agent : undefined,
					summary: typeof item.description === "string" ? item.description : undefined,
				};
				if (key === "results" && typeof item.exitCode === "number") {
					link.status =
						item.aborted === true ? "cancelled" : item.exitCode !== 0 || item.error ? "failed" : "success";
				}
				links.set(item.id, link);
			}
		}
	}
	return links;
}

function sameFile(left: string, right: string): boolean {
	return normalizePathForComparison(path.resolve(left)) === normalizePathForComparison(path.resolve(right));
}

function terminalStatus(info: SessionInfo): ZCodeSessionEndedSubagent["status"] {
	if (info.status === "complete") return "success";
	if (info.status === "error") return "failed";
	if (info.status === "aborted") return "cancelled";
	return "lost";
}

/**
 * Read-only directory over the bound native owner's registry and artifact tree.
 * Parent wiring: info/messages feed native-chat's child reads; projection/list feed
 * V4 snapshots and listSessionSubagents; tool-call lookup supplies agent row links.
 * subscribe invalidates root/child snapshots. No method grants child input rights.
 */
export class NativeChildDirectory {
	readonly #session: AgentSession;
	readonly #registry: AgentRegistryApi;
	readonly #listeners = new Set<(change: NativeChildChange) => void>();
	readonly #observations = new Map<string, ChildObservation>();
	readonly #live = new Map<string, { ref: AgentRef; unsubscribe: () => void }>();
	readonly #children = new Map<string, OwnedNativeChild>();
	readonly #toolOwners = new Map<string, string>();
	readonly #unsubscribers: Array<() => void>;
	#binding = "";
	#rootId = "";
	#rootFile: string | undefined;
	#revision = 0;
	#projectionKey = "";
	#disposed = false;

	constructor(session: AgentSession) {
		this.#session = session;
		const registry = session.agentRegistry;
		if (!registry) throw new Error("Native child registry is unavailable");
		this.#registry = registry;
		this.#rebind();
		const bus = session.subagentEventBus;
		this.#unsubscribers = [
			registry.onChange(({ ref }) => {
				this.#rebind();
				let owned = this.#owns(ref) || this.#live.has(ref.id);
				if (!owned)
					for (const child of this.#children.values()) {
						if (child.nativeAgentId === ref.id) {
							owned = true;
							break;
						}
					}
				if (owned) this.#notify(ref.session?.sessionManager.getSessionId());
			}),
			...(bus
				? [
						bus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, payload => this.#observe(payload, false)),
						bus.on(TASK_SUBAGENT_PROGRESS_CHANNEL, payload => this.#observe(payload, true)),
					]
				: []),
		];
	}

	#rebind(): void {
		const manager = this.#session.sessionManager;
		const rootId = manager.getSessionId();
		const rootFile = manager.getSessionFile();
		const binding = JSON.stringify([rootId, rootFile, manager.getCwd()]);
		if (binding === this.#binding) return;
		const previous = this.#rootId;
		this.#binding = binding;
		this.#rootId = rootId;
		this.#rootFile = rootFile;
		this.#observations.clear();
		this.#children.clear();
		this.#toolOwners.clear();
		this.#projectionKey = "";
		for (const live of this.#live.values()) live.unsubscribe();
		this.#live.clear();
		this.#revision++;
		if (previous) this.#notify(previous);
	}

	#assert(context: WebGuiServiceContext, binding?: string): void {
		if (
			this.#disposed ||
			assertNativeChat(context) !== this.#session ||
			this.#session.agentRegistry !== this.#registry
		)
			throw new Error("Native child owner is unavailable");
		this.#rebind();
		if (binding !== undefined && binding !== this.#binding) throw new Error("Native child owner changed during read");
	}

	#owns(ref: AgentRef): boolean {
		const file = ref.sessionFile;
		return (
			ref.kind === "sub" &&
			!!this.#rootFile &&
			!!file &&
			!sameFile(file, this.#rootFile) &&
			sessionFileBelongsToRoot(file, this.#rootFile) &&
			(!ref.session || sameFile(ref.session.sessionManager.getSessionFile() ?? "", file))
		);
	}

	async #contained(file: string, rootFile: string, live: boolean): Promise<boolean> {
		try {
			const realRoot = await fs.realpath(rootFile.slice(0, -6));
			let realFile: string;
			try {
				realFile = await fs.realpath(file);
			} catch (error) {
				if (!live || !isEnoent(error)) throw error;
				// A native child allocates its transcript before the first message is durable.
				realFile = path.join(await fs.realpath(path.dirname(file)), path.basename(file));
			}
			const relative = path.relative(realRoot, realFile);
			return (
				relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
			);
		} catch (error) {
			if (isEnoent(error)) return false;
			throw error;
		}
	}

	async #liveInfo(ref: AgentRef, file: string): Promise<SessionInfo | undefined> {
		const session = ref.session;
		if (!session) return undefined;
		const messages = session.messages;
		const firstUser = messages.find(message => message.role === "user");
		let size: number;
		try {
			size = (await fs.stat(file)).size;
		} catch (error) {
			if (!isEnoent(error)) throw error;
			size = 0; // Allocated native transcript has not been materialized yet.
		}
		return {
			id: session.sessionManager.getSessionId(),
			path: file,
			cwd: session.sessionManager.getCwd(),
			created: new Date(ref.createdAt),
			modified: new Date(ref.lastActivity),
			messageCount: messages.length,
			size,
			firstMessage: firstUser?.role === "user" ? textContent(firstUser.content, "\n") : "",
			allMessagesText: messages
				.flatMap(message =>
					message.role === "user" || message.role === "assistant" ? [textContent(message.content, "\n")] : [],
				)
				.join("\n"),
		};
	}

	#notify(childId?: string): void {
		if (this.#disposed) return;
		this.#revision++;
		const ids = new Set([this.#rootId, ...this.#children.keys()]);
		if (childId) ids.add(childId);
		for (const listener of this.#listeners) listener({ rootSessionId: this.#rootId, sessionIds: [...ids] });
	}

	#observe(payload: unknown, progress: boolean): void {
		if (this.#disposed || !isRecord(payload)) return;
		this.#rebind();
		const data = progress ? payload.progress : payload;
		if (!isRecord(data) || typeof data.id !== "string" || typeof payload.sessionFile !== "string") return;
		const ref = this.#registry.get(data.id);
		if (!ref || !this.#owns(ref) || !sameFile(ref.sessionFile!, payload.sessionFile)) return;
		const previous = this.#observations.get(ref.id);
		if (previous && previous.generation !== ref.generation && data.status !== "started") return;
		const current =
			previous?.generation === ref.generation && sameFile(previous.file, payload.sessionFile) ? previous : undefined;
		const call = typeof payload.parentToolCallId === "string" ? payload.parentToolCallId : undefined;
		if (current?.toolCallId && call && current.toolCallId !== call && data.status !== "started") return;
		const status = data.status;
		let sessionId = ref.session?.sessionManager.getSessionId();
		if (!sessionId)
			for (const child of this.#children.values()) {
				if (child.nativeAgentId === ref.id && child.generation === ref.generation) {
					sessionId = child.childSessionId;
					break;
				}
			}
		const observation: ChildObservation = {
			...current,
			generation: ref.generation,
			file: payload.sessionFile,
			sessionId,
			toolCallId: call ?? current?.toolCallId,
			agent: typeof payload.agent === "string" ? payload.agent : current?.agent,
			summary:
				typeof data.lastIntent === "string"
					? data.lastIntent
					: typeof payload.description === "string"
						? payload.description
						: current?.summary,
		};
		if (progress)
			observation.progress = {
				currentTool: typeof data.currentTool === "string" ? data.currentTool : undefined,
				lastIntent: typeof data.lastIntent === "string" ? data.lastIntent : undefined,
				completionPercent: typeof data.completionPercent === "number" ? data.completionPercent : undefined,
				tokens: typeof data.tokens === "number" ? data.tokens : undefined,
				cost: typeof data.cost === "number" ? data.cost : undefined,
				durationMs: typeof data.durationMs === "number" ? data.durationMs : undefined,
			};
		if (status === "started" || status === "running" || status === "pending") {
			observation.status = "started";
			observation.endedAt = undefined;
		} else if (status === "completed" || status === "failed" || status === "aborted") {
			observation.status = status;
			observation.endedAt = Date.now();
		}
		this.#observations.set(ref.id, observation);
		this.#notify(ref.session?.sessionManager.getSessionId());
	}

	async #transcriptFiles(context: WebGuiServiceContext, rootFile: string, binding: string): Promise<Set<string>> {
		const files = new Set<string>();
		const visit = async (dir: string): Promise<void> => {
			this.#assert(context, binding);
			const entries = await fs.readdir(dir, { withFileTypes: true }).catch(error => {
				if (isEnoent(error)) return [];
				throw error;
			});
			const directories = new Set(entries.filter(entry => entry.isDirectory()).map(entry => entry.name));
			for (const entry of entries) {
				if (
					!entry.isFile() ||
					!entry.name.endsWith(".jsonl") ||
					entry.name.includes(".bak") ||
					isAdvisorTranscriptName(entry.name)
				)
					continue;
				const file = path.join(dir, entry.name);
				if (!(await this.#contained(file, rootFile, false))) continue;
				files.add(file);
				const id = entry.name.slice(0, -6);
				if (directories.has(id)) await visit(path.join(dir, id));
			}
		};
		await visit(rootFile.slice(0, -6));
		return files;
	}

	async #refresh(context: WebGuiServiceContext): Promise<void> {
		this.#assert(context);
		const binding = this.#binding;
		const rootFile = this.#rootFile;
		if (!rootFile) return;
		// Native IDs are registry-local. Disk histories remain root-owned even when
		// another root currently owns the same basename in the shared registry.
		// Enumerate the native transcript tree without registering/reviving anything.
		const files = await this.#transcriptFiles(context, rootFile, binding);
		for (const ref of this.#registry.list()) if (this.#owns(ref)) files.add(ref.sessionFile!);
		const children: Omit<OwnedNativeChild, "parentSessionId">[] = [];
		for (const file of files) {
			const id = path.basename(file, ".jsonl");
			const current = this.#registry.get(id);
			const ref = current && this.#owns(current) && sameFile(current.sessionFile!, file) ? current : undefined;
			if (current?.kind === "advisor" && current.sessionFile && sameFile(current.sessionFile, file)) continue;
			if (!(await this.#contained(file, rootFile, ref?.session != null))) continue;
			const info = (await readSessionInfo(file)) ?? (ref ? await this.#liveInfo(ref, file) : undefined);
			this.#assert(context, binding);
			if (!info || info.id === this.#rootId || (ref && (this.#registry.get(id) !== ref || !this.#owns(ref))))
				continue;
			const handle = ref?.session ?? null;
			if (handle && handle.sessionManager.getSessionId() !== info.id) continue;
			const observation = this.#observations.get(id);
			const observed =
				observation?.sessionId === info.id &&
				sameFile(observation.file, file) &&
				(!ref || observation.generation === ref.generation)
					? observation
					: undefined;
			const status =
				ref && this.#registry.isRunning(ref)
					? handle?.agent.isPaused
						? "waiting"
						: "running"
					: ref?.status === "aborted" || observed?.status === "aborted"
						? "cancelled"
						: observed?.status === "completed"
							? "success"
							: observed?.status === "failed"
								? "failed"
								: terminalStatus(info);
			const parentFile = `${path.dirname(file)}.jsonl`;
			children.push({
				childSessionId: info.id,
				rootSessionId: this.#rootId,
				nativeAgentId: id,
				nativeParentAgentId:
					ref?.parentId ??
					(sameFile(parentFile, rootFile) ? this.#session.getAgentId() : path.basename(path.dirname(file))),
				generation: ref?.generation,
				parentToolCallId: observed?.toolCallId,
				sessionFile: file,
				session: handle,
				info,
				status,
				subagentType: observed?.agent ?? ref?.history?.agent ?? "subagent",
				summary: observed?.summary ?? ref?.activity,
				startedAt: ref?.createdAt ?? info.created.getTime(),
				progress: observed?.progress,
				endedAt:
					status === "running" || status === "waiting"
						? undefined
						: (observed?.endedAt ?? ref?.lifecycle?.terminalAt),
			});
		}
		children.sort((a, b) => a.sessionFile.length - b.sessionFile.length);
		const byFile = new Map(
			children.map(child => [normalizePathForComparison(path.resolve(child.sessionFile)), child]),
		);
		const resolvedChildren = new Map<string, OwnedNativeChild>();
		const links = new Map<string, Map<string, ChildLink>>();
		links.set(this.#rootId, taskLinks(this.#session.messages));
		for (const child of children) {
			const parentFile = `${path.dirname(child.sessionFile)}.jsonl`;
			const parent = byFile.get(normalizePathForComparison(path.resolve(parentFile)));
			const parentId = sameFile(parentFile, rootFile) ? this.#rootId : parent?.childSessionId;
			if (!parentId || (parent && !resolvedChildren.has(parentId))) continue;
			if (parent && !links.has(parentId)) {
				const messages = parent.session?.messages ?? (await readRpcSubagentTranscript(parent.sessionFile)).messages;
				links.set(parentId, taskLinks(messages));
			}
			const candidateLink = links.get(parentId)?.get(child.nativeAgentId);
			let link = candidateLink && candidateLink.timestamp >= child.startedAt ? candidateLink : undefined;
			if (link) {
				const key = JSON.stringify([parentId, link.toolCallId, child.nativeAgentId]);
				const owner = this.#toolOwners.get(key);
				if (owner && owner !== child.childSessionId) link = undefined;
				else this.#toolOwners.set(key, child.childSessionId);
			}
			const resolved: OwnedNativeChild = {
				...child,
				parentSessionId: parentId,
				parentToolCallId: child.parentToolCallId ?? link?.toolCallId,
				subagentType: child.subagentType === "subagent" ? (link?.agent ?? child.subagentType) : child.subagentType,
				summary: child.summary ?? link?.summary,
				status:
					child.status === "running" ||
					child.status === "waiting" ||
					child.status === "blocked" ||
					child.status === "cancelled"
						? child.status
						: (link?.status ?? child.status),
			};
			resolvedChildren.set(child.childSessionId, resolved);
			const live = this.#live.get(child.nativeAgentId);
			const ref = this.#registry.get(child.nativeAgentId);
			if (ref && ref.generation === child.generation && child.session && live?.ref !== ref) {
				live?.unsubscribe();
				const offMessages = child.session.subscribe(() => {
					this.#rebind();
					if (this.#registry.get(ref.id) === ref && this.#owns(ref)) this.#notify(child.childSessionId);
				});
				const offState = child.session.subscribeRunState(() => {
					this.#rebind();
					if (this.#registry.get(ref.id) === ref && this.#owns(ref)) this.#notify(child.childSessionId);
				});
				this.#live.set(ref.id, {
					ref,
					unsubscribe: () => {
						offMessages();
						offState();
					},
				});
			}
		}
		this.#assert(context, binding);
		this.#children.clear();
		for (const [id, child] of resolvedChildren) {
			const ref = this.#registry.get(child.nativeAgentId);
			if (child.generation === undefined || (ref?.generation === child.generation && this.#owns(ref)))
				this.#children.set(id, child);
		}
		const projectionKey = JSON.stringify(
			[...this.#children.values()]
				.map(child => [
					child.childSessionId,
					child.parentSessionId,
					child.parentToolCallId,
					child.generation,
					child.status,
					child.info.modified.getTime(),
				])
				.sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
		);
		if (projectionKey !== this.#projectionKey) {
			this.#projectionKey = projectionKey;
			this.#revision++;
		}
		for (const [id, live] of this.#live) {
			if (this.#registry.get(id) !== live.ref || !live.ref.session || !this.#owns(live.ref)) {
				live.unsubscribe();
				this.#live.delete(id);
			}
		}
	}

	subscribe(listener: (change: NativeChildChange) => void): () => void {
		if (this.#disposed) throw new Error("Native child directory is disposed");
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	async resolve(context: WebGuiServiceContext, childSessionId: string): Promise<OwnedNativeChild> {
		await this.#refresh(context);
		const child = this.#children.get(childSessionId);
		if (!child) throw new Error(`Native child conversation not found: ${childSessionId}`);
		return child;
	}

	async info(context: WebGuiServiceContext, childSessionId: string): Promise<SessionInfo> {
		return (await this.resolve(context, childSessionId)).info;
	}

	async messages(context: WebGuiServiceContext, childSessionId: string): Promise<AgentMessage[]> {
		const child = await this.resolve(context, childSessionId);
		const binding = this.#binding;
		let messages: AgentMessage[];
		if (child.session) {
			const saved = child.session.messages;
			const stream = child.session.agent.state.streamMessage;
			messages = stream && !saved.includes(stream) ? [...saved, stream] : saved;
		} else {
			messages = (await readRpcSubagentTranscript(child.sessionFile)).messages;
			for (const message of messages) if (message.role === "assistant") normalizeAssistantUsage(message);
		}
		this.#assert(context, binding);
		if (child.session) {
			const ref = this.#registry.get(child.nativeAgentId);
			if (!ref || ref.generation !== child.generation || ref.session !== child.session || !this.#owns(ref))
				throw new Error("Native child generation changed during read");
		} else if (
			(await readSessionHeaderId(child.sessionFile)) !== childSessionId ||
			!this.#rootFile ||
			!(await this.#contained(child.sessionFile, this.#rootFile, false))
		) {
			throw new Error("Native child transcript changed during read");
		}
		this.#assert(context, binding);
		return messages;
	}

	async list(
		context: WebGuiServiceContext,
		parentSessionId: string,
		endedCursor?: string,
		endedLimit = 20,
	): Promise<ZCodeSessionSubagentsResult> {
		await this.#refresh(context);
		if (parentSessionId !== this.#rootId && !this.#children.has(parentSessionId))
			throw new Error("Native parent conversation not found");
		const offset = endedCursor === undefined ? 0 : Number(endedCursor);
		if (!Number.isSafeInteger(offset) || offset < 0 || (endedCursor !== undefined && String(offset) !== endedCursor))
			throw new TypeError("Invalid native child cursor");
		if (!Number.isSafeInteger(endedLimit) || endedLimit < 1 || endedLimit > 100)
			throw new TypeError("Invalid native child page size");
		const children = [...this.#children.values()].filter(child => child.parentSessionId === parentSessionId);
		children.sort((a, b) => a.startedAt - b.startedAt || a.childSessionId.localeCompare(b.childSessionId));
		const running: ZCodeSessionRunningSubagent[] = [];
		const ended: ZCodeSessionEndedSubagent[] = [];
		for (const child of children) {
			const base = {
				childSessionId: child.childSessionId,
				agentId: child.nativeAgentId,
				toolCallId: child.parentToolCallId,
				subagentType: child.subagentType,
				title: child.info.title || child.nativeAgentId,
				summary: child.summary,
				startedAt: child.startedAt,
			};
			if (child.status === "running" || child.status === "waiting" || child.status === "blocked")
				running.push({ ...base, status: child.status });
			else ended.push({ ...base, status: child.status, endedAt: child.endedAt });
		}
		return {
			revision: this.#revision,
			childSessionIds: children.map(child => child.childSessionId),
			running,
			ended: {
				total: ended.length,
				items: ended.slice(offset, offset + endedLimit),
				nextCursor: offset + endedLimit < ended.length ? String(offset + endedLimit) : undefined,
			},
		};
	}

	async projection(context: WebGuiServiceContext, parentSessionId: string): Promise<SubagentProjectionState> {
		const result = await this.list(context, parentSessionId);
		return {
			revision: result.revision,
			childSessionIds: result.childSessionIds,
			running: result.running,
			endedTotal: result.ended.total,
		};
	}

	async childSessionIdsForToolCall(
		context: WebGuiServiceContext,
		parentSessionId: string,
		toolCallId: string,
	): Promise<string[]> {
		await this.#refresh(context);
		return [...this.#children.values()]
			.filter(child => child.parentSessionId === parentSessionId && child.parentToolCallId === toolCallId)
			.map(child => child.childSessionId);
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		for (const unsubscribe of this.#unsubscribers) unsubscribe();
		for (const live of this.#live.values()) live.unsubscribe();
		this.#live.clear();
		this.#children.clear();
		this.#observations.clear();
		this.#toolOwners.clear();
		this.#listeners.clear();
	}
}
