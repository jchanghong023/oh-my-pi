import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { type ArchiveReader, openArchive } from "@oh-my-pi/pi-utils/ar";
import { CodeReviewExportCommand } from "../../../src/extensibility/custom-commands/bundled/code-review-export";
import { writeReviewBundle } from "../../../src/extensibility/custom-commands/bundled/code-review-export/bundle";
import { captureReviewExportSnapshot } from "../../../src/extensibility/custom-commands/bundled/code-review-export/snapshot";
import { buildReviewPrompt } from "../../../src/extensibility/custom-commands/bundled/review/prompt";
import { createResolvedReviewTarget } from "../../../src/extensibility/custom-commands/bundled/review/target";
import type { CustomCommandAPI, CustomCommandContext } from "../../../src/extensibility/custom-commands/types";

const repositories: string[] = [];

/** Real empty Git repository; native vcs owns all index, object and commit operations. */
async function createRepository() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-review-export-"));
	repositories.push(root);
	await fs.mkdir(path.join(root, ".git", "objects", "info"), { recursive: true });
	await fs.mkdir(path.join(root, ".git", "refs", "heads"), { recursive: true });
	await fs.writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
	await fs.writeFile(
		path.join(root, ".git", "config"),
		[
			"[core]",
			"\trepositoryformatversion = 0",
			"\tbare = false",
			"\tautocrlf = false",
			"[user]",
			"\tname = Review Export Test",
			"\temail = export@example.invalid",
			"[commit]",
			"\tgpgsign = false",
			"",
		].join("\n"),
	);
	return root;
}

async function commit(root: string, files: string[], message: string) {
	const repository = vcs.requireGit(root);
	await repository.stageFiles(files);
	return repository.commitCreate(message, {});
}

function hash(bytes: Uint8Array) {
	return createHash("sha256").update(bytes).digest("hex");
}

async function readMember(archive: ArchiveReader, member: string) {
	return Buffer.from((await archive.readFile(member)).bytes);
}

