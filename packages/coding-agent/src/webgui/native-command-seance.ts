import type { TextContent } from "@oh-my-pi/pi-ai";
import { sanitizeErrorLine } from "@oh-my-pi/pi-tui/chrome/error-block";
import type { TaskParams, TaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { getSessionsDirPath } from "@oh-my-pi/pi-utils/dirs";
import { filterAvailableModelsByEnabledPatterns } from "../config/model-resolver";
import { cfgEnabledModels } from "../config/model-settings";
import seanceCommandPrompt from "../prompts/system/seance-command.md" with { type: "text" };
import seanceCommandSolutionSpace from "../prompts/system/seance-command-solution-space.md" with { type: "text" };
import {
	listAllSessions,
	listSessionsReadOnly,
	sessionDisplayName,
	type SessionInfo,
} from "../session/session-listing";
import { FileSessionStorage } from "../session/session-storage";
import type { SlashCommandResult, WebGuiSlashCommandRuntime } from "../slash-commands/types";
import { discoverAgents } from "../task/discovery";
import { isBundledSeance, resolveSeanceSource } from "../task/seance";
import { SEANCE_AGENT_NAME } from "../task/seance-policy";

function matchSession(sessions: SessionInfo[], selector: string): SessionInfo | undefined {
	const normalized = selector.toLowerCase();
	const exact = sessions.filter(session => session.id.toLowerCase() === normalized);
	const matches = exact.length ? exact : sessions.filter(session => session.id.toLowerCase().startsWith(normalized));
	if (matches.length > 1) throw new Error(`Session selector "${sanitizeErrorLine(selector)}" is ambiguous.`);
	return matches[0];
}

/** Consult through the initiating session's task tool; the saved source is never resumed or opened for writing. */
export async function runNativeSeance(
	runtime: WebGuiSlashCommandRuntime,
	args: { source: string | undefined; model: string | undefined },
): Promise<SlashCommandResult> {
	const { session, sessionManager, settings, cwd } = runtime;
	const sessionId = session.sessionId;
	const sameSession = (): boolean =>
		!session.isDisposed &&
		session.sessionId === sessionId &&
		session.settings === settings &&
		sessionManager.getCwd() === cwd;
	const assertCurrent = (): void => {
		runtime.signal?.throwIfAborted();
		if (!sameSession()) {
			throw new Error("The initiating /seance session is no longer current.");
		}
	};
	let invoked = false;
	try {
		assertCurrent();
		const { agents } = await discoverAgents(cwd, undefined, session.effectiveExtensionRoots);
		assertCurrent();
		const agent = agents.find(candidate => candidate.name === SEANCE_AGENT_NAME);
		if (!agent || !isBundledSeance(agent)) {
			throw new Error("A custom `seance` agent overrides the bundled one; rename it to use /seance.");
		}
		const storage = new FileSessionStorage();
		const sessionDir = sessionManager.getSessionDir();
		const sessionsRoot = getSessionsDirPath(settings.getAgentDir());
		let selector = args.source;
		if (!selector) {
			const local = await listSessionsReadOnly(sessionDir, storage);
			const global = await listAllSessions(storage, sessionsRoot);
			assertCurrent();
			const sessions = [...local, ...global.filter(item => !local.some(current => current.path === item.path))];
			if (!sessions.length) throw new Error("No saved sessions are available for /seance.");
			const options = sessions.map((item, index) => ({
				label: `${index + 1}. ${sessionDisplayName(item)} · ${item.id}`,
				description: `${item.cwd} · ${item.modified.toISOString()} · ${item.status ?? "unknown"}`,
			}));
			const picked = await runtime.ui.select("Consult a saved session (read-only)", options);
			assertCurrent();
			if (picked === undefined) {
				await runtime.output("Seance cancelled; no consultation launched.");
				return { consumed: true };
			}
			selector = sessions[options.findIndex(option => option.label === picked)]?.path;
			if (!selector) throw new Error("The selected saved session is no longer available.");
		} else if (!selector.includes("/") && !selector.includes("\\") && !selector.endsWith(".jsonl")) {
			// Resolve IDs against this native profile, not the process's ambient active profile.
			const local = await listSessionsReadOnly(sessionDir, storage);
			const localMatch = matchSession(local, selector);
			const matched = localMatch ?? matchSession(await listAllSessions(storage, sessionsRoot), selector);
			assertCurrent();
			if (!matched) throw new Error(`Session "${sanitizeErrorLine(selector)}" was not found.`);
			selector = matched.path;
		}
		const source = await resolveSeanceSource(selector, { cwd, sessionDirHint: sessionDir, storage });
		assertCurrent();
		let model = args.model;
		if (model === undefined) {
			const choice = source.modelSelectors.length
				? await runtime.ui.select("Consult this session with", [
						{ label: "Use saved model", description: source.modelSelectors.join(" → ") },
						{
							label: "Choose another model",
							description: "One-off model; does not change the saved source or current model",
						},
					])
				: "Choose another model";
			assertCurrent();
			if (choice === undefined) {
				await runtime.output("Seance cancelled; no consultation launched.");
				return { consumed: true };
			}
			if (choice === "Choose another model") {
				const models = filterAvailableModelsByEnabledPatterns(
					session.modelRegistry.getAvailable(),
					cfgEnabledModels.get(settings),
					settings,
				);
				if (!models.length) throw new Error("No authenticated enabled models are available for /seance.");
				model = await runtime.ui.select(
					"Consultation model",
					models.map(item => `${item.provider}/${item.id}`),
				);
				assertCurrent();
				if (model === undefined) {
					await runtime.output("Seance cancelled; no consultation launched.");
					return { consumed: true };
				}
			}
		}
		const taskTool = session.agent.state.tools.find(tool => tool.name === "task");
		if (!taskTool) throw new Error("The task tool is not available for /seance.");
		const params: TaskParams = {
			agent: SEANCE_AGENT_NAME,
			sourceSession: source.file,
			task: seanceCommandPrompt,
			solutionSpace: seanceCommandSolutionSpace.trim(),
			...(model !== undefined ? { model } : {}),
		};
		assertCurrent();
		invoked = true;
		const result = await taskTool.execute(`seance-${Snowflake.next()}`, params, runtime.signal);
		assertCurrent();
		const details = result.details as TaskToolDetails | undefined;
		const content = result.content
			.filter((part): part is TextContent => part.type === "text")
			.map(part => part.text)
			.join("\n")
			.trim();
		const failed = details?.results?.find(item => item.error || item.aborted || item.exitCode !== 0);
		if (
			result.isError ||
			details?.async?.state === "failed" ||
			failed ||
			(!details?.async && !details?.results?.length)
		) {
			await runtime.output(
				sanitizeErrorLine(
					failed?.aborted
						? failed.abortReason || content || failed.error || "Seance cancelled."
						: content || failed?.error || "Seance preflight failed.",
				),
			);
			return { consumed: true, agentInvoked: true, failed: true };
		}
		const ids = new Set([
			...(details?.progress ?? []).map(item => item.id),
			...(details?.results ?? []).map(item => item.id),
		]);
		const resolvedModels = new Set(
			[...(details?.progress ?? []), ...(details?.results ?? [])].flatMap(item =>
				item.resolvedModel ? [item.resolvedModel] : [],
			),
		);
		const state = details?.async?.state === "running" ? "running" : "completed";
		await runtime.output(
			[
				`Seance ${state}: ${[...ids].join(", ") || details?.async?.jobId || source.id}${resolvedModels.size ? ` · ${[...resolvedModels].join(", ")}` : ""}`,
				content,
			]
				.filter(Boolean)
				.join("\n"),
		);
		return { consumed: true, agentInvoked: true };
	} catch (error) {
		if (sameSession()) await runtime.output(sanitizeErrorLine(error));
		return { consumed: true, agentInvoked: invoked, failed: true };
	}
}
