/** Bash transcript output as captured, described to Tern, and painted in the terminal. */
import { expect, test } from "bun:test";
import { createRoot, isUiNode, type UiNode } from "@oh-my-pi/pi-tui";
import { paintNode, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { describeTree } from "@oh-my-pi/pi-tui/testing/corpus";
import { PLAIN_THEME } from "@oh-my-pi/pi-tui/theme/plain";
import type { TspShellProps } from "@oh-my-pi/pi-wire";
import "../../../src/ui/styles/tools/bash";
import "../../../src/ui/styles/tools/block";
import { bashPresenter } from "../../../src/ui/tools/bash";
import { ToolBlock, ToolCall } from "../../../src/ui/transcript/tool-block";

function shellPresentation(tree: UiNode): TspShellProps["presentation"] {
	const shell = tree
		.children()[0]
		?.children()
		.find(child => child.kind === "shell");
	if (!shell) throw new Error("the bash card must hold a shell node");
	return (shell.props() as TspShellProps).presentation;
}

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
			expect(shellPresentation(tree).output).toBe("alpha\nbeta\n");
		} finally {
			dispose();
		}
	});
});

test.each([
	{ label: "current", wall: "[took 0.02s]", exit: "[exit code 23]" },
	{ label: "legacy", wall: "Wall time: 0.02 seconds", exit: "Command exited with code 23" },
])("keeps raw artifact references and folds $label execution notices into the Bash footer", ({ wall, exit }) => {
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
			const raw = `diagnostic\n\n[raw output: local://195.log]\n\n${wall}\n\n${exit}\n`;
			call.updateResult(
				{
					content: [{ type: "text", text: raw }],
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
				const footer = terminal.trimEnd().split("\n").at(-1);
				expect(terminal).toContain("diagnostic");
				expect(terminal).not.toContain(exit);
				expect(terminal).not.toContain(wall);
				expect(footer).toContain("local://195.log");
				expect(footer).toContain("20ms/5m");
				expect(footer).toContain("23");
				// Tern gets the capture on its command node, but draws the separate output and footer segments.
				expect(describeTree(tree, env)).toMatchObject({
					p: { collapsed: !expanded },
					c: [
						{
							p: { role: "omp.run" },
							c: [
								{ k: "shell", p: { role: "omp.tool.bash.command", presentation: { output: raw } } },
								{ k: "ansi", p: { role: "omp.tool.bash.output", text: "diagnostic" } },
								{
									p: { role: "omp.run.foot" },
									c: [
										{ p: { role: "omp.run.state", spans: [{ t: "exit 23" }] } },
										{ p: { role: "omp.run.time", stopped: 20 } },
										{ p: { role: "omp.run.facts", spans: [{ t: "Artifact 195" }] } },
									],
								},
							],
						},
					],
				});
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
			const terminal = () => Bun.stripANSI(paintNode(env, tree, 80).rows.join("\n"));
			for (const [mode, lastLine] of [
				["pseudo", 'print("finished")'],
				["raw", "echo finished"],
			] as const) {
				call.shellVizAction(`view:${mode}`);
				const rows = shellPresentation(tree).rows.map(row => row.segments.map(segment => segment.text).join(""));
				expect(rows[0]).toContain(long);
				expect(rows[1]).toBe(lastLine);
				const view = terminal();
				expect(view.match(/x+/g)?.join("")).toBe(long);
				expect(view).toContain(lastLine);
			}
			call.updateResult({ content: [{ type: "text", text: "raw process output" }] }, false);
			expect(terminal()).toContain("raw process output");
			expect(describeTree(tree, env)).toMatchObject({
				p: { collapsed: false },
				c: [
					{
						c: [
							{ k: "shell" },
							{ k: "ansi", p: { role: "omp.tool.bash.output", text: "raw process output" } },
							{ p: { role: "omp.run.foot" } },
						],
					},
				],
			});
		} finally {
			dispose();
		}
	});
});
