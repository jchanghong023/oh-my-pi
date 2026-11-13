import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../../src/config/settings";
import { ModelRegistry } from "../../src/config/model-registry";
import { createAgentSession } from "../../src/sdk";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import {
	bindAIReqNativeSurface,
	aiReqNativeSurfaceSnapshot,
	nativeWebGuiQuestions,
	releaseAIReqNativeSurface,
	respondAIReqNativeSurface,
	subscribeAIReqNativeSurface,
	updateAIReqNativeSurfaceEditor,
} from "../../src/aireq-workbench/native/native-interactions";
import type {
	AIReqNativeSurfaceTarget,
	AIReqNativeUiStateEvent,
} from "../../src/aireq-workbench/native/native-surface-types";
import { createProviderFixture } from "../spec-driven/provider-fixture";

/** Real native session and journal, not an ExtensionUIContext/controller substitute. */
async function fixture() {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-aireq-native-surface-"));
	const agentDir = path.join(cwd, "agent");
	await fs.mkdir(agentDir);
	const provider = createProviderFixture({ reply: () => ({ text: "Native surface fixture response" }) });
	await fs.writeFile(
		path.join(agentDir, "models.yml"),
		`providers:\n  deepseek:\n    baseUrl: ${provider.baseUrl}\n    auth: none\n    api: openai-completions\n    models:\n      - id: surface\n        reasoning: false\n        input: [text, image]\n        contextWindow: 1000000\n`,
	);
	const settings = await Settings.loadIsolated({
		cwd,
		agentDir,
		inMemory: true,
		overrides: {
			modelRoles: { default: "deepseek/surface", smol: "deepseek/surface" },
			"composer.predictions": false,
			"compaction.enabled": false,
			"prewalk.enabled": false,
			"async.enabled": false,
			"tools.xdev": false,
		},
	});
	const authStorage = await AuthStorage.create(":memory:");
	const registry = new ModelRegistry(authStorage, path.join(agentDir, "models.yml"), { settings });
	const model = registry.find("deepseek", "surface");
	if (!model) throw new Error("Actual native fixture model unavailable");
	const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		settings,
		authStorage,
		modelRegistry: registry,
		model,
		sessionManager: manager,
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
	const target: AIReqNativeSurfaceTarget = {
		projectId: "project",
		irId: "ir",
		srId: "sr",
		sessionId: session.sessionId,
		phase: "solution",
		round: 1,
		clientId: "page-a",
	};
	return {
		session,
		manager,
		target,
		provider,
		async [Symbol.asyncDispose]() {
			await releaseAIReqNativeSurface(session);
			await session.dispose();
			await registry.awaitBackgroundRefresh();
			authStorage.close();
			await provider[Symbol.asyncDispose]();
			await fs.rm(cwd, { recursive: true, force: true });
		},
	};
}

const png = {
	type: "image" as const,
	mimeType: "image/png",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1sAAAAASUVORK5CYII=",
};

