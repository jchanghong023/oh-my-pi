import * as fs from "node:fs/promises";
import * as path from "node:path";
import { PASTE_CODE_LOGIN_PROVIDERS } from "@oh-my-pi/pi-ai";
import { getOAuthCredentialProvider, getOAuthProviders, isOAuthLoginSupported } from "@oh-my-pi/pi-ai/oauth";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { buildHotkeysMarkdown } from "@oh-my-pi/pi-tui/hotkeys-markdown";
import { transcriptEntryMessage } from "@oh-my-pi/pi-tui/chat/transcript-entry";
import { isShadowedExtension } from "@oh-my-pi/pi-tui/overlays/extensions/types";
import { disambiguateDisplayLabels } from "@oh-my-pi/pi-tui/render/render-utils";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { GitModel } from "../../cli/git-tui/state";
import { formatLoginIdentity } from "../../cli/oauth-terminal";
import { cfgDisabledProviders } from "../../config/model-settings";
import { listLocalFiles } from "../../internal-urls";
import { createAgentsHubDeps } from "../../modes/agents-hub-deps";
import { createExtensionDashboardRuntime } from "../../modes/components/extensions/dashboard-runtime";
import {
	resolveLocalEditorTarget,
	revalidateLocalEditorEntry,
	sessionLocalProtocolOptions,
} from "../../modes/local-file-editor";
import { isTranscriptEntry } from "../../session/session-context";
import { cfgBranchSummaryEnabled } from "../../session/context-settings";
import type { AgentSession } from "../../session/agent-session";
import type { SessionEntry } from "../../session/session-entries";
import { formatSessionHistoryMarkdown } from "../../session/session-history-format";
import { TodoCommandController, type TodoCommandHost } from "../../modes/controllers/todo-command-controller";
import { commandConsumed, parseSubcommand, usage } from "../../slash-commands/helpers/parse";
import type { ParsedSlashCommand, SlashCommandResult, WebGuiSlashCommandRuntime } from "../../slash-commands/types";
import { phasesToMarkdown } from "../../tools/todo";
import { AskTool } from "../../tools/ask";
import { ToolAbortError } from "../../tools/tool-errors";
import { captureBrowserSession } from "../../utils/browser-session";
import { markdownFenceFor } from "../../utils/markdown-fence";

import { NativeChildDirectory } from "./native-subagents";
import { forkWebGuiNativeSession, webGuiSessionContext } from "./native-session-host";
import { toSessionPinAccounts } from "../../slash-commands/helpers/session-pin";
import { describeRedeemOutcome, toResetUsageAccounts } from "../../slash-commands/helpers/reset-usage";
/** Index-based selection keeps display sanitization separate from native identifiers. */
async function pick<T>(
	runtime: WebGuiSlashCommandRuntime,
	title: string,
	values: readonly T[],
	label: (value: T) => string,
): Promise<T | undefined> {
	const labels = disambiguateDisplayLabels(
		values.map(value => sanitizeText(label(value))),
		[],
	);
	const selected = await runtime.ui.select(title, labels, { signal: runtime.signal });
	return selected === undefined ? undefined : values[labels.indexOf(selected)];
}

export async function handleWebGuiHotkeys(
	_command: ParsedSlashCommand,
	runtime: WebGuiSlashCommandRuntime,
): Promise<SlashCommandResult> {
	const keys = new KeybindingsManager({}, path.join(runtime.settings.getAgentDir(), "keybindings.yml"));
	keys.reload();
	await runtime.output(buildHotkeysMarkdown({ keybindings: keys }));
	return commandConsumed();
}

