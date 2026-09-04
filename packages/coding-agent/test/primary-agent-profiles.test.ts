import { describe, expect, it } from "bun:test";
import { getPrimaryAgentProfile, projectPrimaryAgentToolNames } from "@oh-my-pi/pi-coding-agent/primary-agent/profiles";

describe("Primary Agent profile projection", () => {
	const tools = ["read", "write", "task", "grep", "bash", "ask", "mcp__server__tool", "extension_tool", "unknown"];

	it("leaves the Main base slate unchanged", () => {
		expect(projectPrimaryAgentToolNames(tools, getPrimaryAgentProfile("main"))).toEqual(tools);
	});

	it("keeps only approved Discuss tools in their base order", () => {
		expect(
			projectPrimaryAgentToolNames(
				tools,
				getPrimaryAgentProfile("discuss"),
				name => name === "read" || name === "grep" || name === "ask",
			),
		).toEqual(["read", "grep", "ask"]);
	});
});
