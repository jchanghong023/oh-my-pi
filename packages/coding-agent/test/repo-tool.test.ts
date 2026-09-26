import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../src/config/settings";
import { RepoService } from "../src/repo/service";
import { createTools, type ToolSession } from "../src/tools";
import { RepoTool } from "../src/tools/repo";

const temporary: string[] = [];
afterEach(async () => {
	await Promise.all(temporary.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

async function fixture(files: Record<string, string> = {}) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-repo-tool-"));
	temporary.push(dir);
	const cwd = path.join(dir, "project");
	const agentDir = path.join(dir, "agent");
	await fs.mkdir(cwd);
	await fs.mkdir(agentDir);
	for (const [name, content] of Object.entries(files)) {
		const file = path.join(cwd, name);
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, content);
	}
	const settings = Settings.isolated({});
	const session = {
		cwd,
		hasUI: false,
		skipPythonPreflight: true,
		settings: Object.assign(settings, { getAgentDir: () => agentDir }),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	} as unknown as ToolSession;
	return { cwd, agentDir, session, tool: new RepoTool(session) };
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map(item => item.text ?? "").join("\n");
}

function execute(tool: RepoTool, params: unknown) {
	return tool.execute("repo-test", params as never);
}

async function build(cwd: string, agentDir: string): Promise<void> {
	const service = new RepoService({ cwd, agentDir });
	try {
		await service.build();
	} finally {
		service.close();
	}
}

describe("repository tool with a real SQLite index and native Python parser", () => {
	it("separates absent, no-hit, indexed content, definitions, and invalid input", async () => {
		const { cwd, agentDir, tool } = await fixture({
			"src/engine.py": "# café\r\ndef engine_timeout():\r\n    return 'ERR_TIMEOUT'\r\n",
		});
		const missing = await execute(tool, { action: "search", query: "ERR_TIMEOUT" });
		expect(missing.details).toMatchObject({ action: "search", queryStatus: "missing" });
		expect(missing.details?.status.exists).toBe(false);
		expect(missing.details).toMatchObject({ hits: [], truncated: false, fieldTruncations: {} });
		await build(cwd, agentDir);
		const nohit = await execute(tool, { action: "search", query: "NO_SUCH_IDENTIFIER" });
		expect(nohit.details).toMatchObject({ action: "search", queryStatus: "ok", hits: [] });
		expect(nohit.details).toMatchObject({ truncated: false, fieldTruncations: {} });
		expect(nohit.details).toMatchObject({ cursor: undefined });
		const search = await execute(tool, { action: "search", query: "ERR_TIMEOUT" });
		expect(search.details).toMatchObject({
			hits: [expect.objectContaining({ path: "src/engine.py", startLine: 3 })],
		});
		expect(resultText(search)).toContain("src/engine.py");
		expect(resultText(search)).toContain("ERR_TIMEOUT");
		const symbol = await execute(tool, { action: "symbol", query: "engine_timeout" });
		expect(symbol.details).toMatchObject({
			hits: [expect.objectContaining({ path: "src/engine.py", name: "engine_timeout", startLine: 2 })],
		});
		expect(resultText(symbol)).toContain("def engine_timeout");
		await expect(execute(tool, { action: "search" })).rejects.toThrow();
	});

	it("surfaces a damaged index as an error instead of reporting no matches", async () => {
		const { cwd, agentDir, tool } = await fixture({ "source.py": "def intact(): return 'STILL_HERE'\n" });
		const service = new RepoService({ cwd, agentDir });
		await service.build();
		const databasePath = service.storage.path;
		service.close();
		await fs.writeFile(databasePath, "not a SQLite database");
		await expect(execute(tool, { action: "search", query: "STILL_HERE" })).rejects.toThrow(/recover/i);
		expect(await fs.readFile(path.join(cwd, "source.py"), "utf8")).toContain("STILL_HERE");
	});

	it("bounds a page and rejects pagination after the index generation changes", async () => {
		const files = Object.fromEntries(
			Array.from({ length: 80 }, (_, index) => [
				`src/${String(index).padStart(2, "0")}.py`,
				`def page_${index}(): return 'PAGING_NEEDLE ${"padding ".repeat(160)}'\n`,
			]),
		);
		const { cwd, agentDir, tool } = await fixture(files);
		await build(cwd, agentDir);
		const first = await execute(tool, { action: "search", query: "PAGING_NEEDLE", limit: 50 });
		if (first.details?.action !== "search") throw new Error("Expected a search response");
		expect(first.details.hits).toHaveLength(50);
		expect(first.details.truncated).toBe(true);
		expect(first.details.cursor).toBeTruthy();
		expect(resultText(first).length).toBeLessThan(20_000);
		const second = await execute(tool, {
			action: "search",
			query: "PAGING_NEEDLE",
			limit: 50,
			cursor: first.details.cursor,
		});
		if (second.details?.action !== "search") throw new Error("Expected a search response");
		const firstPaths = first.details.hits.map(hit => hit.path);
		const secondPaths = second.details.hits.map(hit => hit.path);
		expect(new Set([...firstPaths, ...secondPaths]).size).toBe(80);
		const service = new RepoService({ cwd, agentDir });
		try {
			await fs.writeFile(path.join(cwd, "src/new.py"), "def fresh(): return 'PAGING_NEEDLE'\n");
			service.markChanged([path.join(cwd, "src/new.py")]);
			await service.search("PAGING_NEEDLE");
		} finally {
			service.close();
		}
		await expect(
			execute(tool, { action: "search", query: "PAGING_NEEDLE", cursor: first.details.cursor }),
		).rejects.toThrow();
	});

	it("bounds native megabyte signatures in details without losing symbol pages or source locations", async () => {
		const bigDefault = "x".repeat(950_000);
		const source = [
			`def wide_00(value="${bigDefault}"): return value`,
			...Array.from({ length: 51 }, (_, index) => `def wide_${String(index + 1).padStart(2, "0")}(): pass`),
			"",
		].join("\n");
		const { cwd, agentDir, tool } = await fixture({ "src/signatures.py": source });
		await build(cwd, agentDir);
		const first = await execute(tool, { action: "symbol", query: "wide_", limit: 50 });
		if (first.details?.action !== "symbol") throw new Error("Expected a symbol response");
		expect(first.details.hits).toHaveLength(50);
		expect(first.details.hits[0]).toMatchObject({
			path: "src/signatures.py",
			name: "wide_00",
			startLine: 1,
			endLine: 1,
		});
		expect(first.details.hits[0].signature).toEndWith("…");
		expect(first.details.hits[0].signature?.length).toBeLessThanOrEqual(160);
		expect(first.details.fieldTruncations["hits.signature"]).toBe(1);
		expect(resultText(first)).toContain("Fields truncated");
		expect(first.details.truncated).toBe(true);
		expect(first.details.cursor).toBeTruthy();
		expect(JSON.stringify(first).length).toBeLessThan(40_000);
		const second = await execute(tool, { action: "symbol", query: "wide_", limit: 50, cursor: first.details.cursor });
		if (second.details?.action !== "symbol") throw new Error("Expected a symbol response");
		expect(second.details.truncated).toBe(false);
		expect(second.details.cursor).toBeUndefined();
		expect(second.details.fieldTruncations).toEqual({});
		expect(new Set([...first.details.hits, ...second.details.hits].map(hit => hit.name)).size).toBe(52);
	});

	it("bounds and reports pathological status fields from the real database", async () => {
		const { cwd, agentDir, tool } = await fixture({ "src/healthy.py": "def healthy(): return 1\n" });
		await build(cwd, agentDir);
		const service = new RepoService({ cwd, agentDir });
		try {
			const generation = service.storage.state().generation;
			if (!generation) throw new Error("Expected an index generation");
			const longPath = `nested/${"p".repeat(1_000)}`;
			service.storage.markChanged(Array.from({ length: 50 }, (_, index) => `${index}_${longPath}`));
			for (let index = 0; index < 50; index++)
				service.storage.putFailure(
					{ path: `${index}_${longPath}`, kind: "unreadable", message: `error ${"m".repeat(1_000)}` },
					generation,
				);
			for (let index = 0; index < 20; index++) service.storage.markUncertain(`${index}_${"u".repeat(1_000)}`);
		} finally {
			service.close();
		}
		const status = await execute(tool, { action: "status" });
		if (status.details?.action !== "status") throw new Error("Expected a status response");
		expect(status.details.status.pendingCount).toBe(50);
		expect(status.details.status.pendingPaths).toHaveLength(20);
		expect(status.details.status.pendingTruncated).toBe(true);
		expect(status.details.status.failureCount).toBe(50);
		expect(status.details.status.failures).toHaveLength(20);
		expect(status.details.status.failuresTruncated).toBe(true);
		expect(status.details.status.uncertainCount).toBe(20);
		expect(status.details.status.uncertainReasons).toHaveLength(10);
		expect(status.details.status.uncertaintyTruncated).toBe(true);
		expect(status.details.status.pendingPaths[0]).toEndWith("…");
		expect(status.details.status.failures[0].message).toEndWith("…");
		expect(status.details.fieldTruncations).toMatchObject({
			"status.pendingPaths": 20,
			"status.failures.path": 20,
			"status.failures.message": 20,
			"status.uncertainReasons": 10,
		});
		expect(resultText(status)).toContain("Fields truncated");
		expect(JSON.stringify(status).length).toBeLessThan(30_000);
	});

	it("preserves ordinary locators and explicitly identifies clipped paths and roots", async () => {
		const { cwd, agentDir, session, tool } = await fixture();
		const longRoot = path.join(cwd, ...Array.from({ length: 3 }, () => "r".repeat(90)));
		const longPath = `${"p".repeat(100)}/${"q".repeat(100)}/target.py`;
		await fs.mkdir(path.dirname(path.join(longRoot, longPath)), { recursive: true });
		await fs.writeFile(path.join(longRoot, longPath), "def locator_example(): pass\n");
		await fs.writeFile(path.join(longRoot, "ordinary.py"), "def ordinary_locator(): pass\n");
		Object.assign(session, { cwd: longRoot });
		await build(longRoot, agentDir);
		const symbol = await execute(tool, { action: "symbol", query: "locator_example" });
		if (symbol.details?.action !== "symbol") throw new Error("Expected a symbol response");
		expect(symbol.details.hits).toHaveLength(1);
		expect(symbol.details.hits[0].path).toEndWith("…");
		expect(symbol.details.hits[0].startLine).toBe(1);
		expect(symbol.details.fieldTruncations).toMatchObject({ "hits.path": 1, "status.root": 1 });
		expect(symbol.details.status.root).toEndWith("…");
		expect(resultText(symbol)).toContain("paths may not be usable as locators");
		expect(JSON.stringify(symbol).length).toBeLessThan(10_000);
		const ordinary = await execute(tool, { action: "symbol", query: "ordinary_locator" });
		if (ordinary.details?.action !== "symbol") throw new Error("Expected an ordinary symbol response");
		expect(ordinary.details.hits).toMatchObject([{ path: "ordinary.py", startLine: 1 }]);
		expect(ordinary.details.fieldTruncations["hits.path"]).toBeUndefined();
	});

	it("grants read-only repo in unrestricted sessions without widening restricted permissions", async () => {
		const { session } = await fixture();
		const defaultTools = await createTools(session);
		const readTools = await createTools(session, ["read"]);
		const restricted = { ...session, restrictToolNames: true } as ToolSession;
		const restrictedRead = await createTools(restricted, ["read"]);
		const explicit = await createTools(restricted, ["repo"]);
		expect(defaultTools.find(tool => tool.name === "repo")?.loadMode).toBe("essential");
		expect(readTools.map(tool => tool.name)).toContain("repo");
		expect(restrictedRead.map(tool => tool.name)).not.toContain("repo");
		expect(explicit.map(tool => tool.name)).toContain("repo");
	});
});
