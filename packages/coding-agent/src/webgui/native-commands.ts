import type { ImageContent } from "@oh-my-pi/pi-ai";
import { reset as resetCapabilities } from "../capability";
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "../discovery/helpers";
import { getSkillSlashCommandName, parseSkillInvocation } from "../extensibility/skills";
import { buildSkillCommandPrompt, type BuiltSkillCommandPrompt } from "../modes/skill-command";
import type { AgentSession } from "../session/agent-session";
import type { SubmittedUserInput } from "../modes/types";
import { reloadNativeMcpServers } from "../modes/controllers/mcp-command-controller";
import { reconnectMcpManagerServer } from "../mcp/oauth-reauth";
import { buildAvailableSlashCommands } from "../slash-commands/available-commands";
import { executeWebGuiBuiltinSlashCommand, lookupBuiltinSlashCommand } from "../slash-commands/builtin-registry";
import { parseSlashCommand } from "../slash-commands/helpers/parse";
import type { WebGuiSlashCommandRuntime } from "../slash-commands/types";
import { refreshAgentDiscovery } from "../task";
import {
	nativeWebGuiCommandEnvironment,
	nativeWebGuiCommandHost,
	withNativeWebGuiCommandLifecycleGate,
} from "./native-command-host";
import {
	createNativeWebGuiModeController,
	showNativeWebGuiProviderSetup,
	type NativeWebGuiModeController,
} from "./native-command-modes";
import { handleWebGuiLogin } from "./native-command-session-views";
import { webGuiCollabGuest } from "./native-command-collaboration";
import {
	nativeWebGuiQuestions,
	withNativeWebGuiInteractionScope,
	withNativeWebGuiLocalDialogs,
	type NativeWebGuiInteractionOrigin,
} from "./native-interactions";

export interface NativeWebGuiCommandOptions extends NativeWebGuiInteractionOrigin {
	input?: Pick<SubmittedUserInput, "images" | "imageLinks">;
	onPromptMetadata?: (metadata: { goalAutoOrchestrateInitialId?: string }) => void;
}

interface NativeCommandOperation {
	controller: AbortController;
	settled: Promise<void>;
	background: Set<Promise<void>>;
	completed: boolean;
}

interface NativeCommandState {
	operations: Set<NativeCommandOperation>;
	background: Set<Promise<void>>;
	hostResources: Set<() => Promise<void>>;
	runNativeModeCommand: NativeWebGuiModeController["runNativeModeCommand"];
	runModeCommand: WebGuiSlashCommandRuntime["runModeCommand"];
	prepareLoopGoalPrompt: NativeWebGuiModeController["prepareLoopGoalPrompt"];
	cancelLoopGoalPrompt: NativeWebGuiModeController["cancelLoopGoalPrompt"];
	ready: () => Promise<void>;
	stopModes: () => Promise<void>;
	disposeModes: () => Promise<void>;
	output: (text: string) => Promise<void>;
	hostStop?: Promise<void>;
	hostStopPending?: boolean;
}

const commandStates = new WeakMap<AgentSession, NativeCommandState>();

function commandState(session: AgentSession): NativeCommandState {
	let state = commandStates.get(session);
	if (state) return state;
	const output = async (text: string): Promise<void> => {
		await session.appendCustomMessage(
			{ customType: "webgui-command", content: text, display: true },
			{ waitForIdle: false },
		);
	};
	const modes = createNativeWebGuiModeController(session, nativeWebGuiQuestions(session).ui, output);
	state = {
		operations: new Set(),
		background: new Set(),
		hostResources: new Set(),
		output,
		runModeCommand: modes.runModeCommand,
		runNativeModeCommand: modes.runNativeModeCommand,
		prepareLoopGoalPrompt: modes.prepareLoopGoalPrompt,
		cancelLoopGoalPrompt: modes.cancelLoopGoalPrompt,
		ready: modes.ready,
		stopModes: modes.stop,
		disposeModes: modes.dispose,
	};
	commandStates.set(session, state);
	return state;
}

/** The composer sees the same effective catalogue and skill names that native prompt expansion uses. */
export async function nativeWebGuiCommands(
	session: AgentSession,
): Promise<Array<{ name: string; description: string }>> {
	return (
		await buildAvailableSlashCommands(session, undefined, { includeTuiOnlyBuiltins: true, includeRpcBuiltins: true })
	).map(command => ({ name: command.name, description: command.description ?? "" }));
}