const todoExpanded = new WeakMap<AgentSession, boolean>();
export async function handleWebGuiTodo(
	command: ParsedSlashCommand,
	runtime: WebGuiSlashCommandRuntime,
): Promise<SlashCommandResult> {
	const pending: Promise<unknown>[] = [];
	let failed = false;
	const emit = (text: string) => {
		pending.push(Promise.resolve(runtime.output(text)));
	};
	const expand = (expanded: boolean, markdown = phasesToMarkdown(runtime.session.getTodoPhases())) => {
		todoExpanded.set(runtime.session, expanded);
		pending.push(runtime.host.browserAction({ action: "setTodoExpanded", expanded, markdown }));
	};
	const host: TodoCommandHost = {
		session: runtime.session,
		sessionManager: runtime.sessionManager,
		showStatus: emit,
		showWarning: emit,
		showError: text => {
			failed = true;
			emit(text);
		},
		setTodos: phases => expand(todoExpanded.get(runtime.session) ?? false, phasesToMarkdown(phases)),
		get todoExpanded() {
			return todoExpanded.get(runtime.session) ?? false;
		},
		setTodoExpanded: expanded => expand(expanded),
		toggleTodoExpansion: () => expand(false),
		editMarkdown: markdown => runtime.ui.editor("Edit todos (Markdown)", markdown, { signal: runtime.signal }),
		copyMarkdown: async text => {
			await runtime.host.browserAction({ action: "copyText", text });
		},
	};
	await new TodoCommandController(host).handleTodoCommand(command.args);
	await Promise.all(pending);
	return commandConsumed(failed ? { failed: true } : undefined);
}

export async function handleWebGuiLocal(
	command: ParsedSlashCommand,
	runtime: WebGuiSlashCommandRuntime,
): Promise<SlashCommandResult> {
	const options = sessionLocalProtocolOptions(runtime.sessionManager);
	let resolveTarget: () => Promise<{ url: string; path: string }>;
	if (command.args.trim()) resolveTarget = () => resolveLocalEditorTarget(command.args, options);
	else {
		const files = await listLocalFiles(options);
		if (!files.length) {
			await runtime.output("No local:// files in this session yet.");
			return commandConsumed();
		}
		const file = await pick(runtime, "Edit local:// file", files, entry => entry.url);
		if (!file) return commandConsumed();
		resolveTarget = () => revalidateLocalEditorEntry(file, options);
	}
	const target = await resolveTarget();
	const original = await fs.readFile(target.path, "utf8");
	const edited = await runtime.ui.editor(`Edit ${target.url}`, original, { signal: runtime.signal });
	if (edited === undefined) return commandConsumed();
	// Resolve again after the dialog: neither symlink replacement nor a concurrent edit may silently redirect a save.
	const current = await resolveTarget();
	if (current.path !== target.path || (await fs.readFile(current.path, "utf8")) !== original)
		throw new Error("The local file changed while editing; reopen it before saving.");
	await fs.writeFile(current.path, edited, "utf8");
	await runtime.output(`Saved ${target.url}.`);
	return commandConsumed();
}

function entryLabel(entry: SessionEntry): string {
	if (isTranscriptEntry(entry)) {
		const message = transcriptEntryMessage(entry);
		return `${entry.id} · ${message?.role ?? entry.type} · ${message ? formatSessionHistoryMarkdown([message]).replace(/\s+/g, " ").slice(0, 180) : ""}`;
	}
	return `${entry.id} · ${entry.type}`;
}

