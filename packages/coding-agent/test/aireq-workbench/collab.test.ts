import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import type { HostFrame } from "@oh-my-pi/pi-wire";
import { AgentStorage } from "../../src/session/agent-storage";
import { HistoryStorage } from "../../src/session/history-storage";
import { closeSessionIndex } from "../../src/session/session-index";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { startIntranetRelay } from "../../src/collab/relay-server";
import * as registry from "../../src/collab/registry";
import { createAgentSession } from "../../src/sdk";
import type { AgentSession, AgentSessionEvent } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import { bashExecutionToText, pythonExecutionToText } from "../../src/session/messages";
import {
	runWebGuiCollab,
	runWebGuiJoin,
	runWebGuiLeave,
} from "../../src/aireq-workbench/native/native-command-collaboration";
import {
	type AIReqNativeCollabProjection,
	aiReqNativeCollabProjection,
} from "../../src/aireq-workbench/native/native-collab-projection";
import {
	nativeWebGuiQuestions,
	withNativeWebGuiInteractionScope,
} from "../../src/aireq-workbench/native/native-interactions";
import { AIReqWorkflowHost } from "../../src/aireq-workbench/workflow-host";
import type { ParsedSlashCommand, WebGuiBrowserAction } from "../../src/slash-commands/types";
import { contentText } from "../spec-driven/provider-fixture";
import { WorkflowConsumerFixture, pollWorkflow } from "./workflow-fixture";

function command(name: string, args = ""): ParsedSlashCommand {
	return { name, args, text: `/${name}${args ? ` ${args}` : ""}` };
}
function messages(session: AgentSession): string {
	return session.sessionManager
		.getBranch()
		.filter(entry => entry.type === "message")
		.map(entry => {
			const message = entry.message;
			if (message.role === "bashExecution") return bashExecutionToText(message);
			if (message.role === "pythonExecution") return pythonExecutionToText(message);
			if (message.role === "fileMention") return message.files.map(file => file.content).join("\n");
			if (message.role === "branchSummary" || message.role === "compactionSummary") return message.summary;
			return contentText(message.content);
		})
		.join("\n");
}
function remoteMessages(projection: AIReqNativeCollabProjection, browserId: string): string {
	return (
		projection
			.read(browserId)
			?.entries.map(entry => {
				if (entry.type === "message") return contentText(entry.message.content);
				if (entry.type === "custom_message" && entry.customType === "collab-prompt")
					return contentText(entry.content);
				return "";
			})
			.join("\n") ?? ""
	);
}

