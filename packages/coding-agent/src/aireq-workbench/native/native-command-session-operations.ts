import { normalizePathForComparison } from "@oh-my-pi/pi-utils";
import { formatSessionContinuationNotice } from "../../modes/persistence-failure";
import type { AgentSession } from "../../session/agent-session";
import { SessionManager } from "../../session/session-manager";
import type { WebGuiCommandHost } from "../../slash-commands/types";
import {
	configureNativeWebGuiBrowserCommands,
	configureNativeWebGuiLifecycleCommands,
	configureNativeWebGuiSessionOperations,
	type NativeWebGuiSessionOperations,
} from "./native-command-host";
import { beginNativeWebGuiHostStop } from "./native-commands";
import {
	resumeNativeWebGuiSession,
	runNativeWebGuiBtw,
	runNativeWebGuiTan,
	runNativeWebGuiOmfg,
	runNativeWebGuiCleanse,
	runNativeWebGuiDebug,
} from "./native-command-lifecycle";
import {
	runWebGuiAdvisor,
	runWebGuiCollab,
	runWebGuiJoin,
	runWebGuiLeave,
	runWebGuiCopy,
	runWebGuiOpen,
	runWebGuiExport,
	runWebGuiTrace,
	runWebGuiShare,
} from "./native-command-collaboration";
import { runWebGuiSketch } from "./native-command-sketch";
import {
	handleWebGuiTodo,
	handleWebGuiSession,
	handleWebGuiUsage,
	handleWebGuiHotkeys,
	handleWebGuiExtensions,
	handleWebGuiAgents,
	handleWebGuiGit,
	handleWebGuiLocal,
	handleWebGuiHub,
	handleWebGuiBranch,
	handleWebGuiFork,
	handleWebGuiLogin,
} from "./native-command-session-views";
import {
	createWebGuiNativeSession,
	deleteWebGuiNativeSession,
	moveWebGuiNativeSession,
	resumeWebGuiNativeSession,
	runWebGuiSession,
	webGuiSessionContext,
	webGuiSessionProject,
} from "./native-session-host";
import { nativeWebGuiQuestions } from "./native-interactions";

/** Install only on explicit WebGUI entry, never while normal slash-command modules are loaded. */
export function installNativeWebGuiSessionOperations(): void {
	configureNativeWebGuiSessionOperations(createSessionOperations);
	configureNativeWebGuiLifecycleCommands({
		resume: resumeNativeWebGuiSession,
		btw: runNativeWebGuiBtw,
		tan: runNativeWebGuiTan,
		omfg: runNativeWebGuiOmfg,
		cleanse: runNativeWebGuiCleanse,
		debug: runNativeWebGuiDebug,
	});
	configureNativeWebGuiBrowserCommands({
		collaboration: {
			advisor: runWebGuiAdvisor,
			collab: runWebGuiCollab,
			join: runWebGuiJoin,
			leave: runWebGuiLeave,
			copy: runWebGuiCopy,
			open: runWebGuiOpen,
			export: runWebGuiExport,
			trace: runWebGuiTrace,
			share: runWebGuiShare,
		},
		sessionViews: {
			todo: handleWebGuiTodo,
			session: handleWebGuiSession,
			usage: handleWebGuiUsage,
			hotkeys: handleWebGuiHotkeys,
			extensions: handleWebGuiExtensions,
			agents: handleWebGuiAgents,
			git: handleWebGuiGit,
			local: handleWebGuiLocal,
			hub: handleWebGuiHub,
			branch: handleWebGuiBranch,
			fork: handleWebGuiFork,
			login: handleWebGuiLogin,
		},
		sketch: runWebGuiSketch,
	});
}

function createSessionOperations(session: AgentSession): NativeWebGuiSessionOperations {
	const browserAction: WebGuiCommandHost["browserAction"] = (action, options) =>
		nativeWebGuiQuestions(session).browserAction(action, options);
	const navigate = async (target: AgentSession): Promise<void> => {
		const project = webGuiSessionProject(target);
		await browserAction({
			action: "openSession",
			sessionId: target.sessionId,
			...project,
			workspacePath: target.sessionManager.getCwd(),
			model: target.model ? { providerId: target.model.provider, modelId: target.model.id } : null,
		});
	};
	return {
		withSessionScope: operation => runWebGuiSession(session, operation),
		createNewSession: async () => {
			await session.settings.flush();
			const created = await createWebGuiNativeSession(
				webGuiSessionContext(session),
				session.sessionManager.getCwd(),
				{ model: session.model, thinkingLevel: session.thinkingLevel },
			);
			await navigate(created);
		},
		resetContext: async () => {
			if (!(await runWebGuiSession(session, () => session.newSession())))
				throw new Error("Native context reset was cancelled");
			await navigate(session);
		},
		resumeSession: async (file, options) => {
			await session.settings.flush();
			const info = (await SessionManager.listAll()).find(
				candidate => normalizePathForComparison(candidate.path) === normalizePathForComparison(file),
			);
			if (!info) throw new Error("The selected native history no longer exists");
			const resumed = await resumeWebGuiNativeSession(webGuiSessionContext(session), info.id);
			if (options?.continuation)
				resumed.emitNotice("warning", formatSessionContinuationNotice(options.continuation), "webgui-command");
			await navigate(resumed);
		},
		deleteCurrentSession: async options => {
			const context = webGuiSessionContext(session);
			const cwd = session.sessionManager.getCwd();
			const model = session.model;
			const thinkingLevel = session.thinkingLevel;
			const previousId = session.sessionId;
			const histories = options?.selectAfter
				? (await SessionManager.listAll()).filter(info => info.id !== previousId)
				: [];
			const selected =
				options?.selectAfter && histories.length > 0
					? await nativeWebGuiQuestions(session).ui.select(
							"Resume a native session after deletion",
							histories.map(info => `${info.id} — ${info.title ?? info.firstMessage}`),
						)
					: undefined;
			const selectedHistory = histories.find(info => selected?.startsWith(`${info.id} — `));
			await deleteWebGuiNativeSession(session);
			if (selectedHistory) {
				const resumed = await resumeWebGuiNativeSession(
					{ ...context, nativeSession: undefined },
					selectedHistory.id,
				);
				await navigate(resumed);
				return;
			}
			if (!session.isDisposed && session.sessionId !== previousId) {
				await navigate(session);
				return;
			}
			const replacement = await createWebGuiNativeSession({ ...context, nativeSession: undefined }, cwd, {
				model,
				thinkingLevel,
			});
			await navigate(replacement);
		},
		moveSession: async (cwd, operation) => {
			await beginNativeWebGuiHostStop(session);
			await moveWebGuiNativeSession(session, cwd, operation);
			await navigate(session);
		},
	};
}
