import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentEvent, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { Process } from "@oh-my-pi/pi-natives";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { isRecord, ptree, readLines, removeWithRetries, withTimeout } from "@oh-my-pi/pi-utils";
import { waitFor } from "./fixtures/daemon-harness";

const device = "mcp__stub_regression_announce";
const deviceUri = `xd://${device}`;
const cli = path.join(import.meta.dir, "../src/cli.ts");
const peer = path.join(import.meta.dir, "fixtures/rpc-mcp-server.ts");
const fakeModel = path.join(import.meta.dir, "rpc-wire/fake-openai-server.ts");
const startupTimeoutMs = 10_000;

function toolResult(events: AgentEvent[], toolName: string, args: Record<string, unknown>): string {
	// Inspect this prompt's actual execution, never assistant text or persisted history.
	const starts = events.filter(event => event.type === "tool_execution_start");
	expect(starts).toHaveLength(1);
	expect(starts[0]).toMatchObject({ toolName, args });
	const ends = events.filter(event => event.type === "tool_execution_end");
	expect(ends).toHaveLength(1);
	const end = ends[0];
	if (!end || end.type !== "tool_execution_end") throw new Error("Missing tool execution result");
	expect(end.toolCallId).toBe(starts[0]?.toolCallId);
	expect(end.toolName).toBe(toolName);
	const result: AgentToolResult<unknown> = end.result;
	return result.content
		.filter(part => part.type === "text")
		.map(part => part.text)
		.join("\n");
}

async function auditEntries(audit: string): Promise<Record<string, unknown>[]> {
	const entries: unknown[] = Bun.JSONL.parse(await Bun.file(audit).text());
	return entries.map(entry => {
		if (!isRecord(entry)) throw new Error("Invalid MCP audit entry");
		return entry;
	});
}

function liveAuditPeer(spawn: Record<string, unknown>, audit: string): Process | undefined {
	if (typeof spawn.pid !== "number") throw new Error("Missing MCP PID");
	// An old probe's PID may have been reused, and Windows can retain an
	// exited process object. Check the unique fixture argument and OS status.
	const peerProcess = Process.fromPid(spawn.pid);
	return peerProcess?.status() === "running" && peerProcess.args().includes(audit) ? peerProcess : undefined;
}

