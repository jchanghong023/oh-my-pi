import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getSttModelSpec, type SttModelKey } from "@oh-my-pi/pi-coding-agent/stt/models";

/** Local STT is a protocol fixture, not a model from the restricted chat catalog. */
export function localSttModel(id: SttModelKey) {
	const spec = getSttModelSpec(id);
	if (!spec) throw new Error(`Missing STT fixture specification: ${id}`);
	return buildModel({
		id,
		name: spec.label,
		api: "local-inference",
		kind: "stt",
		provider: "local",
		baseUrl: "local://inference",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	});
}
