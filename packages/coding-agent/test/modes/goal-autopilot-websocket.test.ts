import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { submitInteractiveInput } from "@oh-my-pi/pi-coding-agent/main";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { closeSessionIndex } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { setAgentDir, setProjectDir, TempDir } from "@oh-my-pi/pi-utils";
import { endpoint, send, textEvents, toolEvents } from "../../../ai/test/fixtures/openai-responses-server";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

// Exercise native interactive Goal submission, the provider transport and read
// tool. The loopback service chooses responses; it does not implement Goal policy.
describe("native Goal Codex WebSocket history", () => {
	test.each(["goal", "goal-autopilot"] as const)(
		"%s persists its normal history and chains ten real tool round-trips",
		async goalCommand => {
			await using root = await TempDir.create("@goal-codex-wire-");
			const auth = await AuthStorage.create(root.join("auth.db"));
			let session: AgentSession | undefined;
			let mode: InteractiveMode | undefined;
			let settingsState: SettingsTestState | undefined;
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
				settingsState = beginSettingsTest();
				HistoryStorage.close();
				AgentStorage.close();
				closeSessionIndex();
				setAgentDir(root.path());
				setProjectDir(root.path());
				const token = `aaa.${Buffer.from(
					JSON.stringify({
						"https://api.openai.com/auth": { chatgpt_account_id: "goal-wire-account" },
					}),
				).toString("base64url")}.bbb`;
				// Register the loopback transport under an admitted provider identity;
				// arbitrary chat-provider aliases are intentionally excluded by policy.
				await Bun.write(
					root.join("models.yml"),
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
				const settings = await Settings.init({
					inMemory: true,
					cwd: root.path(),
					agentDir: root.path(),
					overrides: {
						modelRoles: { default: "openai-codex/gpt-5.3-codex-spark", smol: "openai-codex/gpt-5.3-codex-spark" },
						defaultThinkingLevel: "minimal",
						"tools.xdev": false,
						"async.enabled": false,
						"skills.enabled": false,
						"providers.openaiWebsockets": "on",
						"providers.cacheWarming": "off",
						"compaction.enabled": false,
						"goal.enabled": true,
						"goal.continuationModes": [],
					},
				});
				auth.keys.setRuntime("openai-codex", token);
				const modelRegistry = new ModelRegistry(auth, root.join("models.yml"), { settings });
				const model = modelRegistry.find("openai-codex", "gpt-5.3-codex-spark");
				if (!model) throw new Error("Missing isolated native Goal wire model");
				await Promise.all(files.map(file => Bun.write(root.join(file.path), file.content)));
				{
					({ session } = await createAgentSession({
						cwd: root.path(),
						agentDir: root.path(),
						authStorage: auth,
						modelRegistry,
						model,
						settings,
						sessionManager: SessionManager.create(root.path(), root.join("sessions")),
						systemPrompt: ["Exercise the native Goal wire transport."],
						disableExtensionDiscovery: true,
						skills: [],
						contextFiles: [],
						promptTemplates: [],
						slashCommands: [],
						rules: [],
						toolNames: ["read"],
						enableMCP: false,
						enableLsp: false,
						enableIrc: false,
						workspaceTree: {
							rootPath: root.path(),
							rendered: "",
							truncated: false,
							totalLines: 0,
							agentsMdFiles: [],
						},
					}));
					await initTheme();
					mode = new InteractiveMode(session, "test");
					const submitted = mode.getUserInput();
					await executeBuiltinSlashCommand(`/${goalCommand} ${objective}`, { ctx: mode });
					await submitInteractiveInput(mode, session, await submitted);
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
					expect(session.getLastAssistantMessage()?.content).toContainEqual(
						expect.objectContaining({
							type: "text",
							text: "GOAL_WIRE_FINISHED",
						}),
					);
					mode.stop();
					mode = undefined;
					await session.dispose();
					session = undefined;
				}
				const historyFiles = await fs.readdir(root.path(), { recursive: true });
				const entries: Array<Record<string, unknown>> = [];
				for (const file of historyFiles.filter(file => file.endsWith(".jsonl"))) {
					for (const line of (await fs.readFile(root.join(file), "utf8")).trim().split("\n")) {
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
				mode?.stop();
				try {
					await session?.dispose();
				} finally {
					try {
						auth.close();
						await wire.server.stop(true);
					} finally {
						closeSessionIndex();
						HistoryStorage.close();
						AgentStorage.close();
						restoreSettingsTestState(settingsState);
					}
				}
			}
		},
		90_000,
	);
});
