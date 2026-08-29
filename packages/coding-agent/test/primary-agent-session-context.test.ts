import { describe, expect, it } from "bun:test";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";

const timestamp = "2026-08-29T00:00:00.000Z";

describe("Primary Agent session replay", () => {
	it("defaults old sessions to Main", () => {
		expect(buildSessionContext([]).primaryAgent).toBe("main");
	});

	it("restores the last dedicated profile entry on the selected branch", () => {
		const entries: SessionEntry[] = [
			{ type: "primary_agent_change", id: "discuss", parentId: null, timestamp, primaryAgent: "discuss" },
			{ type: "primary_agent_change", id: "main", parentId: "discuss", timestamp, primaryAgent: "main" },
		];
		expect(buildSessionContext(entries, "discuss").primaryAgent).toBe("discuss");
		expect(buildSessionContext(entries, "main").primaryAgent).toBe("main");
	});

	it("maps only the last effective legacy Discuss mode on read", () => {
		const entries: SessionEntry[] = [
			{
				type: "mode_change",
				id: "discuss",
				parentId: null,
				timestamp,
				mode: "discuss",
				data: { previousTools: ["read", "write"] },
			},
			{ type: "mode_change", id: "none", parentId: "discuss", timestamp, mode: "none" },
		];
		expect(buildSessionContext(entries, "discuss").primaryAgent).toBe("discuss");
		expect(buildSessionContext(entries, "discuss").legacyDiscussPreviousTools).toEqual(["read", "write"]);
		expect(buildSessionContext(entries, "none").primaryAgent).toBe("main");
		expect(buildSessionContext(entries, "none").legacyDiscussPreviousTools).toBeUndefined();
	});
});
