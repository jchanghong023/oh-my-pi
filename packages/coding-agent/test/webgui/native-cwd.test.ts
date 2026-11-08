import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgTemperature } from "@oh-my-pi/pi-coding-agent/session/settings";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { NativeChatRuntime } from "../../src/webgui/native-chat";
import { NativeCwdHost } from "../../src/webgui/native-cwd";
import { acquireBrowserProject, readBrowserProject } from "../../src/webgui/project-registry";
import type { WebGuiServiceContext } from "../../src/webgui/rpc-contract";
import { readWebGuiSessionInfo } from "../../src/webgui/session-source";
import { createAssistantMessage, createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { getTestModel } from "../helpers/model-fixtures";

function history(manager: SessionManager): SessionInfo {
	const path = manager.getSessionFile();
	if (!path) throw new Error("Missing native fixture journal");
	return {
		id: manager.getSessionId(),
		path,
		cwd: manager.getCwd(),
		created: new Date(),
		modified: new Date(),
		messageCount: 2,
		size: 0,
		firstMessage: "Saved history",
		allMessagesText: "Saved history",
	};
}

async function fixture(temp: TempDir, unavailableModel = false) {
	const cwdA = temp.join("source");
	const cwdB = temp.join("target");
	for (const [cwd, temperature, marker] of [
		[cwdA, 0.2, "SOURCE"],
		[cwdB, 0.8, "TARGET"],
	] as const) {
		await mkdir(getProjectAgentDir(cwd), { recursive: true });
		await writeFile(`${getProjectAgentDir(cwd)}/config.yml`, `temperature: ${temperature}\n`);
		await writeFile(`${cwd}/marker.txt`, marker);
	}
	const source = SessionManager.create(cwdA, temp.join("source-journals"));
	const target = SessionManager.create(cwdB, temp.join("target-journals"));
	const model = getTestModel("ascend");
	const { contextWindow, maxTokens } = model;
	if (contextWindow === null || maxTokens === null)
		throw new Error("Native cwd fixture requires explicit model limits");
	const savedModel = { ...model, id: "native-cwd-target" };
	for (const [manager, journalModel] of [
		[source, model],
		[target, savedModel],
	] as const) {
		manager.appendMessage({ role: "user", content: "Saved history", timestamp: Date.now() });
		manager.appendMessage({
			...createAssistantMessage("Saved reply"),
			api: journalModel.api,
			provider: journalModel.provider,
			model: journalModel.id,
		});
	}
	if (unavailableModel) target.appendModelChange("missing-provider/unavailable-model");
	await target.ensureOnDisk();
	await target.flush();
	const targetInfo = history(target);
	await target.close();
	const settings = await Settings.loadIsolated({
		cwd: cwdA,
		agentDir: temp.join("agent"),
		overrides: {
			"compaction.enabled": false,
			"memory.backend": "off",
			"async.enabled": false,
		},
	});
	const authStorage = createInMemoryAuthStorage();
	const modelRegistry = new ModelRegistry(authStorage, temp.join("models.yml"));
	// Register both journal identities on this isolated registry, using an admitted fixture provider.
	modelRegistry.registerProvider(savedModel.provider, {
		api: savedModel.api,
		baseUrl: savedModel.baseUrl,
		apiKey: "fixture-key",
		models: [model, savedModel].map(candidate => ({ ...candidate, contextWindow, maxTokens })),
	});
	const { session } = await createAgentSession({
		cwd: cwdA,
		agentDir: temp.join("agent"),
		sessionManager: source,
		authStorage,
		modelRegistry,
		settings,
		model,
		disableExtensionDiscovery: true,
		bindProcessState: false,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		rules: [],
		preloadedCustomToolPaths: [],
		toolNames: ["read"],
		enableMCP: false,
		enableLsp: false,
		taskDepth: 1,
		agentId: "SubAgent",
	});
	await source.ensureOnDisk();
	await source.flush();
	const sourceInfo = history(source);
	const lease = await acquireBrowserProject(cwdA, "webgui");
	await lease.activate(() => readWebGuiSessionInfo(session), { allowLan: false, nativeSession: session });
	const host = new NativeCwdHost(session, lease);
	const controller = new AbortController();
	const context: WebGuiServiceContext = {
		connectionId: crypto.randomUUID(),
		projectId: lease.projectId,
		workspacePath: lease.root,
		nativeSession: session,
		signal: controller.signal,
	};
	const runtime = new NativeChatRuntime(session);
	runtime.recordHistory([sourceInfo, targetInfo]);
	return {
		session,
		host,
		runtime,
		context,
		controller,
		settings,
		lease,
		cwdA,
		cwdB,
		sourceInfo,
		targetInfo,
		model,
		savedModel,
		async close() {
			try {
				await host.close();
			} finally {
				try {
					await session.dispose();
				} finally {
					authStorage.close();
					AgentStorage.close();
				}
			}
		},
	};
}

async function readMarker(session: NativeChatRuntime["session"]): Promise<string> {
	const tool = session.getToolByName("read");
	if (!tool) throw new Error("Missing real SDK read tool");
	const result = await tool.execute("native-cwd-marker", { path: "marker.txt" });
	return result.content
		.filter(part => part.type === "text")
		.map(part => part.text)
		.join("\n");
}

test("cross-project continuation rebinds actual tools/settings on the same native session and retains both leases until exit", async () => {
	using temp = TempDir.createSync("@pi-native-cwd-");
	const f = await fixture(temp);
	const processCwd = process.cwd();
	const nativeAgent = f.session.agent;
	try {
		expect((await f.runtime.snapshot(f.context, f.targetInfo.id)).inputRouting).toEqual({ mode: "startNow" });
		await f.runtime.resume(f.context, f.targetInfo.id);
		expect(f.session.model).toMatchObject({ provider: f.savedModel.provider, id: f.savedModel.id });
		expect(f.session.agent).toBe(nativeAgent);
		expect(f.session.sessionManager.getCwd()).toBe(f.cwdB);
		expect(f.settings.getCwd()).toBe(f.cwdB);
		expect(cfgTemperature.get(f.settings)).toBe(0.8);
		expect(await readMarker(f.session)).toContain("TARGET");
		expect(process.cwd()).toBe(processCwd);
		expect(readBrowserProject(f.lease.projectId)?.nativeSession).toBe(f.session);
		await expect(acquireBrowserProject(f.cwdA, "dev")).rejects.toThrow(/占用/);
		await expect(acquireBrowserProject(f.cwdB, "dev")).rejects.toThrow(/占用/);
		await f.runtime.resume(f.context, f.sourceInfo.id);
		expect(f.session.model).toMatchObject({ provider: f.model.provider, id: f.model.id });
		expect(cfgTemperature.get(f.settings)).toBe(0.2);
		expect(await readMarker(f.session)).toContain("SOURCE");
		expect(f.settings.getCwd()).toBe(f.cwdA);
		await f.host.close();
		for (const cwd of [f.cwdA, f.cwdB]) {
			const released = await acquireBrowserProject(cwd, "dev");
			await released.close();
		}
	} finally {
		await f.close();
	}
});

test("a target Dev lease rejects continuation before changing native tools or configuration", async () => {
	using temp = TempDir.createSync("@pi-native-cwd-conflict-");
	const f = await fixture(temp);
	const contender = await acquireBrowserProject(f.cwdB, "dev");
	try {
		await expect(f.runtime.resume(f.context, f.targetInfo.id)).rejects.toThrow(/占用/);
		expect(f.session.sessionId).toBe(f.sourceInfo.id);
		expect(f.settings.getCwd()).toBe(f.cwdA);
		expect(cfgTemperature.get(f.settings)).toBe(0.2);
		expect(await readMarker(f.session)).toContain("SOURCE");
	} finally {
		await contender.close();
		await f.close();
	}
});

for (const failure of ["model", "cancel"] as const) {
	test(`failed ${failure} recovery restores native cwd/configuration and releases only the added target lease`, async () => {
		using temp = TempDir.createSync(`@pi-native-cwd-${failure}-`);
		const f = await fixture(temp, failure === "model");
		let reachedTarget = false;
		cfgTemperature.listen(f.session, () => {
			if (cfgTemperature.get(f.settings) !== 0.8) return;
			reachedTarget = true;
			if (failure === "cancel") f.controller.abort(new Error("Cancelled recovery"));
		});
		try {
			await expect(f.runtime.resume(f.context, f.targetInfo.id)).rejects.toThrow(
				failure === "model" ? /Could not restore model/ : /Cancelled recovery/,
			);
			expect(reachedTarget).toBe(true);
			expect(f.session.sessionId).toBe(f.sourceInfo.id);
			expect(f.session.sessionManager.getCwd()).toBe(f.cwdA);
			expect(f.settings.getCwd()).toBe(f.cwdA);
			expect(cfgTemperature.get(f.settings)).toBe(0.2);
			expect(await readMarker(f.session)).toContain("SOURCE");
			expect(f.session.isDisposed).toBe(false);
			await expect(acquireBrowserProject(f.cwdA, "dev")).rejects.toThrow(/占用/);
			const released = await acquireBrowserProject(f.cwdB, "dev");
			await released.close();
		} finally {
			await f.close();
		}
	});
}
