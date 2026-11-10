import * as fs from "node:fs/promises";
import { getWorkProfile } from "@oh-my-pi/pi-natives";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { createCleanseStatusBoard } from "@oh-my-pi/pi-tui/apps/cleanse-board";
import { resolveRawSseDebugBuffer } from "@oh-my-pi/pi-tui/apps/debug/raw-sse-buffer";
import { runCleanse } from "../../cleanse";
import { collectMemoryStats, startCpuProfile } from "../../debug/profiler";
import { getRemoteDebugger, startRemoteDebuggerServer } from "../../debug/remote-debugger";
import {
	clearArtifactCache,
	createDebugLogSource,
	createReportBundle,
	getArtifactCacheStats,
} from "../../debug/report-bundle";
import { collectSystemInfo, formatSystemInfo } from "../../debug/system-info";
import { parseCleanseArgs } from "../../modes/controllers/cleanse-command-controller";
import { OmfgController } from "../../modes/controllers/omfg-controller";
import { TanCommandController } from "../../modes/controllers/tan-command-controller";
import { cfgBtwInject } from "../../modes/settings";
import type { AgentSession } from "../../session/agent-session";
import {
	BtwHistoryStore,
	getBtwCopyText,
	getBtwLatestTurn,
	getBtwRecordInject,
	getBtwTurns,
} from "../../session/btw-history";
import { beginBtwTurn, patchLatestBtwTurn, runBtwTurn } from "../../session/btw-turn";
import {
	createForeignSessionStore,
	foreignSessionSourceName,
	persistForeignSession,
} from "../../session/foreign-session-import";
import { resolveResumeTarget } from "../../session/session-listing";
import { SessionManager } from "../../session/session-manager";
import { cfgSessionWorktreeScope } from "../../session/settings";
import { commandConsumed, usage } from "../../slash-commands/helpers/parse";
import type { ParsedSlashCommand, SlashCommandResult, WebGuiSlashCommandRuntime } from "../../slash-commands/types";
import { openPath } from "../../utils/open";

const activeBtwTurns = new WeakSet<AgentSession>();
const activeCleanseRuns = new WeakSet<AgentSession>();
const btwInjects = new WeakMap<AgentSession, Map<string, string>>();

/** Controller callbacks are synchronous; drain their real journal writes before settling the command. */
function lifecycleOutput(runtime: WebGuiSlashCommandRuntime) {
	let pending = Promise.resolve();
	let failure: unknown;
	let failed = false;
	return {
		print(text: string): void {
			pending = pending
				.then(async () => {
					await runtime.output(text);
				})
				.catch(error => {
					failed = true;
					failure = error;
				});
		},
		async flush(): Promise<void> {
			await pending;
			if (failed) throw failure;
		},
	};
}

export async function resumeNativeWebGuiSession(
	command: ParsedSlashCommand,
	runtime: WebGuiSlashCommandRuntime,
): Promise<SlashCommandResult> {
	const arg = command.args.trim();
	if (arg === "@claude" || arg === "@codex") {
		const source = arg === "@claude" ? "claude" : "codex";
		const store = createForeignSessionStore(source);
		const sessions = await store.list();
		if (!sessions.length) return usage(`No ${foreignSessionSourceName(source)} sessions found`, runtime);
		const labels = sessions.map(
			session => `${session.title || session.firstMessage || session.id} · ${session.cwd} · ${session.id}`,
		);
		const chosen = await runtime.ui.select(`Import ${foreignSessionSourceName(source)} session`, labels);
		const selected = chosen === undefined ? undefined : sessions[labels.indexOf(chosen)];
		if (!selected) return commandConsumed();
		await runtime.settings.flush();
		const imported = await persistForeignSession(store, selected, {
			fallbackCwd: runtime.sessionManager.getCwd(),
			suppressBreadcrumb: true,
		});
		const file = imported.getSessionFile();
		await imported.close();
		if (!file) throw new Error("Imported session was not persisted");
		await runtime.host.resumeSession(file);
		return commandConsumed();
	}
	let target = arg;
	if (!target) {
		const listing = await SessionManager.listForPicker(
			runtime.sessionManager.getCwd(),
			runtime.sessionManager.getSessionDir(),
			undefined,
			cfgSessionWorktreeScope.get(runtime.settings),
		);
		if (!listing.sessions.length) return usage("No sessions found", runtime);
		const labels = listing.sessions.map(
			session => `${session.title || session.firstMessage || session.id} · ${session.cwd} · ${session.id}`,
		);
		const chosen = await runtime.ui.select("Resume session", labels);
		const selected = chosen === undefined ? undefined : listing.sessions[labels.indexOf(chosen)];
		if (!selected) return commandConsumed();
		target = selected.id;
	}
	const resolved = await resolveResumeTarget(
		target,
		runtime.sessionManager.getCwd(),
		runtime.sessionManager.getSessionDir(),
		{ allowGlobalFallback: true },
	);
	if (!resolved) return usage(`Session "${target}" not found`, runtime);
	await runtime.host.resumeSession(resolved.session.path, { continuation: resolved.continuation });
	return commandConsumed();
}

