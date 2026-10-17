import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FileLock, wikiImportLeasePath } from "@oh-my-pi/pi-natives";
import { runDocsCommand } from "../src/cli/docs-cli";
import { DocsService } from "../src/docs/service";

const tempDirs: string[] = [];
async function tempDir(prefix: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("runDocsCommand", () => {
	it("sanitizes a user-supplied root in a top-level CLI error", async () => {
		const cwd = await tempDir("docs-cli-error-root-");
		const agentDir = await tempDir("docs-cli-error-agent-");
		const target = path.join(cwd, `missing-\x1b[31mFORGED\x1b[0m`);
		const child = Bun.spawn(
			[process.execPath, path.join(import.meta.dir, "../src/cli.ts"), "docs", "init", target, "--name", "bad-root"],
			{
				env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const stderr = await new Response(child.stderr).text();
		expect(await child.exited).toBe(1);
		expect(stderr).toContain("Markdown root is not a directory");
		expect(stderr).not.toContain("\x1b");
		expect(stderr).toContain("FORGED");
	}, 30_000);

	it("keeps a newline-bearing root on one CLI diagnostic line", async () => {
		const cwd = await tempDir("docs-cli-newline-root-");
		const agentDir = await tempDir("docs-cli-newline-agent-");
		const target = path.join(cwd, "missing-\nFORGED");
		const child = Bun.spawn(
			[process.execPath, path.join(import.meta.dir, "../src/cli.ts"), "docs", "init", target, "--name", "bad-root"],
			{
				env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const stderr = await new Response(child.stderr).text();
		expect(await child.exited).toBe(1);
		expect(stderr).toContain("Markdown root is not a directory");
		expect(stderr).not.toContain("\nFORGED");
		expect(stderr).toContain("FORGED");
	});

	it("imports and removes a stored index through JSON output", async () => {
		const cwd = await tempDir("docs-cli-root-");
		const agentDir = await tempDir("docs-cli-agent-");
		await fs.writeFile(path.join(cwd, "guide.md"), "# Guide\nText for indexing\n");
		const stdout: string[] = [];
		const stderr: string[] = [];
		const dependencies = {
			createService: async (serviceCwd: string) => new DocsService({ agentDir, cwd: serviceCwd }),
			stdout: (text: string) => stdout.push(text),
			stderr: (text: string) => stderr.push(text),
		};

		const initCode = await runDocsCommand(
			{ action: "init", target: ".", name: "manual", json: true, cwd },
			dependencies,
		);
		expect(initCode).toBe(0);
		const initValue = JSON.parse(stdout.pop() as string);
		expect(initValue.index).toMatchObject({ name: "manual", documentCount: 1 });
		expect(stderr).toEqual([]);

		const observer = new DocsService({ agentDir, cwd });
		try {
			expect((await observer.list()).map(index => index.name)).toEqual(["manual"]);
			await fs.rm(path.join(cwd, "guide.md"));
			const stored = await observer.search("indexing");
			expect(stored.sections).toHaveLength(1);
			expect(stored.sections[0]).toMatchObject({ index: "manual", path: "guide.md", lineStart: 1, lineEnd: 2 });
			expect(stored.sections[0]!.text).toContain("Text for indexing");
		} finally {
			await observer.close();
		}

		const removeCode = await runDocsCommand({ action: "remove", target: "manual", json: true, cwd }, dependencies);
		expect(removeCode).toBe(0);
		expect(JSON.parse(stdout.pop() as string)).toEqual({ removed: "manual" });
		await expect(
			runDocsCommand({ action: "remove", target: "manual", json: true, cwd }, dependencies),
		).rejects.toThrow("Unknown document index");
		const removed = new DocsService({ agentDir, cwd });
		try {
			expect(await removed.list()).toEqual([]);
		} finally {
			await removed.close();
		}
	});

	// Windows filenames cannot contain control characters (\r, \t, ESC…), so the
	// attack-path fixture cannot be created there; the sanitization surface is POSIX-only.
	it.skipIf(process.platform === "win32")(
		"sanitizes control sequences in progress paths before writing to the terminal",
		async () => {
			const cwd = await tempDir("docs-cli-controls-root-");
			const agentDir = await tempDir("docs-cli-controls-agent-");
			const attack = "\x1b]0;OSC\x07\x1b[31mCSI\x1b[0m\rFORGED\tTAB\u0085";
			await fs.writeFile(path.join(cwd, `guide-${attack}.md`), "# Guide\nText\n");
			const stdout: string[] = [];
			const stderr: string[] = [];
			const code = await runDocsCommand(
				{ action: "init", target: ".", name: "controls", cwd },
				{
					createService: async serviceCwd => new DocsService({ agentDir, cwd: serviceCwd }),
					stdout: text => stdout.push(text),
					stderr: text => stderr.push(text),
				},
			);
			expect(code).toBe(0);
			const terminalOutput = `${stdout.join("")}${stderr.join("")}`;
			expect(terminalOutput).not.toContain("\x1b");
			expect(terminalOutput).not.toContain("\r");
			expect(terminalOutput).not.toContain("\t");
			expect(terminalOutput).not.toContain("\u0085");
			expect(terminalOutput).not.toContain("\nFORGED");
		},
	);

	it("returns 130 and JSON cancelled output for an aborted initialization", async () => {
		const cwd = await tempDir("docs-cli-abort-root-");
		const agentDir = await tempDir("docs-cli-abort-agent-");
		await fs.writeFile(path.join(cwd, "guide.md"), "# Guide\nText\n");
		const controller = new AbortController();
		controller.abort();
		const output: string[] = [];
		const code = await runDocsCommand(
			{ action: "init", target: ".", name: "cancelled", json: true, cwd, signal: controller.signal },
			{
				createService: async serviceCwd => new DocsService({ agentDir, cwd: serviceCwd }),
				stdout: text => output.push(text),
			},
		);
		expect(code).toBe(130);
		expect(output).toHaveLength(1);
		expect(JSON.parse(output[0]!)).toEqual({ state: "cancelled", error: expect.stringMatching(/\S/) });
		const observer = new DocsService({ agentDir, cwd });
		try {
			expect(await observer.list()).toEqual([]);
		} finally {
			await observer.close();
		}
	});

	it("returns 130 when cancelled while waiting for the import lock", async () => {
		const cwd = await tempDir("docs-cli-lock-root-");
		const agentDir = await tempDir("docs-cli-lock-agent-");
		await fs.writeFile(path.join(cwd, "guide.md"), "# Guide\nText\n");
		const seed = new DocsService({ agentDir, cwd });
		try {
			await seed.init(".", "manual");
		} finally {
			await seed.close();
		}
		await fs.writeFile(path.join(cwd, "guide.md"), "# Replacement\nUncommitted replacement evidence\n");
		const lease = FileLock.tryAcquire(wikiImportLeasePath(path.join(agentDir, "docs.db")));
		const blocked = new DocsService({ agentDir, cwd });
		let timer: NodeJS.Timeout | undefined;
		try {
			expect(lease.acquired).toBe(true);
			await blocked.list();
			const controller = new AbortController();
			// Exercise real subprocess cancellation while an OS-backed import lease is held.
			// Fake timers cannot drive the worker's file-lock wait.
			timer = setTimeout(() => controller.abort(), 20);
			const output: string[] = [];
			const code = await runDocsCommand(
				{ action: "init", target: ".", name: "cancelled", json: true, cwd, signal: controller.signal },
				{
					createService: async () => blocked,
					stdout: text => output.push(text),
				},
			);
			expect(code).toBe(130);
			expect(output).toHaveLength(1);
			expect(JSON.parse(output[0]!)).toEqual({ state: "cancelled", error: expect.stringMatching(/\S/) });
			const observer = new DocsService({ agentDir, cwd });
			try {
				expect((await observer.list()).map(index => index.name)).toEqual(["manual"]);
				const original = await observer.search("Text");
				expect(original.sections).toHaveLength(1);
				expect(original.sections[0]!.text).toContain("Text");
				expect((await observer.search("replacement")).sections).toEqual([]);
			} finally {
				await observer.close();
			}
		} finally {
			if (timer !== undefined) clearTimeout(timer);
			await blocked.close();
			lease.release();
		}
	});

	it("does not report success or remove stored evidence when removal is cancelled", async () => {
		const cwd = await tempDir("docs-cli-remove-abort-root-");
		const agentDir = await tempDir("docs-cli-remove-abort-agent-");
		await fs.writeFile(path.join(cwd, "guide.md"), "# Guide\nOriginal stored evidence\n");
		const observer = new DocsService({ agentDir, cwd });
		try {
			await observer.init(".", "manual");
			const controller = new AbortController();
			controller.abort();
			const output: string[] = [];
			const code = await runDocsCommand(
				{ action: "remove", target: "manual", json: true, cwd, signal: controller.signal },
				{
					createService: async serviceCwd => new DocsService({ agentDir, cwd: serviceCwd }),
					stdout: value => output.push(value),
				},
			);
			expect(code).toBe(130);
			expect(output).toHaveLength(1);
			expect(JSON.parse(output[0]!)).toMatchObject({ state: "cancelled", error: expect.stringMatching(/\S/) });
			expect(output.join("")).not.toContain('"removed"');
			expect((await observer.list()).map(index => index.name)).toEqual(["manual"]);
			expect((await observer.search("Original")).sections[0]!.text).toContain("Original stored evidence");
		} finally {
			await observer.close();
		}
	});
});
