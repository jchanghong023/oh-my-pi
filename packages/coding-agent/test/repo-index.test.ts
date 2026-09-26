import { $ } from "bun";
import { afterEach, describe, expect, it } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RepoService } from "../src/repo/service";
import type { RepoQueryResult, RepoTextHit } from "../src/repo/types";

const dirs: string[] = [];
const services: RepoService[] = [];

async function fixture(files: Record<string, string> = {}) {
	const temp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-repo-index-test-"));
	dirs.push(temp);
	const root = path.join(temp, "project");
	const agentDir = path.join(temp, "profile");
	await fs.mkdir(root);
	await fs.mkdir(agentDir);
	for (const [name, body] of Object.entries(files)) {
		await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
		await Bun.write(path.join(root, name), body);
	}
	const service = new RepoService({ cwd: root, agentDir });
	services.push(service);
	return { temp, root, agentDir, service };
}

async function put(root: string, name: string, body: string) {
	await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
	await Bun.write(path.join(root, name), body);
}

async function paths(service: RepoService, query: string, page: RepoQueryResult<RepoTextHit>): Promise<string[]> {
	const found = page.hits.map(hit => hit.path);
	let cursor = page.cursor;
	while (cursor) {
		const next = await service.search(query, { limit: 3, cursor });
		found.push(...next.hits.map(hit => hit.path));
		cursor = next.cursor;
	}
	return found;
}

