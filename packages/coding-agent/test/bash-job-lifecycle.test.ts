import { afterEach, beforeEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import type { BashToolDetails } from "@oh-my-pi/pi-tui/tools/bash";
import { AsyncJobManager } from "../src/async";
import { Settings } from "../src/config/settings";
import { parseInternalUrl } from "../src/internal-urls/parse";
import { ProcProtocolHandler } from "../src/internal-urls/proc-protocol";
import { asyncJobSnapshot } from "../src/session/async-job-views";
import type { ToolSession } from "../src/tools";
import { BashTool } from "../src/tools/bash";
import { WriteTool } from "../src/tools/write";

let cwd: string;
let manager: AsyncJobManager;
let tool: BashTool;
let write: WriteTool;

beforeEach(async () => {
	cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-job-lifecycle-"));
	manager = new AsyncJobManager({});
	const session: ToolSession = {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionId: () => cwd,
		getSessionSpawns: () => "*",
		asyncJobManager: manager,
		settings: Settings.isolated({}),
	};
	tool = new BashTool(session);
	write = new WriteTool(session);
});

afterEach(async () => {
	await manager.dispose();
	await fs.rm(cwd, { recursive: true, force: true });
});

it("keeps repeated finite Bash names distinct across receipts, owner views and final outcomes without aliases", async () => {
	const release = Promise.withResolvers<void>();
	const session: ToolSession = {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionId: () => cwd,
		getSessionSpawns: () => "*",
		getAgentId: () => "Owner",
		getToolCallIntent: () => "Checking command",
		asyncJobManager: manager,
		allocateOutputArtifact: async () => {
			await release.promise;
			return {};
		},
		settings: Settings.isolated({ "async.enabled": true, "launch.enabled": false }),
	};
	const bash = new BashTool(session);
	const protocol = new ProcProtocolHandler();
	const frames: BashToolDetails[] = [];
	try {
		const first = await bash.execute(
			"named-first",
			{ command: "printf named-output", async: true, timeout: 0 },
			undefined,
			update => {
				if (update.details) frames.push(update.details);
			},
		);
		const second = await bash.execute("named-second", { command: "printf named-output", async: true });
		const failed = await bash.execute("named-failed", { command: "printf failed-output; exit 3", async: true });
		const receipts = [first, second, failed].map(result => {
			const job = result.details?.async;
			if (!job?.name) throw new Error("expected a named finite Bash job");
			const text = result.content.find(block => block.type === "text")?.text ?? "";
			expect(text).toContain(`${job.jobId} — ${job.name}`);
			expect(result.details?.service).toBeUndefined();
			return job;
		});
		expect(new Set(receipts.map(job => job.name)).size).toBe(3);
		expect(first.details?.timeoutDisabled).toBe(true);
		const listed = await protocol.resolve(parseInternalUrl("proc://"), { session });
		for (const { jobId, name } of receipts) {
			expect(listed.content).toContain(name!);
			expect(listed.details?.proc?.jobs).toContainEqual(
				expect.objectContaining({ id: jobId, name, status: "running" }),
			);
			const detail = await protocol.resolve(parseInternalUrl(`proc://${jobId}`), { session });
			expect(detail.content).toContain(`Name: ${name}`);
			await expect(
				protocol.resolve(parseInternalUrl(`proc://${encodeURIComponent(name!)}`), { session }),
			).rejects.toThrow("not found");
		}
		const foreign = await protocol.resolve(parseInternalUrl("proc://"), {
			session: { ...session, getAgentId: () => "Other" },
		});
		expect(foreign.details?.proc?.jobs).toEqual([]);
		release.resolve();
		await manager.waitForAll();
		for (const [index, { jobId, name }] of receipts.entries()) {
			const status = index === 2 ? "failed" : "completed";
			const detail = await protocol.resolve(parseInternalUrl(`proc://${jobId}`), { session });
			expect(detail.details?.proc?.job).toMatchObject({ id: jobId, name, status });
			expect(detail.content).toContain(index === 2 ? "failed-output" : "named-output");
			expect(manager.isJobResultConsumed(jobId)).toBe(false);
			expect(asyncJobSnapshot(manager, "Owner").recent).toContainEqual(
				expect.objectContaining({ id: jobId, name, status }),
			);
		}
		expect(frames.some(frame => frame.async?.state === "completed")).toBe(true);
		expect(frames.every(frame => frame.async?.name === receipts[0]!.name)).toBe(true);
	} finally {
		release.resolve();
		await manager.waitForAll();
	}
});

it("rejects unnamed readiness and async PTY before executing commands", async () => {
	const marker = path.join(cwd, "should-not-exist");
	const command = "printf side-effect > should-not-exist";
	for (const { options, message } of [
		{ options: { ready: { log: "ready" } }, message: "ready requires a service name" },
		{ options: { name: " ", ready: { port: 12345 } }, message: "ready requires a service name" },
		{ options: { async: true, pty: true }, message: "Async bash does not support pty" },
	]) {
		const execution = tool.execute("invalid-mode", { command, ...options });
		await expect(execution).rejects.toBeInstanceOf(ToolError);
		await expect(execution).rejects.toThrow(message);
		expect(await Bun.file(marker).exists()).toBe(false);
	}
});

it("keeps empty readiness placeholders as a plain command", async () => {
	await tool.execute("empty-ready", {
		command: "printf executed > placeholder-marker",
		name: " ",
		ready: { log: " ", port: 0 },
		async: false,
		pty: false,
	});
	expect(await Bun.file(path.join(cwd, "placeholder-marker")).text()).toBe("executed");
});

it.skipIf(process.platform === "win32")(
	"allows a cancelled bash job to run its TERM cleanup",
	async () => {
		const script = path.join(cwd, "cleanup.sh");
		await Bun.write(
			script,
			"trap 'sleep 0.2; printf cleaned >> cleaned; exit 0' TERM\nprintf 'ready\\n'\nwhile :; do :; done\n",
		);
		const ready = Promise.withResolvers<void>();
		const result = await tool.execute(
			"term-cleanup",
			{ command: `sh ${JSON.stringify(script)}`, async: true, timeout: 0 },
			undefined,
			update => {
				if (update.content?.some(block => block.type === "text" && block.text.includes("ready"))) ready.resolve();
			},
		);
		await ready.promise;
		const id = result.details?.async?.jobId;
		if (!id) throw new Error("expected background job");
		const watchAbort = new AbortController();
		const watcher = fs.watch(cwd, { signal: watchAbort.signal });
		const cleaned = (async () => {
			for await (const event of watcher) {
				if (event.filename === "cleaned") return true;
			}
			return false;
		})();
		// A real subprocess handles TERM; fake timers cannot bound its OS-level cleanup.
		const deadline = Promise.withResolvers<false>();
		const watchdog = setTimeout(() => deadline.resolve(false), 3_000);
		try {
			const cancelled = await write.execute("cancel-cleanup", { path: `proc://${id}/kill` });
			expect(cancelled.details?.proc).toMatchObject({ cancelled: [{ id, status: "cancelled" }] });
			await manager.waitForAll();
			expect(await Promise.race([cleaned, deadline.promise])).toBe(true);
			expect(await Bun.file(path.join(cwd, "cleaned")).text()).toBe("cleaned");
		} finally {
			clearTimeout(watchdog);
			watchAbort.abort();
			await cleaned.catch(() => {});
		}
	},
	10_000,
);

it.skipIf(process.platform === "win32")("gives a background job the session identity", async () => {
	const sessionFile = path.join(cwd, "sessions", "bg.jsonl");
	const job = new BashTool({
		cwd,
		hasUI: false,
		getSessionFile: () => sessionFile,
		getSessionId: () => "session-bg",
		getSessionSpawns: () => "*",
		asyncJobManager: manager,
		settings: Settings.isolated({}),
	});
	const result = await job.execute("bg-env", {
		command: `printf '%s|%s|%s' "$PI_SESSION_ID" "$PI_SESSION_FILE" "$PI_TOOL_CALL_ID" > env.txt`,
		async: true,
	});
	if (!result.details?.async?.jobId) throw new Error("expected background job");
	await manager.waitForAll();
	const [id, file, callId] = (await Bun.file(path.join(cwd, "env.txt")).text()).split("|");
	expect(id).toBe("session-bg");
	expect(file).toBe(sessionFile);
	expect(callId).toBe("bg-env");
});
