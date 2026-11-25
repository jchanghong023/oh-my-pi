import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { contentText, MARKER, type ModelRequest } from "../helpers/provider-fixture";
import { eventually, nativeDraftMatches, nativeDraftSnapshot, tuiTest, withTui } from "../helpers/tui-harness";

function callable(request: ModelRequest, name: string): string {
	const tool = request.tools?.find(item => item.function?.name.replace(/^_/u, "") === name)?.function?.name;
	if (!tool) throw new Error(`Ctrl+Enter Goal fixture requires native ${name}`);
	return tool;
}

describe("native Goal Ctrl+Enter tool-batch delivery", () => {
	test("Ctrl+Enter changes ordinary Goal work only after the current turn yields", async () => {
		if (!tuiTest) throw new Error("tui-test is required for the physical Ctrl+Enter Goal acceptance case");
		const feedbackCount = (request: ModelRequest) =>
			request.messages.filter(
				message => message.role === "user" && contentText(message.content).includes("ENTER_CHANGE_DIRECTION"),
			).length;
		const isGoalRequest = (request: ModelRequest) =>
			request.messages.some(
				message => message.role === "user" && contentText(message.content).includes("GOAL_ENTER_OBJECTIVE"),
			);
		let turns = 0;
		await withTui(
			{
				configuration: {
					tools: { commands: false },
					compaction: { enabled: false },
					goal: { continuationModes: [] },
					bash: { direnv: "off", allowCompoundCommands: true },
				},
				reply: request => {
					if (!isGoalRequest(request)) return { text: `${MARKER}_CHAT_READY` };
					turns++;
					if (turns === 1)
						return {
							tools: [
								{
									name: callable(request, "bash"),
									args: {
										i: "Holding the original batch",
										command:
											"printf running > enter-tool-started; while [ ! -f enter-release ]; do sleep 0.05; done; printf ENTER_BATCH_FINISHED",
										timeout: 30,
										pty: false,
									},
								},
								{
									name: callable(request, "write"),
									args: { path: "enter-batch-proof.txt", content: "ENTIRE_BATCH_FINISHED" },
								},
							],
						};
					if (turns === 2) {
						expect(
							request.messages
								.filter(message => message.role === "tool")
								.map(message => contentText(message.content))
								.join("\n"),
						).toContain("ENTER_BATCH_FINISHED");
						return { text: "GOAL_ORIGINAL_TURN_FINISHED" };
					}
					if (turns === 3 && feedbackCount(request) > 0) {
						return {
							tool: {
								name: callable(request, "write"),
								args: { path: "enter-changed-work.txt", content: "CTRL_ENTER_CHANGED_REAL_WORK" },
							},
						};
					}
					return { text: "GOAL_ENTER_FINISHED" };
				},
			},
			[120, 40],
			async ({ cwd, tui, provider }) => {
				await tui("submit", "/goal GOAL_ENTER_OBJECTIVE inspect the complete original batch");
				await eventually(() => Bun.file(path.join(cwd, "enter-tool-started")).exists(), Boolean);
				try {
					await tui("type", "ENTER_CHANGE_DIRECTION write the changed-work proof after the entire batch");
					await tui("key", "press", "Ctrl+Enter");
					await eventually(
						() => nativeDraftSnapshot(tui),
						({ screen, cursor }) =>
							screen.includes("ENTER_CHANGE_DIRECTION") && nativeDraftMatches(screen, "", cursor),
					);
					expect(provider.requests.filter(isGoalRequest)).toHaveLength(1);
				} finally {
					await Bun.write(path.join(cwd, "enter-release"), "release without cancellation");
				}
				await tui("expect", "text", "GOAL_ENTER_FINISHED", "--timeout", "30000");
				const inputs = provider.requests.filter(isGoalRequest);
				expect(inputs.map(feedbackCount)).toEqual([0, 0, 1, 1]);
				expect(await Bun.file(path.join(cwd, "enter-batch-proof.txt")).text()).toBe("ENTIRE_BATCH_FINISHED");
				expect(await Bun.file(path.join(cwd, "enter-changed-work.txt")).text()).toBe(
					"CTRL_ENTER_CHANGED_REAL_WORK",
				);
				for (const input of inputs) {
					expect(
						input.messages.some(message =>
							contentText(message.content).includes("MUST 全自动无人值守完成完整目标。"),
						),
					).toBe(false);
				}
			},
		);
	}, 120_000);
});
