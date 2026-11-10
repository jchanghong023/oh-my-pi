import { AgentBusyError } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { PROPOSE_DEVICE_NAME } from "@oh-my-pi/pi-tui/tools/resolve";
import { splitQueuedMessages } from "@oh-my-pi/pi-tui/prompt/queue-input";
import type { LoopLimitRuntime } from "@oh-my-pi/pi-tui/status-line/loop";
import { all as allSettings, type SettingValueOf } from "../../config/registry";
import { formatModelString, resolveModelRoleValue } from "../../config/model-resolver";
import { cfgModelRoles } from "../../config/model-settings";
import type { ExtensionUIContext } from "../../extensibility/extensions/types";
import { cfgGoalEnabled } from "../../goals/settings";
import { copyLocalArtifacts, resolveLocalRoot } from "../../internal-urls";
import {
	consumeLoopLimitIteration,
	createLoopLimitRuntime,
	isLoopLimitExhausted,
	parseLoopArgs,
	type ParsedLoopArgs,
} from "../../modes/loop-limit";
import { evaluateLoopCondition } from "../../modes/loop-condition";
import { isLoopGoalComplete, renderLoopGoalPrompt } from "../../modes/loop-goal";
import { cfgDisplayMode, cfgLoopConditionTimeoutMs, cfgLoopMode } from "../../modes/settings";
import type { SubmittedUserInput } from "../../modes/types";
import { RpcGoalController } from "../../modes/rpc/rpc-goal";
import { RpcLiveBridge, type RpcLiveStartResult } from "../../modes/rpc/rpc-live";
import { resolveApprovedPlan } from "../../plan-mode/approved-plan";
import { listPlanFiles, readPlanFile, resolvePlanFilePath } from "../../plan-mode/plan-files";
import { dispatchApprovedPlan } from "../../plan-mode/session-approval";
import { cfgPlanEnabled, shouldEnterPlanModeOnStartup } from "../../plan-mode/settings";
import { resolvePlanModelTransition } from "../../plan-mode/model-transition";
import guidedGoalInterviewPrompt from "../../prompts/goals/guided-goal-interview.md" with { type: "text" };
import planModeCompactInstructionsPrompt from "../../prompts/system/plan-mode-compact-instructions.md" with { type: "text" };
import type { AgentSession, AgentSessionEvent } from "../../session/agent-session";
import { cfgHideThinkingBlock } from "../../session/settings";
import type { SlashCommandResult, WebGuiSlashCommandRuntime } from "../../slash-commands/types";
import { VibeSessionRegistry, type VibeOwnerScope } from "../../vibe/runtime";
import { writeDeviceDispatch } from "../../tools/resolve";
import { isMCPToolName } from "../../tools/builtin-names";
import { nativeWebGuiCommandHost } from "./native-command-host";
import {
	nativeWebGuiInteractionOrigin,
	withNativeWebGuiInteractionScope,
	type NativeWebGuiInteractionOrigin,
} from "./native-interactions";

export type NativeWebGuiModeCommand = "plan" | "loop" | "loopgoal" | "goal" | "goal-autopilot";
export type NativeWebGuiDisplayMode = SettingValueOf<typeof cfgDisplayMode>;
export type NativeWebGuiInteractiveModeCommand =
	| "settings"
	| "display"
	| "plan-review"
	| "vibe"
	| "guided-goal"
	| "queue"
	| "live"
	| "record"
	| "pause";
export interface NativeWebGuiModeController {
	ready(): Promise<void>;
	runModeCommand(mode: NativeWebGuiModeCommand, args: string): Promise<SlashCommandResult>;
	transformLoopPrompt(text: string): string | false;
	runNativeModeCommand(
		command: NativeWebGuiInteractiveModeCommand,
		args: string,
		input?: Pick<SubmittedUserInput, "images" | "imageLinks">,
	): Promise<SlashCommandResult>;
	stop(): Promise<void>;
	dispose(): Promise<void>;
}

export interface NativeWebGuiMediaState {
	kind: "record" | "live";
	mediaId: string;
	state: "stopped" | "error";
	downloadStarted?: boolean;
	fileName?: string;
	error?: string;
}

interface NativeWebGuiMediaOwner {
	report(origin: NativeWebGuiInteractionOrigin, event: NativeWebGuiMediaState): Promise<void>;
	disconnect(connectionId: string): Promise<void>;
	resumeInput(): void;
}

const mediaOwners = new Map<AgentSession, NativeWebGuiMediaOwner>();
const inputOrigins = new WeakMap<
	AgentSession,
	{ generation: number; entries: Map<string, { origin: NativeWebGuiInteractionOrigin }> }
>();

export function registerNativeWebGuiInputOrigin(
	session: AgentSession,
	inputId: string,
	origin: NativeWebGuiInteractionOrigin,
): () => void {
	mediaOwners.get(session)?.resumeInput();
	let scope = inputOrigins.get(session);
	if (!scope || scope.generation !== session.sessionGeneration) {
		scope = { generation: session.sessionGeneration, entries: new Map() };
		inputOrigins.set(session, scope);
	}
	const entry = { origin };
	const previous = scope.entries.get(inputId);
	scope.entries.set(inputId, entry);
	return () => {
		if (inputOrigins.get(session) !== scope || scope.entries.get(inputId) !== entry) return;
		if (previous) scope.entries.set(inputId, previous);
		else scope.entries.delete(inputId);
	};
}

export function forgetNativeWebGuiInputOrigin(session: AgentSession, inputId: string): void {
	inputOrigins.get(session)?.entries.delete(inputId);
}

function consumeInputOrigin(
	session: AgentSession,
	inputId: string | undefined,
): NativeWebGuiInteractionOrigin | undefined {
	const scope = inputOrigins.get(session);
	if (!scope || scope.generation !== session.sessionGeneration || !inputId) return undefined;
	const entry = scope.entries.get(inputId);
	scope.entries.delete(inputId);
	return entry?.origin;
}

export async function reportNativeWebGuiMediaState(
	session: AgentSession,
	origin: NativeWebGuiInteractionOrigin,
	event: NativeWebGuiMediaState,
): Promise<void> {
	const owner = mediaOwners.get(session);
	if (!owner || session.isDisposed) throw new Error("Native browser media owner no longer exists");
	await owner.report(origin, event);
}

