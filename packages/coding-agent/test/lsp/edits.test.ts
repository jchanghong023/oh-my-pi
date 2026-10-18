import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
	applyEditsThenRename,
	applyTextEdits,
	applyTextEditsToString,
	applyWorkspaceEdit,
} from "@oh-my-pi/pi-coding-agent/lsp/edits";
import type { TextEdit } from "@oh-my-pi/pi-coding-agent/lsp/types";
import { subscribeFsMutation } from "@oh-my-pi/pi-coding-agent/tools/fs-cache-invalidation";
import { RepoLifecycle } from "../../src/repo/lifecycle";
import { RepoService } from "../../src/repo/service";

// Rewrite `./moved` → `./renamed` on line 0 of the reference file below.
const importEdit: TextEdit[] = [
	{ range: { start: { line: 0, character: 19 }, end: { line: 0, character: 26 } }, newText: "./renamed" },
];

describe("applyEditsThenRename", () => {
	let dir: string;
	let source: string;
	let ref: string;
	const refBefore = 'import { x } from "./moved";\n';

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "edits-rename-"));
		source = path.join(dir, "moved.ts");
		ref = path.join(dir, "ref.ts");
		await Bun.write(source, "export const x = 1;\n");
		await Bun.write(ref, refBefore);
	});

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true });
	});

	it("applies reference edits and moves the source when the move succeeds", async () => {
		const dest = path.join(dir, "nested", "renamed.ts");
		await applyEditsThenRename([{ filePath: ref, edits: importEdit }], source, dest);

		expect(await Bun.file(dest).text()).toBe("export const x = 1;\n");
		expect(await Bun.file(source).exists()).toBe(false);
		expect(await Bun.file(ref).text()).toBe('import { x } from "./renamed";\n');
	});

	it("rolls back reference edits when the move fails", async () => {
		// A regular file stands where a dest-parent directory must be, so the
		// recursive mkdir throws ENOTDIR before the rename runs.
		const blocker = path.join(dir, "blocker");
		await Bun.write(blocker, "not a dir");
		const dest = path.join(blocker, "sub", "renamed.ts");

		await expect(applyEditsThenRename([{ filePath: ref, edits: importEdit }], source, dest)).rejects.toThrow();

		// Failed move must leave source, destination, and reference files untouched.
		expect(await Bun.file(ref).text()).toBe(refBefore);
		expect(await Bun.file(source).exists()).toBe(true);
		expect(await Bun.file(dest).exists()).toBe(false);
	});
});

