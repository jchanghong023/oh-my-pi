import { describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import { Settings } from "../../src/config/settings";
import { canonicalProjectDir, closeDaemonClient, daemonClient, probeDaemon } from "../../src/daemon/client";
import { projectScope, type DaemonCompletionEvent } from "../../src/daemon/protocol";
import { listServices, sendService, startService, waitForOwnedServiceCompletion } from "../../src/launch/services";
import type { ToolSession } from "../../src/tools";
import { BashTool } from "../../src/tools/bash";
import { IsolatedDaemon, waitFor } from "../fixtures/daemon-harness";

function serviceSession(cwd: string, id: string, overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated(),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getAgentId: () => "Main",
		getSessionId: () => id,
		...overrides,
	};
}

function failingService(session: ToolSession, name: string) {
	return startService(session, {
		name,
		command: "printf 'service-ready\\n'; read answer; exit 3",
		pty: false,
		ready: { log: "service-ready", timeout: 15 },
	});
}

async function restartDaemon(): Promise<void> {
	const client = await probeDaemon();
	if (!client) throw new Error("No daemon to restart");
	const processRef = Process.fromPid(client.welcome.daemon.pid);
	if (!processRef) throw new Error("Daemon process disappeared");
	const exited = processRef.waitForExit({ timeoutMs: 10_000 });
	try {
		await closeDaemonClient();
		await client.request({ op: "shutdown" });
	} finally {
		client.close();
	}
	expect(await exited).toBeTrue();
}

