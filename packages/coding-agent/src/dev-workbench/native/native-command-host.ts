import { AsyncLocalStorage } from "node:async_hooks";
import type { MCPManager } from "../../mcp/manager";
import type { AgentSession } from "../../session/agent-session";
import type {
	WebGuiCollaborationCommands,
	WebGuiCommandHost,
	WebGuiLifecycleCommands,
	WebGuiNativeCommandOperation,
	WebGuiSessionViewCommands,
} from "../../slash-commands/types";
import { nativeWebGuiQuestions } from "./native-interactions";

interface NativeWebGuiLifecycleGate {
	session: AgentSession;
	leave: (action: () => Promise<void>) => Promise<void>;
}
const lifecycleGate = new AsyncLocalStorage<NativeWebGuiLifecycleGate>();
export function withNativeWebGuiCommandLifecycleGate<T>(
	session: AgentSession,
	leave: (action: () => Promise<void>) => Promise<void>,
	task: () => Promise<T>,
): Promise<T> {
	return lifecycleGate.run({ session, leave }, task);
}

export interface NativeWebGuiCommandOwner {
	close(): Promise<void>;
	restart(): Promise<void>;
	toggleMode?: (mode: "webgui" | "dev", session: AgentSession) => Promise<void>;
}

const hosts = new WeakMap<AgentSession, NativeWebGuiCommandOwner>();
let defaultHost: NativeWebGuiCommandOwner | undefined;

export type NativeWebGuiSessionOperations = Pick<
	WebGuiCommandHost,
	"createNewSession" | "resetContext" | "resumeSession" | "deleteCurrentSession" | "moveSession" | "withSessionScope"
>;
let sessionOperationsFactory: ((session: AgentSession) => NativeWebGuiSessionOperations) | undefined;
export function configureNativeWebGuiSessionOperations(
	factory: (session: AgentSession) => NativeWebGuiSessionOperations,
): void {
	sessionOperationsFactory = factory;
}

let lifecycleCommands: WebGuiLifecycleCommands | undefined;
export function configureNativeWebGuiLifecycleCommands(commands: WebGuiLifecycleCommands): void {
	lifecycleCommands = commands;
}

let collaborationCommands: WebGuiCollaborationCommands | undefined;
let sessionViewCommands: WebGuiSessionViewCommands | undefined;
let sketchCommand: WebGuiNativeCommandOperation | undefined;
export function configureNativeWebGuiBrowserCommands(commands: {
	collaboration: WebGuiCollaborationCommands;
	sessionViews: WebGuiSessionViewCommands;
	sketch: WebGuiNativeCommandOperation;
}): void {
	collaborationCommands = commands.collaboration;
	sessionViewCommands = commands.sessionViews;
	sketchCommand = commands.sketch;
}

export interface NativeWebGuiCommandEnvironment {
	mcpManager?: MCPManager;
}
const environments = new WeakMap<AgentSession, NativeWebGuiCommandEnvironment>();
export function bindNativeWebGuiCommandEnvironment(
	session: AgentSession,
	environment: NativeWebGuiCommandEnvironment,
): () => void {
	const previous = environments.get(session);
	environments.set(session, environment);
	return () => {
		if (environments.get(session) !== environment) return;
		if (previous) environments.set(session, previous);
		else environments.delete(session);
	};
}
export function nativeWebGuiCommandEnvironment(session: AgentSession): NativeWebGuiCommandEnvironment {
	return environments.get(session) ?? {};
}

/** Standalone launch owns the terminal wait and native process restart, not an RPC connection. */
export function configureNativeWebGuiCommandHost(host: NativeWebGuiCommandOwner): () => void {
	const previous = defaultHost;
	defaultHost = host;
	return () => {
		if (defaultHost === host) defaultHost = previous;
	};
}

/** Attach the exact lifecycle owner of a borrowed or SDK-created native session. */
export function bindNativeWebGuiCommandHost(session: AgentSession, host: NativeWebGuiCommandOwner): () => void {
	const previous = hosts.get(session);
	hosts.set(session, host);
	return () => {
		if (hosts.get(session) !== host) return;
		if (previous) hosts.set(session, previous);
		else hosts.delete(session);
	};
}

export function nativeWebGuiCommandHost(session: AgentSession): WebGuiCommandHost {
	const owner = (): NativeWebGuiCommandOwner => {
		const host = hosts.get(session) ?? defaultHost;
		if (!host) throw new Error("Native WebGUI lifecycle owner is not bound");
		return host;
	};
	const browserAction: WebGuiCommandHost["browserAction"] = (action, options) =>
		nativeWebGuiQuestions(session).browserAction(action, options);
	const sessionOperations = (): NativeWebGuiSessionOperations => {
		if (!sessionOperationsFactory) throw new Error("Native WebGUI session operations are not installed");
		return sessionOperationsFactory(session);
	};
	const runLifecycle = (action: () => Promise<void>): Promise<void> => {
		const gate = lifecycleGate.getStore();
		return gate?.session === session ? gate.leave(action) : action();
	};
	return {
		get lifecycle() {
			if (!lifecycleCommands) throw new Error("Native WebGUI lifecycle commands are not installed");
			return lifecycleCommands;
		},
		get collaboration() {
			if (!collaborationCommands) throw new Error("Native WebGUI collaboration commands are not installed");
			return collaborationCommands;
		},
		get sessionViews() {
			if (!sessionViewCommands) throw new Error("Native WebGUI session view commands are not installed");
			return sessionViewCommands;
		},
		sketch: (command, runtime) => {
			if (!sketchCommand) throw new Error("Native WebGUI sketch command is not installed");
			return sketchCommand(command, runtime);
		},
		close: () => runLifecycle(() => owner().close()),
		restart: () => runLifecycle(() => owner().restart()),
		toggleMode: mode =>
			runLifecycle(async () => {
				if (mode === "webgui") return owner().close();
				const toggle = owner().toggleMode;
				if (!toggle) throw new Error("Native WebGUI lifecycle owner has no mode transfer");
				await toggle(mode, session);
			}),
		createNewSession: () => runLifecycle(() => sessionOperations().createNewSession()),
		resetContext: () => runLifecycle(() => sessionOperations().resetContext()),
		withSessionScope: operation => sessionOperations().withSessionScope(operation),
		resumeSession: (file, options) => runLifecycle(() => sessionOperations().resumeSession(file, options)),
		deleteCurrentSession: options => runLifecycle(() => sessionOperations().deleteCurrentSession(options)),
		moveSession: (cwd, operation, recover) =>
			runLifecycle(() => sessionOperations().moveSession(cwd, operation, recover)),
		browserAction,
	};
}