/** Socket loss releases only its media; normal native agent work remains resident. */
export async function disconnectNativeWebGuiMedia(connectionId: string): Promise<void> {
	const results = await Promise.allSettled([...mediaOwners.values()].map(owner => owner.disconnect(connectionId)));
	const failures = results.flatMap(result => (result.status === "rejected" ? [result.reason] : []));
	if (failures.length) throw new AggregateError(failures, "Native browser media disconnect cleanup failed");
}

/** Registry-driven native settings dialogs; settings stay on their real session scope. */
export async function showNativeWebGuiSettings(
	session: AgentSession,
	ui: ExtensionUIContext,
	output: (text: string) => Promise<void> | void,
	filter?: (id: string) => boolean,
	applyDisplay?: (mode: NativeWebGuiDisplayMode, hideThinking?: boolean) => Promise<void>,
): Promise<void> {
	const settings = allSettings().filter(setting => setting.ui && (!filter || filter(setting.id)));
	const tabs = [...new Set(settings.map(setting => setting.ui!.tab))];
	const tab = await ui.select("Settings", tabs);
	if (!tab) return;
	for (;;) {
		const entries = settings.filter(setting => setting.ui!.tab === tab);
		const labels = entries.map(
			setting =>
				`${setting.ui!.label} · ${setting.isCredential || ("secret" in setting.ui! && setting.ui!.secret) ? "••••" : JSON.stringify(setting.get(session.settings))} (${setting.id})`,
		);
		const selected = await ui.select(`Settings · ${tab}`, labels);
		if (!selected) return;
		const setting = entries[labels.indexOf(selected)];
		if (!setting) throw new Error("Setting selection expired");
		const metadata = setting.ui!;
		let text: string | undefined;
		if (setting.type === "boolean") text = await ui.select(metadata.label, ["true", "false"]);
		else if (setting.definition.type === "enum")
			text = await ui.select(metadata.label, [...setting.definition.values]);
		else if (setting.type === "array" && metadata.ordered)
			text = await ui.input(`${metadata.label}\nOrdered JSON array`, JSON.stringify(setting.get(session.settings)));
		else if (setting.type === "array" && Array.isArray(metadata.options)) {
			const options = metadata.options;
			const current = setting.get(session.settings);
			const values = Array.isArray(current) ? current : [];
			const labels = options.map(option => `${values.includes(option.value) ? "Selected: " : ""}${option.label}`);
			const choice = await ui.select(metadata.label, labels);
			if (choice !== undefined) {
				const value = options[labels.indexOf(choice)]?.value;
				if (value !== undefined) setting.setMember(session.settings, value, { member: !values.includes(value) });
				await session.settings.flush();
			}
			continue;
		} else if (Array.isArray(metadata.options)) {
			const choices = metadata.options;
			const labels = choices.map(option => option.label);
			const choice = await ui.select(metadata.label, labels);
			if (choice !== undefined) text = String(choices[labels.indexOf(choice)]?.value ?? "");
		} else
			text = await ui.input(
				`${metadata.label}\n${metadata.description}`,
				setting.isCredential ? undefined : JSON.stringify(setting.get(session.settings)),
				{ secret: setting.isCredential },
			);
		if (text === undefined) continue;
		const value = setting.parse(text);
		if (setting.id === "display.mode" && (value === "clean" || value === "compact" || value === "detailed")) {
			if (!applyDisplay) throw new Error("Display settings require their owning browser controller");
			await applyDisplay(value);
		} else if (setting.id === "hideThinkingBlock" && typeof value === "boolean") {
			if (!applyDisplay) throw new Error("Display settings require their owning browser controller");
			await applyDisplay(cfgDisplayMode.get(session.settings), value);
		} else setting.set(session.settings, value);
		await session.settings.flush();
		await output(
			`${metadata.label} updated${setting.provenance(session.settings) === "global" ? "." : `; effective source: ${setting.provenance(session.settings)}.`}`,
		);
	}
}

/** Provider setup shares the existing OAuth handler and credential store. */
export async function showNativeWebGuiProviderSetup(
	runtime: WebGuiSlashCommandRuntime,
	login: (
		command: { name: string; args: string; text: string },
		runtime: WebGuiSlashCommandRuntime,
	) => Promise<SlashCommandResult>,
): Promise<SlashCommandResult> {
	const choice = await runtime.ui.select("Provider setup", [
		"Sign in with OAuth",
		"Add API key",
		"Web search providers",
		"Provider settings",
		"Select model",
	]);
	if (choice === "Sign in with OAuth") {
		return login({ name: "login", args: "", text: "/login" }, runtime);
	}
	if (choice === "Add API key") {
		const providers = [...new Set(runtime.session.modelRegistry.getAll().map(model => model.provider))].sort();
		const provider = await runtime.ui.select("Provider", providers);
		if (!provider) return { consumed: true };
		const key = await runtime.ui.input(`API key for ${provider}`, undefined, { secret: true });
		if (!key?.trim()) return { consumed: true };
		await runtime.session.modelRegistry.authStorage.credentials.upsert(provider, {
			type: "api_key",
			key: key.trim(),
			source: "login",
		});
		await runtime.session.modelRegistry.refreshProvider(provider, "online");
		await runtime.refreshCommands();
		await runtime.output(`API key saved for ${provider}.`);
	}
	if (choice === "Web search providers")
		await showNativeWebGuiSettings(runtime.session, runtime.ui, runtime.output, id =>
			/search|brave|exa|perplexity|tavily|serper|firecrawl/i.test(id),
		);
	if (choice === "Provider settings")
		await showNativeWebGuiSettings(runtime.session, runtime.ui, runtime.output, id => id.startsWith("providers."));
	if (choice === "Select model") {
		const models = runtime.session.modelRegistry.getAvailable();
		const labels = models.map(model => `${model.provider}/${model.id}`);
		const selected = await runtime.ui.select("Select model", labels);
		if (selected) {
			const model = models[labels.indexOf(selected)];
			if (!model) throw new Error("Model selection expired");
			const result = await runtime.session.setModel(model);
			if (!result.switched) return { consumed: true };
			await runtime.output(`Model set to ${formatModelString(model)}.`);
		}
	}
	return { consumed: true };
}

