/** A bash run's presented output as Tern is sent it: what the command printed, its closing newline included. */
import { expect, test } from "bun:test";
import { createRoot, isUiNode, type UiNode } from "@oh-my-pi/pi-tui";
import { paintNode, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { describeTree } from "@oh-my-pi/pi-tui/testing/corpus";
import { PLAIN_THEME } from "@oh-my-pi/pi-tui/theme/plain";
import "../../../src/ui/styles/tools/bash";
import { bashPresenter } from "../../../src/ui/tools/bash";
import { ToolBlock, ToolCall } from "../../../src/ui/transcript/tool-block";

test("the shell presentation carries the run's output verbatim", () => {
	createRoot(dispose => {
		try {
			const call = new ToolCall({
				id: "call1",
				name: "bash",
				args: { command: "printf 'alpha\\nbeta\\n'" },
				presenter: bashPresenter,
			});
			call.setArgsComplete();
			call.setExecutionStarted();
			call.updateResult({ content: [{ type: "text", text: "alpha\nbeta\n" }] }, false);
			const tree = ToolBlock({ call });
			if (!isUiNode(tree)) throw new Error("ToolBlock must build one node");
			const find = (at: UiNode): UiNode | undefined =>
				at.kind === "shell"
					? at
					: at
							.children()
							.map(find)
							.find(found => found !== undefined);
			const shell = find(tree);
			if (!shell) throw new Error("the bash card must hold a shell node");
			expect((shell.props() as { presentation?: { output?: string } }).presentation?.output).toBe("alpha\nbeta\n");
		} finally {
			dispose();
		}
	});
});

test("keeps raw artifact references and folds only the execution notices into the Bash footer", () => {
	createRoot(dispose => {
		try {
			const call = new ToolCall({
				id: "call-footer",
				name: "bash",
				presenter: bashPresenter,
				args: { command: "test-command" },
			});
			call.setArgsComplete();
			call.setExecutionStarted();
			call.updateResult(
				{
					content: [
						{
							type: "text",
							text: "diagnostic\n\n[raw output: local://195.log]\n\nWall time: 0.02 seconds\n\nCommand exited with code 23",
						},
					],
					details: { exitCode: 23, wallTimeMs: 20, wallTimeNoticeEmitted: true, timeoutSeconds: 300 },
					isError: true,
				},
				false,
			);
			const tree = ToolBlock({ call });
			if (!isUiNode(tree)) throw new Error("ToolBlock must build one node");
			const env = staticEnvironment(PLAIN_THEME);
			for (const expanded of [false, true]) {
				call.setExpanded(expanded);
				const terminal = Bun.stripANSI(paintNode(env, tree, 120).rows.join("\n"));
				const native = JSON.stringify(describeTree(tree, env));
				for (const view of [terminal, native]) {
					expect(view).toContain("diagnostic");
					expect(view).toContain("local://195.log");
					expect(view).not.toContain("Command exited with code 23");
					expect(view).not.toContain("Wall time: 0.02 seconds");
				}
				expect(terminal).toContain("20ms/5m");
				expect(terminal).toContain("23");
			}
		} finally {
			dispose();
		}
	});
});

test("expanding a Bash card preserves the complete multiline command and its result", () => {
	createRoot(dispose => {
		try {
			const long = "x".repeat(600);
			const command = `bun test ${long}\necho finished`;
			const call = new ToolCall({ id: "long-bash", name: "bash", args: { command }, presenter: bashPresenter });
			call.setArgsComplete();
			call.setExecutionStarted();
			call.setExpanded(true);
			const tree = ToolBlock({ call });
			if (!isUiNode(tree)) throw new Error("ToolBlock must build one node");
			const env = staticEnvironment(PLAIN_THEME);
			const native = () => JSON.stringify(describeTree(tree, env));
			const terminal = () => Bun.stripANSI(paintNode(env, tree, 80).rows.join("\n"));
			expect(native()).toContain(long);
			expect(native()).toContain("echo finished");
			expect(terminal()).toContain("echo finished");
			call.updateResult({ content: [{ type: "text", text: "raw process output" }] }, false);
			expect(terminal()).toContain("raw process output");
			expect(native()).toContain("raw process output");
		} finally {
			dispose();
		}
	});
});
