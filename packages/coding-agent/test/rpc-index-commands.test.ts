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

interface WikiEvidenceLocation {
	cwd: string;
	agentDir: string;
	docsDir: string;
}

async function importWikiEvidence(f: WikiEvidenceLocation, count: number) {
	await fs.rm(path.join(f.docsDir, "manual.md"));
	for (let index = 0; index < count; index++)
		await Bun.write(
			path.join(f.docsDir, `p${String(index).padStart(2, "0")}.md`),
			`# Evidence\nmbist_check.rpt evidence ${index}\nStored final line ${index}.\n`,
		);
	const docs = new DocsService({ agentDir: f.agentDir, cwd: f.cwd });
	try {
		await docs.init(f.docsDir, "manual");
		return await docs.search("mbist_check.rpt", { limit: 100 });
	} finally {
		await docs.close();
	}
}

const grepExpression = String.raw` raw\.Token\[42\] `;

async function importGrepEvidence(f: WikiEvidenceLocation, count: number) {
	await fs.rm(path.join(f.docsDir, "manual.md"));
	for (let index = 0; index < count; index++)
		await Bun.write(
			path.join(f.docsDir, `p${String(index).padStart(2, "0")}.md`),
			`# Evidence\n raw.Token[42] marker ${index}\nStored final line ${index}.\n`,
		);
	for (const [name, text] of [
		["normalized", " raw Token 42 marker"],
		["uppercase", " RAW.Token[42] marker"],
		["unspaced", "raw.Token[42] marker"],
		["suffix", " raw.Token[42]suffix"],
	])
		await Bun.write(path.join(f.docsDir, `${name}.md`), `# Decoy\n${text}\n`);
	const docs = new DocsService({ agentDir: f.agentDir, cwd: f.cwd });
	try {
		await docs.init(f.docsDir, "manual");
		return await docs.search(grepExpression, { mode: "grep", case: true, limit: 100 });
	} finally {
		await docs.close();
	}
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
			expect((await docs.list()).map(index => index.name)).toEqual(["manual"]);
		} finally {
			await docs.close();
		}
		f.select.mockResolvedValueOnce("Delete document index").mockResolvedValueOnce("1. manual");
		f.confirm.mockResolvedValueOnce(true);
		await f.run("/wiki");
		const removed = new DocsService({ agentDir: f.agentDir, cwd: f.cwd });
		try {
			expect(await removed.list()).toEqual([]);
		} finally {
			await removed.close();
		}
		expect(await Bun.file(path.join(f.docsDir, "manual.md")).text()).toContain("sensorbeacon");
	});

	test("wiki browses every DB page without rewriting its query and outputs complete snapshot citations", async () => {
		const f = await fixture();
		const expected = await importWikiEvidence(f, 45);
		expect(expected.total).toBe(45);
		await fs.rm(f.docsDir, { recursive: true });
		const seen: string[] = [];
		let pageKey: string | undefined;
		f.select.mockImplementation(async (title, options) => {
			if (title === "Document indexes") return "Search document indexes";
			const labels = options.map(getExtensionUISelectOptionLabel);
			if (labels[0] !== pageKey) {
				pageKey = labels[0];
				seen.push(...labels.filter(label => /^\d+\./.test(label)));
				return labels[0];
			}
			return labels.includes("Next page") ? "Next page" : "Done browsing";
		});
		f.input.mockResolvedValueOnce("mbist_check.rpt");
		await f.run("/wiki");
		expect(f.input).toHaveBeenCalledTimes(1);
		expect(seen).toHaveLength(45);
		expect(new Set(seen).size).toBe(45);
		expect(seen).toEqual(
			expected.sections.map(
				(section, position) =>
					`${position + 1}. [exact-name] [${section.index}] ${section.path}:${section.lineStart}-${section.lineEnd} ${section.headingPath}`,
			),
		);
		const output = f.output.join("\n");
		expect(output).toContain("Section hits: 45 · showing 1-20");
		expect(output).toContain("showing 21-40");
		expect(output).toContain("showing 41-45");
		expect(output).toContain("exact-name matches: 45");
		expect(output).toContain("Results exhausted.");
		for (const position of [0, 20, 40]) {
			const section = expected.sections[position]!;
			expect(output).toContain(
				`[exact-name] [${section.index}] ${section.path}:${section.lineStart}-${section.lineEnd} ${section.headingPath}\nsha256=${section.documentHash} · sectionId=${section.sectionId}\n\n${section.text}`,
			);
		}
		const finalOptions = f.select.mock.calls.at(-1)![1].map(getExtensionUISelectOptionLabel);
		expect(finalOptions).not.toContain("Next page");
		expect(finalOptions).toContain("Done browsing");
	});

	test("wiki grep preserves expression spaces and regex mode for every DB-only page", async () => {
		const f = await fixture();
		const expected = await importGrepEvidence(f, 45);
		expect(expected.total).toBe(45);
		await fs.rm(f.docsDir, { recursive: true });
		const seen: string[] = [];
		let pageKey: string | undefined;
		f.select.mockImplementation(async (title, options) => {
			const labels = options.map(getExtensionUISelectOptionLabel);
			if (title === "Document indexes") {
				expect(labels).toContain("Search document indexes");
				expect(labels).toContain("Grep document indexes");
				return "Grep document indexes";
			}
			if (labels[0] !== pageKey) {
				pageKey = labels[0];
				seen.push(...labels.filter(label => /^\d+\./.test(label)));
				return labels[0];
			}
			return labels.includes("Next page") ? "Next page" : "Done browsing";
		});
		f.input.mockResolvedValueOnce(grepExpression);
		await f.run("/wiki");
		expect(f.input).toHaveBeenCalledTimes(1);
		expect(f.input.mock.calls[0]![0]).toBe("Grep document indexes");
		expect(seen).toEqual(
			expected.sections.map(
				(section, position) =>
					`${position + 1}. [regex] [${section.index}] ${section.path}:${section.lineStart}-${section.lineEnd} ${section.headingPath}`,
			),
		);
		expect(new Set(seen).size).toBe(45);
		const output = f.output.join("\n");
		for (const range of ["1-20", "21-40", "41-45"]) expect(output).toContain(`showing ${range}`);
		for (const position of [0, 20, 40]) {
			const section = expected.sections[position]!;
			expect(output).toContain(
				`[regex] [${section.index}] ${section.path}:${section.lineStart}-${section.lineEnd} ${section.headingPath}\nsha256=${section.documentHash} · sectionId=${section.sectionId}\n\n${section.text}`,
			);
		}
		for (const decoy of ["normalized.md", "uppercase.md", "unspaced.md", "suffix.md"])
			expect(seen.join("\n")).not.toContain(decoy);
		expect(output).toContain("Results exhausted.");
		expect(output).not.toContain("Full name:");
		expect(output).not.toContain("/wiki failed:");
	}, 15_000);

	test("wiki keeps default technical names distinct from explicit grep and accepts PCRE2", async () => {
		const f = await fixture();
		await importGrepEvidence(f, 1);
		await fs.rm(f.docsDir, { recursive: true });
		f.select.mockResolvedValueOnce("Search document indexes");
		f.select.mockImplementationOnce(async (_title, options) => {
			const labels = options.map(getExtensionUISelectOptionLabel);
			expect(labels.some(label => label.includes("[exact-name]") && label.includes("uppercase.md"))).toBe(true);
			expect(labels.some(label => label.includes("[exact-name]") && label.includes("unspaced.md"))).toBe(true);
			return labels.find(label => label.includes("p00.md"));
		});
		f.select.mockResolvedValueOnce("Done browsing");
		f.input.mockResolvedValueOnce(" raw.Token[42] ");
		await f.run("/wiki");
		expect(f.output.join("\n")).toContain("[exact-name]");
		f.output.length = 0;
		f.select.mockResolvedValueOnce("Grep document indexes");
		f.input.mockResolvedValueOnce("raw.Token[42]");
		await f.run("/wiki");
		expect(f.output.join("\n")).toContain("Section hits: 0");
		expect(f.output.join("\n")).not.toContain("Full name:");
		f.output.length = 0;
		f.select.mockResolvedValueOnce("Grep document indexes");
		f.select.mockImplementationOnce(async (_title, options) => getExtensionUISelectOptionLabel(options[0]!));
		f.select.mockResolvedValueOnce("Done browsing");
		f.input.mockResolvedValueOnce(String.raw`(?<= )raw\.Token\[42\](?= )`);
		await f.run("/wiki");
		expect(f.output.join("\n")).toContain("Section hits: 1");
		expect(f.output.join("\n")).toContain("[regex] [manual] p00.md:");
		expect(f.output.join("\n")).toContain(" raw.Token[42] marker 0");
		expect(f.output.join("\n")).not.toContain("/wiki failed:");
	}, 15_000);

	test("wiki reports invalid and oversized grep without erasing existing snapshot evidence", async () => {
		const f = await fixture();
		const expected = await importGrepEvidence(f, 1);
		f.select.mockResolvedValueOnce("Grep document indexes");
		f.select.mockImplementationOnce(async (_title, options) => getExtensionUISelectOptionLabel(options[0]!));
		f.select.mockResolvedValueOnce("Done browsing");
		f.input.mockResolvedValueOnce(grepExpression);
		await f.run("/wiki");
		const evidence = expected.sections[0]!;
		const retained = f.output.find(value => value.includes(`sha256=${evidence.documentHash}`))!;
		expect(retained).toContain(evidence.text);
		for (const expression of ["[", "x".repeat(501)]) {
			const start = f.output.length;
			f.select.mockResolvedValueOnce("Grep document indexes");
			f.input.mockResolvedValueOnce(expression);
			await f.run("/wiki");
			const failure = f.output.slice(start).join("\n");
			expect(failure).toContain("/wiki failed:");
			expect(failure).not.toContain("Section hits:");
			expect(failure).toMatch(expression === "[" ? /invalid.*regex/i : /500/);
			expect(f.output).toContain(retained);
		}
	}, 15_000);

	for (const failure of ["cancel", "stale"] as const) {
		test(`wiki grep ${failure} continuation retains the selected snapshot without restarting`, async () => {
			const f = await fixture();
			const expected = await importGrepEvidence(f, 25);
			f.input.mockResolvedValueOnce(grepExpression);
			f.select.mockResolvedValueOnce("Grep document indexes");
			f.select.mockImplementationOnce(async (_title, options) => getExtensionUISelectOptionLabel(options[0]!));
			f.select.mockImplementationOnce(async (_title, options) => {
				expect(options.map(getExtensionUISelectOptionLabel)).toContain("Next page");
				if (failure === "cancel") {
					f.controller.abort();
				} else {
					const docs = new DocsService({ agentDir: f.agentDir, cwd: f.cwd });
					try {
						await docs.remove("manual");
						await fs.rm(f.docsDir, { recursive: true });
						await fs.mkdir(f.docsDir);
						await Bun.write(
							path.join(f.docsDir, "replacement.md"),
							"# Replacement\n raw.Token[42] new snapshot\n",
						);
						await docs.init(f.docsDir, "manual");
					} finally {
						await docs.close();
					}
				}
				return "Next page";
			});
			await f.run("/wiki");
			const output = f.output.join("\n");
			const section = expected.sections[0]!;
			expect(output).toContain(`sha256=${section.documentHash} · sectionId=${section.sectionId}`);
			expect(output).toContain(section.text);
			expect(output).not.toContain("replacement.md");
			expect(f.output.filter(value => value.startsWith("Section hits:"))).toHaveLength(1);
			expect(f.input).toHaveBeenCalledTimes(1);
			if (failure === "stale")
				expect(output).toContain("/wiki failed: Stale documentation search cursor: indexed snapshot has changed");
			else expect(output).not.toContain("/wiki failed:");
		}, 15_000);
	}

	test("wiki opens the selected snapshot but reports stale continuation instead of restarting", async () => {
		const f = await fixture();
		const expected = await importWikiEvidence(f, 25);
		f.input.mockResolvedValueOnce("mbist_check.rpt");
		f.select.mockResolvedValueOnce("Search document indexes");
		f.select.mockImplementationOnce(async (_title, options) => {
			const docs = new DocsService({ agentDir: f.agentDir, cwd: f.cwd });
			try {
				await docs.remove("manual");
				await fs.rm(f.docsDir, { recursive: true });
				await fs.mkdir(f.docsDir);
				await Bun.write(path.join(f.docsDir, "replacement.md"), "# Replacement\nmbist_check.rpt new snapshot\n");
				await docs.init(f.docsDir, "manual");
			} finally {
				await docs.close();
			}
			return getExtensionUISelectOptionLabel(options[0]!);
		});
		f.select.mockResolvedValueOnce("Next page");
		await f.run("/wiki");
		const output = f.output.join("\n");
		const section = expected.sections[0]!;
		expect(output).toContain(`sha256=${section.documentHash} · sectionId=${section.sectionId}`);
		expect(output).toContain(section.text);
		expect(output).toContain("/wiki failed: Stale documentation search cursor: indexed snapshot has changed");
		expect(output).not.toContain("replacement.md");
		expect(f.output.filter(value => value.startsWith("Section hits:"))).toHaveLength(1);
		expect(f.input).toHaveBeenCalledTimes(1);
	});

	test("wiki reports zero indexed matches as exhausted without opening an evidence dialog", async () => {
		const f = await fixture();
		await importWikiEvidence(f, 1);
		f.select.mockResolvedValueOnce("Search document indexes");
		f.input.mockResolvedValueOnce("zxqv_missing.noexist");
		await f.run("/wiki");
		expect(f.output.join("\n")).toContain("Section hits: 0 · showing 0-0");
		expect(f.output.join("\n")).toContain("未找到完整名称命中");
		expect(f.output.join("\n")).toContain("Results exhausted.");
		expect(f.output.join("\n")).not.toContain("/wiki failed:");
		expect(f.select).toHaveBeenCalledTimes(1);
	});

	test("wiki cannot advance a pending result page after its owning session changes", async () => {
		const f = await fixture();
		await importWikiEvidence(f, 21);
		f.select.mockResolvedValueOnce("Search document indexes");
		f.input.mockResolvedValueOnce("mbist_check.rpt");
		f.select.mockImplementationOnce(async (_title, options) => {
			expect(options.map(getExtensionUISelectOptionLabel)).toContain("Next page");
			f.session.sessionGeneration++;
			return "Next page";
		});
		await f.run("/wiki");
		expect(f.output.filter(value => value.startsWith("Section hits:"))).toHaveLength(1);
		expect(f.output.join("\n")).not.toContain("showing 21-21");
		expect(f.select).toHaveBeenCalledTimes(2);
	});

	test("wiki reports duplicate-name failure and keeps the original searchable index", async () => {
		const f = await fixture();
		const indexName = "PRIVATE_DUPLICATE_INDEX_TITLE";
		const docs = new DocsService({ agentDir: f.agentDir, cwd: f.cwd });
		try {
			await docs.init(f.docsDir, indexName);
		} finally {
			await docs.close();
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
				expect((await retained.list()).map(index => index.name)).toEqual([indexName]);
				expect((await retained.search("sensorbeacon")).sections).not.toHaveLength(0);
			} finally {
				await retained.close();
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
