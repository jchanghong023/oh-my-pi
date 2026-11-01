import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { TUI } from "@oh-my-pi/pi-tui";

function writeArgs(lineCount: number) {
	return {
		path: "notes.txt",
		content: Array.from({ length: lineCount }, (_, i) => `line ${i + 1}`).join("\n"),
	};
}

function partialWriteResult(text = "Writing notes.txt...") {
	return { content: [{ type: "text", text }] };
}

describe("ToolExecutionComponent write repaint seam", () => {
	const components: ToolExecutionComponent[] = [];

	beforeAll(async () => {
		await initTheme();
	});

	afterEach(() => {
		for (const component of components) component.stopAnimation();
		components.length = 0;
		vi.restoreAllMocks();
	});

	function makeComponent(args: unknown) {
		const requestRender = vi.fn();
		const ui = { requestRender, requestComponentRender() {} } as unknown as TUI;
		const component = new ToolExecutionComponent("write", args, {}, undefined, ui);
		components.push(component);
		requestRender.mockClear();
		return { component, requestRender };
	}

	it("forces a viewport repaint when a painted collapsed tail window receives its first result", () => {
		// 20 lines > WRITE_STREAMING_PREVIEW_LINES (12): the pending preview is a
		// tail window the first-result render re-anchors to the top of the file.
		const { component, requestRender } = makeComponent(writeArgs(20));
		component.render(80);

		component.updateResult(partialWriteResult(), true);

		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	it("does not repaint when the pending tail window never reaches the terminal", () => {
		const { component, requestRender } = makeComponent(writeArgs(20));
		// No render() before the result: no repaint for a shape the user never saw.

		component.updateResult(partialWriteResult(), true);

		expect(requestRender).not.toHaveBeenCalled();
	});

	it("does not repaint a collapsed preview that fits the streaming window", () => {
		// 12 lines render top-anchored without a tail window, so the first result
		// does not re-anchor the frame; wiping scrollback would be gratuitous.
		const { component, requestRender } = makeComponent(writeArgs(12));
		component.render(80);

		component.updateResult(partialWriteResult(), true);

		expect(requestRender).not.toHaveBeenCalled();
	});

	it("does not repaint an expanded pending preview", () => {
		// Expanded previews show the whole file top-anchored — no tail window to
		// re-anchor.
		const { component, requestRender } = makeComponent(writeArgs(20));
		component.setExpanded(true);
		component.render(80);

		component.updateResult(partialWriteResult(), true);

		expect(requestRender).not.toHaveBeenCalled();
	});

	it("preserves write collapse and expansion controls", () => {
		const { component } = makeComponent(writeArgs(80));
		component.updateResult({ content: [{ type: "text", text: "Wrote notes.txt" }] }, false);
		const collapsed = component.render(100).length;
		const collapsedNative = JSON.stringify(component.describe());
		component.setExpanded(true);
		expect(component.render(100).length).toBeGreaterThan(collapsed);
		expect(JSON.stringify(component.describe())).not.toBe(collapsedNative);
		component.setExpanded(false);
		expect(component.render(100)).toHaveLength(collapsed);
		expect(JSON.stringify(component.describe())).toBe(collapsedNative);
	});

	it("retains the complete multi-line command and result through the detailed expand control", () => {
		const command = `bun test ${"x".repeat(600)}\necho finished`;
		const ui = { requestRender() {}, requestComponentRender() {}, resetDisplay() {} } as unknown as TUI;
		const component = new ToolExecutionComponent("bash", { command }, {}, undefined, ui);
		components.push(component);
		component.setExpanded(true);
		expect(JSON.stringify(component.describe())).toContain("echo finished");
		expect(JSON.stringify(component.describe())).toContain("x".repeat(600));
		expect(Bun.stripANSI(component.render(80).join("\n"))).toContain("echo finished");
		component.updateResult({ content: [{ type: "text", text: "raw process output" }] }, false);
		expect(Bun.stripANSI(component.render(80).join("\n"))).toContain("raw process output");
		expect(JSON.stringify(component.describe())).toContain("raw process output");
	});
});
