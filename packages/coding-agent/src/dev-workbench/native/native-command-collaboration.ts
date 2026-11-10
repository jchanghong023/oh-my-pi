import { APP_NAME, getAgentDir, getProjectDir, logger } from "@oh-my-pi/pi-utils";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import {
	ADVISOR_REVIEW_MODES,
	ADVISOR_SESSION_SCOPES,
	ADVISOR_SYNC_BACKLOG_MODES,
	type AdvisorConfig,
	type WatchdogConfigDoc,
} from "@oh-my-pi/pi-tui/overlays/advisor-config";
import { extractLastCodeBlock, extractLastCommand, extractLastLink } from "@oh-my-pi/pi-tui/overlays/copy-targets";
import type { TranscriptEntryLike } from "@oh-my-pi/pi-tui/chat/transcript-entry";
import { collectBlocks, targetCopy } from "@oh-my-pi/pi-tui/overlays/copy-selector";
import { buildSessionTrace } from "@oh-my-pi/omp-stats/trace";
import {
	discoverAdvisorConfigs,
	loadWatchdogConfigFile,
	resolveAdvisorConfigEditPath,
	saveWatchdogConfigFile,
} from "../../advisor";
import { CollabController } from "../../collab/controller";
import { type CollabHost, type CollabHostPort, subscribeCollabEntries } from "../../collab/host";
import { intranetCollabEnabled } from "../../collab/intranet";
import { listCollabHosts } from "../../collab/registry";
import type { AgentSession } from "../../session/agent-session";
import { createBranchSummaryMessage, createCompactionSummaryMessage } from "../../session/messages";
import { commandConsumed, parseSubcommand, usage } from "../../slash-commands/helpers/parse";
import type { ParsedSlashCommand, WebGuiSlashCommandRuntime } from "../../slash-commands/types";
import { parseExportArgs } from "../../export/html/args";
import { shareSession } from "../../export/share";
import { loadCustomShare } from "../../export/custom-share";
import { cfgShareRedactSecrets, cfgShareServerUrl, cfgShareStore } from "../../commands/settings";
import {
	bindNativeWebGuiGuestUI,
	nativeWebGuiInteractionOrigin,
	withNativeWebGuiGuestInputScope,
} from "./native-interactions";
import { devNativeCollabProjection } from "./native-collab-projection";
import { runDevNativeInput, runWebGuiSession } from "./native-session-host";

export type DevCollabCommandRuntime = Pick<
	WebGuiSlashCommandRuntime,
	"session" | "sessionManager" | "settings" | "ui" | "output" | "signal" | "registerHostShutdown"
> & {
	host: Pick<WebGuiSlashCommandRuntime["host"], "browserAction">;
};

interface CollaborationState {
	controller: CollabController;
	close(): Promise<void>;
}
const sessions = new WeakMap<AgentSession, CollaborationState>();
const disposerSessions = new WeakSet<AgentSession>();

function collaboration(runtime: DevCollabCommandRuntime): CollaborationState {
	let state = sessions.get(runtime.session);
	if (state) return state;
	const { session, sessionManager, settings } = runtime;
	const port: CollabHostPort = {
		session,
		sessionManager,
		settings,
		eventBus: session.eventBus,
		subagentEventBus: session.subagentEventBus,
		subscribeEntries: listener => subscribeCollabEntries(sessionManager, listener),
		promptCustomMessage: (message, options) =>
			// CollabHost has checked the current peer's write capability. Its relay
			// callbacks may inherit /collab start's browser scopes, which must not
			// bind guest work or guest questions to that browser's lifetime.
			withNativeWebGuiGuestInputScope(() =>
				runWebGuiSession(session, () =>
					runDevNativeInput(
						session,
						() => session.promptCustomMessage(message, options),
						typeof message.content === "string"
							? message.content
							: message.content
									.filter(part => part.type === "text")
									.map(part => part.text)
									.join("\n"),
					),
				),
			),
		getContextUsage: () => {
			const usage = session.getContextUsage();
			return {
				tokens: usage?.tokens ?? 0,
				contextWindow: usage?.contextWindow ?? session.model?.contextWindow ?? 0,
			};
		},
		showStatus: message => {
			void runtime.output(message);
		},
	};
	const controller = new CollabController({ nativePort: port });
	controller.startupComplete();
	const restoreGuestUI = bindNativeWebGuiGuestUI(session, () => controller.host);
	state = {
		controller,
		async close() {
			await controller.shutdown("WebGUI session closed");
			restoreGuestUI();
			if (sessions.get(session) === this) sessions.delete(session);
		},
	};
	sessions.set(session, state);
	const owned = state;
	if (!disposerSessions.has(session)) {
		disposerSessions.add(session);
		session.addDisposer(() => {
			void sessions
				.get(session)
				?.close()
				.catch(error => logger.warn("Native collaboration disposal failed", { error: String(error) }));
		});
	}
	runtime.registerHostShutdown?.(() => owned.close());
	return state;
}

