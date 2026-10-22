import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ZCodeModelIoRetention } from "../../src/modes/zcode/model-io";
import { ArtifactManager } from "../../src/session/artifacts";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { createAgentSession } from "../../src/sdk";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-zcode-model-io-"));
	cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
	const artifacts = new ArtifactManager(path.join(root, "session"));
	const errors: Error[] = [];
	const capture = new ZCodeModelIoRetention({
		sessionId: "session-a",
		artifacts: () => artifacts,
		onError: error => errors.push(error),
	});
	return {
		root,
		artifacts,
		errors,
		capture,
		async records() {
			const files = await artifacts.listFiles();
			return (await Promise.all(files.map(file => fs.readFile(path.join(artifacts.dir, file), "utf8")))).flatMap(
				text =>
					text
						.trim()
						.split("\n")
						.filter(Boolean)
						.map(line => JSON.parse(line)),
			);
		},
	};
}

const assistant = (text: string) => ({
	role: "assistant",
	content: [{ type: "text", text }],
	provider: "local",
	model: "mock",
	stopReason: "stop",
});

describe("ZCode model IO retention", () => {
	it("does not create artifacts while disabled, including responses after enabling", async () => {
		const f = await fixture();
		await f.capture.onPayload?.({ messages: [{ content: "disabled payload" }] });
		f.capture.setEnabled(true);
		f.capture.onSessionEvent({ type: "message_end", message: assistant("disabled response") });
		await f.capture.close();
		expect(await f.artifacts.listFiles()).toEqual([]);
		expect(f.errors).toEqual([]);
	});

	it("retains actual local HTTP payload and response without credentials or URL secrets", async () => {
		const f = await fixture();
		f.capture.setEnabled(true);
		let received: Record<string, unknown> | undefined;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				received = (await request.json()) as Record<string, unknown>;
				const chunk = (delta: Record<string, unknown>, finish_reason: string | null) =>
					`data: ${JSON.stringify({ id: "local-response", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
				return new Response(
					chunk({ role: "assistant", content: "provider answer" }, null) + chunk({}, "stop") + "data: [DONE]\n\n",
					{
						headers: { "content-type": "text/event-stream", authorization: "Bearer hidden" },
					},
				);
			},
		});
		cleanup.push(async () => {
			server.stop(true);
		});
		const model = {
			...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">),
			api: "openai-completions" as const,
			provider: "local",
			id: "mock",
			baseUrl: `http://127.0.0.1:${server.port}/v1`,
		};
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime(model.provider, "do-not-store");
		cleanup.push(async () => authStorage.close());
		const terminal = Promise.withResolvers<AssistantMessage>();
		const signals: Array<AbortSignal | undefined> = [];
		const { session } = await createAgentSession({
			cwd: f.root,
			agentDir: f.root,
			sessionManager: SessionManager.inMemory(f.root),
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, path.join(f.root, "models.yml")),
			settings: Settings.isolated({ "compaction.enabled": false }),
			model,
			bindProcessState: false,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			toolNames: [],
			restrictToolNames: true,
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			taskDepth: 1,
			agentId: "SubAgent",
			onPayload: async (payload, observedModel, signal) => {
				signals.push(signal);
				await f.capture.onPayload(payload, observedModel, signal);
			},
			onResponse: async (response, observedModel, signal) => {
				signals.push(signal);
				await f.capture.onResponse(response, observedModel, signal);
			},
			onModelResponse: (message, observedModel, signal) => {
				signals.push(signal);
				f.capture.onModelResponse(message, observedModel, signal);
				terminal.resolve(message as AssistantMessage);
			},
		});
		cleanup.push(() => session.dispose());
		await session.sendUserMessage("actual provider request https://user:password@example.test/api?token=secret");
		const response = await terminal.promise;
		expect(signals).toHaveLength(3);
		expect(signals[0]).toBeInstanceOf(AbortSignal);
		expect(signals.every(signal => signal === signals[0])).toBe(true);
		await f.capture.close();
		expect(response.stopReason).toBe("stop");
		const records = await f.records();
		expect(records.map(record => record.type)).toEqual(["provider_payload", "provider_response", "model_response"]);
		expect(records[0].payload.model).toEqual(received?.model);
		expect(JSON.stringify(received?.messages)).toContain("actual provider request");
		expect(JSON.stringify(records[0].payload.messages)).toContain("actual provider request");
		expect(records[2].message.content).toEqual(assistant("provider answer").content);
		expect(records[2].message).toEqual(response);
		const stored = JSON.stringify(records);
		for (const secret of ["do-not-store", "password", "Bearer hidden", "token=secret"])
			expect(stored).not.toContain(secret);
	});

	it("isolates sessions and rejects stale generations, cancellation and post-close events", async () => {
		const a = await fixture();
		const b = await fixture();
		a.capture.setEnabled(true);
		const aborted = new AbortController();
		await a.capture.onPayload?.({ text: "a-first" }, undefined, aborted.signal);
		a.capture.setEnabled(false);
		a.capture.setEnabled(true);
		a.capture.onSessionEvent({ type: "message_end", message: assistant("stale") });
		await b.capture.onPayload?.({ text: "b-disabled" });
		aborted.abort();
		a.capture.onModelResponse(assistant("cancelled"), undefined, aborted.signal);
		await a.capture.onPayload?.({ text: "a-second" });
		a.capture.onSessionEvent({ type: "message_end", message: assistant("current") });
		await a.capture.close();
		a.capture.onSessionEvent({ type: "message_end", message: assistant("closed") });
		await b.capture.close();
		const records = await a.records();
		expect(
			records.filter(record => record.type === "model_response").map(record => record.message.content[0].text),
		).toEqual(["current"]);
		expect(await b.artifacts.listFiles()).toEqual([]);
	});

	it("ignores an old request terminal event after a new request is admitted for the same model", async () => {
		const f = await fixture();
		const model = {
			...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">),
			provider: "local",
			id: "mock",
		};
		const oldSignal = new AbortController().signal;
		const currentSignal = new AbortController().signal;
		f.capture.setEnabled(true);
		await f.capture.onPayload({ text: "old request" }, model, oldSignal);
		f.capture.setEnabled(false);
		f.capture.setEnabled(true);
		await f.capture.onPayload({ text: "current request" }, model, currentSignal);
		f.capture.onModelResponse(assistant("old terminal"), model, oldSignal);
		f.capture.onModelResponse(assistant("current terminal"), model, currentSignal);
		await f.capture.close();
		expect(
			(await f.records())
				.filter(record => record.type === "model_response")
				.map(record => record.message.content[0].text),
		).toEqual(["current terminal"]);
	});

	it("drains an accepted terminal response when close aborts its completed request signal", async () => {
		const f = await fixture();
		const controller = new AbortController();
		f.capture.setEnabled(true);
		await f.capture.onPayload({ text: "request" }, undefined, controller.signal);
		const message = assistant("actual completed response");
		f.capture.onModelResponse(message, undefined, controller.signal);
		controller.abort(new Error("Session closed"));
		await f.capture.close();
		const records = await f.records();
		expect(records.map(record => record.type)).toEqual(["provider_payload", "model_response"]);
		expect(records[1].message).toEqual(message);
		expect(f.errors).toEqual([]);
	});

	it("does not admit a terminal response after its request was cancelled", async () => {
		const f = await fixture();
		const controller = new AbortController();
		f.capture.setEnabled(true);
		await f.capture.onPayload({ text: "request" }, undefined, controller.signal);
		controller.abort();
		f.capture.onModelResponse(assistant("cancelled response"), undefined, controller.signal);
		await f.capture.close();
		expect((await f.records()).map(record => record.type)).toEqual(["provider_payload"]);
	});

	it("still invalidates pending terminal IO when retention is disabled", async () => {
		const f = await fixture();
		const controller = new AbortController();
		f.capture.setEnabled(true);
		await f.capture.onPayload({ text: "request" }, undefined, controller.signal);
		f.capture.onModelResponse(assistant("pending response"), undefined, controller.signal);
		f.capture.setEnabled(false);
		await f.capture.close();
		expect((await f.records()).map(record => record.type)).toEqual(["provider_payload"]);
	});

	it("reports IO failure without failing the model hook and rejects flush and close", async () => {
		const f = await fixture();
		await fs.writeFile(f.artifacts.dir, "not a directory");
		f.capture.setEnabled(true);
		await f.capture.onPayload?.({ messages: ["request"] });
		expect(f.errors).toHaveLength(1);
		await expect(f.capture.flush()).rejects.toThrow("Model IO retention failed");
		await expect(f.capture.close()).rejects.toThrow("Model IO retention failed");
	});

	it("removes image and video bytes while keeping textual model content", async () => {
		const f = await fixture();
		f.capture.setEnabled(true);
		await f.capture.onPayload?.({
			messages: [
				{
					content: [
						{ type: "image", source: { type: "base64", media_type: "image/png", data: "private-image-bytes" } },
						{ type: "text", text: "keep this text" },
					],
				},
			],
		});
		await f.capture.close();
		const stored = JSON.stringify(await f.records());
		expect(stored).toContain("keep this text");
		expect(stored).not.toContain("private-image-bytes");
	});
});