export async function handleWebGuiBranch(
	command: ParsedSlashCommand,
	runtime: WebGuiSlashCommandRuntime,
): Promise<SlashCommandResult> {
	if (runtime.session.isStreaming)
		return usage("Wait for the current response to finish or abort it before navigating.", runtime);
	const entries =
		command.name === "tree"
			? runtime.sessionManager.getEntries()
			: runtime.sessionManager.getBranch().filter(isTranscriptEntry);
	if (!entries.length) {
		await runtime.output("No entries in session.");
		return commandConsumed();
	}
	const target = await pick(
		runtime,
		command.name === "tree" ? "Navigate session tree" : "Rewind to message (keep old branch)",
		entries,
		entry =>
			`${entry.id === runtime.sessionManager.getLeafId() ? "* " : ""}${runtime.sessionManager.getLabel(entry.id) ? `[${runtime.sessionManager.getLabel(entry.id)}] ` : ""}${entryLabel(entry)} · parent: ${entry.parentId ?? "root"}`,
	);
	if (!target) return commandConsumed();
	if (command.name === "tree") {
		const action = await runtime.ui.select(entryLabel(target), ["Navigate", "Rename label", "Remove label"], {
			signal: runtime.signal,
		});
		if (!action) return commandConsumed();
		if (action !== "Navigate") {
			const label =
				action === "Remove label"
					? ""
					: await runtime.ui.editor("Branch label", runtime.sessionManager.getLabel(target.id) ?? "", {
							signal: runtime.signal,
						});
			if (label === undefined) return commandConsumed();
			runtime.sessionManager.appendLabelChange(target.id, label.trim() || undefined);
			await runtime.output(label.trim() ? `Label updated: ${label.trim()}` : "Label removed.");
			return commandConsumed();
		}
	}
	let summarize = false;
	let customInstructions: string | undefined;
	if (command.name === "tree" && cfgBranchSummaryEnabled.get(runtime.settings)) {
		const choice = await runtime.ui.select(
			"Summarize the abandoned branch?",
			["No summary", "Summarize", "Custom summary instructions"],
			{ signal: runtime.signal },
		);
		if (!choice) return commandConsumed();
		summarize = choice !== "No summary";
		if (choice === "Custom summary instructions") {
			customInstructions = await runtime.ui.editor("Summary instructions", undefined, { signal: runtime.signal });
			if (customInstructions === undefined) return commandConsumed();
		}
	}
	const options = { summarize, customInstructions, requireIdle: true, allowAskReopen: command.name === "tree" };
	let result = await runtime.session.navigateTree(target.id, options);
	if (result.reopenAsk) {
		const tool = new AskTool({
			cwd: runtime.cwd,
			hasUI: true,
			settings: runtime.settings,
			getSessionFile: () => runtime.sessionManager.getSessionFile() ?? null,
			getSessionSpawns: () => null,
			getPlanModeState: () => runtime.session.getPlanModeState(),
		});
		try {
			const answer = await tool.execute(
				"tree-reanswer",
				{ questions: result.reopenAsk.questions },
				runtime.signal,
				undefined,
				runtime.session.buildAskReanswerContext(runtime.ui),
			);
			if (answer.details?.chatRedirect)
				return usage("Choose an answer instead of Chat about this when navigating the tree.", runtime);
			result = await runtime.session.navigateTree(target.id, { ...options, reanswerAskResult: answer });
		} catch (error) {
			if (error instanceof ToolAbortError) return commandConsumed();
			throw error;
		}
	}
	if (result.aborted) {
		await runtime.output("Branch summarization cancelled.");
		return commandConsumed();
	}
	if (result.cancelled) {
		await runtime.output("Navigation cancelled.");
		return commandConsumed();
	}
	if (result.editorText !== undefined)
		await runtime.host.browserAction({
			action: "setDraft",
			text: result.editorText,
			images: result.editorImages,
			onlyIfEmpty: command.name === "tree",
		});
	await runtime.output("Navigated to selected point; the previous path remains a branch.");
	if (result.askReanswerCommitted) runtime.session.resumeAfterAskReanswer();
	return commandConsumed();
}