describe("LSP resource snapshots without a repository index", () => {
	let cwd: string;
	let unsubscribe: () => void;
	let notifications: Array<{ paths: readonly string[]; reason?: string }>;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "lsp-resource-snapshot-"));
		notifications = [];
		unsubscribe = subscribeFsMutation((paths, reason) => {
			if (paths.some(file => file.startsWith(`${cwd}${path.sep}`))) notifications.push({ paths, reason });
		});
	});

	afterEach(async () => {
		unsubscribe();
		await fs.rm(cwd, { recursive: true, force: true });
	});

	const uri = (file: string) => pathToFileURL(file).href;

	function denySnapshot(directory: string) {
		const readdir = fs.readdir;
		const failure = Object.assign(new Error("snapshot enumeration denied"), { code: "EACCES" });
		// 保留原始参数元组与重载，避免 options 联合类型转发时丢失返回值关联。
		return spyOn(fs, "readdir").mockImplementation(((...args: Parameters<typeof readdir>) => {
			if (args[0] === directory) return Promise.reject(failure);
			return readdir(...args);
		}) as typeof readdir);
	}

	for (const entrypoint of ["workspace", "references"] as const) {
		it(`moves a directory via ${entrypoint} when a descendant snapshot cannot be read`, async () => {
			const source = path.join(cwd, "source");
			const target = path.join(cwd, "target");
			await fs.mkdir(path.join(source, "nested"), { recursive: true });
			await Bun.write(path.join(source, "nested", "child.py"), "def movedentry(): pass\n");
			const snapshotSpy = denySnapshot(path.join(source, "nested"));
			try {
				if (entrypoint === "workspace") {
					const result = await applyWorkspaceEdit(
						{ documentChanges: [{ kind: "rename", oldUri: uri(source), newUri: uri(target) }] },
						cwd,
					);
					expect(result.executed).toEqual([{ kind: "rename", oldUri: uri(source), newUri: uri(target) }]);
				} else {
					await applyEditsThenRename([], source, target);
				}
			} finally {
				snapshotSpy.mockRestore();
			}
			expect(await Bun.file(path.join(target, "nested", "child.py")).text()).toBe("def movedentry(): pass\n");
			expect(await fs.lstat(source).catch(() => undefined)).toBeUndefined();
			expect(notifications).toHaveLength(1);
			expect(notifications[0].paths).toEqual([source, target]);
			expect(notifications[0].reason).toBeDefined();
		});
	}

	it("marks an unreadable overwrite target snapshot uncertain without blocking the real rename", async () => {
		const source = path.join(cwd, "source");
		const target = path.join(cwd, "target");
		await fs.mkdir(source);
		await Bun.write(path.join(source, "moved.py"), "def movedentry(): pass\n");
		await fs.mkdir(path.join(target, "nested"), { recursive: true });
		await Bun.write(path.join(target, "nested", "old.py"), "def displacedentry(): pass\n");
		const snapshotSpy = denySnapshot(path.join(target, "nested"));
		try {
			await applyWorkspaceEdit(
				{
					documentChanges: [
						{ kind: "rename", oldUri: uri(source), newUri: uri(target), options: { overwrite: true } },
					],
				},
				cwd,
			);
		} finally {
			snapshotSpy.mockRestore();
		}
		expect(await Bun.file(path.join(target, "moved.py")).text()).toBe("def movedentry(): pass\n");
		expect(await Bun.file(path.join(target, "nested", "old.py")).exists()).toBe(false);
		expect(await fs.lstat(source).catch(() => undefined)).toBeUndefined();
		expect(notifications).toHaveLength(2);
		expect(notifications[0].paths).toEqual([target]);
		expect(notifications[0].reason).toBeDefined();
		expect(notifications[1].paths).toEqual([
			source,
			path.join(source, "moved.py"),
			target,
			path.join(target, "moved.py"),
		]);
		expect(notifications[1].reason).toBeUndefined();
	});

	it("preserves uncertain overwrite notifications and restores the target after a real rename failure", async () => {
		const source = path.join(cwd, "source");
		// 内核禁止把目录移入自身后代；真实 rename 失败必须恢复已暂存的目标，而非被快照错误提前拦截。
		const target = path.join(source, "target");
		await fs.mkdir(path.join(target, "nested"), { recursive: true });
		await Bun.write(path.join(source, "source.py"), "def sourceentry(): pass\n");
		await Bun.write(path.join(target, "nested", "old.py"), "def restoredentry(): pass\n");
		const snapshotSpy = denySnapshot(path.join(target, "nested"));
		const executed: string[] = [];
		try {
			await expect(
				applyWorkspaceEdit(
					{
						documentChanges: [
							{ kind: "rename", oldUri: uri(source), newUri: uri(target), options: { overwrite: true } },
						],
					},
					cwd,
					change => executed.push(change.kind),
				),
			).rejects.toThrow();
		} finally {
			snapshotSpy.mockRestore();
		}
		expect(await Bun.file(path.join(source, "source.py")).text()).toBe("def sourceentry(): pass\n");
		expect(await Bun.file(path.join(target, "nested", "old.py")).text()).toBe("def restoredentry(): pass\n");
		expect(executed).toEqual([]);
		expect(notifications).toHaveLength(2);
		for (const notification of notifications) {
			expect(notification.paths).toEqual([target]);
			expect(notification.reason).toBeDefined();
		}
	});

	it("deletes a directory with an incomplete snapshot while retaining uncertain coverage", async () => {
		const target = path.join(cwd, "target");
		await fs.mkdir(path.join(target, "nested"), { recursive: true });
		await Bun.write(path.join(target, "nested", "child.py"), "def removedentry(): pass\n");
		const snapshotSpy = denySnapshot(path.join(target, "nested"));
		try {
			const result = await applyWorkspaceEdit(
				{ documentChanges: [{ kind: "delete", uri: uri(target), options: { recursive: true } }] },
				cwd,
			);
			expect(result.executed).toEqual([{ kind: "delete", uri: uri(target) }]);
		} finally {
			snapshotSpy.mockRestore();
		}
		expect(await fs.lstat(target).catch(() => undefined)).toBeUndefined();
		expect(notifications).toHaveLength(1);
		expect(notifications[0].paths).toEqual([target]);
		expect(notifications[0].reason).toBeDefined();
	});
});

