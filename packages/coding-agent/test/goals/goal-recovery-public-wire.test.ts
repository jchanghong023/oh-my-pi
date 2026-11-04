import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";
import { endpoint, send, textEvents, toolEvents } from "../../../ai/test/fixtures/openai-responses-server";
import {
	command,
	create,
	deadline,
	fixture,
	finishedOutput,
	output,
	ProcessPeer,
	subscribe,
} from "../modes/zcode-process-harness";

const selection = { providerId: "openai-codex", modelId: "gpt-5.3-codex-spark" };
const instruction = "MUST 全自动无人值守完成完整目标。";
type Outcome = "tool" | "ignored" | "provider-error" | "cancel" | "auth-preflight" | "no-tools";

// The extension changes real credentials/capabilities at a lifecycle boundary;
// it never replaces prompt dispatch, the Goal guard, or the provider transport.
// Tool removal must finish in the awaited stop hook: agent_end is a
// notification after public settlement and can race recovery admission.
function admissionExtension(outcome: Outcome, marker: string): string {
	return `import * as fs from "node:fs/promises";
export default function(pi) {
 let ended = 0;
 pi.on(${JSON.stringify(outcome === "no-tools" ? "session_stop" : "agent_end")}, async (_event, ctx) => {
  if (++ended !== 2) return;
  ${outcome === "auth-preflight" ? `ctx.modelRegistry.authStorage.keys.removeRuntime("openai-codex"); ctx.modelRegistry.authStorage.keys.removeConfig("openai-codex");` : ""}
  ${outcome === "no-tools" ? "await pi.setActiveTools([]);" : ""}
  await fs.writeFile(${JSON.stringify(marker)}, ${outcome === "no-tools" ? "JSON.stringify(pi.getActiveTools())" : JSON.stringify("admission boundary reached")});
 });
 pi.registerCommand("wire-restore", { description: "Restore the isolated admission fixture", handler: async (_args, ctx) => {
  ctx.modelRegistry.authStorage.keys.setRuntime("openai-codex", process.env.GOAL_WIRE_TOKEN);
  await pi.setActiveTools(["read", "write", "goal"]);
 } });
}`;
}

async function idle(peer: ProcessPeer, sessionId: string): Promise<void> {
	await deadline(
		(async () => {
			for (;;) {
				const state = await peer.request("session/read", { sessionId });
				if (isRecord(state) && isRecord(state.projection) && state.projection.status === "idle") return;
				await peer.next(
					frame => frame.method === "v4/conversation/frame" && JSON.stringify(frame.params).includes(sessionId),
				);
			}
		})(),
	);
}

describe("public app-server Goal one-shot required transport", () => {
	for (const goalCommand of ["goal", "goal-autopilot"] as const) {
		test.each(["tool", "ignored", "provider-error", "cancel", "auth-preflight", "no-tools"] as const)(
			`${goalCommand} recovery %s never leaves required on another model attempt or user submission`,
			async outcome => {
				await using root = await TempDir.create("@goal-required-wire-");
				await using config = await fixture(root);
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
					// A tool result may continue normally; subsequent no-tool automatic
					// work must stop, not replenish the one-shot correction allowance.
					send(socket, textEvents("GOAL_WIRE_RECOVERY_FINISHED", `recovery_${index}`));
				});
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
					const extension = root.join("recovery-admission.ts");
					await Bun.write(extension, admissionExtension(outcome, root.join("admission-reached")));
					await Bun.write(
						path.join(config.agentDir, "config.yml"),
						JSON.stringify({
							modelRoles: {
								default: `${selection.providerId}/${selection.modelId}`,
								smol: `${selection.providerId}/${selection.modelId}`,
							},
							defaultThinkingLevel: "off",
							tools: { xdev: false },
							skills: { enabled: false },
							providers: { openaiWebsockets: "on", cacheWarming: "off" },
							compaction: { enabled: false },
							retry: { enabled: false },
							goal: { continuationModes: ["rpc"] },
							extensions: [extension],
						}),
					);
					await Bun.write(path.join(config.cwdA, "required-proof.txt"), "REAL_REQUIRED_READ_RESULT");
					await using peer = new ProcessPeer(config.cwdA, {
						...config.env,
						OMP_OFFLINE: "1",
						GOAL_WIRE_TOKEN: token,
					});
					await peer.ready();
					const sessionId = await create(peer, config.cwdA, selection);
					await subscribe(peer, sessionId);
					expect(
						await command(peer, sessionId, "sendText", {
							text: `/${goalCommand} GOAL_REQUIRED_OBJECTIVE read required-proof.txt`,
						}),
					).toMatchObject({ status: "accepted" });
					if (outcome === "cancel") {
						await wire.waitForRequests(3);
						expect(await command(peer, sessionId, "stop", {})).toMatchObject({ status: "accepted" });
					} else {
						await output(peer, sessionId, "unfinished");
					}
					await idle(peer, sessionId);
					const recoveryCount = outcome === "auth-preflight" || outcome === "no-tools" ? 0 : 1;
					expect(wire.requests.filter(request => request.body.tool_choice === "required")).toHaveLength(
						recoveryCount,
					);
					expect(wire.requests).toHaveLength(outcome === "tool" ? 5 : recoveryCount ? 3 : 2);
					const admission = await Bun.file(root.join("admission-reached")).text();
					if (outcome === "no-tools") {
						expect(JSON.parse(admission)).toEqual([]);
					} else {
						expect(admission).toBe("admission boundary reached");
					}
					if (outcome === "tool") {
						expect(JSON.stringify(wire.requests[3]!.body.input)).toContain("REAL_REQUIRED_READ_RESULT");
						for (const request of wire.requests.slice(3)) expect(request.body.tool_choice).not.toBe("required");
					}
					// Pause before reentry so the next user turn is not mistaken for
					// another permitted continuation stretch.
					await command(peer, sessionId, "sendText", { text: "/goal pause" });
					if (outcome === "auth-preflight" || outcome === "no-tools") {
						await command(peer, sessionId, "sendText", { text: "/wire-restore" });
					}
					const before = wire.requests.length;
					nextUser = true;
					expect(
						await command(peer, sessionId, "sendText", {
							text: "GOAL_WIRE_NEXT_USER inspect independently; do not resume",
						}),
					).toMatchObject({ status: "accepted" });
					await finishedOutput(peer, sessionId, "GOAL_WIRE_NEXT_FINISHED");
					expect(wire.requests).toHaveLength(before + 1);
					expect(wire.requests.at(-1)!.body.tool_choice).not.toBe("required");
					expect(wire.httpRequests).toEqual([]);
					// EOF closes the real session writer before examining its journal.
					expect(await peer.eof()).toBe(0);
					// Persisted notices, not renderer fields, remain one initial copy.
					const files = await fs.readdir(config.configRoot, { recursive: true });
					const entries = (
						await Promise.all(
							files
								.filter(file => file.endsWith(`_${sessionId}.jsonl`))
								.map(file => fs.readFile(path.join(config.configRoot, file), "utf8")),
						)
					).flatMap(text =>
						text
							.trim()
							.split("\n")
							.filter(Boolean)
							.map(line => JSON.parse(line) as Record<string, unknown>),
					);
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
					await wire.server.stop(true);
				}
			},
			90_000,
		);
	}
});