afterEach(async () => {
	for (const service of services.splice(0)) service.close();
	await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("repository index with real SQLite and native Python parsing", () => {
	it("distinguishes missing index, no matches, and indexed hits with exact source lines", async () => {
		const { service } = await fixture({
			"src/engine.py": "# café\r\nERR_TIMEOUT = '超时\u{1f680}'\r\nvalue = ERR_TIMEOUT\r\n",
		});
		const missing = await service.search("ERR_TIMEOUT");
		expect(missing.status).toBe("missing");
		expect(missing.hits).toEqual([]);
		expect((await service.status()).exists).toBe(false);
		await service.build();
		const exact = await service.search("ERR_TIMEOUT");
		expect(exact.status).toBe("ok");
		expect(
			exact.hits.some(
				hit => hit.path === "src/engine.py" && hit.startLine === 2 && hit.snippet.includes("ERR_TIMEOUT"),
			),
		).toBe(true);
		expect((await service.search("TIMEOUT")).hits.some(hit => hit.path === "src/engine.py")).toBe(true);
		expect((await service.search("超时")).hits.some(hit => hit.path === "src/engine.py" && hit.startLine === 2)).toBe(
			true,
		);
		expect((await service.search("zz-not-present")).hits).toEqual([]);
	});

	it("locates snippets in original source after Unicode case folding changes string length", async () => {
		const { service } = await fixture({
			"src/unicode.py": `${"İ".repeat(120)}\r\nsuffix_needle = 1\r\n`,
		});
		await service.build();
		const page = await service.search("SUFFIX_NEEDLE");
		expect(page.hits).toEqual([
			expect.objectContaining({
				path: "src/unicode.py",
				startLine: 2,
				endLine: 2,
				snippet: "suffix_needle = 1",
			}),
		]);
	});

	it("ranks literal identifiers ahead of split-token recall and handles case, short, Chinese and quoted punctuation", async () => {
		const { service } = await fixture({
			"src/exact.py": "ERR_TIMEOUT = '失败:重试'\n",
			"src/split.py": "ERR = 'TIMEOUT while processing'\n",
			"src/other.py": "print('retry stage')\n",
		});
		await service.build();
		const exact = await service.search("ERR_TIMEOUT");
		expect(exact.hits[0]?.path).toBe("src/exact.py");
		expect((await service.search("err_timeout")).hits.some(hit => hit.path === "src/exact.py")).toBe(true);
		expect((await service.search("TIMEOUT")).hits.some(hit => hit.path === "src/exact.py")).toBe(true);
		expect((await service.search("ER")).hits.some(hit => hit.path === "src/exact.py")).toBe(true);
		expect((await service.search("失败")).hits.some(hit => hit.path === "src/exact.py")).toBe(true);
		expect((await service.search("失败:重试")).hits.some(hit => hit.path === "src/exact.py")).toBe(true);
		expect((await service.search("'失败:重试'")).hits.some(hit => hit.path === "src/exact.py")).toBe(true);
		expect((await service.search("x' OR 1=1 --")).hits).toEqual([]);
	});

	it("uses JavaScript Unicode lowercase for short text and symbol candidates without moving source coordinates", async () => {
		const { service } = await fixture({
			"src/accent.txt": "É\n",
			"src/turkish.txt": "İ\r\nmatch on second line\r\n",
			"src/symbols.py": "def Café():\n    return 1\n",
			"src/nested.py": "class Té:\n    def Café(self):\n        return 1\n",
			"src/other.py": "def plain():\n    return 1\n",
		});
		await service.build();
		expect((await service.search("é", { path: "src/accent.txt" })).hits).toEqual([
			expect.objectContaining({ path: "src/accent.txt", startLine: 1, snippet: "É" }),
		]);
		expect((await service.search("é", { path: "src/symbols.py" })).hits).toEqual([
			expect.objectContaining({ path: "src/symbols.py", startLine: 1, snippet: "def Café():" }),
		]);
		expect((await service.search("i\u0307")).hits).toEqual([
			expect.objectContaining({ path: "src/turkish.txt", startLine: 1, snippet: "İ" }),
		]);
		expect((await service.symbol("CAFÉ", { path: "src/symbols.py" })).hits).toEqual([
			expect.objectContaining({ path: "src/symbols.py", name: "Café", startLine: 1 }),
		]);
		expect((await service.symbol("TÉ.CAFÉ", { path: "src/nested.py" })).hits).toEqual([
			expect.objectContaining({ path: "src/nested.py", qualname: "Té.Café", startLine: 2 }),
		]);
		expect((await service.symbol("caf_")).hits).toEqual([]);
	});

	it("filters by path and category without conflating tests, config and source", async () => {
		const { service } = await fixture({
			"src/core.py": "FILTER_NEEDLE = 1\n",
			"tests/test_core.py": "FILTER_NEEDLE = 2\n",
			"config/app.toml": "key = 'FILTER_NEEDLE'\n",
			"notes.txt": "FILTER_NEEDLE\n",
		});
		await service.build();
		const all = await service.search("FILTER_NEEDLE");
		expect(new Set(all.hits.map(hit => hit.path))).toEqual(
			new Set(["src/core.py", "tests/test_core.py", "config/app.toml", "notes.txt"]),
		);
		expect((await service.search("FILTER_NEEDLE", { category: "source" })).hits.map(hit => hit.path)).toEqual([
			"src/core.py",
		]);
		expect((await service.search("FILTER_NEEDLE", { category: "test" })).hits.map(hit => hit.path)).toEqual([
			"tests/test_core.py",
		]);
		expect((await service.search("FILTER_NEEDLE", { category: "config" })).hits.map(hit => hit.path)).toEqual([
			"config/app.toml",
		]);
		expect((await service.search("FILTER_NEEDLE", { path: "src/" })).hits.map(hit => hit.path)).toEqual([
			"src/core.py",
		]);
	});

	it("returns bounded deterministic pages without loss and rejects cursors from earlier generations", async () => {
		const files = Object.fromEntries(
			Array.from({ length: 12 }, (_, i) => [
				`src/m${String(i).padStart(2, "0")}.py`,
				`# shared-pagination-needle ${i}\n${"padding ".repeat(1_000)}\n`,
			]),
		);
		const { root, service } = await fixture(files);
		await service.build();
		const query = "shared-pagination-needle";
		const first = await service.search(query, { limit: 3 });
		expect(first.cursor).toBeDefined();
		expect(first.truncated).toBe(true);
		const firstAgain = await service.search(query, { limit: 3 });
		expect(firstAgain.hits).toEqual(first.hits);
		const all = await paths(service, query, first);
		expect(all).toHaveLength(12);
		expect(new Set(all).size).toBe(12);
		expect(first.hits.every(hit => hit.snippet.length < 2_000)).toBe(true);
		await expect(service.search(query, { cursor: "not-base64-json" })).rejects.toThrow();
		await expect(service.search("another-query", { cursor: first.cursor })).rejects.toThrow();
		await put(root, "src/new.py", "# shared-pagination-needle\n");
		service.markChanged([path.join(root, "src/new.py")]);
		await service.search("shared-pagination-needle");
		await expect(service.search("shared-pagination-needle", { cursor: first.cursor })).rejects.toThrow();
	});

	it("indexes Python module, decorated and async declarations, nested scopes, same names and CRLF line locations", async () => {
		const { service } = await fixture({
			"pkg/módulo.py": [
				"# café",
				"@decorate",
				"class Widget:",
				"    @wrap(1)",
				"    async def run(",
				"        self, payload",
				"    ):",
				"        def nested():",
				"            return payload",
				"        return nested()",
				"def run():",
				"    return 1",
				"def run():",
				"    return 2",
				"",
			].join("\r\n"),
		});
		await service.build();
		const widget = await service.symbol("Widget");
		expect(widget.hits.some(hit => hit.kind === "class" && hit.name === "Widget" && hit.startLine === 2)).toBe(true);
		const runs = (await service.symbol("run")).hits;
		expect((await service.symbol("RUN")).hits).toEqual(runs);
		const page = await service.symbol("run", { limit: 1 });
		const paged = [...page.hits];
		let cursor = page.cursor;
		while (cursor) {
			const next = await service.symbol("run", { limit: 1, cursor });
			paged.push(...next.hits);
			cursor = next.cursor;
		}
		expect(paged).toEqual(runs);
		expect(runs.slice(0, 3).map(hit => hit.name)).toEqual(["run", "run", "run"]);
		expect(runs[3]?.name).toBe("nested");
		expect(new Set(runs.slice(0, 3).map(hit => `${hit.qualname}:${hit.startLine}`)).size).toBe(3);
		expect(runs[3]?.qualname).toContain("Widget.run.nested");
		expect(
			runs
				.filter(hit => hit.name === "run" && hit.kind === "function")
				.map(hit => hit.startLine)
				.sort((a, b) => a - b),
		).toEqual([11, 13]);
		expect(
			runs.some(
				hit =>
					hit.kind === "method" &&
					hit.qualname.includes("Widget.run") &&
					hit.startLine === 4 &&
					hit.signature?.includes("payload"),
			),
		).toBe(true);
		expect(
			(await service.symbol("nested")).hits.some(
				hit => hit.qualname.includes("Widget.run.nested") && hit.startLine === 8,
			),
		).toBe(true);
		expect(
			(await service.symbol("módulo")).hits.some(hit => hit.kind === "module" && hit.path === "pkg/módulo.py"),
		).toBe(true);
	});

	it("keeps searchable malformed Python text, reports parse failure, and drops obsolete definitions", async () => {
		const { root, service } = await fixture({ "src/service.py": "def valid():\n    return 'before'\n" });
		await service.build();
		expect((await service.symbol("valid")).hits.map(hit => hit.path)).toEqual(["src/service.py"]);
		await put(root, "src/service.py", "def broken(:\n    return 'still searchable'\n");
		service.markChanged([path.join(root, "src/service.py")]);
		expect((await service.search("still searchable")).hits.map(hit => hit.path)).toEqual(["src/service.py"]);
		expect((await service.symbol("valid")).hits).toEqual([]);
		expect((await service.status()).failures.some(failure => failure.path === "src/service.py")).toBe(true);
	});

	it("handles known add, edit, delete and rename before the next query", async () => {
		const { root, service } = await fixture({ "old.py": "def old_name():\n    return 'old_marker'\n" });
		await service.build();
		await put(root, "added.py", "def newly_added():\n    return 'added_marker'\n");
		service.markChanged([path.join(root, "added.py")]);
		const added = (await service.search("added_marker")).hits;
		expect(added[0]?.path).toBe("added.py");
		expect(added[0]?.snippet).toContain("added_marker");
		expect(added.map(hit => hit.path)).toContain("old.py");
		await put(root, "old.py", "def replacement():\n    return 'replacement_marker'\n");
		service.markChanged([path.join(root, "old.py")]);
		expect((await service.symbol("old_name")).hits).toEqual([]);
		const edited = (await service.search("replacement_marker")).hits;
		expect(edited.map(hit => hit.path)).toEqual(["old.py", "added.py"]);
		expect(edited[0]?.snippet).toContain("replacement_marker");
		await fs.rename(path.join(root, "old.py"), path.join(root, "renamed.py"));
		service.markChanged([path.join(root, "old.py"), path.join(root, "renamed.py")]);
		const renamed = (await service.search("replacement_marker")).hits;
		expect(renamed.map(hit => hit.path)).toEqual(["renamed.py", "added.py"]);
		expect(renamed[0]?.snippet).toContain("replacement_marker");
		await fs.rm(path.join(root, "added.py"));
		service.markChanged([path.join(root, "added.py")]);
		const remaining = (await service.search("added_marker")).hits;
		expect(remaining.map(hit => hit.path)).toEqual(["renamed.py"]);
		expect(remaining[0]?.snippet).toContain("replacement_marker");
	});

	it("does not import a known changed path beneath an ignored ancestor during incremental or full reconciliation", async () => {
		const { root, service } = await fixture({
			".gitignore": "generated/\n",
			"generated/ignored.py": "ignoredancestoralpha = 1\n",
			"src/visible.py": "visibleanchor = 1\n",
		});
		await service.build();
		expect((await service.search("ignoredancestoralpha")).hits).toEqual([]);
		await put(root, "generated/ignored.py", "ignoredancestorbeta = 1\n");
		service.markChanged([path.join(root, "generated/ignored.py")]);
		expect((await service.search("ignoredancestorbeta")).hits).toEqual([]);
		expect((await service.search("visibleanchor")).hits.map(hit => hit.path)).toEqual(["src/visible.py"]);
		await service.reconcile();
		expect((await service.search("ignoredancestorbeta")).hits).toEqual([]);
	});

	it("keeps scope unchecked after .gitignore hides indexed files until an explicit full reconcile", async () => {
		const { root, service } = await fixture({
			".gitignore": "",
			"private/secret.py": "def secret_target(): return 'privatemarker'\n",
			"visible.py": "def visible_target(): return 1\n",
		});
		await service.build();
		expect((await service.search("privatemarker")).hits.map(hit => hit.path)).toEqual(["private/secret.py"]);
		await put(root, ".gitignore", "private/\n");
		service.markChanged([path.join(root, ".gitignore")]);
		const pending = await service.status();
		expect(pending.pendingPaths).toContain(".gitignore");
		expect(pending.unchecked).toBe(true);
		expect(pending.needsReconcile).toBe(true);
		const stale = await service.search("privatemarker");
		expect(stale.hits.map(hit => hit.path)).toEqual(["private/secret.py"]);
		expect(stale.warnings).toContain("Full repository scope has not been reconciled since uncertain changes");
		const flushed = await service.status();
		expect(flushed.pendingCount).toBe(0);
		expect(flushed.unchecked).toBe(true);
		expect(flushed.needsReconcile).toBe(true);
		await service.reconcile();
		expect((await service.search("privatemarker")).hits).toEqual([]);
		expect((await service.symbol("secret_target")).hits).toEqual([]);
		expect((await service.search("visible_target")).hits.map(hit => hit.path)).toEqual(["visible.py"]);
		const checked = await service.status();
		expect(checked.pendingCount).toBe(0);
		expect(checked.unchecked).toBe(false);
		expect(checked.needsReconcile).toBe(false);
	});

	it("finds newly unignored files only after full reconciliation of .ignore and marks Git scope inputs", async () => {
		const { root, service } = await fixture({
			".ignore": "generated/\n",
			"generated/old.py": "def old_unignored(): return 'old_visible_after_reconcile'\n",
		});
		await service.build();
		expect((await service.search("old_visible_after_reconcile")).hits).toEqual([]);
		await put(root, ".ignore", "");
		await put(root, "generated/new.py", "def new_unignored(): return 'newvisibleafterreconcile'\n");
		service.markChanged([path.join(root, ".ignore")]);
		const before = await service.search("newvisibleafterreconcile");
		expect(before.hits).toEqual([]);
		expect(before.coverage.pendingCount).toBe(0);
		expect(before.coverage.unchecked).toBe(true);
		expect(before.coverage.needsReconcile).toBe(true);
		await service.reconcile();
		expect((await service.symbol("old_unignored")).hits.map(hit => hit.path)).toEqual(["generated/old.py"]);
		expect((await service.search("newvisibleafterreconcile")).hits.map(hit => hit.path)).toEqual([
			"generated/new.py",
		]);
		expect((await service.status()).unchecked).toBe(false);
		service.markChanged([path.join(root, ".git", "info", "exclude")]);
		const gitScope = await service.search("newvisibleafterreconcile");
		expect(gitScope.hits.map(hit => hit.path)).toEqual(["generated/new.py"]);
		expect(gitScope.coverage.pendingCount).toBe(0);
		expect(gitScope.coverage.needsReconcile).toBe(true);
	});

	it("retains scope uncertainty from ignore edits made during an in-flight full reconcile", async () => {
		const { root, service } = await fixture({
			".gitignore": "",
			"private/secret.py": "def stale_during_reconcile(): return 1\n",
		});
		await service.build();
		await service.reconcile({
			onProgress: progress => {
				if (progress.phase !== "reading" || progress.path !== ".gitignore") return;
				fsSync.writeFileSync(path.join(root, ".gitignore"), "private/\n");
				service.markChanged([path.join(root, ".gitignore")]);
			},
		});
		expect((await service.status()).needsReconcile).toBe(true);
		const stale = await service.symbol("stale_during_reconcile");
		expect(stale.hits.map(hit => hit.path)).toEqual(["private/secret.py"]);
		expect(stale.coverage.pendingCount).toBe(0);
		expect(stale.coverage.unchecked).toBe(true);
		await service.reconcile();
		expect((await service.symbol("stale_during_reconcile")).hits).toEqual([]);
		expect((await service.status()).needsReconcile).toBe(false);
	});

	it("full reconciliation detects untracked files and same-size same-mtime external rewrites", async () => {
		const { root, service } = await fixture({
			"src/external.py": "def original(): return 'MARKER_A'\n",
			"src/gone.py": "def disappeared(): return 'EXTERNAL_DELETE'\n",
		});
		await service.build();
		const previous = await fs.stat(path.join(root, "src/external.py"));
		await put(root, "src/external.py", "def replaced(): return 'MARKER_B'\n");
		await fs.utimes(path.join(root, "src/external.py"), previous.atime, previous.mtime);
		const rewritten = await fs.stat(path.join(root, "src/external.py"));
		expect(rewritten.size).toBe(previous.size);
		expect(Math.abs(rewritten.mtimeMs - previous.mtimeMs)).toBeLessThan(1);
		await put(root, "src/untracked.py", "def extra(): return 'UNTRACKED'\n");
		await fs.rm(path.join(root, "src/gone.py"));
		await service.reconcile();
		expect((await service.symbol("original")).hits).toEqual([]);
		expect((await service.symbol("replaced")).hits.map(hit => hit.path)).toEqual(["src/external.py"]);
		expect((await service.search("UNTRACKED")).hits.map(hit => hit.path)).toEqual(["src/untracked.py"]);
		expect((await service.search("EXTERNAL_DELETE")).hits).toEqual([]);
		expect((await service.status()).lastFullCheck).not.toBeNull();
	});

	it.skipIf(process.platform !== "linux")(
		"retries atomic same-path replacement during a read and keeps repeated races pending",
		async () => {
			const content = (marker: string) => `def version(): return '${marker}'\n`;
			const { root, temp, service } = await fixture({ "source.py": content("OLD_BEACON") });
			const file = path.join(root, "source.py");
			await service.build();
			const originalStat = await fs.stat(file);
			const stage = async (marker: string) => {
				const staged = path.join(temp, `${marker}.py`);
				await fs.writeFile(staged, content(marker));
				await fs.utimes(staged, originalStat.atime, originalStat.mtime);
				expect((await fs.stat(staged)).size).toBe(originalStat.size);
				return staged;
			};
			const probe = await fs.open(file, "r");
			const prototype = Object.getPrototypeOf(probe) as { read: typeof probe.read };
			const originalRead = prototype.read;
			await probe.close();
			const duringRead = async (replacements: string[], operation: () => Promise<unknown>) => {
				let swapped = 0;
				prototype.read = async function (this: typeof probe, ...args: Parameters<typeof probe.read>) {
					const result = await originalRead.apply(this, args);
					if (
						result.bytesRead > 0 &&
						swapped < replacements.length &&
						fsSync.readlinkSync(`/proc/self/fd/${this.fd}`) === file
					) {
						fsSync.renameSync(replacements[swapped++], file);
					}
					return result;
				};
				try {
					await operation();
				} finally {
					prototype.read = originalRead;
				}
				expect(swapped).toBe(replacements.length);
				const current = await fs.stat(file);
				expect(current.size).toBe(originalStat.size);
				expect(Math.abs(current.mtimeMs - originalStat.mtimeMs)).toBeLessThan(1);
			};
			const first = await stage("MID_BEACON");
			const second = await stage("NEW_BEACON");
			await fs.rename(first, file);
			await duringRead([second], async () => {
				await service.reconcile();
			});
			expect((await service.search("NEW_BEACON")).hits).toEqual([
				expect.objectContaining({ path: "source.py", snippet: content("NEW_BEACON").trim() }),
			]);
			const stableGeneration = (await service.status()).generation;
			const next = await stage("RED_BEACON");
			const replacement1 = await stage("BLU_BEACON");
			const replacement2 = await stage("FIN_BEACON");
			await fs.rename(next, file);
			service.markChanged([file]);
			await duringRead([replacement1, replacement2], async () => {
				await expect(service.search("RED_BEACON")).rejects.toThrow(/changed while being read/i);
			});
			expect((await service.status()).generation).toBe(stableGeneration);
			expect((await service.status()).pendingPaths).toContain("source.py");
			expect((await service.search("FIN_BEACON")).hits).toEqual([
				expect.objectContaining({ path: "source.py", snippet: content("FIN_BEACON").trim() }),
			]);
			expect((await service.status()).pendingPaths).not.toContain("source.py");
		},
	);

	it.skipIf(process.platform === "win32")(
		"exposes excluded binary, oversized and symlink files without following external source",
		async () => {
			const { root, temp, service } = await fixture({ "src/valid.py": "def visible(): return 'VISIBLE'\n" });
			await Bun.write(path.join(root, "src/binary.dat"), new Uint8Array([0, 69, 88, 84, 69, 82, 78, 65, 76]));
			await Bun.write(path.join(root, "src/huge.txt"), "L".repeat(2 * 1024 * 1024 + 1));
			const outside = path.join(temp, "outside.py");
			await Bun.write(outside, "def outside_scope(): return 'EXTERNAL'\n");
			await fs.symlink(outside, path.join(root, "src/escape.py"));
			await service.build();
			const status = await service.status();
			expect(status.fileCount).toBe(1);
			expect(status.incomplete).toBe(true);
			expect(status.failures.map(failure => [failure.path, failure.kind])).toEqual(
				expect.arrayContaining([
					["src/binary.dat", "binary"],
					["src/huge.txt", "oversize"],
				]),
			);
			expect((await service.search("EXTERNAL")).hits).toEqual([]);
			expect((await service.symbol("outside_scope")).hits).toEqual([]);
		},
	);

	it("isolates non-Git directories, Git roots, and separate Git worktrees in one profile", async () => {
		const { root, agentDir, service } = await fixture({ "identity.py": "def main_root_only(): return 1\n" });
		await $`git init -q`.cwd(root).quiet();
		await $`git add identity.py`.cwd(root).quiet();
		await $`git -c user.name=IndexTest -c user.email=index@example.test commit -qm initial`.cwd(root).quiet();
		const worktree = path.join(path.dirname(root), "sibling-worktree");
		await $`git worktree add -qb index-worktree ${worktree}`.cwd(root).quiet();
		await put(worktree, "identity.py", "def worktree_only(): return 2\n");
		const sibling = new RepoService({ cwd: worktree, agentDir });
		services.push(sibling);
		const nongit = path.join(path.dirname(root), "nongit");
		await fs.mkdir(nongit);
		await put(nongit, "identity.py", "def nongit_only(): return 3\n");
		const standalone = new RepoService({ cwd: nongit, agentDir });
		services.push(standalone);
		await service.build();
		expect((await sibling.status()).exists).toBe(false);
		await sibling.build();
		await standalone.build();
		await put(root, "new_untracked.py", "def git_untracked(): return 'UNTRACKED_GIT'\n");
		await service.reconcile();
		expect((await service.symbol("git_untracked")).hits.map(hit => hit.path)).toEqual(["new_untracked.py"]);
		expect((await service.symbol("main_root_only")).hits.map(hit => hit.path)).toEqual(["identity.py"]);
		expect((await sibling.symbol("worktree_only")).hits.map(hit => hit.path)).toEqual(["identity.py"]);
		expect((await standalone.symbol("nongit_only")).hits.map(hit => hit.path)).toEqual(["identity.py"]);
		expect((await service.symbol("worktree_only")).hits).toEqual([]);
		expect(
			new Set([(await service.status()).root, (await sibling.status()).root, (await standalone.status()).root]).size,
		).toBe(3);
	});

	it("reports pending and uncertain coverage without triggering a build from status", async () => {
		const { root, service } = await fixture({ "known.py": "def known(): return 1\n" });
		const missing = await service.status();
		expect(missing.exists).toBe(false);
		service.markChanged([path.join(root, "known.py")]);
		expect((await service.status()).exists).toBe(false);
		await service.build();
		service.markUncertain("external command may change files");
		service.markChanged([path.join(root, "known.py")]);
		const pending = await service.status();
		expect(pending.pendingPaths).toContain("known.py");
		expect(pending.needsReconcile).toBe(true);
		await service.search("known");
		expect((await service.status()).pendingPaths).not.toContain("known.py");
		await service.reconcile();
		expect((await service.status()).needsReconcile).toBe(false);
	});

	it("cancellation and failure leave the earlier generation usable, including mid-build and failed rebuild", async () => {
		const { root, service } = await fixture({
			"a.py": "def stable(): return 'oldnimbus'\n",
			"b.py": "def second(): return 2\n",
		});
		const initial = new AbortController();
		await expect(
			service.build({
				signal: initial.signal,
				onProgress: progress => {
					if (progress.phase === "reading" && progress.processed === 1) initial.abort();
				},
			}),
		).rejects.toMatchObject({ name: "AbortError" });
		expect((await service.status()).exists).toBe(false);
		await expect(
			service.build({
				onProgress: progress => {
					if (progress.phase === "reading" && progress.processed === 1)
						throw new Error("fixture read interrupted");
				},
			}),
		).rejects.toThrow("fixture read interrupted");
		expect((await service.status()).exists).toBe(false);
		await service.build();
		const generation = (await service.status()).generation;
		await put(root, "a.py", "def changed(): return 'newmeteor'\n");
		const cancelled = new AbortController();
		await expect(
			service.rebuild({
				signal: cancelled.signal,
				onProgress: progress => {
					if (progress.phase === "reading" && progress.processed === 1) cancelled.abort();
				},
			}),
		).rejects.toMatchObject({ name: "AbortError" });
		expect((await service.status()).generation).toBe(generation);
		expect((await service.search("oldnimbus")).hits.map(hit => hit.path)).toEqual(["a.py"]);
		await expect(
			service.reconcile({
				onProgress: progress => {
					if (progress.phase === "reading" && progress.processed === 1)
						throw new Error("interrupted fixture read");
				},
			}),
		).rejects.toThrow("interrupted fixture read");
		expect((await service.status()).generation).toBe(generation);
		expect((await service.search("oldnimbus")).hits.map(hit => hit.path)).toEqual(["a.py"]);
		await expect(
			service.rebuild({
				onProgress: progress => {
					if (progress.phase === "reading" && progress.processed === 1) throw new Error("interrupted rebuild");
				},
			}),
		).rejects.toThrow("interrupted rebuild");
		expect((await service.status()).generation).toBe(generation);
		await service.rebuild();
		expect((await service.search("newmeteor")).hits.map(hit => hit.path)).toEqual(["a.py"]);
	});

	it("rolls back a real file-read failure without publishing a partial initial or updated generation", async () => {
		const { root, service } = await fixture({
			"a.py": "def first(): return 'oldharbor'\n",
			"b.py": "def second(): return 'safeisland'\n",
		});
		await expect(
			service.build({
				onProgress: progress => {
					if (progress.phase === "reading" && progress.processed === 1) fsSync.unlinkSync(path.join(root, "b.py"));
				},
			}),
		).rejects.toThrow();
		expect((await service.status()).exists).toBe(false);
		await put(root, "b.py", "def second(): return 'safeisland'\n");
		await service.build();
		const generation = (await service.status()).generation;
		await put(root, "a.py", "def newer(): return 'newmountain'\n");
		await expect(
			service.reconcile({
				onProgress: progress => {
					if (progress.phase === "reading" && progress.processed === 1) fsSync.unlinkSync(path.join(root, "b.py"));
				},
			}),
		).rejects.toThrow();
		expect((await service.status()).generation).toBe(generation);
		expect((await service.search("oldharbor")).hits.map(hit => hit.path)).toEqual(["a.py"]);
		expect((await service.search("safeisland")).hits.map(hit => hit.path)).toEqual(["b.py"]);
		await put(root, "b.py", "def second(): return 'safeisland'\n");
		await service.reconcile();
		expect((await service.search("newmountain")).hits.map(hit => hit.path)).toEqual(["a.py"]);
	});

	it("requires explicit recovery of a corrupt database and preserves recovery intent after a failed attempt", async () => {
		const { root, agentDir, service } = await fixture({
			"src/repair.py": "def repair_target(): return 'recoverybeacon'\n",
			"src/secondary.py": "def secondary_target(): return 'secondbeacon'\n",
		});
		await service.build();
		const databasePath = service.storage.path;
		service.close();
		await Bun.write(databasePath, "not a SQLite database");
		const reopened = new RepoService({ cwd: root, agentDir });
		services.push(reopened);
		await expect(reopened.status()).rejects.toThrow(/recover/i);
		await expect(reopened.search("recoverybeacon")).rejects.toThrow(/recover/i);
		await expect(
			reopened.recover({
				onProgress: progress => {
					if (progress.phase === "reading" && progress.processed === 1)
						throw new Error("recovery interrupted after staging one file");
				},
			}),
		).rejects.toThrow("recovery interrupted after staging one file");
		await expect(reopened.status()).rejects.toThrow(/recover/i);
		const recovered = await reopened.recover();
		expect(recovered.exists).toBe(true);
		expect(recovered.fileCount).toBe(2);
		expect((await reopened.search("recoverybeacon")).hits.map(hit => hit.path)).toEqual(["src/repair.py"]);
		expect((await reopened.symbol("repair_target")).hits.map(hit => hit.path)).toEqual(["src/repair.py"]);
		expect((await reopened.search("secondbeacon")).hits.map(hit => hit.path)).toEqual(["src/secondary.py"]);
	});

	it("removes a corrupt index without changing sources or rebuilding implicitly", async () => {
		const { root, agentDir, service } = await fixture({
			"src/preserved.py": "def preserved(): return 'sourceafterremoval'\n",
		});
		await service.build();
		const databasePath = service.storage.path;
		service.close();
		await Bun.write(databasePath, "not a SQLite database");
		const reopened = new RepoService({ cwd: root, agentDir });
		services.push(reopened);
		await expect(reopened.status()).rejects.toThrow(/recover/i);
		await reopened.remove();
		expect((await reopened.status()).exists).toBe(false);
		expect((await reopened.search("sourceafterremoval")).status).toBe("missing");
		expect(await Bun.file(path.join(root, "src/preserved.py")).text()).toContain("sourceafterremoval");
	});

	it("serializes maintenance on separate service instances without losing disjoint changed paths", async () => {
		const { root, agentDir, service } = await fixture({
			"a.py": "def a(): return 'beforealpha'\n",
			"b.py": "def b(): return 'beforebeta'\n",
		});
		await service.build();
		const peer = new RepoService({ cwd: root, agentDir });
		services.push(peer);
		await put(root, "a.py", "def a(): return 'afteralpha'\n");
		await put(root, "b.py", "def b(): return 'afterbeta'\n");
		service.markChanged([path.join(root, "a.py")]);
		peer.markChanged([path.join(root, "b.py")]);
		await Promise.all([service.reconcile(), peer.reconcile()]);
		expect((await service.search("afteralpha")).hits.map(hit => hit.path)).toEqual(["a.py"]);
		expect((await peer.search("afterbeta")).hits.map(hit => hit.path)).toEqual(["b.py"]);
		expect((await service.search("beforealpha")).hits).toEqual([]);
		expect((await peer.search("beforebeta")).hits).toEqual([]);
		expect((await service.status()).pendingPaths).toEqual([]);
		expect((await peer.status()).pendingPaths).toEqual([]);
	});

	it("retains a change recorded after its path is indexed but before update publishes", async () => {
		const { root, agentDir, service } = await fixture({
			"a.py": "def a(): return 'oldriver'\n",
			"b.py": "def b(): return 'unchangedplain'\n",
		});
		await service.build();
		const peer = new RepoService({ cwd: root, agentDir });
		services.push(peer);
		await put(root, "a.py", "def a(): return 'middleforest'\n");
		await service.reconcile({
			onProgress: progress => {
				if (progress.phase !== "reading" || progress.path !== "a.py") return;
				fsSync.writeFileSync(path.join(root, "a.py"), "def a(): return 'finaldesert'\n");
				peer.markChanged([path.join(root, "a.py")]);
			},
		});
		expect((await service.status()).pendingPaths).toContain("a.py");
		expect((await peer.search("finaldesert")).hits.map(hit => hit.path)).toEqual(["a.py"]);
		expect((await service.search("middleforest")).hits).toEqual([]);
		expect((await service.status()).pendingPaths).toEqual([]);
	});

	it.each(["build", "rebuild"] as const)("does not resurrect after a queued %s crosses deletion", async mode => {
		const { root, service } = await fixture({ "a.py": "def durable(): return 'sourceintact'\n" });
		if (mode === "rebuild") await service.build();
		let deleting: Promise<void> | undefined;
		let queued: Promise<"fulfilled" | "rejected"> | undefined;
		const operation = mode === "build" ? service.build.bind(service) : service.rebuild.bind(service);
		await operation({
			onProgress: progress => {
				if (progress.phase !== "reading" || progress.processed !== 1) return;
				deleting = service.remove();
				queued = operation().then(
					() => "fulfilled" as const,
					() => "rejected" as const,
				);
			},
		});
		expect(deleting).toBeDefined();
		expect(queued).toBeDefined();
		await deleting;
		expect(await queued).toBe("rejected");
		expect((await service.status()).exists).toBe(false);
		expect(await Bun.file(path.join(root, "a.py")).text()).toContain("sourceintact");
	});

	it("serves consistent generation metadata and complete hits during concurrent full reconciliation", async () => {
		const { root, agentDir, service } = await fixture({
			"a.py": "priorwasm\n",
			"b.py": "priorwasm\n",
		});
		await service.build();
		const prior = (await service.status()).generation;
		const observer = new RepoService({ cwd: root, agentDir });
		services.push(observer);
		await put(root, "a.py", "freshdragon\n");
		await put(root, "b.py", "freshdragon\n");
		const updating = service.reconcile();
		const observing = Promise.all(
			Array.from({ length: 12 }, () => Promise.all([observer.search("priorwasm"), observer.search("freshdragon")])),
		);
		const [observed, completed] = await Promise.all([observing, updating]);
		for (const pair of observed) {
			for (const page of pair) {
				expect(page.coverage.generation).toBe(page.generation);
				expect(page.status).toBe("ok");
				expect(page.coverage.fileCount).toBe(2);
				expect([prior, completed.generation]).toContain(page.generation);
				const expected =
					(page.generation === prior && page === pair[0]) ||
					(page.generation === completed.generation && page === pair[1])
						? ["a.py", "b.py"]
						: [];
				expect(page.hits.map(hit => hit.path)).toEqual(expected);
			}
		}
		expect((await observer.search("priorwasm")).hits).toEqual([]);
		expect((await observer.search("freshdragon")).hits.map(hit => hit.path)).toEqual(["a.py", "b.py"]);
	});

	it("coordinates concurrent requests, deletion, and disposal without resurrecting an index or changing sources", async () => {
		const { root, service } = await fixture({ "a.py": "def survives(): return 'source_remains'\n" });
		await service.build();
		await put(root, "a.py", "def replaced(): return 'source_remains'\n");
		const update = service.reconcile();
		const querying = service.search("source_remains");
		const deleting = service.remove();
		const outcomes = await Promise.allSettled([update, querying, deleting]);
		expect(outcomes[2].status).toBe("fulfilled");
		expect((await service.status()).exists).toBe(false);
		expect((await service.search("source_remains")).status).toBe("missing");
		expect(await Bun.file(path.join(root, "a.py")).text()).toContain("source_remains");
		service.close();
	});
});
