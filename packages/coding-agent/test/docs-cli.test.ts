import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { acquireFileLock } from "@oh-my-pi/pi-utils/file-lock";
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

		const removeCode = await runDocsCommand({ action: "remove", target: "manual", json: true, cwd }, dependencies);
		expect(removeCode).toBe(0);
		expect(JSON.parse(stdout.pop() as string)).toEqual({ removed: "manual" });
		await expect(
			runDocsCommand({ action: "remove", target: "manual", json: true, cwd }, dependencies),
		).rejects.toThrow("Unknown document index");
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
		expect(JSON.parse(output[0] as string)).toEqual({ state: "cancelled", error: "Document indexing cancelled" });
	});

	it("returns 130 when cancelled while waiting for the import lock", async () => {
		const cwd = await tempDir("docs-cli-lock-root-");
		const agentDir = await tempDir("docs-cli-lock-agent-");
		await fs.writeFile(path.join(cwd, "guide.md"), "# Guide\nText\n");
		const lease = await acquireFileLock(path.join(agentDir, "docs.db"));
		try {
			const controller = new AbortController();
			setTimeout(() => controller.abort(), 20);
			const output: string[] = [];
			const code = await runDocsCommand(
				{ action: "init", target: ".", name: "cancelled", json: true, cwd, signal: controller.signal },
				{
					createService: async serviceCwd => new DocsService({ agentDir, cwd: serviceCwd }),
					stdout: text => output.push(text),
				},
			);
			expect(code).toBe(130);
			expect(JSON.parse(output[0] as string)).toEqual({ state: "cancelled", error: "Document indexing cancelled" });
		} finally {
			lease.release();
		}
	});
});