export async function runNativeWebGuiTan(
	command: ParsedSlashCommand,
	runtime: WebGuiSlashCommandRuntime,
): Promise<SlashCommandResult> {
	const output = lifecycleOutput(runtime);
	const controller = new TanCommandController({
		session: runtime.session,
		sessionManager: runtime.sessionManager,
		settings: runtime.settings,
		mcpManager: runtime.mcpManager,
		sessionScopedCwd: true,
		showStatus: output.print,
		showError: output.print,
	});
	const dispatched = await controller.start(command.args, runtime.input?.images);
	await output.flush();
	return commandConsumed({ failed: !dispatched });
}

export async function runNativeWebGuiOmfg(
	command: ParsedSlashCommand,
	runtime: WebGuiSlashCommandRuntime,
): Promise<SlashCommandResult> {
	if (runtime.input?.images?.length) return usage("/omfg does not accept images.", runtime);
	let failed = false;
	const output = lifecycleOutput(runtime);
	const controller = new OmfgController({
		session: runtime.session,
		sessionManager: runtime.sessionManager,
		settings: runtime.settings,
		showStatus: output.print,
		showError: text => {
			failed = true;
			output.print(text);
		},
		showHookConfirm: (title, message) => runtime.ui.confirm(title, message),
		showHookSelector: (title, choices) => runtime.ui.select(title, choices),
		showHookInput: (title, placeholder) => runtime.ui.input(title, placeholder),
		createPanel: complaint => {
			output.print(`Forging TTSR rule: ${complaint}`);
			return {
				setRule: text => {
					if (text) output.print(text);
				},
				setStatus: (_status, text) => {
					if (text) output.print(text);
				},
				markError: text => {
					failed = true;
					output.print(text);
				},
				markAborted: () => {
					output.print("Rule generation cancelled.");
				},
				markRejected: () => {
					output.print("Rule not saved.");
				},
				markSaved: file => {
					output.print(`TTSR rule saved: ${file}`);
				},
			};
		},
	});
	const abort = () => controller.dispose();
	runtime.signal?.addEventListener("abort", abort, { once: true });
	try {
		await controller.start(command.args);
		await controller.settle();
		return commandConsumed({ failed });
	} finally {
		runtime.signal?.removeEventListener("abort", abort);
		controller.dispose();
		await output.flush();
	}
}

export async function runNativeWebGuiCleanse(
	command: ParsedSlashCommand,
	runtime: WebGuiSlashCommandRuntime,
): Promise<SlashCommandResult> {
	if (runtime.input?.images?.length) return usage("/cleanse does not accept images.", runtime);
	const parsed = parseCleanseArgs(command.args);
	if (parsed.error) return usage(parsed.error, runtime);
	if (activeCleanseRuns.has(runtime.session))
		return usage("A /cleanse run is already active; cancel it first.", runtime);
	const messages = lifecycleOutput(runtime);
	const print = messages.print;
	const promptRequest = async () =>
		(await runtime.ui.input("Describe what to detect and fix", 'e.g. "ts errors"'))?.trim() || null;
	const output = {
		write: (text: string) => {
			print(text);
			return true;
		},
		isTTY: false,
	};
	const board = createCleanseStatusBoard(output, output);
	activeCleanseRuns.add(runtime.session);
	const result = await runCleanse(
		{ ...parsed, cwd: runtime.sessionManager.getCwd() },
		{
			board,
			print,
			printError: print,
			promptRequest,
			pickTarget: async checkers => {
				const all = `Run all ${checkers.length} discovered checkers`;
				const custom = "Describe what to fix…";
				const labels = checkers.map(checker => `${checker.label} — ${checker.command}`);
				const choice = await runtime.ui.select("Select what to cleanse", [all, ...labels, custom]);
				if (choice === all) return { kind: "all" };
				if (choice === custom) {
					const request = await promptRequest();
					return request === null ? { kind: "cancel" } : { kind: "request", request };
				}
				const selected = choice === undefined ? undefined : checkers[labels.indexOf(choice)];
				return selected ? { kind: "checker", id: selected.id } : { kind: "cancel" };
			},
		},
		runtime.signal ?? new AbortController().signal,
	).finally(async () => {
		activeCleanseRuns.delete(runtime.session);
		await messages.flush();
	});
	return commandConsumed({ failed: result.exitCode !== 0 && result.status !== "cancelled" });
}