describe("retained AIReq native surface", () => {
	test("portable native methods rehydrate for both exact pages without copying native history", async () => {
		await using f = await fixture();
		const a = f.target;
		const b = { ...a, clientId: "page-b" };
		bindAIReqNativeSurface(f.session, a);
		bindAIReqNativeSurface(f.session, b);
		const broker = nativeWebGuiQuestions(f.session);
		const history = f.manager.getEntries();
		const events: AIReqNativeUiStateEvent[] = [];
		const detach = subscribeAIReqNativeSurface(f.session, a, event => {
			if (event.t === "native-ui-state") events.push(event);
		});
		broker.ui.setEditorText("native ");
		broker.ui.pasteToEditor("draft");
		broker.ui.setWidget("review", ["Review the actual diff"], { placement: "belowEditor" });
		broker.ui.setStatus("checks", "waiting");
		broker.ui.setTitle("Exact SR");
		broker.ui.setWorkingMessage("Native work");
		broker.ui.setToolsExpanded(true);
		broker.ui.notify("Transient native notice");
		expect(broker.ui.getEditorText()).toBe("native draft");
		expect(broker.ui.getToolsExpanded()).toBe(true);
		detach();
		const reconnect = aiReqNativeSurfaceSnapshot(f.session, a);
		const otherBrowser = aiReqNativeSurfaceSnapshot(f.session, b);
		expect(reconnect.events.find(event => event.method === "setEditorText")).toMatchObject({
			value: "native draft",
			target: a,
		});
		expect(otherBrowser.events.find(event => event.method === "setEditorText")).toMatchObject({
			value: "native draft",
			target: b,
		});
		expect(reconnect.events.find(event => event.method === "setWidget")).toMatchObject({
			value: { key: "review", content: ["Review the actual diff"], options: { placement: "belowEditor" } },
		});
		expect(reconnect.events.find(event => event.method === "setStatus")).toMatchObject({
			value: { key: "checks", text: "waiting" },
		});
		expect(reconnect.events.find(event => event.method === "setTitle")).toMatchObject({ value: "Exact SR" });
		expect(reconnect.events.find(event => event.method === "setWorkingMessage")).toMatchObject({
			value: "Native work",
		});
		expect(reconnect.events.some(event => event.method === "notify")).toBe(false);
		expect(events.every((event, index) => (event.sequence ?? 0) > (events[index - 1]?.sequence ?? 0))).toBe(true);
		updateAIReqNativeSurfaceEditor(f.session, b, "Browser draft");
		expect(broker.ui.getEditorText()).toBe("Browser draft");
		expect(
			aiReqNativeSurfaceSnapshot(f.session, a).events.find(event => event.method === "setEditorText"),
		).toMatchObject({ value: "Browser draft" });
		expect(f.manager.getEntries()).toEqual(history);
		expect(f.provider.requests).toEqual([]);
	}, 60_000);

	test("structured native ask preserves selected text and image MIME/bytes and rejects foreign or duplicate answers", async () => {
		await using f = await fixture();
		await using foreign = await fixture();
		bindAIReqNativeSurface(f.session, f.target);
		bindAIReqNativeSurface(foreign.session, foreign.target);
		const broker = nativeWebGuiQuestions(f.session);
		const question = {
			id: "native-question",
			question: "Which change?",
			options: [{ label: "A" }, { label: "B" }],
			multi: true,
		};
		const pending = broker.ui.askDialog!([question]);
		const request = broker.pendingInteractions[0]!;
		expect(request.payload).toMatchObject({
			kind: "userInput",
			input: { nativeQuestions: [question], acceptImages: true },
		});
		const result = {
			kind: "submit" as const,
			results: [
				{
					id: question.id,
					question: question.question,
					options: ["A", "B"],
					multi: true,
					selectedOptions: ["A"],
					customInput: "Use this image",
					customInputImages: [png],
					note: "Exact evidence",
					noteImages: [png],
					noteOption: "A",
				},
			],
		};
		await expect(
			respondAIReqNativeSurface(f.session, { ...f.target, round: 2 }, request.interactionId, {
				content: { result },
			}),
		).rejects.toThrow();
		await expect(
			respondAIReqNativeSurface(foreign.session, foreign.target, request.interactionId, { content: { result } }),
		).rejects.toThrow();
		const invalid = {
			...result,
			results: [{ ...result.results[0]!, customInputImages: [{ ...png, mimeType: "text/plain" }] }],
		};
		await expect(
			respondAIReqNativeSurface(f.session, f.target, request.interactionId, { content: { result: invalid } }),
		).rejects.toThrow();
		expect(broker.pendingInteractions).toHaveLength(1);
		await respondAIReqNativeSurface(f.session, f.target, request.interactionId, { content: { result } });
		expect(await pending).toEqual(result);
		expect(broker.pendingInteractions).toEqual([]);
		await expect(
			respondAIReqNativeSurface(f.session, f.target, request.interactionId, { content: { result } }),
		).rejects.toThrow();
		expect(f.provider.requests).toEqual([]);
	}, 60_000);

	test("page selection changes reject stale drafts/responses while reconnect and other page preserve the native wait", async () => {
		await using f = await fixture();
		let current = f.target;
		bindAIReqNativeSurface(f.session, f.target, () => current);
		const b = { ...f.target, clientId: "page-b" };
		bindAIReqNativeSurface(f.session, b);
		const broker = nativeWebGuiQuestions(f.session);
		const pending = broker.ui.input("Exact owner input");
		const request = broker.pendingInteractions[0]!;
		current = { ...current, irId: "different-ir" };
		expect(() => updateAIReqNativeSurfaceEditor(f.session, f.target, "stale")).toThrow();
		await expect(
			respondAIReqNativeSurface(f.session, f.target, request.interactionId, { freeText: "stale" }),
		).rejects.toThrow();
		expect(aiReqNativeSurfaceSnapshot(f.session, b).pendingInteractions.map(item => item.interactionId)).toEqual([
			request.interactionId,
		]);
		await respondAIReqNativeSurface(f.session, b, request.interactionId, { freeText: "Current human answer" });
		expect(await pending).toBe("Current human answer");
		bindAIReqNativeSurface(f.session, f.target);
		expect(aiReqNativeSurfaceSnapshot(f.session, f.target).pendingInteractions).toEqual([]);
		expect(f.provider.requests).toEqual([]);
	}, 60_000);

	test("native abort and settlement end waits and discard owned surface state", async () => {
		await using f = await fixture();
		bindAIReqNativeSurface(f.session, f.target);
		const broker = nativeWebGuiQuestions(f.session);
		const abort = new AbortController();
		const pending = broker.ui.editor("Cancelable native editor", "prefill", { signal: abort.signal });
		const request = broker.pendingInteractions[0]!;
		abort.abort();
		// Bun's promise matchers can synchronously wait: abort before invoking the matcher.
		await expect(pending).rejects.toThrow();
		await expect(
			respondAIReqNativeSurface(f.session, f.target, request.interactionId, { freeText: "too late" }),
		).rejects.toThrow();
		broker.ui.setEditorText("owned draft");
		broker.ui.setWidget("owned-widget", ["owned state"]);
		await releaseAIReqNativeSurface(f.session);
		expect(() => aiReqNativeSurfaceSnapshot(f.session, f.target)).toThrow();
		bindAIReqNativeSurface(f.session, f.target);
		expect(aiReqNativeSurfaceSnapshot(f.session, f.target).events).toEqual([]);
		expect(nativeWebGuiQuestions(f.session).ui.getEditorText()).toBe("");
		expect(f.provider.requests).toEqual([]);
	}, 60_000);
});