/** Build from this session's effective skills using the same policy-checked payload as the TUI. */
export async function buildNativeWebGuiSkillPrompt(
	session: AgentSession,
	text: string,
	streamingBehavior: "steer" | "followUp",
	images: ImageContent[],
): Promise<BuiltSkillCommandPrompt | undefined> {
	const parsed = parseSkillInvocation(text);
	if (!parsed) return undefined;
	const skillCommands = new Map(
		session.skillsSettings?.enableSkillCommands
			? session.skills.map(skill => [getSkillSlashCommandName(skill), skill] as const)
			: [],
	);
	if (!skillCommands.has(getSkillSlashCommandName({ name: parsed.name }))) {
		if (text.trimStart().startsWith("/skill:")) throw new Error(`Unknown native command: /skill:${parsed.name}`);
		return undefined;
	}
	return buildSkillCommandPrompt(
		{
			session,
			skillCommands,
		},
		text,
		streamingBehavior,
		images,
	);
}

/** Restore only an explicitly admitted browser session's native persistent mode state. */
export async function prepareNativeWebGuiCommands(session: AgentSession): Promise<void> {
	const state = commandState(session);
	if (state.hostStopPending) throw new Error("Native host resources are settling; new input is not admitted");
	state.hostStop = undefined;
	await state.ready();
}

/** true consumes a command, false leaves native prompt dispatch intact, string replaces the prompt. */
export function executeNativeWebGuiCommand(
	session: AgentSession,
	text: string,
	options?: NativeWebGuiCommandOptions,
): Promise<string | boolean> {
	const run = () =>
		withNativeWebGuiLocalDialogs(async () => {
			await prepareNativeWebGuiCommands(session);
			const result = await executeNativeCommand(session, text, options);
			if (result === true) return true;
			const state = commandState(session);
			const controller = new AbortController();
			const settled = Promise.withResolvers<void>();
			const operation: NativeCommandOperation = {
				controller,
				settled: settled.promise,
				background: new Set(),
				completed: false,
			};
			state.operations.add(operation);
			try {
				if (state.hostStop) return true;
				const prepared = await state.prepareLoopGoalPrompt(typeof result === "string" ? result : text);
				return controller.signal.aborted ? true : prepared === false ? result : prepared;
			} finally {
				operation.completed = true;
				state.operations.delete(operation);
				settled.resolve();
			}
		});
	return options ? withNativeWebGuiInteractionScope({ ...options, sessionId: session.sessionId }, run) : run();
}

async function executeNativeCommand(
	session: AgentSession,
	text: string,
	options?: NativeWebGuiCommandOptions,
): Promise<string | boolean> {
	const parsed = parseSlashCommand(text);
	if (!parsed) return false;
	if (!lookupBuiltinSlashCommand(parsed.name)) {
		const catalog = await buildAvailableSlashCommands(session, undefined, {
			includeTuiOnlyBuiltins: true,
			includeRpcBuiltins: true,
		});
		if (!catalog.some(command => command.name === parsed.name || command.aliases?.includes(parsed.name))) {
			throw new Error(`Unknown native command: /${parsed.name}`);
		}
		// Native chat builds user-attributed skill prompts; AgentSession owns other prompt expansion.
		return false;
	}
	const state = commandState(session);
	const controller = new AbortController();
	const settled = Promise.withResolvers<void>();
	const operation: NativeCommandOperation = {
		controller,
		settled: settled.promise,
		background: new Set(),
		completed: false,
	};
	state.operations.add(operation);
	const host = nativeWebGuiCommandHost(session);
	const { mcpManager } = nativeWebGuiCommandEnvironment(session);
	const leaveForLifecycle = async (action: () => Promise<void>): Promise<void> => {
		// A lifecycle command cannot wait for its own RPC command frame to finish.
		state.operations.delete(operation);
		await settleNativeWebGuiHostResources(session);
		await action();
	};
	const runtime: WebGuiSlashCommandRuntime = {
		session,
		sessionManager: session.sessionManager,
		settings: session.settings,
		cwd: session.sessionManager.getCwd(),
		sessionScopedCwd: true,
		signal: controller.signal,
		input: options?.input,
		ui: nativeWebGuiQuestions(session).ui,
		observesCustomMessages: true,
		output: state.output,
		isCollabGuest: Boolean(webGuiCollabGuest(session)),
		mcpManager,
		reconnectMcpServer: async (name, selected) => {
			const status = await reconnectMcpManagerServer(mcpManager, name, selected);
			if (status && mcpManager) await session.refreshMCPTools(mcpManager.getTools());
			return status;
		},
		host,
		registerHostShutdown: dispose => {
			state.hostResources.add(dispose);
			return () => {
				state.hostResources.delete(dispose);
			};
		},
		setModel: async model => {
			const result = await session.setModel(model);
			if (!result.switched) throw new Error("Model change cancelled.");
		},
		newSession: options => session.newSession(options),
		refreshCommands: async () => {
			await nativeWebGuiCommands(session);
		},
		reloadPlugins: async () => {
			const cwd = session.sessionManager.getCwd();
			const projectPath = await resolveActiveProjectRegistryPath(cwd);
			clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
			await refreshAgentDiscovery(cwd, session.effectiveExtensionRoots);
			await session.refreshSkillsAndCommands();
			resetCapabilities();
			if (mcpManager) {
				const reloaded = await reloadNativeMcpServers(session, mcpManager);
				for (const [name, error] of reloaded.errors) await state.output(`MCP ${name}: ${error}`);
			}
			await nativeWebGuiCommands(session);
		},
		runModeCommand: state.runModeCommand,
		runNativeModeCommand: (command, args) =>
			command === "setup"
				? showNativeWebGuiProviderSetup(runtime, handleWebGuiLogin)
				: state.runNativeModeCommand(command, args, runtime.input),
		runCommandInBackground: task => {
			const work = Promise.resolve().then(task);
			state.background.add(work);
			operation.background.add(work);
			const done = () => {
				state.background.delete(work);
				operation.background.delete(work);
				if (operation.completed && operation.background.size === 0) {
					state.operations.delete(operation);
					settled.resolve();
				}
			};
			void work.then(done, error => {
				done();
				session.emitNotice("error", error instanceof Error ? error.message : String(error), "webgui-command");
			});
		},
	};
	try {
		const result = await withNativeWebGuiCommandLifecycleGate(session, leaveForLifecycle, () =>
			executeWebGuiBuiltinSlashCommand(text, runtime),
		);
		if (controller.signal.aborted && parsed.name === "loopgoal") return true;
		if (result === false) return false;
		if (result && "prompt" in result) {
			if (result.goalAutoOrchestrateInitialId)
				options?.onPromptMetadata?.({ goalAutoOrchestrateInitialId: result.goalAutoOrchestrateInitialId });
			return result.prompt;
		}
		if (result?.failed) throw new Error(`/${parsed.name} failed; see its native command result`);
		return true;
	} finally {
		operation.completed = true;
		if (operation.background.size === 0) {
			state.operations.delete(operation);
			settled.resolve();
		}
	}
}