afterEach(async () => {
	await Promise.all(repositories.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("code-review-export frozen bundles", () => {
	test("exports exact historical versions, full diff, binary metadata and real builtin prompts", async () => {
		const root = await createRepository();
		const before = Buffer.from('const token = "literal-secret-before";\r\nconst value = 1;');
		const after = Buffer.concat([
			Buffer.from('const token = "literal-secret-after";\r\n// legacy byte: '),
			Buffer.from([0xe9]),
		]);
		const deleted = Buffer.from("deleted source\r\n");
		const context = Buffer.from("first\r\nsecond\r\nthird\r\nfourth");
		await fs.writeFile(path.join(root, "changed.ts"), before);
		await fs.writeFile(path.join(root, "deleted.ts"), deleted);
		await fs.writeFile(path.join(root, "related.ts"), context);
		const base = await commit(root, ["changed.ts", "deleted.ts", "related.ts"], "baseline");
		await fs.writeFile(path.join(root, "changed.ts"), after);
		await fs.rm(path.join(root, "deleted.ts"));
		const binary = Buffer.from([0, 1, 255, 10]);
		await fs.writeFile(path.join(root, "image.bin"), binary);
		const target = await commit(root, ["changed.ts", "deleted.ts", "image.bin"], "selected change");
		// Historical export must ignore the checkout's newer contents.
		await fs.writeFile(path.join(root, "changed.ts"), "not the selected commit\n");
		await fs.writeFile(path.join(root, "related.ts"), "not selected context\n");
		const snapshot = await captureReviewExportSnapshot(root, { kind: "commit", ref: target });
		try {
			const result = await writeReviewBundle(snapshot, {
				args: [],
				instructions: "Check shared state ownership.",
			});
			const archive = await openArchive(result.path);
			expect(await readMember(archive, "changed-files/before/changed.ts")).toEqual(before);
			expect(await readMember(archive, "changed-files/after/changed.ts")).toEqual(after);
			expect(await readMember(archive, "changed-files/before/deleted.ts")).toEqual(deleted);
			expect(archive.getNode("changed-files/after/deleted.ts")).toBeUndefined();
			expect(archive.getNode("changed-files/after/image.bin")).toBeUndefined();
			expect(archive.getNode("context/target/related.ts")).toBeUndefined();
			expect(await readMember(archive, "diff.patch")).toEqual(Buffer.from(snapshot.diff));
			expect(await readMember(archive, "instructions/review.md")).toEqual(
				Buffer.from(
					buildReviewPrompt(
						createResolvedReviewTarget(
							"commit",
							snapshot.mode,
							snapshot.diff,
							"No changes in the selected scope",
						),
						"Check shared state ownership.",
					),
				),
			);
			expect(await readMember(archive, "instructions/reviewer.md")).toEqual(
				await fs.readFile(path.resolve(import.meta.dir, "../../../src/prompts/agents/reviewer.md")),
			);
			const manifest = JSON.parse((await readMember(archive, "manifest.json")).toString("utf8"));
			expect(manifest.baseCommit).toBe(base);
			expect(manifest.targetCommit).toBe(target);
			expect(manifest.sources).toContainEqual(
				expect.objectContaining({
					path: "image.bin",
					binary: true,
					originalBytes: binary.length,
					originalSha256: hash(binary),
				}),
			);
			expect(manifest.sources).not.toContainEqual(expect.objectContaining({ path: "related.ts" }));
			let uncompressed = 0;
			const files = [...archive.indexEntries()].filter(entry => !entry.isDirectory);
			for (const entry of files) uncompressed += (await readMember(archive, entry.path)).length;
			expect(result.fileCount).toBe(files.length);
			expect(result.sourceLines).toBe(5);
			expect(result.uncompressedBytes).toBe(uncompressed);
			expect(result.compressedBytes).toBe((await fs.stat(result.path)).size);
			expect(manifest.statistics.uncompressedBytes).toBe(uncompressed);
			for (const entry of manifest.members) {
				const bytes = await readMember(archive, entry.member);
				expect(entry.bytes).toBe(bytes.length);
				expect(entry.sha256).toBe(hash(bytes));
			}
		} finally {
			await snapshot.dispose();
		}
	});

	test("uses final staged-plus-unstaged and untracked bytes, excludes .tmp, and replaces the fixed ZIP", async () => {
		const root = await createRepository();
		await fs.writeFile(path.join(root, "tracked.ts"), "baseline\n");
		await commit(root, ["tracked.ts"], "baseline");
		await fs.writeFile(path.join(root, "tracked.ts"), "staged intermediate\n");
		await vcs.requireGit(root).stageFiles(["tracked.ts"]);
		const final = Buffer.from('const password = "must-remain-literal";\r\n');
		await fs.writeFile(path.join(root, "tracked.ts"), final);
		const untracked = Buffer.from("\ufeffnew untracked source\r\n");
		await fs.mkdir(path.join(root, "new"));
		await fs.writeFile(path.join(root, "new", "source.ts"), untracked);
		await fs.mkdir(path.join(root, ".tmp"));
		await fs.writeFile(path.join(root, ".tmp", "review-bundle.zip"), "previous package");
		await fs.writeFile(path.join(root, ".tmp", "keep.txt"), "unrelated temp data");
		const indexBefore = await fs.readFile(path.join(root, ".git", "index"));
		let firstZip: Buffer | undefined;
		for (let run = 0; run < 2; run++) {
			if (run === 1)
				await fs.writeFile(
					path.join(root, "new", "source.ts"),
					Buffer.concat([untracked, Buffer.from("second export\n")]),
				);
			const snapshot = await captureReviewExportSnapshot(root, { kind: "uncommitted" });
			try {
				const result = await writeReviewBundle(snapshot, { args: [] });
				expect(result.path).toBe(path.join(root, ".tmp", "review-bundle.zip"));
				const archive = await openArchive(result.path);
				expect(await readMember(archive, "changed-files/after/tracked.ts")).toEqual(final);
				expect(await readMember(archive, "changed-files/after/new/source.ts")).toEqual(
					await fs.readFile(path.join(root, "new", "source.ts")),
				);
				expect(await readMember(archive, "diff.patch")).toEqual(Buffer.from(snapshot.diff));
				expect([...archive.indexEntries()].some(entry => entry.path.includes("/.tmp/"))).toBe(false);
				const bytes = await fs.readFile(result.path);
				if (firstZip) expect(bytes.equals(firstZip)).toBe(false);
				else firstZip = bytes;
			} finally {
				await snapshot.dispose();
			}
		}
		expect(await fs.readFile(path.join(root, ".git", "index"))).toEqual(indexBefore);
		expect(await fs.readFile(path.join(root, ".tmp", "keep.txt"), "utf8")).toBe("unrelated temp data");
		expect((await fs.readdir(path.join(root, ".tmp"))).sort()).toEqual(["keep.txt", "review-bundle.zip"]);
	});

	test("excludes oversized tracked .tmp inputs before rendering every local scope", async () => {
		const root = await createRepository();
		await fs.mkdir(path.join(root, ".tmp"));
		const capturePath = path.join(root, ".tmp", "capture.bin");
		await fs.writeFile(capturePath, Buffer.alloc(64 * 1024 * 1024 + 1));
		await fs.writeFile(path.join(root, "source.ts"), "export const value = 1;\n");
		const initial = await commit(root, [".tmp/capture.bin", "source.ts"], "root with oversized temporary capture");
		const assertExport = async (scope: Parameters<typeof captureReviewExportSnapshot>[1], value: number) => {
			const snapshot = await captureReviewExportSnapshot(root, scope);
			try {
				expect(snapshot.changes.map(change => change.path)).toEqual(["source.ts"]);
				expect(snapshot.diff).toContain(`+export const value = ${value};`);
				expect(snapshot.diff).not.toContain(".tmp");
				const result = await writeReviewBundle(snapshot, { args: [] });
				const archive = await openArchive(result.path);
				expect(await readMember(archive, "changed-files/after/source.ts")).toEqual(
					Buffer.from(`export const value = ${value};\n`),
				);
				expect([...archive.indexEntries()].some(entry => entry.path.includes("/.tmp/"))).toBe(false);
			} finally {
				await snapshot.dispose();
			}
		};
		await assertExport({ kind: "commit", ref: initial }, 1);
		const handle = await fs.open(capturePath, "r+");
		try {
			await handle.write(Buffer.from([1]), 0, 1, 0);
			await fs.writeFile(path.join(root, "source.ts"), "export const value = 2;\n");
			const target = await commit(root, [".tmp/capture.bin", "source.ts"], "retained source and excluded capture");
			await assertExport({ kind: "commit", ref: target }, 2);
			await assertExport({ kind: "base-branch", baseRef: initial, targetRef: target }, 2);
			await handle.write(Buffer.from([2]), 0, 1, 0);
			await fs.writeFile(path.join(root, "source.ts"), "export const value = 3;\n");
			await vcs.requireGit(root).stageFiles([".tmp/capture.bin", "source.ts"]);
			await assertExport({ kind: "uncommitted" }, 3);
		} finally {
			await handle.close();
		}
	}, 60_000);

	test("represents renames crossing root .tmp as retained additions and deletions", async () => {
		const root = await createRepository();
		await fs.mkdir(path.join(root, ".tmp"));
		await fs.writeFile(path.join(root, "removed.ts"), "export const removed = 1;\n");
		await fs.writeFile(path.join(root, ".tmp", "incoming.ts"), "export const incoming = 2;\n");
		await commit(root, ["removed.ts", ".tmp/incoming.ts"], "before boundary renames");
		await fs.rename(path.join(root, "removed.ts"), path.join(root, ".tmp", "removed.ts"));
		await fs.rename(path.join(root, ".tmp", "incoming.ts"), path.join(root, "incoming.ts"));
		const target = await commit(
			root,
			["removed.ts", ".tmp/removed.ts", ".tmp/incoming.ts", "incoming.ts"],
			"rename across temporary boundary",
		);
		for (const scope of [{ kind: "commit", ref: target }, { kind: "uncommitted" }] as const) {
			// Reverse the committed boundary moves to exercise the uncommitted comparison too.
			if (scope.kind === "uncommitted") {
				await fs.rename(path.join(root, ".tmp", "removed.ts"), path.join(root, "removed.ts"));
				await fs.rename(path.join(root, "incoming.ts"), path.join(root, ".tmp", "incoming.ts"));
				await vcs.requireGit(root).stageFiles(["removed.ts", ".tmp/removed.ts", ".tmp/incoming.ts", "incoming.ts"]);
			}
			const snapshot = await captureReviewExportSnapshot(root, scope);
			try {
				expect(snapshot.changes.map(change => ({ path: change.path, status: change.status }))).toEqual([
					{ path: "incoming.ts", status: scope.kind === "commit" ? "A" : "D" },
					{ path: "removed.ts", status: scope.kind === "commit" ? "D" : "A" },
				]);
				expect(snapshot.changes.every(change => change.previousPath === undefined)).toBe(true);
				expect(snapshot.diff).not.toContain(".tmp");
				expect(snapshot.diff).toContain("new file mode 100644");
				expect(snapshot.diff).toContain("deleted file mode 100644");
			} finally {
				await snapshot.dispose();
			}
		}
	});

	test("preserves baseline private files removed from the index but excludes genuinely untracked private files", async () => {
		const root = await createRepository();
		const before = Buffer.from("MODE=baseline\r\nLABEL=café\r\n");
		const after = Buffer.from("\ufeffMODE=worktree\r\nLABEL=変更済み\r\n");
		await fs.writeFile(path.join(root, ".env"), before);
		await commit(root, [".env"], "baseline private configuration fixture");
		// Stage only the deletion, then restore modified worktree bytes: the same state as git rm --cached.
		await fs.rm(path.join(root, ".env"));
		await vcs.requireGit(root).stageFiles([".env"]);
		await fs.writeFile(path.join(root, ".env"), after);
		await fs.writeFile(path.join(root, ".npmrc"), "registry=https://registry.example.invalid/\n");
		const snapshot = await captureReviewExportSnapshot(root, { kind: "uncommitted" });
		try {
			const result = await writeReviewBundle(snapshot, { args: [] });
			const archive = await openArchive(result.path);
			const manifest = JSON.parse((await readMember(archive, "manifest.json")).toString("utf8"));
			for (const [version, member, expected] of [
				["base", "changed-files/before/.env", before],
				["target", "changed-files/after/.env", after],
			] as const) {
				const actual = await readMember(archive, member);
				expect(actual).toEqual(expected);
				expect(manifest.members).toContainEqual({
					member,
					bytes: actual.length,
					sha256: hash(actual),
				});
				expect(manifest.sources).toContainEqual(
					expect.objectContaining({
						path: ".env",
						version,
						member,
						originalBytes: expected.length,
						originalSha256: hash(expected),
						bytes: expected.length,
						sha256: hash(expected),
					}),
				);
			}
			expect(manifest.changes).toContainEqual(expect.objectContaining({ path: ".env", status: "M" }));
			expect(await readMember(archive, "diff.patch")).toEqual(Buffer.from(snapshot.diff));
			expect(snapshot.diff).toContain("-MODE=baseline");
			expect(snapshot.diff).toContain("+\ufeffMODE=worktree");
			expect([...archive.indexEntries()].some(entry => entry.path.endsWith("/.npmrc"))).toBe(false);
			expect(manifest.sources).not.toContainEqual(expect.objectContaining({ path: ".npmrc" }));
			const exclusion = "Excluded .npmrc: untracked private configuration (not related source).";
			for (const limitations of [snapshot.limitations, result.limitations, manifest.limitations]) {
				expect(limitations).toContain(exclusion);
				expect(limitations.some((value: string) => value.startsWith("Excluded .env:"))).toBe(false);
			}
			const readme = (await readMember(archive, "README.md")).toString("utf8");
			expect(readme).toContain(exclusion);
			expect(readme).not.toContain("Excluded .env:");
		} finally {
			await snapshot.dispose();
		}
	});

	test("a changed frozen worktree aborts publication and preserves the previous successful ZIP and unrelated staging", async () => {
		const root = await createRepository();
		await fs.writeFile(path.join(root, "source.ts"), "baseline\n");
		await commit(root, ["source.ts"], "baseline");
		await fs.writeFile(path.join(root, "source.ts"), "first successful change\n");
		const first = await captureReviewExportSnapshot(root, { kind: "uncommitted" });
		let finalPath: string;
		try {
			finalPath = (await writeReviewBundle(first, { args: [] })).path;
		} finally {
			await first.dispose();
		}
		const previous = await fs.readFile(finalPath);
		const unrelated = path.join(root, ".tmp", "review-export-other-owner");
		await fs.mkdir(unrelated);
		await fs.writeFile(path.join(unrelated, "keep"), "owned by someone else");
		const frozen = await captureReviewExportSnapshot(root, { kind: "uncommitted" });
		try {
			// Prime the real snapshot read, then alter bytes without relying on mocked callbacks.
			await frozen.readFile("source.ts");
			await fs.writeFile(path.join(root, "source.ts"), "a concurrent edit after capture\n");
			await expect(writeReviewBundle(frozen, { args: [] })).rejects.toThrow();
			expect(await fs.readFile(finalPath)).toEqual(previous);
			expect(await fs.readFile(path.join(unrelated, "keep"), "utf8")).toBe("owned by someone else");
			expect((await fs.readdir(path.join(root, ".tmp"))).sort()).toEqual([
				"review-bundle.zip",
				"review-export-other-owner",
			]);
		} finally {
			await frozen.dispose();
		}
	});

	test("exports through the command with no model or credentials, preserving code and review focus", async () => {
		const root = await createRepository();
		const before = Buffer.from("export const value = 1;\r\n");
		const after = Buffer.from('export const value = 2;\r\nconst token = "keep-literal";\r\n');
		await fs.writeFile(path.join(root, "source.ts"), before);
		await commit(root, ["source.ts"], "baseline");
		await fs.writeFile(path.join(root, "source.ts"), after);
		const errors: string[] = [];
		const context = {
			hasUI: false,
			get model() {
				throw new Error("Pure export must not access the session model");
			},
			get modelRegistry() {
				throw new Error("Pure export must not access model credentials");
			},
			ui: {
				setStatus() {},
				notify(message: string, level?: string) {
					if (level === "error") errors.push(message);
				},
			},
		} as unknown as CustomCommandContext;
		const command = new CodeReviewExportCommand({ cwd: root } as CustomCommandAPI);
		await command.execute(["Check", "ownership."], context);
		expect(errors).toEqual([]);
		const archive = await openArchive(path.join(root, ".tmp", "review-bundle.zip"));
		expect(await readMember(archive, "changed-files/before/source.ts")).toEqual(before);
		expect(await readMember(archive, "changed-files/after/source.ts")).toEqual(after);
		const diff = (await readMember(archive, "diff.patch")).toString("utf8");
		expect(diff).toContain("-export const value = 1;");
		expect(diff).toContain("+export const value = 2;");
		const manifest = JSON.parse((await readMember(archive, "manifest.json")).toString("utf8"));
		expect(manifest.instructions).toBe("Check ownership.");
	});
});
