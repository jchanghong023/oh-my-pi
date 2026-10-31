import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as ai from "@oh-my-pi/pi-ai";
import { type Api, Effort, type Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { generateCommitMessage } from "@oh-my-pi/pi-coding-agent/utils/commit-message-generator";
import { generateSessionTitle } from "@oh-my-pi/pi-coding-agent/utils/title-generator";

function getModelOrThrow(id: string) {
	const model = getBundledModel("anthropic", id);
	if (!model) throw new Error(`Expected model ${id}`);
	return model;
}

function createRegistry(model: Model<Api>) {
	return {
		getAvailable: (_kind = "chat") => [model],
		getApiKey: async () => "test-key",
		resolver: vi.fn(() => async () => "test-key"),
	};
}

function createSettings(modelRoles: Record<string, string>) {
	return Settings.isolated({ modelRoles });
}

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("role thinking helper propagation", () => {
	it("passes smol-role thinking to commit message generation", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const settings = createSettings({
			default: `${model.provider}/${model.id}:high`,
			smol: "@default:minimal",
		});
		const registry = createRegistry(model);
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "end_turn",
			content: [{ type: "text", text: "fix scope handling" }],
		} as never);

		const message = await generateCommitMessage(
			`diff --git a/x b/x\n+change\n`,
			registry as never,
			settings,
			import.meta.dir,
		);
		expect(message).toBe("fix scope handling");
		expect(completeSimpleMock.mock.calls[0]?.[2]).toMatchObject({
			reasoning: Effort.Minimal,
			maxTokens: 1024,
		});
	});

	it("keeps the commit budget reasoning-safe when the catalog disables reasoning", async () => {
		const model = { ...getModelOrThrow("claude-sonnet-4-5"), reasoning: false };
		const settings = createSettings({
			smol: `${model.provider}/${model.id}`,
		});
		const registry = createRegistry(model);
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "end_turn",
			content: [{ type: "text", text: "fix qwen title budget" }],
		} as never);

		const message = await generateCommitMessage(
			`diff --git a/x b/x\n+change\n`,
			registry as never,
			settings,
			import.meta.dir,
		);
		expect(message).toBe("fix qwen title budget");
		expect(completeSimpleMock.mock.calls[0]?.[2]).toMatchObject({
			maxTokens: 1024,
		});
	});

	it.each(["missing key", "error", "throw", "empty", "aborted"] as const)(
		"continues to another commit candidate after CodeAgent %s",
		async failure => {
			const fallback = getModelOrThrow("claude-sonnet-4-5");
			const codeagent: Model<Api> = { ...fallback, provider: "codeagent", id: "commit-test" };
			const settings = createSettings({ smol: "codeagent/commit-test" });
			const registry = {
				...createRegistry(fallback),
				getAvailable: () => [codeagent, fallback],
				getApiKey: async (model: Model<Api>) =>
					model.provider === "codeagent" && failure === "missing key" ? undefined : "test-key",
			};
			const complete = vi.spyOn(ai, "completeSimple").mockImplementation(async model => {
				if (model.provider === "codeagent") {
					if (failure === "throw") throw new Error("request failed");
					if (failure === "error") return { stopReason: "error", errorMessage: "request failed" } as never;
					return { stopReason: failure === "aborted" ? "aborted" : "end_turn", content: [] } as never;
				}
				return { stopReason: "end_turn", content: [{ type: "text", text: "fallback message" }] } as never;
			});

			const message = await generateCommitMessage(
				"diff --git a/x b/x\n+change\n",
				registry as never,
				settings,
				import.meta.dir,
			);

			expect(message).toBe("fallback message");
			expect(complete.mock.calls.map(call => call[0].provider)).toEqual(
				failure === "missing key" ? ["anthropic"] : ["codeagent", "anthropic"],
			);
		},
	);

	it("retries a transient CodeAgent commit failure before moving to another candidate", async () => {
		const fallback = getModelOrThrow("claude-sonnet-4-5");
		const codeagent: Model<Api> = { ...fallback, provider: "codeagent", id: "commit-test" };
		const registry = { ...createRegistry(fallback), getAvailable: () => [codeagent, fallback] };
		const settings = createSettings({ smol: "codeagent/commit-test" });
		const complete = vi
			.spyOn(ai, "completeSimple")
			.mockResolvedValueOnce({ stopReason: "error", errorStatus: 503, errorMessage: "service unavailable" } as never)
			.mockResolvedValueOnce({
				stopReason: "end_turn",
				content: [{ type: "text", text: "retried message" }],
			} as never);

		const message = await generateCommitMessage(
			"diff --git a/x b/x\n+change\n",
			registry as never,
			settings,
			import.meta.dir,
		);

		expect(message).toBe("retried message");
		expect(complete.mock.calls.map(call => call[0].provider)).toEqual(["codeagent", "codeagent"]);
	});

	it("disables reasoning for title generation even when smol role has thinking", async () => {
		const model = getModelOrThrow("claude-sonnet-4-5");
		const settings = createSettings({
			default: `${model.provider}/${model.id}:high`,
			smol: "@default:low",
		});
		const registry = createRegistry(model);
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "end_turn",
			content: [{ type: "text", text: "<title>Investigate resolver</title>" }],
		} as never);

		const title = await generateSessionTitle("Investigate resolver", registry as never, settings, import.meta.dir);
		expect(title).toBe("Investigate resolver");
		expect(completeSimpleMock.mock.calls[0]?.[2]).toMatchObject({ disableReasoning: true });
	});
});
