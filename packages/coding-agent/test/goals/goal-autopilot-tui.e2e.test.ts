import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { contentText, MARKER, type ModelRequest } from "../helpers/provider-fixture";
import { eventually, nativeDraftMatches, nativeDraftSnapshot, tuiTest, withTui } from "../helpers/tui-harness";

function callable(request: ModelRequest, name: string): string {
	const found = request.tools?.find(tool => tool.function?.name.replace(/^_/u, "") === name)?.function?.name;
	if (!found) throw new Error(`The native Goal test requires callable ${name}`);
	return found;
}

describe("native Goal user follow-up delivery", () => {
	test("Ctrl+Q changes autopilot work immediately after the complete tool batch", async () => {
		if (!tuiTest) throw new Error("tui-test is required to verify the real Goal terminal entry and Ctrl+Q");
		const feedbackCount = (request: ModelRequest) =>
			request.messages.filter(
				message => message.role === "user" && contentText(message.content).includes("GOAL_CHANGE_DIRECTION"),
			).length;
		const isGoalRequest = (request: ModelRequest) =>
			request.messages.some(
				message => message.role === "user" && contentText(message.content).includes("GOAL_KEY_OBJECTIVE"),
			);
		let goalRequests = 0;
		await withTui(
			{
				configuration: {
					tools: { commands: true },
					compaction: { enabled: false },
					goal: { continuationModes: [] },
					bash: { direnv: "off", allowCompoundCommands: true },
				},
				reply: request => {
					if (!isGoalRequest(request)) return { text: `${MARKER}_CHAT_READY` };
					goalRequests++;
					if (goalRequests === 1)
						return {
							tools: [
								{
									name: callable(request, "bash"),
									args: {
										i: "Holding the current batch",
										command:
											"printf running > tool-started; while [ ! -f release-tool ]; do sleep 0.05; done; printf GOAL_BATCH_FINISHED",
										timeout: 30,
										pty: false,
									},
								},
								{
									name: callable(request, "write"),
									args: { path: "batch-proof.txt", content: "COMPLETE_BATCH" },
								},
							],
						};
					if (goalRequests === 2 && feedbackCount(request) > 0) {
						const results = request.messages
							.filter(message => message.role === "tool")
							.map(message => contentText(message.content))
							.join("\n");
						expect(results).toContain("GOAL_BATCH_FINISHED");
						return {
							tool: {
								name: callable(request, "write"),
								args: { path: "changed-work.txt", content: "FOLLOWUP_CHANGED_REAL_WORK" },
							},
						};
					}
					return { text: "GOAL_KEYS_FINISHED" };
				},
			},
			[120, 40],
			async ({ cwd, tui, provider }) => {
				await tui("submit", "/goal-autopilot GOAL_KEY_OBJECTIVE inspect the entire current tool batch");
				await eventually(() => Bun.file(path.join(cwd, "tool-started")).exists(), Boolean);
				try {
					await tui("type", "GOAL_CHANGE_DIRECTION write the changed-work proof after this complete batch");
					await tui("key", "press", "Ctrl+Q");
					await eventually(
						() => nativeDraftSnapshot(tui),
						({ screen, cursor }) =>
							screen.includes("GOAL_CHANGE_DIRECTION") && nativeDraftMatches(screen, "", cursor),
					);
					expect(provider.requests.filter(isGoalRequest)).toHaveLength(1);
				} finally {
					await Bun.write(path.join(cwd, "release-tool"), "release the original tool without cancelling it");
				}
				await tui("expect", "text", "GOAL_KEYS_FINISHED", "--timeout", "30000");
				expect(provider.requests.filter(isGoalRequest).map(feedbackCount)).toEqual([0, 1, 1]);
				expect(await Bun.file(path.join(cwd, "batch-proof.txt")).text()).toBe("COMPLETE_BATCH");
				expect(await Bun.file(path.join(cwd, "changed-work.txt")).text()).toBe("FOLLOWUP_CHANGED_REAL_WORK");
			},
		);
	}, 120_000);
});
