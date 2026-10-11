import { afterEach, describe, expect, test, vi } from "bun:test";
import { logger } from "@oh-my-pi/pi-utils";
import { type LogEvent, registerLogSink } from "@oh-my-pi/pi-utils/logger";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import { DocsService } from "../src/docs/service";
import { getExtensionUISelectOptionLabel, type ExtensionUIContext } from "../src/extensibility/extensions/types";
import { RepoService } from "../src/repo/service";
import type { AgentSession } from "../src/session/agent-session";
import { executeRpcBuiltinSlashCommand } from "../src/slash-commands/acp-builtins";
import type { RpcSlashCommandRuntime } from "../src/slash-commands/types";

const directories: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

async function fixture() {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-index-"));
	directories.push(directory);
	const cwd = path.join(directory, "project");
	const agentDir = path.join(directory, "agent");
	const docsDir = path.join(directory, "docs");
	await Promise.all([cwd, agentDir, docsDir].map(value => fs.mkdir(value)));
	await Bun.write(path.join(cwd, "engine.py"), "def sensor_target(): return 'sensorbeacon'\n");
	await Bun.write(path.join(docsDir, "manual.md"), "# Sensors\n\nThe sensorbeacon measures temperature.\n");
	const settings = await Settings.loadIsolated({ cwd, agentDir, inMemory: true });
	const session = {
		sessionId: "index-session",
		sessionGeneration: 0,
		isDisposed: false,
		sessionManager: { getCwd: () => cwd },
	};
	const controller = new AbortController();
	const tasks: Promise<void>[] = [];
	const output: string[] = [];
	const select = vi.fn<ExtensionUIContext["select"]>(async () => undefined);
	const input = vi.fn<ExtensionUIContext["input"]>(async () => undefined);
	const confirm = vi.fn<ExtensionUIContext["confirm"]>(async () => false);
	const runtime: RpcSlashCommandRuntime = {
		session: session as unknown as AgentSession,
		sessionManager: session.sessionManager as unknown as AgentSession["sessionManager"],
		settings,
		cwd,
		signal: controller.signal,
		ui: { select, input, confirm },
		output: text => {
			output.push(text);
		},
		refreshCommands: async () => {},
		reloadPlugins: async () => {},
		runCommandInBackground: task => {
			tasks.push(task());
		},
		runModeCommand: async () => {
			throw new Error("An index command must not enter another mode");
		},
	};
	const run = async (command: string) => {
		expect(await executeRpcBuiltinSlashCommand(command, runtime)).toEqual({ consumed: true });
		await Promise.all(tasks.splice(0));
	};
	return { cwd, agentDir, docsDir, session, controller, runtime, tasks, output, select, input, confirm, run };
}