export async function handleWebGuiExtensions(
	_command: ParsedSlashCommand,
	runtime: WebGuiSlashCommandRuntime,
): Promise<SlashCommandResult> {
	const dashboard = createExtensionDashboardRuntime({
		cwd: runtime.cwd,
		settings: runtime.settings,
		extensionRoots: () => runtime.session.effectiveExtensionRoots,
		mcpManager: runtime.mcpManager,
		onMcpToolsChanged: tools => runtime.session.refreshMCPTools(tools),
	});
	for (;;) {
		const section = await runtime.ui.select("Extension Control Center", ["Extensions", "Providers", "Close"], {
			signal: runtime.signal,
		});
		if (!section || section === "Close") return commandConsumed();
		if (section === "Providers") {
			const provider = await pick(
				runtime,
				"Select extension provider",
				dashboard.getProviders(),
				p => `${p.enabled ? "On" : "Off"} · ${p.displayName}`,
			);
			if (!provider) continue;
			const operation = await runtime.ui.select(
				provider.displayName,
				["Toggle provider", ...(provider.foreignUserSource ? ["Toggle user source"] : []), "Back"],
				{ signal: runtime.signal },
			);
			if (!operation || operation === "Back") continue;
			const enabled =
				operation === "Toggle provider"
					? dashboard.toggleProvider(provider.id)
					: dashboard.toggleUserSource(provider.id);
			if (!enabled) {
				const items = await dashboard.loadExtensions(dashboard.getDisabledExtensions());
				for (const item of items.filter(
					item =>
						item.kind === "mcp" &&
						item.source.provider === provider.id &&
						!isShadowedExtension(item) &&
						(operation === "Toggle provider" || item.source.level === "user"),
				))
					await dashboard.applyMcpToggle(item.name, false);
			}
		} else {
			const extension = await pick(
				runtime,
				"Select extension",
				await dashboard.loadExtensions(dashboard.getDisabledExtensions()),
				item => `${item.state} · ${item.kind} · ${item.displayName}`,
			);
			if (!extension) continue;
			await runtime.output(
				[extension.displayName, extension.description, extension.path, extension.disabledReason]
					.filter(Boolean)
					.join("\n"),
			);
			if (isShadowedExtension(extension)) continue;
			if (
				!(await runtime.ui.confirm(
					"Toggle extension",
					`${extension.state === "active" ? "Disable" : "Enable"} ${extension.displayName}?`,
					{ signal: runtime.signal },
				))
			)
				continue;
			const enable = extension.state !== "active";
			const disabled = dashboard.getDisabledExtensions();
			if (extension.kind === "mcp") {
				await dashboard.persistMcpToggle(
					extension.name,
					enable,
					["native", "mcp-json"].includes(extension.source.provider) ? extension.path : undefined,
				);
				await dashboard.applyMcpToggle(extension.name, enable);
			}
			dashboard.setDisabledExtensions(
				enable ? disabled.filter(id => id !== extension.id) : [...new Set([...disabled, extension.id])],
			);
		}
		await runtime.settings.flush();
		await runtime.reloadPlugins();
	}
}

