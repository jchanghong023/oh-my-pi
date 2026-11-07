import type { GuestFrame, HostFrame, ImageContent } from "@oh-my-pi/pi-wire";
import type {
	DevActionIntent,
	DevActionPreview,
	DevActionResult,
	DevGitTarget,
	DevMaterialRef,
	DevNativeUiRequest,
	DevNativeUiResponse,
	DevNativeCommand,
	DevRequirementSnapshot,
	DevSessionTarget,
	SpecDocument,
	DevInputTarget,
	DevGuestSessionTarget,
	DevNativeUiStateEvent,
	DevComposerPort as ComposerPort,
	DevSubmitResult as SubmitResult,
} from "../../../coding-agent/src/spec-driven/types";
import type { AgentPort, SessionTransport } from "../lib/client";
import type { TextPredictionPort } from "../components/shell/PredictiveTextarea";
import { SessionReplica } from "../lib/client";
import { reduceNativeView } from "./native-state";
import { workbenchHttp } from "./legacy-http";
import type { NativeViewState } from "./native-state";

export type NativeCommand = DevNativeCommand;

export interface OperationConfirmation {
	operationId: string;
	confirmationToken: string;
	userReply: string;
}

class WorkbenchHttpError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "WorkbenchHttpError";
	}
}
class WorkbenchAdmissionError extends Error {}
function admissionFailure(error: unknown, message: string): SubmitResult {
	return error instanceof WorkbenchAdmissionError ||
		(error instanceof WorkbenchHttpError && error.status >= 400 && error.status < 500)
		? { kind: "rejected", message: error.message }
		: { kind: "unknown", message: `${message}: ${String(error)}. Not retried automatically.` };
}

export function inputTargetIdentity(target: DevInputTarget | null): string {
	if (!target) return "unprepared";
	const owner = "kind" in target ? `collab:${target.roomId}:${target.peerId}` : (target.requirementId ?? "local");
	return `${owner}:${target.sessionId}:${target.generation}`;
}
export interface WorkbenchState {
	requirements: readonly DevRequirementSnapshot[];
	connected: boolean;
	error: string | null;
	nativeUi: readonly DevNativeUiRequest[];
	joined: {
		peerId: string;
		roomId: string;
		canWrite: boolean;
		nativeEditorSupported: boolean;
		target: DevGuestSessionTarget;
		ended: boolean;
	} | null;
	unknownInput: string | null;
	statuses: readonly string[];
	composerPrediction: { target: DevInputTarget; choices: readonly string[] } | null;
	nativeViews: ReadonlyMap<string, NativeViewState>;
	/** UI invalidation only; never a record or material byte version. */
	materialRefresh: number;
}
type WorkbenchEvent =
	| HostFrame
	| { t: "requirements"; requirements: DevRequirementSnapshot[] }
	| { t: "requirement"; snapshot: DevRequirementSnapshot }
	| { t: "native-ui"; request: DevNativeUiRequest | null }
	| { t: "native-ui-end"; requestId: string }
	| { t: "collab-target"; target: DevGuestSessionTarget }
	| { t: "composer-prediction"; target: DevInputTarget; choices: readonly string[] }
	| { t: "native-status"; message: string }
	| DevNativeUiStateEvent;

