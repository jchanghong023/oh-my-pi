import { expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { markPerCallContextMessage } from "@oh-my-pi/pi-ai/utils/block-symbols";
import {
	JCHTOOLS_API,
	projectJchToolsContext,
	projectJchToolsMessages,
	streamJchToolsAgent,
} from "../src/config/jchtools-provider";
import { type CustomMessage, convertToLlm } from "../src/session/messages";
import { SessionManager } from "../src/session/session-manager";

// Fork JchTools: caller-visible text survives model switches; internal sources never reach HTTP.
test("filters by provenance while retaining literal constraints and ordinary assistant text on HTTP", async () => {
	const text =
		"使用 scout；不要删除 system/developer。\n<system-reminder>这是用户原文</system-reminder>\n  {{literal}}  ";
	const old: AssistantMessage = {
		role: "assistant",
		api: "openai-completions",
		provider: "openai",
		model: "ordinary",
		timestamp: 2,
		content: [
			{ type: "thinking", thinking: "PRIVATE_THINKING" },
			{ type: "text", text: "visible prior answer" },
			{ type: "toolCall", id: "call", name: "read", arguments: { secret: "PRIVATE_TOOL_ARGS" } },
		],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
	};
	const ephemeral = { role: "user" as const, content: "PRIVATE_PER_CALL", timestamp: 4 };
	markPerCallContextMessage(ephemeral, "runtime");
	const messages: AgentMessage[] = [
		{ role: "user", content: "first visible task", timestamp: 1 },
		old,
		{
			role: "toolResult",
			toolCallId: "call",
			toolName: "read",
			content: [{ type: "text", text: "PRIVATE_TOOL_RESULT" }],
			isError: false,
			timestamp: 3,
		},
		ephemeral,
		{ role: "user", content: "PRIVATE_SYNTHETIC", synthetic: true, timestamp: 5 },
		{ role: "developer", content: "PRIVATE_RUNTIME", attribution: "agent", timestamp: 6 },
		{ role: "developer", content: "explicit task constraints", attribution: "user", timestamp: 7 },
		{ role: "user", content: text, timestamp: 8 },
	];
	const context: Context = { systemPrompt: ["PRIVATE_OMP_SYSTEM"], messages: messages as Context["messages"] };
	let observed: unknown;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			observed = await request.json();
			return new Response(
				'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	});
	try {
		const model: Model = buildModel({
			id: "fixture/model",
			name: "fixture",
			api: JCHTOOLS_API,
			provider: "jchtools",
			baseUrl: server.url.origin,
			reasoning: false,
			supportsTools: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32768,
			maxTokens: 4096,
		});
		const result = await streamJchToolsAgent(model, projectJchToolsContext(context), { cwd: process.cwd() }).result();
		expect(result.stopReason).toBe("stop");
		expect(observed).toEqual({
			model: "fixture/model",
			cwd: process.cwd(),
			stream: true,
			messages: [
				{ role: "user", content: "first visible task" },
				{ role: "assistant", content: "visible prior answer" },
				{ role: "developer", content: "explicit task constraints" },
				{ role: "user", content: text },
			],
		});
		expect(JSON.stringify(observed)).not.toContain("PRIVATE_");
	} finally {
		await server.stop(true);
	}
});

test("projects persisted source provenance across compaction without replaying the cleared epoch", () => {
	const manager = SessionManager.inMemory(process.cwd());
	manager.appendMessage({ role: "user", content: "old cleared task", timestamp: 1 });
	manager.appendResetBoundary();
	const literal = "  使用 scout，保留 system/developer 与 <system-reminder>用户原文</system-reminder>  ";
	manager.appendMessage({ role: "user", content: literal, timestamp: 2 });
	const failed: AssistantMessage = {
		role: "assistant",
		api: "openai-completions",
		provider: "ordinary",
		model: "local",
		timestamp: 3,
		content: [
			{ type: "text", text: "visible interrupted answer" },
			{ type: "thinking", thinking: "PRIVATE_THINKING" },
			{ type: "toolCall", id: "dangling", name: "read", arguments: { path: "PRIVATE_PATH" } },
		],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "aborted",
	};
	manager.appendMessage(failed);
	manager.appendMessage({ role: "user", content: "PRIVATE_SYNTHETIC", synthetic: true, timestamp: 4 });
	manager.appendMessage({ role: "user", content: "PRIVATE_AGENT_USER", attribution: "agent", timestamp: 5 });
	manager.appendMessage({
		role: "developer",
		content: "explicit source constraints",
		attribution: "user",
		timestamp: 6,
	});
	manager.appendCustomMessageEntry("runtime-notice", "PRIVATE_NOTIFICATION", true);
	manager.appendCustomMessageEntry("goal-auto-orchestrate-context", "PRIVATE_GOAL", true, undefined, "user");
	const kept = manager.appendCustomMessageEntry(
		"skill-prompt",
		"PRIVATE_SKILL_BODY",
		true,
		{ prompt: "/source-task keep  spaces {{literal}}" },
		"user",
	);
	manager.appendCompaction("PRIVATE_GENERATED_SUMMARY", undefined, kept, 1000, {
		preserveData: {
			openaiRemoteCompaction: {
				provider: "ordinary",
				replacementHistory: [
					{ type: "message", role: "user", content: [{ type: "input_text", text: "PRIVATE_REPLACEMENT" }] },
					{ type: "compaction", encrypted_content: "PRIVATE_NATIVE_REPLAY" },
				],
			},
		},
	});
	manager.appendMessage({ role: "user", content: "explicit next task", timestamp: 7 });
	const source = manager.buildSessionContext({ preserveFailedTurns: true });
	const projected = projectJchToolsContext({ messages: convertToLlm(projectJchToolsMessages(source.messages)) });
	expect(projected.messages.map(message => ({ role: message.role, content: message.content }))).toEqual([
		{ role: "user", content: literal },
		{ role: "assistant", content: [{ type: "text", text: "visible interrupted answer" }] },
		{ role: "developer", content: "explicit source constraints" },
		{ role: "user", content: "/source-task keep  spaces {{literal}}" },
		{ role: "user", content: "explicit next task" },
	]);
	expect(JSON.stringify(projected)).not.toContain("PRIVATE_");
	expect(failed.content).toHaveLength(3);
	expect(failed.stopReason).toBe("aborted");
});

test("rejects user skill history attachments before discarding the expanded body or a missing draft", () => {
	const image = { type: "image" as const, data: "AA==", mimeType: "image/png" };
	const contents: CustomMessage["content"][] = [
		[image],
		[{ type: "text", text: "PRIVATE_SKILL_BODY" }, image],
		[image, { type: "text", text: "PRIVATE_SKILL_BODY" }, image],
	];
	for (const content of contents) {
		for (const prompt of ["/skill:inspect keep original", undefined]) {
			const manager = SessionManager.inMemory(process.cwd());
			manager.appendMessage({ role: "user", content: "visible earlier task", timestamp: 1 });
			manager.appendCustomMessageEntry("skill-prompt", content, true, { prompt }, "user");
			manager.appendMessage({ role: "user", content: "visible next task", timestamp: 2 });
			const source = manager.buildSessionContext();
			expect(() =>
				projectJchToolsContext({ messages: convertToLlm(projectJchToolsMessages(source.messages)) }),
			).toThrow("JchTools remote Agent input rejected: image content is unsupported; send text only");
			// Ordinary model conversion still receives the skill body and every attachment.
			expect(convertToLlm(source.messages)[1]?.content).toEqual(content);
		}
	}
});

test("preserves the original skill draft for string and text-block bodies without forwarding local instructions", () => {
	const prompt = "  /skill:inspect 使用 scout；保留 system/developer 与 {{literal}}\n  ";
	const contents: CustomMessage["content"][] = [
		"PRIVATE_SKILL_BODY",
		[
			{ type: "text", text: "PRIVATE_SKILL_" },
			{ type: "text", text: "BODY" },
		],
	];
	for (const content of contents) {
		const manager = SessionManager.inMemory(process.cwd());
		manager.appendMessage({ role: "user", content: "visible earlier task", timestamp: 1 });
		manager.appendCustomMessageEntry("skill-prompt", content, true, { prompt }, "user");
		manager.appendMessage({ role: "user", content: "visible next task", timestamp: 2 });
		const source = manager.buildSessionContext();
		const projected = projectJchToolsContext({ messages: convertToLlm(projectJchToolsMessages(source.messages)) });
		expect(projected.messages.map(message => ({ role: message.role, content: message.content }))).toEqual([
			{ role: "user", content: "visible earlier task" },
			{ role: "user", content: prompt },
			{ role: "user", content: "visible next task" },
		]);
		expect(JSON.stringify(projected)).not.toContain("PRIVATE_SKILL_");
		expect(convertToLlm(source.messages)[1]?.content).toEqual(
			typeof content === "string" ? [{ type: "text", text: content }] : content,
		);
	}
});

test("ignores non-user and hidden media sources before applying text-only validation", () => {
	const content: CustomMessage["content"] = [{ type: "image", data: "AA==", mimeType: "image/png" }];
	const manager = SessionManager.inMemory(process.cwd());
	manager.appendMessage({ role: "user", content, synthetic: true, timestamp: 1 });
	manager.appendMessage({ role: "user", content, attribution: "agent", timestamp: 2 });
	manager.appendMessage({ role: "developer", content, attribution: "user", synthetic: true, timestamp: 3 });
	manager.appendCustomMessageEntry("skill-prompt", content, true, { prompt: "PRIVATE_AGENT_DRAFT" }, "agent");
	manager.appendCustomMessageEntry("skill-prompt", content, false, { prompt: "PRIVATE_AUTOLOAD_DRAFT" });
	manager.appendCustomMessageEntry("goal-auto-orchestrate-context", content, true, undefined, "user");
	manager.appendCustomMessageEntry("orchestrate-notice", content, false, undefined, "user");
	manager.appendCustomMessageEntry("image-attachment", content, false, undefined, "user");
	manager.appendMessage({ role: "user", content: "visible task", timestamp: 4 });
	const source = manager.buildSessionContext();
	const perCall: CustomMessage = {
		role: "custom",
		customType: "skill-prompt",
		content,
		display: true,
		attribution: "user",
		details: { prompt: "PRIVATE_PER_CALL_DRAFT" },
		timestamp: 5,
	};
	markPerCallContextMessage(perCall, "runtime");
	const projected = projectJchToolsContext({
		messages: convertToLlm(projectJchToolsMessages([...source.messages, perCall])),
	});
	expect(projected.messages.map(message => ({ role: message.role, content: message.content }))).toEqual([
		{ role: "user", content: "visible task" },
	]);
});