/** Host-owned checkpoints stay registered after failure so a later exit can settle them. */
export async function settleNativeWebGuiHostResources(session: AgentSession): Promise<void> {
	const state = commandStates.get(session);
	if (!state) return;
	for (const resource of [...state.hostResources]) await resource();
}

/** Ordinary Stop cancels pending command inputs, not persistent modes or host-owned resources. */
export async function cancelNativeWebGuiCommandInputs(session: AgentSession): Promise<void> {
	const state = commandStates.get(session);
	if (!state) {
		nativeWebGuiQuestions(session).cancelPendingInteractions();
		return;
	}
	const operations = [...state.operations];
	state.cancelLoopGoalPrompt();
	for (const operation of operations) operation.controller.abort(new Error("Native command input stopped by user"));
	nativeWebGuiQuestions(session).cancelPendingInteractions();
	await Promise.all(operations.map(operation => operation.settled));
}

/** Phase one keeps browser control acknowledgements available and never waits for command turns. */
export function beginNativeWebGuiHostStop(session: AgentSession): Promise<void> {
	const state = commandStates.get(session);
	if (state?.hostStop) return state.hostStop;
	if (state)
		for (const operation of state.operations) operation.controller.abort(new Error("Native command stopped by host"));
	nativeWebGuiQuestions(session).cancelPendingInteractions();
	if (!state) return Promise.resolve();
	state.hostStopPending = true;
	const stopping = state.stopModes();
	state.hostStop = stopping;
	void stopping.then(
		() => {
			state.hostStopPending = false;
		},
		() => {
			state.hostStopPending = false;
			if (state.hostStop === stopping) state.hostStop = undefined;
		},
	);
	return stopping;
}

/** Stop only this actual session's command/dialog/mode work before native session settlement. */
export async function stopNativeWebGuiCommands(session: AgentSession): Promise<void> {
	const state = commandStates.get(session);
	if (!state) return;
	await beginNativeWebGuiHostStop(session);
	await Promise.all([...state.operations].map(operation => operation.settled));
	await Promise.allSettled([...state.background]);
	await settleNativeWebGuiHostResources(session);
}

export async function disposeNativeWebGuiCommands(session: AgentSession): Promise<void> {
	const state = commandStates.get(session);
	if (!state) return;
	await stopNativeWebGuiCommands(session);
	await state.disposeModes();
	commandStates.delete(session);
}
