import * as path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { AsyncJobManager } from "../async/job-manager";
import { prompt } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import { cfgEditMode } from "../edit/settings";
import type { ExtensionFactory } from "../extensibility/extensions";
import { containedSpecPath } from "./artifacts";
import { createAgentSession, type CreateAgentSessionOptions } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import { SessionManager } from "../session/session-manager";
import { AgentRegistry } from "../registry/agent-registry";
import actorTemplate from "../prompts/agents/spec-driven.md" with { type: "text" };
import taskTemplate from "../prompts/spec-driven-task.md" with { type: "text" };
import communicationPrompt from "../prompts/spec-driven-communication.md" with { type: "text" };
import type { SpecAgentInput, SpecConversationReply, SpecRunContext, SpecStageRole } from "./types";

export interface SpecActor {
	readonly id: string;
	readonly role: SpecStageRole;
	readonly session: AgentSession;
	request(input: SpecAgentInput, context: SpecRunContext): Promise<SpecConversationReply>;
	dispose(): Promise<void>;
}

/** Collect every registered descendant of `ownerId` through the actual agent parent chain. */
export function specDescendantAgentIds(registry: AgentRegistry, ownerId: string): string[] {
	const children = new Map<string, string[]>();
	for (const ref of registry.list()) {
		if (!ref.parentId) continue;
		const siblings = children.get(ref.parentId) ?? [];
		siblings.push(ref.id);
		children.set(ref.parentId, siblings);
	}
	const seen = new Set<string>([ownerId]);
	const descendants: string[] = [];
	const queue = [ownerId];
	while (queue.length) {
		const parent = queue.shift()!;
		for (const child of children.get(parent) ?? []) {
			if (seen.has(child)) continue;
			seen.add(child);
			descendants.push(child);
			queue.push(child);
		}
	}
	return descendants;
}

/** Wait for all jobs owned by `ownerId`, treating rejected jobs as settled and picking up late registrations. */
async function waitOwnedSettled(manager: AsyncJobManager, ownerId: string): Promise<void> {
	const awaited = new Set<string>();
	for (;;) {
		const pending = manager.getAllJobs({ ownerId }).filter(job => !awaited.has(job.id));
		if (pending.length === 0) return;
		for (const job of pending) awaited.add(job.id);
		await Promise.all(pending.map(job => job.promise.catch(() => {})));
	}
}

/**
 * Cancel the actor and every descendant agent's jobs, then wait for actual settlement.
 * A task child owns its own background jobs, so the actor's exact-owner barrier alone
 * cannot stop an idle grandchild; this walks the registered parent chain instead.
 */
export async function cancelSpecDescendantJobs(
	manager: AsyncJobManager,
	ownerId: string,
	registry: AgentRegistry = AgentRegistry.global(),
): Promise<boolean> {
	const targets = new Set<string>([ownerId]);
	for (let pass = 0; pass < 3; pass++) {
		for (const id of specDescendantAgentIds(registry, ownerId)) targets.add(id);
		for (const id of targets) manager.cancelAll({ ownerId: id });
		for (const id of targets) await waitOwnedSettled(manager, id);
		if (!specDescendantAgentIds(registry, ownerId).some(id => !targets.has(id))) return true;
	}
	return false;
}

