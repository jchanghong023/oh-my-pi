import { describe, expect, it } from "bun:test";
import { convertMessages } from "@oh-my-pi/pi-ai/providers/openai-completions";
import {
	applyChatCompletionsReasoningParams,
	type ChatCompletionsReasoningOptions,
	type OpenAICompletionsParams,
} from "@oh-my-pi/pi-ai/providers/openai-shared";
import type { AssistantMessage, Message } from "@oh-my-pi/pi-ai/types";
import { carriesReasoning, portableReasoningIdentity } from "@oh-my-pi/pi-catalog/compat/reasoning-carry";
import { getCodeAgentModels } from "../src/config/codeagent-provider";

function reasoningParameters(options?: ChatCompletionsReasoningOptions): OpenAICompletionsParams {
	const model = getCodeAgentModels()[0]!;
	const params: OpenAICompletionsParams = { model: model.id, messages: [], stream: true };
	applyChatCompletionsReasoningParams(params, model, model.compat, { ...options, hasTools: true });
	return params;
}

describe("CodeAgent thinking policy", () => {
	it.each(["low", "high", "max"] as const)("enables thinking with the selected %s effort", effort => {
		const params = reasoningParameters({ reasoning: effort });
		expect(params.thinking).toEqual({ type: "enabled" });
		expect(params.reasoning_effort).toBe(effort);
	});

	it("turns thinking off when explicitly disabled", () => {
		const params = reasoningParameters({ reasoning: "max", disableReasoning: true });
		expect(params.thinking).toEqual({ type: "disabled" });
		expect(params.reasoning_effort).toBeUndefined();
	});

	it("does not turn thinking on when no effort is selected", () => {
		const params = reasoningParameters();
		expect(params.thinking).toEqual({ type: "disabled" });
		expect(params.reasoning_effort).toBeUndefined();
	});
});

describe("CodeAgent DeepSeek reasoning carry", () => {
	it.each([
		["deepseek-v4.1-flash-1017", "4.1.0"],
		["DeepSeek-V4-Flash-0731-CodeAgent", "4.0.0"],
	])("classifies %s as portable DeepSeek Flash reasoning", (id, revision) => {
		expect(portableReasoningIdentity("codeagent", "openai-completions", id)).toEqual({
			class: "deepseek",
			family: "flash",
			revision,
		});
	});

	it("carries reasoning across hosts only for the same DeepSeek revision", () => {
		const target = getCodeAgentModels()[0]!;
		expect(carriesReasoning({ provider: "factory-droid", api: "openai-completions", model: target.id }, target)).toBe(
			true,
		);
		expect(
			carriesReasoning(
				{ provider: "codeagent", api: "openai-completions", model: "DeepSeek-V4-Flash-0731-CodeAgent" },
				target,
			),
		).toBe(false);
	});

	it("preserves earlier reasoning in tool-call and ordinary assistant messages", () => {
		const model = getCodeAgentModels()[0]!;
		const usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const assistant: AssistantMessage = {
			role: "assistant",
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage,
			stopReason: "toolUse",
			timestamp: 1,
			content: [
				{
					type: "thinking",
					thinking: "Read the file first.",
					thinkingSignature: "reasoning_content",
					summary: false,
				},
				{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "README.md" } },
			],
		};
		const reply: AssistantMessage = {
			...assistant,
			stopReason: "stop",
			timestamp: 3,
			content: [
				{
					type: "thinking",
					thinking: "The file answers the question.",
					thinkingSignature: "reasoning_content",
					summary: false,
				},
				{ type: "text", text: "Done." },
			],
		};
		const history: Message[] = [
			{ role: "user", content: "Read the file.", timestamp: 0 },
			assistant,
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "read",
				content: [{ type: "text", text: "Contents" }],
				isError: false,
				timestamp: 2,
			},
			reply,
		];
		const encoded = convertMessages(model, { messages: history }, model.compat).filter(
			message => message.role === "assistant",
		);
		expect(encoded).toHaveLength(2);
		expect(Reflect.get(encoded[0]!, "reasoning_content")).toBe("Read the file first.");
		expect(Reflect.get(encoded[1]!, "reasoning_content")).toBe("The file answers the question.");
	});
});
