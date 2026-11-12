import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type VcsGitRepo, type VcsScopedCommitOptions, vcsGitDiscover } from "../native/index.js";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

const baseline = "first\n2\n3\n4\n5\n6\n7\n8\n9\n10\n11\ntail\n";
const ownedPatch =
	"diff --git a/tracked.txt b/tracked.txt\n--- a/tracked.txt\n+++ b/tracked.txt\n@@ -1 +1 @@\n-first\n+owned\n";
const message = "requirement=fixture operation=scoped\n";

function digest(bytes: Uint8Array | string): string {
	return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

interface Fixture {
	root: string;
	repo: VcsGitRepo;
}

async function gitDirectory(directory: string, bare: boolean): Promise<void> {
	await fs.mkdir(path.join(directory, "objects"), { recursive: true });
	await fs.mkdir(path.join(directory, "refs", "heads"), { recursive: true });
	await fs.writeFile(path.join(directory, "HEAD"), "ref: refs/heads/main\n");
	await fs.writeFile(
		path.join(directory, "config"),
		`[core]\nrepositoryformatversion=0\nbare=${bare}\nautocrlf=false\ncommitGraph=true\nhooksPath=disabled-hooks\n[user]\nname=Workbench Fixture\nemail=fixture@example.test\n[commit]\ngpgsign=false\n`,
	);
}

async function repository(hooksPath?: string): Promise<Fixture> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-workbench-vcs-"));
	roots.push(root);
	await gitDirectory(path.join(root, ".git"), false);
	const repo = vcsGitDiscover(root);
	if (!repo) throw new Error("fixture repository was not discovered");
	if (hooksPath !== undefined) await repo.configSet("core.hooksPath", hooksPath);
	await fs.writeFile(path.join(root, "tracked.txt"), baseline);
	await fs.writeFile(path.join(root, "unrelated.txt"), "unrelated\n");
	await repo.stageFiles(["tracked.txt", "unrelated.txt"]);
	await repo.commitCreate("initial\n", {});
	return { root, repo };
}

async function prepare({ root, repo }: Fixture, patch = ownedPatch): Promise<VcsScopedCommitOptions> {
	const expectedHeadSha = await repo.headSha();
	if (!expectedHeadSha) throw new Error("fixture needs a born HEAD");
	const indexPath = path.join(root, ".git", "confirmed.index");
	const reconciledIndexPath = path.join(root, ".git", "reconciled.index");
	await fs.copyFile(path.join(root, ".git", "index"), reconciledIndexPath);
	await repo.readTree(expectedHeadSha, indexPath);
	await repo.applyPatch(patch, { cached: true, indexPath });
	await repo.applyPatch(patch, { cached: true, indexPath: reconciledIndexPath });
	return {
		expectedHeadRef: "refs/heads/main",
		expectedHeadSha,
		expectedIndexVersion: digest(await fs.readFile(path.join(root, ".git", "index"))),
		indexPath,
		reconciledIndexPath,
		expectedTree: await repo.writeTree(indexPath),
		files: ["tracked.txt"],
	};
}

// Native-generated indexes use v2 here. Editing a real on-disk Git flag and
// recomputing its checksum exercises preservation without spawning Git or
// pretending a plain path->blob map represents the user's index.
function entryOffset(index: Buffer, wanted: string): number {
	if (index.toString("ascii", 0, 4) !== "DIRC" || index.readUInt32BE(4) !== 2) {
		throw new Error("fixture expects a real v2 index");
	}
	let offset = 12;
	for (let count = index.readUInt32BE(8); count > 0; count--) {
		const end = index.indexOf(0, offset + 62);
		if (end < 0) throw new Error("unterminated index entry");
		if (index.toString("utf8", offset + 62, end) === wanted) return offset;
		offset += Math.ceil((end - offset + 1) / 8) * 8;
	}
	throw new Error(`missing index entry ${wanted}`);
}

async function setIndexFlags(root: string, wanted: string, transform: (flags: number) => number): Promise<void> {
	const indexPath = path.join(root, ".git", "index");
	const index = await fs.readFile(indexPath);
	const offset = entryOffset(index, wanted);
	index.writeUInt16BE(transform(index.readUInt16BE(offset + 60)), offset + 60);
	const checksum = new Bun.CryptoHasher("sha1").update(index.subarray(0, -20)).digest();
	index.set(checksum, index.length - 20);
	await fs.writeFile(indexPath, index);
}

async function flags(root: string, wanted: string): Promise<number> {
	const index = await fs.readFile(path.join(root, ".git", "index"));
	return index.readUInt16BE(entryOffset(index, wanted) + 60);
}