export async function handleWebGuiAgents(
	_command: ParsedSlashCommand,
	runtime: WebGuiSlashCommandRuntime,
): Promise<SlashCommandResult> {
	const deps = createAgentsHubDeps(
		runtime.cwd,
		runtime.settings,
		runtime.session.modelRegistry,
		() => runtime.session.effectiveExtensionRoots,
	);
	for (;;) {
		const agents = await deps.loadAgents();
		const choice = await pick(
			runtime,
			"Agents · model, prewalk and advisor",
			[
				...agents.map(agent => ({
					agent,
					label: `${agent.disabled ? "Off" : "On"} · ${agent.name} · ${deps.effectiveModelPatterns(agent).join(", ")}`,
				})),
				{ agent: undefined, label: "Create agent" },
			],
			row => row.label,
		);
		if (!choice) return commandConsumed();
		if (!choice.agent) {
			const description = await runtime.ui.editor("Describe the agent to create", undefined, {
				signal: runtime.signal,
			});
			if (!description) continue;
			const generated = await deps.generateAgent(description, text => runtime.ui.notify(text));
			const edited = await runtime.ui.editor(
				"Review generated agent JSON (identifier, whenToUse, systemPrompt)",
				generated,
				{ signal: runtime.signal },
			);
			if (edited === undefined) continue;
			const spec: unknown = JSON.parse(edited.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ""));
			if (
				!spec ||
				typeof spec !== "object" ||
				!("identifier" in spec) ||
				typeof spec.identifier !== "string" ||
				!/^[a-z0-9]+(?:-[a-z0-9]+){1,5}$/.test(spec.identifier) ||
				!("whenToUse" in spec) ||
				typeof spec.whenToUse !== "string" ||
				!("systemPrompt" in spec) ||
				typeof spec.systemPrompt !== "string"
			)
				throw new Error("Invalid generated agent specification.");
			const scope = await runtime.ui.select("Save agent scope", ["project", "user"], { signal: runtime.signal });
			if (scope !== "project" && scope !== "user") continue;
			await runtime.output(
				await deps.saveAgent(scope, {
					identifier: spec.identifier,
					whenToUse: spec.whenToUse,
					systemPrompt: spec.systemPrompt,
				}),
			);
		} else {
			const agent = choice.agent;
			const property = await runtime.ui.select(
				agent.name,
				["Toggle enabled", "model", "prewalk", "advisor", "Inspect"],
				{ signal: runtime.signal },
			);
			if (!property) continue;
			if (property === "Inspect") {
				await runtime.output(`${agent.description}\n\n${agent.systemPrompt}`);
				continue;
			}
			if (property === "Toggle enabled") deps.setAgentDisabled(agent.name, { disabled: !agent.disabled });
			else if (property === "model" || property === "prewalk" || property === "advisor") {
				const current =
					property === "model"
						? agent.overrideModel
						: property === "prewalk"
							? agent.prewalkOverride
							: agent.advisorOverride;
				const value = await runtime.ui.editor(
					`${agent.name}: ${property} override (empty resets to default)`,
					current ?? "",
					{ signal: runtime.signal },
				);
				if (value === undefined) continue;
				deps.setAgentOverride(property, agent.name, value.trim() || undefined);
			}
		}
		await runtime.settings.flush();
	}
}

interface PendingLogin {
	provider: string;
	callback?: (value: string) => void;
}
const logins = new WeakMap<AgentSession, PendingLogin>();

async function loginInput(
	runtime: WebGuiSlashCommandRuntime,
	login: PendingLogin,
	title: string,
	placeholder?: string,
	signal = runtime.signal,
): Promise<string> {
	const callback = Promise.withResolvers<string>();
	login.callback = callback.resolve;
	const controller = new AbortController();
	const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
	try {
		return await Promise.race([
			callback.promise,
			runtime.ui.input(title, placeholder, { signal: combined, secret: true }).then(value => {
				if (value === undefined) throw new Error("Login cancelled");
				return value;
			}),
		]);
	} finally {
		login.callback = undefined;
		controller.abort();
	}
}