export async function runNativeWebGuiBtw(
	command: ParsedSlashCommand,
	runtime: WebGuiSlashCommandRuntime,
): Promise<SlashCommandResult> {
	await runtime.sessionManager.ensureOnDisk();
	const store = await BtwHistoryStore.open(runtime.sessionManager.getArtifactsDir() ?? undefined);
	let question = command.args.trim();
	let previous;
	if (!question) {
		const records = store.getRecords();
		const labels = records.map(record => `${record.title || record.question} · ${record.id}`);
		const choice = await runtime.ui.select("BTW history", ["Ask a new side question", ...labels]);
		if (choice === undefined) return commandConsumed();
		previous = records[labels.indexOf(choice)];
		if (previous) {
			await runtime.output(
				getBtwTurns(previous)
					.map(turn => `Q: ${turn.question}\nA: ${turn.answer}${turn.error ? `\nError: ${turn.error}` : ""}`)
					.join("\n\n"),
			);
			const inject = btwInjects.get(runtime.session)?.get(previous.id);
			const action = await runtime.ui.select("BTW topic", [
				"Follow up",
				"Copy answer",
				...(inject ? ["Send steering prompt"] : []),
				"Close",
			]);
			if (action === "Copy answer") {
				await runtime.host.browserAction({ action: "copyText", text: getBtwCopyText(previous) ?? "" });
				return commandConsumed();
			}
			if (action === "Send steering prompt" && inject) {
				await runtime.session.prompt(inject, { attribution: "user", streamingBehavior: "steer" });
				btwInjects.get(runtime.session)?.delete(previous.id);
				return commandConsumed({ agentInvoked: true });
			}
			if (action !== "Follow up") return commandConsumed();
		}
		question = (await runtime.ui.input("Side question"))?.trim() || "";
		if (!question) return commandConsumed();
	}
	if (activeBtwTurns.has(runtime.session)) return usage("A /btw question is still running; cancel it first.", runtime);
	const sessionId = runtime.sessionManager.getSessionId();
	const turn = beginBtwTurn(question, runtime.sessionManager.getLeafId(), previous, runtime.input?.images);
	let record = turn.record;
	let checkpointed = false;
	let releaseCheckpoint: (() => void) | undefined;
	activeBtwTurns.add(runtime.session);
	try {
		await store.upsert(record);
		checkpointed = true;
		if (previous) btwInjects.get(runtime.session)?.delete(previous.id);
		releaseCheckpoint = runtime.registerHostShutdown?.(async () => {
			try {
				await store.flush();
			} catch {
				// Match the native controller: retry the retained checkpoint before allowing a lifecycle change.
				await store.retry(record);
				await store.flush();
			}
		});
		const result = await runBtwTurn(runtime.session, {
			question,
			images: runtime.input?.images,
			history: turn.history,
			inject: cfgBtwInject.get(runtime.settings),
			conversationKey: turn.conversationKey,
			signal: runtime.signal ?? new AbortController().signal,
			onTextDelta: delta => {
				record = patchLatestBtwTurn(record, {
					answer: getBtwLatestTurn(record).answer + delta,
					updatedAt: Date.now(),
				});
			},
		});
		record = patchLatestBtwTurn(record, { answer: result.replyText, status: "complete", updatedAt: Date.now() });
		await store.upsert(record);
		await runtime.output(result.replyText);
		const inject = cfgBtwInject.get(runtime.settings) ? getBtwRecordInject(record) : undefined;
		if (inject) {
			let injects = btwInjects.get(runtime.session);
			if (!injects) btwInjects.set(runtime.session, (injects = new Map()));
			injects.set(record.id, inject);
		}
		const branchable =
			!previous &&
			record.leafId &&
			!runtime.session.isStreaming &&
			runtime.sessionManager.getSessionId() === sessionId &&
			runtime.sessionManager.getLeafId() === record.leafId;
		const action = await runtime.ui.select("BTW answer", [
			"Close",
			"Copy answer",
			...(inject ? ["Send steering prompt"] : []),
			...(branchable ? ["Branch from answer"] : []),
		]);
		if (action === "Copy answer")
			await runtime.host.browserAction({ action: "copyText", text: getBtwCopyText(record) ?? "" });
		if (action === "Send steering prompt" && inject) {
			await runtime.session.prompt(inject, { attribution: "user", streamingBehavior: "steer" });
			btwInjects.get(runtime.session)?.delete(record.id);
			return commandConsumed({ agentInvoked: true });
		}
		if (action === "Branch from answer" && branchable && record.leafId) {
			const branch = await runtime.session.branchFromBtw(
				question,
				result.assistantMessage,
				record.leafId,
				sessionId,
				runtime.input?.images,
			);
			await runtime.output(branch.cancelled ? "/btw branch cancelled" : "Branched from /btw answer.");
		}
		return commandConsumed();
	} catch (error) {
		if (checkpointed && getBtwLatestTurn(record).status === "running") {
			record = patchLatestBtwTurn(record, {
				status: runtime.signal?.aborted ? "cancelled" : "error",
				error: error instanceof Error ? error.message : String(error),
				updatedAt: Date.now(),
			});
			await store.upsert(record);
		}
		throw error;
	} finally {
		activeBtwTurns.delete(runtime.session);
		await store.flush();
		releaseCheckpoint?.();
	}
}

