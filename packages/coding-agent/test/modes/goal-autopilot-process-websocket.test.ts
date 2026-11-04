import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { endpoint, send, textEvents, toolEvents } from "../../../ai/test/fixtures/openai-responses-server";
import { command, create, finishedOutput, fixture, ProcessPeer, subscribe } from "./zcode-process-harness";

// Exercise the real source CLI's app-server entry, provider transport and read
// tool. The loopback service chooses responses; it does not implement Goal policy.
describe("public Goal Codex WebSocket history", () => {
	test.each(["goal", "goal-autopilot"] as const)(
		"%s persists its normal history and chains ten real tool round-trips",
		async goalCommand => {
			await using root = await TempDir.create("@goal-codex-wire-");
			await using config = await fixture(root);
			const objective =
				"Inspect all ten tool results.\n\nKeep literal {{objective}} & <user> content.\tGOAL_WIRE_OBJECTIVE";
			// Model ten distinct reads, not an identical-call loop: production repeat-read
			// advisories and same-file history pruning must remain enabled.
			const files = Array.from({ length: 10 }, (_, index) => ({
				path: `wire-proof-${index + 1}.txt`,
				content: `TEN_CODEX_READ_RESULTS_${index + 1}`,
			}));
			const responseFrames: Array<{ connection: number; type: unknown; response: unknown }> = [];
			const wire = endpoint((socket, body, index) => {
				expect(body.type).toBe("response.create");
				const file = files[index - 1];
				const events = file
					? toolEvents("read", JSON.stringify({ path: file.path }), `resp_${index}`, `read_${index}`)
					: textEvents("GOAL_WIRE_FINISHED", `resp_${index}`);
				send(socket, events);
				for (const event of events) {
					if (event.type === "response.created" || event.type === "response.completed") {
						responseFrames.push({ connection: socket.data.id, type: event.type, response: event.response });
					}
				}
			});
			try {
				const token = `aaa.${Buffer.from(
					JSON.stringify({
						"https://api.openai.com/auth": { chatgpt_account_id: "goal-wire-account" },
					}),
				).toString("base64url")}.bbb`;
				// Register the loopback transport under an admitted provider identity;
				// arbitrary chat-provider aliases are intentionally excluded by policy.
				await Bun.write(
					path.join(config.agentDir, "models.yml"),
					JSON.stringify({
						providers: {
							"openai-codex": {
								baseUrl: `${wire.server.url.origin}/backend-api/codex`,
								api: "openai-codex-responses",
								apiKey: token,
								models: [
									{
										id: "gpt-5.3-codex-spark",
										name: "Isolated Goal wire model",
										reasoning: false,
										preferWebsockets: true,
										input: ["text"],
										contextWindow: 131072,
										maxTokens: 1024,
										cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
									},
								],
							},
						},
					}),
				);
				await Bun.write(
					path.join(config.agentDir, "config.yml"),
					JSON.stringify({
						modelRoles: { default: "openai-codex/gpt-5.3-codex-spark", smol: "openai-codex/gpt-5.3-codex-spark" },
						defaultThinkingLevel: "off",
						tools: { xdev: false },
						skills: { enabled: false },
						providers: { openaiWebsockets: "on", cacheWarming: "off" },
						compaction: { enabled: false },
						goal: { continuationModes: [] },
					}),
				);
				await Promise.all(files.map(file => Bun.write(path.join(config.cwdA, file.path), file.content)));
				{
					// Cache-only catalog discovery keeps this inference-only wire service
					// isolated; offline mode still permits explicitly selected inference.
					await using peer = new ProcessPeer(config.cwdA, { ...config.env, OMP_OFFLINE: "1" });
					await peer.ready();
					const sessionId = await create(peer, config.cwdA, {
						providerId: "openai-codex",
						modelId: "gpt-5.3-codex-spark",
					});
					await subscribe(peer, sessionId);
					expect(
						await command(peer, sessionId, "sendText", { text: `/${goalCommand} ${objective}` }),
					).toMatchObject({ status: "accepted" });
					await finishedOutput(peer, sessionId, "GOAL_WIRE_FINISHED");
					// Session bootstrap may prewarm an unused socket. The external
					// contract is one uninterrupted response chain, not one total upgrade.
					// This endpoint accepts every upgrade and assigns connection ids in
					// upgrade order, so empty prewarms remain visible in failure evidence.
					const connections = wire.upgrades.map((upgrade, index) => ({
						connection: index + 1,
						path: upgrade.path,
						sessionId: upgrade.headers.get("session-id"),
						requests: wire.requests
							.filter(request => request.connection === index + 1)
							.map(request => ({
								type: request.body.type,
								model: request.body.model,
								previousResponseId: request.body.previous_response_id,
								input: request.body.input,
							})),
						responses: responseFrames
							.filter(frame => frame.connection === index + 1)
							.map(frame => ({ type: frame.type, id: (frame.response as { id?: unknown }).id })),
					}));
					const diagnostics = JSON.stringify({ goalCommand, connections }, null, 2);
					expect(wire.httpRequests, diagnostics).toEqual([]);
					for (const upgrade of wire.upgrades) {
						expect(upgrade.path, diagnostics).toBe("/backend-api/codex/responses");
						expect(upgrade.headers.get("authorization"), diagnostics).toBe(`Bearer ${token}`);
						expect(upgrade.headers.get("chatgpt-account-id"), diagnostics).toBe("goal-wire-account");
					}
					expect(wire.requests, diagnostics).toHaveLength(11);
					const activeConnections = connections.filter(connection => connection.requests.length > 0);
					expect(activeConnections, diagnostics).toHaveLength(1);
					expect(
						wire.requests.map(request => request.body.model),
						diagnostics,
					).toEqual(Array(11).fill("gpt-5.3-codex-spark"));
					expect(
						wire.requests.map(request => request.connection),
						diagnostics,
					).toEqual(Array(11).fill(activeConnections[0]!.connection));
					expect(wire.requests.map(request => request.body.previous_response_id)).toEqual([
						undefined,
						...Array.from({ length: 10 }, (_, index) => `resp_${index + 1}`),
					]);
					const firstInput = wire.requests[0]!.body.input as Array<Record<string, unknown>>;
					const firstText = JSON.stringify(firstInput);
					expect(firstText).toContain("GOAL_WIRE_OBJECTIVE");
					if (goalCommand === "goal-autopilot") {
						expect(firstText).toContain("MUST 全自动无人值守完成完整目标。");
						expect(firstText).toContain("NEVER 重复请求授权或确认。");
					} else {
						expect(firstText).not.toContain("MUST 全自动无人值守完成完整目标。");
					}
					for (let index = 1; index < wire.requests.length; index++) {
						const delta = wire.requests[index]!.body.input as Array<Record<string, unknown>>;
						expect(delta).toEqual([
							expect.objectContaining({
								type: "function_call_output",
								call_id: `read_${index}`,
								output: expect.stringContaining(files[index - 1]!.content),
							}),
						]);
						expect(JSON.stringify(delta)).not.toContain("MUST 全自动无人值守完成完整目标。");
					}
				}
				const historyFiles = await fs.readdir(config.configRoot, { recursive: true });
				const entries: Array<Record<string, unknown>> = [];
				for (const file of historyFiles.filter(file => file.endsWith(".jsonl"))) {
					for (const line of (await fs.readFile(path.join(config.configRoot, file), "utf8")).trim().split("\n")) {
						if (line) entries.push(JSON.parse(line));
					}
				}
				const notices = entries.filter(
					entry => entry.type === "custom_message" && entry.customType === "goal-auto-orchestrate-context",
				);
				expect(notices).toHaveLength(goalCommand === "goal-autopilot" ? 1 : 0);
				if (goalCommand === "goal-autopilot") {
					expect(notices[0]).toMatchObject({ attribution: "user", content: expect.stringContaining(objective) });
					const content = notices[0]!.content as string;
					expect(wire.requests[0]!.body.input).toContainEqual(
						expect.objectContaining({
							role: "user",
							content: expect.arrayContaining([expect.objectContaining({ text: content })]),
						}),
					);
				}
			} finally {
				await wire.server.stop(true);
			}
		},
		90_000,
	);
});
