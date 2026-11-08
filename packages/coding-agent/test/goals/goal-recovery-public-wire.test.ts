import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { createAgentSession } from "../../src/sdk";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { endpoint, send, textEvents, toolEvents } from "../../../ai/test/fixtures/openai-responses-server";
import { deadline, goalCliFixture } from "./goal-cli-fixture";

const selection = { providerId: "openai-codex", modelId: "gpt-5.3-codex-spark" };
const instruction = "MUST 全自动无人值守完成完整目标。";

// Native TUI scheduling/one-shot bounds are covered by goal-mode-integration.
// This SDK consumer exercises actual admission and provider bytes, not a scripted
// model or a replacement continuation scheduler. RPC does not schedule recovery.
describe("public SDK Goal one-shot required transport", () => {
	for (const goalCommand of ["goal", "goal-autopilot"] as const) {
		test.each(["tool", "ignored", "provider-error", "cancel", "auth-preflight", "no-tools"] as const)(
			`${goalCommand} recovery %s never leaves required on another model attempt or user submission`,
			async outcome => {
				await using root = await TempDir.create("@goal-required-wire-");
				const config = await goalCliFixture(root);
				let nextUser = false;
				const wire = endpoint((socket, body, index) => {
					if (nextUser) {
						send(socket, textEvents("GOAL_WIRE_NEXT_FINISHED", `next_${index}`));
						return;
					}
					if (index < 3) {
						send(socket, textEvents(`GOAL_WIRE_PROMISE_${index}`, `promise_${index}`));
						return;
					}
					if (index === 3) {
						expect(body.tool_choice).toBe("required");
						if (outcome === "cancel") {
							send(socket, [{ type: "response.created", response: { id: "held_recovery" } }]);
							return;
						}
						if (outcome === "provider-error") {
							send(socket, [
								{
									type: "response.failed",
									response: {
										id: "failed_recovery",
										status: "failed",
										error: { code: "invalid_request_error", message: "GOAL_WIRE_RECOVERY_REJECTED" },
									},
								},
							]);
							return;
						}
						if (outcome === "tool") {
							send(
								socket,
								toolEvents(
									"read",
									JSON.stringify({ path: "required-proof.txt" }),
									"recovery_tool",
									"read_recovery",
								),
							);
							return;
						}
					}
					send(socket, textEvents("GOAL_WIRE_RECOVERY_FINISHED", `recovery_${index}`));
				});
				const auth = await AuthStorage.create(root.join("auth.db"));
				let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
				try {
					const token = `aaa.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "goal-required-wire" } })).toString("base64url")}.bbb`;
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
											id: selection.modelId,
											name: "Goal recovery wire",
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
					const settings = Settings.isolated({
						modelRoles: {
							default: `${selection.providerId}/${selection.modelId}`,
							smol: `${selection.providerId}/${selection.modelId}`,
						},
						defaultThinkingLevel: "minimal",
						"tools.xdev": false,
						"providers.openaiWebsockets": "on",
						"providers.cacheWarming": "off",
						"compaction.enabled": false,
						"retry.enabled": false,
						"async.enabled": false,
						"goal.continuationModes": [],
					});
					auth.keys.setRuntime(selection.providerId, token);
					const registry = new ModelRegistry(auth, path.join(config.agentDir, "models.yml"), { settings });
					const model = registry.find(selection.providerId, selection.modelId);
					if (!model) throw new Error("Missing native Goal recovery fixture model");
					({ session } = await createAgentSession({
						cwd: config.cwd,
						agentDir: config.agentDir,
						authStorage: auth,
						modelRegistry: registry,
						model,
						settings,
						sessionManager: SessionManager.create(config.cwd, root.join("sessions")),
						disableExtensionDiscovery: true,
						skills: [],
						contextFiles: [],
						promptTemplates: [],
						slashCommands: [],
						rules: [],
						extensions: [],
						enableMCP: false,
						enableLsp: false,
						enableIrc: false,
						bindProcessState: false,
						workspaceTree: {
							rootPath: config.cwd,
							rendered: "",
							truncated: false,
							totalLines: 0,
							agentsMdFiles: [],
						},
					}));
					const recoveryNotices: string[] = [];
					session.subscribe(event => {
						if (event.type === "notice" && event.source === "goal") recoveryNotices.push(event.message);
					});
					await session.setActiveToolsByName(["read", "write", "goal"]);
					await Bun.write(path.join(config.cwd, "required-proof.txt"), "REAL_REQUIRED_READ_RESULT");
					const objective = "GOAL_REQUIRED_OBJECTIVE read required-proof.txt";
					const state = await session.goalRuntime.createGoal({
						objective,
						autoOrchestrate: goalCommand === "goal-autopilot",
					});
					await deadline(session.prompt(objective, { goalAutoOrchestrateInitialId: state.goal.id }));
					await deadline(
						session.promptCustomMessage({
							customType: "goal-continuation",
							content: session.goalRuntime.buildContinuationPrompt()!,
							display: false,
						}),
					);
					// Change the real admission inputs only after the preceding native turn
					// has settled. No desktop command or extension command restores them.
					if (outcome === "auth-preflight") {
						auth.keys.removeRuntime(selection.providerId);
						auth.keys.removeConfig(selection.providerId);
					}
					if (outcome === "no-tools") {
						await session.setActiveToolsByName([]);
						expect(session.getActiveToolNames()).toEqual([]);
					}
					const recovery = session.promptCustomMessage({
						customType: "goal-tool-recovery",
						content: session.goalRuntime.buildContinuationPrompt(true)!,
						display: false,
					});
					if (outcome === "cancel") {
						await wire.waitForRequests(3);
						await session.abort();
					}
					if (outcome === "auth-preflight") await expect(deadline(recovery)).rejects.toThrow();
					else expect(await deadline(recovery)).toBe(outcome !== "no-tools");
					if (outcome === "auth-preflight" || outcome === "no-tools")
						expect(recoveryNotices.some(message => message.includes("unfinished"))).toBe(true);
					if (outcome === "provider-error" || outcome === "cancel") {
						const last = session.messages.findLast(message => message.role === "assistant");
						expect(last?.role === "assistant" && last.stopReason).toBe(
							outcome === "cancel" ? "aborted" : "error",
						);
						if (outcome === "provider-error")
							expect(last?.role === "assistant" && last.errorMessage).toContain("GOAL_WIRE_RECOVERY_REJECTED");
					}
					if (outcome === "tool") {
						// Real work does not carry required into the next model attempt.
						await deadline(
							session.promptCustomMessage({
								customType: "goal-continuation",
								content: session.goalRuntime.buildContinuationPrompt()!,
								display: false,
							}),
						);
						expect(JSON.stringify(wire.requests[3]!.body.input)).toContain("REAL_REQUIRED_READ_RESULT");
						for (const request of wire.requests.slice(3)) expect(request.body.tool_choice).not.toBe("required");
					}
					const recoveryCount = outcome === "auth-preflight" || outcome === "no-tools" ? 0 : 1;
					expect(wire.requests.filter(request => request.body.tool_choice === "required")).toHaveLength(
						recoveryCount,
					);
					expect(wire.requests).toHaveLength(outcome === "tool" ? 5 : recoveryCount ? 3 : 2);
					await session.goalRuntime.pauseGoal();
					auth.keys.setRuntime(selection.providerId, token);
					await session.setActiveToolsByName(["read", "write", "goal"]);
					const before = wire.requests.length;
					expect(
						await session.promptCustomMessage({
							customType: "goal-tool-recovery",
							content: "A paused Goal cannot admit forced-tool recovery.",
							display: false,
						}),
					).toBe(false);
					nextUser = true;
					await deadline(session.prompt("GOAL_WIRE_NEXT_USER inspect independently; do not resume"));
					expect(wire.requests).toHaveLength(before + 1);
					expect(wire.requests.at(-1)!.body.tool_choice).not.toBe("required");
					expect(wire.httpRequests).toEqual([]);
					const file = session.sessionFile;
					await session.dispose();
					session = undefined;
					if (!file) throw new Error("Native Goal session did not persist its journal");
					const entries = (await fs.readFile(file, "utf8"))
						.split("\n")
						.filter(Boolean)
						.map(line => JSON.parse(line) as Record<string, unknown>);
					const notices = entries.filter(
						entry => entry.type === "custom_message" && entry.customType === "goal-auto-orchestrate-context",
					);
					expect(notices).toHaveLength(goalCommand === "goal-autopilot" ? 1 : 0);
					if (notices.length) {
						expect(notices[0]).toMatchObject({
							attribution: "user",
							content: expect.stringContaining(instruction),
						});
						expect(JSON.stringify(wire.requests[0]!.body.input)).toContain(instruction);
					}
				} finally {
					if (session) {
						await session.abort({ goalReason: "internal" });
						await session.dispose();
					}
					auth.close();
					await wire.server.stop(true);
				}
			},
			90_000,
		);
	}
});
