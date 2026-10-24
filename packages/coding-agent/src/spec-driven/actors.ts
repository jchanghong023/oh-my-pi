import { createHash } from "node:crypto";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import { createAgentSession, type CreateAgentSessionOptions } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import type { HandoffResult } from "../session/agent-session-types";
import { SessionManager } from "../session/session-manager";
import { cfgCompactionKeepRecentTokens } from "../session/context-settings";
import { AgentRegistry } from "../registry/agent-registry";
import { finalizeSubprocessOutput } from "../task/executor";
import actorTemplate from "../prompts/agents/spec-driven.md" with { type: "text" };
import taskTemplate from "../prompts/spec-driven-task.md" with { type: "text" };
import type { SpecActorInput, SpecHandoff, SpecHandoffInput, SpecRunContext, SpecStageRole } from "./types";

export interface SpecActor {
	readonly id: string;
	readonly role: SpecStageRole;
	readonly session: AgentSession;
	request(input: SpecActorInput, context: SpecRunContext, schema?: unknown): Promise<unknown>;
	handoff(input: SpecHandoffInput, context: SpecRunContext): Promise<SpecHandoff>;
	dispose(): Promise<void>;
}

/** Caller owns the live producer, its independent transcript and its final disposal. */
export async function createSpecActor(args: {
	role: SpecStageRole;
	options: CreateAgentSessionOptions;
	sessionDirectory: string;
	methods: readonly string[];
	onSessionCreated?: (session: AgentSession) => (() => void) | void;
}): Promise<SpecActor> {
	const id = `spec-${args.role}-${crypto.randomUUID()}`;
	const registry = args.options.agentRegistry ?? AgentRegistry.global();
	const fixed = prompt.render(actorTemplate, { name: `spec-${args.role}` });
	const settings = (
		await (args.options.settings ??
			args.options.settingsManager ??
			Settings.loadIsolated({ cwd: args.options.cwd, agentDir: args.options.agentDir }))
	).overlay();
	const { session } = await createAgentSession({
		...args.options,
		settings,
		agentId: id,
		parentTaskPrefix: id,
		expectedAgentRef: null,
		bindProcessState: false,
		agentRegistry: registry,
		sessionManager: SessionManager.create(args.options.cwd!, args.sessionDirectory),
		requireYieldTool: false,
		systemPrompt: defaults => [...defaults, fixed, ...args.methods],
	});
	const ref = registry.get(id);
	let disposed = false;
	let busy = false;
	let runId: string | undefined;
	let release: (() => void) | void;
	try {
		release = args.onSessionCreated?.(session);
	} catch (error) {
		await session.dispose();
		registry.unregister(id, ref ?? session);
		throw error;
	}
	const owned = (context: SpecRunContext): void => {
		context.signal.throwIfAborted();
		if (disposed || session.isDisposed || registry.get(id) !== ref || ref?.session !== session)
			throw new Error("Specification producer ownership changed");
		if (runId && runId !== context.runId) throw new Error("Specification producer belongs to another run");
		runId = context.runId;
	};
	const perform = async <T>(context: SpecRunContext, operation: () => Promise<T>): Promise<T> => {
		owned(context);
		if (busy) throw new Error("Specification producer is busy");
		busy = true;
		const abort = () => {
			void session.abort();
		};
		context.signal.addEventListener("abort", abort, { once: true });
		try {
			const value = await operation();
			owned(context);
			return value;
		} finally {
			context.signal.removeEventListener("abort", abort);
			busy = false;
		}
	};
	return {
		id,
		role: args.role,
		session,
		request(input, context, schema) {
			return perform(context, async () => {
				const business =
					input.payload !== null && typeof input.payload === "object" ? input.payload : { payload: input.payload };
				const task = prompt.render(taskTemplate, {
					payload: JSON.stringify({
						specDrivenRole: args.role,
						input: { ...business, documents: input.documents, handoff: input.handoff },
					}),
					skills: [],
				});
				let message: AssistantMessage | undefined;
				// 压缩会替换并缩短历史，不能用调用前的数组下标划分当前请求。
				// 只捕获本次原生请求产生的终结消息，维护移除历史后仍保留真实结果。
				const unsubscribe = session.subscribe(event => {
					if (event.type === "message_end" && event.message.role === "assistant") message = event.message;
				});
				try {
					await session.prompt(`${task}\n\nOutput JSON matching this schema:\n${JSON.stringify(schema ?? {})}`, {
						throwOnDrop: true,
					});
				} finally {
					unsubscribe();
				}
				context.signal.throwIfAborted();
				if (
					!message ||
					message.role !== "assistant" ||
					message.stopReason === "error" ||
					message.stopReason === "aborted"
				)
					throw new Error(`Native ${args.role} produced no successful assistant result`);
				const text = message.content
					.filter(item => item.type === "text")
					.map(item => item.text)
					.join("\n");
				const result = finalizeSubprocessOutput({
					rawOutput: text,
					lastAssistantText: text,
					exitCode: 0,
					stderr: "",
					doneAborted: false,
					signalAborted: context.signal.aborted,
					outputSchema: schema,
					outputSchemaMode: "strict",
					outputSchemaSource: "caller",
				});
				if (result.exitCode !== 0 || result.structuredOutput?.status !== "valid")
					throw new Error(result.stderr || `Invalid native ${args.role} result`);
				return result.structuredOutput.data;
			});
		},
		handoff(input, context) {
			return perform(context, async () => {
				await session.appendCustomMessage(
					{ customType: "spec-approved-handoff", content: JSON.stringify(input), display: false },
					{ signal: context.signal },
				);
				// 短阶段会被默认保留预算全部保留，原生 handoff 因无可压缩内容而提前退出。
				// 仅在本生产者交接期间保留原生最小尾部；父设置和普通压缩策略不变。
				cfgCompactionKeepRecentTokens.override(settings, 0);
				let result: HandoffResult | undefined;
				try {
					result = await session.handoff(JSON.stringify(input), { signal: context.signal });
				} finally {
					cfgCompactionKeepRecentTokens.clearOverride(settings);
				}
				context.signal.throwIfAborted();
				if (!result?.document?.trim()) throw new Error("Native specification handoff returned no document");
				return {
					actorId: id,
					sessionId: session.sessionId,
					role: args.role,
					runId: context.runId,
					generation: context.generation,
					transition: input.transition,
					path: input.path,
					body: result.document,
					digest: createHash("sha256").update(result.document).digest("hex"),
					versions: Object.fromEntries(input.documents.map(document => [document.path, document.version])),
				};
			});
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			await session.abort();
			try {
				await session.dispose();
			} finally {
				release?.();
				registry.unregister(id, ref ?? session);
			}
		},
	};
}
