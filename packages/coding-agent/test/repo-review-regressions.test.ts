import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { validateToolArguments } from "@oh-my-pi/pi-ai";
import type { TUI } from "@oh-my-pi/pi-tui";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { Settings } from "../src/config/settings";
import { RepoHubComponent } from "../src/modes/components/repo-hub";
import { RepoLifecycle } from "../src/repo/lifecycle";
import { RepoService } from "../src/repo/service";
import { type ToolSession } from "../src/tools";
import { invalidateFsScanAfterDelete, invalidateFsScanAfterWrite } from "../src/tools/fs-cache-invalidation";
import { RepoTool } from "../src/tools/repo";

const temporary: string[] = [];

beforeAll(async () => {
	await initTheme();
});

afterEach(async () => {
	await Promise.all(temporary.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

// Keep the real SQLite/native-parser fixture and tool invocation used by repo-tool.test.ts.
async function fixture(files: Record<string, string> = {}) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-repo-review-"));
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
	const settings = Object.assign(Settings.isolated({}), { getAgentDir: () => agentDir });
	const session = {
		cwd,
		hasUI: false,
		skipPythonPreflight: true,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
	} as unknown as ToolSession;
	return { dir, cwd, agentDir, settings, tool: new RepoTool(session) };
}

async function execute(tool: RepoTool, params: Record<string, unknown>) {
	return tool.execute(
		"repo-review",
		validateToolArguments(tool, { type: "toolCall", id: "repo-review", name: "repo", arguments: params }) as never,
	);
}

describe("repository review regressions", () => {
	it("P2-6 displays an index-parent creation failure and allows retry in the same panel", async () => {
		const { cwd, agentDir, settings, tool } = await fixture({ "engine.py": "def retry_target(): pass\n" });
		const failed = Promise.withResolvers<void>();
		const built = Promise.withResolvers<void>();
		const closed = Promise.withResolvers<void>();
		const tui = { requestRender() {} } as unknown as TUI;
		const hub = await RepoHubComponent.create(tui, cwd, settings, { onCancel: closed.resolve });
		tui.requestRender = () => {
			const rendered = hub.render(10_000).join("\n");
			if (/(?:EEXIST|ENOTDIR)/.test(rendered)) failed.resolve();
			if (rendered.includes("Files: 1")) built.resolve();
		};
		const parent = path.join(agentDir, "repo");
		try {
			hub.handleInput("b");
			// A file at the required parent fails mkdir on all platforms, even as root.
			// Install it after opening/confirming so initial panel creation is unaffected.
			await fs.writeFile(parent, "index parent is temporarily unavailable");
			expect(() => hub.handleInput("y")).not.toThrow();
			await failed.promise;
			expect(hub.render(10_000).join("\n")).toContain(parent);
			expect(await fs.readFile(parent, "utf8")).toBe("index parent is temporarily unavailable");

			await fs.unlink(parent);
			hub.handleInput("b");
			expect(hub.render(10_000).join("\n")).toContain("Build repository index for");
			hub.handleInput("y");
			await built.promise;
			expect(hub.render(10_000).join("\n")).not.toMatch(/EEXIST|ENOTDIR/);
			expect((await execute(tool, { action: "symbol", query: "retry_target" })).details).toMatchObject({
				hits: [{ path: "engine.py", name: "retry_target" }],
			});
		} finally {
			hub.handleInput("\x1b");
			hub.handleInput("y");
			await closed.promise;
			hub.dispose();
		}
	});

	it("P2-7 refreshes canonical-root queries after root-alias write and deleted-parent notifications without indexing subtree links", async () => {
		const { dir, cwd, agentDir, tool } = await fixture({
			"engine.py": "def before_alias_write(): return 'staleorchard'\n",
			"nested/gone.py": "def deleted_alias_target(): return 'vanishedcanyon'\n",
		});
		const alias = path.join(dir, "project-alias");
		const outside = path.join(dir, "outside");
		await fs.mkdir(outside);
		await fs.writeFile(path.join(outside, "escape.py"), "def outside_link_target(): return 'externalglacier'\n");
		const linkType = process.platform === "win32" ? "junction" : "dir";
		await fs.symlink(cwd, alias, linkType);
		await fs.symlink(outside, path.join(cwd, "external"), linkType);
		await fs.symlink(path.join(cwd, "nested"), path.join(cwd, "mirror"), linkType);
		const service = new RepoService({ cwd, agentDir });
		const lifecycle = new RepoLifecycle({ agentDir, getCwd: () => alias });
		try {
			// Subscribe before publishing, avoiding unrelated session-start Git discovery.
			lifecycle.start();
			await service.build();
			expect(await service.status()).toMatchObject({ fileCount: 2, pendingCount: 0, unchecked: false });
			expect((await execute(tool, { query: "vanishedcanyon" })).details).toMatchObject({
				hits: [{ path: "nested/gone.py" }],
			});

			const linkedOutside = path.join(alias, "external/escape.py");
			await fs.writeFile(linkedOutside, "def outside_link_changed(): return 'unindexedvolcano'\n");
			invalidateFsScanAfterWrite(linkedOutside);
			invalidateFsScanAfterWrite(path.join(alias, "mirror/gone.py"));
			expect((await execute(tool, { query: "unindexedvolcano" })).details).toMatchObject({ hits: [] });
			expect((await execute(tool, { action: "symbol", query: "outside_link" })).details).toMatchObject({ hits: [] });
			expect((await execute(tool, { query: "vanishedcanyon" })).details).toMatchObject({
				hits: [{ path: "nested/gone.py" }],
			});
			expect((await service.status()).fileCount).toBe(2);

			const written = path.join(alias, "engine.py");
			await fs.writeFile(written, "def after_alias_write(): return 'freshmeadow'\n");
			invalidateFsScanAfterWrite(written);
			expect((await execute(tool, { query: "freshmeadow" })).details).toMatchObject({
				hits: [{ path: "engine.py", snippet: "def after_alias_write(): return 'freshmeadow'" }],
			});
			expect((await execute(tool, { action: "symbol", query: "after_alias_write" })).details).toMatchObject({
				hits: [{ path: "engine.py", name: "after_alias_write" }],
			});
			expect((await execute(tool, { query: "staleorchard" })).details).toMatchObject({ hits: [] });
			expect((await execute(tool, { action: "symbol", query: "before_alias_write" })).details).toMatchObject({
				hits: [],
			});

			// Neither the leaf nor its immediate parent exists when the delete hint arrives.
			const deleted = path.join(alias, "nested/gone.py");
			await fs.rm(path.join(alias, "nested"), { recursive: true });
			invalidateFsScanAfterDelete(deleted);
			expect((await execute(tool, { action: "symbol", query: "deleted_alias_target" })).details).toMatchObject({
				hits: [],
			});
			expect((await execute(tool, { query: "vanishedcanyon" })).details).toMatchObject({ hits: [] });
			expect(await service.status()).toMatchObject({ fileCount: 1, pendingCount: 0 });
			expect(await fs.readFile(path.join(cwd, "engine.py"), "utf8")).toContain("freshmeadow");
			expect(await fs.readFile(path.join(outside, "escape.py"), "utf8")).toContain("unindexedvolcano");
		} finally {
			lifecycle.dispose();
			service.close();
		}
	});

	for (const action of ["search", "symbol"] as const) {
		for (const filter of [
			"../outside",
			"src/../../outside",
			"/absolute",
			"C:\\absolute",
			"C:relative",
			"..\\outside",
		]) {
			it(`P2-8 rejects unindexed ${action} path ${JSON.stringify(filter)} without creating storage`, async () => {
				const { agentDir, tool } = await fixture({ "engine.py": "def untouched(): pass\n" });
				try {
					await expect(execute(tool, { action, query: "untouched", path: filter })).rejects.toThrow(
						/Repository path must/,
					);
				} finally {
					// Check this even on the pre-fix accepted-input failure path.
					expect(await fs.readdir(agentDir)).toEqual([]);
				}
			});
		}
	}
});