describe("LSP edits with a real repository index", () => {
	let temp: string;
	let cwd: string;
	let service: RepoService | undefined;
	let lifecycle: RepoLifecycle | undefined;

	beforeEach(async () => {
		temp = await fs.mkdtemp(path.join(os.tmpdir(), "lsp-edits-repo-"));
		cwd = path.join(temp, "project");
		await fs.mkdir(cwd);
	});

	afterEach(async () => {
		lifecycle?.dispose();
		service?.close();
		lifecycle = undefined;
		service = undefined;
		await fs.rm(temp, { recursive: true, force: true });
	});

	const uri = (name: string) => pathToFileURL(path.join(cwd, name)).href;
	const renameSymbol = (before: string, after: string): TextEdit[] => [
		{
			range: { start: { line: 0, character: 4 }, end: { line: 0, character: 4 + before.length } },
			newText: after,
		},
	];

	async function indexed(files: Record<string, string>): Promise<RepoService> {
		for (const [name, content] of Object.entries(files)) {
			const file = path.join(cwd, name);
			await fs.mkdir(path.dirname(file), { recursive: true });
			await Bun.write(file, content);
		}
		const agentDir = path.join(temp, "profile");
		service = new RepoService({ cwd, agentDir });
		await service.build();
		lifecycle = new RepoLifecycle({ agentDir, getCwd: () => cwd });
		lifecycle.start();
		await service.reconcile();
		return service;
	}

	it("refreshes search and symbols after a text rename", async () => {
		// Keep markers token-disjoint: text search also recalls split identifier tokens.
		const repo = await indexed({ "engine.py": "def staleidentifier(): pass\n" });
		await applyWorkspaceEdit(
			{ changes: { [uri("engine.py")]: renameSymbol("staleidentifier", "freshbinding") } },
			cwd,
		);
		expect((await repo.symbol("freshbinding")).hits.map(hit => hit.path)).toEqual(["engine.py"]);
		expect((await repo.search("freshbinding")).hits.map(hit => hit.path)).toEqual(["engine.py"]);
		expect((await repo.symbol("staleidentifier")).hits).toEqual([]);
		expect((await repo.search("staleidentifier")).hits).toEqual([]);
		expect((await repo.status()).unchecked).toBe(false);
	});

	for (const format of ["changes", "documentChanges"] as const) {
		it(`refreshes the committed prefix when a later ${format} edit fails`, async () => {
			const repo = await indexed({ "first.py": "def initialbinding(): pass\n" });
			const firstEdits = renameSymbol("initialbinding", "committedentry");
			const missingEdits = renameSymbol("missing", "unreachable");
			const edit =
				format === "changes"
					? { changes: { [uri("first.py")]: firstEdits, [uri("missing.py")]: missingEdits } }
					: {
							documentChanges: [
								{ textDocument: { uri: uri("first.py") }, edits: firstEdits },
								{ textDocument: { uri: uri("missing.py") }, edits: missingEdits },
							],
						};
			await expect(applyWorkspaceEdit(edit, cwd)).rejects.toThrow();
			expect((await repo.status()).pendingPaths).toEqual(["first.py"]);
			const refreshed = await repo.symbol("committedentry");
			expect(refreshed.hits.map(hit => hit.path)).toEqual(["first.py"]);
			expect((await repo.symbol("initialbinding")).hits).toEqual([]);
			expect((await repo.search("initialbinding")).hits).toEqual([]);
		});
	}

	it("refreshes an uncertain failed write without certifying its coverage", async () => {
		const repo = await indexed({ "engine.py": "def before_failure(): pass\n" });
		const file = path.join(cwd, "engine.py");
		const write = Bun.write.bind(Bun);
		const failure = new Error("write interrupted after truncation");
		const writeSpy = spyOn(Bun, "write").mockImplementation(async (target, content) => {
			if (target === file) {
				await write(file, "def partial_write(): pass\n");
				throw failure;
			}
			return write(target as string, content as string);
		});
		try {
			await expect(applyTextEdits(file, renameSymbol("before_failure", "requested_name"))).rejects.toBe(failure);
		} finally {
			writeSpy.mockRestore();
		}
		const refreshed = await repo.symbol("partial_write");
		expect(refreshed.hits.map(hit => hit.path)).toEqual(["engine.py"]);
		expect(refreshed.coverage.unchecked).toBe(true);
		expect((await repo.symbol("before_failure")).hits).toEqual([]);
		expect((await repo.search("before_failure")).hits).toEqual([]);
	});

	it("tracks create, overwrite rename and delete at their committed paths", async () => {
		const repo = await indexed({
			"nested/renamed.py": "def displaced_symbol(): pass\n",
			"cleared.py": "def cleared_symbol(): pass\n",
		});
		await applyWorkspaceEdit(
			{ documentChanges: [{ kind: "create", uri: uri("cleared.py"), options: { overwrite: true } }] },
			cwd,
		);
		expect((await repo.symbol("cleared_symbol")).hits).toEqual([]);
		expect(await Bun.file(path.join(cwd, "cleared.py")).text()).toBe("");
		await applyWorkspaceEdit({ documentChanges: [{ kind: "create", uri: uri("created.py") }] }, cwd);
		expect((await repo.status()).pendingPaths).toEqual(["created.py"]);
		await applyTextEdits(path.join(cwd, "created.py"), [
			{
				range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
				newText: "def createdentry(): pass\n",
			},
		]);
		expect((await repo.symbol("createdentry")).hits.map(hit => hit.path)).toEqual(["created.py"]);
		await applyWorkspaceEdit(
			{
				documentChanges: [
					{
						kind: "rename",
						oldUri: uri("created.py"),
						newUri: uri("nested/renamed.py"),
						options: { overwrite: true },
					},
				],
			},
			cwd,
		);
		expect((await repo.symbol("createdentry")).hits.map(hit => hit.path)).toEqual(["nested/renamed.py"]);
		expect((await repo.search("createdentry")).hits.map(hit => hit.path)).toEqual(["nested/renamed.py"]);
		expect((await repo.symbol("displaced_symbol")).hits).toEqual([]);
		await applyWorkspaceEdit(
			{ documentChanges: [{ kind: "delete", uri: uri("nested"), options: { recursive: true } }] },
			cwd,
		);
		expect((await repo.symbol("createdentry")).hits).toEqual([]);
		expect((await repo.search("createdentry")).hits).toEqual([]);
	});

	for (const entrypoint of ["workspace", "references"] as const) {
		it(`refreshes descendant paths after a directory rename via ${entrypoint}`, async () => {
			const repo = await indexed({
				"before/engine.py": "def directoryentry(): pass\n",
				"before/nested/child.py": "def descendantentry(): pass\n",
			});
			if (entrypoint === "workspace") {
				await applyWorkspaceEdit(
					{ documentChanges: [{ kind: "rename", oldUri: uri("before"), newUri: uri("after") }] },
					cwd,
				);
			} else {
				await applyEditsThenRename([], path.join(cwd, "before"), path.join(cwd, "after"));
			}
			expect((await repo.symbol("directoryentry")).hits.map(hit => hit.path)).toEqual(["after/engine.py"]);
			expect((await repo.search("directoryentry")).hits.map(hit => hit.path)).toEqual(["after/engine.py"]);
			expect((await repo.symbol("descendantentry")).hits.map(hit => hit.path)).toEqual(["after/nested/child.py"]);
			expect((await repo.search("descendantentry")).hits.map(hit => hit.path)).toEqual(["after/nested/child.py"]);
			expect((await repo.status()).unchecked).toBe(false);
		});
	}

	it("refreshes concrete descendants after a recursive delete partially fails", async () => {
		const repo = await indexed({
			"nested/removed.py": "def removedentry(): pass\n",
			"nested/retained.py": "def retainedentry(): pass\n",
		});
		const directory = path.join(cwd, "nested");
		const rm = fs.rm;
		const failure = Object.assign(new Error("recursive delete interrupted"), { code: "EACCES" });
		const rmSpy = spyOn(fs, "rm").mockImplementation(async (target, options) => {
			if (target === directory) {
				await rm(path.join(directory, "removed.py"));
				throw failure;
			}
			return rm(target, options);
		});
		try {
			await expect(
				applyWorkspaceEdit(
					{ documentChanges: [{ kind: "delete", uri: uri("nested"), options: { recursive: true } }] },
					cwd,
				),
			).rejects.toBe(failure);
		} finally {
			rmSpy.mockRestore();
		}
		expect((await repo.symbol("removedentry")).hits).toEqual([]);
		expect((await repo.search("removedentry")).hits).toEqual([]);
		expect((await repo.symbol("retainedentry")).hits.map(hit => hit.path)).toEqual(["nested/retained.py"]);
		expect((await repo.status()).unchecked).toBe(true);
	});

	it("tracks the old and new paths of a rename with reference edits", async () => {
		const repo = await indexed({
			"moved.py": "def moved_symbol(): pass\n",
			"reference.py": "def before_reference(): pass\n",
		});
		await applyEditsThenRename(
			[{ filePath: path.join(cwd, "reference.py"), edits: renameSymbol("before_reference", "after_reference") }],
			path.join(cwd, "moved.py"),
			path.join(cwd, "renamed.py"),
		);
		expect((await repo.symbol("moved_symbol")).hits.map(hit => hit.path)).toEqual(["renamed.py"]);
		expect((await repo.search("moved_symbol")).hits.map(hit => hit.path)).toEqual(["renamed.py"]);
		expect((await repo.symbol("after_reference")).hits.map(hit => hit.path)).toEqual(["reference.py"]);
		expect((await repo.symbol("before_reference")).hits).toEqual([]);
	});

	it("invalidates restored reference edits even if the temporary edits were already indexed", async () => {
		const repo = await indexed({
			"moved.py": "def moved_symbol(): pass\n",
			"first.py": "def before_reference(): pass\n",
			"second.py": "def second_reference(): pass\n",
			blocker: "not a directory",
		});
		const first = path.join(cwd, "first.py");
		const second = path.join(cwd, "second.py");
		const write = Bun.write.bind(Bun);
		let observedTemporary = false;
		let temporaryPaths: string[] | undefined;
		let temporaryOldPaths: string[] | undefined;
		const writeSpy = spyOn(Bun, "write").mockImplementation(async (target, content) => {
			if (target === second && !observedTemporary) {
				observedTemporary = true;
				temporaryPaths = (await repo.symbol("after_reference")).hits.map(hit => hit.path);
				temporaryOldPaths = (await repo.symbol("before_reference")).hits.map(hit => hit.path);
			}
			return write(target as string, content as string);
		});
		try {
			await expect(
				applyEditsThenRename(
					[
						{ filePath: first, edits: renameSymbol("before_reference", "after_reference") },
						{ filePath: second, edits: renameSymbol("second_reference", "changed_reference") },
					],
					path.join(cwd, "moved.py"),
					path.join(cwd, "blocker", "renamed.py"),
				),
			).rejects.toThrow();
		} finally {
			writeSpy.mockRestore();
		}
		expect(observedTemporary).toBe(true);
		expect(temporaryPaths).toEqual(["first.py"]);
		expect(temporaryOldPaths).toEqual([]);
		expect((await repo.symbol("before_reference")).hits.map(hit => hit.path)).toEqual(["first.py"]);
		expect((await repo.symbol("after_reference")).hits).toEqual([]);
		expect((await repo.symbol("second_reference")).hits.map(hit => hit.path)).toEqual(["second.py"]);
		expect((await repo.symbol("moved_symbol")).hits.map(hit => hit.path)).toEqual(["moved.py"]);
		expect((await repo.status()).unchecked).toBe(false);
	});

	it("invalidates an overwrite destination restored after a failed resource rename", async () => {
		const repo = await indexed({
			"source.py": "def source_symbol(): pass\n",
			"target.py": "def target_symbol(): pass\n",
		});
		const source = path.join(cwd, "source.py");
		const target = path.join(cwd, "target.py");
		const rename = fs.rename;
		const failure = Object.assign(new Error("source rename denied"), { code: "EACCES" });
		let displacedPaths: string[] | undefined;
		const renameSpy = spyOn(fs, "rename").mockImplementation(async (from, to) => {
			if (from === source && to === target) {
				displacedPaths = (await repo.symbol("target_symbol")).hits.map(hit => hit.path);
				throw failure;
			}
			return rename(from, to);
		});
		try {
			await expect(
				applyWorkspaceEdit(
					{
						documentChanges: [
							{
								kind: "rename",
								oldUri: uri("source.py"),
								newUri: uri("target.py"),
								options: { overwrite: true },
							},
						],
					},
					cwd,
				),
			).rejects.toBe(failure);
		} finally {
			renameSpy.mockRestore();
		}
		expect(displacedPaths).toEqual([]);
		expect((await repo.symbol("target_symbol")).hits.map(hit => hit.path)).toEqual(["target.py"]);
		expect((await repo.symbol("source_symbol")).hits.map(hit => hit.path)).toEqual(["source.py"]);
		expect(await Bun.file(target).text()).toBe("def target_symbol(): pass\n");
		expect((await repo.status()).unchecked).toBe(false);
	});

	it("refreshes displaced directory descendants when a failed rename restores them", async () => {
		const repo = await indexed({
			"source/engine.py": "def sourceentry(): pass\n",
			"target/nested/child.py": "def restoredentry(): pass\n",
		});
		const source = path.join(cwd, "source");
		const target = path.join(cwd, "target");
		const rename = fs.rename;
		const failure = Object.assign(new Error("directory rename denied"), { code: "EACCES" });
		let displacedPaths: string[] | undefined;
		const renameSpy = spyOn(fs, "rename").mockImplementation(async (from, to) => {
			if (from === source && to === target) {
				displacedPaths = (await repo.symbol("restoredentry")).hits.map(hit => hit.path);
				throw failure;
			}
			return rename(from, to);
		});
		try {
			await expect(
				applyWorkspaceEdit(
					{
						documentChanges: [
							{ kind: "rename", oldUri: uri("source"), newUri: uri("target"), options: { overwrite: true } },
						],
					},
					cwd,
				),
			).rejects.toBe(failure);
		} finally {
			renameSpy.mockRestore();
		}
		expect(displacedPaths).toEqual([]);
		expect((await repo.symbol("restoredentry")).hits.map(hit => hit.path)).toEqual(["target/nested/child.py"]);
		expect((await repo.search("restoredentry")).hits.map(hit => hit.path)).toEqual(["target/nested/child.py"]);
		expect((await repo.symbol("sourceentry")).hits.map(hit => hit.path)).toEqual(["source/engine.py"]);
		expect((await repo.status()).unchecked).toBe(false);
	});

	it("does not publish mutations for previews, ignored operations or rejected edits", async () => {
		const repo = await indexed({
			"source.py": "def source_symbol(): pass\n",
			"target.py": "def target_symbol(): pass\n",
		});
		const generation = (await repo.status()).generation;
		expect(
			applyTextEditsToString("def source_symbol(): pass\n", renameSymbol("source_symbol", "preview_symbol")),
		).toContain("preview_symbol");
		const skipped = await applyWorkspaceEdit(
			{
				documentChanges: [
					{ kind: "create", uri: uri("source.py"), options: { ignoreIfExists: true } },
					{
						kind: "rename",
						oldUri: uri("source.py"),
						newUri: uri("target.py"),
						options: { ignoreIfExists: true },
					},
					{ kind: "delete", uri: uri("missing.py"), options: { ignoreIfNotExists: true } },
				],
			},
			cwd,
		);
		expect(skipped.executed).toEqual([]);
		await expect(
			applyWorkspaceEdit(
				{
					changes: {
						[uri("source.py")]: renameSymbol("source_symbol", "unwritten_symbol"),
						[uri("target.py")]: [
							...renameSymbol("target_symbol", "first_overlap"),
							...renameSymbol("target_symbol", "second_overlap"),
						],
					},
				},
				cwd,
			),
		).rejects.toThrow("overlapping LSP edits");
		expect(await repo.status()).toMatchObject({ generation, pendingCount: 0, unchecked: false });
		expect((await repo.symbol("source_symbol")).hits.map(hit => hit.path)).toEqual(["source.py"]);
		expect((await repo.symbol("unwritten_symbol")).hits).toEqual([]);
		expect((await repo.symbol("preview_symbol")).hits).toEqual([]);
	});
});
