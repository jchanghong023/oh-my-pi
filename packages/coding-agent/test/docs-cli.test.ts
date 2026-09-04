import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
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
	it("routes init/list/status/reinit/remove, emits JSON, and defaults to FTS", async () => {
		const cwd = await tempDir("docs-cli-root-");
		const agentDir = await tempDir("docs-cli-agent-");
		await fs.writeFile(path.join(cwd, "guide.md"), "# Guide\nText for indexing\n");
		const stdout: string[] = [];
		const stderr: string[] = [];
		const calls: boolean[] = [];
		const dependencies = {
			createService: async (serviceCwd: string, needsModel: boolean) => {
				calls.push(needsModel);
				return new DocsService({ agentDir, cwd: serviceCwd, extractor: null });
			},
			stdout: (text: string) => stdout.push(text),
			stderr: (text: string) => stderr.push(text),
		};

		const initCode = await runDocsCommand(
			{ action: "init", target: ".", name: "manual", json: true, cwd },
			dependencies,
		);
		expect(initCode).toBe(0);
		const initValue = JSON.parse(stdout.pop() as string) as { index: { name: string; state: string; mode: string } };
		expect(initValue.index).toMatchObject({ name: "manual", state: "ready", mode: "fts" });
		expect(stderr).toEqual([]);

		const listCode = await runDocsCommand({ action: "list", json: true, cwd }, dependencies);
		expect(listCode).toBe(0);
		expect(JSON.parse(stdout.pop() as string)).toHaveLength(1);
		const statusCode = await runDocsCommand({ action: "status", target: "manual", json: true, cwd }, dependencies);
		expect(statusCode).toBe(0);
		expect(JSON.parse(stdout.pop() as string).name).toBe("manual");

		const reinitCode = await runDocsCommand({ action: "reinit", target: "manual", cwd }, dependencies);
		expect(reinitCode).toBe(0);
		expect(stderr.some(line => line.startsWith("scan "))).toBe(true);
		expect(stdout.pop()).toContain('"state":"ready"');

		const removeCode = await runDocsCommand({ action: "remove", target: "manual", json: true, cwd }, dependencies);
		expect(removeCode).toBe(0);
		expect(JSON.parse(stdout.pop() as string)).toEqual({ removed: "manual" });
		expect(calls).toEqual([false, false, false, true, false]);
	});

	it("sanitizes control sequences in progress paths before writing to the terminal", async () => {
		const cwd = await tempDir("docs-cli-controls-root-");
		const agentDir = await tempDir("docs-cli-controls-agent-");
		const attack = "\x1b]0;OSC\x07\x1b[31mCSI\x1b[0m\rFORGED\tTAB\u0085";
		await fs.writeFile(path.join(cwd, `guide-${attack}.md`), "# Guide\nText\n");
		const stdout: string[] = [];
		const stderr: string[] = [];
		const code = await runDocsCommand(
			{ action: "init", target: ".", name: "controls", cwd },
			{
				createService: async serviceCwd => new DocsService({ agentDir, cwd: serviceCwd, extractor: null }),
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
	});

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
				createService: async serviceCwd => new DocsService({ agentDir, cwd: serviceCwd, extractor: null }),
				stdout: text => output.push(text),
			},
		);
		expect(code).toBe(130);
		expect(JSON.parse(output[0] as string)).toEqual({ state: "cancelled", error: "Document indexing cancelled" });
	});
});
