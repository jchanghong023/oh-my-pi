import { beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TUI } from "@oh-my-pi/pi-tui";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
	await initTheme(false, undefined, undefined, "dark", "light");
}, 15_000);

const SKIP_TEXT = "Skipped due to a queued background completion (job or supervised process).";

function renderTool(
	name: "edit" | "wait",
	result: { content: Array<{ type: string; text: string }>; details?: unknown; isError?: boolean },
	options: { expanded?: boolean; rows?: number } = {},
): string {
	const tui = new TUI(new VirtualTerminal(120, 20));
	const component = new ToolExecutionComponent(
		name,
		name === "edit" ? { path: "hub/src/viewer/session.ts" } : {},
		{},
		undefined,
		tui,
	);
	component.updateResult(result, false);
	component.setExpanded(options.expanded ?? false);
	component.setTranscriptAllocation(options.rows ?? 20, { tick: 0, now: 0 });
	return Bun.stripANSI(component.render(120).join("\n"));
}

describe("mid-turn steering skip rendering", () => {
	it("hides skipped waits in collapsed, expanded, and compact views", () => {
		const skipDetails = [
			{ __synthetic: true, source: "interrupt_skipped", executed: false },
			{ __interrupted: true, source: "interrupt_skipped", execution: "started" },
		];

		for (const details of skipDetails) {
			const result = { content: [{ type: "text", text: SKIP_TEXT }], details, isError: true };
			expect(renderTool("wait", result)).toBe("");
			expect(renderTool("wait", result, { expanded: true })).toBe("");
			expect(renderTool("wait", result, { rows: 1 })).toBe("");
		}
	});

	it("preserves other skipped tool cards and real wait results", async () => {
		const skippedEdit = renderTool("edit", {
			content: [{ type: "text", text: SKIP_TEXT }],
			details: { __synthetic: true, source: "interrupt_skipped", executed: false },
			isError: true,
		});
		expect(skippedEdit).toContain("Edit");

		const realWait = renderTool(
			"wait",
			{
				content: [{ type: "text", text: "No background work to wait for" }],
				details: { op: "wait", jobs: [] },
			},
			{ expanded: true },
		);
		expect(realWait).toContain("No background work to wait for");
	}, 15_000);

	it("still renders a genuine edit failure as an error", async () => {
		const failure = "Cannot apply edit: target was not found";

		const rendered = renderTool("edit", { content: [{ type: "text", text: failure }], details: {}, isError: true });

		expect(rendered).toContain(failure);
	}, 15_000);
});
