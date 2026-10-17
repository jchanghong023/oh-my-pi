import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { type ArchiveReader, encodeArchive, openArchive } from "@oh-my-pi/pi-utils/ar";
import { CodeReviewExportCommand } from "../../../src/extensibility/custom-commands/bundled/code-review-export";
import { writeReviewBundle } from "../../../src/extensibility/custom-commands/bundled/code-review-export/bundle";
import { captureReviewExportSnapshot } from "../../../src/extensibility/custom-commands/bundled/code-review-export/snapshot";
import type { CustomCommandAPI, CustomCommandContext } from "../../../src/extensibility/custom-commands/types";

const repositories: string[] = [];
const repositoryWork = new Set<Promise<void>>();

function runRepositoryWork(work: () => Promise<void>) {
	const pending = work();
	repositoryWork.add(pending);
	return pending.finally(() => repositoryWork.delete(pending));
}

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
	// Bun's test deadline does not cancel native Git work or the async test body.
	// Let owned work (including snapshot disposal) settle before removing its cwd.
	await Promise.allSettled(repositoryWork);
	await Promise.all(repositories.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
}, 60_000);

describe("code-review-export frozen bundles", () => {
	test(
		"exports exact historical versions, full diff, binary metadata and real builtin prompts",
		() =>
			runRepositoryWork(async () => {
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
			}),
		30_000,
	);

	test(
		"uses final staged-plus-unstaged and untracked bytes, excludes .tmp, and replaces the fixed ZIP",
		() =>
			runRepositoryWork(async () => {
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
			}),
		60_000,
	);

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

describe("P2-16 code-review-export headless result", () => {
	async function runHeadlessExport(
		root: string,
		mode: "text" | "json",
		messages = ["/code-review-export Check ownership."],
		withModel = false,
	) {
		const home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-review-export-home-"));
		repositories.push(home);
		const agentDir = path.join(home, "agent");
		const runtimeTemp = path.join(home, "tmp");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.mkdir(runtimeTemp, { recursive: true });
		const requests: string[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				requests.push(await request.text());
				return Response.json({ error: { message: "Export must not request a model" } }, { status: 500 });
			},
		});
		try {
			if (withModel) {
				await fs.writeFile(
					path.join(agentDir, "models.yml"),
					JSON.stringify({
						providers: {
							"export-test": {
								baseUrl: `${server.url.origin}/v1`,
								api: "openai-completions",
								auth: "none",
								models: [
									{
										id: "export-only",
										name: "Export Only",
										reasoning: false,
										input: ["text"],
										cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
										contextWindow: 131072,
										maxTokens: 1024,
									},
								],
							},
						},
					}),
				);
			}
			await fs.writeFile(
				path.join(agentDir, "config.yml"),
				JSON.stringify({
					retry: { enabled: false },
					compaction: { enabled: false },
				}),
			);
			const proc = Bun.spawn(
				[
					process.execPath,
					path.resolve(import.meta.dir, "../../../src/cli.ts"),
					"--no-session",
					"--no-title",
					"--no-lsp",
					"--no-tools",
					"--no-skills",
					"--no-rules",
					...(withModel ? ["--provider", "export-test", "--model", "export-only"] : []),
					"--print",
					"--mode",
					mode,
					...messages,
				],
				{
					cwd: root,
					env: {
						PATH: process.env.PATH,
						SystemRoot: process.env.SystemRoot,
						WINDIR: process.env.WINDIR,
						TMPDIR: runtimeTemp,
						TMP: runtimeTemp,
						TEMP: runtimeTemp,
						HOME: home,
						USERPROFILE: home,
						OMP_CONFIG_ROOT: home,
						PI_CODING_AGENT_DIR: agentDir,
						CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
						XDG_CONFIG_HOME: path.join(home, "config"),
						XDG_DATA_HOME: path.join(home, "data"),
						XDG_CACHE_HOME: path.join(home, "cache"),
						XDG_STATE_HOME: path.join(home, "state"),
						GIT_CONFIG_NOSYSTEM: "1",
						GIT_CONFIG_GLOBAL: path.join(home, "absent-gitconfig"),
						AWS_EC2_METADATA_DISABLED: "true",
						NO_COLOR: "1",
					},
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			// Only a child-process watchdog: fake time cannot terminate a genuinely stuck CLI.
			// No assertion or successful path waits for this wall-clock deadline.
			let timedOut = false;
			const timeout = setTimeout(() => {
				timedOut = true;
				proc.kill();
			}, 25_000);
			try {
				const [exitCode, stdout, stderr] = await Promise.all([
					proc.exited,
					new Response(proc.stdout).text(),
					new Response(proc.stderr).text(),
				]);
				expect(timedOut, `${stdout}\n${stderr}`).toBe(false);
				if (mode === "json") {
					for (const line of stdout.split("\n").filter(line => line.trim())) JSON.parse(line);
				}
				return { exitCode, stdout, stderr, requests };
			} finally {
				clearTimeout(timeout);
				if (proc.exitCode === null) proc.kill();
				await proc.exited;
			}
		} finally {
			await server.stop(true);
		}
	}

	test.each([
		["text", false],
		["json", false],
		["text", true],
		["json", true],
	] as const)(
		"reports the published ZIP without a model request in %s mode (configured model: %s)",
		async (mode, withModel) => {
			const root = await createRepository();
			await fs.writeFile(path.join(root, "source.ts"), "export const value = 1;\n");
			const base = await commit(root, ["source.ts"], "baseline");
			const after = Buffer.from("export const value = 2;\r\n");
			await fs.writeFile(path.join(root, "source.ts"), after);
			const run = await runHeadlessExport(root, mode, undefined, withModel);
			expect(run.requests).toEqual([]);
			expect(run.exitCode, run.stderr).toBe(0);
			const finalPath = path.join(root, ".tmp", "review-bundle.zip");
			const archive = await openArchive(finalPath);
			expect(await readMember(archive, "changed-files/after/source.ts")).toEqual(after);
			const manifest = JSON.parse((await readMember(archive, "manifest.json")).toString("utf8"));
			expect(manifest.instructions).toBe("Check ownership.");
			// Match the actual result identity, not a particular notification sentence.
			const output = `${run.stdout}\n${run.stderr}`;
			expect(output.includes(finalPath) || output.includes(JSON.stringify(finalPath).slice(1, -1))).toBe(true);
			expect(output).toContain(base);
			if (mode === "json") {
				const events = run.stdout
					.split("\n")
					.filter(Boolean)
					.map(line => JSON.parse(line));
				expect(events).toContainEqual(
					expect.objectContaining({ type: "notice", source: "custom-command:code-review-export" }),
				);
				expect(events.some(event => event.type === "agent_start" || event.type === "turn_start")).toBe(false);
			}
		},
		30_000,
	);

	test.each(["text", "json"] as const)(
		"reports a necessary-member failure with nonzero exit and preserves the old ZIP in %s mode",
		async mode => {
			const root = await createRepository();
			await fs.writeFile(path.join(root, "source.ts"), "export const value = 1;\n");
			await commit(root, ["source.ts"], "baseline");
			await fs.writeFile(path.join(root, "source.ts"), "export const value = 2;\n");
			const first = await captureReviewExportSnapshot(root, { kind: "uncommitted" });
			let finalPath: string;
			try {
				finalPath = (await writeReviewBundle(first, { args: [] })).path;
			} finally {
				await first.dispose();
			}
			const previous = await fs.readFile(finalPath);
			// Below snapshot's 32 MiB read limit but above ZIP's 16 MiB member limit.
			await fs.writeFile(path.join(root, "source.ts"), Buffer.alloc(16 * 1024 * 1024 + 1, 0x78));
			const run = await runHeadlessExport(root, mode);
			expect(run.requests).toEqual([]);
			expect(await fs.readFile(finalPath)).toEqual(previous);
			expect((await fs.readdir(path.dirname(finalPath))).sort()).toEqual(["review-bundle.zip"]);
			expect(run.exitCode, `${run.stdout}\n${run.stderr}`).not.toBe(0);
			// The caller must receive the failed member identity, not just a generic working indicator.
			expect(`${run.stdout}\n${run.stderr}`).toContain("source.ts");
			const archive = await openArchive(finalPath);
			expect(await readMember(archive, "changed-files/after/source.ts")).toEqual(
				Buffer.from("export const value = 2;\n"),
			);
		},
		30_000,
	);

	test.each(["text", "json"] as const)(
		"still rejects ordinary prompts and unresolved slash commands without a model in %s mode",
		async mode => {
			const root = await createRepository();
			await fs.writeFile(path.join(root, "source.ts"), "export const value = 1;\n");
			await commit(root, ["source.ts"], "baseline");
			for (const message of ["Check ownership.", "/not-a-local-command"]) {
				const run = await runHeadlessExport(root, mode, [message]);
				expect(run.exitCode, `${run.stdout}\n${run.stderr}`).not.toBe(0);
				expect(run.requests).toEqual([]);
				await expect(fs.stat(path.join(root, ".tmp", "review-bundle.zip"))).rejects.toMatchObject({
					code: "ENOENT",
				});
			}
		},
		60_000,
	);
});

describe("P2-17 code-review-export cancellable encoding", () => {
	test("shared ZIP encoding services repeated event-loop turns and rejects an in-flight abort", async () => {
		// Three legal 15 MiB members stay below the export's 64 MiB aggregate limit.
		// Printable deterministic entropy prevents this from becoming a tiny empty/repeated-byte compression.
		const bytes = Buffer.allocUnsafe(15 * 1024 * 1024);
		let state = 0x12345678;
		for (let index = 0; index < bytes.length; index++) {
			state ^= state << 13;
			state ^= state >>> 17;
			state ^= state << 5;
			bytes[index] = 32 + ((state >>> 0) % 95);
		}
		const members = [
			["changed-files/after/first.txt", bytes],
			["changed-files/after/second.txt", bytes],
			["changed-files/after/third.txt", bytes],
		] as const;
		// The existing two-argument function is assignable, so this regression runs
		// against the baseline as well as the proposed optional { signal } API.
		const encodeWithSignal: (
			format: Parameters<typeof encodeArchive>[0],
			entries: Parameters<typeof encodeArchive>[1],
			options: { signal: AbortSignal },
		) => Promise<Uint8Array> = encodeArchive;
		const controller = new AbortController();
		let turns = 0;
		let settled = false;
		let heartbeat: NodeJS.Immediate;
		const tick = () => {
			if (settled) return;
			turns++;
			// A single yield before synchronous deflate must not satisfy this regression.
			if (turns === 2) controller.abort(new DOMException("Cancel active ZIP encoding", "AbortError"));
			else heartbeat = setImmediate(tick);
		};
		heartbeat = setImmediate(tick);
		try {
			await expect(encodeWithSignal("zip", members, { signal: controller.signal })).rejects.toMatchObject({
				name: "AbortError",
			});
			expect(turns).toBe(2);
			expect(controller.signal.aborted).toBe(true);
		} finally {
			settled = true;
			clearImmediate(heartbeat);
		}
	}, 30_000);

	test("a timer-driven abort during bundling preserves the previous real ZIP and cleans owned staging", async () => {
		const root = await createRepository();
		await fs.writeFile(path.join(root, "source.ts"), "export const value = 1;\n");
		await commit(root, ["source.ts"], "baseline");
		await fs.writeFile(path.join(root, "source.ts"), "export const value = 2;\n");
		const first = await captureReviewExportSnapshot(root, { kind: "uncommitted" });
		let finalPath: string;
		try {
			finalPath = (await writeReviewBundle(first, { args: [] })).path;
		} finally {
			await first.dispose();
		}
		const previous = await fs.readFile(finalPath);
		await fs.writeFile(path.join(root, "source.ts"), Buffer.alloc(15 * 1024 * 1024, 0x78));
		const snapshot = await captureReviewExportSnapshot(root, { kind: "uncommitted" });
		const controller = new AbortController();
		let timer: NodeJS.Immediate | undefined;
		try {
			// Freeze real source bytes before scheduling cancellation, so capture I/O
			// cannot consume the timer and turn this into a pre-capture cancellation.
			const before = await snapshot.readFile("source.ts", "base");
			const after = await snapshot.readFile("source.ts", "target");
			const cachedSnapshot = {
				...snapshot,
				async readFile(file: string, version: "base" | "target" = "target") {
					expect(file).toBe("source.ts");
					if (version === "target") {
						timer = setImmediate(() => controller.abort(new DOMException("Cancel bundle", "AbortError")));
					}
					return version === "base" ? before : after;
				},
			};
			await expect(writeReviewBundle(cachedSnapshot, { args: [] }, controller.signal)).rejects.toMatchObject({
				name: "AbortError",
			});
			expect(controller.signal.aborted).toBe(true);
			expect(await fs.readFile(finalPath)).toEqual(previous);
			expect((await fs.readdir(path.dirname(finalPath))).sort()).toEqual(["review-bundle.zip"]);
			const archive = await openArchive(finalPath);
			expect(await readMember(archive, "changed-files/after/source.ts")).toEqual(
				Buffer.from("export const value = 2;\n"),
			);
		} finally {
			clearImmediate(timer);
			await snapshot.dispose();
		}
	}, 30_000);
});