describe("RPC index commands use the real index services", () => {
	test("wiki creates, searches and deletes an index through host dialogs without modifying source documents", async () => {
		const f = await fixture();
		f.select.mockResolvedValueOnce("New document index");
		f.input.mockResolvedValueOnce(f.docsDir).mockResolvedValueOnce("manual");
		await f.run("/wiki");
		expect(f.output.join("\n")).toContain("Created document index manual: 1 documents.");

		f.select.mockResolvedValueOnce("Search document indexes");
		f.select.mockImplementationOnce(async (_title, options) => getExtensionUISelectOptionLabel(options[0]!));
		f.input.mockResolvedValueOnce("sensorbeacon");
		await f.run("/wiki");
		expect(f.output.join("\n")).toContain("The sensorbeacon measures temperature.");
		expect(f.output.join("\n")).toContain("manual.md:");

		f.select.mockResolvedValueOnce("Delete document index").mockResolvedValueOnce("1. manual");
		f.confirm.mockResolvedValueOnce(false);
		await f.run("/wiki");
		const docs = new DocsService({ agentDir: f.agentDir, cwd: f.cwd });
		try {
			expect(docs.list().map(index => index.name)).toEqual(["manual"]);
		} finally {
			docs.close();
		}
		f.select.mockResolvedValueOnce("Delete document index").mockResolvedValueOnce("1. manual");
		f.confirm.mockResolvedValueOnce(true);
		await f.run("/wiki");
		const removed = new DocsService({ agentDir: f.agentDir, cwd: f.cwd });
		try {
			expect(removed.list()).toEqual([]);
		} finally {
			removed.close();
		}
		expect(await Bun.file(path.join(f.docsDir, "manual.md")).text()).toContain("sensorbeacon");
	});

	test("wiki reports duplicate-name failure and keeps the original searchable index", async () => {
		const f = await fixture();
		const indexName = "PRIVATE_DUPLICATE_INDEX_TITLE";
		const docs = new DocsService({ agentDir: f.agentDir, cwd: f.cwd });
		try {
			await docs.init(f.docsDir, indexName);
		} finally {
			docs.close();
		}
		const events: LogEvent[] = [];
		const operationId = "rpc-wiki-duplicate-regression";
		const dispose = registerLogSink(event => {
			if (event.context?.operation_id === operationId && event.context.component === "rpc") events.push(event);
		});
		try {
			f.select.mockResolvedValueOnce("New document index");
			f.input.mockResolvedValueOnce(f.docsDir).mockResolvedValueOnce(indexName);
			await logger.withLogContext({ operation_id: operationId, call_id: "rpc-wiki-parent" }, () => f.run("/wiki"));
			expect(f.output.join("\n")).toContain(`/wiki failed: Document index already exists: ${indexName}`);
			const retained = new DocsService({ agentDir: f.agentDir, cwd: f.cwd });
			try {
				expect(retained.list().map(index => index.name)).toEqual([indexName]);
				expect(retained.search("sensorbeacon").sections).not.toHaveLength(0);
			} finally {
				retained.close();
			}
			expect(events.map(event => event.context?.event)).toEqual([
				"rpc_index_dashboard_started",
				"rpc_index_dashboard_failed",
			]);
			const [started, failed] = events;
			expect(started).toMatchObject({
				level: "info",
				context: {
					command: "/wiki",
					stage: "dashboard",
					result: "started",
					operation_id: operationId,
					parent_call_id: "rpc-wiki-parent",
					session_id: f.session.sessionId,
					session_generation: 0,
				},
			});
			expect(started?.context?.call_id).toEqual(expect.any(String));
			expect(started?.context?.call_id).not.toBe("rpc-wiki-parent");
			expect(structuredClone(failed)).toMatchObject({
				level: "error",
				context: {
					command: "/wiki",
					stage: "docs_init",
					result: "failed",
					error_type: "Error",
					operation_id: operationId,
					call_id: started?.context?.call_id,
					parent_call_id: "rpc-wiki-parent",
					elapsed_ms: expect.any(Number),
				},
			});
			expect(Number(failed?.context?.elapsed_ms)).toBeGreaterThanOrEqual(0);
			const serialized = JSON.stringify(events);
			for (const sensitive of [
				indexName,
				f.docsDir,
				f.cwd,
				f.agentDir,
				"Document index already exists",
				"Sensors",
				"sensorbeacon",
			]) {
				expect(serialized).not.toContain(sensitive);
			}
		} finally {
			dispose();
		}
	});

	test("repository build requires confirmation of the actual root, then update and deletion preserve project files", async () => {
		const f = await fixture();
		f.select.mockResolvedValueOnce("Build repository index");
		await f.run("/repo");
		expect(f.confirm.mock.calls[0]?.[0]).toBe("Build repository index?");
		const missing = new RepoService({ cwd: f.cwd, agentDir: f.agentDir });
		try {
			expect(f.confirm.mock.calls[0]?.[1]).toBe(`Root: ${missing.root}`);
			expect((await missing.status()).exists).toBe(false);
		} finally {
			missing.close();
		}

		f.select.mockResolvedValueOnce("Build repository index");
		f.confirm.mockResolvedValueOnce(true);
		await f.run("/repo");
		expect(f.output.join("\n")).toContain("Build repository index complete.");
		await Bun.write(path.join(f.cwd, "engine.py"), "def sensor_updated(): return 'updatedbeacon'\n");
		f.select.mockResolvedValueOnce("Update repository index");
		await f.run("/repo");
		const updated = new RepoService({ cwd: f.cwd, agentDir: f.agentDir });
		try {
			expect((await updated.symbol("sensor_updated")).hits.map(hit => hit.path)).toEqual(["engine.py"]);
			expect((await updated.search("sensorbeacon")).hits).toEqual([]);
		} finally {
			updated.close();
		}

		f.select.mockResolvedValueOnce("Delete repository index");
		f.confirm.mockResolvedValueOnce(true);
		await f.run("/repo");
		const removed = new RepoService({ cwd: f.cwd, agentDir: f.agentDir });
		try {
			expect((await removed.status()).exists).toBe(false);
		} finally {
			removed.close();
		}
		expect(await Bun.file(path.join(f.cwd, "engine.py")).text()).toContain("sensor_updated");
	});

	test("repository rebuild recovers a corrupt database only after confirmation", async () => {
		const f = await fixture();
		const before = new RepoService({ cwd: f.cwd, agentDir: f.agentDir });
		await before.build();
		const indexPath = before.storage.path;
		before.close();
		await Bun.write(indexPath, "corrupt database");
		const events: LogEvent[] = [];
		const operationId = "rpc-repo-recovery-regression";
		const dispose = registerLogSink(event => {
			if (event.context?.operation_id === operationId && event.context.component === "rpc") events.push(event);
		});
		try {
			f.select.mockResolvedValueOnce("Rebuild repository index");
			await logger.withLogContext({ operation_id: operationId }, () => f.run("/repo"));
			expect(await Bun.file(indexPath).text()).toBe("corrupt database");
			expect(f.output.join("\n")).toContain("Unable to read repository index status:");
			const firstCall = events[0]?.context?.call_id;
			expect(firstCall).toEqual(expect.any(String));
			expect(events.map(event => event.context?.event)).toEqual([
				"rpc_index_dashboard_started",
				"rpc_index_dashboard_stage_failed",
				"rpc_index_dashboard_cancelled",
			]);
			expect(events[1]).toMatchObject({
				level: "error",
				context: {
					command: "/repo",
					stage: "repo_status",
					result: "failed",
					error_type: "Error",
					operation_id: operationId,
					call_id: firstCall,
					elapsed_ms: expect.any(Number),
				},
			});
			expect(events[2]?.context).toMatchObject({ result: "cancelled", call_id: firstCall });
			f.select.mockResolvedValueOnce("Rebuild repository index");
			f.confirm.mockResolvedValueOnce(true);
			await logger.withLogContext({ operation_id: operationId }, () => f.run("/repo"));
			expect(f.output.join("\n")).toContain("Rebuild repository index complete.");
			const recovered = new RepoService({ cwd: f.cwd, agentDir: f.agentDir });
			try {
				expect(recovered.storage.recoveryError).toBeUndefined();
				expect((await recovered.symbol("sensor_target")).hits.map(hit => hit.path)).toEqual(["engine.py"]);
			} finally {
				recovered.close();
			}
			expect(events.slice(3).map(event => event.context?.event)).toEqual([
				"rpc_index_dashboard_started",
				"rpc_index_dashboard_stage_failed",
				"rpc_index_dashboard_completed",
			]);
			const recoveryCall = events[3]?.context?.call_id;
			expect(recoveryCall).toEqual(expect.any(String));
			expect(recoveryCall).not.toBe(firstCall);
			expect(events[4]).toMatchObject({
				level: "error",
				context: {
					command: "/repo",
					stage: "repo_status",
					result: "failed",
					operation_id: operationId,
					call_id: recoveryCall,
					elapsed_ms: expect.any(Number),
				},
			});
			expect(events[5]?.context).toMatchObject({
				stage: "index_output",
				result: "completed",
				call_id: recoveryCall,
			});
			const serialized = JSON.stringify(events);
			for (const sensitive of [
				indexPath,
				f.cwd,
				f.agentDir,
				"Repository index recovery required",
				"corrupt database",
				"engine.py",
			]) {
				expect(serialized).not.toContain(sensitive);
			}
		} finally {
			dispose();
		}
	});

	test("a session switch while root confirmation is pending cannot create an index or output into the new session", async () => {
		const f = await fixture();
		const events: LogEvent[] = [];
		const operationId = "rpc-repo-session-switch-regression";
		const dispose = registerLogSink(event => {
			if (event.context?.operation_id === operationId && event.context.component === "rpc") events.push(event);
		});
		try {
			f.select.mockResolvedValueOnce("Build repository index");
			let outputCount = 0;
			f.confirm.mockImplementationOnce(async () => {
				outputCount = f.output.length;
				f.session.sessionGeneration++;
				return true;
			});
			await logger.withLogContext({ operation_id: operationId }, () => f.run("/repo"));
			expect(f.output).toHaveLength(outputCount);
			const service = new RepoService({ cwd: f.cwd, agentDir: f.agentDir });
			try {
				expect((await service.status()).exists).toBe(false);
			} finally {
				service.close();
			}
			expect(events.map(event => event.context?.event)).toEqual([
				"rpc_index_dashboard_started",
				"rpc_index_dashboard_cancelled",
			]);
			expect(events[0]?.context?.call_id).toEqual(expect.any(String));
			expect(events[1]).toMatchObject({
				level: "info",
				context: {
					command: "/repo",
					stage: "maintenance_confirm",
					result: "cancelled",
					operation_id: operationId,
					call_id: events[0]?.context?.call_id,
					session_id: f.session.sessionId,
					session_generation: 0,
					elapsed_ms: expect.any(Number),
				},
			});
			const serialized = JSON.stringify(events);
			for (const sensitive of [f.cwd, f.agentDir, "Build repository index?", "Root:"]) {
				expect(serialized).not.toContain(sensitive);
			}
		} finally {
			dispose();
		}
	});

	test("abort stops a pending dashboard dialog while the prompt is already acknowledged", async () => {
		const f = await fixture();
		const entered = Promise.withResolvers<void>();
		f.select.mockImplementationOnce(async (_title, _options, dialogOptions) => {
			const answer = Promise.withResolvers<string | undefined>();
			dialogOptions?.signal?.addEventListener("abort", () => answer.resolve(undefined), { once: true });
			entered.resolve();
			return answer.promise;
		});
		expect(await executeRpcBuiltinSlashCommand("/wiki", f.runtime)).toEqual({ consumed: true });
		await entered.promise;
		f.controller.abort();
		await Promise.all(f.tasks);
		expect(f.input).not.toHaveBeenCalled();
		expect(f.output).toEqual(["No document indexes."]);
	});

	test("cancelled repository rebuilding preserves the previous usable generation", async () => {
		const f = await fixture();
		const before = new RepoService({ cwd: f.cwd, agentDir: f.agentDir });
		const generation = (await before.build()).generation;
		before.close();
		f.select.mockResolvedValueOnce("Rebuild repository index");
		f.confirm.mockResolvedValueOnce(true);
		f.runtime.output = text => {
			f.output.push(text);
			if (text.startsWith("/repo: enumerating")) f.controller.abort();
		};
		await f.run("/repo");
		expect(f.output.join("\n")).not.toContain("Rebuild repository index complete.");
		const retained = new RepoService({ cwd: f.cwd, agentDir: f.agentDir });
		try {
			expect((await retained.status()).generation).toBe(generation);
			expect((await retained.symbol("sensor_target")).hits).toHaveLength(1);
		} finally {
			retained.close();
		}
	});
});