/** No browser crypto or second execution queue: all mutations go to this same-origin host. */
export class WorkbenchClient {
	readonly #base: URL;
	readonly #listeners = new Set<() => void>();
	#snapshot: WorkbenchState = {
		requirements: [],
		connected: false,
		error: null,
		nativeUi: [],
		joined: null,
		unknownInput: null,
		composerPrediction: null,
		statuses: [],
		nativeViews: new Map(),
		materialRefresh: 0,
	};
	#socket: WebSocket | null = null;
	#timer: Timer | null = null;
	#closed = false;
	#selectedId: string | null = null;
	#selection = 0;
	#browserId: string | null = null;
	#bootstrap: Promise<void> | null = null;
	#localTarget: DevSessionTarget | null = null;
	#sessionEnded = false;
	#predictionRevision = 0;
	#replica: SessionReplica;
	readonly #transport: SessionTransport;
	readonly #editorDrafts = new Map<string, { target: DevInputTarget; text: string }>();
	readonly #editorTimers = new Map<string, Timer>();
	readonly #editorSends = new Map<string, Promise<void>>();
	readonly #editorSynced = new Map<string, string>();
	readonly #editorFailures = new Set<string>();
	readonly #editorSubmissions = new Set<string>();
	readonly textPrediction: TextPredictionPort = {
		complete: (text, cursor) => this.request("api/text-prediction", { text, cursor }),
		feedback: (text, cursor, suffix, accepted) => {
			void this.request("api/text-prediction", { text, cursor, suffix, accepted }).catch(() => {});
		},
	};

	constructor(base: URL = new URL("./", window.location.href)) {
		this.#base = base;
		this.#transport = {
			connect: () => this.#openSocket(),
			close: () => {
				this.#sessionEnded = true;
				this.#publish({
					composerPrediction: null,
					joined: this.#snapshot.joined ? { ...this.#snapshot.joined, ended: true } : null,
					error: "Native session ended. No input is replayed and no next Agent or room is followed.",
				});
			},
			send: frame => this.#sendFrame(frame),
		};
		this.#replica = new SessionReplica(this.#transport, "workbench");
	}
	get replica(): SessionReplica {
		return this.#replica;
	}
	get initialized(): boolean {
		return this.#browserId !== null;
	}
	getSnapshot = (): WorkbenchState => this.#snapshot;
	subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	};
	#publish(patch: Partial<WorkbenchState>): void {
		this.#snapshot = { ...this.#snapshot, ...patch };
		if (
			this.#snapshot.composerPrediction &&
			!this.#predictionTargetIsCurrent(this.#snapshot.composerPrediction.target)
		) {
			this.#predictionRevision++;
			this.#snapshot = { ...this.#snapshot, composerPrediction: null };
		}
		for (const listener of this.#listeners) listener();
	}
	url(path: string): URL {
		return new URL(path.replace(/^\//, ""), this.#base);
	}
	ready(): Promise<void> {
		if (this.#bootstrap) return this.#bootstrap;
		const bootstrap = this.request<{ browserId: string }>("api/browser")
			.then(browser => {
				this.#browserId = browser.browserId;
			})
			.catch(error => {
				if (this.#bootstrap === bootstrap) this.#bootstrap = null;
				throw error;
			});
		this.#bootstrap = bootstrap;
		return bootstrap;
	}
	async request<T>(path: string, body?: unknown, method?: string): Promise<T> {
		const route = path.replace(/^\//, "").split("?")[0];
		const verb = method ?? (body === undefined ? "GET" : "POST");
		if (verb !== "GET" && verb !== "HEAD" && route !== "api/collab/leave" && !this.#snapshot.connected)
			throw new WorkbenchAdmissionError("Disconnected; action was not sent");
		if (route !== "api/browser") await this.ready();
		const multipart = body instanceof FormData;
		const response = await workbenchHttp(this.url(path), {
			method: verb,
			contentType: body === undefined || multipart ? undefined : "application/json",
			body: body === undefined ? undefined : multipart ? body : JSON.stringify(body),
		});
		if (!response.ok) {
			const text = response.text;
			let message = text;
			try {
				const value: unknown = JSON.parse(text);
				if (value && typeof value === "object" && "error" in value) message = String(value.error);
			} catch {}
			throw new WorkbenchHttpError(message || `HTTP ${response.status}`, response.status);
		}
		return JSON.parse(response.text) as T;
	}
	async connect(): Promise<void> {
		this.#closed = false;
		if (this.#sessionEnded && !this.#snapshot.joined) {
			const socket = this.#socket;
			this.#socket = null;
			socket?.close();
			this.#selection++;
			this.#publish({ connected: false, nativeUi: [] });
			this.#replica = new SessionReplica(this.#transport, "workbench");
			this.#sessionEnded = false;
		}
		try {
			await this.ready();
			await this.refresh();
			this.#openSocket();
		} catch (error) {
			this.#publish({ error: String(error), connected: false });
		}
	}
	async refresh(): Promise<void> {
		const requirements = await this.request<DevRequirementSnapshot[]>("api/requirements");
		this.#publish({ requirements, error: null });
	}
	select(requirementId: string | null, force = false): void {
		if (this.#snapshot.joined && !force) {
			this.#selectedId = requirementId;
			this.#publish({ error: null });
			return;
		}
		if (!force && this.#selectedId === requirementId && this.#socket) return;
		this.#selectedId = requirementId;
		this.#selection++;
		this.#publish({ connected: false, nativeUi: [] });
		this.#socket?.close();
		this.#socket = null;
		this.#replica.connectionClosed("Viewed session changed", false);
		this.#replica = new SessionReplica(this.#transport, "workbench");
		this.#sessionEnded = false;
		this.#publish({ error: null });
		if (this.#browserId) this.#openSocket();
	}
	#openSocket(): void {
		if (this.#closed || this.#socket) return;
		if (this.#timer !== null) clearTimeout(this.#timer);
		this.#timer = null;
		const selection = this.#selection;
		const url = this.url("api/events");
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		if (this.#selectedId) url.searchParams.set("requirementId", this.#selectedId);
		if (this.#browserId) url.searchParams.set("browserId", this.#browserId);
		const socket = new WebSocket(url.href);
		this.#socket = socket;
		socket.onopen = () => {
			if (this.#socket !== socket) return;
			this.#publish({ connected: true, error: null });
			void this.refresh().catch(error => this.#publish({ error: String(error) }));
		};
		socket.onmessage = event => {
			if (this.#socket !== socket || selection !== this.#selection) return;
			try {
				const frame = JSON.parse(String(event.data)) as WorkbenchEvent;
				switch (frame.t) {
					case "requirements":
						this.#publish({ requirements: frame.requirements });
						break;
					case "requirement": {
						const exists = this.#snapshot.requirements.some(
							item => item.record.requirementId === frame.snapshot.record.requirementId,
						);
						const requirements = exists
							? this.#snapshot.requirements.map(item =>
									item.record.requirementId === frame.snapshot.record.requirementId ? frame.snapshot : item,
								)
							: [...this.#snapshot.requirements, frame.snapshot];
						this.#publish({ requirements });
						const header = this.#replica.getSnapshot().header;
						const recipient = frame.snapshot.runtime?.recipient;
						if (
							!this.#snapshot.joined &&
							frame.snapshot.record.requirementId === this.#selectedId &&
							header &&
							recipient &&
							header.id !== recipient.sessionId
						)
							this.select(this.#selectedId, true);
						break;
					}
					case "native-ui":
						if (frame.request)
							this.#publish({
								nativeUi: [
									...this.#snapshot.nativeUi.filter(item => item.requestId !== frame.request?.requestId),
									frame.request,
								],
							});
						break;
					case "native-ui-end":
						this.#publish({
							nativeUi: this.#snapshot.nativeUi.filter(item => item.requestId !== frame.requestId),
						});
						break;
					case "composer-prediction":
						if (this.#predictionTargetIsCurrent(frame.target)) {
							this.#predictionRevision++;
							this.#publish({ composerPrediction: { target: frame.target, choices: frame.choices } });
						}
						break;
					case "native-status":
						this.#publish({ statuses: [...this.#snapshot.statuses.slice(-49), frame.message] });
						break;
					case "native-ui-state":
						this.#applyNativeState(frame);
						break;
					case "collab-target": {
						const joined = this.#snapshot.joined;
						if (
							joined &&
							joined.roomId === frame.target.roomId &&
							joined.target.sessionId === frame.target.sessionId &&
							!this.#sessionEnded
						)
							this.#publish({ joined: { ...joined, target: frame.target } });
						else if (joined)
							this.#replica.connectionClosed("Shared session changed; explicit join required", false);
						break;
					}
					default:
						if (!this.#sessionEnded) {
							this.#replica.receiveFrame(frame);
							if (frame.t === "welcome") {
								this.#predictionRevision++;
								this.#publish({ composerPrediction: null });
							}
							if (
								this.#snapshot.composerPrediction &&
								!this.#predictionTargetIsCurrent(this.#snapshot.composerPrediction.target)
							)
								this.#publish({ composerPrediction: null });
							if (
								!this.#snapshot.joined &&
								this.#selectedId !== null &&
								frame.t === "event" &&
								frame.event.type === "tool_execution_end"
							)
								this.#publish({ materialRefresh: this.#snapshot.materialRefresh + 1 });
						}
						break;
				}
			} catch (error) {
				this.#publish({ error: `Invalid host event: ${String(error)}` });
			}
		};
		socket.onclose = () => {
			if (this.#socket !== socket) return;
			this.#socket = null;
			for (const timer of this.#editorTimers.values()) clearTimeout(timer);
			this.#editorTimers.clear();
			const wasJoined = this.#snapshot.joined !== null;
			this.#publish({
				connected: false,
				joined: null,
				nativeUi: [],
				error: wasJoined
					? "Shared session disconnected. Join again explicitly; no next Agent was joined."
					: "Disconnected. Reconnecting facts only; no input or action will be replayed.",
			});
			this.#replica.connectionClosed("Connection lost", !wasJoined);
			// Restore browser facts only; the ended guest replica still requires an explicit join.
			if (!this.#closed && selection === this.#selection)
				this.#timer = setTimeout(() => {
					this.#timer = null;
					if (selection === this.#selection) this.#openSocket();
				}, 1500);
		};
	}
	#predictionTargetIsCurrent(target: DevInputTarget): boolean {
		return (
			!this.#closed &&
			!this.#sessionEnded &&
			this.#snapshot.connected &&
			this.#snapshot.joined?.canWrite !== false &&
			!this.#replica.getSnapshot().readOnly &&
			inputTargetIdentity(target) === inputTargetIdentity(this.target())
		);
	}
	/** Reads the native controller's existing choices; never starts a prediction/model request. */
	async refreshComposerPrediction(target: DevInputTarget): Promise<void> {
		if (!this.#predictionTargetIsCurrent(target)) return;
		const socket = this.#socket;
		const selection = this.#selection;
		const revision = this.#predictionRevision;
		const result = await this.request<{ choices: readonly string[] }>("api/composer-prediction", { target });
		if (
			socket === this.#socket &&
			selection === this.#selection &&
			revision === this.#predictionRevision &&
			this.#predictionTargetIsCurrent(target)
		)
			this.#publish({ composerPrediction: { target, choices: result.choices } });
	}
	composerPredictionFeedback(target: DevInputTarget, event: "shown" | "accepted", rank?: number): void {
		if (!this.#predictionTargetIsCurrent(target)) return;
		// Feedback responses must not overwrite a newer pushed prediction or another session.
		void this.request("api/composer-prediction", { target, event, rank }).catch(() => {});
	}
	nativeView(target: DevInputTarget | null): NativeViewState | undefined {
		if (!target) return undefined;
		return this.#snapshot.nativeViews.get(inputTargetIdentity(target));
	}
	#applyNativeState(event: DevNativeUiStateEvent): void {
		const current = this.target();
		const target =
			current && "kind" in current && current.sessionId === event.target.sessionId ? current : event.target;
		const identity = inputTargetIdentity(target);
		const draft = this.#editorDrafts.get(identity)?.text ?? "";
		const view = reduceNativeView(this.#snapshot.nativeViews.get(identity), event, identity, draft, Date.now());
		if ((event.method === "setEditorText" || event.method === "pasteToEditor") && view.editorUpdate) {
			this.#editorDrafts.set(identity, { target, text: view.editorUpdate.text });
			this.#editorSynced.set(identity, view.editorUpdate.text);
			const timer = this.#editorTimers.get(identity);
			if (timer !== undefined) clearTimeout(timer);
			this.#editorTimers.delete(identity);
		}
		this.#publish({ nativeViews: new Map(this.#snapshot.nativeViews).set(identity, view) });
		if (
			(event.method === "rerenderMessage" || event.method === "refreshTranscript") &&
			current &&
			current.sessionId === event.target.sessionId
		) {
			void this.refreshNativeTranscript(current).catch(error => this.#publish({ error: String(error) }));
		}
	}
	#supportsNativeEditor(target: DevInputTarget): boolean {
		if (!("kind" in target)) return true;
		const joined = this.#snapshot.joined;
		return (
			joined?.nativeEditorSupported === true &&
			joined.canWrite &&
			inputTargetIdentity(joined.target) === inputTargetIdentity(target)
		);
	}
	rememberDraft(target: DevInputTarget, text: string, edited = true): void {
		const identity = inputTargetIdentity(target);
		this.#editorDrafts.set(identity, { target, text });
		const timer = this.#editorTimers.get(identity);
		if (timer !== undefined) clearTimeout(timer);
		this.#editorTimers.delete(identity);
		if (
			!edited ||
			!this.#supportsNativeEditor(target) ||
			this.#editorSubmissions.has(identity) ||
			this.#editorFailures.has(identity) ||
			this.#editorSynced.get(identity) === text ||
			!this.#snapshot.connected
		)
			return;
		this.#editorTimers.set(
			identity,
			setTimeout(() => {
				this.#editorTimers.delete(identity);
				void this.flushEditor(target).catch(error =>
					this.#publish({ error: `Native editor sync failed: ${String(error)}` }),
				);
			}, 200),
		);
	}
	async flushEditor(target: DevInputTarget): Promise<void> {
		if (!this.#supportsNativeEditor(target)) return;
		const identity = inputTargetIdentity(target);
		if (this.#editorSubmissions.has(identity))
			throw new WorkbenchAdmissionError("Input submission is in progress; editor input was not queued");
		const timer = this.#editorTimers.get(identity);
		if (timer !== undefined) clearTimeout(timer);
		this.#editorTimers.delete(identity);
		const previous = this.#editorSends.get(identity) ?? Promise.resolve();
		const send = previous
			.catch(() => {})
			.then(async () => {
				const draft = this.#editorDrafts.get(identity);
				if (!draft || this.#editorSynced.get(identity) === draft.text) return;
				const invalid = this.#targetError(target);
				if (!this.#snapshot.connected || this.#sessionEnded || invalid)
					throw new Error(invalid ?? "Native editor target is disconnected or ended");
				const result = await this.request<{ updated: boolean }>("api/native-editor", { target, text: draft.text });
				if (!result.updated) throw new Error("Native host did not update the editor");
				this.#editorSynced.set(identity, draft.text);
				this.#editorFailures.delete(identity);
			});
		this.#editorSends.set(identity, send);
		try {
			await send;
		} catch (error) {
			this.#editorFailures.add(identity);
			throw error;
		} finally {
			if (this.#editorSends.get(identity) === send) this.#editorSends.delete(identity);
		}
	}
	#targetQuery(target: DevInputTarget): URLSearchParams {
		const query = new URLSearchParams({ sessionId: target.sessionId, generation: String(target.generation) });
		if ("kind" in target) {
			query.set("kind", target.kind);
			query.set("peerId", target.peerId);
			query.set("roomId", target.roomId);
		} else if (target.requirementId) query.set("requirementId", target.requirementId);
		return query;
	}
	async refreshNativeTranscript(target: DevInputTarget): Promise<void> {
		const replica = this.#replica;
		const known = new Set(replica.getSnapshot().entries.map(entry => entry.id));
		const frames = await this.request<HostFrame[]>(`api/native-snapshot?${this.#targetQuery(target)}`);
		if (replica === this.#replica && inputTargetIdentity(this.target()) === inputTargetIdentity(target))
			replica.refreshHistory(frames, known);
	}
	#sendFrame(frame: GuestFrame): void {
		if (frame.t === "hello") return;
		const target = this.target();
		if (!target) return;
		void this.wireMutation(target, frame).then(result => {
			if (result.kind === "rejected") this.#publish({ error: result.message });
		});
	}
	close(): void {
		this.#closed = true;
		for (const timer of this.#editorTimers.values()) clearTimeout(timer);
		this.#editorTimers.clear();
		if (this.#timer !== null) clearTimeout(this.#timer);
		this.#timer = null;
		const socket = this.#socket;
		this.#socket = null;
		socket?.close();
		this.#publish({ connected: false, composerPrediction: null });
		this.#replica.connectionClosed("Page subscription closed", false);
	}
	target(): DevInputTarget | null {
		if (this.#snapshot.joined) return this.#snapshot.joined.target;
		if (this.#selectedId === null) return this.#localTarget;
		const runtime = this.#snapshot.requirements.find(item => item.record.requirementId === this.#selectedId)?.runtime;
		return runtime?.recipient
			? { requirementId: this.#selectedId, sessionId: runtime.recipient.sessionId, generation: runtime.generation }
			: null;
	}
	#targetError(target: DevInputTarget | { requirementId: string | null }): string | null {
		const joined = this.#snapshot.joined;
		if (joined && (!("kind" in target) || inputTargetIdentity(target) !== inputTargetIdentity(joined.target)))
			return "This browser is joined to a distinct Collab target; local or stale-target input was not sent";
		if (!joined && "kind" in target) return "This guest target is no longer joined; join explicitly again";
		return null;
	}
	composer(target: DevInputTarget): ComposerPort {
		return {
			sendPrompt: (text, images) => this.submitInput(target, text, images),
			sendUiResponse: (reqId, value) => this.wireMutation(target, { t: "ui-response", reqId, value }),
			sendAbort: () => this.wireMutation(target, { t: "abort" }),
		};
	}
	async submitInputForSelection(text: string, images?: readonly ImageContent[]): Promise<SubmitResult> {
		const target = this.target();
		return this.submitInput(target ?? { requirementId: this.#selectedId }, text, images);
	}
	async submitInput(
		target: DevInputTarget | { requirementId: string | null },
		text: string,
		images?: readonly ImageContent[],
	): Promise<SubmitResult> {
		if (!this.#snapshot.connected) return { kind: "rejected", message: "Disconnected; input was not sent" };
		if (this.#sessionEnded) return { kind: "rejected", message: "Native session ended; no next Agent was joined" };
		const targetError = this.#targetError(target);
		if (targetError) return { kind: "rejected", message: targetError };
		let requestId: string | null = null;
		const editorTarget = "sessionId" in target && this.#supportsNativeEditor(target) ? target : null;
		const identity = editorTarget ? inputTargetIdentity(editorTarget) : null;
		const draft = identity ? this.#editorDrafts.get(identity) : undefined;
		if (identity && this.#editorSubmissions.has(identity))
			return { kind: "rejected", message: "Input submission is already in progress" };
		try {
			let editorSend: Promise<void> | undefined;
			if (editorTarget && identity) {
				const timer = this.#editorTimers.get(identity);
				if (timer !== undefined) clearTimeout(timer);
				this.#editorTimers.delete(identity);
				// Slash parsing reads the editor; ordinary prompts already carry their text in /api/input.
				editorSend = text.trimStart().startsWith("/")
					? this.flushEditor(editorTarget)
					: this.#editorSends.get(identity);
				this.#editorSubmissions.add(identity);
			}
			// Drain an editor write already in flight before the host acquires its input control boundary.
			await editorSend;
			const prepared = await this.request<{ requestId: string; target: DevInputTarget }>(
				"api/input-preview",
				"sessionId" in target ? { target } : target,
			);
			requestId = prepared.requestId;
			if (prepared.target && "requirementId" in prepared.target && prepared.target.requirementId === null)
				this.#localTarget = prepared.target;
			const result = await this.request<SubmitResult>("api/input", { requestId, text, images });
			if (
				result.kind === "accepted" &&
				identity &&
				draft &&
				draft.text.trim() === text.trim() &&
				this.#editorDrafts.get(identity) === draft
			)
				this.#editorDrafts.delete(identity);
			if (result.kind === "unknown") this.#publish({ unknownInput: requestId });
			return result;
		} catch (error) {
			if (!requestId) return { kind: "rejected", message: String(error) };
			if (
				error instanceof WorkbenchAdmissionError ||
				(error instanceof WorkbenchHttpError && error.status >= 400 && error.status < 500)
			)
				return { kind: "rejected", message: error.message };
			this.#publish({ unknownInput: requestId });
			return {
				kind: "unknown",
				message: `Host acceptance unknown: ${String(error)}. Inspect receipt before resending.`,
			};
		} finally {
			if (identity) this.#editorSubmissions.delete(identity);
		}
	}
	async inspectInput(): Promise<SubmitResult> {
		if (!this.#snapshot.unknownInput) return { kind: "rejected", message: "No uncertain input receipt" };
		const result = await this.request<SubmitResult>(`api/inputs/${encodeURIComponent(this.#snapshot.unknownInput)}`);
		if (result.kind !== "unknown") this.#publish({ unknownInput: null });
		return result;
	}
	async wireMutation(target: DevInputTarget, frame: GuestFrame): Promise<SubmitResult> {
		if (!this.#snapshot.connected) return { kind: "rejected", message: "Disconnected; response was not sent" };
		if (this.#sessionEnded) return { kind: "rejected", message: "Native session ended; command not sent" };
		const targetError = this.#targetError(target);
		if (targetError) return { kind: "rejected", message: targetError };
		try {
			return await this.request<SubmitResult>("api/native-frame", { target, frame });
		} catch (error) {
			return admissionFailure(error, "Native admission unconfirmed");
		}
	}
	agents(target: DevInputTarget): AgentPort {
		return {
			sendAgentCmd: (cmd, agentId, text) => this.wireMutation(target, { t: "agent-cmd", cmd, agentId, text }),
			fetchTranscript: (id, fromByte) => {
				const current = this.target();
				if (!current || current.sessionId !== target.sessionId || current.generation !== target.generation)
					return Promise.resolve(null);
				return this.#replica.fetchTranscript(id, fromByte);
			},
		};
	}
	async nativeCommand(target: DevInputTarget, command: string, args: string[]): Promise<SubmitResult> {
		if (!this.#snapshot.connected) return { kind: "rejected", message: "Disconnected; command was not sent" };
		if (this.#sessionEnded) return { kind: "rejected", message: "Native session ended; command not sent" };
		const targetError = this.#targetError(target);
		if (targetError) return { kind: "rejected", message: targetError };
		if (command !== "abort") {
			try {
				await this.flushEditor(target);
			} catch (error) {
				return { kind: "rejected", message: `Native editor sync failed; command was not sent: ${String(error)}` };
			}
		}
		try {
			return await this.request<SubmitResult>("api/native-command", { target, command, args });
		} catch (error) {
			return admissionFailure(error, "Command result unknown");
		}
	}
	commands(target: DevInputTarget): Promise<NativeCommand[]> {
		return this.request(`api/native-commands?${this.#targetQuery(target)}`);
	}
	async create(input: {
		source: "conversation" | "import";
		request?: string;
		relatedRequirementIds?: string[];
	}): Promise<DevRequirementSnapshot> {
		const snapshot = await this.request<DevRequirementSnapshot>("api/requirements", input);
		await this.refresh();
		return snapshot;
	}
	async localBusiness(request: string): Promise<SpecDocument | null> {
		if (this.#snapshot.joined)
			throw new Error("请先显式离开远程共享聊天，再启动本地业务写作；不会静默切换聊天 owner。");
		const result = await this.request<{ document: SpecDocument | null; target: DevSessionTarget }>(
			"api/local-business",
			{ request },
		);
		this.#localTarget = result.target;
		this.select(null, true);
		this.#publish({});
		return result.document;
	}
	async importBusiness(id: string, source: File | string): Promise<void> {
		if (typeof source === "string")
			await this.request(`api/business/${encodeURIComponent(id)}`, { kind: "host-path", path: source });
		else {
			const form = new FormData();
			form.append("file", source);
			await this.request(`api/business/${encodeURIComponent(id)}`, form);
		}
		await this.refresh();
	}
	materials(id: string): Promise<DevMaterialRef[]> {
		return this.request(`api/materials/${encodeURIComponent(id)}`);
	}
	async localBusinessMaterial(): Promise<string> {
		await this.ready();
		const response = await workbenchHttp(this.url("api/local-business/material"));
		if (!response.ok) throw new Error(response.text);
		return response.text;
	}
	async material(id: string, materialId: string): Promise<Pick<SpecDocument, "content" | "version">> {
		await this.ready();
		const response = await workbenchHttp(
			this.url(`api/materials/${encodeURIComponent(id)}/${encodeURIComponent(materialId)}`),
		);
		if (!response.ok) throw new Error(response.text);
		const version: unknown = JSON.parse(response.header("etag") ?? "null");
		if (typeof version !== "string") throw new Error("Host material response is missing its actual byte version");
		return { content: response.text, version };
	}
	async preview(
		snapshot: DevRequirementSnapshot,
		intent: DevActionIntent,
		gitTarget: DevGitTarget | null,
	): Promise<DevActionPreview> {
		return this.request("api/action-preview", {
			requirementId: snapshot.record.requirementId,
			expectedRecordVersion: snapshot.recordVersion,
			expectedStage: snapshot.record.stage,
			intent,
			gitTarget,
		});
	}
	confirm(preview: DevActionPreview, userReply: string): Promise<DevActionResult> {
		return this.resume({
			operationId: preview.action.binding.operationId,
			confirmationToken: preview.confirmationToken,
			userReply,
		});
	}
	async resume(confirmation: OperationConfirmation): Promise<DevActionResult> {
		try {
			sessionStorage.setItem("omp.dev.operation", confirmation.operationId);
			sessionStorage.setItem("omp.dev.confirmation", JSON.stringify(confirmation));
		} catch {}
		const result = await this.request<DevActionResult>("api/actions", confirmation);
		await this.refresh().catch(error =>
			this.#publish({ error: `Operation returned a result, but refresh failed: ${String(error)}` }),
		);
		return result;
	}
	operation(operationId: string): Promise<DevActionResult> {
		return this.request(`api/operations/${encodeURIComponent(operationId)}`);
	}
	targets(id: string): Promise<DevGitTarget[]> {
		return this.request(`api/git-targets/${encodeURIComponent(id)}`);
	}
	async join(usernameOrLink: string, name: string): Promise<void> {
		this.#sessionEnded = false;
		try {
			const joined = await this.request<{
				peerId: string;
				roomId: string;
				canWrite: boolean;
				nativeEditorSupported: boolean;
				target: DevGuestSessionTarget;
			}>("api/collab/join", { browserId: this.#browserId, usernameOrLink, name });
			const identity = inputTargetIdentity(joined.target);
			let native: NativeViewState | undefined;
			for (const view of this.#snapshot.nativeViews.values())
				if (
					view.target.sessionId === joined.target.sessionId &&
					(!native || view.target.generation > native.target.generation)
				)
					native = view;
			const nativeViews = native
				? new Map(this.#snapshot.nativeViews).set(identity, {
						...native,
						editorUpdate: native.editorUpdate ? { ...native.editorUpdate, identity } : null,
					})
				: this.#snapshot.nativeViews;
			this.#publish({ joined: { ...joined, ended: this.#sessionEnded }, nativeViews });
		} catch (error) {
			this.#publish({ joined: null });
			this.select(this.#selectedId, true);
			throw error;
		}
	}
	async leave(): Promise<void> {
		await this.request("api/collab/leave", { browserId: this.#browserId });
		this.#publish({ joined: null });
		this.select(this.#selectedId, true);
	}
	async respond(request: DevNativeUiRequest, value: DevNativeUiResponse["value"]): Promise<void> {
		const result = await this.request<{ accepted: boolean; reason?: string }>("api/native-ui-response", {
			requestId: request.requestId,
			requirementId: request.requirementId,
			sessionId: request.sessionId,
			generation: request.generation,
			value,
		});
		if (!result.accepted) throw new Error(result.reason ?? "Native request rejected");
		this.#publish({ nativeUi: this.#snapshot.nativeUi.filter(item => item.requestId !== request.requestId) });
	}
}
