import { expect, test } from "bun:test";
import { createRoot, isUiNode } from "@oh-my-pi/pi-tui";
import { paintNode, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { describeTree } from "@oh-my-pi/pi-tui/testing/corpus";
import { PLAIN_THEME } from "@oh-my-pi/pi-tui/theme/plain";
import "../../../src/ui/styles/tools/write";
import { writePresenter } from "../../../src/ui/tools/write";
import { ToolBlock, ToolCall } from "../../../src/ui/transcript/tool-block";
import { flowSuite } from "./tool-flows";

for (const id of [
	"edit",
	"edit-multi-file-preview",
	"edit_delete",
	"edit_move",
	"apply_patch",
	"write",
	"write_agent",
	"write_agent_broadcast",
	"write_agent_failed_receipt",
	"write_proc_cancel",
	"write_proc_mode",
	"write_proc_stdin",
	"write_proc_stop",
	"todo",
	"wait",
	"think",
	"resolve",
	"reject",
	"yield",
])
	flowSuite(id);

test("settled Write previews expand without losing content, then return to the original collapsed view", () => {
	createRoot(dispose => {
		try {
			const content = Array.from({ length: 80 }, (_, i) => `LINE_${String(i).padStart(2, "0")}`).join("\n");
			const call = new ToolCall({
				id: "write-expand",
				name: "write",
				presenter: writePresenter,
				args: { path: "notes.txt", content },
			});
			call.setArgsComplete();
			call.setExecutionStarted();
			call.updateResult({ content: [{ type: "text", text: "Wrote notes.txt" }] }, false);
			const node = ToolBlock({ call });
			if (!isUiNode(node)) throw new Error("ToolBlock must build one node");
			const env = staticEnvironment(PLAIN_THEME);
			const view = () => ({ terminal: paintNode(env, node, 100).rows, native: describeTree(node, env, 100) });
			const collapsed = view();
			call.setExpanded(true);
			const expanded = view();
			expect(expanded.terminal.join("\n")).toContain("LINE_79");
			expect(expanded.native).not.toEqual(collapsed.native);
			call.setExpanded(false);
			expect(view()).toEqual(collapsed);
		} finally {
			dispose();
		}
	});
});
