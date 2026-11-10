import { describe, expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";
import { fixture, GATE_BUDGET, PublicPeer, test, textValues } from "./process-fixture";
import { registerPackagedSkillTest } from "./process-packaged-skills-fixture";
import { createProviderFixture, rolePayload } from "./provider-fixture";

describe("spec-driven actual OMP public entry", () => {
	test(
		"ordinary sessions retain native read, write and Task outside /dev",
		async () => {
			await using root = await TempDir.create("@omp-spec-ordinary-control-");
			await using provider = createProviderFixture();
			const config = await fixture(root, provider.baseUrl);
			await using peer = new PublicPeer(config.cwd, config.env, provider);
			await peer.start();
			const events = await peer.promptAndWait(
				"OMP_SPEC_ORDINARY_CONTROL: exercise ordinary native read, write and Task.",
				undefined,
				GATE_BUDGET,
			);
			expect(textValues(events).some(text => text.includes("OMP_SPEC_ORDINARY_CONTROL_DONE"))).toBe(true);
			expect(await fs.readFile(path.join(config.cwd, "ordinary-note.txt"), "utf8")).toBe(
				"ordinary session remains writable\n",
			);
			expect(provider.requests.every(request => !rolePayload(request))).toBe(true);
			const native = provider.requests
				.flatMap(request => request.messages)
				.flatMap(message => message.tool_calls ?? [])
				.filter(isRecord);
			expect(
				native.some(
					call =>
						isRecord(call.function) &&
						typeof call.function.name === "string" &&
						call.function.name.replace(/^_/u, "") === "task",
				),
			).toBe(true);
			expect(provider.failures).toEqual([]);
		},
		GATE_BUDGET,
	);

	registerPackagedSkillTest(true);
});
