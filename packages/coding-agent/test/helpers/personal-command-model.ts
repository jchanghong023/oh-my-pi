import { buildModel } from "@oh-my-pi/pi-catalog/build";

/** Protocol fixture for historical Claude effort semantics, not live provider catalog admission. */
export function personalCommandProtocolModel(id = "claude-sonnet-4-5") {
	return buildModel({
		id,
		name: `Personal command protocol fixture (${id})`,
		provider: "anthropic",
		api: "anthropic-messages",
		baseUrl: "https://personal-command-fixture.invalid",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 200_000,
		maxTokens: 64_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	});
}