/** Caller owns the live producer, its independent transcript and its final disposal. */
export async function createSpecActor(args: {
	role: SpecStageRole;
	options: CreateAgentSessionOptions;
	sessionDirectory: string;
	methods?: readonly string[];
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
	cfgEditMode.override(settings, "replace");
	let currentInput: SpecAgentInput | undefined;
	const writeGuard: ExtensionFactory = pi => {
		pi.on("tool_call", async event => {
			if (["read", "grep", "glob"].includes(event.toolName)) return undefined;
			if (!currentInput || currentInput.readOnly)
				return { block: true, reason: "当前阶段只允许读取；请通过明确的修改操作恢复写权限。" };
			if (args.role === "executor") return undefined;
			if (event.toolName !== "write" && event.toolName !== "edit")
				return { block: true, reason: "执行确认前只能写本阶段的指定产物。" };
			const requested = event.input.path;
			if (
				typeof requested !== "string" ||
				requested.includes("://") ||
				/[\0:#?\[\]]/.test(requested.replace(/^[A-Za-z]:/, ""))
			)
				return { block: true, reason: "阶段产物必须使用精确文件路径。" };
			const cwd = args.options.cwd!;
			const relative = (path.isAbsolute(requested) ? path.relative(cwd, requested) : requested).replaceAll(
				"\\",
				"/",
			);
			const allowed = currentInput.outputPaths.some(output => {
				if (!output.includes("*")) return output === relative;
				const prefix = output.slice(0, output.indexOf("*"));
				return (
					output.endsWith("*/spec.md") &&
					relative.startsWith(prefix) &&
					/^[a-z0-9]+(?:-[a-z0-9]+)*\/spec\.md$/.test(relative.slice(prefix.length))
				);
			});
			if (!allowed) return { block: true, reason: `未授权的阶段文件写入：${requested}` };
			try {
				await containedSpecPath(cwd, relative);
			} catch (error) {
				return { block: true, reason: error instanceof Error ? error.message : String(error) };
			}
			return undefined;
		});
	};
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
		// Restricted SDK sessions ignore inline `extensions`, but rebind prepared
		// factories without admitting ambient tools or extension discovery.
		...(args.options.restrictToolNames
			? {
					preloadedPreparedExtensions: [
						...(args.options.preloadedPreparedExtensions ?? []),
						{
							path: "<spec-stage-write-guard>",
							resolvedPath: "<spec-stage-write-guard>",
							factory: writeGuard,
							error: null,
						},
					],
				}
			: { extensions: [...(args.options.extensions ?? []), writeGuard] }),
		systemPrompt: defaults => [...defaults, fixed, ...(args.methods ?? []), communicationPrompt],
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
		let abortCompletion: Promise<void> | undefined;
		let cancellationCompletion: Promise<boolean> | undefined;
		const abort = () => {
			// Keep the cancellation barrier until the native prompt, tools and descendants settle.
			if (session.asyncJobManager) {
				cancellationCompletion ??= cancelSpecDescendantJobs(session.asyncJobManager, id, registry);
				void cancellationCompletion.catch(() => {});
			}
			abortCompletion ??= session.abort();
			void abortCompletion.catch(() => {});
		};
		context.signal.addEventListener("abort", abort, { once: true });
		type Outcome = { ok: true; value: T } | { ok: false; error: unknown };
		let outcome: Outcome;
		try {
			const value = await operation();
			owned(context);
			outcome = { ok: true, value };
		} catch (error) {
			outcome = { ok: false, error };
		}
		let barrierError: unknown;
		try {
			if (context.signal.aborted) abort();
			let settled = cancellationCompletion ? await cancellationCompletion : true;
			await abortCompletion;
			if (context.signal.aborted && session.asyncJobManager) {
				const afterAbort = await cancelSpecDescendantJobs(session.asyncJobManager, id, registry);
				settled = settled && afterAbort;
			}
			if (!settled) throw new Error("Descendant cancellation was not confirmed");
		} catch (error) {
			barrierError = error;
		} finally {
			context.signal.removeEventListener("abort", abort);
			busy = false;
		}
		if (barrierError) throw barrierError;
		context.signal.throwIfAborted();
		if (!outcome.ok) throw outcome.error;
		return outcome.value;
	};
	return {
		id,
		role: args.role,
		session,
		request(input, context) {
			return perform(context, async () => {
				currentInput = input;
				await session.setActiveToolsByName(
					input.readOnly
						? ["read", "grep", "glob"]
						: [...(args.options.toolNames ?? ["read", "grep", "glob", "write", "edit"])],
				);
				const task = prompt.render(taskTemplate, { payload: JSON.stringify(input, null, 2) });
				let message: AssistantMessage | undefined;
				// 压缩会替换并缩短历史，不能用调用前的数组下标划分当前请求。
				// 只捕获本次原生请求产生的终结消息，维护移除历史后仍保留真实结果。
				const unsubscribe = session.subscribe(event => {
					if (event.type === "message_end" && event.message.role === "assistant") message = event.message;
				});
				try {
					await session.prompt(task, { throwOnDrop: true });
				} finally {
					unsubscribe();
					currentInput = undefined;
				}
				context.signal.throwIfAborted();
				if (
					!message ||
					message.role !== "assistant" ||
					message.stopReason === "error" ||
					message.stopReason === "aborted"
				) {
					const detail = message?.errorMessage?.trim();
					throw new Error(
						`Native ${args.role} produced no successful assistant result${detail ? `: ${detail}` : ""}`,
					);
				}
				const text = message.content
					.filter(item => item.type === "text")
					.map(item => item.text)
					.join("\n");
				return { text };
			});
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			await session.abort();
			if (session.asyncJobManager) await cancelSpecDescendantJobs(session.asyncJobManager, id, registry);
			try {
				await session.dispose();
			} finally {
				release?.();
				registry.unregister(id, ref ?? session);
			}
		},
	};
}