export async function runWebGuiCollab(command: ParsedSlashCommand, runtime: DevCollabCommandRuntime) {
	const { verb, rest } = parseSubcommand(command.args.trim());
	const state = collaboration(runtime);
	if (verb === "stop") {
		if (rest) return usage("Usage: /collab stop", runtime);
		await state.controller.stop("host stopped");
		await runtime.output("Collab stopped");
		return commandConsumed();
	}
	if (verb === "list") {
		if (rest) return usage("Usage: /collab list", runtime);
		const hosts = await listCollabHosts();
		// Registry snapshots deliberately contain metadata, not room keys or write tokens.
		await runtime.output(hosts.length ? JSON.stringify(hosts, null, 2) : "No active Collab hosts");
		return commandConsumed();
	}
	if (verb === "status") {
		if (rest) return usage("Usage: /collab status", runtime);
		const host = state.controller.host;
		if (!host) {
			const origin = nativeWebGuiInteractionOrigin();
			const projection = origin ? devNativeCollabProjection(runtime.session) : undefined;
			const guest = origin ? projection?.read(projection.browserId(origin.connectionId)) : null;
			await runtime.output(
				guest
					? `In a collab session as a ${guest.participant?.canWrite ? "" : "read-only "}guest (/leave to exit)`
					: "Not in a collab session",
			);
			return commandConsumed();
		}
		const participants = host.participants
			.map(p => `${p.name}${p.role === "host" ? " (host)" : p.readOnly ? " (view-only)" : ""}`)
			.join(", ");
		await runtime.output(`Collab: ${host.intranetUsername ? `${host.intranetUsername} — ` : ""}${participants}`);
		if (!host.intranetUsername) await presentCollabLink(host, host.access === "view", runtime);
		return commandConsumed();
	}
	const origin = nativeWebGuiInteractionOrigin();
	if (origin) {
		const projection = devNativeCollabProjection(runtime.session);
		if (projection.read(projection.browserId(origin.connectionId)))
			return usage("Already in a collab session as a guest (/leave first)", runtime);
	}
	const view = verb === "view";
	const host = await state.controller.start({
		access: view ? "view" : "control",
		relay: verb === "start" || view ? rest : command.args.trim(),
	});
	await runtime.output(
		host.intranetUsername && !view
			? `Collab active. Join with /join ${host.intranetUsername}`
			: `Collab ${view ? "read-only " : ""}session active.`,
	);
	if (!host.intranetUsername || view) await presentCollabLink(host, view, runtime);
	return commandConsumed();
}

async function presentCollabLink(host: CollabHost, view: boolean, runtime: DevCollabCommandRuntime): Promise<void> {
	// Keys and write tokens stay in the authorized interaction, never the stored transcript.
	const choice = await runtime.ui.select("Collaboration invite", ["Copy join link", "Open browser invite", "Done"], {
		signal: runtime.signal,
	});
	if (choice === "Copy join link")
		await runtime.host.browserAction({ action: "copyText", text: view ? host.viewLink : host.link });
	else if (choice === "Open browser invite")
		await runtime.host.browserAction({ action: "openUrl", url: view ? host.webViewLink : host.webLink });
}

