import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import { KnowledgeService } from "../src/knowledge/service";
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
	await Bun.write(path.join(cwd, "sensor.md"), "# Sensor\n\nThe sensorbeacon measures temperature.\n");
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
		ui: {
			select: async () => "New knowledge index",
			confirm: async () => true,
			input: async (title: string) => (title === "Markdown directory" ? cwd : "manual"),
		},
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
		const init = KnowledgeService.prototype.init;
		vi.spyOn(KnowledgeService.prototype, "init").mockImplementation(
			async function (this: KnowledgeService, directory, name, options) {
				options?.onProgress?.({ phase: "scan", completed: 1, total: 10, failed: 0 });
				now += 199;
				options?.onProgress?.({ phase: "scan", completed: 2, total: 10, failed: 0 });
				now += 1;
				options?.onProgress?.({ phase: "scan", completed: 3, total: 10, failed: 0 });
				options?.onProgress?.({ phase: "scan", completed: 10, total: 10, failed: 0 });
				options?.onProgress?.({ phase: "fts", completed: 0, total: 9, failed: 0 });
				return init.call(this, directory, name, options);
			},
		);
		expect(await executeRpcBuiltinSlashCommand("/knowledge", f.runtime)).toEqual({ consumed: true });
		await Promise.all(f.tasks);
		expect(f.output.filter(text => /^\/knowledge: scan \d+\/10$/.test(text))).toEqual([
			"/knowledge: scan 1/10",
			"/knowledge: scan 3/10",
			"/knowledge: scan 10/10",
		]);
		expect(f.output).toContain("/knowledge: fts 0/9");
		expect(f.output.at(-1)).toContain("Created knowledge index manual: 1 documents.");
		const service = new KnowledgeService({ cwd: f.cwd, agentDir: f.settings.getAgentDir() });
		try {
			expect((await service.search("sensorbeacon")).sections.map(section => section.path)).toEqual(["sensor.md"]);
		} finally {
			await service.close();
		}
	});

	it("continues real indexing when a progress notification fails", async () => {
		const f = await fixture();
		let failures = 0;
		f.runtime.output = text => {
			if (text.startsWith("/knowledge:")) {
				failures++;
				throw new Error("host progress output unavailable");
			}
			f.output.push(text);
		};
		expect(await executeRpcBuiltinSlashCommand("/knowledge", f.runtime)).toEqual({ consumed: true });
		await Promise.all(f.tasks);
		expect(failures).toBeGreaterThan(0);
		expect(f.output.at(-1)).toContain("Created knowledge index manual: 1 documents.");
		const service = new KnowledgeService({ cwd: f.cwd, agentDir: f.settings.getAgentDir() });
		try {
			expect((await service.search("sensorbeacon")).sections.map(section => section.path)).toEqual(["sensor.md"]);
		} finally {
			await service.close();
		}
	});
});
