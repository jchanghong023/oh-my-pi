import { expect, it } from "bun:test";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

it("dispatches with explicit SDK authorization and observes the same request's terminal reply", async () => {
	using root = TempDir.createSync("@pi-sdk-request-hooks-");
	const auth = createInMemoryAuthStorage();
	const source = "sdk-request-hooks-test";
	registerMockApi(source);
	let session: AgentSession | undefined;
	try {
		const model = createMockModel({
			handler: { content: ["Provider reply"], responseHeaders: { "x-request-id": "request-1" } },
		});
		const metadata: Array<{ id: string | undefined; signal: AbortSignal | undefined }> = [];
		const terminal: Array<{ message: unknown; modelId: string; signal: AbortSignal | undefined }> = [];
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		({ session } = await createAgentSession({
			cwd: root.path(),
			agentDir: root.path(),
			model,
			modelRegistry: new ModelRegistry(auth, root.join("models.yml"), { settings }),
			sessionManager: SessionManager.inMemory(root.path()),
			settings,
			getApiKey: () => "stored-key",
			resolveRequestAuth: async () => ({ apiKey: "request-key", headers: { "x-request-auth": "ephemeral" } }),
			onResponse: (response, _model, signal) => {
				metadata.push({ id: response.headers["x-request-id"], signal });
			},
			onModelResponse: (message, requestModel, signal) => {
				terminal.push({ message, modelId: requestModel.id, signal });
			},
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			cacheWarming: "off",
		}));

		await session.prompt("Reply once");

		expect(model.calls).toHaveLength(1);
		const options = model.calls[0]?.options;
		expect(options).toMatchObject({ apiKey: "request-key", headers: { "x-request-auth": "ephemeral" } });
		expect(options?.signal).toBeInstanceOf(AbortSignal);
		expect(metadata).toEqual([{ id: "request-1", signal: options?.signal }]);
		expect(terminal).toEqual([
			{
				message: expect.objectContaining({ content: [{ type: "text", text: "Provider reply" }] }),
				modelId: model.id,
				signal: options?.signal,
			},
		]);
	} finally {
		try {
			await session?.dispose();
		} finally {
			unregisterCustomApis(source);
			auth.close();
		}
	}
});