export async function handleWebGuiLogin(
	command: ParsedSlashCommand,
	runtime: WebGuiSlashCommandRuntime,
): Promise<SlashCommandResult> {
	const argument = command.args.trim();
	const pending = logins.get(runtime.session);
	if (pending) {
		if (argument && !isOAuthLoginSupported(argument) && pending.callback) {
			pending.callback(argument);
			return commandConsumed();
		}
		return usage(
			`OAuth login already in progress for ${pending.provider}. Complete the authorization dialog or submit /login <redirect URL>.`,
			runtime,
		);
	}
	if (argument && !isOAuthLoginSupported(argument))
		return usage("OAuth provider is not supported, or no login is waiting for a callback.", runtime);
	const providers = getOAuthProviders().filter(
		provider => !cfgDisabledProviders.get(runtime.settings).includes(provider.id),
	);
	const provider = argument
		? getOAuthProviders().find(provider => provider.id === argument)
		: await pick(runtime, "Login provider", providers, provider => `${provider.name} (${provider.id})`);
	if (!provider) return commandConsumed();
	const login: PendingLogin = { provider: provider.id };
	logins.set(runtime.session, login);
	runtime.runCommandInBackground(async () => {
		try {
			const identity = await runtime.session.modelRegistry.authStorage.oauth.login(provider.id, {
				signal: runtime.signal,
				onBrowserSession: captureBrowserSession,
				onAuth: info => {
					void runtime.host
						.browserAction({
							action: "openUrl",
							url: info.launchUrl ?? info.url,
							instructions: info.instructions,
						})
						.catch(error => runtime.session.emitNotice("error", String(error)));
				},
				onPrompt: prompt => loginInput(runtime, login, prompt.message, prompt.placeholder),
				onManualCodeInput: PASTE_CODE_LOGIN_PROVIDERS.has(provider.id)
					? signal => loginInput(runtime, login, "Paste authorization code or redirect URL", undefined, signal)
					: undefined,
			});
			await runtime.session.modelRegistry.refreshProvider(getOAuthCredentialProvider(provider.id), "online");
			await runtime.refreshCommands();
			await runtime.output(
				`Logged in to ${provider.name}${formatLoginIdentity(identity) ? ` as ${formatLoginIdentity(identity)}` : ""}.`,
			);
		} catch (error) {
			runtime.session.emitNotice("error", `Login failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			logins.delete(runtime.session);
		}
	});
	return commandConsumed();
}

export async function handleWebGuiGit(
	command: ParsedSlashCommand,
	runtime: WebGuiSlashCommandRuntime,
): Promise<SlashCommandResult> {
	const repo = vcs.requireGit(runtime.cwd);
	const revision = command.args.trim();
	const pinnedSha = revision ? await repo.resolveRef(revision, runtime.signal) : undefined;
	if (revision && !pinnedSha) throw new Error(`Cannot resolve revision: ${revision}`);
	const model = new GitModel(repo.info().repoRoot, { pinnedSha: pinnedSha ?? undefined });
	for (;;) {
		await model.refresh();
		await model.loadHeadFiles();
		const files = [...model.staged, ...model.unstaged, ...(model.clean ? (model.headCommit?.files ?? []) : [])];
		const actions = pinnedSha
			? ["Browse files", "Close"]
			: ["Browse files", "Stage all", "Unstage all", "Commit", "Amend commit", "Close"];
		const action = await runtime.ui.select(`Git · ${pinnedSha ?? model.branch ?? "detached HEAD"}`, actions, {
			signal: runtime.signal,
		});
		if (!action || action === "Close") return commandConsumed();
		if (action === "Stage all") {
			await model.stage();
			continue;
		}
		if (action === "Unstage all") {
			await model.unstage();
			continue;
		}
		if (action === "Commit" || action === "Amend commit") {
			const message = await runtime.ui.editor(
				action,
				action === "Amend commit"
					? [model.headCommit?.subject, model.headCommit?.body].filter(Boolean).join("\n\n")
					: "",
				{ signal: runtime.signal },
			);
			if (!message?.trim()) continue;
			await model.commit(message, { amend: action === "Amend commit" });
			await runtime.output("Commit created.");
			continue;
		}
		const file = await pick(runtime, "Git files", files, file => `${file.area} · ${file.kind} · ${file.path}`);
		if (!file) continue;
		const contents = await model.streamContents(file, () => {}, runtime.signal);
		if (contents.kind === "text") {
			const fence = markdownFenceFor(contents.oldText + contents.newText);
			await runtime.output(
				`### ${file.path}\n\nBefore:\n${fence}\n${contents.oldText}\n${fence}\n\nAfter:\n${fence}\n${contents.newText}\n${fence}`,
			);
		} else {
			const describe = (side: typeof contents.old) =>
				side.kind === "image"
					? `image (${side.image.widthPx}×${side.image.heightPx}, ${side.image.byteLength} bytes)`
					: JSON.stringify(side);
			await runtime.output(`${file.path}\nBefore: ${describe(contents.old)}\nAfter: ${describe(contents.new)}`);
		}
		if (pinnedSha || file.area === "commit") continue;
		const patchable = file.kind !== "untracked" && file.kind !== "conflicted" && contents.kind === "text";
		const operation = await runtime.ui.select(
			file.path,
			[
				file.area === "staged" ? "Unstage" : "Stage",
				...(patchable ? [file.area === "staged" ? "Unstage selected patch" : "Stage selected patch"] : []),
				"Discard",
				"Back",
			],
			{ signal: runtime.signal },
		);
		if (operation === "Stage") await model.stage([file]);
		if (operation === "Unstage") await model.unstage([file]);
		if (operation === "Stage selected patch" || operation === "Unstage selected patch") {
			const patch = await runtime.ui.editor(
				"Keep only the hunks to apply",
				await repo.diffText({ files: [file.path], cached: file.area === "staged" }, runtime.signal),
				{ signal: runtime.signal },
			);
			if (patch?.trim()) await model.applyPatch(patch, { cached: true, reverse: file.area === "staged" });
		}
		if (
			operation === "Discard" &&
			(await runtime.ui.confirm("Discard changes permanently", file.path, { signal: runtime.signal }))
		)
			await model.discard([file]);
	}
}

export async function handleWebGuiFork(
	command: ParsedSlashCommand,
	runtime: WebGuiSlashCommandRuntime,
): Promise<SlashCommandResult> {
	const argument = command.args.trim().toLowerCase();
	if (argument && !["pane", "window", "tab"].includes(argument))
		return usage("Usage: /fork [pane|window|tab]", runtime);
	const allowBusySnapshot = Boolean(argument) && runtime.session.isBusyForSnapshot;
	if (
		allowBusySnapshot &&
		!(await runtime.ui.confirm(
			"Fork while a response is running?",
			"The child may not include the partial response. The current session will keep running here.",
			{ signal: runtime.signal },
		))
	)
		return commandConsumed();
	const fork = await forkWebGuiNativeSession(runtime.session, { allowBusySnapshot });
	await runtime.host.browserAction({
		action: "openSession",
		sessionId: fork.sessionId,
		...(argument ? { placement: argument === "pane" ? ("pane" as const) : ("window" as const) } : {}),
	});
	await runtime.output(`Session forked: ${fork.sessionId}. Original session preserved.`);
	return commandConsumed();
}

export async function handleWebGuiSession(
	command: ParsedSlashCommand,
	runtime: WebGuiSlashCommandRuntime,
	pin: (argument: string, session: AgentSession, output: WebGuiSlashCommandRuntime["output"]) => Promise<void>,
): Promise<SlashCommandResult> {
	const { verb, rest } = parseSubcommand(command.args);
	if (!verb || (verb === "info" && !rest)) {
		await runtime.output(
			[
				`Session: ${runtime.session.sessionId}`,
				`Title: ${runtime.session.sessionName}`,
				`CWD: ${runtime.cwd}`,
				JSON.stringify(runtime.session.getSessionStats(), null, 2),
			].join("\n"),
		);
		return commandConsumed();
	}
	if (verb === "pin") {
		if (rest) {
			await pin(rest, runtime.session, runtime.output);
			return commandConsumed();
		}
		if (runtime.session.isStreaming) return usage("Cannot pin an account while the session is streaming.", runtime);
		const list = await runtime.session.listCurrentProviderOAuthAccounts();
		if (!list || !list.accounts.length) {
			await pin("", runtime.session, runtime.output);
			return commandConsumed();
		}
		const account = await pick(
			runtime,
			`Pin ${list.provider} account to this session`,
			toSessionPinAccounts(list.accounts),
			account => `${account.position + 1}. ${account.label}${account.active ? " (active)" : ""}`,
		);
		if (account) await pin(`OAuth credential #${account.credentialId}`, runtime.session, runtime.output);
		return commandConsumed();
	}
	if (verb === "delete" && !rest) {
		if (runtime.session.isStreaming) return usage("Cannot delete the session while streaming.", runtime);
		if (!runtime.sessionManager.getSessionFile())
			return usage("No session file to delete (in-memory session).", runtime);
		if (
			!(await runtime.ui.confirm(
				"Delete session permanently",
				"Delete this session and its artifacts, then return to the session selector?",
				{ signal: runtime.signal },
			))
		)
			return commandConsumed();
		await runtime.host.deleteCurrentSession({ selectAfter: true });
		return commandConsumed();
	}
	return usage("Usage: /session [info|delete|pin [account]]", runtime);
}

export async function handleWebGuiUsage(
	command: ParsedSlashCommand,
	runtime: WebGuiSlashCommandRuntime,
	reset: (argument: string, session: AgentSession, output: WebGuiSlashCommandRuntime["output"]) => Promise<void>,
	report: (runtime: WebGuiSlashCommandRuntime) => Promise<string>,
): Promise<SlashCommandResult> {
	const { verb, rest } = parseSubcommand(command.args);
	if (!verb || (verb === "show" && !rest)) {
		await runtime.output(await report(runtime));
		return commandConsumed();
	}
	if (verb !== "reset") return usage("Usage: /usage [show|reset [provider/credential-id|provider/active]]", runtime);
	if (rest) {
		await reset(rest, runtime.session, runtime.output);
		return commandConsumed();
	}
	const accounts = toResetUsageAccounts(await runtime.session.listResetCredits());
	const available = accounts.filter(account => account.availableCount > 0);
	if (!available.length) {
		await runtime.output("No saved rate-limit resets available to spend right now.");
		return commandConsumed();
	}
	const selected = await pick(
		runtime,
		"Spend a saved rate-limit reset",
		available,
		account => `${account.providerLabel} · ${account.label} · ${account.availableCount} saved`,
	);
	if (selected)
		await runtime.output(
			describeRedeemOutcome(await runtime.session.redeemResetCredit(selected.target), selected.label),
		);
	return commandConsumed();
}

export async function handleWebGuiHub(
	_command: ParsedSlashCommand,
	runtime: WebGuiSlashCommandRuntime,
): Promise<SlashCommandResult> {
	const directory = new NativeChildDirectory(runtime.session);
	const context = webGuiSessionContext(runtime.session);
	let parentSessionId = runtime.session.sessionId;
	try {
		for (;;) {
			const projection = await directory.projection(context, parentSessionId);
			if (!projection.childSessionIds.length) {
				await runtime.output("No subagents in this session.");
				if (parentSessionId === runtime.session.sessionId) return commandConsumed();
				parentSessionId = runtime.session.sessionId;
				continue;
			}
			const children = await Promise.all(projection.childSessionIds.map(id => directory.resolve(context, id)));
			const child = await pick(
				runtime,
				"Agent Hub · live and completed subagents",
				children,
				child => `${child.nativeAgentId} · ${child.status} · ${child.summary ?? child.subagentType}`,
			);
			if (!child) return commandConsumed();
			const operation = await runtime.ui.select(
				child.nativeAgentId,
				[
					"Read transcript",
					"Open conversation",
					"Browse subagents",
					"Back to root",
					...(child.session ? ["Abort current operation"] : []),
					"Refresh",
				],
				{ signal: runtime.signal },
			);
			if (operation === "Read transcript") {
				const messages = await directory.messages(context, child.childSessionId);
				await runtime.output(formatSessionHistoryMarkdown(messages));
			} else if (operation === "Open conversation") {
				await runtime.host.browserAction({ action: "openSession", sessionId: child.childSessionId });
			} else if (operation === "Browse subagents") {
				parentSessionId = child.childSessionId;
			} else if (operation === "Back to root") {
				parentSessionId = runtime.session.sessionId;
			} else if (
				operation === "Abort current operation" &&
				(await runtime.ui.confirm("Abort subagent", child.nativeAgentId, { signal: runtime.signal }))
			) {
				const current = await directory.resolve(context, child.childSessionId);
				if (!current.session) throw new Error("The selected subagent is no longer live.");
				await current.session.abort();
			}
		}
	} finally {
		directory.dispose();
	}
}
