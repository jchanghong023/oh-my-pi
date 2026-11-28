import { Tokenizer } from "@oh-my-pi/pi-agent-core";
import { type AssistantMessage, type Message, streamSimple, type UserMessage } from "@oh-my-pi/pi-ai";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { cfgOffline } from "../../config/auxiliary-model-policy";
import { getModelMatchPreferences, resolveModelRoleValue } from "../../config/model-resolver";
import { formatModelRoleAlias, roleCandidatePool } from "../../config/model-roles";
import enhancementPrompt from "../../prompts/system/prompt-enhancement.md" with { type: "text" };
import type { AgentViewSession } from "../../session/agent-session-handle";
import { operatorTitleText } from "../../session/messages";

const HISTORY_TURNS = 2;
const HISTORY_TOKENS = 2048;

function textContent(content: UserMessage["content"] | AssistantMessage["content"]): string {
	return typeof content === "string"
		? content
		: content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");
}

/** Keep the recent end of an oversized message without splitting a surrogate pair. */
function historyTail(text: string, tokenizer: Tokenizer, budget: number): string {
	let start = 0;
	let end = text.length;
	while (start < end) {
		const middle = start + Math.floor((end - start) / 2);
		if (tokenizer.checkTokenBudget(text.slice(middle).toWellFormed(), budget).fits) end = middle;
		else start = middle + 1;
	}
	return text.slice(start).toWellFormed();
}

function recentHistory(session: AgentViewSession, tokenizer: Tokenizer): Message[] {
	const source = session.messages;
	const history: Message[] = [];
	let turns = 0;
	let budget = HISTORY_TOKENS;
	for (let i = source.length - 1; i >= 0 && turns < HISTORY_TURNS && budget > 0; i--) {
		const message = source[i];
		const assistant = message.role === "assistant" ? message : undefined;
		const userText =
			message.role === "user"
				? message.synthetic || message.attribution === "agent"
					? undefined
					: textContent(message.content)
				: message.role === "custom" && !message.excludeFromContext
					? operatorTitleText(message)
					: undefined;
		if (!assistant && userText === undefined) continue;
		if (!assistant) turns++;
		let text = assistant ? textContent(assistant.content) : (userText ?? "");
		if (!text.trim()) continue;
		const tokens = tokenizer.countTokens(text, "strict");
		if (tokens > budget) text = historyTail(text, tokenizer, budget);
		budget -= tokens;
		if (!text.trim()) continue;
		history.push(
			assistant
				? {
						role: "assistant",
						content: [{ type: "text", text }],
						api: assistant.api,
						provider: assistant.provider,
						model: assistant.model,
						usage: assistant.usage,
						stopReason: "stop",
						timestamp: assistant.timestamp,
					}
				: { role: "user", content: text, timestamp: message.timestamp },
		);
	}
	return history.reverse();
}

export async function enhancePrompt(
	session: AgentViewSession,
	draft: string,
	signal: AbortSignal,
	metadataForProvider: (provider: string) => Record<string, unknown> | undefined,
): Promise<string> {
	const { settings, modelRegistry } = session;
	const offline = cfgOffline.get(settings);
	const pool = roleCandidatePool("smol", settings, modelRegistry);
	const eligible = offline ? pool.filter(candidate => candidate.provider === session.model?.provider) : pool;
	const model = resolveModelRoleValue(formatModelRoleAlias("smol"), eligible, {
		settings,
		matchPreferences: getModelMatchPreferences(settings),
	}).model;
	if (!model) throw new Error("No available smol model for prompt enhancement.");

	const messages = recentHistory(session, new Tokenizer(model));
	messages.push({ role: "user", content: draft, timestamp: Date.now() });
	const stream = streamSimple(
		model,
		{ systemPrompt: [enhancementPrompt], messages },
		{
			apiKey: modelRegistry.resolver(model, session.sessionId),
			metadata: metadataForProvider(model.provider),
			disableReasoning: true,
			cacheRetention: "none",
			signal,
		},
	);
	for await (const _event of stream) {
		// Drain the stream without displaying or retaining deltas.
	}
	const response = await stream.result();
	if (response.stopReason !== "stop") {
		throw new Error(
			response.stopReason === "length"
				? "The model truncated its rewrite."
				: "The model did not complete the rewrite.",
		);
	}
	const text = sanitizeText(textContent(response.content).replaceAll("\r\n", "\n"));
	if (!text.trim()) throw new Error("The model returned an empty rewrite.");
	return text;
}
