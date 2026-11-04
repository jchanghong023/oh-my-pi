export type ZeroConfigRequest = {
	model: string;
	messages: Array<{ role: string; content: unknown }>;
	tools?: Array<{ name: string }>;
};

export function zeroConfigAnthropicReply(model: string, write: boolean): Response {
	const frames = [
		{
			type: "message_start",
			message: {
				id: "zero-config-message",
				type: "message",
				role: "assistant",
				model,
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 10, output_tokens: 0 },
			},
		},
		{
			type: "content_block_start",
			index: 0,
			content_block: write
				? { type: "tool_use", id: "zero_config_write", name: "write", input: {} }
				: { type: "text", text: "" },
		},
		{
			type: "content_block_delta",
			index: 0,
			delta: write
				? {
						type: "input_json_delta",
						partial_json: JSON.stringify({ path: "proof.txt", content: "ZERO_CONFIG_TOOL_EFFECT" }),
					}
				: { type: "text_delta", text: "ZERO_CONFIG_COMPLETE" },
		},
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: write ? "tool_use" : "end_turn", stop_sequence: null },
			usage: { output_tokens: 5 },
		},
		{ type: "message_stop" },
	];
	return new Response(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}

export function zeroConfigHasToolResult(body: ZeroConfigRequest): boolean {
	return body.messages.some(
		message =>
			Array.isArray(message.content) &&
			message.content.some(block => block?.type === "tool_result" && block.tool_use_id === "zero_config_write"),
	);
}