describe("session-owned daemon services", () => {
	it("delivers a failed service only to the owning session on the shared connection", async () => {
		const harness = await IsolatedDaemon.create();
		const received: Array<[string, DaemonCompletionEvent]> = [];
		const delivered = Promise.withResolvers<void>();
		const makeSession = (id: string): ToolSession =>
			serviceSession(harness.dir, id, {
				queueLaunchCompletion: async event => {
					received.push([id, event]);
					delivered.resolve();
				},
			});
		try {
			const first = makeSession("first-session");
			const second = makeSession("second-session");
			const started = await failingService(first, "failing-service");
			expect(started.daemon).toMatchObject({ state: "ready", owner: "first-session" });
			await listServices(second);
			const firstFinished = waitForOwnedServiceCompletion(first);
			await sendService(first, "failing-service", "go\n");
			await delivered.promise;
			await firstFinished;
			expect(received.map(([id, { unit }]) => [id, unit.key, unit.state, unit.exitCode])).toEqual([
				["first-session", "failing-service", "failed", 3],
			]);
		} finally {
			await harness.dispose();
		}
	}, 35_000);

	it("replays a failed service only after its owning session is resumed", async () => {
		const harness = await IsolatedDaemon.create();
		let sessionId = "old-session";
		const callbacks = new Set<() => void>();
		const received: Array<[string, DaemonCompletionEvent]> = [];
		const session = serviceSession(harness.dir, sessionId, {
			getSessionId: () => sessionId,
			registerSessionChangeCallback: callback => {
				callbacks.add(callback);
				return () => {
					callbacks.delete(callback);
				};
			},
			queueLaunchCompletion: async event => {
				received.push([sessionId, event]);
			},
		});
		function switchTo(id: string): void {
			sessionId = id;
			for (const callback of callbacks) callback();
		}
		try {
			const started = await failingService(session, "old-service");
			switchTo("new-session");
			await listServices(session);
			await sendService(session, started.daemon.key, "go\n");
			const client = await daemonClient();
			const ended = await client.request({ op: "wait", unit: started.daemon.id, for: "exit", timeoutMs: 10_000 });
			expect(ended.unit.state).toBe("failed");
			expect(received).toEqual([]);

			switchTo("old-session");
			await listServices(session);
			await waitFor(() => received.length > 0, "the original session's completion");
			expect(received.map(([id, { owner, unit }]) => [id, owner, unit.key, unit.state])).toEqual([
				["old-session", "old-session", "old-service", "failed"],
			]);
			// A completion awaiting ack prevents reuse of this name. Once acked the
			// service can be replaced, proving replay really cleared the stored event.
			await waitFor(async () => {
				try {
					return await client.open({
						kind: "proc",
						scope: started.daemon.scope,
						key: started.daemon.key,
						owner: "old-session",
						proc: {
							application: process.execPath,
							args: ["-e", "process.stdin.resume()"],
							env: {},
							cwd: harness.dir,
							pty: false,
						},
					});
				} catch (error) {
					if (error instanceof Error && error.message.includes("unacknowledged completion notifications"))
						return undefined;
					throw error;
				}
			}, "acknowledgment of the replay");
		} finally {
			await harness.dispose();
		}
	}, 40_000);

	it("re-adopts a detached service and replays its exit only to its original owner", async () => {
		const harness = await IsolatedDaemon.create();
		const owner = "original-session";
		const received: Array<[string, DaemonCompletionEvent]> = [];
		const makeSession = (id: string) =>
			serviceSession(harness.dir, id, {
				queueLaunchCompletion: async event => {
					received.push([id, event]);
				},
			});
		const disposals: Array<() => void | Promise<void>> = [];
		try {
			await listServices(
				serviceSession(harness.dir, owner, {
					registerDisposeCallback: callback => {
						disposals.push(callback);
					},
				}),
			);
			const first = await daemonClient();
			const scope = projectScope(await canonicalProjectDir(harness.dir));
			const { unit } = await first.open({
				kind: "proc",
				scope,
				key: "detached-service",
				owner,
				proc: {
					application: process.execPath,
					args: ["-e", "setInterval(() => {}, 1000); console.log('service-ready')"],
					env: {},
					cwd: harness.dir,
					pty: false,
					ready: { log: "service-ready", timeoutMs: 5_000 },
				},
				policy: { hold: "detached" },
			});
			const pid = unit.pids[0];
			if (pid === undefined) throw new Error(`Detached service did not start: ${unit.exitReason ?? unit.state}`);
			harness.track(pid);
			expect(unit.state).toBe("ready");
			const processRef = Process.fromPid(pid);
			if (!processRef) throw new Error("Detached service disappeared before daemon shutdown");
			for (const dispose of disposals) await dispose();
			await restartDaemon();
			expect(processRef.status()).toBe(ProcessStatus.Running);
			const later = await listServices(makeSession("later-session"));
			expect(later.find(candidate => candidate.key === unit.key)).toMatchObject({
				id: unit.id,
				owner,
				pids: [pid],
			});
			await processRef.terminate({ group: true, gracefulMs: 0, timeoutMs: 5_000 });
			const client = await daemonClient();
			expect(
				(await client.request({ op: "wait", unit: unit.id, for: "exit", timeoutMs: 10_000 })).matched,
			).toBeTrue();
			expect(received).toEqual([]);
			await listServices(makeSession(owner));
			await waitFor(() => received.length > 0, "detached service completion");
			expect(received.map(([receiver, event]) => [receiver, event.owner, event.unit.key])).toEqual([
				[owner, owner, unit.key],
			]);
		} finally {
			await harness.dispose();
		}
	}, 45_000);

	it("starts bash services with the initiating session and tool call identity", async () => {
		const harness = await IsolatedDaemon.create();
		const sessionFile = path.join(harness.dir, "svc.jsonl");
		try {
			const session = serviceSession(harness.dir, "session-svc", { getSessionFile: () => sessionFile });
			const escaped = sessionFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const result = await new BashTool(session).execute("svc-env", {
				command: `printf 'env=%s|%s|%s\\n' "$PI_SESSION_ID" "$PI_SESSION_FILE" "$PI_TOOL_CALL_ID"; read answer`,
				name: "env-service",
				pty: false,
				ready: { log: `env=session-svc\\|${escaped}\\|svc-env`, timeout: 15 },
			});
			expect(result.details?.service).toMatchObject({ ready: true, timedOut: false });
		} finally {
			await harness.dispose();
		}
	}, 35_000);

	it("propagates log retrieval cancellation without stopping the started service", async () => {
		const harness = await IsolatedDaemon.create();
		try {
			const client = await daemonClient();
			const session = serviceSession(harness.dir, "log-cancel-owner");
			const controller = new AbortController();
			const request = client.request.bind(client);
			const spy = vi.spyOn(client, "request").mockImplementation(async (operation, signal) => {
				if (operation.op === "logs") controller.abort();
				return request(operation, signal);
			});
			try {
				await expect(
					new BashTool(session).execute(
						"log-cancel",
						{
							command: "read answer",
							name: "log-cancel-service",
							pty: false,
						},
						controller.signal,
					),
				).rejects.toThrow("Daemon logs request aborted");
				expect((await listServices(session)).find(unit => unit.key === "log-cancel-service")?.state).toBe(
					"running",
				);
			} finally {
				spy.mockRestore();
			}
		} finally {
			await harness.dispose();
		}
	}, 35_000);
});