describe("Dev workbench native VCS consumers", () => {
	test("commits one hunk and preserves unrelated staged hunks, flags, entries and worktree bytes", async () => {
		const fixture = await repository();
		const { root, repo } = fixture;
		await fs.writeFile(path.join(root, "tracked.txt"), baseline.replace("tail", "staged-tail"));
		await fs.writeFile(path.join(root, "unrelated.txt"), "staged unrelated\n");
		await repo.stageFiles(["tracked.txt", "unrelated.txt"]);
		await setIndexFlags(root, "unrelated.txt", value => value | 0x8000);
		await setIndexFlags(root, "tracked.txt", value => value | 0x8000);
		const worktree = baseline.replace("first", "owned").replace("\n7\n", "\ndirty\n").replace("tail", "staged-tail");
		await fs.writeFile(path.join(root, "tracked.txt"), worktree);
		const options = await prepare(fixture);
		const result = await repo.commitCreateScoped(message, options);
		expect(result).toMatchObject({ refUpdated: true, indexUpdated: true });
		expect(await repo.headSha()).toBe(result.sha);
		expect((await repo.showBlob("HEAD:tracked.txt")).data.toString()).toBe(baseline.replace("first", "owned"));
		expect((await repo.showBlob("HEAD:unrelated.txt")).data.toString()).toBe("unrelated\n");
		expect(await repo.diffText({ cached: true })).toContain("+staged-tail");
		expect(await repo.diffText({ cached: true })).toContain("+staged unrelated");
		expect(await fs.readFile(path.join(root, "tracked.txt"), "utf8")).toBe(worktree);
		expect((await flags(root, "unrelated.txt")) & 0x8000).toBe(0x8000);
		expect((await flags(root, "tracked.txt")) & 0x8000).toBe(0x8000);
		const index = await fs.readFile(path.join(root, ".git", "index"));
		expect(await repo.commitCreateScoped(message, options)).toMatchObject({
			sha: result.sha,
			refUpdated: true,
			indexUpdated: true,
		});
		expect(await fs.readFile(path.join(root, ".git", "index"))).toEqual(index);
	});

	test("rejects stale index, branch, tree and unowned reconciliation before moving HEAD", async () => {
		const fixture = await repository();
		const { root, repo } = fixture;
		const options = await prepare(fixture);
		const head = await repo.headSha();
		await expect(
			repo.commitCreateScoped(message, { ...options, expectedHeadRef: "refs/heads/other" }),
		).rejects.toThrow();
		await expect(
			repo.commitCreateScoped(message, { ...options, expectedTree: await repo.writeTree() }),
		).rejects.toThrow();
		await repo.applyPatch(
			"diff --git a/unrelated.txt b/unrelated.txt\n--- a/unrelated.txt\n+++ b/unrelated.txt\n@@ -1 +1 @@\n-unrelated\n+not authorized\n",
			{ cached: true, indexPath: options.reconciledIndexPath },
		);
		await expect(repo.commitCreateScoped(message, options)).rejects.toThrow();
		await fs.writeFile(path.join(root, "unrelated.txt"), "new staged state\n");
		await repo.stageFiles(["unrelated.txt"]);
		await expect(repo.commitCreateScoped(message, options)).rejects.toThrow();
		expect(await repo.headSha()).toBe(head);
	});

	test("refuses conflicted indexes instead of dropping stage entries", async () => {
		const fixture = await repository();
		const options = await prepare(fixture);
		await setIndexFlags(fixture.root, "unrelated.txt", value => (value & ~0x3000) | 0x1000);
		options.expectedIndexVersion = digest(await fs.readFile(path.join(fixture.root, ".git", "index")));
		const index = await fs.readFile(path.join(fixture.root, ".git", "index"));
		await expect(fixture.repo.commitCreateScoped(message, options)).rejects.toThrow();
		expect(await fixture.repo.headSha()).toBe(options.expectedHeadSha);
		expect(await fs.readFile(path.join(fixture.root, ".git", "index"))).toEqual(index);
	});

	test("blocks active hooks without executing them or changing ordinary commit behavior", async () => {
		const fixture = await repository("hooks");
		const options = await prepare(fixture);
		const hooks = path.join(fixture.root, "hooks");
		await fs.mkdir(hooks);
		const hook = path.join(hooks, "pre-commit");
		await fs.writeFile(hook, "#!/bin/sh\nprintf hook > hook-ran\nexit 1\n");
		await fs.chmod(hook, 0o755);
		await fixture.repo.configSet("core.hooksPath", hooks);
		await expect(fixture.repo.commitCreateScoped(message, options)).rejects.toMatchObject({
			name: "VcsError",
			code: "Backend",
			exitCode: 1,
		});
		expect(await Bun.file(path.join(fixture.root, "hook-ran")).exists()).toBe(false);
		expect(await fixture.repo.headSha()).toBe(options.expectedHeadSha);
		await expect(fixture.repo.commitCreate("ordinary commit\n", {})).rejects.toThrow();
		expect(await Bun.file(path.join(fixture.root, "hook-ran")).exists()).toBe(true);
	});

	test("configured signer failure leaves HEAD and the real index untouched", async () => {
		const fixture = await repository();
		const options = await prepare(fixture);
		const index = await fs.readFile(path.join(fixture.root, ".git", "index"));
		await fixture.repo.configSet("commit.gpgSign", "true");
		await fixture.repo.configSet("gpg.format", "openpgp");
		await fixture.repo.configSet("gpg.program", path.join(fixture.root, "nonexistent-signer"));
		await expect(fixture.repo.commitCreateScoped(message, options)).rejects.toThrow();
		expect(await fixture.repo.headSha()).toBe(options.expectedHeadSha);
		expect(await fs.readFile(path.join(fixture.root, ".git", "index"))).toEqual(index);
	});

	test("reports an existing ref-success/index-failure and resumes only its index", async () => {
		const fixture = await repository();
		const options = await prepare(fixture);
		// Reconstruct the durable state of an interrupted two-file publication
		// using actual objects/refs, then hold the real index lock for a failure.
		const sha = await fixture.repo.commitTree(options.expectedTree, [options.expectedHeadSha], message);
		await fixture.repo.reset("soft", sha);
		const lock = path.join(fixture.root, ".git", "index.lock");
		await fs.writeFile(lock, "another writer owns this lock");
		const partial = await fixture.repo.commitCreateScoped(message, options);
		expect(partial).toMatchObject({ sha, refUpdated: true, indexUpdated: false });
		expect(partial.diagnostic).toBeTruthy();
		await fs.rm(lock);
		expect(await fixture.repo.commitCreateScoped(message, options)).toMatchObject({
			sha,
			refUpdated: true,
			indexUpdated: true,
		});
		expect(await fixture.repo.headSha()).toBe(sha);
		expect(await fixture.repo.writeTree()).toBe(options.expectedTree);
		await expect(fixture.repo.commitCreateScoped("different operation\n", options)).rejects.toThrow();
	});

	test("does not overwrite an externally changed index during index-only recovery", async () => {
		const fixture = await repository();
		const options = await prepare(fixture);
		const sha = await fixture.repo.commitTree(options.expectedTree, [options.expectedHeadSha], message);
		await fixture.repo.reset("soft", sha);
		await fs.writeFile(path.join(fixture.root, "unrelated.txt"), "external staging\n");
		await fixture.repo.stageFiles(["unrelated.txt"]);
		const index = await fs.readFile(path.join(fixture.root, ".git", "index"));
		expect(await fixture.repo.commitCreateScoped(message, options)).toMatchObject({
			sha,
			refUpdated: true,
			indexUpdated: false,
		});
		expect(await fs.readFile(path.join(fixture.root, ".git", "index"))).toEqual(index);
		expect(await fixture.repo.headSha()).toBe(sha);
	});

	test("observes exact bare-remote refs, distinguishes absence from unknown and never moves local HEAD", async () => {
		const { root, repo } = await repository();
		const remote = path.join(root, "remote.git");
		await gitDirectory(remote, true);
		const sha = await repo.headSha();
		if (!sha) throw new Error("fixture HEAD missing");
		await repo.push({ remote, refspec: `${sha}:refs/heads/main` });
		await repo.push({ remote, refspec: `${sha}:refs/heads/nested/refs/heads/missing` });
		expect(await repo.remoteRef(remote, "refs/heads/main")).toEqual({ sha });
		expect(await repo.remoteRef(remote, "refs/heads/missing")).toEqual({ sha: null });
		await expect(repo.remoteRef(path.join(root, "missing-remote"), "refs/heads/main")).rejects.toThrow();
		await expect(repo.remoteRef(remote, "main")).rejects.toThrow();
		const abort = new AbortController();
		abort.abort();
		await expect(repo.remoteRef(remote, "refs/heads/main", abort.signal)).rejects.toThrow();
		expect(await repo.headSha()).toBe(sha);
	});

	test("reads changed live remote HEAD without trusting or changing cached origin HEAD", async () => {
		const { root, repo } = await repository();
		const remote = path.join(root, "default-remote.git");
		await gitDirectory(remote, true);
		await repo.configSet("remote.origin.url", remote);
		const firstSha = await repo.headSha();
		if (!firstSha) throw new Error("fixture HEAD missing");
		await repo.push({ remote: "origin", refspec: `${firstSha}:refs/heads/main` });
		const cached = path.join(root, ".git", "refs", "remotes", "origin");
		await fs.mkdir(cached, { recursive: true });
		await fs.writeFile(path.join(cached, "main"), `${firstSha}\n`);
		await fs.writeFile(path.join(cached, "HEAD"), "ref: refs/remotes/origin/main\n");
		expect(await repo.remoteDefaultBranch("origin")).toEqual({ branch: "main", sha: firstSha });
		await fs.writeFile(path.join(root, "tracked.txt"), "new remote default\n");
		await repo.stageFiles(["tracked.txt"]);
		await repo.commitCreate("next remote default\n", {});
		const nextSha = await repo.headSha();
		if (!nextSha || nextSha === firstSha) throw new Error("fixture needs a distinct commit");
		const branch = "release/nested/default";
		await repo.push({ remote: "origin", refspec: `${nextSha}:refs/heads/${branch}` });
		await fs.writeFile(path.join(remote, "HEAD"), `ref: refs/heads/${branch}\n`);
		expect(await repo.remoteDefaultBranch("origin")).toEqual({ branch, sha: nextSha });
		expect(await repo.defaultBranch()).toBe("main");
		expect(await fs.readFile(path.join(cached, "HEAD"), "utf8")).toBe("ref: refs/remotes/origin/main\n");
		expect(await repo.headSha()).toBe(nextSha);
		const abort = new AbortController();
		abort.abort();
		await expect(repo.remoteDefaultBranch("origin", abort.signal)).rejects.toThrow();
	});

	test("rejects missing, detached and non-branch remote defaults distinctly from failed transport", async () => {
		const { root, repo } = await repository();
		const remote = path.join(root, "invalid-default-remote.git");
		await gitDirectory(remote, true);
		const sha = await repo.headSha();
		if (!sha) throw new Error("fixture HEAD missing");
		// An unborn HEAD yields a successful, empty advertisement, not a
		// transport failure and not an invented main/master branch.
		await expect(repo.remoteDefaultBranch(remote)).rejects.toMatchObject({
			name: "VcsError",
			code: "Backend",
			exitCode: 1,
		});
		await repo.push({ remote, refspec: `${sha}:refs/heads/main` });
		await fs.writeFile(path.join(remote, "HEAD"), "ref: refs/heads/missing\n");
		await expect(repo.remoteDefaultBranch(remote)).rejects.toMatchObject({
			name: "VcsError",
			code: "Backend",
			exitCode: 1,
		});
		await fs.writeFile(path.join(remote, "HEAD"), `${sha}\n`);
		await expect(repo.remoteDefaultBranch(remote)).rejects.toMatchObject({
			name: "VcsError",
			code: "Backend",
			exitCode: 1,
		});
		await repo.push({ remote, refspec: `${sha}:refs/tags/not-a-branch` });
		await fs.writeFile(path.join(remote, "HEAD"), "ref: refs/tags/not-a-branch\n");
		await expect(repo.remoteDefaultBranch(remote)).rejects.toMatchObject({
			name: "VcsError",
			code: "Backend",
			exitCode: 1,
		});
		await expect(repo.remoteDefaultBranch(path.join(root, "missing-remote"))).rejects.toMatchObject({
			name: "VcsError",
			code: "Cli",
			exitCode: 128,
		});
		await expect(repo.remoteDefaultBranch("")).rejects.toMatchObject({
			name: "VcsError",
			code: "Backend",
			exitCode: 1,
		});
		expect(await repo.headSha()).toBe(sha);
	});

	test("treats a caller deadline and a lost local advertisement as unknown, never absent", async () => {
		const { root, repo } = await repository();
		const remote = path.join(root, "network-fixture.git");
		await gitDirectory(remote, true);
		const program = path.join(root, "upload-pack-fixture.ts");
		await fs.writeFile(program, "await Bun.sleep(1000); process.exit(1);\n");
		await repo.configSet("remote.fixture.url", remote);
		await repo.configSet(
			"remote.fixture.uploadpack",
			`"${process.execPath.replaceAll("\\", "/")}" "${program.replaceAll("\\", "/")}"`,
		);
		await expect(repo.remoteRef("fixture", "refs/heads/main", AbortSignal.timeout(50))).rejects.toMatchObject({
			name: "VcsError",
			code: "Canceled",
			exitCode: 1,
		});
		await expect(repo.remoteDefaultBranch("fixture", AbortSignal.timeout(50))).rejects.toMatchObject({
			name: "VcsError",
			code: "Canceled",
			exitCode: 1,
		});
		await fs.writeFile(program, "process.exit(1);\n");
		await expect(repo.remoteRef("fixture", "refs/heads/main")).rejects.toMatchObject({
			name: "VcsError",
			code: "Cli",
			exitCode: 128,
		});
		await expect(repo.remoteDefaultBranch("fixture")).rejects.toMatchObject({
			name: "VcsError",
			code: "Cli",
			exitCode: 128,
		});
	});

	test("reports partial per-file reversal, preserves a changed preimage and resumes idempotently", async () => {
		const fixture = await repository();
		const { root, repo } = fixture;
		const patch = `${ownedPatch}diff --git a/unrelated.txt b/unrelated.txt\n--- a/unrelated.txt\n+++ b/unrelated.txt\n@@ -1 +1 @@\n-unrelated\n+owned other\n`;
		await fs.writeFile(path.join(root, "tracked.txt"), baseline.replace("first", "owned"));
		await fs.writeFile(path.join(root, "unrelated.txt"), "external edit\n");
		const expected = [
			{
				path: "tracked.txt",
				beforeVersion: digest(baseline.replace("first", "owned")),
				afterVersion: digest(baseline),
			},
			{ path: "unrelated.txt", beforeVersion: digest("owned other\n"), afterVersion: digest("unrelated\n") },
		];
		const index = await fs.readFile(path.join(root, ".git", "index"));
		const result = await repo.applyOwnedPatch(patch, { reverse: true, expected });
		expect(result.complete).toBe(false);
		expect(result.paths).toEqual([
			{ path: "tracked.txt", status: "applied", actualVersion: digest(baseline) },
			{ path: "unrelated.txt", status: "failed", actualVersion: digest("external edit\n") },
		]);
		expect(await fs.readFile(path.join(root, "unrelated.txt"), "utf8")).toBe("external edit\n");
		await fs.writeFile(path.join(root, "unrelated.txt"), "owned other\n");
		const resumed = await repo.applyOwnedPatch(patch, { reverse: true, expected });
		expect(resumed.complete).toBe(true);
		expect(resumed.paths.map(item => item.status)).toEqual(["unchanged", "applied"]);
		expect(await fs.readFile(path.join(root, ".git", "index"))).toEqual(index);
	});

	test("checks confirmed output hashes and exhaustive ownership before changing files", async () => {
		const { root, repo } = await repository();
		const result = await repo.applyOwnedPatch(ownedPatch, {
			reverse: false,
			expected: [{ path: "tracked.txt", beforeVersion: digest(baseline), afterVersion: digest("wrong output") }],
		});
		expect(result.complete).toBe(false);
		expect(result.paths[0]).toMatchObject({ status: "failed", actualVersion: digest(baseline) });
		await expect(repo.applyOwnedPatch(ownedPatch, { reverse: false, expected: [] })).rejects.toThrow();
		expect(await fs.readFile(path.join(root, "tracked.txt"), "utf8")).toBe(baseline);
	});

	test("guards both rename sides and handles null deletion postimages", async () => {
		const { root, repo } = await repository();
		const patch =
			"diff --git a/unrelated.txt b/renamed.txt\nsimilarity index 100%\nrename from unrelated.txt\nrename to renamed.txt\n";
		const expected = [
			{ path: "unrelated.txt", beforeVersion: digest("unrelated\n"), afterVersion: null },
			{ path: "renamed.txt", beforeVersion: null, afterVersion: digest("unrelated\n") },
		];
		expect((await repo.applyOwnedPatch(patch, { reverse: false, expected })).complete).toBe(true);
		expect(await Bun.file(path.join(root, "unrelated.txt")).exists()).toBe(false);
		expect(await fs.readFile(path.join(root, "renamed.txt"), "utf8")).toBe("unrelated\n");
		expect(
			(await repo.applyOwnedPatch(patch, { reverse: false, expected })).paths.every(
				item => item.status === "unchanged",
			),
		).toBe(true);
	});

	test("applies native binary patches with raw-byte guards", async () => {
		const { root, repo } = await repository();
		const before = new Uint8Array([0, 1, 2, 3, 0, 255]);
		const after = new Uint8Array([0, 9, 8, 7, 0, 254]);
		const file = path.join(root, "binary.dat");
		await fs.writeFile(file, before);
		await repo.stageFiles(["binary.dat"]);
		await repo.commitCreate("binary baseline\n", {});
		await fs.writeFile(file, after);
		const patch = await repo.diffText({ binary: true, files: ["binary.dat"] });
		const preview = await repo.previewOwnedPatch(patch, { reverse: true });
		expect(preview.expected).toEqual([
			{ path: "binary.dat", beforeVersion: digest(after), afterVersion: digest(before) },
		]);
		expect(new Uint8Array(await fs.readFile(file))).toEqual(after);
		const result = await repo.applyOwnedPatch(patch, {
			reverse: true,
			expected: preview.expected,
		});
		expect(result.complete).toBe(true);
		expect(new Uint8Array(await fs.readFile(file))).toEqual(before);
	});

	test("serializes competing confirmations without creating a second operation commit", async () => {
		const fixture = await repository();
		const options = await prepare(fixture);
		const outcomes = await Promise.allSettled(
			Array.from({ length: 6 }, () => fixture.repo.commitCreateScoped(message, options)),
		);
		const head = await fixture.repo.headSha();
		let successes = 0;
		for (const outcome of outcomes) {
			if (outcome.status === "fulfilled") {
				successes++;
				expect(outcome.value).toMatchObject({ sha: head, refUpdated: true, indexUpdated: true });
			} else {
				expect(outcome.reason).toMatchObject({ name: "VcsError" });
			}
		}
		expect(successes).toBeGreaterThan(0);
		expect(head).not.toBe(options.expectedHeadSha);
	});

	test("refuses detached and unborn HEAD without modifying the real index", async () => {
		const fixture = await repository();
		const options = await prepare(fixture);
		const headPath = path.join(fixture.root, ".git", "HEAD");
		const index = await fs.readFile(path.join(fixture.root, ".git", "index"));
		await fs.writeFile(headPath, `${options.expectedHeadSha}\n`);
		await expect(fixture.repo.commitCreateScoped(message, options)).rejects.toThrow();
		await fs.writeFile(headPath, "ref: refs/heads/unborn\n");
		await expect(fixture.repo.commitCreateScoped(message, options)).rejects.toThrow();
		expect(await fs.readFile(path.join(fixture.root, ".git", "index"))).toEqual(index);
	});

	test("resumes a rename whose target already landed without rewriting that target", async () => {
		const { root, repo } = await repository();
		const patch =
			"diff --git a/unrelated.txt b/renamed.txt\nsimilarity index 100%\nrename from unrelated.txt\nrename to renamed.txt\n";
		await fs.writeFile(path.join(root, "renamed.txt"), "unrelated\n");
		const result = await repo.applyOwnedPatch(patch, {
			reverse: false,
			expected: [
				{ path: "unrelated.txt", beforeVersion: digest("unrelated\n"), afterVersion: null },
				{ path: "renamed.txt", beforeVersion: null, afterVersion: digest("unrelated\n") },
			],
		});
		expect(result.complete).toBe(true);
		expect(result.paths).toEqual([
			{ path: "unrelated.txt", status: "applied", actualVersion: null },
			{ path: "renamed.txt", status: "unchanged", actualVersion: digest("unrelated\n") },
		]);
		expect(await Bun.file(path.join(root, "unrelated.txt")).exists()).toBe(false);
	});

	test("retains successful paths when a later path cannot be observed as a file", async () => {
		const { root, repo } = await repository();
		await fs.mkdir(path.join(root, "blocked"));
		const addition =
			"diff --git a/blocked b/blocked\nnew file mode 100644\n--- /dev/null\n+++ b/blocked\n@@ -0,0 +1 @@\n+new\n";
		const result = await repo.applyOwnedPatch(ownedPatch + addition, {
			reverse: false,
			expected: [
				{
					path: "tracked.txt",
					beforeVersion: digest(baseline),
					afterVersion: digest(baseline.replace("first", "owned")),
				},
				{ path: "blocked", beforeVersion: null, afterVersion: digest("new\n") },
			],
		});
		expect(result.complete).toBe(false);
		expect(result.paths[0]).toMatchObject({ path: "tracked.txt", status: "applied" });
		expect(result.paths[1]).toMatchObject({ path: "blocked", status: "failed" });
		expect(result.diagnostic).toBeTruthy();
		expect((await fs.stat(path.join(root, "blocked"))).isDirectory()).toBe(true);
	});

	test("never traverses a linked parent or writes Git metadata", async () => {
		const { root, repo } = await repository();
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "omp-vcs-outside-"));
		roots.push(outside);
		await fs.writeFile(path.join(outside, "protected.txt"), "original\n");
		await fs.symlink(outside, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
		const patch =
			"diff --git a/linked/protected.txt b/linked/protected.txt\n--- a/linked/protected.txt\n+++ b/linked/protected.txt\n@@ -1 +1 @@\n-original\n+overwritten\n";
		await expect(
			repo.applyOwnedPatch(patch, {
				reverse: false,
				expected: [
					{
						path: "linked/protected.txt",
						beforeVersion: digest("original\n"),
						afterVersion: digest("overwritten\n"),
					},
				],
			}),
		).rejects.toThrow();
		expect(await fs.readFile(path.join(outside, "protected.txt"), "utf8")).toBe("original\n");
		const config = await fs.readFile(path.join(root, ".git", "config"));
		await expect(
			repo.applyOwnedPatch("", {
				reverse: false,
				expected: [{ path: ".git/config", beforeVersion: digest(config), afterVersion: null }],
			}),
		).rejects.toThrow();
		expect(await fs.readFile(path.join(root, ".git", "config"))).toEqual(config);
	});

	test("previews actual CRLF checkout postimages without index, worktree or config writes", async () => {
		const { root, repo } = await repository();
		await fs.writeFile(path.join(root, ".gitattributes"), "*.txt text eol=crlf\n");
		await repo.stageFiles([".gitattributes"]);
		await repo.commitCreate("CRLF attributes\n", {});
		const after = baseline.replaceAll("\n", "\r\n");
		const before = after.replace("first", "owned");
		await fs.writeFile(path.join(root, "tracked.txt"), before);
		const patch = await repo.diffText({ files: ["tracked.txt"] });
		const index = await fs.readFile(path.join(root, ".git", "index"));
		const config = await fs.readFile(path.join(root, ".git", "config"));
		const head = await repo.headSha();
		const preview = await repo.previewOwnedPatch(patch, { reverse: true });
		expect(preview.expected).toEqual([
			{ path: "tracked.txt", beforeVersion: digest(before), afterVersion: digest(after) },
		]);
		expect(await fs.readFile(path.join(root, "tracked.txt"), "utf8")).toBe(before);
		expect(await fs.readFile(path.join(root, ".git", "index"))).toEqual(index);
		expect(await fs.readFile(path.join(root, ".git", "config"))).toEqual(config);
		expect(await repo.headSha()).toBe(head);
		expect((await repo.applyOwnedPatch(patch, { reverse: true, expected: preview.expected })).complete).toBe(true);
		expect(await fs.readFile(path.join(root, "tracked.txt"), "utf8")).toBe(after);
	});

	test("previews and applies configured clean/smudge output, rejecting even optional filter failures", async () => {
		const { root, repo } = await repository();
		const program = path.join(root, "controlled-filter.ts");
		await fs.writeFile(
			program,
			"const input = await Bun.stdin.text(); if (process.argv[2] === 'clean') { if (!input.startsWith('WT:')) process.exit(7); process.stdout.write(input.slice(3)); } else { process.stdout.write('WT:' + input); }\n",
		);
		const command = `"${process.execPath.replaceAll("\\", "/")}" "${program.replaceAll("\\", "/")}"`;
		await repo.configSet("filter.workbench.clean", `${command} clean`);
		await repo.configSet("filter.workbench.smudge", `${command} smudge`);
		await repo.configSet("filter.workbench.required", "false");
		await fs.writeFile(path.join(root, ".gitattributes"), "*.filtered filter=workbench -text\n");
		const file = path.join(root, "sample.filtered");
		const index = await fs.readFile(path.join(root, ".git", "index"));
		const privateIndex = path.join(root, ".git", "filtered-snapshot.index");
		await repo.readTree("HEAD", privateIndex);
		await fs.writeFile(file, "WT:before\n");
		await repo.stageFilesIntoIndex(["sample.filtered"], privateIndex);
		const beforeTree = await repo.writeTree(privateIndex);
		expect((await repo.showBlob(`${beforeTree}:sample.filtered`)).data.toString()).toBe("before\n");
		await fs.writeFile(file, "WT:after\n");
		await repo.stageFilesIntoIndex(["sample.filtered"], privateIndex);
		const tree = await repo.writeTree(privateIndex);
		expect((await repo.showBlob(`${tree}:sample.filtered`)).data.toString()).toBe("after\n");
		const patch = await repo.diffTree(beforeTree, tree, true);
		const preview = await repo.previewOwnedPatch(patch, { reverse: true });
		expect(preview.expected).toEqual([
			{ path: "sample.filtered", beforeVersion: digest("WT:after\n"), afterVersion: digest("WT:before\n") },
		]);
		expect(await fs.readFile(file, "utf8")).toBe("WT:after\n");
		expect(await fs.readFile(path.join(root, ".git", "index"))).toEqual(index);
		expect((await repo.applyOwnedPatch(patch, { reverse: true, expected: preview.expected })).complete).toBe(true);
		expect(await fs.readFile(file, "utf8")).toBe("WT:before\n");
		await fs.writeFile(file, "WT:after\n");
		await fs.writeFile(
			program,
			"const input = await Bun.stdin.text(); if (process.argv[2] === 'clean') process.stdout.write(input.slice(3)); else { process.stdout.write('bad output'); process.exit(9); }\n",
		);
		const config = await fs.readFile(path.join(root, ".git", "config"));
		await expect(repo.previewOwnedPatch(patch, { reverse: true })).rejects.toThrow();
		const failed = await repo.applyOwnedPatch(patch, { reverse: true, expected: preview.expected });
		expect(failed.complete).toBe(false);
		expect(failed.diagnostic).toBeTruthy();
		expect(await fs.readFile(file, "utf8")).toBe("WT:after\n");
		expect(await fs.readFile(path.join(root, ".git", "index"))).toEqual(index);
		expect(await fs.readFile(path.join(root, ".git", "config"))).toEqual(config);
		expect(await repo.configGet("filter.workbench.required")).toBe("false");
		const snapshot = await fs.readFile(privateIndex);
		await fs.writeFile(
			program,
			"await Bun.stdin.text(); process.stdout.write('bad canonical bytes'); process.exit(11);\n",
		);
		await expect(repo.stageFilesIntoIndex(["sample.filtered"], privateIndex)).rejects.toThrow();
		expect(await fs.readFile(privateIndex)).toEqual(snapshot);
		expect(await fs.readFile(path.join(root, ".git", "index"))).toEqual(index);
		expect(await fs.readFile(file, "utf8")).toBe("WT:after\n");
	});

	test("snapshots exact dirty, untracked and deleted CRLF paths into private canonical indexes only", async () => {
		const { root, repo } = await repository();
		await fs.writeFile(path.join(root, ".gitattributes"), "*.txt text eol=crlf\n");
		await repo.stageFiles([".gitattributes"]);
		await repo.commitCreate("snapshot attributes\n", {});
		const real = path.join(root, ".git", "index");
		const index = await fs.readFile(real);
		const first = path.join(root, ".git", "before.index");
		const second = path.join(root, ".git", "after.index");
		const replay = path.join(root, ".git", "replay.index");
		await repo.readTree("HEAD", first);
		await repo.readTree("HEAD", second);
		const dirty = baseline.replace("first", "preexisting dirty");
		await fs.writeFile(path.join(root, "tracked.txt"), dirty.replaceAll("\n", "\r\n"));
		await fs.writeFile(path.join(root, "new.txt"), "new before\r\n");
		await fs.rm(path.join(root, "unrelated.txt"));
		const scope = ["tracked.txt", "new.txt", "unrelated.txt"];
		await repo.stageFilesIntoIndex(scope, first);
		const before = await repo.writeTree(first);
		expect((await repo.showBlob(`${before}:tracked.txt`)).data.toString()).toBe(dirty);
		expect((await repo.showBlob(`${before}:new.txt`)).data.toString()).toBe("new before\n");
		expect(await repo.lsTree(before, ["unrelated.txt"])).toEqual([]);
		const changed = dirty.replace("\n7\n", "\nowned\n").replaceAll("\n", "\r\n");
		await fs.writeFile(path.join(root, "tracked.txt"), changed);
		await fs.writeFile(path.join(root, "new.txt"), "new after\r\n");
		await repo.stageFilesIntoIndex(scope, second);
		const after = await repo.writeTree(second);
		const patch = await repo.diffTree(before, after, true);
		await repo.readTree(before, replay);
		await repo.applyPatch(patch, { cached: true, indexPath: replay });
		expect(await repo.writeTree(replay)).toBe(after);
		expect(await fs.readFile(real)).toEqual(index);
		expect(await fs.readFile(path.join(root, "tracked.txt"), "utf8")).toBe(changed);
		expect(await fs.readFile(path.join(root, "new.txt"), "utf8")).toBe("new after\r\n");
		const snapshot = await fs.readFile(second);
		await repo.stageFilesIntoIndex([], second);
		expect(await fs.readFile(second)).toEqual(snapshot);
		await expect(repo.stageFilesIntoIndex(["tracked.txt"], real)).rejects.toThrow();
		await expect(repo.stageFilesIntoIndex([".git/config"], second)).rejects.toThrow();
		const lock = `${second}.lock`;
		await fs.writeFile(lock, "another snapshot writer");
		await expect(repo.stageFilesIntoIndex(["tracked.txt"], second)).rejects.toThrow();
		await fs.rm(lock);
		expect(await fs.readFile(second)).toEqual(snapshot);
		expect(await fs.readFile(real)).toEqual(index);
	});

	test("resolves effective pre-push hooks without running them and blocks before a scoped commit", async () => {
		const fixture = await repository();
		const { root, repo } = fixture;
		const options = await prepare(fixture);
		expect(await repo.hookPath("pre-push")).toBeNull();
		const hooks = path.join(root, "required-hooks");
		await fs.mkdir(hooks);
		const hook = path.join(hooks, "pre-push");
		await fs.writeFile(hook, "#!/bin/sh\nprintf unexpected > push-hook-ran\n");
		await fs.chmod(hook, 0o755);
		await repo.configSet("core.hooksPath", "required-hooks");
		expect(await repo.hookPath("pre-push")).toBe(hook);
		const index = await fs.readFile(path.join(root, ".git", "index"));
		await expect(repo.commitCreateScoped(message, options)).rejects.toMatchObject({
			name: "VcsError",
			code: "Backend",
			exitCode: 1,
		});
		expect(await repo.headSha()).toBe(options.expectedHeadSha);
		expect(await fs.readFile(path.join(root, ".git", "index"))).toEqual(index);
		expect(await Bun.file(path.join(root, "push-hook-ran")).exists()).toBe(false);
		await expect(repo.hookPath("../pre-push")).rejects.toThrow();
		if (process.platform !== "win32") {
			await fs.chmod(hook, 0o644);
			expect(await repo.hookPath("pre-push")).toBeNull();
		}
	});

	test("keeps strict hook-resolution failures out of ordinary commit behavior", async () => {
		const fixture = await repository();
		const { root, repo } = fixture;
		const options = await prepare(fixture);
		await repo.configSet("core.hooksPath", ":(optional)missing-hooks");
		await expect(repo.hookPath("pre-commit")).rejects.toThrow();
		await expect(repo.commitCreateScoped(message, options)).rejects.toThrow();
		await fs.writeFile(path.join(root, "tracked.txt"), baseline.replace("first", "ordinary"));
		await repo.stageFiles(["tracked.txt"]);
		const sha = await repo.commitCreate("ordinary native behavior\n", {});
		expect(await repo.headSha()).toBe(sha);
		expect((await repo.showBlob(`${sha}:tracked.txt`)).data.toString()).toBe(baseline.replace("first", "ordinary"));
		expect(await repo.configGet("core.hooksPath")).toBe(":(optional)missing-hooks");
	});

	test("walks real commit ancestry without creating an optional commit-graph cache", async () => {
		const { root, repo } = await repository();
		const base = await repo.headSha();
		if (!base) throw new Error("fixture HEAD missing");
		const info = path.join(root, ".git", "objects", "info");
		await expect(fs.stat(info)).rejects.toMatchObject({ code: "ENOENT" });
		await fs.writeFile(path.join(root, "tracked.txt"), baseline.replace("first", "descendant"));
		await repo.stageFiles(["tracked.txt"]);
		const tip = await repo.commitCreate("descendant without commit-graph\n", {});
		expect(await repo.mergeBase(base, tip)).toBe(base);
		expect(await repo.mergeBase(tip, base)).toBe(base);
		const unrelated = await repo.commitTree(await repo.writeTree(), [], "independent root\n");
		expect(await repo.mergeBase(tip, unrelated)).toBeNull();
		await expect(repo.mergeBase(tip, "missing-commit")).rejects.toThrow();
		await expect(fs.stat(info)).rejects.toMatchObject({ code: "ENOENT" });
		// An existing invalid graph path is not the optional-absence case.
		await fs.writeFile(info, new Uint8Array(64));
		await expect(repo.mergeBase(base, tip)).rejects.toThrow();
	});
});