export async function runWebGuiJoin(command: ParsedSlashCommand, runtime: DevCollabCommandRuntime) {
	const state = collaboration(runtime);
	const { session } = runtime;
	const generation = session.sessionGeneration;
	const origin = nativeWebGuiInteractionOrigin();
	if (!origin?.sessionId || origin.sessionId !== session.sessionId)
		throw new Error("Collaboration requires its originating browser session.");
	const projection = devNativeCollabProjection(session);
	const browserId = projection.browserId(origin.connectionId);
	if (projection.read(browserId)) return usage("Already in a collab session (/leave first)", runtime);
	if (state.controller.host) return usage("Stop hosting first (/collab stop)", runtime);
	let link = command.args.trim();
	if (!link)
		link =
			(
				await runtime.ui.input(intranetCollabEnabled() ? "Collab username or link" : "Collab link", undefined, {
					secret: true,
					signal: runtime.signal,
				})
			)?.trim() ?? "";
	if (!link) return commandConsumed();
	if (session.isDisposed || session.sessionGeneration !== generation || session.sessionId !== origin.sessionId)
		throw new Error("Collab origin session changed.");
	const signal = runtime.signal ?? new AbortController().signal;
	await projection.join({ browserId, usernameOrLink: link, name: "guest" }, signal);
	// The guest has its own native projection; the workflow actor and outstanding work stay local.
	await runtime.output("Joined collab session. Local workflow remains active (/leave to exit).");
	return commandConsumed();
}

export async function runWebGuiLeave(_command: ParsedSlashCommand, runtime: DevCollabCommandRuntime) {
	const state = collaboration(runtime);
	const origin = nativeWebGuiInteractionOrigin();
	const projection = origin ? devNativeCollabProjection(runtime.session) : undefined;
	const browserId = origin ? projection!.browserId(origin.connectionId) : undefined;
	const guest = browserId ? projection!.read(browserId) : null;
	if (guest?.participant && browserId) {
		await projection!.leave(browserId, guest.participant);
		await runtime.output("Left collab session.");
		return commandConsumed();
	}
	const controller = state.controller;
	const hosting = !!controller.host;
	await controller.stop("host stopped");
	await runtime.output(hosting ? "Collab stopped" : "Not in a collab session");
	return commandConsumed();
}

