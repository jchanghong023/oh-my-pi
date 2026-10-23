import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { completeSimple, type Context, type Model } from "@oh-my-pi/pi-ai";
import { concreteThinkingLevel, toReasoningEffort } from "@oh-my-pi/pi-tui/thinking";
import { Type } from "@sinclair/typebox";
import { ModelRegistry } from "../../config/model-registry";
import { Settings } from "../../config/settings";
import { discoverAuthStorage } from "../../sdk";
import type { AuthStorage } from "../../session/auth-storage";
import type { ZCodeProviderConfiguration } from "./provider-config";
import type { LegacyProtocol as L } from "./schema";

function contextFor(params: L.ZCodeWorkspaceGenerateTextParams, model: Model): Context {
	const context: Context = { messages: [], systemPrompt: [] };
	const timestamp = Date.now();
	for (const message of params.messages ?? [{ role: "user", content: params.prompt! }]) {
		switch (message.role) {
			case "system":
				context.systemPrompt!.push(message.content);
				break;
			case "user":
				context.messages.push({ role: "user", content: message.content, timestamp });
				break;
			case "tool":
				context.messages.push({
					role: "toolResult",
					toolCallId: message.toolCallId,
					toolName: message.toolName,
					content: [{ type: "text", text: message.content }],
					isError: message.isError ?? false,
					timestamp,
				});
				break;
			case "assistant":
				context.messages.push({
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					timestamp,
					content: [
						{ type: "text", text: message.content },
						...(message.toolCalls ?? []).map(call => ({
							type: "toolCall" as const,
							id: call.id,
							name: call.name,
							arguments: call.input as Record<string, unknown>,
						})),
					],
					stopReason: message.toolCalls?.length ? "toolUse" : "stop",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				});
		}
	}
	if (params.tools)
		context.tools = params.tools.map(tool => ({
			name: tool.name,
			description: tool.description ?? "",
			parameters: Type.Unsafe(tool.inputSchema),
		}));
	return context;
}

/** 工作区辅助生成不属于聊天：只借用原生模型配置和 completion，不创建会话或写 transcript。 */
export async function generateWorkspaceText(
	configuration: ZCodeProviderConfiguration,
	params: L.ZCodeWorkspaceGenerateTextParams,
	signal: AbortSignal,
): Promise<L.ZCodeWorkspaceGenerateTextResult> {
	signal.throwIfAborted();
	const cwd = resolve(params.workspace.workspacePath);
	const settings = await Settings.loadReadOnly({ cwd });
	let auth: AuthStorage | undefined;
	try {
		auth = await discoverAuthStorage(undefined, { cwd, settings });
		const registry = new ModelRegistry(auth, undefined, { settings });
		await configuration.prepare(cwd, settings, registry);
		signal.throwIfAborted();
		const selection = params.selection;
		const model = registry.find(selection.providerId, selection.modelId);
		if (!model) throw new Error(`Unknown model: ${selection.providerId}/${selection.modelId}`);
		const level = selection.options?.reasoningLevel;
		const thinking =
			level === undefined ? undefined : configuration.resolveThinkingLevel(model.provider, model.id, level);
		if (level !== undefined && thinking === undefined) throw new Error("Unsupported Host reasoning level");
		const sessionId = randomUUID();
		const supplied = await configuration.resolveRequestAuth(
			{ sessionId, workspace: params.workspace, modelSelection: selection },
			model,
			signal,
		);
		const apiKey = supplied?.apiKey ?? (await registry.getApiKey(model, sessionId, { signal }));
		const headers = { ...(await registry.getProviderHeaders(model.provider)), ...supplied?.headers };
		if (apiKey === undefined && Object.keys(headers).length === 0)
			throw new Error(`No request authentication for provider: ${model.provider}`);
		const response = await completeSimple(model, contextFor(params, model), {
			apiKey,
			headers,
			signal,
			maxTokens: params.maxOutputTokens,
			maxHttpAttempts: 1,
			reasoning: toReasoningEffort(concreteThinkingLevel(thinking)),
			disableReasoning: thinking === "off",
			onPayload: payload => configuration.transformRequestPayload(payload, model, selection, params.maxOutputTokens),
		});
		signal.throwIfAborted();
		if (response.stopReason === "error" || response.stopReason === "aborted")
			throw new Error(response.errorMessage || `Provider request ${response.stopReason}`);
		const toolCalls = response.content
			.filter(block => block.type === "toolCall")
			.map(call => ({
				id: call.id,
				name: call.name,
				input: call.arguments,
			}));
		return {
			text: response.content
				.filter(block => block.type === "text")
				.map(block => block.text)
				.join(""),
			selection,
			finishReason: response.stopReason,
			...(toolCalls.length ? { toolCalls } : {}),
			usage: {
				inputTokens: response.usage.input,
				outputTokens: response.usage.output,
				totalTokens: response.usage.totalTokens,
				cacheReadTokens: response.usage.cacheRead,
				cacheWriteTokens: response.usage.cacheWrite,
			},
		};
	} finally {
		auth?.close();
		settings.cancelPendingSaves();
	}
}
