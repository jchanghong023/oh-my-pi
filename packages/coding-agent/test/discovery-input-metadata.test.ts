import { describe, expect, it } from "bun:test";
import type { PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import type { Api, Context, Model, ModelSpec, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { clearCustomApis, registerCustomApi } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { ToolRestrictions } from "@oh-my-pi/pi-coding-agent/session/tool-restrictions";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("per-input discovery metadata boundary", () => {
	// The actual SDK owns admission and provider options; the transport alone is local.
	it("preserves queued automation metadata in the journal without widening tools or leaking provider options", async () => {
		using directory = TempDir.createSync("@omp-discovery-metadata-");
		const requests: Array<{ context: Context; options: SimpleStreamOptions | undefined }> = [];
		const api = "test-discovery-metadata";
		registerCustomApi(api, (_model, context, options) => {
			requests.push({ context, options });
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("metadata answer");
				stream.push({ type: "text_delta", contentIndex: 0, delta: "metadata answer", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});
		const authStorage = createInMemoryAuthStorage();
		const model = buildModel({
			id: "metadata-model",
			name: "Metadata model",
			api,
			provider: "metadata-provider",
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32_768,
			maxTokens: 1_024,
		} as ModelSpec<Api>) as Model<Api>;
		authStorage.keys.setRuntime(model.provider, "test-key");
		const policy = new ToolRestrictions({ allowlist: ["read", "write"], denylist: ["write"] });
		const manager = SessionManager.create(directory.path(), directory.path());
		let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
		try {
			({ session } = await createAgentSession({
				cwd: directory.path(),
				agentDir: directory.path(),
				sessionManager: manager,
				authStorage,
				modelRegistry: new ModelRegistry(authStorage, directory.join("models.yml")),
				model,
				settings: Settings.isolated({
					"compaction.enabled": false,
					"todo.enabled": false,
					"tools.format": "native",
					"memory.backend": "off",
				}),
				toolNames: ["read", "write"],
				restrictToolNames: true,
				toolRestrictions: policy,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				rules: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				taskDepth: 1,
				agentId: "MetadataBoundary",
			}));
			session.setQueueAutoDrain(false);
			const sourceCommand: NonNullable<PromptOptions["sourceCommand"]> = {
				sessionId: session.sessionId,
				commandId: "automation-command",
				fingerprint: "immutable-origin",
				type: "sendText",
				automationId: "automation-discovery-42",
			};
			const attachments = [{ ref: "attachment:input", fileName: "input.txt", mime: "text/plain", bytes: 3 }];
			const metadata = { inputId: "metadata-input", sourceCommand, attachments, toolDenylist: ["read"] };
			await session.prompt("queued input", { ...metadata, queueOnly: true, streamingBehavior: "followUp" });
			expect(requests).toEqual([]);
			expect(session.getQueuedInputMessages()).toHaveLength(1);
			expect(session.getQueuedInputMessages()[0]).toMatchObject(metadata);

			const reservation = session.takeQueuedInput("metadata-input");
			if (!reservation) throw new Error("Expected the actual queued input reservation");
			await reservation.prompt({});
			await session.waitForIdle();
			expect(requests).toHaveLength(1);
			expect(requests[0].context.tools?.map(tool => tool.name) ?? []).toEqual([]);
			for (const key of ["toolDenylist", "sourceCommand", "automationId", "attachments", "inputId"]) {
				expect(requests[0].options).not.toHaveProperty(key);
			}
			expect(policy.allows("write")).toBe(false);
			expect(policy.allows("bash")).toBe(false);
			expect(policy.allows("read")).toBe(true);
			await manager.flush();
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Expected a durable session journal");
			const entries = (await Bun.file(sessionFile).text())
				.trim()
				.split("\n")
				.map(line => JSON.parse(line));
			expect(
				entries.find(entry => entry.type === "message" && entry.message.inputId === "metadata-input"),
			).toMatchObject({
				message: metadata,
			});
			expect(session.getQueuedInputMessages()).toEqual([]);

			// Empty per-input restrictions release only that input, never the caller's base deny/allowlist.
			await session.prompt("unrestricted next input", { toolDenylist: [], sourceCommand, attachments });
			expect(requests).toHaveLength(2);
			expect(requests[1].context.tools?.map(tool => tool.name)).toEqual(["read"]);
			for (const key of ["toolDenylist", "sourceCommand", "automationId", "attachments"]) {
				expect(requests[1].options).not.toHaveProperty(key);
			}
		} finally {
			await session?.dispose();
			authStorage.close();
			clearCustomApis();
		}
	});
});
