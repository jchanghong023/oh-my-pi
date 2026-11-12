import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { AgentStorage } from "../../src/session/agent-storage";
import { HistoryStorage } from "../../src/session/history-storage";
import { closeSessionIndex } from "../../src/session/session-index";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { startIntranetRelay } from "../../src/collab/relay-server";
import { CollabHost, subscribeCollabEntries } from "../../src/collab/host";
import * as registry from "../../src/collab/registry";
import { createAgentSession } from "../../src/sdk";
import type { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import { runWebGuiJoin, runWebGuiLeave } from "../../src/aireq-workbench/native/native-command-collaboration";
import {
	AIReqNativeCollabProjection,
	bindAIReqNativeCollabProjection,
	type AIReqNativeCollabUpdate,
} from "../../src/aireq-workbench/native/native-collab-projection";
import {
	nativeWebGuiQuestions,
	withNativeWebGuiInteractionScope,
} from "../../src/aireq-workbench/native/native-interactions";
import type { ParsedSlashCommand } from "../../src/slash-commands/types";
import { contentText, type ModelRequest, type Reply } from "../spec-driven/provider-fixture";
import { WorkflowConsumerFixture, pollWorkflow } from "./workflow-fixture";

interface NativeCollabMember {
	session: AgentSession;
	settings: Settings;
}

const command = (name: string, args = ""): ParsedSlashCommand => ({ name, args, text: `/${name} ${args}` });
const journal = (session: AgentSession) => fs.readFile(session.sessionFile!, "utf8");

async function fixture(reply: (request: ModelRequest) => Reply | Promise<Reply>) {
	const owned = await WorkflowConsumerFixture.create({ reply });
	const offline = process.env.OMP_OFFLINE;
	process.env.OMP_OFFLINE = "1";
	const relay = startIntranetRelay({ hostname: "127.0.0.1", port: 0 });
	const publish = registry.publishCollabHost;
	const publication = spyOn(registry, "publishCollabHost").mockImplementation((source, options) =>
		publish(source, { ...options, dir: path.join(owned.root, "collab-registry") }),
	);
	const disposers: Array<() => Promise<void>> = [];
	async function member(name: string) {
		const agentDir = path.join(owned.root, "config/profiles/acceptance/agent");
		const settings = await Settings.loadIsolated({
			cwd: owned.project,
			agentDir,
			inMemory: true,
			overrides: {
				modelRoles: { default: "deepseek/deepseek-v4-flash", smol: "deepseek/deepseek-v4-flash" },
				"collab.relayUrl": relay.url,
				"collab.autoStart": "off",
				"compaction.enabled": false,
				"prewalk.enabled": false,
				"todo.enabled": false,
				"async.enabled": false,
				"tools.xdev": false,
			},
		});
		const auth = await AuthStorage.create(":memory:");
		const models = new ModelRegistry(auth, path.join(agentDir, "models.yml"), { settings });
		const model = models.find("deepseek", "deepseek-v4-flash");
		if (!model) throw new Error("Native fixture model unavailable");
		const directory = path.join(owned.root, "sessions", name);
		const manager = await SessionManager.open(path.join(directory, "root.jsonl"), directory, undefined, {
			initialCwd: owned.project,
		});
		const { session } = await createAgentSession({
			cwd: owned.project,
			agentDir,
			settings,
			authStorage: auth,
			modelRegistry: models,
			model,
			sessionManager: manager,
			agentRegistry: new AgentRegistry(),
			contextFiles: [],
			rules: [],
			skills: [],
			promptTemplates: [],
			slashCommands: [],
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableLsp: false,
			autoTitle: false,
			offline: true,
			bindProcessState: false,
		});
		const updates: AIReqNativeCollabUpdate[] = [];
		const projection = new AIReqNativeCollabProjection({
			settings,
			resolveBrowserId: id => id,
			onUpdate: (_id, event) => updates.push(event),
		});
		const unbind = bindAIReqNativeCollabProjection(session, projection);
		const shutdown = new Set<() => Promise<void>>();
		const runtime = {
			session,
			get sessionManager() {
				return session.sessionManager;
			},
			settings,
			cwd: owned.project,
			ui: nativeWebGuiQuestions(session).ui,
			output: () => {},
			registerHostShutdown(dispose: () => Promise<void>) {
				shutdown.add(dispose);
				return () => shutdown.delete(dispose);
			},
			host: {
				browserAction: async () => {
					throw new Error("Guest must never navigate local actor identity");
				},
			},
		};
		const call = (operation: typeof runWebGuiJoin | typeof runWebGuiLeave, parsed: ParsedSlashCommand) =>
			withNativeWebGuiInteractionScope({ connectionId: name, sessionId: session.sessionId }, () =>
				operation(parsed, runtime),
			);
		disposers.push(async () => {
			for (const stop of shutdown) await stop();
			await projection.close();
			unbind();
			await session.dispose();
			await models.awaitBackgroundRefresh();
			auth.close();
		});
		return { session, settings, projection, updates, call, name };
	}
	async function host(participant: NativeCollabMember) {
		const { session, settings } = participant;
		const host = new CollabHost({
			nativePort: {
				session,
				sessionManager: session.sessionManager,
				settings,
				eventBus: session.eventBus,
				subagentEventBus: session.subagentEventBus,
				subscribeEntries: listener => subscribeCollabEntries(session.sessionManager, listener),
				getContextUsage: () => ({ tokens: 0, contextWindow: modelContext(session) }),
				showStatus: () => {},
			},
		});
		await host.start(relay.url);
		disposers.push(() => host.stop("fixture ended"));
		return host;
	}
	return {
		owned,
		member,
		host,
		async [Symbol.asyncDispose]() {
			try {
				for (const dispose of disposers.toReversed()) await dispose();
			} finally {
				publication.mockRestore();
				relay.stop();
				HistoryStorage.close();
				closeSessionIndex();
				AgentStorage.close();
				closeModelCache();
				try {
					await owned.close();
				} finally {
					if (offline === undefined) delete process.env.OMP_OFFLINE;
					else process.env.OMP_OFFLINE = offline;
				}
			}
		},
	};
}
const modelContext = (session: AgentSession) => session.model?.contextWindow ?? 0;

test("native guest join/leave cannot adopt or cancel its locally owned running journal", async () => {
	const held = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const localMarker = `local-owned-${crypto.randomUUID()}`;
	const remoteMarker = `remote-tool-${crypto.randomUUID()}`;
	let readPath = "";
	await using f = await fixture(async request => {
		const user = contentText(request.messages.findLast(message => message.role === "user")?.content);
		if (user.includes(localMarker)) {
			entered.resolve();
			await held.promise;
		}
		if (user.includes(remoteMarker) && request.messages.at(-1)?.role !== "tool")
			return { tool: { name: "read", args: { path: readPath } } };
		return { text: "Native collaboration fixture response" };
	});
	readPath = path.join(f.owned.project, "user-file.txt");
	using _releaseOnFailure = { [Symbol.dispose]: () => held.resolve() };
	const owner = await f.member("owner");
	const local = await f.member("guest");
	await owner.session.prompt("Remote native baseline");
	const host = await f.host(owner);
	const localJob = local.session.prompt(localMarker);
	await entered.promise;
	const identity = {
		id: local.session.sessionId,
		generation: local.session.sessionGeneration,
		file: local.session.sessionFile,
		manager: local.session.sessionManager,
	};
	const before = await journal(local.session);
	await local.call(runWebGuiJoin, command("join", host.link));
	const target = local.projection.read(local.name)!.participant!;
	expect(target.sessionId).toBe(owner.session.sessionId);
	expect(target.sessionId).not.toBe(identity.id);
	expect(local.session.sessionId).toBe(identity.id);
	expect(local.session.sessionGeneration).toBe(identity.generation);
	expect(local.session.sessionFile).toBe(identity.file);
	expect(local.session.sessionManager).toBe(identity.manager);
	expect(await journal(local.session)).toBe(before);
	expect(local.session.isStreaming).toBe(true);
	expect(
		local.projection
			.conversation(local.name, target)
			.rows.window.some(row => row.kind === "userInput" && row.text.includes("Remote native baseline")),
	).toBe(true);
	expect(await local.projection.sendFrame(local.name, target, { t: "prompt", text: remoteMarker })).toMatchObject({
		kind: "unknown",
	});
	await pollWorkflow(
		async () => local.projection.conversation(local.name, target),
		view =>
			view.rows.window.some(
				row =>
					row.kind === "toolCall" && row.status === "success" && row.output?.text.includes("retain user bytes"),
			),
		"Remote native read result projects to copied V4",
	);
	expect(
		local.updates.some(update => update.frame?.t === "event" && update.frame.event.type === "tool_execution_start"),
	).toBe(true);
	await local.call(runWebGuiLeave, command("leave"));
	expect(local.session.isStreaming).toBe(true);
	expect(await journal(local.session)).toBe(before);
	expect(local.projection.read(local.name)).toBeNull();
	await local.call(runWebGuiJoin, command("join", host.link));
	const replacement = local.projection.read(local.name)!.participant!;
	expect(replacement.peerId).not.toBe(target.peerId);
	expect(await local.projection.sendFrame(local.name, target, { t: "abort" })).toMatchObject({ kind: "rejected" });
	await expect(local.projection.leave(local.name, target)).rejects.toThrow("stale");
	expect(local.projection.read(local.name)!.participant).toEqual(replacement);
	await local.call(runWebGuiLeave, command("leave"));
	const count = local.updates.length;
	await owner.session.prompt("Remote after guest leave must not mutate local projection");
	expect(local.updates).toHaveLength(count);
	held.resolve();
	await localJob;
	expect(local.session.sessionId).toBe(identity.id);
	expect(await journal(local.session)).toContain(localMarker);
	expect(await journal(local.session)).not.toContain(remoteMarker);
	expect(await journal(local.session)).not.toContain("Remote native baseline");
}, 180_000);

test("real encrypted native asks enforce exact target, authority and ended-request boundaries", async () => {
	await using f = await fixture(async () => ({ text: "Native owner reply" }));
	const owner = await f.member("ask-owner");
	const writer = await f.member("writer");
	const viewer = await f.member("viewer");
	await owner.session.prompt("Published native history");
	const host = await f.host(owner);
	await writer.call(runWebGuiJoin, command("join", host.link));
	await viewer.call(runWebGuiJoin, command("join", host.viewLink));
	const target = writer.projection.read(writer.name)!.participant!;
	const viewTarget = viewer.projection.read(viewer.name)!.participant!;
	expect(viewTarget.canWrite).toBe(false);
	expect(viewer.projection.conversation(viewer.name, viewTarget).inputRouting.mode).toBe("reject");
	expect(await viewer.projection.sendFrame(viewer.name, viewTarget, { t: "prompt", text: "forbidden" })).toMatchObject(
		{ kind: "rejected" },
	);
	const ask = host.requestGuestUi({
		kind: "select",
		title: "Real native decision",
		options: ["Accept", "Reject", "Done"],
		selectionMarker: "checkbox",
		checkedIndices: [0],
		markableCount: 2,
		initialIndex: 1,
		helpText: "Select one native action",
	});
	const pending = await pollWorkflow(
		async () => writer.projection.read(writer.name)!.uiRequests,
		requests => requests.length === 1,
		"Native remote question",
	);
	const reqId = pending[0]!.reqId;
	const conversation = writer.projection.conversation(writer.name, target);
	expect(conversation.pendingInteractions[0]?.payload.kind).toBe("userInput");
	const payload = conversation.pendingInteractions[0]!.payload;
	if (payload.kind !== "userInput") throw new Error("Native selector lost its interaction kind");
	expect(payload.input).toMatchObject({
		kind: "collab-native-selector",
		checkedIndices: [0],
		markableCount: 2,
		initialIndex: 1,
	});
	expect(payload.options?.map(option => option.label)).toEqual(["[x] Accept", "[ ] Reject", "Done"]);
	expect(payload.prompt).toContain("Select one native action");
	expect(
		await writer.projection.sendFrame(
			writer.name,
			{ ...target, generation: target.generation + 1 },
			{ t: "ui-response", reqId, value: "Reject" },
		),
	).toMatchObject({ kind: "rejected" });
	expect(
		await writer.projection.sendFrame(writer.name, target, { t: "ui-response", reqId, value: "Accept" }),
	).toMatchObject({ kind: "unknown" });
	expect(await ask).toEqual({ kind: "answered", value: "Accept" });
	await pollWorkflow(
		async () => writer.projection.read(writer.name)!.uiRequests,
		requests => requests.length === 0,
		"Native question ended",
	);
	expect(
		await writer.projection.sendFrame(writer.name, target, { t: "ui-response", reqId, value: "Reject" }),
	).toMatchObject({ kind: "rejected" });
	await host.stop("Remote room ended");
	await pollWorkflow(
		async () => writer.projection.read(writer.name)?.status,
		status => status === "disconnected",
		"Remote disconnect retires input",
	);
	expect(await writer.projection.sendFrame(writer.name, target, { t: "abort" })).toMatchObject({ kind: "rejected" });
	expect(owner.session.isDisposed).toBe(false);
}, 180_000);
