import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import { RepoService } from "../src/repo/service";
import { executeRpcBuiltinSlashCommand } from "../src/slash-commands/acp-builtins";
import type { RpcSlashCommandRuntime } from "../src/slash-commands/types";

const directories: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

async function fixture() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-progress-"));
	directories.push(root);
	const cwd = path.join(root, "project");
	await fs.mkdir(cwd);
	await Bun.write(path.join(cwd, "sensor.py"), "def sensor_beacon(): return 42\n");
	const settings = await Settings.loadIsolated({ cwd, agentDir: path.join(root, "agent"), inMemory: true });
	const tasks: Promise<void>[] = [];
	const output: string[] = [];
	const controller = new AbortController();
	const session = {
		sessionId: "progress-owner",
		sessionGeneration: 0,
		isDisposed: false,
		sessionManager: { getCwd: () => cwd },
	};
	const runtime = {
		cwd,
		settings,
		session,
		sessionManager: session.sessionManager,
		signal: controller.signal,
		ui: { select: async () => "Build repository index", confirm: async () => true, input: async () => undefined },
		output: (text: string) => {
			output.push(text);
		},
		runCommandInBackground: (task: () => Promise<void>) => {
			tasks.push(task());
		},
		refreshCommands: async () => {},
		reloadPlugins: async () => {},
	} as unknown as RpcSlashCommandRuntime;
	return { root, cwd, settings, runtime, output, tasks, controller };
}

describe("RPC index progress contract", () => {
	it("throttles an unfinished phase for 200ms while retaining phase changes and final progress", async () => {
		const f = await fixture();
		let now = 1_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const build = RepoService.prototype.build;
		vi.spyOn(RepoService.prototype, "build").mockImplementation(async function (this: RepoService, options) {
			options?.onProgress?.({ phase: "parsing", processed: 1, total: 10 });
			now += 199;
			options?.onProgress?.({ phase: "parsing", processed: 2, total: 10 });
			now += 1;
			options?.onProgress?.({ phase: "parsing", processed: 3, total: 10 });
			options?.onProgress?.({ phase: "parsing", processed: 10, total: 10 });
			options?.onProgress?.({ phase: "reading", processed: 0, total: 9 });
			return build.call(this, options);
		});
		expect(await executeRpcBuiltinSlashCommand("/repo", f.runtime)).toEqual({ consumed: true });
		await Promise.all(f.tasks);
		expect(f.output.filter(text => text.startsWith("/repo: parsing"))).toEqual([
			"/repo: parsing 1/10",
			"/repo: parsing 3/10",
			"/repo: parsing 10/10",
		]);
		expect(f.output).toContain("/repo: reading 0/9");
		expect(f.output.at(-1)).toContain("Build repository index complete.");
		const service = new RepoService({ cwd: f.cwd, agentDir: f.settings.getAgentDir() });
		try {
			expect((await service.symbol("sensor_beacon")).hits.map(hit => hit.path)).toEqual(["sensor.py"]);
		} finally {
			service.close();
		}
	});

	it("continues real indexing when a progress notification fails", async () => {
		const f = await fixture();
		let failures = 0;
		f.runtime.output = text => {
			if (text.startsWith("/repo:")) {
				failures++;
				throw new Error("host progress output unavailable");
			}
			f.output.push(text);
		};
		expect(await executeRpcBuiltinSlashCommand("/repo", f.runtime)).toEqual({ consumed: true });
		await Promise.all(f.tasks);
		expect(failures).toBeGreaterThan(0);
		expect(f.output.at(-1)).toContain("Build repository index complete.");
		const service = new RepoService({ cwd: f.cwd, agentDir: f.settings.getAgentDir() });
		try {
			expect((await service.symbol("sensor_beacon")).hits.map(hit => hit.path)).toEqual(["sensor.py"]);
		} finally {
			service.close();
		}
	});
});
