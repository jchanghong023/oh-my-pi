import { createHash, randomUUID } from "node:crypto";
import { Type } from "@oh-my-pi/omptype/typebox";
import type { Model } from "@oh-my-pi/pi-ai";
import type { CustomTool } from "../../../extensibility/custom-tools/types";
import type { ZCodeSessionManager, ZCodeSessionRecord } from "../sessions";
import {
	WorkflowError,
	refToString,
	type ActorRef,
	type ActorSessionSeed,
	type AskMessage,
	type InstanceRef,
	type JournalStorePort,
	type PersonaSpec,
	type RunEvent,
	type SessionRef,
	type SubmitVerdict,
	type WorkflowDriver,
	type WorkflowReportSink,
} from "./vendor/dynamic-workflow/index.js";
import { createOmpWorkflowWorld } from "./world";

export interface OmpWorkflowDriverContext {
	runId: string;
	sessions: ZCodeSessionManager;
	emit(event: RunEvent): void;
	modelBindings?: ReadonlyMap<string, Model>;
	subagentModel?: Model;
	modelCatalog?: readonly Model[];
	admitRequest?: (signal?: AbortSignal) => Promise<() => void>;
	signal?: AbortSignal;
}

interface Ask {
	instance: InstanceRef;
	message: AskMessage;
	actor: Actor;
	cancelled: boolean;
	accepted: boolean;
	nudge?: string;
	drain?: Promise<void>;
	pending?: (verdict: SubmitVerdict) => void;
	toolCalls: number;
	worldToolCalls: number;
	turns: number;
	escalations: Map<string, { resolve(answer: string): void; reject(error: Error): void }>;
}
interface Actor {
	releaseRequest?: () => void;
	record: ZCodeSessionRecord;
	current?: Ask;
	tail: Promise<void>;
}

/** Boundary B owns only the SDK actors it creates; the parent never executes an actor ask. */
export class OmpWorkflowDriver implements WorkflowDriver {
	readonly #quietSessions = new Set<string>();
	readonly #actors = new Map<string, Actor>();
	readonly #asks = new Map<string, Ask>();
	readonly #creating = new Set<Promise<SessionRef>>();
	readonly #world;
	readonly #abort = new AbortController();
	#disposed = false;
	#closed: Promise<void> = Promise.resolve();
	readonly #onAbort = () => this.dispose();