export async function runNativeWebGuiDebug(
	_command: ParsedSlashCommand,
	runtime: WebGuiSlashCommandRuntime,
): Promise<SlashCommandResult> {
	const choice = await runtime.ui.select("Debug Tools", [
		"Open artifact folder",
		"Performance report",
		"Work scheduling profile",
		"Dump session report",
		"Memory report",
		"Recent logs",
		"System info",
		"Browser state",
		"Browser rendering and protocols",
		"Raw SSE stream",
		"Start JS remote debugger",
		"Export native transcript",
		"Clear artifact cache",
	]);
	if (!choice) return commandConsumed();
	const rawSseText = resolveRawSseDebugBuffer(runtime.session).toRawText();
	const base = {
		sessionFile: runtime.sessionManager.getSessionFile(),
		settings: {
			model: runtime.session.model?.id,
			thinkingLevel: runtime.session.thinkingLevel,
			cwd: runtime.sessionManager.getCwd(),
		},
		rawSseText,
	};
	if (choice === "Browser state" || choice === "Browser rendering and protocols") {
		const diagnostics = await runtime.host.browserAction({
			action: "diagnostics",
			probe: choice === "Browser state" ? "state" : "protocols",
		});
		await runtime.output(JSON.stringify(diagnostics, null, 2));
		return commandConsumed();
	}
	if (choice === "Open artifact folder") {
		const directory = runtime.sessionManager.getArtifactsDir();
		if (!directory || !(await fs.stat(directory).catch(() => undefined))?.isDirectory())
			return usage("Artifact folder does not exist yet.", runtime);
		await openPath(directory);
		await runtime.output(`Opened: ${directory}`);
	} else if (choice === "Recent logs") {
		const source = await createDebugLogSource();
		await runtime.output((await source.getInitialText()) || "No recent logs.");
	} else if (choice === "System info") {
		await runtime.output(formatSystemInfo(await collectSystemInfo()));
	} else if (choice === "Raw SSE stream") {
		await runtime.output(rawSseText || "No provider SSE frames captured.");
	} else if (choice === "Start JS remote debugger") {
		if (
			!(await runtime.ui.confirm(
				"Start JS remote debugger?",
				"Expose this process's experimental JavaScriptCore inspector socket? This cannot be stopped without restarting.",
			))
		)
			return commandConsumed();
		const info = getRemoteDebugger() ?? (await startRemoteDebuggerServer());
		await runtime.output(`JavaScriptCore inspector listening on ${info.host}:${info.port}`);
	} else if (choice === "Export native transcript") {
		await runtime.sessionManager.flush();
		await runtime.output(JSON.stringify(runtime.session.messages, null, 2));
	} else if (choice === "Clear artifact cache") {
		const directory = getSessionsDir();
		const stats = await getArtifactCacheStats(directory);
		if (
			await runtime.ui.confirm(
				"Clear Artifact Cache",
				`Found ${stats.count} artifact files (${stats.totalSize} bytes). Remove artifacts older than 30 days?`,
			)
		) {
			const result = await clearArtifactCache(directory, 30);
			await runtime.output(`Cleared ${result.removed} artifact directories`);
		}
	} else {
		let cpuProfile;
		if (choice === "Performance report") {
			const profiler = await startCpuProfile();
			try {
				await runtime.ui.confirm(
					"CPU profiling started",
					"Reproduce the issue, then confirm to stop profiling and generate the report.",
				);
			} finally {
				cpuProfile = await profiler.stop();
			}
		}
		const result = await createReportBundle({
			...base,
			cpuProfile,
			memoryStats: choice === "Memory report" ? collectMemoryStats() : undefined,
			workProfile:
				choice === "Work scheduling profile" || choice === "Performance report" ? getWorkProfile(30) : undefined,
		});
		await runtime.output(
			`Report saved: ${result.path}\nFiles: ${result.files.join(", ")}\nReview before sharing: session data, artifacts, logs and settings may contain secrets.`,
		);
	}
	return commandConsumed();
}
