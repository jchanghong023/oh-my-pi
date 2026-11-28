import { expect, test } from "bun:test";
import { createRoot } from "@oh-my-pi/pi-tui";
import { paintNode, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { describeTree } from "@oh-my-pi/pi-tui/testing/corpus";
import { PLAIN_THEME } from "@oh-my-pi/pi-tui/theme/plain";
import type { CoordinationDetails } from "../../../src/tools/details/wait";
import type { ToolResult, ToolViewState } from "../../../src/ui/tools/contract";
import "../../../src/ui/styles/tools/wait";
import { waitPresenter } from "../../../src/ui/tools/wait";
import { bodyNodes, toolNode } from "./presenter-corpus";
import { type ToolScreen, toolScreenSuite } from "./screens";

export const waitScreen: ToolScreen = {
	dir: "tools/wait",
	name: "wait",
	presenter: waitPresenter,
};

toolScreenSuite(waitScreen);

function present(result: ToolResult<CoordinationDetails>, expanded: boolean) {
	return createRoot(dispose => {
		try {
			const state: ToolViewState = {
				expanded,
				isPartial: false,
				argsComplete: true,
				executionStarted: true,
			};
			const view = waitPresenter.result!(result, state, {});
			const node = toolNode(
				"wait",
				{ ...view, term: { ...view?.term, expanded } },
				bodyNodes(view?.body),
				"done",
				state,
			);
			const env = staticEnvironment(PLAIN_THEME);
			return {
				terminal: Bun.stripANSI(paintNode(env, node, 160).rows.join("\n")),
				native: JSON.stringify(describeTree(node, env, 160)),
			};
		} finally {
			dispose();
		}
	});
}

test("shows the upstream Wait completion log, expanded preview, and native job tiles", () => {
	const result: ToolResult<CoordinationDetails> = {
		content: [{ type: "text", text: "original wait output" }],
		details: {
			op: "wait",
			jobs: [
				{
					id: "bg_1",
					type: "bash",
					status: "failed",
					label: "first",
					durationMs: 100,
					errorText: "first error\nadditional diagnostic",
					artifactError: "write",
				},
				{ id: "bg_2", type: "bash", status: "failed", label: "second", durationMs: 200, errorText: "second error" },
			],
		},
	};
	const before = structuredClone(result);
	const collapsed = present(result, false);
	for (const jobId of ["bg_1", "bg_2"]) {
		expect(collapsed.terminal).toContain(jobId);
		expect(collapsed.native).toContain(jobId);
	}
	expect(collapsed.terminal).toContain("first error");
	expect(collapsed.terminal).toContain("second error");
	expect(collapsed.terminal).toContain("artifact write failed");
	expect(collapsed.terminal).not.toContain("additional diagnostic");
	expect(collapsed.terminal).not.toContain("Output tail:");
	expect(collapsed.native).not.toContain("first error");
	expect(present(result, true).terminal).toContain("additional diagnostic");
	expect(result).toEqual(before);
});