/** Real copied native commands own the relay; guest bytes never enter the local native journal. */
async function fixture(held?: { marker: string; entered: PromiseWithResolvers<void>; release: Promise<void> }) {
	const owned = await WorkflowConsumerFixture.create({
		reply: async request => {
			if (
				held &&
				request.messages.some(
					message => message.role === "user" && contentText(message.content).includes(held.marker),
				)
			) {
				held.entered.resolve();
				await held.release;
			}
			return { text: "Actual shared native response" };
		},
	});
	const originalOffline = process.env.OMP_OFFLINE;
	process.env.OMP_OFFLINE = "1";
	const relay = startIntranetRelay({ hostname: "127.0.0.1", port: 0 });
	const publish = registry.publishCollabHost;
	const publication = spyOn(registry, "publishCollabHost").mockImplementation((source, options) =>
		publish(source, { ...options, dir: path.join(owned.root, "collab-registry") }),
	);
	const members: Array<{ close(): Promise<void> }> = [];
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
	if (!model) throw new Error("Shared native model unavailable");
	const directory = path.join(owned.root, "native-sessions");
	const manager = await SessionManager.open(path.join(directory, "root.jsonl"), directory, undefined, {
		initialCwd: owned.project,
	});
	const { session: root } = await createAgentSession({
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
	const workflow = new AIReqWorkflowHost({ cwd: owned.project, rootSession: root, settings });
	await workflow.initialize();
	const projectId = (await workflow.store.listProjects())[0]!.id;
	const released = await workflow.command("fixture", {
		type: "createRelease",
		projectId,
		title: "Native collaboration",
		expectedRevision: (await workflow.view(projectId)).revision,
		operationId: crypto.randomUUID(),
	});
	if (released.status !== "completed") throw new Error(`Native collaboration Release failed: ${released.error}`);
	const releaseId = (await workflow.view(projectId)).releases.at(-1)!.id;
	async function member(name: string) {
		const created = await workflow.command(name, {
			type: "createBrowserDraft",
			projectId,
			releaseId,
			expectedRevision: (await workflow.view(projectId)).revision,
			operationId: crypto.randomUUID(),
		});
		if (created.status !== "completed") throw new Error(`Native collaboration draft failed: ${created.error}`);
		const object = { projectId, irId: created.irId! };
		await workflow.bind(name, object);
		const ref = await workflow.prepare(name, object);
		const session = (await workflow.project(projectId)).runtime.session(ref);
		const context = await workflow.nativeContext(name, projectId);
		const prompt = (text: string) => workflow.runNativeInput(session, () => session.prompt(text), text);
		await prompt(`Retain the local ${name} conversation before joining any shared session.`);
		const output: string[] = [];
		const actions: WebGuiBrowserAction[] = [];
		const frames: HostFrame[] = [];
		const localEvents: AgentSessionEvent[] = [];
		const projection = aiReqNativeCollabProjection(session);
		const unsubscribe = projection.subscribe(name, event => {
			if (event.frame) frames.push(event.frame);
		});
		const unsubscribeLocal = session.subscribe(event => localEvents.push(event));
		const shutdown = new Set<() => Promise<void>>();
		const runtime = {
			session,
			get sessionManager() {
				return session.sessionManager;
			},
			settings,
			cwd: session.sessionManager.getCwd(),
			ui: nativeWebGuiQuestions(session).ui,
			output: (text: string) => {
				output.push(text);
			},
			registerHostShutdown(dispose: () => Promise<void>) {
				shutdown.add(dispose);
				return () => shutdown.delete(dispose);
			},
			host: {
				browserAction: async (action: WebGuiBrowserAction) => {
					actions.push(action);
					return {};
				},
			},
		};
		const call = (
			operation: typeof runWebGuiCollab | typeof runWebGuiJoin | typeof runWebGuiLeave,
			parsed: ParsedSlashCommand,
		) =>
			withNativeWebGuiInteractionScope({ connectionId: context.connectionId, sessionId: session.sessionId }, () =>
				operation(parsed, runtime),
			);
		const result = {
			session,
			projection,
			prompt,
			output,
			actions,
			frames,
			localEvents,
			call,
			async close() {
				for (const stop of shutdown) await stop();
				unsubscribe();
				unsubscribeLocal();
			},
		};
		members.push(result);
		return result;
	}
	return {
		owned,
		relay,
		member,
		async [Symbol.asyncDispose]() {
			try {
				for (const member of members.toReversed()) await member.close();
				await workflow.close();
				await workflow.release();
				await root.dispose();
				await models.awaitBackgroundRefresh();
				auth.close();
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
					if (originalOffline === undefined) delete process.env.OMP_OFFLINE;
					else process.env.OMP_OFFLINE = originalOffline;
				}
			}
		},
	};
}

test("AIReq native offline share/join preserves local journals and leaving a guest never stops the real owner", async () => {
	const marker = `shared-native-input-${crypto.randomUUID()}`;
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	await using f = await fixture({ marker, entered, release: release.promise });
	using _releaseOnFailure = { [Symbol.dispose]: () => release.resolve() };
	const owner = await f.member("owner");
	const alice = await f.member("alice");
	const bob = await f.member("bob");
	await owner.prompt("Native share baseline");
	const aliceOriginal = {
		id: alice.session.sessionId,
		file: alice.session.sessionFile!,
		bytes: await fs.readFile(alice.session.sessionFile!, "utf8"),
	};
	const bobOriginal = {
		id: bob.session.sessionId,
		file: bob.session.sessionFile!,
		bytes: await fs.readFile(bob.session.sessionFile!, "utf8"),
	};
	expect(await owner.call(runWebGuiCollab, command("collab", "start"))).toMatchObject({ consumed: true });
	const username = owner.output.join("\n").match(/Join with \/join (\S+)/u)?.[1];
	if (!username) throw new Error("Native offline adapter did not expose its username join entry");
	await alice.call(runWebGuiJoin, command("join", username));
	await bob.call(runWebGuiJoin, command("join", username));
	const aliceTarget = alice.projection.read("alice")!.participant!;
	const bobTarget = bob.projection.read("bob")!.participant!;
	expect(aliceTarget.canWrite).toBe(true);
	expect(bobTarget.canWrite).toBe(true);
	expect(remoteMessages(alice.projection, "alice")).toContain("Native share baseline");
	expect(remoteMessages(bob.projection, "bob")).toContain("Native share baseline");
	expect(alice.session.sessionId).toBe(aliceOriginal.id);
	expect(bob.session.sessionId).toBe(bobOriginal.id);
	expect(alice.actions).toEqual([]);
	expect(bob.actions).toEqual([]);
	const hosts = await registry.listCollabHosts({ dir: path.join(f.owned.root, "collab-registry") });
	expect(hosts).toHaveLength(1);
	expect(hosts[0]!.sessionId).toBe(owner.session.sessionId);
	expect(hosts[0]!.participants).toBe(3);
	const bobLocalEvents = bob.localEvents.length;
	await alice.projection.sendFrame("alice", aliceTarget, { t: "prompt", text: marker });
	await entered.promise;
	expect(owner.session.isStreaming).toBe(true);
	expect(
		f.owned.provider.requests.filter(request =>
			request.messages.some(message => message.role === "user" && contentText(message.content).includes(marker)),
		),
	).toHaveLength(1);
	await alice.call(runWebGuiLeave, command("leave"));
	expect(alice.projection.read("alice")).toBeNull();
	expect(bob.projection.read("bob")?.status).toBe("joined");
	expect(owner.session.isStreaming).toBe(true);
	release.resolve();
	await pollWorkflow(
		async () => ({ text: remoteMessages(bob.projection, "bob"), busy: owner.session.isStreaming }),
		value => !value.busy && value.text.includes(marker),
		"Shared native owner settlement after guest leave",
	);
	const aliceFramesAfterLeave = alice.frames.length;
	const late = `owner-after-guest-leave-${crypto.randomUUID()}`;
	await owner.prompt(late);
	await pollWorkflow(
		async () => remoteMessages(bob.projection, "bob"),
		value => value.includes(late),
		"Remaining guest projection update",
	);
	expect(alice.frames).toHaveLength(aliceFramesAfterLeave);
	expect(bob.localEvents).toHaveLength(bobLocalEvents);
	expect(messages(alice.session)).not.toContain(marker);
	expect(messages(bob.session)).not.toContain(marker);
	expect(await fs.readFile(aliceOriginal.file, "utf8")).toBe(aliceOriginal.bytes);
	expect(await fs.readFile(bobOriginal.file, "utf8")).toBe(bobOriginal.bytes);
	expect(
		await alice.projection.sendFrame("alice", aliceTarget, { t: "prompt", text: "late forbidden input" }),
	).toMatchObject({ kind: "rejected" });
	await bob.call(runWebGuiLeave, command("leave"));
	expect(bob.session.sessionId).toBe(bobOriginal.id);
	expect(owner.session.isDisposed).toBe(false);
	expect(f.owned.provider.failures).toEqual([]);
}, 180_000);

test("AIReq native view-only projection cannot prompt and closed-room capabilities never adopt local history", async () => {
	await using f = await fixture();
	const owner = await f.member("owner");
	const viewer = await f.member("viewer");
	const late = await f.member("late");
	await owner.prompt("Owner published native history");
	await owner.call(runWebGuiCollab, command("collab", "start"));
	const hosts = await registry.listCollabHosts({ dir: path.join(f.owned.root, "collab-registry") });
	const host = hosts[0]!;
	const view = await registry.resolveCollabHostLink(host.instanceId, "view", {
		dir: path.join(f.owned.root, "collab-registry"),
	});
	const control = await registry.resolveCollabHostLink(host.instanceId, "control", {
		dir: path.join(f.owned.root, "collab-registry"),
	});
	const viewerId = viewer.session.sessionId;
	await viewer.call(runWebGuiJoin, command("join", view.url));
	const target = viewer.projection.read("viewer")!.participant!;
	expect(target.canWrite).toBe(false);
	const count = f.owned.provider.requests.length;
	expect(
		await viewer.projection.sendFrame("viewer", target, { t: "prompt", text: "forbidden-viewer-input" }),
	).toMatchObject({ kind: "rejected" });
	expect(f.owned.provider.requests).toHaveLength(count);
	expect(messages(owner.session)).not.toContain("forbidden-viewer-input");
	await owner.call(runWebGuiCollab, command("collab", "stop"));
	await pollWorkflow(
		async () => viewer.projection.read("viewer")?.status,
		value => value === undefined || value === "disconnected",
		"Closed native room projection cleanup",
	);
	expect(viewer.session.sessionId).toBe(viewerId);
	const localId = late.session.sessionId;
	await expect(late.call(runWebGuiJoin, command("join", control.url))).rejects.toThrow();
	expect(late.session.sessionId).toBe(localId);
	expect(late.projection.read("late")?.participant ?? null).toBeNull();
	expect(f.owned.provider.requests).toHaveLength(count);
}, 180_000);
