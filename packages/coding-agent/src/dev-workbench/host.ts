import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { getProjectDir, normalizePathForComparison } from "@oh-my-pi/pi-utils/dirs";
import * as os from "node:os";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { GuestFrame, HostFrame } from "@oh-my-pi/pi-wire";
import type { CollabController } from "../collab/controller";
import { subscribeCollabEntries, type CollabHostPort } from "../collab/host";
import { Settings } from "../config/settings";
import { getSessionSlashCommands } from "../extensibility/extensions/get-commands-handler";
import { parseSkillInvocation } from "../extensibility/skills";
import { RpcGoalController } from "../modes/rpc/rpc-goal";
import { ComposerPredictionController } from "../modes/controllers/composer-prediction-controller";
import { cfgComposerPredictionAlternatives, cfgComposerPredictions } from "../modes/settings";
import type { AgentSessionEvent } from "../session/agent-session-events";
import {
	createAgentSession,
	discoverAuthStorage,
	type CreateAgentSessionResult,
	type CreateAgentSessionOptions,
} from "../sdk";
import type { AgentSession } from "../session/agent-session";
import { SKILL_PROMPT_MESSAGE_TYPE } from "../session/messages";
import { SpecDrivenController } from "../spec-driven/controller";
import type {
	DevActionPreview,
	DevActionResult,
	DevNativeCommand,
	DevNativeUiResponse,
	DevPerson,
	DevSessionTarget,
	DevGuestSessionTarget,
	DevInputTarget,
	DevSubmitResult,
} from "../spec-driven/types";
import { DevWorkspace } from "../spec-driven/workspace";
import { cfgGoalEnabled } from "../goals/settings";
import { startTeamDiscussion } from "../team/controller";
import { createDevCollabController, createDevLocalSessionBridge, DevCollabBridge } from "./collab";
import { DevNativeUiController } from "./native-ui";
import { startDevWorkbenchServer } from "./server";
import { $env } from "@oh-my-pi/pi-utils/env";
import { ensureTheme } from "@oh-my-pi/pi-tui/theme";
import { CLI_THINKING_LEVELS, parseConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import type { Args } from "../cli/args";
import { applyStartupCwd } from "../cli/startup-cwd";
import {
	COMPANY_OFFLINE_CONTEXT_WINDOW,
	COMPANY_OFFLINE_ROLE_DEFAULTS,
	setCompanyChatContextWindow,
} from "../config/company-models";
import { COMPANY_PROVIDER_ID, getCompanyConfig, setCompanyOfflineEnabled } from "../config/company-provider";
import { ModelRegistry } from "../config/model-registry";
import { disabledProviderIds } from "../config/model-resolver";
import { initializeWithSettings } from "../discovery";
import { injectPluginDirRoots, preloadPluginRoots } from "../discovery/helpers";
import { injectOmpExtensionCliRoots } from "../discovery/omp-extension-roots";
import { buildSessionOptions, resolveScopedModels, watchScopedModelSettings } from "../main";
import { AgentLifecycleManager } from "../registry/agent-lifecycle";
import { createAuthStorageSettingsSync } from "../session/auth-broker-config";
import { SessionManager } from "../session/session-manager";
import { cfgSessionMaxCost, cfgSessionWarnCost } from "../session/settings";
import { createPersistedSubagentReviverFactory } from "../task/persisted-revive";
import { cfgTaskAgentIdleTtlMs } from "../task/settings";
import { cfgAstEditEnabled, cfgFetchEnabled, cfgToolsApprovalMode, cfgWebSearchEnabled } from "../tools/settings";
import { cfgBrowserEnabled } from "../tools/browser/settings";
import { EventBus } from "../utils/event-bus";
import { openPathWithResult } from "../utils/open";
import { type MCPAuthHandler, MCPManager } from "../mcp/manager";
import type { MCPAuthChallenge, MCPAuthInvocation, MCPServerConfig } from "../mcp/types";
import {
	findMcpServerForAuth,
	matchingManagerServerConfig,
	MCPOAuthCancelledError,
	reauthorizeMcpServer,
} from "../mcp/oauth-reauth";
import { cfgMcpEnableProjectConfig } from "../mcp/settings";
import { AgentRegistry } from "../registry/agent-registry";
import { isLocalAgentSession } from "../session/agent-session-handle";
import { specDescendantAgentIds } from "../spec-driven/actors";
import { lookupBuiltinSlashCommand } from "../slash-commands/builtin-registry";
import { parseSlashCommand } from "../slash-commands/helpers/parse";
import { parseCommandArgs } from "../utils/command-args";

// Only session-scoped handlers belong here: no global setup, session switching or TUI lifecycle.
const DEV_SESSION_BUILTINS = new Set([
	"effort",
	"tools",
	"context",
	"jobs",
	"changelog",
	"compact",
	"shake",
	"fresh",
	"clear",
	"force",
]);

export interface DevWorkbenchHandle {
	url: string;
	urls: readonly string[];
	loopbackUrl: string;
	close(): Promise<void>;
}
interface InputReceipt {
	browserId: string;
	target: DevInputTarget;
	createdAt: number;
	started: boolean;
	result: DevSubmitResult;
}
interface SessionPrediction {
	controller: ComposerPredictionController;
	target: DevSessionTarget | undefined;
	epoch: number;
	requestedEpoch?: number;
}
export interface DevComposerPredictionFrame {
	t: "composer-prediction";
	target: DevInputTarget;
	choices: readonly string[];
}
type EntryListener = NonNullable<AgentSession["sessionManager"]["onEntryAppended"]>;
type FrameListener = (frame: HostFrame | DevComposerPredictionFrame | object) => void;
const hosts = new Map<string, Promise<DevWorkbenchHost>>();
const services = new WeakMap<DevWorkbenchHost, Promise<DevWorkbenchHandle>>();
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Browser human interaction uses the existing interactive Goal policy, never a settings override. */
export function createDevGoalController(session: AgentSession): RpcGoalController {
	return new RpcGoalController(session, undefined, "interactive");
}

export class DevWorkbenchHost {
	readonly cwd: string;
	readonly settings: Settings;
	readonly #cacheKey: string | undefined;
	readonly #ownsRoot: boolean;
	readonly rootSession: AgentSession;
	readonly controller: SpecDrivenController;
	readonly collab: CollabController;
	readonly nativeUi = new DevNativeUiController();
	readonly guests: DevCollabBridge;
	readonly #frames = new Map<string, Set<FrameListener>>();
	readonly #native = new Map<
		string,
		{ target: DevSessionTarget; sendFrame(frame: GuestFrame): Promise<DevSubmitResult>; close(): Promise<void> }
	>();
	readonly #interactionOwners = new Map<string, DevSessionTarget>();
	readonly #rooms = new Map<AgentSession, CollabController>();
	readonly #goals = new Map<AgentSession, RpcGoalController>();
	readonly #predictions = new Map<AgentSession, SessionPrediction>();
	readonly #inputs = new Map<string, InputReceipt>();
	readonly #prepared = new Map<string, string>();
	readonly #work = new Set<Promise<unknown>>();
	readonly #disposers: Array<() => void> = [];
	#closing: Promise<void> | undefined;
	#stopping = false;
	#service: DevWorkbenchHandle | undefined;
	readonly #authShutdown = new AbortController();
	readonly #mcpManager: MCPManager | undefined;
	readonly #restoreMcpAuth: (() => void) | undefined;

	constructor(input: {
		session: AgentSession;
		settings: Settings;
		cwd: string;
		cacheKey?: string;
		ownsRoot?: boolean;
		mcpManager?: MCPManager;
		restoreMcpAuth?: () => void;
	}) {
		this.cwd = input.cwd;
		this.#cacheKey = input.cacheKey;
		this.#ownsRoot = input.ownsRoot === true;
		this.settings = input.settings.overlay();
		this.rootSession = input.session;
		this.#mcpManager = input.mcpManager;
		this.#restoreMcpAuth = input.restoreMcpAuth;
		const uiForSession = (session: AgentSession) => this.nativeUi.createContext(() => this.targetForSession(session));
		const createInteractionUI: NonNullable<CreateAgentSessionOptions["createInteractionUI"]> = origin => {
			const parent = this.controller
				.nativeSessions()
				.find(entry => entry.session.sessionId === origin.parentSessionId);
			const ancestor = parent
				? {
						requirementId: parent.requirementId,
						sessionId: parent.session.sessionId,
						generation: parent.generation,
					}
				: this.#interactionOwners.get(origin.parentSessionId);
			if (!ancestor) throw new Error("Native interaction parent is not owned by this workbench");
			const target = { ...ancestor, sessionId: origin.sessionId };
			this.#interactionOwners.set(origin.sessionId, ancestor);
			const cancel = () => {
				this.nativeUi.cancelSession(origin.sessionId);
				this.#interactionOwners.delete(origin.sessionId);
			};
			return {
				ui: this.nativeUi.createContext(() => {
					this.controller.resolveSession(ancestor);
					return target;
				}),
				cancel,
				dispose: cancel,
			};
		};
		this.controller = new SpecDrivenController({
			...input,
			settings: this.settings,
			uiForSession,
			createInteractionUI,
		});
		this.collab = createDevCollabController(this.sessionPort(this.rootSession));
		this.guests = new DevCollabBridge({
			settings: this.settings,
			onFrame: (browserId, frame) => this.#emit(browserId, frame),
			onJoined: (browserId, participant) =>
				this.#emit(browserId, {
					t: "collab-target",
					target: {
						kind: "collab",
						peerId: participant.peerId,
						roomId: participant.roomId,
						sessionId: participant.sessionId,
						generation: participant.generation,
					},
				}),
			onDisconnected: browserId => this.#emit(browserId, { t: "error", message: "Collab connection ended" }),
		});
		this.#disposers.push(
			this.nativeUi.observe(event => {
				for (const browserId of this.#frames.keys()) this.#emit(browserId, event);
			}),
		);
		this.#disposers.push(
			this.controller.subscribeSessions(session => {
				this.#observePredictions(session);
				if (this.#goals.has(session)) return;
				const goal = createDevGoalController(session);
				this.#goals.set(session, goal);
				this.#disposers.push(
					session.subscribe(event => {
						goal.observe(event);
						if (event.type === "goal_updated") {
							for (const browserId of this.#frames.keys())
								this.#emit(browserId, {
									t: "native-status",
									message: JSON.stringify({
										sessionId: session.sessionId,
										goal: session.getGoalModeState() ?? null,
									}),
								});
						}
					}),
				);
			}),
		);
		this.#disposers.push(
			this.controller.observe(() => {
				for (const [session, prediction] of this.#predictions) {
					if (prediction.target && !this.#predictionIsCurrent(session, prediction)) {
						prediction.epoch++;
						prediction.controller.cancel();
						this.#publishPrediction(session, prediction);
					}
				}
			}),
		);
	}

	targetForSession(session: AgentSession): DevSessionTarget {
		const owned = this.controller.nativeSessions().find(entry => entry.session === session);
		if (!owned) throw new Error("Session no longer belongs to this requirement");
		return { requirementId: owned.requirementId, sessionId: session.sessionId, generation: owned.generation };
	}
	#predictionIsCurrent(session: AgentSession, prediction: SessionPrediction): boolean {
		const target = prediction.target;
		if (this.#stopping || !target || this.controller.nativeSession(target.requirementId ?? undefined) !== session)
			return false;
		const current = this.targetForSession(session);
		return current.sessionId === target.sessionId && current.generation === target.generation;
	}
	#predictionChoices(session: AgentSession, prediction: SessionPrediction): readonly string[] {
		if (
			!this.#predictionIsCurrent(session, prediction) ||
			session.isStreaming ||
			session.isCompacting ||
			!cfgComposerPredictions.get(session.settings)
		)
			return [];
		const choices = prediction.controller.choices ?? [];
		return choices.length <= 1 || cfgComposerPredictionAlternatives.get(session.settings)
			? choices
			: choices.slice(0, 1);
	}
	#publishPrediction(session: AgentSession, prediction: SessionPrediction): void {
		if (!prediction.target) return;
		const choices = this.#predictionChoices(session, prediction);
		for (const browserId of this.#frames.keys()) {
			const participant = this.guests.getParticipant(browserId);
			if (participant) {
				if (participant.canWrite && participant.sessionId === session.sessionId)
					this.#emit(browserId, { t: "composer-prediction", target: this.guestTarget(browserId), choices });
			} else {
				this.#emit(browserId, { t: "composer-prediction", target: prediction.target, choices });
			}
		}
	}
	#observePredictions(session: AgentSession): void {
		if (this.#predictions.has(session)) return;
		const editor = this.nativeUi.createContext(() => prediction.target ?? this.targetForSession(session));
		const prediction: SessionPrediction = {
			controller: new ComposerPredictionController({
				settings: session.settings,
				viewSession: session,
				focusedAgentId: undefined,
				editor: { getText: () => editor.getEditorText() },
				ui: { requestRender: () => this.#publishPrediction(session, prediction) },
				isCurrent: () => this.#predictionIsCurrent(session, prediction),
			}),
			target: undefined,
			epoch: 0,
		};
		this.#predictions.set(session, prediction);
		this.#disposers.push(session.subscribe(event => this.#observePredictionEvent(session, prediction, event)));
	}
	#observePredictionEvent(session: AgentSession, prediction: SessionPrediction, event: AgentSessionEvent): void {
		if (
			event.type === "agent_start" ||
			event.type === "session_abort" ||
			event.type === "auto_compaction_start" ||
			event.type === "manual_compaction_start" ||
			event.type === "auto_retry_start" ||
			event.type === "model_changed"
		) {
			prediction.epoch++;
			prediction.controller.cancel();
			this.#publishPrediction(session, prediction);
		}
		if (event.type !== "agent_end" || this.#stopping) return;
		const last = event.messages.findLast(message => message.role === "assistant");
		if (!last || last.stopReason === "error" || last.stopReason === "aborted" || event.yielded === false) return;
		const epoch = prediction.epoch;
		const anchor = session.messages.at(-1);
		this.#track(
			(async () => {
				await session.waitForIdle();
				await session.waitForAdmittedSubmissions();
				if (
					this.#stopping ||
					prediction.epoch !== epoch ||
					prediction.requestedEpoch === epoch ||
					session.messages.at(-1) !== anchor ||
					session.isRetrying ||
					session.hasPendingAsyncWork()
				)
					return;
				const target = this.targetForSession(session);
				if (this.controller.nativeSession(target.requirementId ?? undefined) !== session) return;
				prediction.target = target;
				prediction.requestedEpoch = epoch;
				prediction.controller.request();
			})(),
		);
	}
	composerPrediction(
		browserId: string,
		target: DevInputTarget,
		event?: "shown" | "accepted",
		rank?: number,
	): { choices: readonly string[] } {
		this.assertWritable(browserId);
		const local = this.#nativeCommandTarget(browserId, target);
		if (!local) return { choices: [] };
		const session = this.controller.resolveSession(local);
		const prediction = this.#predictions.get(session);
		if (!prediction) return { choices: [] };
		const choices = this.#predictionChoices(session, prediction);
		if (event === "shown" && choices.length) prediction.controller.shown();
		if (event === "accepted") {
			if (rank === undefined || !Number.isSafeInteger(rank) || rank < 0 || rank >= choices.length)
				throw new Error("Prediction rank is outside the current choices");
			prediction.controller.accepted(rank);
		}
		return { choices };
	}
	sessionPort(session: AgentSession): CollabHostPort {
		const owned = this.controller.nativeSessions().find(entry => entry.session === session);
		const target = owned
			? { requirementId: owned.requirementId, sessionId: session.sessionId, generation: owned.generation }
			: null;
		return {
			session,
			sessionManager: session.sessionManager,
			settings: this.settings,
			collabGuest: undefined,
			eventBus: session.eventBus,
			subagentEventBus: session.subagentEventBus,
			subscribeEntries: listener => subscribeCollabEntries(session.sessionManager, listener),
			promptCustomMessage: (message, options) => {
				if (!target) return Promise.reject(new Error("Native input target is no longer owned by this Dev host"));
				return this.controller.submitNativeInput(target, (native, onAdmitted) => {
					const completion = native.promptCustomMessage(message, {
						...options,
						onPromptAdmitted: () => {
							onAdmitted();
							options?.onPromptAdmitted?.();
						},
					});
					this.#track(completion);
					return completion;
				});
			},
			getContextUsage: () => {
				const usage = session.getContextUsage();
				return {
					tokens: usage?.tokens ?? 0,
					contextWindow: usage?.contextWindow ?? session.model?.contextWindow ?? 0,
				};
			},
			showStatus: text => {
				for (const browserId of this.#frames.keys()) this.#emit(browserId, { t: "native-status", message: text });
			},
		};
	}
	subscribeEntries(listener: EntryListener): () => void {
		return subscribeCollabEntries(this.rootSession.sessionManager, listener);
	}
	respondNativeUi(input: DevNativeUiResponse): Promise<{ accepted: boolean; reason?: string }> {
		return this.nativeUi.respondDevNativeUi(input);
	}
	person(browserId: string): DevPerson {
		const participant = this.guests.getParticipant(browserId);
		return participant
			? { name: participant.name, source: "collab", peerId: participant.peerId }
			: { name: os.userInfo().username, source: "local" };
	}
	assertWritable(browserId: string): void {
		const participant = this.guests.getParticipant(browserId);
		if (participant && !participant.canWrite) throw new Error("This native Collab connection is read-only");
		if (this.#stopping) throw new Error("Dev mode is stopping; no new work is accepted");
	}
	#emit(browserId: string, frame: HostFrame | object): void {
		for (const listener of this.#frames.get(browserId) ?? []) {
			try {
				listener(frame);
			} catch {
				this.#frames.get(browserId)?.delete(listener);
			}
		}
	}
	observeBrowser(browserId: string, listener: FrameListener): () => void {
		let listeners = this.#frames.get(browserId);
		if (!listeners) this.#frames.set(browserId, (listeners = new Set()));
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
			if (!listeners.size) this.#frames.delete(browserId);
		};
	}
	async subscribeNative(
		browserId: string,
		requirementId: string | null,
		listener: (frame: HostFrame | DevComposerPredictionFrame) => void,
	): Promise<() => Promise<void>> {
		let bridge:
			| { target: DevSessionTarget; sendFrame(frame: GuestFrame): Promise<DevSubmitResult>; close(): Promise<void> }
			| undefined;
		let closed = false;
		const attach = (session: AgentSession) => {
			if (closed || bridge || this.guests.getParticipant(browserId)) return;
			bridge = {
				target: this.targetForSession(session),
				...createDevLocalSessionBridge(this.sessionPort(session), listener),
			};
			this.#native.set(browserId, bridge);
			const prediction = this.#predictions.get(session);
			listener({
				t: "composer-prediction",
				target: bridge.target,
				choices: prediction ? this.#predictionChoices(session, prediction) : [],
			});
		};
		const session = this.controller.nativeSession(requirementId ?? undefined);
		if (session) attach(session);
		const participant = this.guests.getParticipant(browserId);
		if (participant) {
			const target = this.guestTarget(browserId);
			listener({
				t: "composer-prediction",
				target,
				choices: participant.canWrite ? this.composerPrediction(browserId, target).choices : [],
			});
		}
		const unsubscribe = this.controller.subscribeSessions((session, id) => {
			if (id === requirementId && !bridge) attach(session);
		});
		return async () => {
			if (closed) return;
			closed = true;
			unsubscribe();
			if (bridge && this.#native.get(browserId) === bridge) this.#native.delete(browserId);
			await bridge?.close();
			if (!this.#frames.has(browserId)) await this.guests.leaveDevCollab(browserId);
		};
	}
	guestTarget(browserId: string): DevGuestSessionTarget {
		const participant = this.guests.getParticipant(browserId);
		if (!participant) throw new Error("This browser is not joined to a native Collab session");
		return {
			kind: "collab",
			peerId: participant.peerId,
			roomId: participant.roomId,
			sessionId: participant.sessionId,
			generation: participant.generation,
		};
	}
	#assertTarget(browserId: string, target: DevInputTarget): void {
		if ("kind" in target) {
			const current = this.guestTarget(browserId);
			if (
				current.peerId !== target.peerId ||
				current.roomId !== target.roomId ||
				current.sessionId !== target.sessionId ||
				current.generation !== target.generation
			)
				throw new Error("Joined native session identity changed; join explicitly again");
		} else {
			if (this.guests.getParticipant(browserId))
				throw new Error("Leave Collab before sending to a local native session");
			this.controller.resolveSession(target);
		}
	}
	#nativeCommandTarget(browserId: string, target: DevInputTarget): DevSessionTarget | null {
		this.#assertTarget(browserId, target);
		if (!("kind" in target)) return target;
		const owned = this.controller.nativeSessions().find(entry => entry.session.sessionId === target.sessionId);
		if (!owned) return null;
		const local = this.targetForSession(owned.session);
		this.controller.resolveSession(local);
		return local;
	}
	async joinDevCollab(
		input: { browserId: string; usernameOrLink: string; name: string },
		signal: AbortSignal,
	): Promise<{
		peerId: string;
		roomId: string;
		canWrite: boolean;
		target: DevGuestSessionTarget;
		nativeEditorSupported: boolean;
	}> {
		const result = await this.guests.joinDevCollab(input, signal);
		const local = this.#native.get(input.browserId);
		this.#native.delete(input.browserId);
		await local?.close();
		const target = this.guestTarget(input.browserId);
		const predictionTarget = this.#nativeCommandTarget(input.browserId, target);
		this.#emit(input.browserId, {
			t: "composer-prediction",
			target,
			choices: result.canWrite ? this.composerPrediction(input.browserId, target).choices : [],
		});
		return { ...result, target, nativeEditorSupported: predictionTarget !== null };
	}
	async prepareDevAction(
		browserId: string,
		input: Parameters<SpecDrivenController["prepareDevAction"]>[0],
	): Promise<DevActionPreview> {
		this.assertWritable(browserId);
		const preview = await this.controller.prepareDevAction(input);
		this.#prepared.set(preview.action.binding.operationId, browserId);
		return preview;
	}
	async confirmDevAction(
		browserId: string,
		input: Parameters<SpecDrivenController["confirmDevAction"]>[0],
	): Promise<DevActionResult> {
		this.assertWritable(browserId);
		const boundBrowser = this.#prepared.get(input.operationId);
		if (boundBrowser !== undefined && boundBrowser !== browserId)
			throw new Error("Confirmation belongs to another browser");
		const result = await this.controller.confirmDevAction(input, this.person(browserId));
		this.#prepared.set(input.operationId, browserId);
		return result;
	}
	prepareDevInput(browserId: string, target: DevInputTarget): { requestId: string; target: DevInputTarget } {
		this.assertWritable(browserId);
		this.#assertTarget(browserId, target);
		const now = Date.now();
		for (const [id, receipt] of this.#inputs) if (now - receipt.createdAt > 30 * 60_000) this.#inputs.delete(id);
		if (this.#inputs.size >= 2048) throw new Error("Too many pending native input receipts");
		const requestId = randomUUID();
		this.#inputs.set(requestId, {
			browserId,
			target: { ...target },
			createdAt: now,
			started: false,
			result: { kind: "unknown", message: "Input has not been submitted" },
		});
		return { requestId, target };
	}
	inspectDevInput(browserId: string, requestId: string): DevSubmitResult {
		const receipt = this.#inputs.get(requestId);
		return receipt?.browserId === browserId
			? receipt.result
			: { kind: "unknown", message: "No native receipt exists for this browser" };
	}
	async submitDevInput(
		browserId: string,
		input: { requestId: string; text: string; images?: readonly ImageContent[] },
	): Promise<DevSubmitResult> {
		this.assertWritable(browserId);
		const receipt = this.#inputs.get(input.requestId);
		if (!receipt || receipt.browserId !== browserId)
			return { kind: "rejected", message: "Input identity is missing or belongs to another browser" };
		if (receipt.started) return receipt.result;
		try {
			this.#assertTarget(browserId, receipt.target);
		} catch (error) {
			return (receipt.result = { kind: "rejected", message: message(error) });
		}
		receipt.started = true;
		const parsed = parseSlashCommand(input.text);
		const builtin = parsed && lookupBuiltinSlashCommand(parsed.name);
		if (parsed && (builtin || ["abort", "thinking", "queue"].includes(parsed.name))) {
			try {
				return (receipt.result = await this.runDevNativeCommand(browserId, {
					target: receipt.target,
					command: builtin?.name ?? parsed.name,
					args: parseCommandArgs(parsed.args),
					rawText: input.text,
					images: input.images,
				}));
			} catch (error) {
				return (receipt.result = { kind: "rejected", message: message(error) });
			}
		}
		if ("kind" in receipt.target) {
			const sent = await this.guests.sendFrame(browserId, {
				t: "prompt",
				text: input.text,
				images: input.images ? [...input.images] : undefined,
			});
			return (receipt.result =
				sent.kind === "accepted"
					? {
							kind: "unknown",
							message:
								"Native Collab transport sent the input, but this protocol has no admission acknowledgement; do not automatically resend",
						}
					: sent);
		}
		const target = receipt.target;
		const accepted = Promise.withResolvers<DevSubmitResult>();
		let settled = false;
		const settle = (result: DevSubmitResult) => {
			receipt.result = result;
			if (!settled) {
				settled = true;
				accepted.resolve(result);
			}
		};
		const task = this.controller
			.submitNativeInput(target, (session, onAdmitted) => {
				const completion = (async () => {
					const options = {
						inputId: input.requestId,
						streamingBehavior: "followUp" as const,
						onPromptAdmitted: () => {
							onAdmitted();
							receipt.result = { kind: "accepted" };
						},
					};
					const invocation = session.skillsSettings?.enableSkillCommands
						? parseSkillInvocation(input.text)
						: undefined;
					const skill = invocation && session.skills.find(candidate => candidate.name === invocation.name);
					if (skill && invocation) {
						// Native loading enforces this session's skill scope and preserves the typed invocation/arguments.
						const built = await session.buildUserSkillPrompt(skill, invocation);
						const invoked = await session.promptCustomMessage(
							{
								customType: SKILL_PROMPT_MESSAGE_TYPE,
								content: input.images?.length
									? [{ type: "text", text: built.message }, ...input.images]
									: built.message,
								display: true,
								details: built.details,
								attribution: "user",
							},
							{ ...options, queueChipText: input.text },
						);
						if (receipt.result.kind !== "accepted") throw new Error("Native skill input was not admitted");
						return invoked;
					}
					return session.prompt(input.text, {
						...options,
						images: input.images ? [...input.images] : undefined,
						userInitiated: true,
						throwOnDrop: true,
					});
				})();
				this.#track(completion);
				return completion.catch(error => {
					if (receipt.result.kind === "accepted") this.#emit(browserId, { t: "error", message: message(error) });
					throw error;
				});
			})
			.then(
				admitted =>
					settle(admitted ? { kind: "accepted" } : { kind: "rejected", message: "Native input was not admitted" }),
				error => {
					if (receipt.result.kind === "accepted") this.#emit(browserId, { t: "error", message: message(error) });
					else settle({ kind: "rejected", message: message(error) });
				},
			);
		this.#track(task);
		return accepted.promise;
	}
	#track(task: Promise<unknown>): void {
		this.#work.add(task);
		void task.then(
			() => this.#work.delete(task),
			() => this.#work.delete(task),
		);
	}
	getNativeCommands(target: DevInputTarget, browserId = ""): DevNativeCommand[] {
		const local = "kind" in target ? this.#nativeCommandTarget(browserId, target) : target;
		if (!local)
			return [
				{ name: "abort", description: "Stop the joined native session through its existing Collab transport" },
			];
		const session = this.controller.resolveSession(local);
		return [
			{ name: "abort", description: "Stop native work in this session" },
			{
				name: "model",
				description: "Select a model for this Dev session only; does not change native global defaults",
			},
			{ name: "thinking", description: "Set native reasoning level" },
			...(cfgGoalEnabled.get(this.settings) && (this.controller.canStartGoal(local) || session.getGoalModeState())
				? [{ name: "goal", description: "Start, pause, resume, or drop the native Goal" }]
				: []),
			{ name: "collab", description: "Share this native session or stop its room" },
			{ name: "team", description: "Run a native Team discussion in this session" },
			{ name: "queue", description: "Native queue: list, remove <inputId>, clear, pause-drain, resume-drain" },
			...Array.from(DEV_SESSION_BUILTINS, name => ({
				name,
				description: lookupBuiltinSlashCommand(name)?.description ?? name,
			})),
			...getSessionSlashCommands(session).map(command => ({ name: command.name, description: command.description })),
		];
	}
	async runDevNativeCommand(
		browserId: string,
		request: {
			target: DevInputTarget;
			command: string;
			args: string[];
			rawText?: string;
			images?: readonly ImageContent[];
		},
	): Promise<DevSubmitResult> {
		try {
			this.assertWritable(browserId);
			const local = this.#nativeCommandTarget(browserId, request.target);
			if (!local) {
				if (request.command.replace(/^\//, "") !== "abort")
					throw new Error("The joined remote native protocol does not expose this command");
				const result = await this.guests.sendFrame(browserId, { t: "abort" });
				return result.kind === "accepted"
					? {
							kind: "unknown",
							message: "Native Collab transport sent Stop without a native settlement acknowledgement",
						}
					: result;
			}
			const input = { ...request, target: local };
			const session = this.controller.resolveSession(input.target);
			const builtin = lookupBuiltinSlashCommand(input.command.replace(/^\//, ""));
			const command = builtin?.name ?? input.command.replace(/^\//, "");
			if (!this.getNativeCommands(input.target).some(item => item.name === command))
				throw new Error(
					builtin
						? `/${command} requires the ordinary OMP TUI or changes configuration outside this Dev session; it is not available here`
						: "This command is not available in the target native session",
				);
			const ui = this.nativeUi.createContext(() => {
				this.controller.resolveSession(input.target);
				return input.target;
			});
			if (command === "abort") {
				this.#goals.get(session)?.stopForHostAbort();
				if (input.target.requirementId) await this.controller.stop(input.target.requirementId);
				else await this.controller.stopLocalBusiness();
			} else if (command === "collab") {
				let room = this.#rooms.get(session);
				if (!room) {
					room = createDevCollabController(this.sessionPort(session));
					room.startupComplete();
					this.#rooms.set(session, room);
				}
				if (input.args[0] === "stop") await room.stop("Stopped explicitly in the workbench");
				else {
					const hosted = await room.start({ access: input.args[0] === "view" ? "view" : "control" });
					this.#emit(browserId, { t: "native-status", message: hosted.link });
				}
			} else if (command === "model") {
				const available = session.modelRegistry.getAvailable();
				const selector = input.args.length
					? input.args.join(" ")
					: await ui.select(
							"Native model",
							available.map(model => `${model.provider}/${model.id}`),
						);
				if (!selector) return { kind: "rejected", message: "Model selection cancelled" };
				this.controller.resolveSession(input.target);
				const model = available.find(model => `${model.provider}/${model.id}` === selector);
				if (!model) throw new Error("Choose an available native provider/model identifier");
				await session.setModel(model);
				this.#emit(browserId, {
					t: "native-status",
					message: `Model set to ${model.provider}/${model.id} for this Dev session.`,
				});
			} else if (command === "thinking") {
				const selector = input.args[0] ?? (await ui.select("Native reasoning level", [...CLI_THINKING_LEVELS]));
				if (selector === undefined) return { kind: "rejected", message: "Native reasoning selection cancelled" };
				const level = parseConfiguredThinkingLevel(selector);
				if (level === undefined) throw new Error("Invalid native reasoning selector");
				session.setThinkingLevel(level);
				this.#emit(browserId, { t: "native-status", message: `Thinking set to ${level} for this Dev session.` });
			} else if (command === "goal") {
				const [action, ...objective] = input.args;
				const goal = this.#goals.get(session);
				if (!goal) throw new Error("Native Goal controller is unavailable for this owned session");
				if (action === "start" || action === "resume") await this.controller.assertGoalAllowed(input.target);
				if (action === "pause" || action === "resume" || action === "drop") {
					const result = await goal.handle({ op: action });
					this.#emit(browserId, {
						t: "native-status",
						message: result.goal ? `Goal ${result.goal.status}: ${result.goal.objective}` : "No active Goal.",
					});
				} else if (action === "start") {
					await goal.handle({ op: "create", objective: objective.join(" ") });
					const prepared = this.prepareDevInput(browserId, request.target);
					return this.submitDevInput(browserId, { requestId: prepared.requestId, text: objective.join(" ") });
				} else if (action === "status" || action === undefined) {
					const result = await goal.handle({ op: "get" });
					this.#emit(browserId, {
						t: "native-status",
						message: result.goal ? `Goal ${result.goal.status}: ${result.goal.objective}` : "No active Goal.",
					});
				} else throw new Error("Goal expects start <objective>, pause, resume, drop, or status");
			} else if (command === "queue") {
				const [action = "list", inputId] = input.args;
				const identities = () =>
					session
						.getQueuedInputMessages()
						.map(message =>
							"inputId" in message && typeof message.inputId === "string" ? message.inputId : null,
						);
				if (action === "remove") {
					if (!inputId || !identities().includes(inputId))
						throw new Error("The selected input is not in the native queue");
					if (!(await ui.confirm("Remove native queued input", inputId)))
						return { kind: "rejected", message: "Queue removal cancelled" };
					this.controller.resolveSession(input.target);
					if (!session.takeQueuedInput(inputId))
						throw new Error("The native input was already dispatched or removed");
				} else if (action === "clear") {
					const before = identities();
					if (!(await ui.confirm("Clear native queued inputs", `Remove ${before.length} queued inputs?`)))
						return { kind: "rejected", message: "Queue clear cancelled" };
					this.controller.resolveSession(input.target);
					if (JSON.stringify(before) !== JSON.stringify(identities()))
						throw new Error("The native queue changed during confirmation; review it again");
					session.clearQueue();
				} else if (action === "pause-drain") session.setQueueAutoDrain(false);
				else if (action === "resume-drain") session.setQueueAutoDrain(true);
				else if (action !== "list")
					throw new Error("Queue expects list, remove <inputId>, clear, pause-drain, or resume-drain");
				this.#emit(browserId, {
					t: "native-status",
					message: [
						`Native queue: ${session.queuedMessageCount} pending; automatic dispatch ${session.getQueueAutoDrain() ? "enabled" : "paused"}.`,
						...[...session.getQueuedMessages().steering, ...session.getQueuedMessages().followUp].map(
							(text, index) => `${index + 1}. ${text}`,
						),
					].join("\n"),
				});
			} else if (command === "team") {
				const question = input.args.join(" ") || (await ui.editor("Native Team question"));
				if (!question) return { kind: "rejected", message: "Team discussion cancelled" };
				this.controller.resolveSession(input.target);
				const result = await startTeamDiscussion(question, {
					session,
					settings: this.settings,
					cwd: this.cwd,
					hooks: {
						showStatus: text => ui.notify(text),
						showError: text => ui.notify(text, "error"),
						output: text => ui.notify(text),
					},
				});
				if (!result.started) return { kind: "rejected", message: result.message };
			} else if (DEV_SESSION_BUILTINS.has(command) && builtin?.handle) {
				const parsed = parseSlashCommand(input.rawText ?? `/${command} ${input.args.join(" ")}`);
				if (!parsed) throw new Error("Invalid slash command");
				if (parsed.args && !builtin.allowArgs && !builtin.acpAllowArgs)
					throw new Error(`/${command} does not accept arguments`);
				const result = await builtin.handle(
					{ ...parsed, name: command },
					{
						session,
						sessionManager: session.sessionManager,
						settings: session.settings,
						cwd: session.sessionManager.getCwd(),
						ui,
						input: { images: input.images ? [...input.images] : undefined },
						sessionScopedCwd: true,
						output: text => this.#emit(browserId, { t: "native-status", message: text }),
						refreshCommands: () => {},
						reloadPlugins: async () => {
							throw new Error("Plugin reload is not available in a Dev stage session");
						},
					},
				);
				if (result && "prompt" in result) {
					const prepared = this.prepareDevInput(browserId, request.target);
					return this.submitDevInput(browserId, {
						requestId: prepared.requestId,
						text: result.prompt,
						images: input.images,
					});
				}
				if (result && "failed" in result && result.failed)
					return { kind: "rejected", message: `/${command} did not complete; see the command message above` };
			} else {
				const prepared = this.prepareDevInput(browserId, request.target);
				return this.submitDevInput(browserId, {
					requestId: prepared.requestId,
					text: input.rawText ?? `/${command} ${input.args.join(" ")}`.trim(),
					images: input.images,
				});
			}
			return { kind: "accepted" };
		} catch (error) {
			return { kind: "rejected", message: message(error) };
		}
	}
	updateNativeEditor(browserId: string, target: DevInputTarget, text: string): { updated: true } {
		this.assertWritable(browserId);
		const local = this.#nativeCommandTarget(browserId, target);
		if (!local) throw new Error("The joined remote native transport does not expose an editor state surface");
		this.nativeUi.updateEditor(local, text);
		return { updated: true };
	}
	async readNativeSnapshot(browserId: string, target: DevInputTarget): Promise<HostFrame[]> {
		const local = this.#nativeCommandTarget(browserId, target);
		if (!local) throw new Error("The joined remote native transport does not support a read-only resnapshot");
		const session = this.controller.resolveSession(local);
		const frames: HostFrame[] = [];
		const projection = createDevLocalSessionBridge(this.sessionPort(session), frame => frames.push(frame));
		await projection.close();
		return frames;
	}
	async sendNativeFrame(browserId: string, target: DevInputTarget, frame: GuestFrame): Promise<DevSubmitResult> {
		if (frame.t !== "fetch-transcript") this.assertWritable(browserId);
		this.#assertTarget(browserId, target);
		if (frame.t === "abort") return this.runDevNativeCommand(browserId, { target, command: "abort", args: [] });
		if ("kind" in target) {
			const result = await this.guests.sendFrame(browserId, frame);
			return result.kind === "accepted" && frame.t !== "fetch-transcript"
				? {
						kind: "unknown",
						message: "Native Collab transport sent the operation without a native acknowledgement",
					}
				: result;
		}
		const bridge = this.#native.get(browserId);
		if (
			!bridge ||
			bridge.target.sessionId !== target.sessionId ||
			bridge.target.generation !== target.generation ||
			bridge.target.requirementId !== target.requirementId
		)
			return {
				kind: "rejected",
				message: "Subscribe to the selected native session before issuing native controls",
			};
		return bridge.sendFrame(frame);
	}
	#resolveMcpCaller(invocation: MCPAuthInvocation): {
		session: AgentSession;
		requirementId: string | null;
		generation: number;
	} {
		if (invocation.signal?.aborted) throw new MCPOAuthCancelledError();
		if (!invocation.scope || invocation.scope === "owner" || !invocation.toolCallId)
			throw new Error("MCP authorization requires an attributed native tool invocation");
		const registry = AgentRegistry.global();
		for (const owner of this.controller.nativeSessions()) {
			try {
				this.controller.resolveSession({
					requirementId: owner.requirementId,
					sessionId: owner.session.sessionId,
					generation: owner.generation,
				});
			} catch {
				continue;
			}
			const ownerId = owner.session.getAgentId();
			if (!ownerId) continue;
			const candidates = [owner.session];
			for (const id of specDescendantAgentIds(registry, ownerId)) {
				const session = registry.get(id)?.session;
				if (session && isLocalAgentSession(session)) candidates.push(session);
			}
			for (const session of candidates) {
				if (
					!session.isDisposed &&
					session.sessionManager.getSessionId() === invocation.scope &&
					session.agent.state.pendingToolCalls.has(invocation.toolCallId)
				) {
					return { session, requirementId: owner.requirementId, generation: owner.generation };
				}
			}
		}
		throw new Error("MCP authorization no longer belongs to an active native tool call in this workbench");
	}
	handleNativeMcpAuth(
		name: string,
		challenge: MCPAuthChallenge,
		invocation?: MCPAuthInvocation,
	): Promise<MCPServerConfig | undefined> {
		const work = this.#authorizeMcp(name, challenge, invocation);
		this.#track(work);
		return work;
	}
	async #authorizeMcp(
		name: string,
		challenge: MCPAuthChallenge,
		invocation?: MCPAuthInvocation,
	): Promise<MCPServerConfig | undefined> {
		if (!invocation) throw new Error("MCP authorization requires native invocation identity");
		const manager = this.#mcpManager;
		if (!manager) throw new Error("The workbench's borrowed native MCP manager is unavailable");
		const bound = this.#resolveMcpCaller(invocation);
		const target = {
			requirementId: bound.requirementId,
			sessionId: bound.session.sessionId,
			generation: bound.generation,
		};
		const current = () => {
			const owner = this.#resolveMcpCaller(invocation);
			if (
				owner.session !== bound.session ||
				owner.generation !== bound.generation ||
				owner.requirementId !== bound.requirementId
			)
				throw new Error("Native MCP authorization owner changed");
			return target;
		};
		const ui = this.nativeUi.createContext(current);
		const signal = invocation.signal
			? AbortSignal.any([invocation.signal, this.#authShutdown.signal])
			: this.#authShutdown.signal;
		try {
			return await bound.session.waitForUser(async () => {
				const found = await findMcpServerForAuth(name, this.cwd, manager, {
					preferManager: true,
					enableProjectConfig: cfgMcpEnableProjectConfig.get(this.settings),
				});
				if (!found || !matchingManagerServerConfig(manager, name, found.config))
					throw new Error(
						"The configured MCP authentication target does not match this borrowed native connection",
					);
				current();
				if (
					!(await ui.confirm(
						`Authorize native MCP server ${name}`,
						`This active native tool requires OAuth. The existing native flow may save credentials and update its ${found.scope} server configuration. Continue?`,
						{ signal },
					))
				)
					return undefined;
				let authorizationUrl = "";
				let instructions = "";
				const outcome = await reauthorizeMcpServer(name, found, {
					authStorage: bound.session.modelRegistry.authStorage,
					mcpManager: manager,
					cwd: this.cwd,
					authChallenge: challenge,
					signal,
					flowOwner: bound.session,
					silent: true,
					onAuth: info => {
						authorizationUrl = info.url;
						instructions = info.instructions ?? "";
						ui.notify(`MCP ${name}: ${authorizationUrl}\n${instructions}`);
					},
					onProgress: message => ui.notify(message),
					onManualCodeInput: async flowSignal => {
						const answer = await ui.input(
							`MCP ${name}: open this authorization URL, then paste the callback URL or code\n${authorizationUrl}\n${instructions}`,
							undefined,
							{ signal: flowSignal ? AbortSignal.any([signal, flowSignal]) : signal, secret: true },
						);
						if (answer === undefined) throw new MCPOAuthCancelledError();
						return answer;
					},
				});
				current();
				return outcome.config;
			});
		} catch (error) {
			if (error instanceof MCPOAuthCancelledError || signal.aborted) return undefined;
			throw error;
		}
	}
	attachService(service: DevWorkbenchHandle): void {
		this.#service = service;
	}
	close(): Promise<void> {
		this.#stopping = true;
		let closing = this.#closing;
		if (!closing) {
			closing = this.#close();
			this.#closing = closing;
			void closing.catch(() => {
				if (this.#closing === closing) this.#closing = undefined;
			});
		}
		return closing;
	}
	async #close(): Promise<void> {
		const failures: unknown[] = [];
		this.#authShutdown.abort("Dev workbench host shutdown");
		this.nativeUi.close();
		for (const prediction of this.#predictions.values()) prediction.controller.cancel();
		for (const goal of this.#goals.values()) goal.stopForHostAbort();
		const predictions = await Promise.allSettled(
			[...this.#predictions.values()].map(prediction => prediction.controller.settled()),
		);
		for (const result of predictions) if (result.status === "rejected") failures.push(result.reason);
		for (const close of [
			() => this.guests.close(),
			() => this.collab.shutdown("Dev mode exit"),
			...[...this.#rooms.values()].map(room => () => room.shutdown("Dev mode exit")),
			() => this.controller.dispose(),
		]) {
			try {
				await close();
			} catch (error) {
				failures.push(error);
			}
		}
		const results = await Promise.allSettled([...this.#work]);
		for (const result of results) if (result.status === "rejected") failures.push(result.reason);
		for (const goal of this.#goals.values()) {
			try {
				await goal.settled();
			} catch (error) {
				failures.push(error);
			}
		}
		if (failures.length)
			throw new AggregateError(failures, "Dev native work has not fully settled; ordinary mode must remain blocked");
		await this.settings.flush();
		for (const dispose of this.#disposers) dispose();
		this.#restoreMcpAuth?.();
		if (this.#ownsRoot) await this.rootSession.dispose();
		await this.#service?.close();
		if (this.#cacheKey) hosts.delete(this.#cacheKey);
		services.delete(this);
	}
}

export async function createDevWorkbenchHost(input: {
	session: AgentSession;
	settings: Settings;
	cwd: string;
	setToolUIContext?: CreateAgentSessionResult["setToolUIContext"];
	ownsRoot?: boolean;
	mcpManager?: MCPManager;
	nativeMcpUiAuthHandler?: MCPAuthHandler;
}): Promise<DevWorkbenchHost> {
	if (input.session.isDisposed) throw new Error("Cannot enter Dev mode with a disposed native root");
	const { root: cwd } = await DevWorkspace.resolve(input.cwd);
	const profile = await fs.realpath(input.settings.getAgentDir());
	const cacheKey = JSON.stringify([normalizePathForComparison(cwd), normalizePathForComparison(profile)]);
	let pending = hosts.get(cacheKey);
	if (!pending) {
		pending = (async () => {
			const candidate = input.mcpManager ?? input.session.nativeChildCapabilities?.mcpManager;
			const manager = candidate instanceof MCPManager ? candidate : undefined;
			const previousAuth = manager?.getAuthHandler();
			const bindUiAuth = !!manager && (!previousAuth || previousAuth === input.nativeMcpUiAuthHandler);
			const authHandler: MCPAuthHandler = (name, challenge, invocation) => {
				return host.handleNativeMcpAuth(name, challenge, invocation);
			};
			const restoreMcpAuth = () => {
				if (bindUiAuth && manager?.getAuthHandler() === authHandler) manager.setAuthHandler(previousAuth);
			};
			const host = new DevWorkbenchHost({
				session: input.session,
				settings: input.settings,
				cwd,
				cacheKey,
				ownsRoot: input.ownsRoot === true,
				mcpManager: manager,
				restoreMcpAuth,
			});
			try {
				if (input.ownsRoot && input.setToolUIContext) {
					const ui = host.nativeUi.createContext(() => ({
						requirementId: null,
						sessionId: input.session.sessionId,
						generation: 0,
					}));
					input.setToolUIContext(ui, true);
				}
				if (bindUiAuth) manager?.setAuthHandler(authHandler);
			} catch (error) {
				try {
					await host.close();
				} catch (cleanup) {
					throw new AggregateError([error, cleanup], "Dev host entry and settlement failed");
				}
				throw error;
			}
			return host;
		})();
		hosts.set(cacheKey, pending);
		void pending.catch(() => hosts.delete(cacheKey));
	}
	const host = await pending;
	if (host.rootSession !== input.session)
		throw new Error(
			"This workspace already has a Dev host bound to another native root; exit it before entering again",
		);
	return host;
}
export function getOrStartDevWorkbench(
	host: DevWorkbenchHost,
	options?: Parameters<typeof startDevWorkbenchServer>[1],
): Promise<DevWorkbenchHandle> {
	let pending = services.get(host);
	if (!pending) {
		pending = startDevWorkbenchServer(host, options).then(handle => {
			host.attachService(handle);
			return handle;
		});
		services.set(host, pending);
		void pending.catch(() => services.delete(host));
	}
	return pending;
}
export async function closeAllDevWorkbenches(): Promise<void> {
	const opening = await Promise.allSettled([...hosts.values()]);
	const owned = opening.filter(result => result.status === "fulfilled").map(result => result.value);
	const results = await Promise.allSettled(owned.map(host => host.close()));
	const failed = [...opening, ...results].filter(result => result.status === "rejected");
	if (failed.length)
		throw new AggregateError(
			failed.map(result => result.reason),
			"Workbench shutdown failed",
		);
}
/** Native startup shared by the browser host; constructing it never submits a turn. */
export async function createDevWorkbenchSession(parsed: Args): Promise<{
	session: AgentSession;
	settings: Settings;
	cwd: string;
	setToolUIContext: CreateAgentSessionResult["setToolUIContext"];
	mcpManager?: MCPManager;
	ownsRoot: true;
}> {
	await applyStartupCwd(parsed);
	const cwd = getProjectDir();
	await ensureTheme();
	await setCompanyOfflineEnabled(parsed.offline === true);
	const activeSettings = await Settings.init({ cwd, configFiles: parsed.config });
	if (parsed.approvalMode) cfgToolsApprovalMode.override(activeSettings, parsed.approvalMode);
	else if (parsed.autoApprove) cfgToolsApprovalMode.override(activeSettings, "yolo");
	if (parsed.warnCost !== undefined) cfgSessionWarnCost.override(activeSettings, parsed.warnCost);
	if (parsed.maxCost !== undefined) cfgSessionMaxCost.override(activeSettings, parsed.maxCost);
	if (parsed.offline) {
		cfgWebSearchEnabled.override(activeSettings, false);
		cfgBrowserEnabled.override(activeSettings, false);
		cfgAstEditEnabled.override(activeSettings, false);
		cfgFetchEnabled.override(activeSettings, false);
		setCompanyChatContextWindow(COMPANY_OFFLINE_CONTEXT_WINDOW);
		if (getCompanyConfig() && !disabledProviderIds(activeSettings).has(COMPANY_PROVIDER_ID)) {
			activeSettings.setModelRoleDefaults(COMPANY_OFFLINE_ROLE_DEFAULTS);
		}
	}
	const home = os.homedir();
	if (parsed.pluginDirs?.length) await injectPluginDirRoots(home, parsed.pluginDirs, cwd, { includeClaude: false });
	else await preloadPluginRoots(home, cwd, { includeClaude: false });
	if (!parsed.trustedExtensions?.length) {
		injectOmpExtensionCliRoots([...(parsed.extensions ?? []), ...(parsed.hooks ?? [])], home, cwd, {
			mode: parsed.noExtensions ? "explicit-only" : "merge",
			replace: true,
		});
	}
	await initializeWithSettings(activeSettings);
	const smol = parsed.smol ?? $env.PI_SMOL_MODEL;
	const slow = parsed.slow ?? $env.PI_SLOW_MODEL;
	const plan = parsed.plan ?? $env.PI_PLAN_MODEL;
	if (smol || slow || plan) activeSettings.overrideModelRoles({ smol, slow, plan });
	if (parsed.noPty) Bun.env.PI_NO_PTY = "1";
	if (parsed.noTitle) Bun.env.PI_NO_TITLE = "1";
	const authStorage = await discoverAuthStorage(undefined, { settings: activeSettings });
	createAuthStorageSettingsSync(activeSettings, authStorage);
	const modelRegistry = new ModelRegistry(authStorage, undefined, { settings: activeSettings });
	await modelRegistry.hydrateCredentialScopedModelCaches();
	const scopedModels = await resolveScopedModels(parsed, modelRegistry, activeSettings);
	const manager = SessionManager.inMemory(cwd);
	const options = await buildSessionOptions(parsed, scopedModels, manager, modelRegistry, activeSettings);
	options.authStorage = authStorage;
	options.modelRegistry = modelRegistry;
	options.settings = activeSettings;
	options.hasUI = true;
	options.interactivePrompts = true;
	options.settingsApproval = true;
	options.deferSkillDescriptionCompression = true;
	options.eventBus = new EventBus();
	options.subagentEventBus = new EventBus();
	if (parsed.apiKey && options.model) authStorage.keys.setRuntime(options.model.provider, parsed.apiKey);
	const result = await createAgentSession(options);
	if (parsed.apiKey && !options.model && result.session.model) {
		authStorage.keys.setRuntime(result.session.model.provider, parsed.apiKey);
	}
	watchScopedModelSettings(result.session, parsed, modelRegistry, activeSettings);
	AgentLifecycleManager.global().setPersistedSubagentReviverFactory(
		createPersistedSubagentReviverFactory({
			session: result.session,
			authStorage,
			modelRegistry,
			settings: activeSettings,
			enableLsp: options.enableLsp ?? true,
			eventBus: options.eventBus,
			subagentEventBus: options.subagentEventBus,
		}),
		() => Math.trunc(Number(cfgTaskAgentIdleTtlMs.get(activeSettings)) || 0),
	);
	return {
		session: result.session,
		settings: activeSettings,
		cwd,
		setToolUIContext: result.setToolUIContext,
		ownsRoot: true,
		mcpManager: result.mcpManager,
	};
}

/** Standalone native owner; the browser only subscribes to this process. */
export async function runDevWorkbenchCommand(parsedArgs: Args, _rawArgs: string[]): Promise<void> {
	const boot = await createDevWorkbenchSession(parsedArgs);
	let host: DevWorkbenchHost | undefined;
	const shutdown = Promise.withResolvers<void>();
	const signal = () => shutdown.resolve();
	for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(name, signal);
	try {
		host = await createDevWorkbenchHost(boot);
		const handle = await getOrStartDevWorkbench(host);
		for (const url of handle.urls) process.stdout.write(`Dev workbench ready: ${url}\n`);
		if (handle.urls.length === 1 && parsedArgs.offline) {
			process.stderr.write("No non-loopback IPv4 interface was found; only the local URL is available.\n");
		}
		if (process.env.OMP_DEV_NO_OPEN === "1") {
			process.stderr.write("Browser opener skipped (OMP_DEV_NO_OPEN=1); use the ready URL.\n");
		} else {
			const opened = await openPathWithResult(handle.loopbackUrl);
			if (!opened.opened)
				process.stderr.write(`Browser opener failed: ${opened.reason}. Service remains ready at ${handle.url}\n`);
		}
		await shutdown.promise;
	} finally {
		for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(name, signal);
		try {
			await host?.close();
		} finally {
			await boot.session.dispose();
		}
	}
}