/** Host-independent operations over the real native session, never a hidden terminal. */
export function createNativeWebGuiModeController(
	session: AgentSession,
	ui: ExtensionUIContext,
	output: (text: string) => Promise<void> | void,
): NativeWebGuiModeController {
	let disposed = false;
	let stopped = false;
	let lifecycleGeneration = 0;
	const initialMode = session.sessionManager.buildSessionContext();
	let loop:
		| {
				args: ParsedLoopArgs;
				limit: LoopLimitRuntime | undefined;
				goalMode: boolean;
				prompt?: string;
				generation: number;
				timer?: Timer;
				condition?: AbortController;
		  }
		| undefined;
	let loopOrigin: NativeWebGuiInteractionOrigin | undefined;
	let planPrevious:
		| {
				enabled: string[];
				mounted: string[];
				registered: string[];
				model?: Model;
				thinkingLevel?: ConfiguredThinkingLevel;
		  }
		| undefined;
	let planPaused = session.sessionManager.buildSessionContext().mode === "plan_paused";
	let planOrigin: NativeWebGuiInteractionOrigin | undefined;
	let planModelEpoch = 0;
	let vibePrevious: string[] | undefined;
	let vibeScope: VibeOwnerScope | undefined;
	let releaseInterview: (() => Promise<void>) | undefined;
	let recording = false;
	let recordingId: string | undefined;
	let recordingOrigin: NativeWebGuiInteractionOrigin | undefined;
	let liveOrigin: NativeWebGuiInteractionOrigin | undefined;
	let reviewTask: Promise<void> | undefined;
	let voiceSessionId: string | undefined;
	let dialogs = new AbortController();
	let displayPrevious:
		| { mode: NativeWebGuiDisplayMode; modeRuntime: boolean; thinking: boolean; thinkingRuntime: boolean }
		| undefined;
	let suppressLiveTerminalCleanup = false;
	const goals = new RpcGoalController(session, undefined, "interactive");
	const goalReady = goals.reconcile({ preserveActiveGoal: session.getGoalModeState()?.enabled === true });
	const live = new RpcLiveBridge(session, frame => {
		if (frame.type === "live_transcript") session.emitNotice("info", frame.text, "webgui-live");
		else if (frame.type === "live_end") {
			if (frame.error) session.emitNotice("error", frame.error, "webgui-live");
			if (!suppressLiveTerminalCleanup && liveOrigin)
				void stopBrowserLive().catch(error => session.emitNotice("error", String(error), "webgui-live"));
		}
	});
	const localOptions = () => ({
		getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
		getSessionId: () => session.sessionManager.getSessionId(),
	});
	const planOptions = () => ({ localProtocolOptions: localOptions(), cwd: session.sessionManager.getCwd() });
	const assertLive = () => {
		if (disposed || stopped || session.isDisposed) throw new Error("Native mode host has stopped");
	};
	const resumeInput = () => {
		if (!disposed && !session.isDisposed && stopped) {
			stopped = false;
			dialogs = new AbortController();
		}
	};
	const consumed = (): SlashCommandResult => ({ consumed: true });
	const scoped = async <T>(origin: NativeWebGuiInteractionOrigin | undefined, task: () => Promise<T>): Promise<T> => {
		if (!origin) throw new Error("Browser operation has no owning page");
		return withNativeWebGuiInteractionScope(origin, task);
	};
	async function stopBrowserLive(): Promise<void> {
		const origin = liveOrigin;
		const id = voiceSessionId;
		if (!origin) return;
		await scoped(origin, () =>
			nativeWebGuiCommandHost(session).browserAction({ action: "liveStop", voiceSessionId: id }, { timeout: 15000 }),
		);
		if (liveOrigin === origin && voiceSessionId === id) {
			liveOrigin = undefined;
			voiceSessionId = undefined;
		}
	}
	async function stopBrowserRecording(): Promise<void> {
		const origin = recordingOrigin;
		if (!origin) return;
		const started = recording;
		const id = recordingId;
		const result = await scoped(origin, () =>
			nativeWebGuiCommandHost(session).browserAction({ action: "recordStop", recordingId: id }, { timeout: 15000 }),
		);
		if (result.recording !== false || (started && result.downloadStarted !== true))
			throw new Error("Browser recording has not stopped and downloaded");
		if (recordingOrigin === origin && recordingId === id) {
			recording = false;
			recordingOrigin = undefined;
			recordingId = undefined;
		}
	}
	async function reportMediaState(
		origin: NativeWebGuiInteractionOrigin,
		event: NativeWebGuiMediaState,
	): Promise<void> {
		const expected = event.kind === "record" ? recordingOrigin : liveOrigin;
		const token = event.kind === "record" ? recordingId : voiceSessionId;
		if (
			!expected ||
			origin.connectionId !== expected.connectionId ||
			origin.clientId !== expected.clientId ||
			token !== event.mediaId
		)
			throw new Error("Browser media report is stale or belongs to another connection");
		if (event.kind === "record") {
			recording = false;
			recordingOrigin = undefined;
			recordingId = undefined;
			await output(
				event.state === "error"
					? `Browser recording stopped with an error: ${event.error ?? "capture/export failed"}`
					: event.downloadStarted
						? `Browser recording downloaded: ${event.fileName ?? "recording.webm"}.`
						: "Browser recording stopped; no recording download was confirmed.",
			);
		} else {
			suppressLiveTerminalCleanup = true;
			try {
				await live.stop();
			} finally {
				suppressLiveTerminalCleanup = false;
			}
			if (voiceSessionId === event.mediaId) {
				liveOrigin = undefined;
				voiceSessionId = undefined;
			}
			await output(
				event.state === "error"
					? `Live voice stopped: ${event.error ?? "browser microphone/connection failed"}`
					: "Live voice stopped.",
			);
		}
	}
	async function disconnectMedia(connectionId: string): Promise<void> {
		if (liveOrigin?.connectionId === connectionId) {
			suppressLiveTerminalCleanup = true;
			try {
				await live.stop();
				liveOrigin = undefined;
				voiceSessionId = undefined;
			} finally {
				suppressLiveTerminalCleanup = false;
			}
			session.emitNotice(
				"info",
				"Live voice stopped because its browser connection closed; native agent work continues.",
				"webgui-live",
			);
		}
		if (recordingOrigin?.connectionId === connectionId) {
			recording = false;
			recordingOrigin = undefined;
			recordingId = undefined;
			session.emitNotice(
				"warning",
				"Recording browser disconnected. Capture belongs to that page; no download result was confirmed.",
				"webgui-record",
			);
		}
	}
	async function applyDisplay(mode: NativeWebGuiDisplayMode, hideThinking = mode === "clean"): Promise<void> {
		displayPrevious ??= {
			mode: cfgDisplayMode.get(session.settings),
			modeRuntime: cfgDisplayMode.provenance(session.settings) === "runtime",
			thinking: cfgHideThinkingBlock.get(session.settings),
			thinkingRuntime: cfgHideThinkingBlock.provenance(session.settings) === "runtime",
		};
		await nativeWebGuiCommandHost(session).browserAction({ action: "setDisplayMode", mode, hideThinking });
		cfgDisplayMode.override(session.settings, mode);
		cfgHideThinkingBlock.override(session.settings, hideThinking);
	}
	const stopLoop = (pause = false) => {
		if (!loop) return;
		clearTimeout(loop.timer);
		loop.condition?.abort();
		loop.generation++;
		if (pause) {
			loop.prompt = undefined;
			loop.timer = undefined;
		} else loop = undefined;
	};
	function transformLoopPrompt(text: string): string | false {
		return loop?.goalMode ? renderLoopGoalPrompt(text) : false;
	}
	const submitSynthetic = async (text: string, images?: SubmittedUserInput["images"]) => {
		assertLive();
		if (session.isStreaming) {
			await session.followUp(text, images, { synthetic: true });
			return;
		}
		try {
			await session.prompt(text, { synthetic: true, images });
		} catch (error) {
			if (!(error instanceof AgentBusyError)) throw error;
			if (stopped || disposed) return;
			await session.followUp(text, images, { synthetic: true });
		}
	};
	const scheduleLoop = () => {
		const current = loop;
		if (!current?.prompt || stopped || disposed || current.timer) return;
		const generation = current.generation;
		current.timer = setTimeout(() => {
			current.timer = undefined;
			void (async () => {
				await session.waitForIdle();
				if (loop !== current || generation !== current.generation || stopped || disposed) return;
				if (isLoopLimitExhausted(current.limit)) {
					stopLoop();
					await output("Loop limit reached.");
					return;
				}
				if (current.args.condition) {
					const condition = new AbortController();
					current.condition = condition;
					const verdict = await evaluateLoopCondition(current.args.condition, {
						cwd: session.sessionManager.getCwd(),
						timeoutMs: cfgLoopConditionTimeoutMs.get(session.settings),
						sessionId: session.sessionManager.getSessionId(),
						signal: condition.signal,
					});
					if (loop !== current || generation !== current.generation || stopped || disposed) return;
					if (verdict.kind !== "continue") {
						stopLoop();
						if ("message" in verdict) await output(verdict.message);
						return;
					}
				}
				if (session.isStreaming || session.isCompacting || session.hasPostPromptWork) {
					scheduleLoop();
					return;
				}
				const action = cfgLoopMode.get(session.settings);
				if (action === "reset" && session.getVibeModeState()?.enabled) {
					stopLoop();
					await output("Exit vibe mode before using reset loops. Loop mode disabled.");
					return;
				}
				if (!consumeLoopLimitIteration(current.limit)) {
					stopLoop();
					return;
				}
				if (action === "compact") await session.compact(undefined, { suppressContinuation: true });
				else if (action === "reset")
					await scoped(loopOrigin, () => nativeWebGuiCommandHost(session).resetContext());
				if (loop !== current || generation !== current.generation || stopped || disposed) return;
				const inputId = crypto.randomUUID();
				const rollbackOrigin = loopOrigin
					? registerNativeWebGuiInputOrigin(session, inputId, loopOrigin)
					: undefined;
				try {
					await session.prompt(current.prompt!, { inputId, inputClientId: loopOrigin?.clientId });
				} catch (error) {
					rollbackOrigin?.();
					throw error;
				}
			})().catch(error => {
				stopLoop();
				session.emitNotice("error", String(error), "webgui-loop");
			});
		}, current.args.intervalMs ?? 1000);
	};
	const observe = (event: AgentSessionEvent) => {
		if (event.type === "message_start" && event.message.role === "user" && !event.message.synthetic) {
			const inputId =
				"inputId" in event.message && typeof event.message.inputId === "string" ? event.message.inputId : undefined;
			const origin = consumeInputOrigin(session, inputId) ?? nativeWebGuiInteractionOrigin();
			if (origin) {
				planOrigin = origin;
				if (loop) loopOrigin = origin;
			}
		}
		if (event.type === "tool_execution_end" && !event.isError && session.getPlanModeState()?.enabled) {
			const dispatch = writeDeviceDispatch(event.toolName, event.result);
			const details =
				dispatch?.tool === PROPOSE_DEVICE_NAME && dispatch.mode === "execute" ? dispatch.inner : undefined;
			if (details && typeof details === "object" && "title" in details && typeof details.title === "string") {
				const title = details.title;
				void scoped(planOrigin, () => planReview(title)).catch(error =>
					session.emitNotice("error", String(error), "webgui-plan"),
				);
			}
		}
		goals.observe(event);
		if (event.type === "goal_updated" && event.state?.enabled) releaseInterview = undefined;
		if (event.type === "message_start" && event.message.role === "user" && !event.message.synthetic && loop) {
			const text =
				typeof event.message.content === "string"
					? event.message.content
					: event.message.content
							.filter(part => part.type === "text")
							.map(part => part.text)
							.join("\n");
			loop.prompt = text;
			clearTimeout(loop.timer);
			loop.timer = undefined;
			loop.condition?.abort();
			loop.generation++;
		}
		if (event.type === "agent_end") {
			if (loop?.goalMode && event.isTerminal !== false && isLoopGoalComplete(event.messages)) {
				stopLoop();
				return;
			}
			if (
				event.messages.some(
					message =>
						message.role === "assistant" && (message.stopReason === "aborted" || message.stopReason === "error"),
				)
			) {
				if (loop) {
					clearTimeout(loop.timer);
					loop.condition?.abort();
					loop.prompt = undefined;
					loop.generation++;
				}
			} else scheduleLoop();
		}
	};
	const unsubscribe = session.subscribe(observe);
	async function reconcilePlanRole(): Promise<void> {
		if (!session.getPlanModeState()?.enabled || !planPrevious || disposed || stopped) return;
		const epoch = ++planModelEpoch;
		const resolved = resolveModelRoleValue(
			session.settings.getModelRole("plan"),
			session.modelRegistry.getAvailable(),
			{ settings: session.settings },
		);
		const transition = resolvePlanModelTransition(session.model, resolved, session.isStreaming);
		if (transition.kind === "thinking") session.setThinkingLevel(transition.thinkingLevel);
		else if (transition.kind === "apply") {
			const apply = async () => {
				await session.waitForIdle();
				if (epoch === planModelEpoch && session.getPlanModeState()?.enabled && !stopped && !disposed)
					await session.setModelTemporary(transition.model, transition.thinkingLevel);
			};
			if (transition.deferred)
				void apply().catch(error => session.emitNotice("error", String(error), "webgui-plan"));
			else await session.setModelTemporary(transition.model, transition.thinkingLevel);
		}
	}
	const unsubscribePlanRole = cfgModelRoles.listen(session.settings, () => {
		void reconcilePlanRole().catch(error => session.emitNotice("error", String(error), "webgui-plan"));
	});

	async function exitPlan(paused: boolean): Promise<void> {
		const state = session.getPlanModeState();
		if (!state?.enabled) {
			planPaused = false;
			session.sessionManager.appendModeChange("none");
			return;
		}
		planModelEpoch++;
		const activePresentation = {
			enabled: session.getEnabledToolNames(),
			mounted: session.getMountedXdevToolNames(),
			model: session.model,
			thinking: session.configuredThinkingLevel(),
		};
		await session.runModeExitTeardown(async () => {
			if (session.isStreaming) await session.abort();
			session.setPlanModeState(undefined);
			try {
				if (planPrevious) {
					await session.restoreNonMCPToolPresentation(
						planPrevious.enabled,
						planPrevious.mounted,
						planPrevious.registered,
					);
					if (planPrevious.model) await session.setModelTemporary(planPrevious.model, planPrevious.thinkingLevel);
				}
			} catch (error) {
				session.setPlanModeState(state);
				try {
					await session.setActiveToolPresentation(activePresentation.enabled, activePresentation.mounted);
					if (activePresentation.model)
						await session.setModelTemporary(activePresentation.model, activePresentation.thinking);
				} catch (rollback) {
					throw new AggregateError(
						[error, rollback],
						"Plan mode exit failed and could not restore its original state",
					);
				}
				throw error;
			}
			session.setPlanProposalHandler(null);
			session.sessionManager.appendModeChange(paused ? "plan_paused" : "none");
			planPaused = paused;
			planPrevious = undefined;
		});
	}
	function planReview(title?: string): Promise<void> {
		if (reviewTask) return reviewTask;
		const task = reviewPlan(title);
		reviewTask = task;
		const release = () => {
			if (reviewTask === task) reviewTask = undefined;
		};
		void task.then(release, release);
		return task;
	}
	async function reviewPlan(title?: string): Promise<void> {
		const signal = dialogs.signal;
		signal.throwIfAborted();
		const state = session.getPlanModeState();
		if (!state?.enabled) throw new Error("Plan mode is not active.");
		if (session.isStreaming) await session.abort();
		const resolved = await resolveApprovedPlan({
			suppliedTitle: title,
			statePlanFilePath: state.planFilePath,
			readPlan: url => readPlanFile(url, planOptions()),
			listPlanFiles: () => listPlanFiles({ localProtocolOptions: localOptions() }),
		});
		const choice = await ui.select(
			`Plan review: ${resolved.title}\n\n${resolved.planContent}`,
			[
				"Approve and clear context",
				"Approve and compact context",
				"Approve and keep context",
				"Edit plan",
				"Request refinement",
				"Keep planning",
			],
			{ signal },
		);
		if (choice === "Edit plan") {
			const edited = await ui.editor("Edit plan", resolved.planContent, { signal });
			signal.throwIfAborted();
			if (edited !== undefined) await Bun.write(resolvePlanFilePath(resolved.planFilePath, planOptions()), edited);
			return reviewPlan(resolved.title);
		}
		if (choice === "Request refinement") {
			const feedback = await ui.input("Plan refinement feedback", undefined, { signal });
			signal.throwIfAborted();
			if (feedback?.trim())
				void session.prompt(feedback).catch(error => session.emitNotice("error", String(error), "webgui-plan"));
			return;
		}
		if (!choice?.startsWith("Approve and ")) return;
		const available = session.modelRegistry.getAvailable();
		const labels = available.map(model => `${model.provider}/${model.id}`);
		const selected = await ui.select("Execution model", ["Restore previous model", ...labels], { signal });
		if (!selected) return;
		const executionModel = selected === "Restore previous model" ? undefined : available[labels.indexOf(selected)];
		signal.throwIfAborted();
		await exitPlan(false);
		if (choice === "Approve and clear context") {
			const oldRoot = resolveLocalRoot(localOptions());
			await nativeWebGuiCommandHost(session).resetContext();
			signal.throwIfAborted();
			await copyLocalArtifacts(oldRoot, resolveLocalRoot(localOptions()));
			await Bun.write(resolvePlanFilePath(resolved.planFilePath, planOptions()), resolved.planContent);
		} else if (choice === "Approve and compact context") {
			session.setPlanReferencePath(resolved.planFilePath);
			await session.compact(undefined, {
				suppressContinuation: true,
				internalGuidance: prompt.render(planModeCompactInstructionsPrompt, { planFilePath: resolved.planFilePath }),
			});
		}
		signal.throwIfAborted();
		if (executionModel)
			await session.setModelTemporary(executionModel, session.resolveTemporaryModelThinkingLevel(executionModel));
		void dispatchApprovedPlan(session, {
			...resolved,
			preserveContext: choice !== "Approve and clear context",
			signal,
		}).catch(error => session.emitNotice("error", String(error), "webgui-plan"));
	}
	async function plan(args: string, restore?: { planFilePath?: string }): Promise<SlashCommandResult> {
		planOrigin = nativeWebGuiInteractionOrigin();
		if (session.getGoalModeState()?.goal || session.getVibeModeState()?.enabled)
			throw new Error("Exit goal/vibe mode first.");
		if (session.getPlanModeState()?.enabled) {
			const content = await readPlanFile(session.getPlanModeState()!.planFilePath, planOptions());
			if (
				content?.trim() &&
				!(await ui.confirm("Exit plan mode?", "This exits plan mode without approving a plan.", {
					signal: dialogs.signal,
				}))
			)
				return consumed();
			await exitPlan(true);
			await output("Plan mode paused.");
			return consumed();
		}
		if (planPaused && !args.trim()) {
			planPaused = false;
			session.sessionManager.appendModeChange("none");
			await output("Plan mode disabled.");
			return consumed();
		}
		if (!cfgPlanEnabled.get(session.settings)) throw new Error("Plan mode is disabled (plan.enabled).");
		const currentTools = session.getEnabledToolNames();
		const previous = {
			enabled: currentTools.filter(name => !isMCPToolName(name)),
			mounted: session.getMountedXdevToolNames().filter(name => !isMCPToolName(name)),
			registered: session.getAllToolNames(),
			model: session.model,
			thinkingLevel: session.configuredThinkingLevel(),
		};
		const tools = currentTools.filter(name => name !== "write");
		if (session.hasBuiltInTool("write")) tools.push("write");
		const path = restore?.planFilePath ?? "local://PLAN.md";
		session.setPlanModeState({ enabled: true, planFilePath: path, workflow: "parallel", reentry: planPaused });
		try {
			await session.setActiveToolsByName(tools);
		} catch (error) {
			session.setPlanModeState(undefined);
			throw error;
		}
		planPrevious = previous;
		planPaused = false;
		session.setPlanProposalHandler(title => session.preparePlanForReview(title));
		session.sessionManager.appendModeChange("plan", { planFilePath: path });
		if (!restore) await reconcilePlanRole();
		if (session.isStreaming) await session.sendPlanModeContext({ deliverAs: "steer" });
		await output(`Plan mode enabled. Plan file: ${path}`);
		return args.trim() ? { prompt: args.trim() } : consumed();
	}
	async function goal(args: string, autoOrchestrate: boolean): Promise<SlashCommandResult> {
		await goalReady;
		await goals.settled();
		if (!cfgGoalEnabled.get(session.settings)) throw new Error("Goal mode is disabled (goal.enabled).");
		if (session.getPlanModeState()?.enabled || planPaused || session.getVibeModeState()?.enabled)
			throw new Error("Exit plan/vibe mode first.");
		const [initialVerb = "", ...words] = args.trim().split(/\s+/);
		let verb = initialVerb;
		let rest = words.join(" ");
		const current = session.getGoalModeState();
		if (!verb && current?.goal) {
			const choice = await ui.select(
				`Goal: ${current.goal.objective} (${current.goal.status})`,
				current.enabled ? ["Show details", "Adjust budget", "Pause", "Drop"] : ["Resume", "Show details", "Drop"],
				{ signal: dialogs.signal },
			);
			verb =
				(
					{
						"Show details": "show",
						"Adjust budget": "budget",
						Pause: "pause",
						Resume: "resume",
						Drop: "drop",
					} as Record<string, string>
				)[choice ?? ""] ?? "";
			if (!verb) return consumed();
		}
		if (verb === "show") {
			await output(current?.goal ? JSON.stringify(current.goal, null, 2) : "No goal set.");
			return consumed();
		}
		if (verb === "pause") {
			if (!current?.enabled) throw new Error("No active goal to pause.");
			await goals.handle({ op: "pause" });
			await output("Goal mode paused.");
			return consumed();
		}
		if (verb === "resume") {
			await goals.handle({ op: "resume" });
			await output("Goal mode resumed.");
			return consumed();
		}
		if (verb === "drop") {
			if (!current?.goal) throw new Error("No goal to drop.");
			if (
				await ui.confirm(
					"Drop goal?",
					"This removes the goal record. Accumulated usage stays in the session log.",
					{ signal: dialogs.signal },
				)
			) {
				await goals.handle({ op: "drop" });
				await output("Goal dropped.");
			}
			return consumed();
		}
		if (verb === "budget") {
			if (!current?.enabled) throw new Error("Resume the goal before adjusting the budget.");
			rest ||=
				(await ui.input("Goal budget (positive integer or off)", current.goal.tokenBudget?.toString(), {
					signal: dialogs.signal,
				})) ?? "";
			if (!rest) return consumed();
			if (rest !== "off" && !/^[1-9]\d*$/.test(rest))
				throw new Error("Goal budget must be a positive integer or off.");
			await session.goalRuntime.onBudgetMutated(rest === "off" ? undefined : Number(rest));
			goals.notifyHostAction();
			await output(rest === "off" ? "Goal budget cleared." : `Goal budget set to ${rest}.`);
			return consumed();
		}
		let objective = verb === "set" ? rest : args.trim();
		objective ||= (await ui.editor("Goal objective", undefined, { signal: dialogs.signal }))?.trim() ?? "";
		if (!objective) return consumed();
		if (current?.goal) {
			if (verb !== "set")
				throw new Error("A goal already exists. Use /goal to manage it or /goal set to replace it.");
			if (!current.enabled)
				throw new Error("Resume the current goal first, or drop it before setting a new objective.");
			await session.goalRuntime.replaceGoal({ objective, autoOrchestrate });
		} else {
			await session.goalRuntime.createGoal({ objective, autoOrchestrate });
			await session.setActiveToolsByName([...new Set([...session.getEnabledToolNames(), "goal"])]);
		}
		const state = session.getGoalModeState();
		if (session.isStreaming) await session.sendGoalModeContext({ deliverAs: "steer" });
		await output("Goal mode enabled.");
		return { prompt: objective, ...(state?.autoOrchestrate ? { goalAutoOrchestrateInitialId: state.goal.id } : {}) };
	}
	const vibeParent = () => ({
		getAgentId: () => session.getAgentId() ?? null,
		getSessionId: () => session.sessionManager.getSessionId(),
		getSessionFile: () => session.sessionManager.getSessionFile() ?? null,
		sessionManager: session.sessionManager,
		asyncJobManager: session.asyncJobManager,
		settings: session.settings,
		getActiveModelString: () => (session.model ? formatModelString(session.model) : undefined),
	});
	async function vibe(args: string): Promise<SlashCommandResult> {
		if (session.getVibeModeState()?.enabled) {
			await session.runModeExitTeardown(async () => {
				if (session.isStreaming) await session.abort();
				await VibeSessionRegistry.global().killAll(vibeParent(), vibeScope);
				await session.deactivateVibeTools(vibePrevious ?? []);
				session.setVibeModeState(undefined);
			});
			vibePrevious = undefined;
			vibeScope = undefined;
			await output("Vibe mode disabled.");
			return consumed();
		}
		if (session.getPlanModeState()?.enabled || planPaused || session.getGoalModeState()?.goal)
			throw new Error("Exit plan/goal mode first.");
		const registry = VibeSessionRegistry.global();
		vibeScope = registry.ownerScope(vibeParent());
		registry.activateScope(vibeScope);
		vibePrevious = session.getEnabledToolNames();
		await session.activateVibeTools(session.hasBuiltInTool("todo") ? ["read", "todo"] : ["read"]);
		session.setVibeModeState({ enabled: true });
		session.sessionManager.appendModeChange("vibe", { previousTools: vibePrevious });
		if (session.isStreaming) await session.sendVibeModeContext({ deliverAs: "steer" });
		await output("Vibe mode enabled. Real fast/good worker sessions are available.");
		return args.trim() ? { prompt: args.trim() } : consumed();
	}
	async function runModeCommand(mode: NativeWebGuiModeCommand, args: string): Promise<SlashCommandResult> {
		resumeInput();
		await readyTask;
		assertLive();
		if (mode === "plan") return plan(args);
		if (mode === "goal" || mode === "goal-autopilot") return goal(args, mode === "goal-autopilot");
		if (loop) {
			stopLoop();
			await output("Loop mode disabled.");
			return consumed();
		}
		const parsed = parseLoopArgs(args);
		if (typeof parsed === "string") throw new Error(parsed);
		const goalMode = mode === "loopgoal";
		loop = {
			args: parsed,
			limit: createLoopLimitRuntime(parsed.limit),
			goalMode,
			prompt: parsed.prompt,
			generation: 0,
		};
		loopOrigin = nativeWebGuiInteractionOrigin();
		if (parsed.intervalMs !== undefined) consumeLoopLimitIteration(loop.limit);
		await output(
			goalMode
				? "Loopgoal mode enabled. Stop suspends repeats; /loopgoal disables it."
				: "Loop mode enabled. Stop suspends repeats; /loop disables it.",
		);
		return parsed.prompt ? { prompt: parsed.prompt } : consumed();
	}
	async function runNativeModeCommand(
		command: NativeWebGuiInteractiveModeCommand,
		args: string,
		input?: Pick<SubmittedUserInput, "images" | "imageLinks">,
	): Promise<SlashCommandResult> {
		resumeInput();
		await readyTask;
		assertLive();
		switch (command) {
			case "settings":
				await showNativeWebGuiSettings(session, ui, output, undefined, applyDisplay);
				return consumed();
			case "display": {
				const mode =
					args.trim() ||
					{ clean: "compact", compact: "detailed", detailed: "clean" }[cfgDisplayMode.get(session.settings)];
				if (mode !== "clean" && mode !== "compact" && mode !== "detailed")
					throw new Error("Usage: /display [clean|compact|detailed]");
				await applyDisplay(mode);
				await output(`Display mode: ${mode}.`);
				return consumed();
			}
			case "plan-review":
				await planReview();
				return consumed();
			case "vibe":
				return vibe(args);
			case "guided-goal": {
				await goalReady;
				if (!cfgGoalEnabled.get(session.settings)) throw new Error("Goal mode is disabled (goal.enabled).");
				if (
					session.getPlanModeState()?.enabled ||
					planPaused ||
					session.getVibeModeState()?.enabled ||
					session.getGoalModeState()?.goal
				)
					throw new Error("Exit the current plan/vibe/goal mode first.");
				const signal = dialogs.signal;
				const release = await goals.prepareInterview();
				if (signal.aborted || stopped) {
					await release();
					signal.throwIfAborted();
					throw new Error("Goal interview stopped");
				}
				releaseInterview = release;
				void submitSynthetic(
					prompt.render(guidedGoalInterviewPrompt, { initial: args.trim() || undefined }),
					input?.images,
				).catch(error => session.emitNotice("error", String(error), "webgui-guided-goal"));
				return consumed();
			}
			case "queue": {
				const messages = splitQueuedMessages(args);
				if (messages.length === 0 && !input?.images?.length) throw new Error("Usage: /queue <message>");
				const startedIdle = !session.isStreaming && session.queuedMessageCount === 0;
				const queue = messages.length ? messages : [""];
				const origin = nativeWebGuiInteractionOrigin();
				for (let index = 0; index < queue.length; index++) {
					assertLive();
					const inputId = crypto.randomUUID();
					const rollbackOrigin = origin ? registerNativeWebGuiInputOrigin(session, inputId, origin) : undefined;
					const task = session.prompt(queue[index]!, {
						inputId,
						inputClientId: origin?.clientId,
						images: index === 0 ? input?.images : undefined,
						streamingBehavior: "followUp",
						queueOnly: index > 0 || !startedIdle,
					});
					if (index === 0 && startedIdle)
						void task.catch(error => {
							rollbackOrigin?.();
							session.emitNotice("error", String(error), "webgui-queue");
						});
					else
						try {
							await task;
						} catch (error) {
							rollbackOrigin?.();
							throw error;
						}
				}
				await output(
					startedIdle ? "Sent queued message." : `Queued ${queue.length} message(s) for when the agent yields.`,
				);
				return { consumed: true, agentInvoked: startedIdle };
			}
			case "live": {
				const host = nativeWebGuiCommandHost(session);
				if (liveOrigin) {
					suppressLiveTerminalCleanup = true;
					try {
						await live.stop();
						await stopBrowserLive();
					} finally {
						suppressLiveTerminalCleanup = false;
					}
					await output("Live voice stopped.");
					return consumed();
				}
				liveOrigin = nativeWebGuiInteractionOrigin();
				const id = crypto.randomUUID();
				voiceSessionId = id;
				const generation = lifecycleGeneration;
				try {
					const offer = await host.browserAction({ action: "liveOffer", voiceSessionId: id });
					if (typeof offer.sdpOffer !== "string" || offer.voiceSessionId !== id)
						throw new Error("Browser did not supply the owning WebRTC offer");
					if (voiceSessionId !== id) throw new Error("Live voice stopped before offer acknowledgement");
					if (generation !== lifecycleGeneration || stopped) throw new Error("Live voice start cancelled");
					suppressLiveTerminalCleanup = true;
					let result: RpcLiveStartResult;
					try {
						result = await live.start({ sdpOffer: offer.sdpOffer });
					} finally {
						suppressLiveTerminalCleanup = false;
					}
					if (!result.sdpAnswer) throw new Error("Native live session returned no SDP answer");
					if (generation !== lifecycleGeneration || stopped) throw new Error("Live voice start cancelled");
					await host.browserAction({ action: "liveAnswer", sdpAnswer: result.sdpAnswer, voiceSessionId });
				} catch (error) {
					suppressLiveTerminalCleanup = true;
					try {
						await live.stop();
						await stopBrowserLive();
					} catch (cleanup) {
						throw new AggregateError(
							[error, cleanup],
							`Live voice failed: ${error instanceof Error ? error.message : String(error)}`,
						);
					} finally {
						suppressLiveTerminalCleanup = false;
					}
					throw error;
				}
				await output("Live voice connected.");
				return consumed();
			}
			case "record": {
				const host = nativeWebGuiCommandHost(session);
				if (!recordingOrigin) {
					recordingOrigin = nativeWebGuiInteractionOrigin();
					const id = crypto.randomUUID();
					recordingId = id;
					const generation = lifecycleGeneration;
					try {
						const result = await host.browserAction({ action: "recordStart", recordingId: id });
						if (result.recording !== true || result.recordingId !== id || recordingId !== id)
							throw new Error("Browser recording did not start or already ended");
						recording = true;
						if (generation !== lifecycleGeneration || stopped) {
							await stopBrowserRecording();
							throw new Error("Recording start cancelled");
						}
					} catch (error) {
						await stopBrowserRecording();
						throw error;
					}
					await output(
						"Browser screen recording started. /record stops and downloads the actual WebM capture (not an ompcast recording).",
					);
				} else {
					await stopBrowserRecording();
					await output("Browser recording stopped and downloaded as WebM.");
				}
				return consumed();
			}
			case "pause":
				return pauseSession();
		}
	}
	async function pauseSession(): Promise<SlashCommandResult> {
		const gate = session.agent.pauseGate;
		const owned = gate.pause();
		try {
			await ui.select(
				"Paused — native agents hold at their next safe boundary. In-flight calls finish; queued messages wait.",
				["Resume"],
				{ signal: dialogs.signal },
			);
		} finally {
			if (owned) gate.resume();
		}
		await output("Native agents resumed.");
		return consumed();
	}
	async function stop(): Promise<void> {
		stopped = true;
		lifecycleGeneration++;
		stopLoop(true);
		goals.stopForHostAbort();
		dialogs.abort(new Error("Native mode host stopping"));
		const failures: unknown[] = [];
		suppressLiveTerminalCleanup = true;
		for (const close of [
			async () => {
				await readyTask;
				goals.stopForHostAbort();
				if (session.getGoalModeState()?.enabled) await goals.handle({ op: "pause" });
				goals.stopForHostAbort();
				await goals.settled();
			},
			async () => {
				await live.stop();
				await stopBrowserLive();
			},
			stopBrowserRecording,
			async () => {
				if (session.getVibeModeState()?.enabled) await vibe("");
			},
			async () => {
				if (session.getPlanModeState()?.enabled) await exitPlan(true);
			},
			async () => {
				if (releaseInterview) {
					await releaseInterview();
					releaseInterview = undefined;
				}
			},
		]) {
			try {
				await close();
			} catch (error) {
				failures.push(error);
			}
		}
		suppressLiveTerminalCleanup = false;
		if (failures.length) throw new AggregateError(failures, "Native browser mode resources have not settled");
	}
	async function dispose(): Promise<void> {
		if (disposed) return;
		await stop();
		stopLoop();
		unsubscribe();
		unsubscribePlanRole();
		if (displayPrevious) {
			if (displayPrevious.modeRuntime) cfgDisplayMode.override(session.settings, displayPrevious.mode);
			else cfgDisplayMode.clearOverride(session.settings);
			if (displayPrevious.thinkingRuntime) cfgHideThinkingBlock.override(session.settings, displayPrevious.thinking);
			else cfgHideThinkingBlock.clearOverride(session.settings);
			displayPrevious = undefined;
		}
		disposed = true;
		mediaOwners.delete(session);
		inputOrigins.delete(session);
	}
	const readyTask = (async () => {
		await goalReady;
		if (disposed || stopped) return;
		if (initialMode.mode === "plan" && !session.getPlanModeState()?.enabled && cfgPlanEnabled.get(session.settings)) {
			const file = initialMode.modeData?.planFilePath;
			await plan("", { planFilePath: typeof file === "string" ? file : undefined });
		} else if (initialMode.mode === "vibe" && !session.getVibeModeState()?.enabled) {
			await VibeSessionRegistry.global().rehydrate(vibeParent());
			if (!stopped && !disposed) await vibe("");
		} else if (
			(initialMode.mode === "plan" || initialMode.mode === "plan_paused") &&
			!cfgPlanEnabled.get(session.settings)
		) {
			planPaused = false;
			session.sessionManager.appendModeChange("none");
		} else if (shouldEnterPlanModeOnStartup(session.sessionManager, session.settings)) {
			await plan("");
		}
	})();
	void readyTask.catch(error => session.emitNotice("error", String(error), "webgui-mode-restore"));
	mediaOwners.set(session, { report: reportMediaState, disconnect: disconnectMedia, resumeInput });
	return {
		ready: () => readyTask,
		runModeCommand,
		transformLoopPrompt,
		runNativeModeCommand,
		stop,
		dispose,
	};
}
