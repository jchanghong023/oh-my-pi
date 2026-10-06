/**
 * Per-session RPC host: everything the RPC protocol surface binds to ONE
 * AgentSession.
 *
 * Extracted from the former `runRpcMode` closure so the single-session mode
 * (rpc-mode.ts, a thin stdin/stdout transport shell) and the multi-session
 * project mode can share it. Owns the fork controllers, prompt-result
 * reporting, extension UI context, host tool/URI bridges, and the session
 * event forwarding for exactly one session; the caller owns the frame
 * transport, the process lifetime, and the AgentSession itself.
 */
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import * as path from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, Model } from "@oh-my-pi/pi-ai";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { $env, isRecord, logger, Snowflake, toError } from "@oh-my-pi/pi-utils";
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "../../discovery/helpers";
import {
	type ExtensionAskDialogQuestion,
	type ExtensionAskDialogResult,
	type ExtensionAskDialogSubmitResult,
	type ExtensionError,
	type ExtensionUIContext,
	type ExtensionUIDialogOptions,
	type ExtensionUISelectItem,
	type ExtensionWidgetOptions,
	getExtensionUISelectOptionLabel,
	timedOutAskDialogResult,
} from "../../extensibility/extensions";
import {
	type BuiltSkillPromptMessage,
	buildSkillPromptMessage,
	parseSkillInvocation,
	type Skill,
	type SkillPromptInput,
} from "../../extensibility/skills";
import { type Theme, theme } from "@oh-my-pi/pi-tui/theme";
import {
	type WordCompletionEngine,
	type WordCompletionMethod,
	type WordCompletionQuery,
	wordCompletionQuery,
} from "@oh-my-pi/pi-tui/prompt/word-completion";
import { requestTextPrediction, textPredictionBackend } from "../../predict/client";
import { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import { type AgentSession, SessionBusyError } from "../../session/agent-session";
import type { RestoredQueuedMessage } from "../../session/agent-session-types";
import { CACHE_WARMING_MODES } from "../../session/cache-warmer";
import { findMostRecentNonEmptySession } from "../../session/session-listing";
import { SKILL_PROMPT_MESSAGE_TYPE, USER_INTERRUPT_LABEL } from "../../session/messages";
import { executeAcpBuiltinSlashCommand } from "../../slash-commands/acp-builtins";
import {
	buildAvailableSlashCommands,
	type InternalAvailableSlashCommand,
} from "../../slash-commands/available-commands";
import { defaultLoadModeForToolName } from "../../tools/essential-tools";
import type { EventBus } from "../../utils/event-bus";
import { selectRpcEntries } from "./rpc-compat";
import { calculateTokensPerSecond } from "../../utils/token-rate";
import { formatPersistenceFailure, formatPersistenceNotice } from "../persistence-failure";
import { type ExtensionSendAction, initializeExtensions } from "../runtime-init";
import { cfgSpellingAutocomplete } from "../settings";
import { RpcHostToolBridge } from "./host-tools";
import { RpcHostUriBridge } from "./host-uris";
import { RpcBtwController } from "./rpc-btw";
import { RpcForkAskBroker } from "./rpc-fork-ask";
import { RpcAttachmentError, resolveRpcAttachments, type RpcForkAttachment } from "./rpc-fork-attachments";
import { RpcForkPermissionController } from "./rpc-fork-permission";
import { RpcForkHost } from "./rpc-fork-host";
import { isNegotiableRpcProtocolVersion, RPC_FORK_PROTOCOL_VERSION } from "./rpc-fork-types";
import { MAX_RPC_FRAME_BYTES } from "./rpc-frame";
import { RpcGoalController } from "./rpc-goal";
import { RpcLiveBridge, type RpcLiveSessionFactory } from "./rpc-live";
import { pageRpcMessages, RpcMessagesPageError } from "./rpc-messages";
import {
	RpcExtensionUserMessageTracker,
	RpcPromptResults,
	type RpcPromptTicket,
	watchAndReportPromptResult,
} from "./rpc-prompt-results";
import { RpcSessionEventForwarder } from "./rpc-session-events";
import { isRpcSessionSettled, RpcSessionSettleWatcher, watchedScheduledTurnProbe } from "./rpc-session-settle";
import { RpcSubagentRegistry, readRpcSubagentTranscript, resolveOwnedLiveSubagent } from "./rpc-subagents";
import type {
	RpcAbortAndRestoreQueueResult,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcExtensionUISelectOptionDetail,
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcHostToolDefinition,
	RpcHostUriCancelRequest,
	RpcHostUriRequest,
	RpcOpenSessionResult,
	RpcRemoveQueuedMessageResult,
	RpcResponse,
	RpcSessionState,
	RpcSubagentSubscriptionLevel,
} from "./rpc-types";

const INVALID_TEXT_CURSOR_ERROR = "cursor must be an integer UTF-16 offset within text";

function isTextCursor(text: unknown, cursor: unknown): text is string {
	return (
		typeof text === "string" &&
		typeof cursor === "number" &&
		Number.isInteger(cursor) &&
		cursor >= 0 &&
		cursor <= text.length
	);
}

/**
 * Composer ghost-text query at a UTF-16 cursor offset, gated like the TUI
 * editor's: only at the end of a line, and only for a prose word.
 */
function wordQueryAt(text: string, cursor: number): WordCompletionQuery | undefined {
	if (cursor < text.length && text[cursor] !== "\n") return undefined;
	const lines = text.split("\n");
	let cursorLine = 0;
	let lineStart = 0;
	while (lineStart + lines[cursorLine]!.length < cursor) lineStart += lines[cursorLine++]!.length + 1;
	return wordCompletionQuery(lines, cursorLine, cursor - lineStart);
}

interface QueuedWordPrediction {
	engine: WordCompletionEngine;
	query: WordCompletionQuery;
	resolve(suffix: string | null): void;
	reject(error: unknown): void;
}

/**
 * `predict_word` answers for one RPC session, with the TUI provider's flow
 * control: one engine request in flight, and a newer request replaces the one
 * waiting behind it (the replaced request answers `null`), so a burst of
 * typing costs the shared daemon at most two inferences.
 */
export class RpcWordPredictor {
	#busy = false;
	#queued: QueuedWordPrediction | undefined;
	readonly #request: typeof requestTextPrediction;

	/** `request` is a test seam. */
	constructor(request: typeof requestTextPrediction = requestTextPrediction) {
		this.#request = request;
	}

	/**
	 * Ghost-text suffix for the word ending at `cursor`, or `null` when the
	 * engine is off, nothing applies, or a newer request superseded this one.
	 * Rejects when the prediction daemon cannot answer.
	 */
	predict(method: WordCompletionMethod, text: string, cursor: number): Promise<string | null> {
		if (method === "off") return Promise.resolve(null);
		const query = wordQueryAt(text, cursor);
		if (!query) return Promise.resolve(null);
		if (!this.#busy) return this.#run(method, query);
		this.#queued?.resolve(null);
		const { promise, resolve, reject } = Promise.withResolvers<string | null>();
		this.#queued = { engine: method, query, resolve, reject };
		return promise;
	}

	async #run(engine: WordCompletionEngine, query: WordCompletionQuery): Promise<string | null> {
		this.#busy = true;
		try {
			const { suggestion } = await this.#request(engine, query.before, query.prefix);
			return suggestion?.suffix || null;
		} finally {
			this.#busy = false;
			const next = this.#queued;
			this.#queued = undefined;
			if (next) void this.#run(next.engine, next.query).then(next.resolve, next.reject);
		}
	}
}

export type PendingExtensionRequest = {
	resolve: (response: RpcExtensionUIResponse) => void;
	reject: (error: Error) => void;
};

/** Render an unknown thrown value as the wire error message. */
function errorMessage(value: unknown): string {
	return value instanceof Error ? value.message : String(value);
}

/** Pending extension UI request map that can fail closed when the RPC client disconnects. */
export class RpcPendingExtensionRequests extends Map<string, PendingExtensionRequest> {
	#closedError: Error | undefined;

	override set(id: string, request: PendingExtensionRequest): this {
		if (this.#closedError) {
			request.reject(this.#closedError);
			return this;
		}
		return super.set(id, request);
	}

	/** Reject every active and future extension UI request. */
	rejectAll(message: string): void {
		if (!this.#closedError) this.#closedError = new Error(message);
		const requests = Array.from(this.values());
		this.clear();
		for (const request of requests) {
			request.reject(this.#closedError);
		}
	}
}

export type RpcOutput = (
	obj:
		| RpcResponse
		| RpcExtensionUIRequest
		| RpcHostToolCallRequest
		| RpcHostToolCancelRequest
		| RpcHostUriRequest
		| RpcHostUriCancelRequest
		| object,
) => void;

export type RpcSessionChangeCommand = Extract<
	RpcCommand,
	{ type: "new_session" } | { type: "switch_session" } | { type: "branch" } | { type: "fork" }
>;

export type RpcQueueModeCommand = Extract<
	RpcCommand,
	{ type: "set_steering_mode" } | { type: "set_follow_up_mode" } | { type: "set_interrupt_mode" }
>;

export type RpcSessionChangeResult =
	| { type: "new_session"; data: { cancelled: boolean } }
	| { type: "switch_session"; data: { cancelled: boolean } }
	| { type: "branch"; data: { text: string; cancelled: boolean } }
	| { type: "fork"; data: { cancelled: boolean } };

export type RpcSessionChangeSession = Pick<
	AgentSession,
	"newSession" | "switchSession" | "branch" | "fork" | "model" | "setModel"
>;

type RpcModelLookupSession = Pick<AgentSession, "getAvailableModels" | "modelRegistry">;

/**
 * The available model with exactly this provider and id. Models missing from
 * the current catalog wait for in-flight background discovery first: on cold
 * start, discovery-backed providers (proxy / ollama / etc.) populate seconds
 * after session ready. Catalog hits skip the wait, so the RPC queue is not
 * stalled behind unrelated discovery.
 */
async function findRpcModel(session: RpcModelLookupSession, provider: string, modelId: string) {
	const find = () => session.getAvailableModels().find(m => m.provider === provider && m.id === modelId);
	const model = find();
	if (model) return model;
	await session.modelRegistry.awaitBackgroundRefresh();
	return find();
}

/** The optional `provider`/`modelId` pair of `open_session` or `switch_session`, validated like `set_model`. */
async function resolveRequestedRpcModel(
	session: RpcModelLookupSession,
	command: { provider?: string; modelId?: string },
): Promise<Model | undefined> {
	const { provider, modelId } = command;
	if (provider === undefined && modelId === undefined) return undefined;
	if (provider === undefined || modelId === undefined) throw new Error("provider and modelId must be given together");
	const model = await findRpcModel(session, provider, modelId);
	if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
	return model;
}

export type RpcSkillCommandSession = Pick<AgentSession, "promptCustomMessage" | "skills" | "skillsSettings">;
export type RpcSkillCommandResult = { agentInvoked: true };

export interface RpcSkillInvocation extends SkillPromptInput {
	skill: Skill;
	queueChipText: string;
}

/**
 * Fast in-memory pre-check for a skill invocation: settings gate, text shape,
 * and skill lookup. Returns null when the message is not a runnable skill
 * command. Performs no I/O — safe to run on the RPC serial queue.
 */
export function resolveRpcSkillInvocation(session: RpcSkillCommandSession, text: string): RpcSkillInvocation | null {
	if (!session.skillsSettings?.enableSkillCommands) return null;
	const parsed = parseSkillInvocation(text);
	if (!parsed) return null;
	const skill = session.skills.find(candidate => candidate.name === parsed.name);
	if (!skill) return null;
	return { skill, args: parsed.args, prompt: parsed.prompt, queueChipText: text };
}

/**
 * Slow half of a skill invocation: builds the skill prompt message (file I/O)
 * and dispatches it through the full prompt pipeline (usage preflight,
 * compaction checks, provider calls). Resolves once the turn is scheduled.
 * Must not run on the RPC serial queue's response path — register it with
 * watchAndReportPromptResult and answer the command once it is admitted.
 */
export async function runRpcSkillCommand(
	session: RpcSkillCommandSession,
	invocation: RpcSkillInvocation,
	streamingBehavior: "steer" | "followUp" = "steer",
	prebuilt?: BuiltSkillPromptMessage,
	onPromptAdmitted?: () => void,
	images?: ImageContent[],
	attachmentsText?: string,
): Promise<boolean> {
	const built = prebuilt ?? (await buildSkillPromptMessage(invocation.skill, invocation, "user"));
	// Resolved attachment bodies travel with the skill command: the
	// prefix stays out of the slash/skill MATCHING text but must still reach
	// the model message and transcript, or uploaded material silently vanishes.
	const messageText = attachmentsText ? attachmentsText + built.message : built.message;
	return session.promptCustomMessage(
		{
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: images?.length ? [{ type: "text", text: messageText }, ...images] : messageText,
			display: true,
			details: built.details,
			attribution: "user",
		},
		{ streamingBehavior, queueChipText: invocation.queueChipText, onPromptAdmitted },
	);
}

/**
 * Skill branch of the `prompt` command: resolves the invocation cheaply, then
 * registers the slow dispatch with watchAndReportPromptResult and awaits
 * admission (or completion, for a message that settles without ever being
 * admitted) before answering. The caller still does not wait for the full
 * dispatch pipeline — building the skill prompt and running it (usage
 * preflight, compaction, provider calls) can outlast any client's prompt
 * timeout under provider stress; only queue admission gates the response.
 */
export async function dispatchRpcSkillPrompt(input: {
	ticket: RpcPromptTicket;
	session: RpcSkillCommandSession;
	message: string;
	/** Resolved attachment text prefix; prepended to the skill message, never the matching text. */
	attachmentsText?: string;
	streamingBehavior: "steer" | "followUp" | undefined;
	results: RpcPromptResults;
	onError: (error: Error) => void;
	extensionUserMessageTracker: RpcExtensionUserMessageTracker;
	images?: ImageContent[];
	isCurrent?: () => boolean;
}): Promise<RpcSkillCommandResult | "cancelled" | null> {
	const invocation = resolveRpcSkillInvocation(input.session, input.message);
	if (!invocation) return null;
	// buildSkillPromptMessage is cheap file I/O and covers the failure the old
	// synchronous path reported immediately (a removed or unreadable SKILL.md);
	// keep that error contract by awaiting it before answering. The expensive
	// promptCustomMessage pipeline (usage preflight, compaction checks, provider
	// calls) is what moves behind the acknowledgement.
	const built = await buildSkillPromptMessage(invocation.skill, invocation, "user");
	if (input.isCurrent && !input.isCurrent()) return "cancelled";
	// A failure before admission still resolves this wait (without rejecting this
	// call) — reportPromptResult already routed it to onError and a failed prompt_result.
	await watchAndReportPromptResult({
		ticket: input.ticket,
		startPrompt: onPromptAdmitted =>
			runRpcSkillCommand(
				input.session,
				invocation,
				input.streamingBehavior ?? "steer",
				built,
				onPromptAdmitted,
				input.images,
				input.attachmentsText ?? "",
			),
		results: input.results,
		onError: input.onError,
		extensionUserMessageTracker: input.extensionUserMessageTracker,
	});
	return { agentInvoked: true };
}

export async function tryRunRpcSkillCommand(
	session: RpcSkillCommandSession,
	text: string,
	streamingBehavior: "steer" | "followUp" = "steer",
	images?: ImageContent[],
): Promise<RpcSkillCommandResult | false> {
	const invocation = resolveRpcSkillInvocation(session, text);
	if (!invocation) return false;
	await runRpcSkillCommand(session, invocation, streamingBehavior, undefined, undefined, images);
	return { agentInvoked: true };
}

export type RpcBuiltinResidualSession = Pick<AgentSession, "prompt">;

/** Forward a builtin's residual prompt through the same RPC options as a normal prompt. */
export function promptRpcBuiltinResidual(
	session: RpcBuiltinResidualSession,
	prompt: string,
	command: Pick<Extract<RpcCommand, { type: "prompt" }>, "images" | "streamingBehavior">,
	onPromptAdmitted?: () => void,
	images?: ImageContent[],
): Promise<boolean> {
	return session.prompt(prompt, {
		images: images ?? command.images,
		streamingBehavior: command.streamingBehavior,
		onPromptAdmitted,
	});
}

export type RpcSubagentResetRegistry = Pick<RpcSubagentRegistry, "clear">;

/**
 * Handle RPC `cancel_subagent`: hard-kill one of this session's running
 * subagents through the same path as the Agent Hub / collab `kill` command.
 * Aborting the live turn and releasing the registry ref as an `aborted`
 * tombstone settles the owning `task` call (foreground or background) with an
 * aborted result, and disposing the session cancels its nested children.
 *
 * Only ids this session reported as running are reachable (see
 * {@link resolveOwnedLiveSubagent}). Returns `false` (a no-op) for unknown,
 * finished, or already-cancelled subagents so hosts can treat cancelling a
 * vanished subagent as success. Rejects when the tombstone cannot be persisted
 * or the abort fails; the subagent is still detached and disposed.
 */
export async function handleRpcCancelSubagent(
	subagentRegistry: Pick<RpcSubagentRegistry, "getSubagents">,
	subagentId: string,
): Promise<boolean> {
	const owned = resolveOwnedLiveSubagent(subagentRegistry, subagentId);
	if (!owned) return false;
	// Start the release first: it publishes the `aborted` tombstone synchronously,
	// so the executor cannot accept the run's result (flipping the ref to idle)
	// while the abort below is still settling. Settle both together so a failed
	// tombstone write is reported here instead of escaping as an unhandled
	// rejection while the abort is pending.
	const [released, aborted] = await Promise.allSettled([
		AgentLifecycleManager.global().release(subagentId, owned.ref, { tombstone: true }),
		owned.session.abort({ reason: USER_INTERRUPT_LABEL }),
	]);
	if (released.status === "rejected") throw released.reason;
	if (aborted.status === "rejected") throw aborted.reason;
	return released.value;
}

/**
 * Handle RPC `steer_subagent`: send the host's message to a running subagent
 * as its user, the same way Agent Hub chat does: `AgentLifecycleManager.ensureLive`,
 * then `prompt(message, { streamingBehavior: "steer" })` on the subagent's own
 * session. A mid-turn subagent is steered at its next step boundary; one
 * between turns starts its next turn. Because this is `prompt()`, extension,
 * custom and file slash commands run and prompt templates expand as in Agent
 * Hub chat (unlike RPC `steer`, which rejects extension commands). The message
 * is recorded in the subagent's transcript, never attributed to the parent.
 *
 * Only running subagents this session lists in `get_subagents` are reachable
 * (see {@link resolveOwnedLiveSubagent}); one whose result the parent already
 * accepted is refused. A running ref always holds a live session, so
 * `ensureLive` never revives here; it only cancels an in-flight idle park.
 *
 * Resolves once the message is accepted: queued into a running turn, or the
 * subagent's new turn started (`agent_start`). A refusal before that —
 * including a prompt dropped by an abort, disposal or usage preflight — is
 * returned as the error; the rest of the turn is not awaited and later
 * failures are logged. Returns an error message, or `undefined` once accepted.
 */
export async function handleRpcSteerSubagent(
	subagentRegistry: Pick<RpcSubagentRegistry, "getSubagents">,
	subagentId: string,
	message: string,
): Promise<string | undefined> {
	const notRunning = `Subagent not running: ${subagentId}`;
	const owned = resolveOwnedLiveSubagent(subagentRegistry, subagentId);
	if (!owned) return notRunning;
	let session: AgentSession;
	try {
		session = await AgentLifecycleManager.global().ensureLive(subagentId);
	} catch {
		return notRunning;
	}
	// ensureLive awaits; the id may now belong to a different (same-name) agent,
	// or the subagent may have finished in the meantime.
	const current = resolveOwnedLiveSubagent(subagentRegistry, subagentId);
	if (current?.ref !== owned.ref || current.session !== session) return notRunning;

	const accepted = Promise.withResolvers<void>();
	const unsubscribe = session.subscribe(event => {
		if (event.type === "agent_start") accepted.resolve();
	});
	session.prompt(message, { streamingBehavior: "steer", throwOnDrop: true }).then(
		() => accepted.resolve(),
		err => {
			accepted.reject(err);
			logger.warn("steer_subagent message failed", { subagentId, error: String(err) });
		},
	);
	try {
		await accepted.promise;
		return undefined;
	} catch (err) {
		return `Subagent refused the message: ${err instanceof Error ? err.message : String(err)}`;
	} finally {
		unsubscribe();
	}
}

export async function handleRpcSessionChange(
	session: RpcSessionChangeSession,
	command: RpcSessionChangeCommand,
	subagentRegistry?: RpcSubagentResetRegistry,
	requestedModel?: Model,
): Promise<RpcSessionChangeResult> {
	switch (command.type) {
		case "new_session": {
			const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
			const cancelled = !(await session.newSession(options));
			if (!cancelled) subagentRegistry?.clear();
			return { type: "new_session", data: { cancelled } };
		}

		case "switch_session": {
			const options = requestedModel ? { model: requestedModel } : undefined;
			const cancelled = !(await session.switchSession(command.sessionPath, options));
			if (!cancelled) subagentRegistry?.clear();
			return { type: "switch_session", data: { cancelled } };
		}

		case "branch": {
			const result = await session.branch(command.entryId);
			if (!result.cancelled) subagentRegistry?.clear();
			return { type: "branch", data: { text: result.selectedText, cancelled: result.cancelled } };
		}

		case "fork": {
			// RPC forks are snapshots: refuse while work could still write into the transcript.
			// fork() rechecks after its awaits; interactive /fork keeps carrying running bash across.
			const cancelled = !(await session.fork(command.entryId, { requireIdle: true }));
			if (!cancelled) subagentRegistry?.clear();
			return { type: "fork", data: { cancelled } };
		}
	}
	throw new Error("Unsupported RPC session change command");
}

export type RpcOpenSessionSession = Pick<
	AgentSession,
	"newSession" | "switchSession" | "sessionFile" | "sessionId" | "messages" | "model" | "setModel"
>;

/**
 * Continue the newest non-empty session in `sessionDir`, or start a fresh one
 * there — the runtime equivalent of `--session-dir <dir> --continue`, so a host
 * can bind a pre-spawned process to a conversation it keys by directory.
 * Reopening the session that is already active is a no-op and does not abort a run.
 *
 * @throws Error when the process runs without session persistence (`--no-session`).
 */
export async function openRpcSession(
	session: RpcOpenSessionSession,
	sessionDir: string,
	subagentRegistry?: RpcSubagentResetRegistry,
	model?: Model,
): Promise<RpcOpenSessionResult> {
	if (!session.sessionFile) throw new Error("open_session requires session persistence (omit --no-session)");
	const dir = path.resolve(sessionDir);
	const latest = await findMostRecentNonEmptySession(dir);
	const current = path.resolve(session.sessionFile);
	const alreadyOpen = latest
		? current === path.resolve(latest)
		: path.dirname(current) === dir && session.messages.length === 0;
	let cancelled = false;
	if (!alreadyOpen) {
		cancelled = latest
			? !(await session.switchSession(latest, model ? { model } : undefined))
			: !(await session.newSession({ sessionDir: dir }));
		if (!cancelled) subagentRegistry?.clear();
	}
	// A resumed session is bound to the model by the switch; an already-open or
	// fresh one selects it as `set_model` would.
	if (!cancelled && model && !modelsAreEqual(session.model, model)) await session.setModel(model);
	return {
		cancelled,
		resumed: !cancelled && latest !== null,
		sessionId: session.sessionId,
		sessionFile: session.sessionFile,
	};
}

/** Validate/normalize host tool definitions; shared with the project host. */
export function normalizeHostToolDefinitions(tools: RpcHostToolDefinition[]): RpcHostToolDefinition[] {
	return tools.map((tool, index) => {
		const name = typeof tool.name === "string" ? tool.name.trim() : "";
		if (!name) {
			throw new Error(`Host tool at index ${index} must provide a non-empty name`);
		}
		const description = typeof tool.description === "string" ? tool.description.trim() : "";
		if (!description) {
			throw new Error(`Host tool "${name}" must provide a non-empty description`);
		}
		if (!tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters)) {
			throw new Error(`Host tool "${name}" must provide a JSON Schema object`);
		}
		const label = typeof tool.label === "string" && tool.label.trim() ? tool.label.trim() : name;
		return {
			name,
			label,
			description,
			parameters: tool.parameters,
			hidden: tool.hidden === true,
			loadMode: defaultLoadModeForToolName(name, tool.loadMode),
			readsSkillUris: tool.readsSkillUris,
		};
	});
}

function parseValueDialogResponse(
	response: RpcExtensionUIResponse,
	dialogOptions: ExtensionUIDialogOptions | undefined,
): string | undefined {
	if ("cancelled" in response && response.cancelled) {
		if (response.timedOut) dialogOptions?.onTimeout?.();
		return undefined;
	}
	if ("value" in response) return response.value;
	return undefined;
}

function shouldEmitRpcTitles(): boolean {
	const raw = $env.PI_RPC_EMIT_TITLE;
	if (!raw) return false;
	const normalized = raw.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isSubagentSubscriptionLevel(value: unknown): value is RpcSubagentSubscriptionLevel {
	return value === "off" || value === "progress" || value === "events";
}

/** Sends an RPC select request while retaining aligned option descriptions. */
export function requestRpcSelect(
	pendingRequests: Map<string, PendingExtensionRequest>,
	output: RpcOutput,
	title: string,
	options: ExtensionUISelectItem[],
	dialogOptions?: ExtensionUIDialogOptions,
): Promise<string | undefined> {
	// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
	const labels = new Array<string>(options.length);
	let optionDetails: RpcExtensionUISelectOptionDetail[] | undefined;
	for (let index = 0; index < options.length; index++) {
		const option = options[index]!;
		labels[index] = getExtensionUISelectOptionLabel(option);
		if (typeof option === "string") continue;
		const description = option.description?.trim();
		if (!description) continue;
		optionDetails ??= Array.from({ length: options.length }, () => ({}));
		optionDetails[index] = { description };
	}

	return requestRpcDialog(
		pendingRequests,
		output,
		dialogOptions,
		undefined,
		{
			method: "select",
			title,
			options: labels,
			...(optionDetails ? { optionDetails } : {}),
			timeout: dialogOptions?.timeout,
		},
		response => parseValueDialogResponse(response, dialogOptions),
	);
}

/** Validates `ask` answers against the questions; any mismatch throws instead of guessing. */
function parseAskDialogResponse(
	response: RpcExtensionUIResponse,
	questions: ExtensionAskDialogQuestion[],
	dialogOptions: ExtensionUIDialogOptions,
): ExtensionAskDialogSubmitResult | undefined {
	if ("cancelled" in response && response.cancelled) {
		if (response.timedOut) dialogOptions.onTimeout?.();
		return undefined;
	}
	const answers: unknown = "answers" in response ? response.answers : undefined;
	if (!Array.isArray(answers) || answers.length !== questions.length) {
		throw new Error(`Ask dialog response must carry ${questions.length} answers in question order`);
	}
	return {
		kind: "submit",
		results: questions.map((question, index) => {
			const answer: unknown = answers[index];
			if (!isRecord(answer) || answer.id !== question.id) {
				throw new Error(`Ask dialog answer ${index} must have id ${JSON.stringify(question.id)}`);
			}
			const labels = question.options.map(option => option.label);
			const multi = question.multi ?? false;
			const { selectedOptions, customInput } = answer;
			if (!Array.isArray(selectedOptions)) {
				throw new Error(`Ask dialog answer ${JSON.stringify(question.id)} must carry a selectedOptions array`);
			}
			const selected: string[] = [];
			for (const label of selectedOptions) {
				if (typeof label !== "string" || !labels.includes(label)) {
					throw new Error(
						`Ask dialog answer ${JSON.stringify(question.id)} selected unknown option ${JSON.stringify(label)}`,
					);
				}
				if (selected.includes(label)) {
					throw new Error(
						`Ask dialog answer ${JSON.stringify(question.id)} selected ${JSON.stringify(label)} twice`,
					);
				}
				selected.push(label);
			}
			if (customInput !== undefined && typeof customInput !== "string") {
				throw new Error(`Ask dialog answer ${JSON.stringify(question.id)} customInput must be a string`);
			}
			const custom = customInput?.trim() || undefined;
			if (!multi && (selected.length > 1 || (selected.length > 0 && custom !== undefined))) {
				throw new Error(
					`Ask dialog answer ${JSON.stringify(question.id)} is single-select but carries more than one answer`,
				);
			}
			return {
				id: question.id,
				question: question.question,
				options: labels,
				multi,
				selectedOptions: selected,
				customInput: custom,
			};
		}),
	};
}

/** Sends all ask questions as one RPC `ask` dialog; a timeout answers every question with its recommended option. */
export async function requestRpcAskDialog(
	pendingRequests: Map<string, PendingExtensionRequest>,
	output: RpcOutput,
	questions: ExtensionAskDialogQuestion[],
	dialogOptions?: ExtensionUIDialogOptions,
): Promise<ExtensionAskDialogResult | undefined> {
	let timedOut = false;
	const opts: ExtensionUIDialogOptions = {
		...dialogOptions,
		onTimeout: () => {
			timedOut = true;
			dialogOptions?.onTimeout?.();
		},
	};
	const result = await requestRpcDialog(
		pendingRequests,
		output,
		opts,
		undefined,
		{ method: "ask", questions, timeout: dialogOptions?.timeout },
		response => parseAskDialogResponse(response, questions, opts),
	);
	return timedOut ? timedOutAskDialogResult(questions) : result;
}

export function requestRpcEditor(
	pendingRequests: Map<string, PendingExtensionRequest>,
	output: RpcOutput,
	title: string,
	prefill?: string,
	dialogOptions?: ExtensionUIDialogOptions,
	editorOptions?: { promptStyle?: boolean },
): Promise<string | undefined> {
	if (dialogOptions?.signal?.aborted) return Promise.resolve(undefined);

	const id = Snowflake.next() as string;
	const { promise, resolve, reject } = Promise.withResolvers<string | undefined>();
	let settled = false;

	const cleanup = () => {
		dialogOptions?.signal?.removeEventListener("abort", onAbort);
		pendingRequests.delete(id);
	};
	const finish = (value: string | undefined) => {
		if (settled) return;
		settled = true;
		cleanup();
		resolve(value);
	};
	const fail = (error: Error) => {
		if (settled) return;
		settled = true;
		cleanup();
		reject(error);
	};
	const onAbort = () => {
		output({
			type: "extension_ui_request",
			id: Snowflake.next() as string,
			method: "cancel",
			targetId: id,
		} as RpcExtensionUIRequest);
		finish(undefined);
	};

	dialogOptions?.signal?.addEventListener("abort", onAbort, { once: true });
	pendingRequests.set(id, {
		resolve: response => {
			if ("cancelled" in response && response.cancelled) {
				finish(undefined);
			} else if ("value" in response) {
				finish(response.value);
			} else {
				finish(undefined);
			}
		},
		reject: fail,
	});
	output({
		type: "extension_ui_request",
		id,
		method: "editor",
		title,
		prefill,
		promptStyle: editorOptions?.promptStyle,
	} as RpcExtensionUIRequest);
	return promise;
}

/** Sends an RPC extension dialog and cancels the remote presentation when its signal aborts. */
export function requestRpcDialog<T>(
	pendingRequests: Map<string, PendingExtensionRequest>,
	output: RpcOutput,
	opts: ExtensionUIDialogOptions | undefined,
	defaultValue: T,
	request: Record<string, unknown>,
	parseResponse: (response: RpcExtensionUIResponse) => T,
): Promise<T> {
	if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

	const id = Snowflake.next() as string;
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	let timeoutId: NodeJS.Timeout | undefined;

	const cleanup = () => {
		clearTimeout(timeoutId);
		opts?.signal?.removeEventListener("abort", onAbort);
		pendingRequests.delete(id);
	};
	// Tells the host to close a dialog omp has already settled, so a late answer
	// cannot look actionable after abort or timeout.
	const cancelHostDialog = () =>
		output({
			type: "extension_ui_request",
			id: Snowflake.next() as string,
			method: "cancel",
			targetId: id,
		} as RpcExtensionUIRequest);
	const onAbort = () => {
		cancelHostDialog();
		cleanup();
		resolve(defaultValue);
	};
	opts?.signal?.addEventListener("abort", onAbort, { once: true });

	if (opts?.timeout !== undefined) {
		timeoutId = setTimeout(() => {
			opts.onTimeout?.();
			cancelHostDialog();
			cleanup();
			resolve(defaultValue);
		}, opts.timeout);
	}

	pendingRequests.set(id, {
		resolve: response => {
			cleanup();
			try {
				resolve(parseResponse(response));
			} catch (err) {
				reject(err);
			}
		},
		reject: error => {
			cleanup();
			reject(error);
		},
	});
	output({ type: "extension_ui_request", id, ...request } as RpcExtensionUIRequest);
	return promise;
}

/**
 * Applies a queue-mode RPC command to the calling session only. Owns the
 * `persist: false` contract (#11555) in one place so no dispatcher arm can
 * silently restore machine-global writes.
 */
export function applyRpcQueueModeCommand(session: AgentSession, command: RpcQueueModeCommand): void {
	switch (command.type) {
		case "set_steering_mode":
			session.setSteeringMode(command.mode, false);
			break;
		case "set_follow_up_mode":
			session.setFollowUpMode(command.mode, false);
			break;
		case "set_interrupt_mode":
			session.setInterruptMode(command.mode, false);
			break;
	}
}

/**
 * Report a store failure as an error `notice` frame and a session move as a
 * warning one (each with a stderr mirror) — issue #11493. Frames go straight
 * through the mode's `output` rather than `session.emitNotice`: dispose clears
 * the session's event listeners before it closes the store (agent-session.ts
 * `#doDispose`), so a failure latched during `close()` would have no subscriber
 * left to forward it and the client would see a nonzero exit with no notice at
 * all. `onFailure` records the failure for the mode's own teardown
 * attribution: a failure still latched at dispose is what makes
 * `session.dispose()` reject.
 */
export function registerRpcPersistenceSurface(
	session: Pick<AgentSession, "sessionManager">,
	output: (frame: object) => void,
	onFailure?: (error: Error) => void,
): () => void {
	const unsubscribeFailures = session.sessionManager.onPersistenceError(error => {
		onFailure?.(error);
		const message = formatPersistenceFailure(error.message);
		output({ type: "notice", level: "error", message, source: "session-persistence" });
		process.stderr.write(`${message}\n`);
	});
	const unsubscribeNotices = session.sessionManager.onPersistenceNotice(notice => {
		const message = formatPersistenceNotice(notice);
		output({ type: "notice", level: "warning", message, source: "session-persistence" });
		process.stderr.write(`${message}\n`);
	});
	return () => {
		unsubscribeFailures();
		unsubscribeNotices();
	};
}

/**
 * Coordinates deferred shutdown with in-flight background input tasks.
 *
 * `pi.shutdown()` from an extension only *requests* shutdown; the process must
 * not exit while a background-dispatched command (`bash`, `predict_word`,
 * `prompt` or `steer_subagent`, see
 * {@link dispatchRpcInputFrame}) still owes the client a response frame. The
 * coordinator tracks those tasks, re-checks the shutdown request whenever one
 * settles (covering a shutdown requested mid-command with no follow-up client
 * frame), and drains every tracked task before invoking `performShutdown`.
 * The shutdown sequence is latched so concurrent triggers (input loop and
 * settling tasks) run it exactly once.
 */
export class RpcShutdownCoordinator {
	#tasks = new Set<Promise<void>>();
	#shutdown: Promise<void> | undefined;
	readonly #isShutdownRequested: () => boolean;
	readonly #performShutdown: () => Promise<void>;

	constructor(options: { isShutdownRequested: () => boolean; performShutdown: () => Promise<void> }) {
		this.#isShutdownRequested = options.isShutdownRequested;
		this.#performShutdown = options.performShutdown;
	}

	/**
	 * Track a background input task. When it settles it is untracked and the
	 * shutdown request is re-checked, so a deferred shutdown fires even when
	 * no further client frames arrive.
	 */
	track(task: Promise<void>): void {
		this.#tasks.add(task);
		void task.finally(() => {
			this.#tasks.delete(task);
			// Fire-and-forget: performShutdown ends the process. Rejections are
			// not expected — hook errors are caught inside extensionRunner.emit,
			// and background tasks catch their own dispatch errors.
			void this.checkShutdownRequested();
		});
	}

	/** Await every tracked task, including tasks tracked while draining. */
	async drain(): Promise<void> {
		while (this.#tasks.size > 0) {
			await Promise.allSettled(Array.from(this.#tasks));
		}
	}

	/**
	 * If shutdown was requested, drain background tasks (so every owed
	 * response frame is written) before running the shutdown sequence.
	 */
	checkShutdownRequested(): Promise<void> {
		if (!this.#shutdown) {
			if (!this.#isShutdownRequested()) return Promise.resolve();
			this.#shutdown = this.drain().then(() => this.#performShutdown());
		}
		return this.#shutdown;
	}
}

/**
 * Extension UI context that uses the RPC protocol.
 */
class RpcExtensionUIContext implements ExtensionUIContext {
	/** Set by `set_ask_dialog`; hosts that never opt in keep the select/editor ask fallback. */
	askDialogEnabled = false;

	constructor(
		private pendingRequests: Map<string, PendingExtensionRequest>,
		private output: (obj: RpcResponse | RpcExtensionUIRequest | object) => void,
		private forkAskBroker?: RpcForkAskBroker,
		private emitTitles = false,
	) {}

	/**
	 * Rich ask over the v3 protocol (rpc-fork-ask). Preferred while the client
	 * negotiated v3: it carries ask_pause and chat escalation the stock opt-in
	 * dialog has no wire for. Otherwise the upstream opt-in ask (set_ask_dialog)
	 * applies; undefined means the ask tool keeps its per-question select fallback.
	 */
	get askDialog(): ExtensionUIContext["askDialog"] {
		const forkDialog = this.forkAskBroker?.getAskDialog();
		if (forkDialog) return forkDialog;
		if (!this.askDialogEnabled) return undefined;
		return (questions, dialogOptions) =>
			requestRpcAskDialog(this.pendingRequests, this.output, questions, dialogOptions);
	}

	select(
		title: string,
		options: ExtensionUISelectItem[],
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return requestRpcSelect(this.pendingRequests, this.output, title, options, dialogOptions);
	}

	confirm(title: string, message: string, dialogOptions?: ExtensionUIDialogOptions): Promise<boolean> {
		return requestRpcDialog(
			this.pendingRequests,
			this.output,
			dialogOptions,
			false,
			{ method: "confirm", title, message, timeout: dialogOptions?.timeout },
			response => {
				if ("cancelled" in response && response.cancelled) {
					if (response.timedOut) dialogOptions?.onTimeout?.();
					return false;
				}
				if ("confirmed" in response) return response.confirmed;
				return false;
			},
		);
	}

	input(title: string, placeholder?: string, dialogOptions?: ExtensionUIDialogOptions): Promise<string | undefined> {
		return this.inputWithOptions(title, placeholder, dialogOptions);
	}

	/** Input dialog with the v3 `sensitive` wire flag (login secret inputs). */
	inputSensitive(
		title: string,
		placeholder?: string,
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return this.inputWithOptions(title, placeholder, dialogOptions, true);
	}

	private inputWithOptions(
		title: string,
		placeholder?: string,
		dialogOptions?: ExtensionUIDialogOptions,
		sensitive?: boolean,
	): Promise<string | undefined> {
		return requestRpcDialog(
			this.pendingRequests,
			this.output,
			dialogOptions,
			undefined,
			{
				method: "input",
				title,
				placeholder,
				timeout: dialogOptions?.timeout,
				...(sensitive ? { sensitive: true } : {}),
			},
			response => parseValueDialogResponse(response, dialogOptions),
		);
	}

	onTerminalInput(): () => void {
		// Raw terminal input not supported in RPC mode
		return () => {};
	}

	notify(message: string, type?: "info" | "warning" | "error"): void {
		// Fire and forget - no response needed
		this.output({
			type: "extension_ui_request",
			id: Snowflake.next() as string,
			method: "notify",
			message,
			notifyType: type,
		} as RpcExtensionUIRequest);
	}

	setStatus(key: string, text: string | undefined): void {
		// Fire and forget - no response needed
		this.output({
			type: "extension_ui_request",
			id: Snowflake.next() as string,
			method: "setStatus",
			statusKey: key,
			statusText: text,
		} as RpcExtensionUIRequest);
	}

	setWorkingMessage(_message?: string): void {
		// Not supported in RPC mode
	}

	setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
		// Only support string arrays in RPC mode - factory functions are ignored
		if (content === undefined || Array.isArray(content)) {
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "setWidget",
				widgetKey: key,
				widgetLines: content as string[] | undefined,
				widgetPlacement: options?.placement,
			} as RpcExtensionUIRequest);
		}
		// Component factories are not supported in RPC mode - would need TUI access
	}

	setFooter(_factory: unknown): void {
		// Custom footer not supported in RPC mode - requires TUI access
	}

	setHeader(_factory: unknown): void {
		// Custom header not supported in RPC mode - requires TUI access
	}

	setTitle(title: string): void {
		// Title updates are low-value noise for most RPC hosts; opt in via PI_RPC_EMIT_TITLE=1.
		if (!this.emitTitles) return;
		this.output({
			type: "extension_ui_request",
			id: Snowflake.next() as string,
			method: "setTitle",
			title,
		} as RpcExtensionUIRequest);
	}

	async custom(): Promise<never> {
		// Custom UI not supported in RPC mode
		return undefined as never;
	}

	pasteToEditor(text: string): void {
		// Paste handling not supported in RPC mode - falls back to setEditorText
		this.setEditorText(text);
	}

	setEditorText(text: string): void {
		// Fire and forget - host can implement editor control
		this.output({
			type: "extension_ui_request",
			id: Snowflake.next() as string,
			method: "set_editor_text",
			text,
		} as RpcExtensionUIRequest);
	}

	getEditorText(): string {
		// Synchronous method can't wait for RPC response
		// Host should track editor state locally if needed
		return "";
	}

	async editor(
		title: string,
		prefill?: string,
		dialogOptions?: ExtensionUIDialogOptions,
		editorOptions?: { promptStyle?: boolean },
	): Promise<string | undefined> {
		return requestRpcEditor(this.pendingRequests, this.output, title, prefill, dialogOptions, editorOptions);
	}

	addAutocompleteProvider(): void {
		// Autocomplete provider composition is not supported in RPC mode
	}

	get theme(): Theme {
		return theme;
	}

	getAllThemes(): Promise<{ name: string; path: string | undefined }[]> {
		return Promise.resolve([]);
	}

	getTheme(_name: string): Promise<Theme | undefined> {
		return Promise.resolve(undefined);
	}

	setTheme(_theme: string | Theme): Promise<{ success: boolean; error?: string }> {
		// Theme switching not supported in RPC mode
		return Promise.resolve({ success: false, error: "Theme switching not supported in RPC mode" });
	}

	getToolsExpanded() {
		// Tool expansion not supported in RPC mode - no TUI
		return false;
	}

	setToolsExpanded(_expanded: boolean) {
		// Tool expansion not supported in RPC mode - no TUI
	}

	setEditorComponent(): void {
		// Custom editor components not supported in RPC mode
	}
}

/** UTF-8 JSON size of `value`, as compared against the transport's response byte ceiling. */
function encodedBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value));
}

/**
 * Build the `remove_queued_message` response within `maxBytes`. The message is already removed,
 * so an oversized response must not become a transport-limit error that loses it: its images are
 * omitted instead (`imagesDropped`).
 */
export function fitRemoveQueuedMessageResponse(
	id: string | undefined,
	removed: RestoredQueuedMessage | undefined,
	maxBytes: number,
): RpcResponse {
	const response = (data: RpcRemoveQueuedMessageResult): RpcResponse => ({
		id,
		type: "response",
		command: "remove_queued_message",
		success: true,
		data,
	});
	if (!removed?.images) return response({ removed: removed !== undefined });
	const full = response({ removed: true, images: removed.images });
	return encodedBytes(full) <= maxBytes ? full : response({ removed: true, imagesDropped: true });
}

/**
 * Build the `abort_and_restore_queue` response within `maxBytes`. The queue is already withdrawn,
 * so an oversized response must not become a transport-limit error that loses it: images go first
 * (`imagesDropped`, keeping every text), then the newest entries (`truncated`, keeping an
 * oldest-first prefix of steering then follow-ups).
 */
export function fitAbortAndRestoreQueueResponse(
	id: string | undefined,
	restored: RpcAbortAndRestoreQueueResult,
	maxBytes: number,
): RpcResponse {
	const response = (data: RpcAbortAndRestoreQueueResult): RpcResponse => ({
		id,
		type: "response",
		command: "abort_and_restore_queue",
		success: true,
		data,
	});
	const full = response(restored);
	if (encodedBytes(full) <= maxBytes) return full;
	const imagesDropped = [...restored.steering, ...restored.followUp].some(entry => entry.images?.length);
	const flags = imagesDropped ? { imagesDropped: true as const } : {};
	const textOnly = {
		steering: restored.steering.map(({ text }) => ({ text })),
		followUp: restored.followUp.map(({ text }) => ({ text })),
	};
	if (imagesDropped) {
		const withoutImages = response({ ...textOnly, ...flags });
		if (encodedBytes(withoutImages) <= maxBytes) return withoutImages;
	}
	const fitted: RpcAbortAndRestoreQueueResult = { steering: [], followUp: [], ...flags, truncated: true };
	// Exact: each entry adds its own JSON plus a comma after the first in its array.
	let remaining = maxBytes - encodedBytes(response(fitted));
	for (const queue of ["steering", "followUp"] as const) {
		for (const entry of textOnly[queue]) {
			const cost = encodedBytes(entry) + (fitted[queue].length > 0 ? 1 : 0);
			if (cost > remaining) return response(fitted);
			fitted[queue].push(entry);
			remaining -= cost;
		}
	}
	return response(fitted);
}

/** Startup options for {@link RpcSessionHost}. */
export interface RpcSessionHostOptions {
	readonly session: AgentSession;
	/** Outbound frame channel; the host must NOT stamp project fields (caller does). */
	readonly output: RpcOutput;
	readonly subagentEventBus?: EventBus;
	readonly headless?: boolean;
	readonly setToolUIContext?: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
	/** Project mode semantics: prompt defaults to plain-text (inputMode "text"); strict command dispatch only via inputMode "auto"/execute_command. */
	readonly projectMode?: boolean;
	/** Shared host-tool/URI bridges (project mode registers tools once for all sessions). When omitted the host owns its own bridges. */
	readonly sharedBridges?: {
		readonly hostToolBridge: RpcHostToolBridge;
		readonly hostUriBridge: RpcHostUriBridge;
	};
	/** True when process shutdown was requested (legacy shutdownState.requested). */
	readonly isShutdownRequested?: () => boolean;
	/** Track a background task for shutdown draining (legacy shutdownCoordinator.track). */
	readonly trackBackgroundTask?: (task: Promise<void>) => void;
	/**
	 * Shared user-input ordering gate (upstream PR #13027). The transport
	 * passes one instance and calls `accept` at frame-arrival time so an abort
	 * or session change invalidates earlier still-queued input; when omitted
	 * the host runs a private gate (ordering only, no cross-frame abort
	 * invalidation — single-session tests use this).
	 */
	readonly inputGate?: RpcUserInputGate;
	/** Builds `live_start` sessions; defaults to the real {@link RpcLiveBridge} controller. */
	readonly createLiveSession?: RpcLiveSessionFactory;
	/**
	 * Largest intact response size under the negotiated protocol (the transport's
	 * `RpcFrameEncoder.maxResponseBytes`); defaults to the v1 single-frame ceiling.
	 */
	readonly maxResponseBytes?: () => number;
}

/** Run state as observed by the hosting process (project mode aggregation). */
export type RpcSessionHostRunState = "idle" | "streaming" | "waiting_interaction" | "closing";

/**
 * One AgentSession's RPC protocol surface.
 *
 * Holds everything the legacy `runRpcMode` closure bound to a single session:
 * the fork-extension controllers, prompt-result reporting, extension UI
 * context and pending-request map, host tool/URI bridges, subagent registry,
 * and the command switch. The transport (stdin framing, output writer, the
 * input dispatcher loop, process exit) stays with the caller.
 */
const USER_INPUT_TYPES: Record<string, true> = {
	prompt: true,
	steer: true,
	follow_up: true,
	abort_and_prompt: true,
};
const SESSION_CHANGE_TYPES: Record<string, true> = {
	new_session: true,
	switch_session: true,
	branch: true,
	fork: true,
	open_session: true,
};

/**
 * Orders native user input (upstream PR #13027). Every accepted command gets a
 * sequence number at frame-arrival time; an abort raises `#validFrom` so
 * earlier still-queued input dies at its next `isCurrent` check, and a session
 * change commits its sequence once it succeeds. `enqueue` serializes the
 * gated arms without blocking the stdin reader. Re-entrant `enqueue` calls —
 * a dispatch wrapped inside an already-ordered section, e.g. project-mode
 * `execute_command` resolving its catalog before handing a synthetic prompt to
 * the same gate — run inline so the whole section keeps one arrival order.
 * Re-entrancy follows the running section's dynamic extent only: the store
 * names the gate and the section token actually running on it, and `enqueue`
 * inlines only while that exact section is still running — so an unrelated
 * frame whose enqueue happens while a section is suspended across an `await`,
 * a callback the section scheduled that outlives it, and any other gate
 * instance all queue in arrival order instead.
 */

/** Identity of the running gate section: inline re-entrancy matches this exact pair. */
interface GateSectionScope {
	readonly gate: RpcUserInputGate;
	readonly section: number;
}

const gateSectionScope = new AsyncLocalStorage<GateSectionScope>();

export class RpcUserInputGate {
	#tail: Promise<void> = Promise.resolve();
	#sequence = 0;
	#validFrom = 0;
	#acceptedAt = new WeakMap<object, number>();
	/** Monotonic token handed to each queued section; `#runningSection` holds the live one. */
	#sectionCounter = 0;
	#runningSection = 0;

	accept(command: RpcCommand): void {
		const isAbort =
			command.type === "abort" || command.type === "abort_and_prompt" || command.type === "abort_and_restore_queue";
		if (
			!isAbort &&
			!Object.hasOwn(USER_INPUT_TYPES, command.type) &&
			!Object.hasOwn(SESSION_CHANGE_TYPES, command.type)
		) {
			return;
		}
		const sequence = ++this.#sequence;
		this.#acceptedAt.set(command, sequence);
		if (isAbort) this.#validFrom = sequence;
	}

	commitSessionChange(command: RpcCommand): void {
		const sequence = this.#acceptedAt.get(command);
		if (sequence !== undefined && sequence > this.#validFrom) this.#validFrom = sequence;
	}

	isCurrent(command: RpcCommand): boolean {
		const sequence = this.#acceptedAt.get(command);
		return sequence !== undefined && sequence >= this.#validFrom;
	}

	enqueue<T>(work: () => Promise<T>): Promise<T> {
		// Only enqueues reached from within the currently running section's own
		// async subtree (across its awaits), on this same gate, run inline; a
		// busy gate still forces every independently dispatched frame to queue
		// behind it in arrival order, and contexts that merely carry a settled
		// section's store (timers it scheduled, other gate instances) queue too.
		const scope = gateSectionScope.getStore();
		if (scope && scope.gate === this && scope.section === this.#runningSection) return work();
		const section = ++this.#sectionCounter;
		const run = this.#tail.then(
			() => this.#runSection(section, work),
			() => this.#runSection(section, work),
		);
		this.#tail = run.then(
			() => {},
			() => {},
		);
		return run;
	}

	/**
	 * Runs one queued section under its scope token. The token is live only
	 * from the section's actual start until its work settles — the cleanup runs
	 * before the tail chain advances — which is exactly what enqueue's inline
	 * check matches against.
	 */
	#runSection<T>(section: number, work: () => Promise<T>): Promise<T> {
		this.#runningSection = section;
		try {
			return gateSectionScope.run({ gate: this, section }, work).finally(() => {
				if (this.#runningSection === section) this.#runningSection = 0;
			});
		} catch (error) {
			// work() itself threw synchronously: no promise will run the finally.
			if (this.#runningSection === section) this.#runningSection = 0;
			throw error;
		}
	}
}

export class RpcSessionHost {
	readonly session: AgentSession;
	readonly forkHost: RpcForkHost;
	readonly promptResults: RpcPromptResults;
	readonly pendingExtensionRequests: RpcPendingExtensionRequests;
	readonly subagentRegistry: RpcSubagentRegistry | undefined;
	/** Host tool bridge in use: shared (project mode) or owned by this host. */
	readonly hostToolBridge: RpcHostToolBridge;
	/** Host URI bridge in use: shared (project mode) or owned by this host. */
	readonly hostUriBridge: RpcHostUriBridge;

	readonly #options: RpcSessionHostOptions;
	readonly #output: RpcOutput;
	readonly #extensionUserMessageTracker = new RpcExtensionUserMessageTracker();
	readonly #wordPredictor = new RpcWordPredictor();
	readonly #sessionEvents: RpcSessionEventForwarder;
	readonly #settleWatcher: RpcSessionSettleWatcher;
	/** Goal-mode RPC surface (upstream): ops, continuation turns, and session-change quiesce. */
	readonly #goalController: RpcGoalController;
	/** Scheduled goal turns keep settlement busy until admission. */
	readonly #goalTurnScheduled: () => boolean;
	/** Live voice sessions (`live_start`/`live_stop`/`live_mute`), at most one per host. */
	readonly #live: RpcLiveBridge;
	/** `/btw` side questions: one at a time per session, checkpointed into the session's BTW history. */
	readonly #btw: RpcBtwController;
	readonly #forkAskBroker: RpcForkAskBroker;
	readonly #uiContext: RpcExtensionUIContext;
	readonly #emitRpcTitles: boolean;
	/** Shutdown request flag (wrapped in object to allow mutation with const). */
	readonly #shutdownState = { requested: false };
	#unsubscribers: Array<() => void> = [];
	#persistenceFailure: Error | undefined;
	#internalCoordinator: RpcShutdownCoordinator | undefined;
	#disposed = false;
	readonly #inputGate: RpcUserInputGate;
	readonly #maxResponseBytes: () => number;

	constructor(options: RpcSessionHostOptions) {
		this.#options = options;
		this.session = options.session;
		this.#output = options.output;
		this.#inputGate = options.inputGate ?? new RpcUserInputGate();
		this.#maxResponseBytes = options.maxResponseBytes ?? (() => MAX_RPC_FRAME_BYTES - 1);

		this.#emitRpcTitles = shouldEmitRpcTitles();
		// A continuation abandoned while waiting leaves nothing to end the activity stretch: re-check settlement.
		this.#goalController = new RpcGoalController(this.session, () => void this.#settleWatcher.check());
		// A scheduled or held goal turn will start a turn: every settle report treats it as busy,
		// and any report of "not settled" for that reason is later closed by `session_settled`.
		this.#goalTurnScheduled = watchedScheduledTurnProbe(
			() => this.#goalController.continuationPending,
			() => this.#settleWatcher,
		);
		this.promptResults = new RpcPromptResults(this.session, this.#output, this.#goalTurnScheduled);
		this.#sessionEvents = new RpcSessionEventForwarder(this.#output);
		this.#settleWatcher = new RpcSessionSettleWatcher(this.session, this.#output, this.#goalTurnScheduled);
		// Live frames go straight to `output`, so `set_event_filter` (session events only) never drops them.
		this.#live = new RpcLiveBridge(this.session, this.#output, this.#options.createLiveSession);
		this.#btw = new RpcBtwController(this.session, frame => this.#output(frame));

		// Fork-extension (protocol v3) surface: negotiation-gated dispatch point.
		// Inactive until `negotiate_protocol {protocolVersion:3}` succeeds; inactive
		// hosts leave every frame on the stock code path unchanged.
		this.forkHost = new RpcForkHost({
			emit: frame => this.#output(frame),
			success: (id, command, data) => this.success(id, command as RpcCommand["type"], data),
			error: (id, command, message, code) => this.error(id, command, message, code),
		});
		this.#forkAskBroker = new RpcForkAskBroker(this.forkHost, frame => this.#output(frame));
		new RpcForkPermissionController(this.forkHost, this.session, { projectMode: this.#options.projectMode });

		this.pendingExtensionRequests = new RpcPendingExtensionRequests();
		this.hostToolBridge = options.sharedBridges?.hostToolBridge ?? new RpcHostToolBridge(this.#output);
		this.hostUriBridge =
			options.sharedBridges?.hostUriBridge ?? new RpcHostUriBridge(this.#output, undefined, this.session.sessionId);
		this.subagentRegistry = options.subagentEventBus
			? new RpcSubagentRegistry(options.subagentEventBus, this.#output)
			: undefined;

		// Wire up UI context for tool execution (ask tool, etc.) and extensions.
		// A single shared instance routes all responses received on stdin to the
		// correct waiting promise regardless of which code path created the request.
		this.#uiContext = new RpcExtensionUIContext(
			this.pendingExtensionRequests,
			this.#output,
			this.#forkAskBroker,
			this.#emitRpcTitles,
		);
		options.setToolUIContext?.(this.#uiContext, true);
	}

	/**
	 * Store failure latched by the persistence surface, for the caller's own
	 * dispose attribution (a failure still latched at dispose is what makes
	 * `session.dispose()` reject).
	 */
	get persistenceFailure(): Error | undefined {
		return this.#persistenceFailure;
	}

	/** Response constructors — same shapes as the legacy runRpcMode closures. */
	success<T extends RpcCommand["type"]>(id: string | undefined, command: T, data?: object | null): RpcResponse {
		if (data === undefined) {
			return { id, type: "response", command, success: true } as RpcResponse;
		}
		return { id, type: "response", command, success: true, data } as RpcResponse;
	}

	error(id: string | undefined, command: string, message: string, code?: string): RpcResponse {
		return { id, type: "response", command, success: false, error: message, ...(code ? { code } : {}) };
	}

	/**
	 * Set up extensions with the RPC-based UI context. The default report/track
	 * hooks reproduce the legacy runRpcMode wiring exactly; callers may
	 * override them. Extension-originated `pi.shutdown()` requests latch on
	 * this host (see {@link isShutdownRequested}).
	 */
	async initializeExtensions(
		reportSendError: (action: ExtensionSendAction, error: Error) => void = (action, err) =>
			this.#output(this.error(undefined, action, err.message)),
		reportRuntimeError: (error: ExtensionError) => void = err =>
			this.#output({
				type: "extension_error",
				extensionPath: err.extensionPath,
				event: err.event,
				error: err.error,
			}),
		trackAgentInvokingMessage: (task: Promise<unknown>) => void = task =>
			this.#extensionUserMessageTracker.trackAgentMessageTask(task),
	): Promise<void> {
		await initializeExtensions(this.session, {
			mode: "rpc",
			// Extension-initiated session changes get the same goal quiesce/reattach as the commands below.
			wrapSessionChange: async <T extends { cancelled: boolean }>(
				change: () => Promise<T>,
				{ detachesRun }: { detachesRun: boolean },
			): Promise<T> => {
				await this.#btw.close();
				await this.#goalController.beginSessionChange();
				let result: T | undefined;
				try {
					result = await change();
					return result;
				} finally {
					// Reattaches only if the session actually changed, then re-checks settlement.
					// A change that throws may already have detached the run: count it as detached.
					await this.#goalController.endSessionChange({ detachedRun: detachesRun && result?.cancelled !== true });
					if (result && !result.cancelled) {
						// As for the host's new/switch commands: a detached run never yields, so
						// close the prompts it was answering. Branch and navigation leave a live
						// run streaming to its normal yield.
						if (detachesRun) this.promptResults.abortOpen();
						void this.#settleWatcher.check();
					}
				}
			},
			reportSendError,
			reportRuntimeError,
			onShutdown: () => {
				this.#shutdownState.requested = true;
			},
			trackAgentInvokingMessage,
			// Headless hosts get the extension runner's no-op UI: hasUI=false, dialogs resolve to defaults.
			uiContext: this.#options.headless ? undefined : this.#uiContext,
		});
	}

	/**
	 * Attach the session-bound listeners: per-hook telemetry, session event
	 * forwarding (events, prompt results, settle watcher), the persistence
	 * failure surface, and command-metadata updates. Call once after
	 * construction (after {@link initializeExtensions}, preserving the legacy
	 * startup order). Teardown handles are kept for {@link dispose}.
	 */
	async start(): Promise<void> {
		// Output all agent events as JSON; prompt results follow the frame that settled them.
		this.#unsubscribers.push(
			this.session.subscribe(event => {
				this.#sessionEvents.forward(event);
				// Before the prompt-result and settle reports: a goal continuation decided at this
				// agent_end is scheduled (and reported as pending) before either reads settlement.
				this.#goalController.observe(event);
				this.promptResults.observe(event);
				this.#settleWatcher.observe(event);
			}),
		);
		await this.#goalController.reconcile();
		await this.#goalController.settled();

		// Discriminates a store failure from any other dispose rejection below.
		// The unsubscribe handle is deliberately NOT kept: the surface must stay
		// registered until the caller disposes the session so a store-close
		// failure still reaches the client as a `notice` frame (the legacy mode
		// never unsubscribed it either).
		registerRpcPersistenceSurface(
			this.session,
			frame => this.#output(frame),
			error => {
				this.#persistenceFailure = error;
			},
		);

		this.#unsubscribers.push(
			this.session.subscribeCommandMetadataChanged(() => {
				void this.emitAvailableCommandsUpdate();
			}),
		);
		await this.emitAvailableCommandsUpdate();
	}

	/** Handle a single command. */
	async handleCommand(command: RpcCommand): Promise<RpcResponse> {
		const id = command.id;
		const session = this.session;

		switch (command.type) {
			case "negotiate_protocol": {
				if (!isNegotiableRpcProtocolVersion(command.protocolVersion))
					return this.error(
						id,
						"negotiate_protocol",
						`Unsupported RPC protocol version: ${command.protocolVersion}`,
					);
				if (command.protocolVersion === RPC_FORK_PROTOCOL_VERSION) this.forkHost.activate();
				return this.success(id, "negotiate_protocol", { protocolVersion: command.protocolVersion });
			}

			// =================================================================
			// Prompting
			// =================================================================

			case "prompt": {
				// Project mode: `inputMode` defaults to "text" — the
				// message is plain model input even when it starts with "/" — and
				// only `inputMode: "auto"` routes through the strict command
				// dispatch chain. The legacy single-session mode keeps that chain
				// (and its unknown-slash fallback to the model) unconditionally.
				const strictCommandDispatch = !this.#options.projectMode || command.inputMode === "auto";
				// Taken before any dispatch so a builtin that schedules a turn (e.g. `/retry`)
				// cannot start its run ahead of the prompt's event-stream position.
				const ticket = this.promptResults.begin(id);
				try {
					const outcome = await this.#dispatchOrderedUserInput(command, ticket, strictCommandDispatch);
					if (typeof outcome === "object") {
						this.promptResults.discard(ticket);
						return outcome.setupError;
					}
					if (outcome === "unknown-command") {
						this.promptResults.discard(ticket);
						const commandName = command.message.trim().split(/\s+/)[0]!;
						return this.error(id, "prompt", `Unknown command: ${commandName}`, "unknown_command");
					}
					if (outcome === "local") {
						this.promptResults.discard(ticket);
						return this.success(id, "prompt", { agentInvoked: false });
					}
					if (outcome === "skill-invoked") {
						return this.success(id, "prompt", { agentInvoked: true });
					}
					if (outcome === "builtin-agent") return this.success(id, "prompt", { agentInvoked: true });
					if (outcome === "cancelled") {
						this.promptResults.settle(ticket);
						return this.success(id, "prompt");
					}
					return this.success(id, "prompt");
				} catch (promptSetupError) {
					// Rejected before acceptance: the error response is the only answer.
					this.promptResults.discard(ticket);
					throw promptSetupError;
				}
			}

			case "steer":
			case "follow_up": {
				const outcome = await this.#dispatchOrderedUserInput(command, undefined, false);
				if (typeof outcome === "object") return outcome.setupError;
				return this.success(id, command.type);
			}

			case "remove_queued_message": {
				if (typeof command.message !== "string") {
					return this.error(id, "remove_queued_message", "message must be a string");
				}
				if (command.queue !== "steering" && command.queue !== "followUp") {
					return this.error(id, "remove_queued_message", 'queue must be "steering" or "followUp"');
				}
				return fitRemoveQueuedMessageResponse(
					id,
					session.takeQueuedMessage(command.message, command.queue),
					this.#maxResponseBytes(),
				);
			}

			case "promote_queued_message": {
				if (typeof command.message !== "string") {
					return this.error(id, "promote_queued_message", "message must be a string");
				}
				return this.success(id, "promote_queued_message", {
					promoted: session.promoteQueuedMessage(command.message),
				});
			}

			case "abort": {
				this.#goalController.stopForHostAbort();
				await session.abort({ reason: USER_INTERRUPT_LABEL });
				return this.success(id, "abort");
			}

			case "abort_and_restore_queue": {
				// Mirrors the TUI Esc restore: withdraw queued user input (including input the run
				// dequeued but never recorded) before aborting, so neither the aborted turn nor
				// abort()'s stranded-queue drain can run it.
				const restored = session.clearQueue({ forInterrupt: true });
				this.#goalController.stopForHostAbort();
				await session.abort({ reason: USER_INTERRUPT_LABEL });
				return fitAbortAndRestoreQueueResponse(id, restored, this.#maxResponseBytes());
			}

			case "abort_and_prompt": {
				this.#goalController.stopForHostAbort();
				await session.abort({ reason: USER_INTERRUPT_LABEL });
				// After the abort so the aborted run's terminal agent_end cannot settle this prompt.
				const ticket = this.promptResults.begin(id);
				void this.#dispatchOrderedUserInput(command, ticket, false).then(
					outcome => {
						if (typeof outcome === "object") {
							this.#output(outcome.setupError);
							this.promptResults.fail(
								ticket,
								(outcome.setupError as Extract<RpcResponse, { success: false }>).error,
							);
						} else if (outcome === "cancelled") this.promptResults.settle(ticket);
						else if (outcome === "local") this.promptResults.completeLocal(ticket);
					},
					(cause: unknown) => {
						const promptError = cause instanceof Error ? cause : new Error(String(cause));
						this.#onPromptError(id, "abort_and_prompt")(promptError);
						this.promptResults.fail(ticket, promptError.message);
					},
				);
				return this.success(id, "abort_and_prompt");
			}

			case "new_session":
			case "switch_session":
			case "branch":
			case "fork": {
				// Fast refusal before the goal controller voids a waiting continuation;
				// fork() repeats the check after each of its own awaits.
				if (command.type === "fork" && session.isBusyForSnapshot) {
					return this.error(id, "fork", new SessionBusyError("fork the session").message, "session_busy");
				}
				const requestedModel =
					command.type === "switch_session" ? await resolveRequestedRpcModel(session, command) : undefined;
				// Validation first: a refused change must not cancel the running side question.
				await this.#btw.close();
				await this.#goalController.beginSessionChange();
				let result: Awaited<ReturnType<typeof handleRpcSessionChange>> | undefined;
				try {
					result = await handleRpcSessionChange(session, command, this.subagentRegistry, requestedModel);
				} catch (err) {
					// fork() refuses when work started while its transition awaited.
					if (err instanceof SessionBusyError) return this.error(id, command.type, err.message, "session_busy");
					throw err;
				} finally {
					// Branch and fork switch files in-process without detaching a run (fork requires idle).
					await this.#goalController.endSessionChange({
						detachedRun: command.type !== "branch" && command.type !== "fork" && result?.data.cancelled !== true,
					});
					// Respond only once this change's reattach (and any queued ahead of it) has run.
					await this.#goalController.settled();
				}
				if (!result.data.cancelled) {
					this.#inputGate.commitSessionChange(command);
					// `branch` leaves a live run streaming to its normal yield; new/switch detach it.
					if (command.type !== "branch" && command.type !== "fork") this.promptResults.abortOpen();
					// The detached run publishes no terminal agent_end to settle on.
					void this.#settleWatcher.check();
					await this.emitAvailableCommandsUpdate();
				}
				return this.success(id, result.type, result.data);
			}

			case "open_session": {
				const requestedModel = await resolveRequestedRpcModel(session, command);
				const fileBeforeOpen = session.sessionFile;
				await this.#btw.close();
				await this.#goalController.beginSessionChange();
				let result: Awaited<ReturnType<typeof openRpcSession>>;
				try {
					result = await openRpcSession(session, command.sessionDir, this.subagentRegistry, requestedModel);
				} finally {
					// Opening the session that is already open leaves a live run going (see below).
					await this.#goalController.endSessionChange({
						detachedRun: session.sessionFile !== fileBeforeOpen,
					});
					// Respond only once this change's reattach (and any queued ahead of it) has run.
					await this.#goalController.settled();
				}
				if (!result.cancelled) {
					this.#inputGate.commitSessionChange(command);
					// Opening the session that is already open switches nothing and leaves a live run
					// going. Any real open (switch or new) changes the file, even when an aliased path
					// reopens a transcript with the same id.
					if (session.sessionFile !== fileBeforeOpen) this.promptResults.abortOpen();
					void this.#settleWatcher.check();
					await this.emitAvailableCommandsUpdate();
				}
				return this.success(id, "open_session", result);
			}

			// =================================================================
			// State
			// =================================================================

			case "get_state": {
				// A goal exit triggered by the last turn restores tools asynchronously; report after it.
				await this.#goalController.settled();
				const state: RpcSessionState = {
					model: session.model,
					thinkingLevel: session.thinkingLevel,
					isStreaming: session.isStreaming,
					isCompacting: session.isCompacting,
					steeringMode: session.steeringMode,
					followUpMode: session.followUpMode,
					interruptMode: session.interruptMode,
					sessionFile: session.sessionFile,
					sessionId: session.sessionId,
					sessionName: session.sessionName,
					autoCompactionEnabled: session.autoCompactionEnabled,
					queuedMessageCount: session.queuedMessageCount,
					approvalMode: RpcForkPermissionController.currentApprovalMode(session),
					hasPendingAsyncWork: session.hasPendingAsyncWork(),
					// A scheduled goal continuation will start a turn: not settled.
					isSettled: isRpcSessionSettled(session, this.#goalTurnScheduled),
					queuedMessages: (() => {
						const queued = session.getQueuedMessages();
						return { steering: [...queued.steering], followUp: [...queued.followUp] };
					})(),
					todoPhases: session.getTodoPhases(),
					fastModeEnabled: session.isFastModeEnabled(),
					tokensPerSecond: calculateTokensPerSecond(session.messages, session.isStreaming),
					fastModeActive: session.isFastModeActive(),
					slowModeSupported: session.isSlowModeSupported(),
					slowModeEnabled: session.isSlowModeEnabled(),
					slowModeScope: session.getSlowModeScope(),
					usageLimit: session.getUsageLimitState(),
					messageCount: session.messages.length,
					systemPrompt: session.systemPrompt,
					dumpTools: session.agent.state.tools.map(tool => ({
						name: tool.name,
						description: tool.description,
						parameters: toolWireSchema(tool),
						examples: tool.examples,
					})),
					contextUsage: session.getContextUsage(),
					goal: session.getGoalModeState() ?? null,
				};
				return this.success(id, "get_state", state);
			}

			case "goal": {
				try {
					return this.success(id, "goal", await this.#goalController.handle(command));
				} catch (goalError) {
					return this.error(id, "goal", goalError instanceof Error ? goalError.message : String(goalError));
				}
			}

			case "set_fast_mode": {
				const supported = session.setFastMode(command.enabled);
				if (command.enabled && !supported) {
					return this.error(id, "set_fast_mode", "Fast mode is unavailable for the current model.");
				}
				return this.success(id, "set_fast_mode", {
					enabled: session.isFastModeEnabled(),
					active: session.isFastModeActive(),
				});
			}

			case "set_slow_mode": {
				// A truthy non-boolean must not flip a persisted global setting.
				if (typeof command.enabled !== "boolean") {
					return this.error(id, "set_slow_mode", "set_slow_mode requires boolean enabled");
				}
				const supported = session.setSlowMode(command.enabled);
				if (command.enabled && !supported) {
					return this.error(id, "set_slow_mode", "Slow mode is unavailable for the current model.");
				}
				return this.success(id, "set_slow_mode", { enabled: session.isSlowModeEnabled() });
			}

			case "set_ask_dialog": {
				this.#uiContext.askDialogEnabled = command.enabled === true;
				return this.success(id, "set_ask_dialog", { enabled: this.#uiContext.askDialogEnabled });
			}

			case "get_available_commands": {
				return this.success(id, "get_available_commands", { commands: await this.getAvailableCommands() });
			}

			case "get_entries": {
				try {
					return this.success(
						id,
						"get_entries",
						selectRpcEntries(
							session.sessionManager.getEntries(),
							session.sessionManager.getLeafId(),
							command.since,
						),
					);
				} catch (err) {
					return this.error(id, "get_entries", errorMessage(err), "unknown_since");
				}
			}

			case "get_tree": {
				return this.success(id, "get_tree", {
					tree: session.sessionManager.getTree(),
					leafId: session.sessionManager.getLeafId(),
				});
			}

			case "set_todos": {
				session.setTodoPhases(command.phases);
				return this.success(id, "set_todos", { todoPhases: session.getTodoPhases() });
			}

			case "set_host_tools": {
				const tools = normalizeHostToolDefinitions(command.tools);
				const rpcTools = this.hostToolBridge.setTools(tools);
				await session.refreshRpcHostTools(rpcTools);
				return this.success(id, "set_host_tools", { toolNames: tools.map(tool => tool.name) });
			}

			case "live_start": {
				try {
					return this.success(
						id,
						"live_start",
						await this.#live.start({ voice: command.voice, instructions: command.instructions }),
					);
				} catch (err) {
					return this.error(id, "live_start", err instanceof Error ? err.message : String(err));
				}
			}

			case "live_stop": {
				await this.#live.stop();
				return this.success(id, "live_stop");
			}

			case "live_mute": {
				try {
					return this.success(id, "live_mute", this.#live.setMuted(command.muted));
				} catch (err) {
					return this.error(id, "live_mute", err instanceof Error ? err.message : String(err));
				}
			}

			case "set_host_uri_schemes": {
				try {
					const schemes = this.hostUriBridge.setSchemes(command.schemes);
					return this.success(id, "set_host_uri_schemes", { schemes });
				} catch (err) {
					return this.error(id, "set_host_uri_schemes", errorMessage(err));
				}
			}

			case "set_subagent_subscription": {
				if (!this.subagentRegistry) {
					return this.error(id, "set_subagent_subscription", "Subagent event bus is unavailable");
				}
				if (!isSubagentSubscriptionLevel(command.level)) {
					return this.error(
						id,
						"set_subagent_subscription",
						`Invalid subagent subscription level: ${String(command.level)}`,
					);
				}
				this.subagentRegistry.setSubscriptionLevel(command.level);
				return this.success(id, "set_subagent_subscription", {
					level: this.subagentRegistry.getSubscriptionLevel(),
				});
			}

			case "set_event_filter": {
				const events = command.events;
				if (
					events !== null &&
					(!Array.isArray(events) || !events.every(event => typeof event === "string" && event.length > 0))
				) {
					return this.error(
						id,
						"set_event_filter",
						"events must be null or an array of non-empty event type strings",
					);
				}
				const messageUpdates = command.messageUpdates === undefined ? "full" : command.messageUpdates;
				if (messageUpdates !== "full" && messageUpdates !== "delta") {
					return this.error(id, "set_event_filter", 'messageUpdates must be "full" or "delta"');
				}
				return this.success(id, "set_event_filter", {
					events: this.#sessionEvents.setFilter(events, messageUpdates),
					messageUpdates,
				});
			}

			case "get_subagents": {
				if (!this.subagentRegistry) {
					return this.error(id, "get_subagents", "Subagent event bus is unavailable");
				}
				return this.success(id, "get_subagents", { subagents: this.subagentRegistry.getSubagents() });
			}

			case "get_subagent_messages": {
				if (!this.subagentRegistry) {
					return this.error(id, "get_subagent_messages", "Subagent event bus is unavailable");
				}
				try {
					if (command.fromByte !== undefined && !Number.isFinite(command.fromByte)) {
						return this.error(id, "get_subagent_messages", "fromByte must be a finite number");
					}
					const sessionFile = this.subagentRegistry.resolveSessionFile(command);
					const transcript = await readRpcSubagentTranscript(sessionFile, command.fromByte);
					return this.success(id, "get_subagent_messages", transcript);
				} catch (err) {
					return this.error(id, "get_subagent_messages", errorMessage(err));
				}
			}

			case "cancel_subagent": {
				if (!this.subagentRegistry) {
					return this.error(id, "cancel_subagent", "Subagent event bus is unavailable");
				}
				if (typeof command.subagentId !== "string" || command.subagentId.length === 0) {
					return this.error(id, "cancel_subagent", "`subagentId` must be a non-empty string.");
				}
				try {
					const cancelled = await handleRpcCancelSubagent(this.subagentRegistry, command.subagentId);
					return this.success(id, "cancel_subagent", { cancelled });
				} catch (err) {
					return this.error(id, "cancel_subagent", err instanceof Error ? err.message : String(err));
				}
			}

			case "steer_subagent": {
				if (!this.subagentRegistry) {
					return this.error(id, "steer_subagent", "Subagent event bus is unavailable");
				}
				if (typeof command.subagentId !== "string" || command.subagentId.length === 0) {
					return this.error(id, "steer_subagent", "`subagentId` must be a non-empty string.");
				}
				if (typeof command.message !== "string" || !command.message.trim()) {
					return this.error(id, "steer_subagent", "`message` is required for steer_subagent.");
				}
				const failure = await handleRpcSteerSubagent(this.subagentRegistry, command.subagentId, command.message);
				return failure ? this.error(id, "steer_subagent", failure) : this.success(id, "steer_subagent");
			}

			// =================================================================
			// Model
			// =================================================================

			case "set_model": {
				const model = await findRpcModel(session, command.provider, command.modelId);
				if (!model) {
					return this.error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
				}
				await session.setModel(model);
				return this.success(id, "set_model", model);
			}

			case "cycle_model": {
				const result = await session.cycleModel();
				if (!result) {
					return this.success(id, "cycle_model", null);
				}
				return this.success(id, "cycle_model", result);
			}

			case "get_available_models": {
				await session.modelRegistry.awaitBackgroundRefresh();
				const models = session.getAvailableModels();
				return this.success(id, "get_available_models", { models });
			}

			// =================================================================
			// Thinking
			// =================================================================

			case "set_thinking_level": {
				session.setThinkingLevel(command.level);
				return this.success(id, "set_thinking_level");
			}

			case "cycle_thinking_level": {
				const level = session.cycleThinkingLevel();
				if (!level) {
					return this.success(id, "cycle_thinking_level", null);
				}
				return this.success(id, "cycle_thinking_level", { level });
			}

			case "get_available_thinking_levels": {
				// Pi-compatible discovery: the selectable levels for the live model,
				// including `off` (which `set_thinking_level` accepts but the
				// effort-only helper excludes). OMP-only `auto`/`inherit` are
				// intentionally omitted — that selector stays an OMP dialect.
				return this.success(id, "get_available_thinking_levels", {
					levels: [ThinkingLevel.Off, ...session.getAvailableThinkingLevels()],
				});
			}

			// =================================================================
			// Queue Modes
			// =================================================================

			case "set_steering_mode": {
				applyRpcQueueModeCommand(session, command);
				return this.success(id, "set_steering_mode");
			}

			case "set_follow_up_mode": {
				applyRpcQueueModeCommand(session, command);
				return this.success(id, "set_follow_up_mode");
			}

			case "set_interrupt_mode": {
				applyRpcQueueModeCommand(session, command);
				return this.success(id, "set_interrupt_mode");
			}

			// =================================================================
			// Compaction
			// =================================================================

			case "compact": {
				const result = await session.compact(command.customInstructions);
				return this.success(id, "compact", result);
			}

			case "set_auto_compaction": {
				session.setAutoCompactionEnabled(command.enabled);
				return this.success(id, "set_auto_compaction");
			}

			// =================================================================
			// Cache warming
			// =================================================================

			case "set_cache_warming": {
				if (!CACHE_WARMING_MODES.includes(command.mode)) {
					return this.error(id, "set_cache_warming", `Invalid cache warming mode: ${String(command.mode)}`);
				}
				const mode = session.setCacheWarmingMode(command.mode);
				return this.success(id, "set_cache_warming", { mode });
			}

			// =================================================================
			// Retry
			// =================================================================

			case "set_auto_retry": {
				session.setAutoRetryEnabled(command.enabled);
				return this.success(id, "set_auto_retry");
			}

			case "abort_retry": {
				session.abortRetry();
				return this.success(id, "abort_retry");
			}

			// =================================================================
			// Bash
			// =================================================================

			case "bash": {
				const result = await session.executeBash(command.command);
				return this.success(id, "bash", result);
			}

			case "abort_bash": {
				session.abortBash();
				return this.success(id, "abort_bash");
			}

			// =================================================================
			// Session
			// =================================================================

			case "get_session_stats": {
				const stats = session.getSessionStats();
				return this.success(id, "get_session_stats", stats);
			}

			case "export_html": {
				const path = await session.exportToHtml(command.outputPath);
				return this.success(id, "export_html", { path });
			}

			case "get_branch_messages": {
				const messages = session.getUserMessagesForBranching();
				return this.success(id, "get_branch_messages", { messages });
			}

			case "get_last_assistant_text": {
				const text = session.getLastAssistantText();
				return this.success(id, "get_last_assistant_text", { text });
			}

			case "set_session_name": {
				const name = command.name.trim();
				if (!name) {
					return this.error(id, "set_session_name", "Session name cannot be empty");
				}
				const applied = await session.setSessionName(name, "user");
				if (!applied) {
					return this.error(id, "set_session_name", "Session name cannot be empty");
				}
				return this.success(id, "set_session_name");
			}

			case "handoff": {
				// Resetting the agent mid-stream lets the live turn keep emitting into a
				// session that handoff has already torn down. Refuse while a prompt is in
				// flight (mirrors the TUI /handoff guard).
				if (session.isStreaming) {
					return this.error(id, "handoff", "Cannot hand off while a response is in progress");
				}
				const result = await session.handoff(command.customInstructions);
				return this.success(id, "handoff", result ? { savedPath: result.savedPath } : null);
			}

			// =================================================================
			// Messages
			// =================================================================

			case "get_messages": {
				return this.success(id, "get_messages", { messages: session.messages });
			}

			case "get_messages_page": {
				// 5.4: historical pages are readable during streaming/compaction —
				// the read-only snapshot keeps `stale_cursor` as the consistency
				// guard, so the old `session_busy` rejection is gone.
				const messages = session.messages;
				try {
					return this.success(
						id,
						"get_messages_page",
						pageRpcMessages(
							messages,
							{
								sessionId: session.sessionId,
								leafId: session.sessionManager.getLeafId(),
								messageCount: messages.length,
								revision: createHash("sha256").update(JSON.stringify(messages)).digest("hex"),
							},
							{
								cursor: command.cursor,
								limit: command.limit,
								order: command.order,
								before: command.before,
								after: command.after,
							},
						),
					);
				} catch (pageError) {
					return this.error(
						id,
						"get_messages_page",
						errorMessage(pageError),
						pageError instanceof RpcMessagesPageError ? pageError.code : undefined,
					);
				}
			}

			// =================================================================
			// Login
			// =================================================================

			case "get_login_providers": {
				const providers = getOAuthProviders().map(provider => ({
					id: provider.id,
					name: provider.name,
					available: provider.available,
					authenticated: session.modelRegistry.authStorage.keys.source(provider.id) !== undefined,
				}));
				return this.success(id, "get_login_providers", { providers });
			}

			case "login": {
				const knownProvider = getOAuthProviders().find(p => p.id === command.providerId);
				if (!knownProvider) {
					return this.error(id, "login", `Unknown OAuth provider: ${command.providerId}`);
				}
				const uiCtx = new RpcExtensionUIContext(
					this.pendingExtensionRequests,
					this.#output,
					this.#forkAskBroker,
					this.#emitRpcTitles,
				);
				// Track whether onAuth has fired. Providers that require interactive
				// input before a browser URL cannot be satisfied headlessly; after
				// onAuth, prompt input is the pasted OAuth code/redirect URL path.
				let authEmitted = false;
				try {
					await session.modelRegistry.authStorage.oauth.login(command.providerId, {
						onAuth: info => {
							authEmitted = true;
							this.#output({
								type: "extension_ui_request",
								id: Snowflake.next() as string,
								method: "open_url",
								url: info.url,
								launchUrl: info.launchUrl,
								instructions: info.instructions,
							} as RpcExtensionUIRequest);
						},
						onProgress: message => {
							uiCtx.notify(message, "info");
						},
						onPrompt: async prompt => {
							if (prompt.secret) {
								// v3 unlocks masked secret input over the protocol (4.3);
								// v1/v2 keeps the stock rejection.
								if (!this.forkHost.isActive) {
									throw new Error(
										`Provider '${command.providerId}' requires secret input, ` +
											"which is not supported in RPC mode. Use the terminal UI to log in.",
									);
								}
								return (
									(await uiCtx.inputSensitive(prompt.message, prompt.placeholder, { timeout: 600_000 })) ?? ""
								);
							}
							if (!authEmitted) {
								// onPrompt called before any auth URL — provider requires
								// interactive input that cannot be satisfied headlessly.
								return Promise.reject(
									new Error(
										`Provider '${command.providerId}' requires interactive prompts ` +
											"which are not supported in RPC mode. Use the terminal UI to log in.",
									),
								);
							}
							return (await uiCtx.input(prompt.message, prompt.placeholder, { timeout: 600_000 })) ?? "";
						},
					});
					// Provider-scoped online refresh so the just-persisted credential
					// re-runs discovery instead of reusing a fresh authoritative cache
					// row (#5780).
					await session.modelRegistry.refreshProvider(command.providerId, "online");
					return this.success(id, "login", { providerId: command.providerId });
				} catch (err: unknown) {
					return this.error(id, "login", errorMessage(err));
				}
			}

			// =================================================================
			// Side questions (/btw)
			// =================================================================

			case "btw": {
				const record = await this.#btw.ask(command.question, command.recordId);
				return this.success(id, "btw", { record });
			}

			case "btw_cancel":
				return this.success(id, "btw_cancel", { cancelled: this.#btw.cancel(command.recordId) });

			case "get_btw_history":
				return this.success(id, "get_btw_history", { records: await this.#btw.history() });

			// =================================================================
			// Word prediction
			// =================================================================

			case "predict_word": {
				if (!isTextCursor(command.text, command.cursor)) {
					return this.error(id, "predict_word", INVALID_TEXT_CURSOR_ERROR);
				}
				try {
					const method = cfgSpellingAutocomplete.get(session.settings);
					const suffix = await this.#wordPredictor.predict(method, command.text, command.cursor);
					return this.success(id, "predict_word", { suffix });
				} catch (err: unknown) {
					return this.error(id, "predict_word", err instanceof Error ? err.message : String(err));
				}
			}

			case "predict_word_feedback": {
				if (!isTextCursor(command.text, command.cursor)) {
					return this.error(id, "predict_word_feedback", INVALID_TEXT_CURSOR_ERROR);
				}
				if (typeof command.suggestion !== "string" || typeof command.accepted !== "boolean") {
					return this.error(id, "predict_word_feedback", "suggestion must be a string and accepted a boolean");
				}
				const method = cfgSpellingAutocomplete.get(session.settings);
				if (method !== "off") {
					const query = wordQueryAt(command.text, command.cursor);
					if (query) {
						textPredictionBackend(method).feedback(
							query.before,
							query.prefix,
							command.suggestion,
							command.accepted,
						);
					}
				}
				return this.success(id, "predict_word_feedback");
			}

			default: {
				// Single fork-extension dispatch hook: active only after v3
				// negotiation; an unhandled type keeps the stock error below.
				const forkResponse = await this.forkHost.handleCommand(command);
				if (forkResponse) return forkResponse;
				const unknownCommand = command as { type: string };
				return this.error(id, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
			}
		}
	}

	async getAvailableCommands(): Promise<InternalAvailableSlashCommand[]> {
		return buildAvailableSlashCommands(this.session);
	}

	async emitAvailableCommandsUpdate(): Promise<void> {
		this.#output({ type: "available_commands_update", commands: await this.getAvailableCommands() });
	}

	/**
	 * True while the session is awaiting an extension dialog, fork question,
	 * or tool permission decision from the client.
	 */
	isWaitingInteraction(): boolean {
		return this.pendingExtensionRequests.size > 0 || this.forkHost.hasPendingRequests;
	}

	getRunState(): RpcSessionHostRunState {
		if (this.#disposed) return "closing";
		if (this.isWaitingInteraction()) return "waiting_interaction";
		if (
			this.session.isStreaming ||
			this.session.isBusyForSnapshot ||
			this.session.hasAdmittedSubmission ||
			this.session.isSessionTransitioning ||
			this.#goalTurnScheduled()
		) {
			return "streaming";
		}
		return "idle";
	}

	/**
	 * True when shutdown was requested for this host (extension
	 * `pi.shutdown()`) or, in project mode, for the process (the
	 * `isShutdownRequested` option).
	 */
	isShutdownRequested(): boolean {
		return this.#disposed || this.#shutdownState.requested || (this.#options.isShutdownRequested?.() ?? false);
	}

	/**
	 * Re-check deferred shutdown after a background task settles. With
	 * process-level shutdown wiring (`trackBackgroundTask` option) the process
	 * owner owns draining and the shutdown sequence; without it the host's
	 * internal coordinator (legacy fallback) drains its own tracked tasks and
	 * disposes the host.
	 */
	checkShutdownRequested(): Promise<void> {
		if (this.#options.trackBackgroundTask) return Promise.resolve();
		return this.#ensureCoordinator().checkShutdownRequested();
	}

	/**
	 * Fail every pending request closed and detach the session-bound
	 * listeners — what the legacy stdin-EOF path did, minus the process exit
	 * and the AgentSession disposal (the caller owns both). Idempotent.
	 * Shared bridges (project mode) outlive this host and are left open. The
	 * persistence surface stays registered so a store-close failure during the
	 * caller's `session.dispose()` still reaches the client as a `notice`.
	 */
	async dispose(reason: string): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#inputGate.accept({ type: "abort" });
		this.forkHost.dispose(`${reason} before fork request completed`);
		this.pendingExtensionRequests.rejectAll(`${reason} before extension UI response completed`);
		if (!this.#options.sharedBridges) {
			this.hostToolBridge.close(`${reason} before host tool execution completed`);
			this.hostUriBridge.clear(`${reason} before host URI request completed`);
		}
		this.#goalController.stopForHostAbort();
		// Per-surface fail-closed messages, derived from the single reason so the
		// wire-visible error text matches the legacy single-session mode exactly.
		// Close the realtime call (microphone, socket) before anything else may
		// settle; `stopLive` below re-checks it idempotently for the exit paths
		// that never run through this dispose.
		try {
			// The process ends regardless; report an unsaved side answer instead of skipping dispose.
			await this.closeBtw();
			await this.#live.stop();
		} finally {
			this.subagentRegistry?.dispose();
			for (const unsubscribe of this.#unsubscribers) {
				try {
					unsubscribe();
				} catch {
					// Best-effort listener teardown.
				}
			}
			this.#unsubscribers = [];
			try {
				this.session.extensionRunner?.setHookExecutedListener(undefined);
			} catch {
				// Best-effort hook listener teardown.
			}
		}
	}

	/**
	 * Route a side-channel (overtaking) frame into this session: extension UI
	 * responses resolve against the pending map, everything else goes to the
	 * fork host's control-frame handlers. Returns true when consumed. The
	 * project host calls this for frames whose interaction id maps to this
	 * session; host tool/URI results never arrive here (shared bridges).
	 */
	handleControlFrame(parsed: unknown): boolean {
		if (isRecord(parsed) && parsed.type === "extension_ui_response" && typeof parsed.id === "string") {
			const pending = this.pendingExtensionRequests.get(parsed.id);
			if (pending) pending.resolve(parsed as RpcExtensionUIResponse);
			return true;
		}
		return this.forkHost.handleControlFrame(parsed);
	}

	/**
	 * Stops the live voice session (microphone, socket) — the realtime call
	 * delegates into the AgentSession, so it must close before the session
	 * disposes. Idempotent: every exit path may call it after `dispose`.
	 */
	stopLive(): Promise<void> {
		return this.#live.stop();
	}

	/**
	 * Flushes the running side question's checkpoint; a failure is reported as a
	 * `notice` frame instead of skipping it. Idempotent: every process-exit path
	 * (`dispose`, the shutdown coordinator's `disposeAndExit`) must close the
	 * side question before the session it checkpoints into disposes.
	 */
	closeBtw(): Promise<void> {
		return this.#btw.close().catch(btwError => {
			const message = toError(btwError).message;
			logger.error(message);
			this.#output({ type: "notice", level: "error", message, source: "btw-history" });
		});
	}

	#onPromptError(id: string | undefined, command: string): (promptError: Error) => void {
		return promptError =>
			this.#output(
				this.error(
					id,
					command,
					promptError.message,
					isRecord(promptError) && typeof promptError.code === "string" ? promptError.code : undefined,
				),
			);
	}

	/**
	 * Resolves v3 `attachments` into message images + a text prelude (5.5);
	 * structured attachment failures carry their wire `code`.
	 */
	async #resolveCommandAttachments(
		id: string | undefined,
		commandType: string,
		attachments: RpcForkAttachment[] | undefined,
		message: string,
	): Promise<{ message: string; images: ImageContent[] } | { error: RpcResponse }> {
		if (!attachments || attachments.length === 0) return { message, images: [] };
		try {
			const resolved = await resolveRpcAttachments(attachments, this.session.sessionManager.getCwd());
			return { message: `${resolved.textPrefix}${message}`, images: resolved.images };
		} catch (attachmentError) {
			if (attachmentError instanceof RpcAttachmentError) {
				return { error: this.error(id, commandType, attachmentError.message, attachmentError.code) };
			}
			throw attachmentError;
		}
	}

	/**
	 * Ordered user-input arm (upstream PR #13027, adapted to the fork's
	 * attachments and strict-dispatch extensions): `prompt`, `steer`,
	 * `follow_up`, and `abort_and_prompt` run serially through the host's
	 * {@link RpcUserInputGate}, and every step re-checks `isCurrent` so an
	 * abort or session change that arrived while this input was queued cancels
	 * it before any agent work starts. Everything async that precedes dispatch
	 * — the `/plan` toggle interception and attachment resolution — runs inside
	 * the gate so a later-arriving plain prompt can never enter the gate first
	 *. Extension input handlers run inside the gate, in
	 * arrival order.
	 */
	#dispatchOrderedUserInput(
		command: Extract<RpcCommand, { type: "prompt" | "steer" | "follow_up" | "abort_and_prompt" }>,
		ticket: RpcPromptTicket | undefined,
		strictCommandDispatch: boolean,
	): Promise<
		| "local"
		| "cancelled"
		| "admitted"
		| "skill-invoked"
		| "builtin-agent"
		| "unknown-command"
		| { setupError: RpcResponse }
	> {
		return this.#inputGate.enqueue(async () => {
			const session = this.session;
			const sessionId = session.sessionId;
			const isCurrent = () =>
				this.#inputGate.isCurrent(command) && !this.isShutdownRequested() && session.sessionId === sessionId;
			if (!isCurrent()) return "cancelled";
			const attachments = await this.#resolveCommandAttachments(command.id, command.type, command.attachments, "");
			if ("error" in attachments) return { setupError: attachments.error };
			if (!isCurrent()) return "cancelled";
			// The attachment text prefix joins the model input only after the
			// extension input handlers below, so slash/skill matching in the
			// prompt arm sees the bare (possibly rewritten) user text.
			const attachmentPrefix = attachments.message;
			let text = command.message;
			let images: ImageContent[] | undefined = command.images
				? [...command.images, ...attachments.images]
				: attachments.images.length > 0
					? attachments.images
					: undefined;
			const runner = session.extensionRunner;
			if (runner?.hasHandlers("input")) {
				const result = await runner.emitInput(text, images, "rpc");
				if (!isCurrent()) return "cancelled";
				if (result.handled) return "local";
				if (result.text !== undefined) text = result.text;
				if (result.images !== undefined) images = result.images;
			}
			if (!isCurrent()) return "cancelled";
			if (!text.trim() && !images?.length && !attachmentPrefix.trim()) return "local";
			const withAttachments = attachmentPrefix ? attachmentPrefix + text : text;
			if (command.type === "steer") {
				await session.steer(withAttachments, images);
				return "admitted";
			}
			if (command.type === "follow_up") {
				await session.followUp(withAttachments, images);
				return "admitted";
			}
			// Set when a builtin consumed the text and returned a residual
			// prompt: that arm keeps its own prompt options (raw command
			// images, no template expansion) via promptRpcBuiltinResidual.
			let builtinResidual: string | undefined;
			if (command.type === "prompt") {
				if (!ticket) return "cancelled";
				if (strictCommandDispatch) {
					const skillResult = await dispatchRpcSkillPrompt({
						ticket,
						session,
						message: text,
						attachmentsText: attachmentPrefix,
						streamingBehavior: command.streamingBehavior,
						results: this.promptResults,
						onError: this.#onPromptError(command.id, "prompt"),
						extensionUserMessageTracker: this.#extensionUserMessageTracker,
						images,
						isCurrent,
					});
					if (skillResult === "cancelled") return "cancelled";
					// Keep the legacy `{ agentInvoked: true }` response data for skill
					// commands (fork clients read it); plain prompts answer bare.
					if (skillResult) return "skill-invoked";
					const builtinResult = await executeAcpBuiltinSlashCommand(text, {
						session,
						sessionManager: session.sessionManager,
						settings: session.settings,
						cwd: session.sessionManager.getCwd(),
						ui: this.#uiContext,
						setModel: model => session.setModelTemporary(model),
						output: commandOutput => this.#output({ type: "command_output", text: commandOutput }),
						refreshCommands: () => this.emitAvailableCommandsUpdate(),
						reloadPlugins: () => this.#reloadPluginState(),
						runCommandInBackground: task => this.#trackBackgroundTask(task()),
						notifyTitleChanged: async () => {
							this.#output({
								type: "session_info_update",
								title: session.sessionName,
								sessionId: session.sessionId,
							});
						},
						notifyConfigChanged: async () => {
							this.#output({
								type: "config_update",
								model: session.model,
								thinkingLevel: session.thinkingLevel,
								approvalMode: RpcForkPermissionController.currentApprovalMode(session),
							});
						},
					});
					if (!isCurrent()) return "cancelled";
					if (builtinResult !== false) {
						if (!("prompt" in builtinResult)) {
							if (builtinResult.agentInvoked === true && ticket) {
								void session.waitForIdle().then(
									() => this.promptResults.settle(ticket),
									(idleError: unknown) => this.promptResults.fail(ticket, errorMessage(idleError)),
								);
								return "builtin-agent";
							}
							return "local";
						}
						text = builtinResult.prompt;
						builtinResidual = builtinResult.prompt;
					}
					// Strict dispatch (project mode): an unmatched "/..." is a
					// command the host does not know — reject it instead of
					// silently turning it into model input.
					if (
						this.#options.projectMode &&
						text.startsWith("/") &&
						!(await buildAvailableSlashCommands(session)).some(
							entry =>
								entry.name === text.slice(1).split(/\s/, 1)[0] ||
								entry.aliases?.includes(text.slice(1).split(/\s/, 1)[0]!),
						)
					) {
						return "unknown-command";
					}
				}
			}
			if (!isCurrent() || !ticket) return "cancelled";
			await watchAndReportPromptResult({
				ticket,
				startPrompt: onPromptAdmitted =>
					builtinResidual !== undefined
						? promptRpcBuiltinResidual(session, builtinResidual, command, onPromptAdmitted, images)
						: session.prompt(withAttachments, {
								images,
								...(command.type === "prompt"
									? {
											streamingBehavior: command.streamingBehavior,
											expandPromptTemplates: strictCommandDispatch,
										}
									: {}),
								onPromptAdmitted,
							}),
				results: this.promptResults,
				onError: this.#onPromptError(command.id, command.type),
				extensionUserMessageTracker: this.#extensionUserMessageTracker,
			});
			return "admitted";
		});
	}

	async #reloadPluginState(): Promise<void> {
		const cwd = this.session.sessionManager.getCwd();
		const projectPath = await resolveActiveProjectRegistryPath(cwd);
		clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
		await this.session.refreshSkillsAndCommands();
		await this.emitAvailableCommandsUpdate();
	}

	#trackBackgroundTask(task: Promise<void>): void {
		const track = this.#options.trackBackgroundTask;
		if (track) {
			track(task);
			return;
		}
		this.#ensureCoordinator().track(task);
	}

	/**
	 * Internal shutdown coordinator for hosts without process-level shutdown
	 * wiring: drains this host's own background tasks, then fails the host
	 * closed (the caller still owns the process exit).
	 */
	#ensureCoordinator(): RpcShutdownCoordinator {
		return (this.#internalCoordinator ??= new RpcShutdownCoordinator({
			isShutdownRequested: () => this.isShutdownRequested(),
			performShutdown: async () => {
				await this.dispose("shutdown requested");
			},
		}));
	}
}
