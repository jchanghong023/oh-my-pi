import { expect, test } from "bun:test";
import { createRoot } from "@oh-my-pi/pi-tui";
import { paintNode, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { describeTree } from "@oh-my-pi/pi-tui/testing/corpus";
import { PLAIN_THEME } from "@oh-my-pi/pi-tui/theme/plain";
import type { CoordinationDetails } from "../../../src/tools/details/wait";
import { formatOutputNotice, type TruncationMeta } from "../../../src/tools/output-meta-format";
import type { ToolResult, ToolViewState } from "../../../src/ui/tools/contract";
import "../../../src/ui/styles/tools/wait";
import { waitFailurePreview, waitPresenter } from "../../../src/ui/tools/wait";
import { bodyNodes, toolNode } from "./presenter-corpus";
import { type ToolScreen, toolScreenSuite } from "./screens";

export const waitScreen: ToolScreen = {
	dir: "tools/wait",
	name: "wait",
	presenter: waitPresenter,
};

toolScreenSuite(waitScreen);

function present(
	result: ToolResult<CoordinationDetails>,
	expanded = false,
	settledBashJobs?: ReadonlyMap<string, string>,
) {
	return createRoot(dispose => {
		try {
			const state: ToolViewState = {
				expanded,
				isPartial: false,
				argsComplete: true,
				executionStarted: true,
				renderContext: { settledBashJobs },
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

test("keeps Wait job tiles and diagnostics but does not repeat output already on an original Bash card", () => {
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
					errorText: "first error",
					artifactError: "write",
				},
				{ id: "bg_2", type: "bash", status: "failed", label: "second", durationMs: 200, errorText: "second error" },
			],
		},
	};
	const matched = new Map([["bg_1", "failed"]]);
	for (const view of Object.values(present(result, false, matched))) {
		expect(view).toContain("bg_1");
		expect(view).toContain("bg_2");
		expect(view).not.toContain("first error");
		expect(view).toContain("second error");
		expect(view).toContain("artifact write failed");
	}
	expect(present(result, true, matched).terminal).toContain("first error");
	expect(present(result, false, new Map([["bg_1", "completed"]])).terminal).toContain("first error");
});

test.each([
	{ capped: false, format: "current" },
	{ capped: true, format: "current" },
	{ capped: false, format: "legacy" },
	{ capped: true, format: "legacy" },
])("shows the failed Bash tail and truthful artifact label ($format, capped=$capped)", ({ capped, format }) => {
	const truncation: TruncationMeta = {
		direction: "tail",
		truncatedBy: "bytes",
		totalLines: 900,
		totalBytes: 100_000,
		outputLines: 500,
		outputBytes: 50_000,
		maxBytes: 50_000,
		artifactId: "123",
		...(capped ? { artifactElidedBytes: 4096 } : {}),
	};
	const meta = { truncation };
	const exitNotice = format === "legacy" ? "Command exited with code 2" : "[exit code 2]";
	const wallNotice = format === "legacy" ? "Wall time: 3.20 seconds" : "[took 3.20s]";
	const errorText =
		[
			'","truncated_json_fragment":true}',
			"earlier output not in the preview",
			"diagnostic: configuration is invalid",
			"",
			"details: check the input path",
			"",
			exitNotice,
			"",
			wallNotice,
		].join("\n") + formatOutputNotice(meta);
	const job = {
		id: "bg_failure",
		type: "bash",
		status: "failed",
		label: "run checks",
		durationMs: 3200,
		wallTimeMs: 3200,
		wallTimeNoticeEmitted: true,
		exitCode: 2,
		errorText,
		meta,
	} as const;
	const result: ToolResult<CoordinationDetails> = {
		content: [{ type: "text", text: "" }],
		details: { op: "wait", jobs: [job] },
	};
	for (const view of Object.values(present(result))) {
		expect(view).toContain("diagnostic: configuration is invalid");
		expect(view).toContain("details: check the input path");
		expect(view.indexOf("diagnostic:")).toBeLessThan(view.indexOf("details:"));
		expect(view).not.toContain("truncated_json_fragment");
		expect(view).not.toContain("earlier output not in the preview");
		expect(view).not.toContain(exitNotice);
		expect(view).not.toContain(wallNotice);
		expect(view).toContain("local://123.log");
		if (capped) {
			expect(view).toMatch(/(?:sample|not saved|样本)/i);
			expect(view).not.toMatch(/full output/i);
		}
	}
	expect(present(result, true).terminal).toContain("truncated_json_fragment");
});

test.each([
	{ notice: "[timed out after 3s]", trailing: true },
	{ notice: "[timed out after 3s; shell unresponsive, output may be incomplete]", trailing: false },
	{ notice: "[Command timed out after 3 seconds]", trailing: false },
])("keeps $notice separate from the Wait output body", ({ notice, trailing }) => {
	const job = {
		id: "bg_timeout",
		type: "bash",
		status: "failed",
		label: "run checks",
		timedOut: true,
		errorText: trailing ? `first line\nlast line\n\n${notice}` : `${notice}\n\nfirst line\nlast line`,
	} as const;
	expect(waitFailurePreview(job, false, undefined)).toMatchObject({
		lines: ["first line", "last line"],
		reason: notice,
	});
});