// Both modes enter main.ts -> createAgentSession -> runRpcMode. An SDK-only
// fixture would miss a lost MCP manager at that launch boundary.
describe("CLI RPC MCP discovery", () => {
	for (const mode of ["rpc", "rpc-ui"] as const) {
		test(`${mode}: mounted MCP survives session switches; user denylist prevents spawn until restart restores it`, async () => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-mcp-"));
			const home = path.join(root, "home");
			const agentDir = path.join(home, ".omp/agent");
			const project = path.join(root, "project");
			await fs.mkdir(agentDir, { recursive: true });
			await fs.mkdir(project);
			// This test asserts session-owned peer shutdown, not daemon lease lifetime.
			// Use the in-process MCP host; a detached sharing daemon can also keep
			// its state files locked after the CLI has exited on Windows.
			await Bun.write(path.join(agentDir, "config.yml"), "mcp:\n  shared: false\n  startupTimeoutMs: 0\n");
			// Do not inherit API keys, profiles, provider overrides or external-tool configs.
			const env = {
				PATH: `${path.dirname(process.execPath)}${path.delimiter}${Bun.env.PATH ?? ""}`,
				HOME: home,
				USERPROFILE: home,
				XDG_CONFIG_HOME: path.join(home, ".config"),
				PI_CONFIG_DIR: ".omp",
				PI_CODING_AGENT_DIR: agentDir,
				OMP_PROFILE: "",
				PI_NO_TITLE: "1",
			};
			using model = ptree.spawn([process.execPath, fakeModel, agentDir], {
				cwd: project,
				env,
				stdin: "pipe",
				detached: true,
				timeout: 120_000,
			});
			try {
				let ready = "";
				for await (const line of readLines(model.stdout, AbortSignal.timeout(startupTimeoutMs))) {
					ready = new TextDecoder().decode(line);
					break;
				}
				expect(ready, model.peekStderr()).toMatch(/^READY \d+/);
				const audit = path.join(root, "mcp.jsonl");
				await Bun.write(audit, "");
				// The denied launch runs first: the restored launch then proves the same
				// command does spawn once the denylist is lifted, that nothing from the
				// denied run sticks across restart, and that the mount survives switches.
				for (const phase of ["disabled", "restored"] as const) {
					await Bun.write(
						path.join(agentDir, "mcp.json"),
						JSON.stringify({
							mcpServers: { stub: { command: process.execPath, args: [peer, audit] } },
							// Deny must win even when the user also explicitly force-enables it.
							...(phase === "disabled" ? { disabledServers: ["stub"], enabledServers: ["stub"] } : {}),
						}),
					);
					using child = ptree.spawn(
						[
							process.execPath,
							cli,
							"--mode",
							mode,
							"--model",
							"fake/fake-model",
							"--no-extensions",
							"--no-skills",
							"--no-rules",
							"--no-lsp",
							"--no-prewalk",
						],
						{ cwd: project, env, stdin: "pipe", detached: true, timeout: 60_000 },
					);
					let observingEof = false;
					using client = new RpcClient({
						spawn: () => ({
							stdin: child.stdin,
							stdout: child.stdout,
							exited: child.exited,
							peekStderr: () => child.peekStderr(),
							kill: (reason, graceMs) => {
								// RpcClient reaps on stdout EOF. That must not rescue a CLI
								// which exited without terminating its owned MCP peer.
								if (!observingEof) child.kill(reason, graceMs);
							},
						}),
					});
					try {
						await client.start();
						// RPC ready means the protocol is available. UI discovery is deferred,
						// and the first turn can stop waiting for it before the route is mounted.
						const state =
							mode === "rpc-ui" && phase === "restored"
								? await waitFor(
										async () => {
											const current = await client.getState();
											if (current.systemPrompt?.some(block => block.includes(deviceUri))) return current;
										},
										`${deviceUri} to be published in the RPC UI prompt`,
										startupTimeoutMs,
									)
								: await client.getState();
						expect(state.dumpTools?.map(tool => tool.name)).toEqual(expect.arrayContaining(["read", "write"]));
						expect(state.dumpTools?.some(tool => tool.name === device)).toBe(false);
						const listing = toolResult(await client.promptAndWait("read_uri xd://"), "read", { path: "xd://" });
						if (phase === "disabled") {
							expect(listing).not.toContain(device);
							const events = await client.promptAndWait(`write_uri ${deviceUri} {}`);
							const error = toolResult(events, "write", { path: deviceUri, content: "{}" });
							expect(events.find(event => event.type === "tool_execution_end")).toMatchObject({ isError: true });
							expect(error).toContain(`No such tool: ${deviceUri}`);
							expect(await auditEntries(audit)).toEqual([]);
						} else {
							expect(listing).toContain(device);
							const docs = toolResult(await client.promptAndWait(`read_uri ${deviceUri}`), "read", {
								path: deviceUri,
							});
							expect(docs).toContain("Return an independently audited invocation marker.");
							const invoke = async () => {
								const before = (await auditEntries(audit)).filter(
									entry => entry.method === "tools/call",
								).length;
								const events = await client.promptAndWait(`write_uri ${deviceUri} {}`);
								expect(toolResult(events, "write", { path: deviceUri, content: "{}" })).toContain(
									"rpc-mcp-invoked",
								);
								expect(events.find(event => event.type === "tool_execution_end")).toMatchObject({
									isError: false,
								});
								const calls = (await auditEntries(audit)).filter(entry => entry.method === "tools/call");
								expect(calls).toHaveLength(before + 1);
								expect(calls.at(-1)).toMatchObject({ params: { name: "regression_announce", arguments: {} } });
							};
							await invoke();
							const original = (await client.getState()).sessionFile;
							if (!original) throw new Error("Expected persisted RPC session");
							expect(await client.openSession(path.join(root, "other-sessions"))).toMatchObject({
								cancelled: false,
							});
							expect((await client.getState()).sessionFile).not.toBe(original);
							await invoke();
							expect(await client.switchSession(original)).toEqual({ cancelled: false });
							expect((await client.getState()).sessionFile).toBe(original);
							await invoke();
						}
						// Pin the audited processes before EOF so the exit check cannot
						// mistake an exited or recycled PID for the original peer.
						const entries = await auditEntries(audit);
						const spawns = entries.filter(entry => entry.event === "spawn");
						const peers = spawns.map(spawn => liveAuditPeer(spawn, audit));
						if (phase === "disabled") {
							expect(spawns).toHaveLength(0);
						} else {
							// The host launches the stub to probe it and again to serve. Every
							// invocation, across both session switches, reached that one server.
							const firstCall = entries.findIndex(entry => entry.method === "tools/call");
							const lastSpawn = entries.findLastIndex(entry => entry.event === "spawn");
							expect(lastSpawn).toBeGreaterThanOrEqual(0);
							expect(firstCall).toBeGreaterThan(lastSpawn);
							expect(peers.at(-1), "Serving MCP peer must be running before RPC shutdown").toBeDefined();
						}
						// Observe natural server teardown before allowing any client tree kill.
						observingEof = true;
						child.stdin.end();
						expect(await withTimeout(child.exited, 10_000, "RPC did not exit after stdin EOF")).toBe(0);
						expect((await auditEntries(audit)).filter(entry => entry.event === "spawn")).toEqual(spawns);
						for (const peer of peers) {
							if (!peer) continue; // An earlier era probe may already have exited.
							expect(await peer.waitForExit({ timeoutMs: 5_000 }), `MCP peer ${peer.pid} still running`).toBe(
								true,
							);
						}
						// The outer spawn deadline can reap descendants after the CLI exits.
						expect(child.exitReason).toBeUndefined();
					} finally {
						observingEof = false;
						try {
							await client.stop();
						} finally {
							child.kill(undefined, 0);
							await child.exited.catch(() => {});
							// An already-exited CLI may have lost its process-tree handle.
							for (const entry of await auditEntries(audit)) {
								if (entry.event === "spawn") await liveAuditPeer(entry, audit)?.terminate({ gracefulMs: 0 });
							}
						}
					}
				}
			} finally {
				model.stdin.end();
				model.kill();
				await model.exited.catch(() => {});
				await removeWithRetries(root);
			}
		}, 120_000);
	}
});