function record(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
function configDocument(value: unknown): WatchdogConfigDoc {
	if (!record(value) || !Array.isArray(value.advisors))
		throw new Error("Configuration must contain an advisors array.");
	const positiveInteger = (item: unknown) => Number.isSafeInteger(item) && (item as number) >= 1;
	if (value.instructions !== undefined && typeof value.instructions !== "string")
		throw new Error("instructions must be text.");
	if (value.maxNotesPerUpdate !== undefined && !positiveInteger(value.maxNotesPerUpdate))
		throw new Error("maxNotesPerUpdate must be a positive integer.");
	const names = new Set<string>();
	for (const item of value.advisors) {
		if (!record(item) || typeof item.name !== "string" || !item.name.trim())
			throw new Error("Each advisor needs a nonempty name.");
		if (names.has(item.name)) throw new Error(`Duplicate advisor: ${item.name}`);
		names.add(item.name);
		for (const key of ["model", "instructions"])
			if (item[key] !== undefined && typeof item[key] !== "string")
				throw new Error(`${item.name}: ${key} must be text.`);
		for (const key of ["enabled", "includeReasoning"])
			if (item[key] !== undefined && typeof item[key] !== "boolean")
				throw new Error(`${item.name}: ${key} must be boolean.`);
		for (const key of ["maxNotesPerUpdate", "reviewInterval"])
			if (item[key] !== undefined && !positiveInteger(item[key]))
				throw new Error(`${item.name}: ${key} must be a positive integer.`);
		if (item.tools !== undefined && (!Array.isArray(item.tools) || item.tools.some(tool => typeof tool !== "string")))
			throw new Error(`${item.name}: tools must be an array of tool names.`);
		for (const [key, choices] of [
			["reviewMode", ADVISOR_REVIEW_MODES],
			["syncBacklog", ADVISOR_SYNC_BACKLOG_MODES],
			["scope", ADVISOR_SESSION_SCOPES],
		] as const)
			if (item[key] !== undefined && !(choices as readonly unknown[]).includes(item[key]))
				throw new Error(`${item.name}: invalid ${key}.`);
	}
	return {
		instructions: value.instructions as string | undefined,
		maxNotesPerUpdate: value.maxNotesPerUpdate as number | undefined,
		advisors: value.advisors as AdvisorConfig[],
	};
}

export async function runWebGuiAdvisor(_command: ParsedSlashCommand, runtime: WebGuiSlashCommandRuntime) {
	const generation = runtime.session.sessionGeneration;
	const sessionId = runtime.session.sessionId;
	const scope = await runtime.ui.select("Advisor configuration scope", ["project", "user"]);
	if (scope !== "project" && scope !== "user") return commandConsumed();
	let projectDir = runtime.cwd;
	try {
		projectDir = vcs.repo(runtime.cwd)?.root() ?? runtime.cwd;
	} catch {
		/* Non-repository project. */
	}
	const agentDir = getAgentDir() ?? getProjectDir();
	const path = await resolveAdvisorConfigEditPath(scope, { projectDir, agentDir });
	const original = await loadWatchdogConfigFile(path);
	if (original.warnings?.length) await runtime.output(original.warnings.join("\n"));
	let text = JSON.stringify(
		{
			instructions: original.instructions,
			maxNotesPerUpdate: original.maxNotesPerUpdate,
			advisors: original.advisors,
		},
		null,
		2,
	);
	for (;;) {
		const edited = await runtime.ui.editor(`Edit ${scope} WATCHDOG configuration (JSON)`, text, {
			signal: runtime.signal,
		});
		if (edited === undefined) return commandConsumed();
		text = edited;
		let doc: WatchdogConfigDoc;
		try {
			doc = configDocument(JSON.parse(edited));
		} catch (error) {
			await runtime.output(error instanceof Error ? error.message : String(error));
			continue;
		}
		runtime.signal?.throwIfAborted();
		if (
			runtime.session.isDisposed ||
			runtime.session.isSessionTransitioning ||
			runtime.session.sessionGeneration !== generation ||
			runtime.session.sessionId !== sessionId ||
			runtime.sessionManager.getCwd() !== runtime.cwd
		)
			throw new Error("Advisor configuration session changed.");
		await saveWatchdogConfigFile(path, doc);
		const discovered = await discoverAdvisorConfigs(runtime.cwd, agentDir);
		const count = runtime.session.applyAdvisorConfigs(
			discovered.advisors,
			discovered.sharedInstructions,
			discovered.sharedMaxNotesPerUpdate,
		);
		if (discovered.warnings.length) await runtime.output(discovered.warnings.join("\n"));
		await runtime.output(
			`Saved ${path}. ${count ? `${count} advisor(s) active.` : "Run /advisor on to activate configured advisors."}`,
		);
		return commandConsumed();
	}
}

export async function runWebGuiCopy(command: ParsedSlashCommand, runtime: WebGuiSlashCommandRuntime) {
	const arg = command.args.trim().toLowerCase();
	let text: string | undefined;
	if (arg === "code") text = extractLastCodeBlock(runtime.session.messages)?.code;
	else if (arg === "cmd" || arg === "command") text = extractLastCommand(runtime.session.messages)?.code;
	else if (arg === "link" || arg === "url") text = extractLastLink(runtime.session.messages)?.href;
	else if (arg) return usage("Usage: /copy [code|cmd|link]", runtime);
	else {
		const targets: { label: string; text: string }[] = [];
		const entries = runtime.sessionManager.getBranch();
		for (let index = entries.length - 1; index >= 0; index--) {
			const persisted = entries[index]!;
			let entry: TranscriptEntryLike;
			if (persisted.type === "message" || persisted.type === "custom_message") {
				if (persisted.type === "custom_message" && !persisted.display) continue;
				entry = persisted;
			} else if (persisted.type === "compaction" || persisted.type === "branch_summary") {
				entry = {
					type: "message",
					id: persisted.id,
					parentId: persisted.parentId,
					timestamp: persisted.timestamp,
					message:
						persisted.type === "compaction"
							? createCompactionSummaryMessage(persisted.summary, persisted.tokensBefore, persisted.timestamp)
							: createBranchSummaryMessage(persisted.summary, persisted.fromId, persisted.timestamp),
				};
			} else continue;
			const blocks = collectBlocks([entry]);
			const whole = targetCopy(
				{
					entries: [entry],
					entryId: entry.id,
					turnId: entry.id,
					isUserTurn: entry.type === "message" && entry.message.role === "user",
					start: index,
					end: index + 1,
				},
				blocks,
			);
			if (whole.content.trim())
				targets.push({ label: `${whole.label}: ${whole.content.slice(0, 100)}`, text: whole.content });
			for (const block of blocks)
				targets.push({ label: `${block.label}: ${block.content.slice(0, 100)}`, text: block.content });
		}
		if (targets.length) {
			const options = targets.map((target, index) => `${index + 1}. ${target.label}`);
			const choice = await runtime.ui.select("Copy from conversation", options, { signal: runtime.signal });
			if (choice === undefined) return commandConsumed();
			text = targets[options.indexOf(choice)]?.text;
		}
	}
	if (text === undefined) {
		await runtime.output("No matching conversation content to copy.");
		return commandConsumed();
	}
	await runtime.host.browserAction({ action: "copyText", text });
	await runtime.output("Copied to browser clipboard.");
	return commandConsumed();
}

export async function runWebGuiOpen(command: ParsedSlashCommand, runtime: WebGuiSlashCommandRuntime) {
	const arg = command.args.trim().toLowerCase();
	if (arg && arg !== "link" && arg !== "url") return usage("Usage: /open [link]", runtime);
	const link = extractLastLink(runtime.session.messages);
	if (!link) {
		await runtime.output("No link to open.");
		return commandConsumed();
	}
	await runtime.host.browserAction({ action: "openUrl", url: link.href });
	return commandConsumed();
}

export async function runWebGuiExport(command: ParsedSlashCommand, runtime: WebGuiSlashCommandRuntime) {
	const { outputPath, useUserThemes } = parseExportArgs(command.args);
	if (outputPath === "--copy" || outputPath === "clipboard" || outputPath === "copy")
		return usage("Use /dump to copy the session to clipboard.", runtime);
	const sessionFile = runtime.session.sessionFile;
	if (!sessionFile) return usage("Cannot export in-memory session to HTML", runtime);
	const destination = path.resolve(
		runtime.cwd,
		outputPath ?? `${APP_NAME}-session-${path.basename(sessionFile, ".jsonl")}.html`,
	);
	const exported = await runtime.session.exportToHtml(destination, useUserThemes);
	await runtime.output(`Session exported to: ${exported}`);
	return commandConsumed();
}

export async function runWebGuiTrace(_command: ParsedSlashCommand, runtime: WebGuiSlashCommandRuntime) {
	const file = runtime.session.sessionFile;
	if (!file) {
		await runtime.output("No session file yet — send a message first.");
		return commandConsumed();
	}
	const trace = await buildSessionTrace(file);
	await runtime.output(JSON.stringify(trace, null, 2));
	return commandConsumed();
}

export async function runWebGuiShare(_command: ParsedSlashCommand, runtime: WebGuiSlashCommandRuntime) {
	const custom = await loadCustomShare();
	if (custom) {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-webgui-share-"));
		try {
			await fs.chmod(directory, 0o700);
			const htmlPath = path.join(directory, "session.html");
			await runtime.session.exportToHtml(htmlPath);
			const result = await custom.fn(htmlPath);
			runtime.signal?.throwIfAborted();
			if (typeof result === "string") {
				await runtime.output("Session shared with custom script.");
				await presentShareLink(result, runtime);
			} else {
				await runtime.output(result?.message ?? "Session shared with custom script.");
				if (result?.url) await presentShareLink(result.url, runtime);
			}
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
		return commandConsumed();
	}
	const result = await shareSession(runtime.sessionManager, {
		serverUrl: cfgShareServerUrl.get(runtime.settings),
		store: cfgShareStore.get(runtime.settings),
		state: runtime.session.state,
		obfuscator: cfgShareRedactSecrets.get(runtime.settings) ? runtime.session.obfuscator : undefined,
	});
	runtime.signal?.throwIfAborted();
	await runtime.output(
		`Encrypted session share created.${result.truncated ? " Large content was trimmed to fit the share size limit." : ""}`,
	);
	await presentShareLink(result.url, runtime);
	return commandConsumed();
}

async function presentShareLink(url: string, runtime: WebGuiSlashCommandRuntime): Promise<void> {
	const choice = await runtime.ui.select("Session share", ["Copy share link", "Open share link", "Done"], {
		signal: runtime.signal,
	});
	if (choice === "Copy share link") await runtime.host.browserAction({ action: "copyText", text: url });
	else if (choice === "Open share link") await runtime.host.browserAction({ action: "openUrl", url });
}
