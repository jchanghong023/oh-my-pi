import { buildModel } from "@oh-my-pi/pi-catalog/build";

/** Explicit protocol fixture, not a claim that Anthropic is in the live chat catalog. */
export function goalProtocolModel() {
	return buildModel({
		id: "claude-sonnet-4-5",
		name: "Goal history protocol fixture",
		provider: "anthropic",
		api: "anthropic-messages",
		baseUrl: "https://goal-protocol-fixture.invalid",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 200_000,
		maxTokens: 64_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
}
