import { describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { adaptSchemaForStrict, isJsonSchemaValueValid, toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { procmgr, TempDir } from "@oh-my-pi/pi-utils";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { Settings } from "../../src/config/settings";
import { AsyncJobManager } from "../../src/async/job-manager";
import { ProcProtocolHandler } from "../../src/internal-urls/proc-protocol";
import { parseInternalUrl } from "../../src/internal-urls/parse";
import { InternalUrlRouter } from "../../src/internal-urls/router";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { SessionManager } from "../../src/session/session-manager";
import * as daemonClient from "../../src/daemon/client";
import type { DaemonClient, DaemonOp, UnitRef } from "../../src/daemon/protocol";
import { BashTool } from "../../src/tools/bash";
import { WriteTool } from "../../src/tools/write";
import { sharedBrowserDaemonName } from "../../src/tools/browser/shared-daemon";
import type { ToolSession } from "../../src/tools";
import type { UnitSnapshot } from "@oh-my-pi/pi-coding-agent/daemon/daemon-types";
import { hasLiveOwnedService } from "../../src/launch/services";
import { IsolatedDaemon } from "../fixtures/daemon-harness";

/** A `proc` unit in the current project with the given board fields. */
function serviceUnit(key: string, fields: Partial<UnitSnapshot> = {}): UnitSnapshot {
	const now = Date.now();
	return {
		id: `${key}-id`,
		kind: "proc",
		scope: { kind: "project", dir: process.cwd() },
		key,
		label: key,
		generation: `${key}-gen-1`,
		state: "running",
		pids: [],
		createdAt: now,
		startedAt: now,
		restartCount: 0,
		outputBytes: 0,
		leases: 1,
		policy: { hold: "leases", idleMs: 0, onIdle: "stop", restart: "no", survive: "exec" },
		supervised: true,
		...fields,
	};
}

function unitKey(unit: UnitRef): string {
	return typeof unit === "string" ? unit : unit.key;
}

/** Client stub; `request` answers the ops a test exercises. */
function stubClient(request: (operation: DaemonOp, signal?: AbortSignal) => Promise<unknown>): DaemonClient {
	return {
		onCompletion: () => () => {},
		onNotify: () => () => {},
		onReconnect: () => () => {},
		close() {},
		request,
	} as unknown as DaemonClient;
}

// Services really spawn the configured shell with POSIX command lines. Windows
// has no `/bin/sh`, so use the product's own Git Bash discovery there.
const SERVICE_SHELL = process.platform === "win32" ? procmgr.resolveWindowsShell() : "/bin/sh";

/**
 * Settles a daemon-backed call with a plain `await` and returns its rejection message.
 */
async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error("Expected the promise to reject");
}

function toolSession(
	cwd: string,
	manager?: AsyncJobManager,
	options: { launch?: boolean; async?: boolean } = {},
): ToolSession {
	return {
		cwd,
		hasUI: false,
		getAgentId: () => "Main",
		getSessionId: () => "Main",
		getSessionFile: () => null,
		asyncJobManager: manager,
		settings: Settings.isolated({
			"launch.enabled": options.launch ?? true,
			"async.enabled": options.async ?? false,
			"bash.autoBackground.enabled": false,
			"bash.autoBackground.thresholdMs": 60_000,
			"bashInterceptor.enabled": false,
			"worktree.clone": false,
			shellPath: SERVICE_SHELL,
		}),
	} as unknown as ToolSession;
}

function steeringContext(steeringSignal: AbortSignal): AgentToolContext {
	return {
		sessionManager: SessionManager.inMemory(),
		modelRegistry: undefined,
		model: undefined,
		isIdle: () => false,
		hasQueuedMessages: () => true,
		abort: () => {},
		toolNames: [],
		toolCall: {
			batchId: "batch-1",
			index: 0,
			total: 1,
			toolCalls: [{ id: "service", name: "bash" }],
			steeringSignal,
		},
	} as unknown as AgentToolContext;
}

/**
 * Agent `Quick` finished its first run and was woken: its new turn's job asks for
 * the id `Quick`, but the settled first job still holds it, so the turn runs as `Quick-2`.
 */
async function wokenAgentSession(
	options: { launch?: boolean } = {},
): Promise<{ manager: AsyncJobManager; session: ToolSession }> {
	const manager = new AsyncJobManager({});
	const registry = new AgentRegistry();
	registry.register({ id: "Quick", displayName: "Quick", kind: "sub", parentId: "Main", session: null });
	const session = toolSession(process.cwd(), manager, { launch: options.launch ?? false });
	session.agentRegistry = registry;
	manager.register("task", "Quick", async () => "READY", { id: "Quick", agentId: "Quick", ownerId: "Main" });
	await manager.getJob("Quick")?.promise;
	const turn = Promise.withResolvers<string>();
	const turnJobId = manager.register(
		"task",
		"Quick",
		async ({ signal }) => {
			signal.addEventListener("abort", () => turn.resolve("cancelled"), { once: true });
			return turn.promise;
		},
		{ id: "Quick", agentId: "Quick", ownerId: "Main" },
	);
	expect(turnJobId).toBe("Quick-2");
	return { manager, session };
}

describe("proc:// background jobs", () => {
	it("tells what became of a job whose row was evicted instead of reporting it not found", async () => {
		const manager = new AsyncJobManager({});
		const id = manager.register("bash", "pod install", async () => "installed", { id: "bg_98", ownerId: "Main" });
		await manager.getJob(id)?.promise;
		manager.consumeJobResults([id]);
		manager.evictCompletedJobs({ ownerId: "Main" });
		const session = toolSession(process.cwd(), manager, { launch: false });
		const protocol = new ProcProtocolHandler();
		try {
			expect(manager.getJob(id)).toBeUndefined();
			const read = await protocol.resolve(parseInternalUrl(`proc://${id}`), { session });
			expect(read.content).toContain("bg_98 [bash] completed");
			expect(read.content).toContain("its result reached you");
			expect(read.content).toContain("cleared when your session was reset");
			const kill = await protocol.write(parseInternalUrl(`proc://${id}/kill`), "", { session });
			expect(kill.details?.proc).toMatchObject({ cancelled: [{ id, status: "already_completed" }] });
			const otherOwner = { ...session, getAgentId: () => "Other" } as ToolSession;
			await expect(protocol.resolve(parseInternalUrl(`proc://${id}`), { session: otherOwner })).rejects.toThrow(
				"not found",
			);
		} finally {
			await manager.dispose();
		}
	});

	it("lists owned jobs, preserves delivery on read, and scopes kill to the owner", async () => {
		const manager = new AsyncJobManager({});
		const pending = Promise.withResolvers<string>();
		const id = manager.register(
			"bash",
			"compiling assets",
			async ({ signal, reportProgress }) => {
				signal.addEventListener("abort", () => pending.resolve("cancelled"), { once: true });
				await reportProgress("building 50%", { output: "building 50%" });
				return pending.promise;
			},
			{ id: "build-job", ownerId: "Main" },
		);
		const otherPending = Promise.withResolvers<string>();
		manager.register(
			"bash",
			"other owner's work",
			async ({ signal }) => {
				signal.addEventListener("abort", () => otherPending.resolve("cancelled"), { once: true });
				return otherPending.promise;
			},
			{ id: "other-job", ownerId: "Other" },
		);
		const session = toolSession(process.cwd(), manager, { launch: false });
		const protocol = new ProcProtocolHandler();
		try {
			await expect(protocol.resolve(parseInternalUrl("proc://"))).rejects.toThrow("requires a tool session");
			await expect(protocol.write(parseInternalUrl(`proc://${id}/kill`), "")).rejects.toThrow(
				"requires a tool session",
			);
			const list = await protocol.resolve(parseInternalUrl("proc://"), { session });
			expect(list.content).toContain(`${id} [bash] running`);
			expect(list.content).not.toContain("other-job");
			expect(list.details?.proc?.jobs).toMatchObject([{ id, status: "running" }]);
			await expect(protocol.resolve(parseInternalUrl("proc://other-job"), { session })).rejects.toThrow("not found");
			await expect(protocol.write(parseInternalUrl("proc://other-job/kill"), "", { session })).rejects.toThrow(
				"not found",
			);
			const running = await protocol.resolve(parseInternalUrl(`proc://${id}`), { session });
			expect(running.content).toContain("compiling assets");
			expect(running.content).toContain("building 50%");
			expect(running.details?.proc?.job).toMatchObject({ id, status: "running" });
			await expect(protocol.write(parseInternalUrl(`proc://${id}`), "input", { session })).rejects.toThrow(
				"in-process job",
			);
			await expect(protocol.resolve(parseInternalUrl(`proc://${id}/kill`), { session })).rejects.toThrow(
				"write-only",
			);
			expect(manager.getJob(id)?.status).toBe("running");
			const cancelled = await protocol.write(parseInternalUrl(`proc://${id}/kill`), "ignored payload", { session });
			expect(cancelled.content[0]?.type === "text" ? cancelled.content[0].text : "").toContain(
				`Cancelled background job ${id}`,
			);
			expect(cancelled.details?.proc).toMatchObject({ op: "cancel", cancelled: [{ id, status: "cancelled" }] });
			expect(manager.getJob(id)?.status).toBe("cancelled");
			const settledId = manager.register("bash", "completed command", async () => "DONE", {
				id: "settled-job",
				ownerId: "Main",
			});
			await manager.getJob(settledId)?.promise;
			const settled = await protocol.resolve(parseInternalUrl(`proc://${settledId}`), { session });
			expect(settled.content).toContain("DONE");
			expect(manager.isJobResultConsumed(settledId)).toBeFalse();
		} finally {
			await manager.dispose();
		}
	});

	it.each([false, true])(
		"rejects service-only controls for known jobs without claiming they are missing (launch: %s)",
		async launch => {
			const client = stubClient(async operation => {
				if (operation.op === "list") return { units: [] };
				throw new Error(`Unexpected daemon op ${operation.op}`);
			});
			const daemonSpy = vi.spyOn(daemonClient, "daemonClient").mockResolvedValue(client);
			const manager = new AsyncJobManager({});
			const pending = Promise.withResolvers<string>();
			const id = manager.register(
				"bash",
				"running command",
				async ({ signal }) => {
					signal.addEventListener("abort", () => pending.resolve("cancelled"), { once: true });
					return pending.promise;
				},
				{ id: "bg_12", ownerId: "Main" },
			);
			const session = toolSession(process.cwd(), manager, { launch });
			const protocol = new ProcProtocolHandler();
			try {
				for (const [suffix, content] of [
					["/mode", "persist"],
					["", "input"],
				]) {
					const message = await rejectionMessage(
						protocol.write(parseInternalUrl(`proc://${id}${suffix}`), content, { session }),
					);
					expect(message).toContain(`${id} is an in-process job`);
					expect(message).toContain("stdin and persist/session/detached modes are services-only");
					expect(message).toContain("Start long-lived work as a named service");
					expect(message).toContain("lifetime controls");
					expect(message).toContain(JSON.stringify({ path: `proc://${id}/kill`, content: "" }));
					expect(message).not.toContain("not found");

					const missing = await rejectionMessage(
						protocol.write(parseInternalUrl(`proc://missing-job${suffix}`), content, { session }),
					);
					expect(missing).toContain("not found: missing-job");
					expect(missing).not.toContain("in-process");
				}
				expect(manager.getJob(id)?.status).toBe("running");
				expect(manager.isJobResultConsumed(id)).toBeFalse();
				if (!launch) expect(daemonSpy).not.toHaveBeenCalled();
			} finally {
				daemonSpy.mockRestore();
				await manager.dispose();
			}
		},
	);

	it("reports unknown ids as missing for both service-only write operations", async () => {
		const protocol = new ProcProtocolHandler();
		const session = toolSession(process.cwd(), undefined, { launch: false });
		for (const [suffix, content] of [
			["/mode", "persist"],
			["", "input"],
		]) {
			const message = await rejectionMessage(
				protocol.write(parseInternalUrl(`proc://missing-job${suffix}`), content, { session }),
			);
			expect(message).toContain("not found: missing-job");
			expect(message).not.toContain("in-process");
		}
	});

	it("advertises stdin and modes as service-only while kill remains available for jobs and agents", async () => {
		const router = new InternalUrlRouter();
		const help = router
			.describe({
				skillUriAccess: false,
				ruleCount: 0,
				securityEnabled: false,
				settingsApproval: false,
				outReplies: false,
				subagent: false,
			})
			.find(line => line.startsWith("proc://"));
		expect(help).toMatch(/\/kill[^;]*jobs, agents, and services/);
		// Service controls live in the on-demand reference (`help://read/urls`), never unqualified in the always-on line.
		expect(help).not.toContain("stdin");
		const reference = router.reference().find(line => line.startsWith("proc://"));
		expect(reference).toMatch(/stdin[^;]*services.only/);
		expect(reference).toMatch(/\/mode[^;]*services.only/);
		expect(reference).toContain("named service");

		const protocol = new ProcProtocolHandler();
		const session = toolSession(process.cwd(), undefined, { launch: false });
		expect(await rejectionMessage(protocol.write(parseInternalUrl("proc://"), "", { session }))).toContain(
			"stdin and modes are services-only",
		);
	});

	it("answers a read of a write-only action with the write that performs it, leaving the job running", async () => {
		const manager = new AsyncJobManager({});
		const pending = Promise.withResolvers<string>();
		const id = manager.register(
			"bash",
			"running command",
			async ({ signal }) => {
				signal.addEventListener("abort", () => pending.resolve("cancelled"), { once: true });
				return pending.promise;
			},
			{ id: "bg_12", ownerId: "Main" },
		);
		const session = toolSession(process.cwd(), manager, { launch: false });
		const protocol = new ProcProtocolHandler();
		try {
			const kill = await rejectionMessage(protocol.resolve(parseInternalUrl(`proc://${id}/kill`), { session }));
			expect(kill).toContain("call write with");
			expect(kill).toContain(JSON.stringify({ path: "proc://bg_12/kill", content: "" }));
			expect(kill).toContain("read proc://bg_12 for its status");
			expect(manager.getJob(id)?.status).toBe("running");
			const mode = await rejectionMessage(protocol.resolve(parseInternalUrl(`proc://${id}/mode`), { session }));
			expect(mode).toContain("call write with");
			expect(mode).toContain('"path":"proc://bg_12/mode"');
			expect(mode).toContain("persist, session, or detached");
			expect(mode).toContain("services-only");
		} finally {
			await manager.dispose();
		}
	});

	it("kills via /kill and never interprets bare job writes as cancellation", async () => {
		const manager = new AsyncJobManager({});
		const pending = Promise.withResolvers<string>();
		const id = manager.register(
			"bash",
			"running command",
			async ({ signal }) => {
				signal.addEventListener("abort", () => pending.resolve("cancelled"), { once: true });
				return pending.promise;
			},
			{ ownerId: "Main" },
		);
		const write = new WriteTool(toolSession(process.cwd(), manager, { launch: false }));
		try {
			await expect(
				write.execute("invalid-cancel", {
					path: `proc://${id}`,
					content: '</antml>\n<parameter name="i">Cancelling background test run',
				}),
			).rejects.toThrow("in-process job");
			await expect(write.execute("empty-stdin", { path: `proc://${id}`, content: "" })).rejects.toThrow(
				"in-process job",
			);
			expect(manager.getJob(id)?.status).toBe("running");
			const result = await write.execute("kill", { path: `proc://${id}/kill`, content: "" });
			await manager.getJob(id)?.promise;
			expect(result.details?.proc).toMatchObject({ op: "cancel", cancelled: [{ id, status: "cancelled" }] });
			expect(manager.getJob(id)?.status).toBe("cancelled");
		} finally {
			await manager.dispose();
		}
	});

	it("kills owned jobs under plan mode while stdin stays guarded (issue #13803)", async () => {
		const manager = new AsyncJobManager({});
		const pending = Promise.withResolvers<string>();
		const id = manager.register(
			"task",
			"exploring the wrong track",
			async ({ signal }) => {
				signal.addEventListener("abort", () => pending.resolve("cancelled"), { once: true });
				return pending.promise;
			},
			{ ownerId: "Main" },
		);
		const session = toolSession(process.cwd(), manager, { launch: false });
		session.getPlanModeState = () => ({
			enabled: true,
			planFilePath: "local://PLAN.md",
			workflow: "parallel",
			reentry: false,
		});
		const write = new WriteTool(session);
		try {
			await expect(write.execute("stdin", { path: `proc://${id}`, content: "go" })).rejects.toThrow("Plan mode");
			expect(manager.getJob(id)?.status).toBe("running");
			const result = await write.execute("kill", { path: `proc://${id}/kill`, content: "" });
			await manager.getJob(id)?.promise;
			expect(result.details?.proc).toMatchObject({ op: "cancel", cancelled: [{ id, status: "cancelled" }] });
			expect(manager.getJob(id)?.status).toBe("cancelled");
		} finally {
			await manager.dispose();
		}
	});

	it("scopes a caller without an agent id to unowned jobs and parentless agents", async () => {
		const manager = new AsyncJobManager({});
		const pending = Promise.withResolvers<string>();
		manager.register(
			"bash",
			"main's work",
			async ({ signal }) => {
				signal.addEventListener("abort", () => pending.resolve("cancelled"), { once: true });
				return pending.promise;
			},
			{ id: "owned-job", ownerId: "Main" },
		);
		manager.register("bash", "unowned work", async () => "done", { id: "unowned-job" });
		const registry = new AgentRegistry();
		registry.register({ id: "Foreign", displayName: "Foreign", kind: "sub", parentId: "Main", session: null });
		const session = toolSession(process.cwd(), manager, { launch: false });
		session.getAgentId = () => null;
		session.agentRegistry = registry;
		const protocol = new ProcProtocolHandler();
		try {
			const list = await protocol.resolve(parseInternalUrl("proc://"), { session });
			expect(list.details?.proc?.jobs).toMatchObject([{ id: "unowned-job" }]);
			await expect(protocol.resolve(parseInternalUrl("proc://owned-job"), { session })).rejects.toThrow("not found");
			await expect(protocol.write(parseInternalUrl("proc://owned-job/kill"), "", { session })).rejects.toThrow(
				"not found",
			);
			expect(manager.getJob("owned-job")?.status).toBe("running");
			const denied = await protocol.write(parseInternalUrl("proc://Foreign/kill"), "", { session });
			expect(denied.details?.proc).toMatchObject({ cancelled: [{ id: "Foreign", status: "not_found" }] });
			expect(registry.get("Foreign")?.status).toBe("running");
		} finally {
			await manager.dispose();
		}
	});

	it.each([false, true])("kills only owned jobless agents (job manager: %s)", async withManager => {
		const manager = withManager ? new AsyncJobManager({}) : undefined;
		const registry = new AgentRegistry();
		registry.register({ id: "Worker", displayName: "Worker", kind: "sub", parentId: "Main", session: null });
		registry.register({ id: "Foreign", displayName: "Foreign", kind: "sub", parentId: "Other", session: null });
		const session = toolSession(process.cwd(), manager, { launch: false });
		session.agentRegistry = registry;
		const write = new WriteTool(session);
		try {
			for (const [suffix, content] of [
				["/mode", "persist"],
				["", "input"],
			]) {
				const message = await rejectionMessage(
					write.execute("service-only", { path: `proc://Worker${suffix}`, content }),
				);
				expect(message).toContain("Worker is an in-process agent");
				expect(message).toContain("stdin and persist/session/detached modes are services-only");
				expect(message).toContain("named service");
				expect(registry.get("Worker")?.status).toBe("running");
			}
			const denied = await write.execute("foreign", { path: "proc://Foreign/kill", content: "" });
			expect(denied.details?.proc).toMatchObject({ cancelled: [{ id: "Foreign", status: "not_found" }] });
			expect(registry.get("Foreign")?.status).toBe("running");
			const killed = await write.execute("worker", { path: "proc://Worker/kill", content: "" });
			expect(killed.details?.proc).toMatchObject({ cancelled: [{ id: "Worker", status: "cancelled" }] });
			expect(registry.get("Worker")).toBeUndefined();
		} finally {
			await manager?.dispose();
		}
	});

	it("finds a woken agent by its own id once its first job row is gone", async () => {
		const { manager, session } = await wokenAgentSession();
		const protocol = new ProcProtocolHandler();
		try {
			manager.evictCompletedJobs({ ownerId: "Main" });
			const running = await protocol.resolve(parseInternalUrl("proc://Quick"), { session });
			expect(running.details?.proc?.job).toMatchObject({ id: "Quick-2", status: "running" });
			for (const [suffix, content] of [
				["/mode", "persist"],
				["", "input"],
			]) {
				const message = await rejectionMessage(
					protocol.write(parseInternalUrl(`proc://Quick${suffix}`), content, { session }),
				);
				expect(message).toContain("Quick is an in-process job");
				expect(message).toContain("services-only");
				expect(manager.getJob("Quick-2")?.status).toBe("running");
			}

			const killed = await protocol.write(parseInternalUrl("proc://Quick/kill"), "", { session });
			await manager.getJob("Quick-2")?.promise;
			expect(killed.details?.proc).toMatchObject({ cancelled: [{ id: "Quick-2", status: "cancelled" }] });
			expect(manager.getJob("Quick-2")?.status).toBe("cancelled");
		} finally {
			await manager.dispose();
		}
	});

	it("names the running job of a woken agent when its settled first job is read", async () => {
		const { manager, session } = await wokenAgentSession();
		try {
			const settled = await new ProcProtocolHandler().resolve(parseInternalUrl("proc://Quick"), { session });
			expect(settled.details?.proc?.job).toMatchObject({ id: "Quick", status: "completed" });
			expect(settled.content).toContain("running again as job Quick-2");
		} finally {
			await manager.dispose();
		}
	});

	it("keeps a service named like a woken agent reachable for read and kill", async () => {
		const now = Date.now();
		const daemon = serviceUnit("Quick", { state: "ready", readyAt: now });
		const stopped: string[] = [];
		const client = stubClient(async operation => {
			if (operation.op === "list") return { units: [daemon] };
			if (operation.op === "describe") return { unit: daemon };
			if (operation.op === "logs") return { text: "serving\n", terminalOutput: "", cursor: 8, unit: daemon };
			if (operation.op === "stop") {
				stopped.push(unitKey(operation.unit));
				return { unit: { ...daemon, state: "exited", exitedAt: now } };
			}
			throw new Error(`Unexpected daemon op ${operation.op}`);
		});
		const spy = vi.spyOn(daemonClient, "daemonClient").mockResolvedValue(client);
		const { manager, session } = await wokenAgentSession({ launch: true });
		const protocol = new ProcProtocolHandler();
		try {
			manager.evictCompletedJobs({ ownerId: "Main" });
			const read = await protocol.resolve(parseInternalUrl("proc://Quick"), { session });
			expect(read.details?.proc).toMatchObject({ daemon: { key: "Quick" } });

			const killed = await protocol.write(parseInternalUrl("proc://Quick/kill"), "", { session });
			expect(killed.details?.proc).toMatchObject({ action: "stop", daemon: { key: "Quick" } });
			expect(stopped).toEqual(["Quick"]);
			expect(manager.getJob("Quick-2")?.status).toBe("running");
		} finally {
			spy.mockRestore();
			await manager.dispose();
		}
	});

	it("requires file content instead of silently truncating a file", async () => {
		using temp = TempDir.createSync("@omp-proc-write-");
		const file = path.join(temp.path(), "keep.txt");
		await Bun.write(file, "keep this");
		const write = new WriteTool(toolSession(temp.path(), undefined, { launch: false }));
		expect(() => write.parameters.assert({ path: file })).toThrow("content");
		expect(await Bun.file(file).text()).toBe("keep this");
		await write.execute("empty-file", { path: file, content: "" });
		expect(await Bun.file(file).text()).toBe("");
	});

	it("never offers strict-mode providers a nullable content", () => {
		const write = new WriteTool(toolSession(process.cwd(), undefined, { launch: false }));
		const strict = adaptSchemaForStrict(toolWireSchema(write), true);
		expect(strict.strict).toBe(true);
		expect(isJsonSchemaValueValid(strict.schema, { path: "proc://bg_1/kill", content: "" })).toBe(true);
		expect(isJsonSchemaValueValid(strict.schema, { path: "proc://bg_1/kill" })).toBe(false);
		// An optional `content` became `anyOf: [string, null]` here, and models filled the null.
		expect(isJsonSchemaValueValid(strict.schema, { path: "keep.txt", content: null })).toBe(false);
	});

	it("shows a running task's progress in the proc:// listing and its own read, but not a bash job's", async () => {
		const manager = new AsyncJobManager({});
		const pending = Promise.withResolvers<string>();
		const reported = Promise.withResolvers<void>();
		const taskId = manager.register(
			"task",
			"AcpSurface",
			async ({ jobId, reportProgress }) => {
				await reportProgress("running", {
					progress: [{ id: jobId, requests: 90, cost: 18.4, contextTokens: 160_000, contextWindow: 1_000_000 }],
				});
				reported.resolve();
				return pending.promise;
			},
			{ ownerId: "Main" },
		);
		const bashId = manager.register("bash", "sleep 60", () => pending.promise, { ownerId: "Main" });
		const session = toolSession(process.cwd(), manager, { launch: false });
		try {
			await reported.promise;
			const proc = new ProcProtocolHandler();
			const rows = (await proc.resolve(parseInternalUrl("proc://"), { session })).content.split("\n");
			expect(rows.find(row => row.startsWith(taskId))).toMatch(
				/ \[task\] running up \S+ — AcpSurface — 90 req · \$18\.40 · ctx 160K\/1M$/,
			);
			expect(rows.find(row => row.startsWith(bashId))).not.toMatch(/90 req|\$18\.40/u);
			const single = await proc.resolve(parseInternalUrl(`proc://${taskId}`), { session });
			expect(single.content.split("\n")[0]).toMatch(
				new RegExp(`^${taskId} \\[task\\] — running — AcpSurface — \\S+ · 90 req · \\$18\\.40 · ctx 160K/1M$`),
			);
		} finally {
			pending.resolve("done");
			await manager.dispose();
		}
	});

	it("keeps listing jobs and agents when the daemon hangs, flagging agents with no live turn", async () => {
		const daemonSpy = vi.spyOn(daemonClient, "daemonClient").mockResolvedValue(
			stubClient(async () => {
				throw new Error("Daemon list request timed out");
			}),
		);
		const manager = new AsyncJobManager({});
		const blocked = Promise.withResolvers<string>();
		manager.register(
			"bash",
			"long build",
			async ({ signal }) => {
				signal.addEventListener("abort", () => blocked.resolve("cancelled"), { once: true });
				return blocked.promise;
			},
			{ id: "build-job", ownerId: "Main" },
		);
		const registry = new AgentRegistry();
		// Claims `running` but no session is streaming: the run is over.
		registry.register({ id: "Visuals", displayName: "Visuals", kind: "sub", parentId: "Main", session: null });
		const session = toolSession(process.cwd(), manager, { launch: true });
		session.agentRegistry = registry;
		const proc = new ProcProtocolHandler();
		try {
			const list = await proc.resolve(parseInternalUrl("proc://"), { session });
			expect(list.content).toContain("build-job [bash] running");
			expect(list.content).toContain("Visuals [task] running up");
			expect(list.content).toContain("no turn in flight");
			expect(list.content).toContain("Services unavailable (daemon): Daemon list request timed out");
			const single = await proc.resolve(parseInternalUrl("proc://Visuals"), { session });
			expect(single.content).toContain("no turn in flight");
			await expect(proc.resolve(parseInternalUrl("proc://web"), { session })).rejects.toThrow(
				"services unavailable: Daemon list request timed out",
			);
			// The suggested kill works without the daemon; service-only actions still surface its error.
			const killed = await proc.write(parseInternalUrl("proc://Visuals/kill"), "", { session });
			expect(killed.details?.proc).toMatchObject({ cancelled: [{ id: "Visuals", status: "cancelled" }] });
			expect(registry.get("Visuals")).toBeUndefined();
			const killedJob = await proc.write(parseInternalUrl("proc://build-job/kill"), "", { session });
			expect(killedJob.details?.proc).toMatchObject({ cancelled: [{ id: "build-job", status: "cancelled" }] });
			await expect(proc.write(parseInternalUrl("proc://web"), "go\n", { session })).rejects.toThrow(
				"Daemon list request timed out",
			);
		} finally {
			daemonSpy.mockRestore();
			await manager.dispose();
		}
	});

	it("labels a kill of a job that settled during the call as delivered by that call", async () => {
		// `write proc://<id>/kill` awaits the daemon lookup before it
		// cancels, so a job can settle inside that window. The call that hands
		// the result over must say so — the same wording `wait` uses — instead
		// of calling the result a lost completion push (#16052).
		const gate = Promise.withResolvers<{ units: UnitSnapshot[] }>();
		const daemonSpy = vi.spyOn(daemonClient, "daemonClient").mockResolvedValue(stubClient(async () => gate.promise));
		const manager = new AsyncJobManager({});
		const settled = Promise.withResolvers<string>();
		const id = manager.register("bash", "late build", async () => settled.promise, { ownerId: "Main" });
		const session = toolSession(process.cwd(), manager, { launch: true });
		const proc = new ProcProtocolHandler();
		try {
			// The call is parked on the daemon lookup, so the job settles during it.
			const killing = proc.write(parseInternalUrl(`proc://${id}/kill`), "", { session });
			settled.resolve("late result");
			await manager.getJob(id)?.promise;
			gate.resolve({ units: [] });
			const killed = await killing;
			const text = killed.content[0]?.type === "text" ? killed.content[0].text : "";
			expect(text).toContain("Delivery: delivered by this call");
			expect(text).not.toContain("not auto-delivered");
		} finally {
			daemonSpy.mockRestore();
			await manager.dispose();
		}
	});

	it("keeps the missed-push wording for a job that settled before the kill call", async () => {
		// The job was already done when the kill arrived and nothing was on the
		// way, so the result is genuinely late — the line must stay honest and
		// say how long before the call it had finished.
		const daemonSpy = vi
			.spyOn(daemonClient, "daemonClient")
			.mockResolvedValue(stubClient(async () => ({ units: [] })));
		const manager = new AsyncJobManager({});
		const id = manager.register("bash", "earlier build", async () => "done earlier", { ownerId: "Main" });
		await manager.getJob(id)?.promise;
		manager.getJob(id)!.endTime = Date.now() - 5_000;
		const session = toolSession(process.cwd(), manager, { launch: true });
		const proc = new ProcProtocolHandler();
		try {
			const killed = await proc.write(parseInternalUrl(`proc://${id}/kill`), "", { session });
			const text = killed.content[0]?.type === "text" ? killed.content[0].text : "";
			expect(text).toContain("Delivery: not auto-delivered; recovered by this snapshot");
			expect(text).toMatch(/already finished \d+(ms|\.\ds) before this call/);
			expect(text).not.toContain("delivered by this call");
		} finally {
			daemonSpy.mockRestore();
			await manager.dispose();
		}
	});
});

describe("bash services via proc://", () => {
	it("leaves the service running when its logs fail", async () => {
		const unit = serviceUnit("log-failure-service", {
			state: "running",
			owner: "Main",
			pids: [12345],
		});
		const operations: DaemonOp["op"][] = [];
		const client = stubClient(async operation => {
			operations.push(operation.op);
			if (operation.op === "open") return { unit, lease: "service-lease", created: true };
			if (operation.op === "logs") throw new Error("service output log is unreadable");
			throw new Error(`Unexpected daemon op ${operation.op}`);
		});
		const spy = vi.spyOn(daemonClient, "daemonClient").mockResolvedValue(client);
		const session = toolSession(process.cwd());
		try {
			await expect(
				new BashTool(session).execute("service-log-failure", {
					command: "printf 'service output\\n'",
					name: unit.key,
					pty: false,
				}),
			).rejects.toThrow("service output log is unreadable");
			expect(hasLiveOwnedService(session)).toBeTrue();
			expect(operations).toEqual(["open", "logs"]);
		} finally {
			spy.mockRestore();
		}
	});

	it("starts at log readiness with a zero port placeholder and exposes service control through proc://", async () => {
		const harness = await IsolatedDaemon.create();
		const manager = new AsyncJobManager({});
		const session = toolSession(harness.dir, manager);
		const bash = new BashTool(session);
		const proc = new ProcProtocolHandler();
		try {
			const name = "echo-service";
			const dir = await daemonClient.canonicalProjectDir(harness.dir);
			const unit = { kind: "proc", scope: { kind: "project", dir }, key: name } as const;
			const started = await bash.execute("service", {
				command: "printf 'READY\\n'; while IFS= read -r line; do printf 'ACK:[%s]\\n' \"$line\"; done",
				name,
				ready: { log: "READY", port: 0, timeout: 15 },
				pty: false,
			});
			expect(started.details?.service).toMatchObject({ name, ready: true, timedOut: false });
			expect((await proc.resolve(parseInternalUrl("proc://"), { session })).details?.proc?.daemons).toMatchObject([
				{ key: name, state: "ready" },
			]);
			const pending = Promise.withResolvers<string>();
			const collisionId = manager.register(
				"bash",
				"colliding job",
				async ({ signal }) => {
					signal.addEventListener("abort", () => pending.resolve("cancelled"), { once: true });
					return pending.promise;
				},
				{ id: name, ownerId: "Main" },
			);
			const ambiguous = `both job ${name} and service ${name}`;
			await expect(proc.resolve(parseInternalUrl(`proc://${name}`), { session })).rejects.toThrow(ambiguous);
			for (const [suffix, content] of [
				["/kill", ""],
				["/mode", "persist"],
				["", "input"],
			]) {
				await expect(proc.write(parseInternalUrl(`proc://${name}${suffix}`), content, { session })).rejects.toThrow(
					ambiguous,
				);
			}
			manager.cancel(collisionId, { ownerId: "Main" });
			await manager.getJob(collisionId)?.promise;
			session.asyncJobManager = undefined;

			const write = new WriteTool(session);
			const sent = await write.execute("stdin", { path: `proc://${name}`, content: "hello" });
			expect(sent.details).toMatchObject({
				proc: { action: "stdin", daemon: { key: name }, input: "hello" },
				touchesNoFiles: true,
			});
			const client = await daemonClient.daemonClient();
			expect(
				await client.request({ op: "wait", unit, for: "ready", pattern: "ACK:\\[hello\\]", timeoutMs: 5_000 }),
			).toMatchObject({ matched: true, match: "ACK:[hello]" });
			expect((await proc.resolve(parseInternalUrl(`proc://${name}`), { session })).content).toContain("ACK:[hello]");
			await proc.write(parseInternalUrl(`proc://${name}`), "", { session });
			expect(
				await client.request({ op: "wait", unit, for: "ready", pattern: "ACK:\\[\\]", timeoutMs: 5_000 }),
			).toMatchObject({ matched: true, match: "ACK:[]" });
			await proc.write(parseInternalUrl(`proc://${name}/mode`), "persist", { session });
			expect((await client.request({ op: "describe", unit })).unit.policy.hold).toBe("persist");
			await proc.write(parseInternalUrl(`proc://${name}/mode`), "session", { session });
			expect((await client.request({ op: "describe", unit })).unit.policy.hold).toBe("leases");

			const replaced = await bash.execute("restart", {
				command: "printf 'REPLACED\\n'; read line",
				name,
				ready: { log: "REPLACED", host: "", timeout: 15 },
				pty: false,
			});
			expect(replaced.content[0]?.type === "text" ? replaced.content[0].text : "").toContain("REPLACED");
			const stopped = await write.execute("kill", { path: `proc://${name}/kill`, content: "" });
			expect(stopped.details?.proc).toMatchObject({ action: "stop", daemon: { key: name } });
		} finally {
			await manager.dispose();
			await harness.dispose();
		}
	}, 45_000);

	it("interrupts a queued readiness wait without abandoning the launched service", async () => {
		const steering = new AbortController();
		steering.abort();
		const unit = serviceUnit("steered-service", { state: "starting", pids: [12345], owner: "Main" });
		const operations: DaemonOp["op"][] = [];
		const client = stubClient(async (operation, signal) => {
			operations.push(operation.op);
			if (operation.op === "open") {
				expect(operation.awaitReady).toBe(false);
				return { unit, lease: "service-lease", created: true };
			}
			if (operation.op === "wait") {
				expect(signal?.aborted).toBeTrue();
				throw signal?.reason;
			}
			throw new Error(`Unexpected daemon op ${operation.op}`);
		});
		const spy = vi.spyOn(daemonClient, "daemonClient").mockResolvedValue(client);
		const session = toolSession(process.cwd());
		try {
			const result = await new BashTool(session).execute(
				"steered-service",
				{ command: "sleep 60", name: unit.key, ready: { log: "READY", timeout: 30 }, pty: false },
				undefined,
				undefined,
				steeringContext(steering.signal),
			);
			expect(result.details?.service).toMatchObject({ name: unit.key, state: "starting", ready: false });
			expect(hasLiveOwnedService(session)).toBeTrue();
			expect(operations).toEqual(["open", "wait"]);
		} finally {
			spy.mockRestore();
		}
	});
	it("still rejects validation and launch failures when a steer is queued", async () => {
		const steering = new AbortController();
		const client = stubClient(async operation => {
			if (operation.op === "open") {
				// The steer lands while the launch request is in flight.
				steering.abort();
				throw new Error("Daemon cwd is not a directory");
			}
			throw new Error(`Unexpected daemon op ${operation.op}`);
		});
		const spy = vi.spyOn(daemonClient, "daemonClient").mockResolvedValue(client);
		const bash = new BashTool(toolSession(process.cwd()));
		try {
			expect(
				await rejectionMessage(
					bash.execute(
						"launch-failure",
						{ command: "sleep 600", name: "launch-failure", ready: { log: "never-printed", timeout: 300 } },
						undefined,
						undefined,
						steeringContext(steering.signal),
					),
				),
			).toContain("Daemon cwd is not a directory");
			expect(
				await rejectionMessage(
					bash.execute(
						"bad-regex",
						{ command: "true", name: "bad-regex", ready: { log: "(", timeout: 300 } },
						undefined,
						undefined,
						steeringContext(steering.signal),
					),
				),
			).toContain("Invalid readiness regex");
		} finally {
			spy.mockRestore();
		}
	});

	it("keeps the settled service result when a steer arrives during log retrieval", async () => {
		const now = Date.now();
		const daemon = serviceUnit("ready-service", { state: "starting", pids: [12345], owner: "Main" });
		const ready = { ...daemon, state: "ready" as const, readyAt: now };
		const logsRequested = Promise.withResolvers<void>();
		const logs = Promise.withResolvers<unknown>();
		const client = stubClient(async operation => {
			if (operation.op === "open") return { unit: daemon, lease: "lease-1", created: true };
			if (operation.op === "wait") return { unit: ready, matched: true, match: "READY" };
			if (operation.op === "logs") {
				logsRequested.resolve();
				return logs.promise;
			}
			throw new Error(`Unexpected daemon op ${operation.op}`);
		});
		const spy = vi.spyOn(daemonClient, "daemonClient").mockResolvedValue(client);
		const steering = new AbortController();
		try {
			const pending = new BashTool(toolSession(process.cwd())).execute(
				"ready-service",
				{ command: "printf 'READY\n'", name: "ready-service", ready: { log: "READY", timeout: 300 } },
				undefined,
				undefined,
				steeringContext(steering.signal),
			);
			await logsRequested.promise;
			steering.abort();
			logs.resolve({ text: "READY\n", terminalOutput: "", cursor: 6, unit: ready });
			const result = await pending;
			expect(result.details?.service).toMatchObject({
				name: "ready-service",
				state: "ready",
				ready: true,
				pid: 12345,
			});
			expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("READY");
		} finally {
			spy.mockRestore();
		}
	});

	it.each([
		{
			label: "materialized placeholders",
			name: "",
			ready: { log: "", port: 0, host: "", timeout: 30 },
		},
		{ label: "blank fields", name: "   ", ready: { log: "", host: "" } },
		{ label: "timeout only", ready: { timeout: 30 } },
		{ label: "host only", ready: { host: "127.0.0.1" } },
	])("runs plain commands with $label", async ({ name, ready }) => {
		const bash = new BashTool(toolSession(process.cwd()));
		const result = await bash.execute("plain", {
			command: "printf 'PLAIN\\n'",
			timeout: 10,
			pty: false,
			async: false,
			name,
			ready,
		});
		const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("");
		expect(result.details?.service).toBeUndefined();
		expect(text).toContain("PLAIN\n");
		expect(text).not.toContain("[ready ignored:");
	});

	it("refuses to detach the project-shared browser, which the daemon would relaunch on an unprepared profile", async () => {
		const name = sharedBrowserDaemonName(true);
		const daemon = serviceUnit(name, { id: "shared", state: "ready", readyAt: Date.now() });
		const operations: DaemonOp["op"][] = [];
		const client = stubClient(async operation => {
			operations.push(operation.op);
			if (operation.op === "list") return { units: [daemon] };
			if (operation.op === "describe") return { unit: daemon };
			// The real daemon answers by relaunching the browser as a detached process.
			if (operation.op === "mode")
				return { unit: { ...daemon, policy: { ...daemon.policy, hold: "detached", survive: "detached" } } };
			throw new Error(`Unexpected daemon op ${operation.op}`);
		});
		const spy = vi.spyOn(daemonClient, "daemonClient").mockResolvedValue(client);
		try {
			await rejectionMessage(
				new ProcProtocolHandler().write(parseInternalUrl(`proc://${name}/mode`), "detached", {
					session: toolSession(process.cwd()),
				}),
			);
			expect(operations).not.toContain("mode");
		} finally {
			spy.mockRestore();
		}
	});
});