	constructor(
		readonly parent: ZCodeSessionRecord,
		readonly sink: WorkflowReportSink,
		readonly journal: JournalStorePort,
		readonly context: OmpWorkflowDriverContext,
	) {
		this.#world = createOmpWorkflowWorld(parent, this.#abort.signal);
		context.signal?.addEventListener("abort", this.#onAbort, { once: true });
		if (context.signal?.aborted) this.dispose();
	}

	get closed(): Promise<void> {
		return this.#closed;
	}
	get quietSessionIds(): readonly string[] {
		return [...this.#quietSessions];
	}
	emit(event: RunEvent): void {
		this.context.emit(event);
	}

	createActorSession(actor: ActorRef, persona: PersonaSpec, seed?: ActorSessionSeed): Promise<SessionRef> {
		const creation = this.#createActor(actor, persona, seed);
		this.#creating.add(creation);
		void creation.finally(() => this.#creating.delete(creation)).catch(() => {});
		return creation;
	}

	async #createActor(actor: ActorRef, persona: PersonaSpec, seed?: ActorSessionSeed): Promise<SessionRef> {
		if (this.#disposed) throw new WorkflowError("DriverError", "Workflow driver is closed");
		const hash = createHash("sha256")
			.update(`${this.context.runId}\0${refToString(actor)}`)
			.digest("hex");
		const id = `dwf-${hash.slice(0, 32)}`;
		const journaled = this.journal.getActor(this.context.runId, actor.siteId, actor.ordinal)?.sessionId;
		if (journaled !== undefined && journaled !== id) {
			throw new WorkflowError("DriverError", "Workflow actor session identity does not match its journal");
		}
		const existing = this.#actors.get(id);
		if (existing) return { id };
		const model = seed?.resolvedModel
			? this.context.modelCatalog?.find(candidate => `${candidate.provider}/${candidate.id}` === seed.resolvedModel)
			: persona.model === undefined
				? (this.context.subagentModel ?? this.parent.session.model)
				: this.context.modelBindings?.get(persona.model);
		if (!model)
			throw new WorkflowError(
				"DriverError",
				`Workflow actor model is not bound: ${seed?.resolvedModel ?? persona.model ?? "parent"}`,
			);
		// SDK inline tools use CustomTool's callback/context/signal argument order.
		const submit: CustomTool = {
			name: "submit_result",
			label: "Submit workflow result",
			approval: "read",
			loadMode: "essential",
			description:
				"Submit the current workflow ask's typed result. A rejection contains validation errors; repair and submit again.",
			parameters: Type.Object({ result: Type.Unknown() }),
			execute: async (_toolCallId, params, _onUpdate, _ctx, signal) => {
				const ask = state?.current;
				if (!ask || ask.cancelled || this.#disposed) throw new Error("No active workflow ask");
				if (!ask.message.typed) throw new Error("This ask is untyped; respond with plain text instead");
				if (ask.pending) throw new Error("A result submission is already pending");
				if (typeof params !== "object" || params === null || !("result" in params))
					throw new Error("A result value is required");
				const pending = Promise.withResolvers<SubmitVerdict>();
				const cancel = () => {
					ask.pending = undefined;
					pending.reject(new Error("Workflow submission cancelled"));
				};
				ask.pending = value => pending.resolve(value);
				if (signal?.aborted) cancel();
				else {
					signal?.addEventListener("abort", cancel, { once: true });
					try {
						this.sink.askSubmitAttempted(ask.instance, params.result);
					} catch (error) {
						ask.pending = undefined;
						pending.reject(error);
					}
				}
				let verdict: SubmitVerdict;
				try {
					verdict = await pending.promise;
				} finally {
					signal?.removeEventListener("abort", cancel);
				}
				if (verdict.kind !== "accept") {
					throw new Error(
						verdict.kind === "reject" ? JSON.stringify(verdict.violations) : "Submit the required result",
					);
				}
				return { content: [{ type: "text", text: "Result accepted." }], details: { accepted: true } };
			},
		};
		// escalate 属于 DSL 的 ask 内协议；只停驻当前 actor，不把问题伪装成新工作节点。
		const escalate: CustomTool = {
			name: "escalate",
			label: "Escalate workflow question",
			approval: "read",
			loadMode: "essential",
			description: "Ask the parent agent a blocking question and continue this ask with its answer.",
			parameters: Type.Object({
				question: Type.String({ minLength: 1, maxLength: 4000 }),
				context: Type.Optional(Type.String({ maxLength: 4000 })),
			}),
			execute: async (_toolCallId, params, _onUpdate, _ctx, signal) => {
				const ask = state?.current;
				if (!ask || ask.cancelled || ask.accepted || this.#disposed) throw new Error("No active workflow ask");
				if (
					typeof params !== "object" ||
					params === null ||
					!("question" in params) ||
					typeof params.question !== "string" ||
					!params.question.trim() ||
					params.question.length > 4000 ||
					("context" in params &&
						params.context !== undefined &&
						(typeof params.context !== "string" || params.context.length > 4000))
				)
					throw new Error("A workflow question and optional context are required");
				const question = params.question;
				const context = "context" in params && typeof params.context === "string" ? params.context : undefined;
				const qid = `dwfq-${this.context.runId}-${randomUUID()}`;
				const pending = Promise.withResolvers<string>();
				ask.escalations.set(qid, pending);
				const cancel = () => {
					ask.escalations.delete(qid);
					pending.reject(new Error("Workflow escalation cancelled"));
				};
				try {
					signal?.throwIfAborted();
					signal?.addEventListener("abort", cancel, { once: true });
					const event: RunEvent = {
						type: "escalation-raised",
						qid,
						actor,
						...(persona.name === undefined ? {} : { actorName: persona.name }),
						question,
						...(context === undefined ? {} : { context }),
						askedAt: Date.now(),
					};
					this.journal.appendEvent(this.context.runId, event);
					this.emit(event);
					// 复用父 AgentSession 的原生通知准入，不维护另一条父输入队列。
					void this.parent
						.run(() =>
							this.parent.session.sendCustomMessage(
								{
									customType: "workflow-escalation",
									content: JSON.stringify({
										runId: this.context.runId,
										question_id: qid,
										question,
										context,
										instruction: "Answer with ResolveWorkflowQuestion({question_id, answer}).",
									}),
									display: true,
								},
								{ deliverAs: "followUp", triggerTurn: true },
							),
						)
						.catch(error => {
							ask.escalations.delete(qid);
							pending.reject(error);
						});
					const answer = await pending.promise;
					return { content: [{ type: "text", text: answer }], details: { qid, answer } };
				} finally {
					signal?.removeEventListener("abort", cancel);
					ask.escalations.delete(qid);
				}
			},
		};
		const record = await this.context.sessions.createWorkflowActor(this.parent, {
			sessionId: id,
			model,
			agentId: `Workflow-${hash.slice(0, 12)}`,
			agentDisplayName: persona.name ?? refToString(actor),
			customTools: [submit, escalate],
			requireExisting: journaled !== undefined,
			...(persona.system === undefined ? {} : { systemPrompt: blocks => [...blocks, persona.system!] }),
			...(seed === undefined ? {} : { seed: { sessionId: seed.sourceSessionId, messageCount: seed.messageCount } }),
		});
		if (this.#disposed) {
			await this.context.sessions.close(record.id);
			throw new WorkflowError("DriverError", "Workflow actor creation cancelled");
		}
		const state: Actor = { record, tail: Promise.resolve() };
		const transport = record.session.agent.streamFn;
		const ownedActor = state;
		record.session.agent.streamFn = async (model, request, options) => {
			const ask = ownedActor.current;
			if (!ask || ask.cancelled || this.#disposed) throw new Error("Workflow ask cancelled");
			if (this.context.admitRequest) {
				this.sink.askWaiting(ask.instance, { cause: "slot" });
				ownedActor.releaseRequest = await this.context.admitRequest(options?.signal);
			}
			if (ask.cancelled || this.#disposed) {
				ownedActor.releaseRequest?.();
				ownedActor.releaseRequest = undefined;
				throw new Error("Workflow ask cancelled");
			}
			this.sink.askExecuting(ask.instance);
			try {
				return await transport(model, request, options);
			} catch (error) {
				ownedActor.releaseRequest?.();
				ownedActor.releaseRequest = undefined;
				throw error;
			}
		};
		this.#actors.set(id, state);
		const actorRecord = this.journal.getActor(this.context.runId, actor.siteId, actor.ordinal);
		if (actorRecord) this.journal.putActor({ ...actorRecord, resolvedModel: `${model.provider}/${model.id}` });
		return { id };
	}

	startAsk(session: SessionRef, instance: InstanceRef, message: AskMessage): void {
		const actor = this.#actors.get(session.id);
		if (!actor || this.#disposed) {
			this.sink.askFailed(
				instance,
				new WorkflowError("DriverError", `Unknown or closed workflow actor: ${session.id}`),
			);
			return;
		}
		const ask: Ask = {
			instance,
			message,
			actor,
			cancelled: false,
			accepted: false,
			toolCalls: 0,
			worldToolCalls: 0,
			turns: 0,
			escalations: new Map(),
		};
		this.#asks.set(refToString(instance), ask);
		// Engine acceptance may release the next ask before the preceding native prompt has drained.
		// This is an actor resource lease, not another accepted conversation-input queue.
		actor.tail = actor.tail
			.then(() => this.#run(ask))
			.catch(error => {
				if (!ask.cancelled && !ask.accepted && !this.#disposed) {
					this.sink.askFailed(
						instance,
						new WorkflowError("DriverError", error instanceof Error ? error.message : String(error)),
					);
				}
			})
			.finally(() => {
				this.#asks.delete(refToString(instance));
			});
	}

	async #run(ask: Ask): Promise<void> {
		if (ask.cancelled || this.#disposed) return;
		const actor = ask.actor;
		actor.current = ask;
		const session = actor.record.session;
		let input = ask.message.instructions;
		if (ask.message.typed)
			input += `\n\nSubmit the final result with submit_result({result: ...}). Required JSON schema:\n${JSON.stringify(ask.message.schema)}`;
		const unsubscribe = session.subscribe(event => {
			if (actor.current !== ask || ask.cancelled) return;
			if (event.type === "tool_execution_start") {
				ask.toolCalls++;
				if (event.toolName !== "submit_result" && event.toolName !== "escalate") {
					ask.worldToolCalls++;
					const tool = session.getToolByName(event.toolName);
					if (tool?.approval !== "read") this.sink.askMutating(ask.instance);
				}
				this.sink.askProgress(ask.instance, { turn: ask.turns, toolCalls: ask.toolCalls });
				this.sink.askStats(ask.instance, {
					tokens: 0,
					toolCalls: 1,
					turns: 0,
					worldToolCalls: event.toolName === "submit_result" || event.toolName === "escalate" ? 0 : 1,
				});
			}
			if (event.type === "tool_execution_end" && ask.accepted) {
				ask.drain ??= actor.record.run(() => session.abort());
			}
			if (event.type === "message_end" && event.message.role === "assistant") {
				actor.releaseRequest?.();
				actor.releaseRequest = undefined;
				ask.turns++;
				this.sink.askProgress(ask.instance, { turn: ask.turns, toolCalls: ask.toolCalls });
				this.sink.askStats(ask.instance, {
					tokens: event.message.usage.totalTokens,
					toolCalls: 0,
					turns: 1,
					worldToolCalls: 0,
				});
			}
		});
		try {
			do {
				ask.nudge = undefined;
				const start = session.messages.length;
				await actor.record.run(() => session.prompt(input));
				await session.sessionManager.flush();
				const messageBoundary = (await this.context.sessions.read(actor.record.id)).messages.length;
				const node = this.journal.getNode(this.context.runId, ask.instance.siteId, ask.instance.ordinal);
				if (node?.status === "completed") this.journal.putNode({ ...node, messageBoundary });
				if (ask.cancelled || ask.accepted || this.#disposed) break;
				const messages = session.messages.slice(start);
				const last = messages.findLast(message => message.role === "assistant");
				if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) {
					throw new Error(last.errorMessage ?? `Workflow actor stopped: ${last.stopReason}`);
				}
				const text =
					last?.role === "assistant"
						? last.content
								.filter(block => block.type === "text")
								.map(block => block.text)
								.join("\n")
						: "";
				this.sink.askTurnEnded(ask.instance, text);
				const completed = this.journal.getNode(this.context.runId, ask.instance.siteId, ask.instance.ordinal);
				if (completed?.status === "completed") this.journal.putNode({ ...completed, messageBoundary });
				input = ask.nudge ?? "";
			} while (ask.nudge && !ask.cancelled && !ask.accepted && !this.#disposed);
		} finally {
			try {
				await ask.drain;
			} finally {
				actor.releaseRequest?.();
				actor.releaseRequest = undefined;
				unsubscribe();
				if (actor.current === ask) actor.current = undefined;
			}
		}
	}

	respondToSubmit(instance: InstanceRef, verdict: SubmitVerdict): void {
		const ask = this.#asks.get(refToString(instance));
		if (!ask || ask.cancelled) return;
		if (verdict.kind === "accept") ask.accepted = true;
		if (verdict.kind === "nudge")
			ask.nudge = "A typed result is required. Call submit_result with the result matching the required schema.";
		const resolve = ask.pending;
		ask.pending = undefined;
		resolve?.(verdict);
	}

	respondToEscalation(qid: string, answer: string): boolean {
		if (this.#disposed) return false;
		for (const ask of this.#asks.values()) {
			const pending = ask.escalations.get(qid);
			if (!pending || ask.cancelled || ask.accepted) continue;
			const event: RunEvent = { type: "escalation-resolved", qid, answer };
			this.journal.appendEvent(this.context.runId, event);
			this.emit(event);
			ask.escalations.delete(qid);
			pending.resolve(answer);
			return true;
		}
		return false;
	}

	cancelAsk(instance: InstanceRef): void {
		const ask = this.#asks.get(refToString(instance));
		if (!ask) return;
		ask.cancelled = true;
		ask.pending?.({ kind: "reject", violations: [] });
		ask.pending = undefined;
		for (const pending of ask.escalations.values()) pending.reject(new Error("Workflow escalation cancelled"));
		ask.escalations.clear();
		if (ask.actor.current === ask) ask.drain ??= ask.actor.record.run(() => ask.actor.record.session.abort());
	}

	executeWorldRead: WorkflowDriver["executeWorldRead"] = (op, args) => this.#world.read(op, args);
	executeArtifactPublish: NonNullable<WorkflowDriver["executeArtifactPublish"]> = request =>
		this.#world.publish(request);

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.context.signal?.removeEventListener("abort", this.#onAbort);
		this.#abort.abort();
		for (const ask of this.#asks.values()) this.cancelAsk(ask.instance);
		this.#closed = (async () => {
			await Promise.allSettled([...this.#creating]);
			const actors = [...this.#actors.values()];
			await Promise.all(actors.map(actor => actor.tail));
			await Promise.all(
				actors.map(async actor => {
					await this.context.sessions.close(actor.record.id);
					this.#quietSessions.add(actor.record.id);
				}),
			);
			this.#actors.clear();
			this.#asks.clear();
		})();
		// Engine's synchronous dispose port cannot await; owner awaits `closed` on connection teardown.
		void this.#closed.catch(() => {});
	}
}

export function makeOmpWorkflowDriver(
	parent: ZCodeSessionRecord,
	sink: WorkflowReportSink,
	journal: JournalStorePort,
	context: OmpWorkflowDriverContext,
): OmpWorkflowDriver {
	return new OmpWorkflowDriver(parent, sink, journal, context);
}
