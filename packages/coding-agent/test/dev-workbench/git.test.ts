import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { VcsGitRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { isFileLockHeld } from "@oh-my-pi/pi-utils";
import { artifactVersion } from "../../src/spec-driven/artifacts";
import { DevForgeService, devRepositoryIdentity } from "../../src/spec-driven/forge";
import { DevGitService, type DevGitRecords, sanitizeDevRemoteUrl } from "../../src/spec-driven/git";
import { readDevRequirement, saveDevRequirement } from "../../src/spec-driven/records";
import type {
	DevActionBinding,
	DevDecision,
	DevGitTarget,
	DevRequirementRecord,
	DevStoredRequirement,
} from "../../src/spec-driven/types";
import { github } from "../../src/utils/github";
import { gitlab } from "../../src/utils/gitlab";

const roots: string[] = [];
const signal = () => new AbortController().signal;
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

/** A minimal ordinary Git repository, constructed without invoking Git or accessing network credentials. */
async function initialize(directory: string, bare: boolean): Promise<void> {
	const git = bare ? directory : path.join(directory, ".git");
	for (const child of ["objects/info", "objects/pack", "refs/heads", "refs/tags"])
		await fs.mkdir(path.join(git, child), { recursive: true });
	await fs.mkdir(path.join(git, "fixture-hooks"), { recursive: true });
	await fs.writeFile(path.join(git, "HEAD"), "ref: refs/heads/main\n");
	await fs.writeFile(
		path.join(git, "config"),
		`[core]\n\trepositoryformatversion = 0\n\tbare = ${bare}\n\tautocrlf = false\n\thooksPath = fixture-hooks\n[commit]\n\tgpgsign = false\n[user]\n\tname = Workbench Fixture\n\temail = workbench@example.invalid\n`,
	);
}
function record(id = "requirement-a"): DevRequirementRecord {
	return {
		schemaVersion: 1,
		requirementId: id,
		changeId: id,
		branch: "feature",
		stage: "executing",
		lifecycle: "active",
		materials: [],
		decisions: [],
		marks: {},
		solutionBasis: null,
		report: { development: null, st: null },
		syncRevisions: [],
		gitOperations: [],
		pr: null,
		testing: "not-started",
		relatedRequirementIds: [],
	};
}
async function fixture(initialDirty = false) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "dev-git-"));
	roots.push(root);
	const cwd = path.join(root, "checkout");
	const remote = path.join(root, "remote.git");
	await initialize(cwd, false);
	await initialize(remote, true);
	const repo = vcs.requireGit(cwd);
	await fs.writeFile(path.join(cwd, "code.txt"), "one\ntwo\nthree\n");
	await fs.writeFile(path.join(cwd, "other.txt"), "unrelated baseline\n");
	await repo.stageFiles(["code.txt", "other.txt"]);
	const initial = await repo.commitCreate("fixture baseline", {
		author: { name: "Fixture", email: "fixture@example.invalid" },
	});
	await repo.remoteAdd("fixture", remote);
	await repo.push({ remote: "fixture", refspec: `${initial}:refs/heads/main`, forceWithLease: false });
	await repo.createBranch("feature", initial, false);
	await repo.checkout("feature");
	await repo.fetch("fixture", "refs/heads/main", "refs/remotes/fixture/main");
	if (initialDirty) {
		await fs.writeFile(path.join(cwd, "other.txt"), "pre-existing dirty content\n");
		await repo.stageFiles(["other.txt"]);
	}
	const stored = await saveDevRequirement(cwd, record(), null);
	const service = new DevGitService({ cwd, repo });
	await service.initializeRequirementGit("requirement-a", signal());
	const identity = devRepositoryIdentity(remote);
	const target: DevGitTarget = {
		localSourceRef: "refs/heads/feature",
		sourceRepository: identity,
		sourceRef: "refs/heads/feature",
		baseRepository: identity,
		baseRef: "refs/heads/main",
		remote: "fixture",
		remoteUrl: sanitizeDevRemoteUrl(remote),
		targetRef: "refs/heads/feature",
		observedTip: null,
	};
	return { cwd, remote, repo, initial, stored, service, target };
}
function binding(stored: DevStoredRequirement, operationId: string): DevActionBinding {
	return {
		requirementId: stored.record.requirementId,
		expectedRecordVersion: stored.recordVersion,
		expectedStage: stored.record.stage,
		files: [],
		operationId,
		expectedGeneration: null,
	};
}
function decision(value: DevActionBinding): DevDecision {
	return {
		operationId: value.operationId,
		stage: value.expectedStage,
		actor: { name: "Fixture human", source: "local" },
		at: "2026-11-07T00:00:00.000Z",
		userReply: "Commit and publish precisely this confirmed scope",
		files: value.files,
	};
}
async function prepare(f: Fixture, operationId: string, files: string[] = ["code.txt"]) {
	const stored = await readDevRequirement(f.cwd, "requirement-a");
	const versions = await Promise.all(
		files.map(async file => ({ path: file, version: artifactVersion(await fs.readFile(path.join(f.cwd, file))) })),
	);
	const actionBinding = { ...binding(stored, operationId), files: versions };
	const target = { ...f.target, observedTip: (await f.repo.remoteRef("fixture", "refs/heads/feature")).sha };
	const preview = await f.service.previewDevGitOperation(
		stored.record,
		{ binding: actionBinding, operation: "commit", target, files: versions },
		signal(),
	);
	return { preview, decision: decision(actionBinding) };
}
interface Fixture {
	cwd: string;
	remote: string;
	repo: VcsGitRepo;
	initial: string;
	stored: DevStoredRequirement;
	service: DevGitService;
	target: DevGitTarget;
}

describe("requirement-scoped native Git publication", () => {
	test("commits only confirmed paths and preserves unrelated staged content", async () => {
		const f = await fixture();
		await fs.writeFile(path.join(f.cwd, "code.txt"), "one\nowned update\nthree\n");
		await fs.writeFile(path.join(f.cwd, "other.txt"), "unrelated staged\n");
		await f.repo.stageFiles(["other.txt"]);
		const beforeUnrelated = await f.repo.diffText({ cached: true, files: ["other.txt"] });
		const prepared = await prepare(f, "commit-a");
		const result = await f.service.executeDevGitOperation(prepared.preview, prepared.decision, signal());
		expect(result.persistence.save).toBe("succeeded");
		expect(result.persistence.commit.indexReconciled).toBe(true);
		expect(result.persistence.push.status).toBe("succeeded");
		const sha = result.persistence.commit.sha!;
		expect((await f.repo.showBlob(`${sha}:other.txt`)).data.toString()).toBe("unrelated baseline\n");
		expect((await f.repo.showBlob(`${sha}:code.txt`)).data.toString()).toBe("one\nowned update\nthree\n");
		expect(await f.repo.diffText({ cached: true, files: ["other.txt"] })).toBe(beforeUnrelated);
		expect(await f.repo.diffText({ cached: true, files: ["code.txt"] })).toBe("");
		expect((await f.repo.remoteRef("fixture", "refs/heads/feature")).sha).toBe(sha);
	});
	test("publishes a business draft without approving its template or advancing the stage", async () => {
		const f = await fixture();
		await saveDevRequirement(f.cwd, { ...f.stored.record, stage: "business" }, f.stored.recordVersion);
		const draftPath = "docs/business-requirements/requirement-a.md";
		const draft = "# Unfinished interview notes\n\nStill collecting the business facts.\n";
		await fs.mkdir(path.dirname(path.join(f.cwd, draftPath)), { recursive: true });
		await fs.writeFile(path.join(f.cwd, draftPath), draft);
		const prepared = await prepare(f, "business-draft-commit", [draftPath]);
		const result = await f.service.executeDevGitOperation(prepared.preview, prepared.decision, signal());
		expect(result.persistence.push.status).toBe("succeeded");
		expect(result.snapshot.record.stage).toBe("business");
		expect(result.snapshot.record.materials).toEqual([]);
		expect(result.snapshot.record.report.development).toBeNull();
		expect(result.snapshot.record.marks).toEqual({});
		expect(result.snapshot.record.gitOperations[0].kind).toBe("commit");
		expect((await f.repo.showBlob(`${result.persistence.commit.sha}:${draftPath}`)).data.toString()).toBe(draft);
		expect((await f.repo.remoteRef("fixture", "refs/heads/feature")).sha).toBe(result.persistence.commit.sha);
	});
	test("publishes separate execution batches without report approval or stage advancement", async () => {
		const f = await fixture();
		await fs.writeFile(path.join(f.cwd, "code.txt"), "first execution batch\n");
		const firstPreview = await prepare(f, "execution-batch-one");
		const first = await f.service.executeDevGitOperation(firstPreview.preview, firstPreview.decision, signal());
		expect(first.persistence.push.status).toBe("succeeded");
		const firstSha = first.persistence.commit.sha;
		if (first.persistence.commit.status !== "succeeded" || !firstSha)
			throw new Error(JSON.stringify(first.persistence));
		await fs.writeFile(path.join(f.cwd, "code.txt"), "second execution batch\n");
		const secondPreview = await prepare(f, "execution-batch-two");
		const second = await f.service.executeDevGitOperation(secondPreview.preview, secondPreview.decision, signal());
		expect(second.persistence.push.status, JSON.stringify(second.persistence)).toBe("succeeded");
		const secondSha = second.persistence.commit.sha;
		if (second.persistence.commit.status !== "succeeded" || !secondSha)
			throw new Error(JSON.stringify(second.persistence));
		expect(secondSha).not.toBe(firstSha);
		expect((await f.repo.commitDetails(secondSha)).parents).toEqual([firstSha]);
		expect((await f.repo.showBlob(`${firstSha}:code.txt`)).data.toString()).toBe("first execution batch\n");
		expect((await f.repo.showBlob(`${secondSha}:code.txt`)).data.toString()).toBe("second execution batch\n");
		expect(second.snapshot.record.stage).toBe("executing");
		expect(second.snapshot.record.report).toEqual({ development: null, st: null });
		expect(second.snapshot.record.marks).toEqual({});
		expect(second.snapshot.record.gitOperations.map(operation => operation.kind)).toEqual(["commit", "commit"]);
		expect(second.snapshot.record.gitOperations[1].knownCommitShas).toContain(firstSha);
		expect((await f.repo.remoteRef("fixture", "refs/heads/feature")).sha).toBe(secondSha);
	});
	test("limits an explicit testing-stage commit to its own record while preserving development dirt", async () => {
		const f = await fixture();
		await saveDevRequirement(
			f.cwd,
			{ ...f.stored.record, stage: "testing", testing: "in-progress" },
			f.stored.recordVersion,
		);
		await fs.writeFile(path.join(f.cwd, "code.txt"), "another development's unstaged work\n");
		await fs.writeFile(path.join(f.cwd, "other.txt"), "another development's staged work\n");
		await f.repo.stageFiles(["other.txt"]);
		await expect(prepare(f, "testing-code-denied", ["code.txt"])).rejects.toThrow("own requirement record");
		const staged = await f.repo.diffText({ cached: true, files: ["other.txt"] });
		const prepared = await prepare(f, "testing-record-commit", []);
		const result = await f.service.executeDevGitOperation(prepared.preview, prepared.decision, signal());
		expect(result.persistence.push.status).toBe("succeeded");
		expect(result.snapshot.record.stage).toBe("testing");
		expect(result.snapshot.record.testing).toBe("in-progress");
		expect(result.snapshot.record.marks).toEqual({});
		expect(await f.repo.changedFiles({ base: f.initial, head: result.persistence.commit.sha! })).toEqual([
			"docs/dev-requirements/requirement-a.json",
		]);
		expect((await f.repo.showBlob(`${result.persistence.commit.sha}:code.txt`)).data.toString()).toBe(
			"one\ntwo\nthree\n",
		);
		expect(await fs.readFile(path.join(f.cwd, "code.txt"), "utf8")).toBe("another development's unstaged work\n");
		expect(await f.repo.diffText({ cached: true, files: ["other.txt"] })).toBe(staged);
	});
	test("denies a fresh explicit commit after completion without moving Git or rewriting the record", async () => {
		const f = await fixture();
		const completed = await saveDevRequirement(
			f.cwd,
			{ ...f.stored.record, stage: "testing", lifecycle: "completed", testing: "tested" },
			f.stored.recordVersion,
		);
		await expect(prepare(f, "completed-commit-denied", [])).rejects.toThrow("Finished requirements");
		expect((await readDevRequirement(f.cwd, "requirement-a")).recordVersion).toBe(completed.recordVersion);
		expect(await f.repo.headSha()).toBe(f.initial);
		expect((await f.repo.remoteRef("fixture", "refs/heads/feature")).sha).toBeNull();
	});
	test("settles duplicate confirmations once and rejects a competing raw decision", async () => {
		const f = await fixture();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let transitions = 0;
		const service = new DevGitService({
			cwd: f.cwd,
			repo: f.repo,
			applyDecision: async (current, accepted) => {
				transitions++;
				entered.resolve();
				await release.promise;
				return { ...current, decisions: [...current.decisions, accepted] };
			},
		});
		const prepared = await prepare(f, "concurrent-confirmation");
		const first = service.executeDevGitOperation(prepared.preview, prepared.decision, signal());
		try {
			await Promise.race([
				entered.promise,
				first.then(() => {
					throw new Error("Expected the controlled transition gate");
				}),
			]);
			await expect(
				service.executeDevGitOperation(
					prepared.preview,
					{ ...prepared.decision, userReply: "A different decision" },
					signal(),
				),
			).rejects.toThrow("Concurrent confirmation differs");
			const duplicate = service.executeDevGitOperation(prepared.preview, prepared.decision, signal());
			release.resolve();
			const [a, b] = await Promise.all([first, duplicate]);
			expect(a.persistence.push.status).toBe("succeeded");
			expect(a.persistence.commit.sha).toBe(b.persistence.commit.sha);
			expect(a.snapshot.record.decisions).toHaveLength(1);
			expect(transitions).toBe(1);
		} finally {
			release.resolve();
			await first;
		}
	});
	test("resolves its SHA from the actual record blob and parent without self-reference commits", async () => {
		const f = await fixture();
		const prepared = await prepare(f, "own-sha");
		const first = await f.service.executeDevGitOperation(prepared.preview, prepared.decision, signal());
		const sha = first.persistence.commit.sha!;
		const repeated = await f.service.resumeDevGitOperation("requirement-a", "own-sha", signal());
		expect(repeated.persistence.commit.sha).toBe(sha);
		expect(await f.repo.headSha()).toBe(sha);
		expect((await f.repo.commitDetails(sha)).parents).toEqual([f.initial]);
		expect(await f.service.getOperationCommit("requirement-a", "own-sha", signal())).toBe(sha);
		const committed = JSON.parse(
			(await f.repo.showBlob(`${sha}:docs/dev-requirements/requirement-a.json`)).data.toString(),
		) as DevRequirementRecord;
		expect(committed.gitOperations).toHaveLength(1);
		expect(committed.gitOperations[0].knownCommitShas).not.toContain(sha);
	});
	test("resolves committed operation identity without any local recovery receipt", async () => {
		const f = await fixture();
		const prepared = await prepare(f, "cold-commit-resolution");
		const result = await f.service.executeDevGitOperation(prepared.preview, prepared.decision, signal());
		expect(result.persistence.push.status).toBe("succeeded");
		await fs.rm(path.join(f.cwd, ".omp", "dev-workbench", "git-operations"), { recursive: true, force: true });
		const cold = new DevGitService({ cwd: f.cwd, repo: f.repo });
		expect(await cold.getOperationCommit("requirement-a", "cold-commit-resolution", signal())).toBe(
			result.persistence.commit.sha,
		);
		expect((await readDevRequirement(f.cwd, "requirement-a")).record.gitOperations[0].knownCommitShas).not.toContain(
			result.persistence.commit.sha,
		);
	});
	test("rejects a stale HEAD/index confirmation before saving the decision", async () => {
		const f = await fixture();
		const prepared = await prepare(f, "stale-index");
		await fs.writeFile(path.join(f.cwd, "other.txt"), "new staged state\n");
		await f.repo.stageFiles(["other.txt"]);
		const result = await f.service.executeDevGitOperation(prepared.preview, prepared.decision, signal());
		expect(result.persistence.save).toBe("failed");
		expect(await f.repo.headSha()).toBe(f.initial);
		expect((await readDevRequirement(f.cwd, "requirement-a")).record.gitOperations).toHaveLength(0);
	});
	test("reuses a contained capture directory without rebasing its preimage or relaxing document guards", async () => {
		const f = await fixture();
		const capture = await f.service.beginOwnedPaths("requirement-a", "reused-write-capture", ["code.txt"], signal());
		expect(await f.service.beginOwnedPaths("requirement-a", "reused-write-capture", ["code.txt"], signal())).toBe(
			capture,
		);
		await fs.writeFile(path.join(f.cwd, "code.txt"), "controlled document update\n");
		expect(await f.service.beginOwnedPaths("requirement-a", "reused-write-capture", ["code.txt"], signal())).toBe(
			capture,
		);
		await expect(
			f.service.beginOwnedPaths("requirement-a", "reused-write-capture", ["other.txt"], signal()),
		).rejects.toThrow("another path scope");
		await expect(
			f.service.beginOwnedPaths("requirement-a", "directory-is-not-document", ["docs"], signal()),
		).rejects.toThrow("unlinked regular file");
		await f.service.endOwnedPaths("requirement-a", capture, signal());
		const changes = await f.service.getOwnedChanges("requirement-a", signal());
		expect(changes).toHaveLength(1);
		expect(changes[0].beforeVersion).toBe(artifactVersion("one\ntwo\nthree\n"));
		expect(changes[0].afterVersion).toBe(artifactVersion("controlled document update\n"));
		const rollback = await f.repo.previewOwnedPatch(changes[0].patch, { reverse: true }, signal());
		expect(
			(await f.repo.applyOwnedPatch(changes[0].patch, { reverse: true, expected: rollback.expected }, signal()))
				.complete,
		).toBe(true);
		expect(await fs.readFile(path.join(f.cwd, "code.txt"), "utf8")).toBe("one\ntwo\nthree\n");
	});
	test("serializes concurrent owned-capture ledger updates and preserves both native cancellations", async () => {
		const f = await fixture();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let pauseNextRead = false;
		const records: DevGitRecords = {
			read: async id => {
				const stored = await readDevRequirement(f.cwd, id);
				if (pauseNextRead) {
					pauseNextRead = false;
					entered.resolve();
					await release.promise;
				}
				return stored;
			},
			save: (value, version) => saveDevRequirement(f.cwd, value, version),
			list: async () => [],
		};
		const service = new DevGitService({ cwd: f.cwd, repo: f.repo, records });
		const firstCapture = await service.beginOwnedPaths(
			"requirement-a",
			"concurrent-owned-code",
			["code.txt"],
			signal(),
		);
		const secondCapture = await service.beginOwnedPaths(
			"requirement-a",
			"concurrent-owned-other",
			["other.txt"],
			signal(),
		);
		await fs.writeFile(path.join(f.cwd, "code.txt"), "owned code descendant change\n");
		await fs.writeFile(path.join(f.cwd, "other.txt"), "owned other descendant change\n");
		pauseNextRead = true;
		const first = service.endOwnedPaths("requirement-a", firstCapture, signal());
		let second: Promise<void> | undefined;
		try {
			await Promise.race([
				entered.promise,
				first.then(() => {
					throw new Error("Expected the ownership read barrier");
				}),
			]);
			const ledgerPath = path.join(f.cwd, ".omp", "dev-workbench", "ownership", "requirement-a.json");
			expect(isFileLockHeld(ledgerPath)).toBe(true);
			second = service.endOwnedPaths("requirement-a", secondCapture, signal());
			release.resolve();
			await Promise.all([first, second]);
			const changes = await service.getOwnedChanges("requirement-a", signal());
			expect(new Set(changes.map(change => change.path))).toEqual(new Set(["code.txt", "other.txt"]));
			expect(changes).toHaveLength(2);
			for (const change of changes) {
				const preview = await f.repo.previewOwnedPatch(change.patch, { reverse: true }, signal());
				const result = await f.repo.applyOwnedPatch(
					change.patch,
					{ reverse: true, expected: preview.expected },
					signal(),
				);
				expect(result.complete).toBe(true);
			}
			expect(await fs.readFile(path.join(f.cwd, "code.txt"), "utf8")).toBe("one\ntwo\nthree\n");
			expect(await fs.readFile(path.join(f.cwd, "other.txt"), "utf8")).toBe("unrelated baseline\n");
		} finally {
			release.resolve();
			await Promise.allSettled(second ? [first, second] : [first]);
		}
	});
	test("refuses changed content without enlarging the confirmed scope", async () => {
		const f = await fixture();
		const prepared = await prepare(f, "stale-content");
		await fs.writeFile(path.join(f.cwd, "code.txt"), "different bytes\n");
		const result = await f.service.executeDevGitOperation(prepared.preview, prepared.decision, signal());
		expect(result.persistence.save).toBe("failed");
		expect(await f.repo.headSha()).toBe(f.initial);
	});
	test("rejects a changed remote tip before saving an old confirmation", async () => {
		const f = await fixture();
		const prepared = await prepare(f, "remote-tip-changed");
		const tree = (await f.repo.resolveRef(`${f.initial}^{tree}`))!;
		const remoteCommit = await f.repo.commitTree(tree, [f.initial], "independent remote update", {
			name: "Fixture",
			email: "fixture@example.invalid",
		});
		await f.repo.push({ remote: "fixture", refspec: `${remoteCommit}:refs/heads/feature`, forceWithLease: false });
		const result = await f.service.executeDevGitOperation(prepared.preview, prepared.decision, signal());
		expect(result.persistence.save).toBe("failed");
		expect(await f.repo.headSha()).toBe(f.initial);
		expect((await readDevRequirement(f.cwd, "requirement-a")).record.gitOperations).toHaveLength(0);
	});
	test("retains a successful commit and resumes only failed publication", async () => {
		const f = await fixture();
		const original = f.repo.push.bind(f.repo);
		let attempts = 0;
		Object.defineProperty(f.repo, "push", {
			configurable: true,
			value: async () => {
				attempts++;
				throw new Error("fixture disconnected before upload");
			},
		});
		const prepared = await prepare(f, "retry-push");
		const failed = await f.service.executeDevGitOperation(prepared.preview, prepared.decision, signal());
		expect(failed.persistence.commit.status).toBe("succeeded");
		expect(failed.persistence.push.status).toBe("failed");
		expect(attempts).toBe(1);
		expect(await f.service.getPendingCommitOperation("requirement-a")).toBeNull();
		Object.defineProperty(f.repo, "push", { configurable: true, value: original });
		const resumed = await f.service.resumeDevGitOperation("requirement-a", "retry-push", signal());
		expect(resumed.persistence.push.status).toBe("succeeded");
		expect(resumed.persistence.commit.sha).toBe(failed.persistence.commit.sha);
		expect((await f.repo.commitDetails(resumed.persistence.commit.sha!)).parents).toEqual([f.initial]);
	});
	test("finds a real operation commit after its native result is lost and never commits it again", async () => {
		const f = await fixture();
		const original = f.repo.commitCreateScoped.bind(f.repo);
		Object.defineProperty(f.repo, "commitCreateScoped", {
			configurable: true,
			value: async (...args: Parameters<typeof original>) => {
				await original(...args);
				throw new Error("fixture lost scoped native response");
			},
		});
		const prepared = await prepare(f, "native-result-lost");
		const first = await f.service.executeDevGitOperation(prepared.preview, prepared.decision, signal());
		expect(first.persistence.commit.status).toBe("succeeded");
		const observedHead = await f.repo.headSha();
		if (!observedHead) throw new Error("A successful scoped commit must leave a real repository HEAD");
		expect(first.persistence.commit.sha).toBe(observedHead);
		Object.defineProperty(f.repo, "commitCreateScoped", { configurable: true, value: original });
		const resumed = await f.service.resumeDevGitOperation("requirement-a", "native-result-lost", signal());
		expect(resumed.persistence.push.status).toBe("succeeded");
		expect(resumed.persistence.commit.sha).toBe(first.persistence.commit.sha);
		expect((await f.repo.commitDetails(resumed.persistence.commit.sha!)).parents).toEqual([f.initial]);
		expect(resumed.snapshot.record.decisions).toHaveLength(1);
	});
	test("observes a successful fixed-SHA upload after its response is lost", async () => {
		const f = await fixture();
		const original = f.repo.push.bind(f.repo);
		Object.defineProperty(f.repo, "push", {
			configurable: true,
			value: async (...args: Parameters<typeof original>) => {
				await original(...args);
				throw new Error("fixture lost upload response");
			},
		});
		const prepared = await prepare(f, "lost-response");
		const result = await f.service.executeDevGitOperation(prepared.preview, prepared.decision, signal());
		expect(result.persistence.push.status).toBe("succeeded");
		expect((await f.repo.remoteRef("fixture", "refs/heads/feature")).sha).toBe(result.persistence.commit.sha);
	});
	test("does not claim synchronization while post-upload remote observation is unknown", async () => {
		const f = await fixture();
		const prepared = await prepare(f, "unknown-remote");
		const originalPush = f.repo.push.bind(f.repo);
		const originalRef = f.repo.remoteRef.bind(f.repo);
		let uploaded = false;
		let pushes = 0;
		Object.defineProperty(f.repo, "push", {
			configurable: true,
			value: async (...args: Parameters<typeof originalPush>) => {
				pushes++;
				await originalPush(...args);
				uploaded = true;
			},
		});
		Object.defineProperty(f.repo, "remoteRef", {
			configurable: true,
			value: async (...args: Parameters<typeof originalRef>) => {
				if (uploaded) throw new Error("fixture remote observation unavailable");
				return originalRef(...args);
			},
		});
		const result = await f.service.executeDevGitOperation(prepared.preview, prepared.decision, signal());
		expect(result.persistence.commit.status).toBe("succeeded");
		expect(result.persistence.push.status).toBe("unknown");
		Object.defineProperty(f.repo, "remoteRef", { configurable: true, value: originalRef });
		const observed = await f.service.readDevGitOperation("requirement-a", "unknown-remote", signal());
		expect(observed.persistence.push.status).toBe("succeeded");
		expect(pushes).toBe(1);
	});
	test("never publishes an unrelated B ancestor while saving A's status", async () => {
		const f = await fixture();
		await fs.writeFile(path.join(f.cwd, "other.txt"), "requirement B private commit\n");
		await f.repo.stageFiles(["other.txt"]);
		const b = await f.repo.commitCreate("B private", {});
		const prepared = await prepare(f, "a-after-b");
		expect(prepared.preview.commitsToPublish).toContain(b);
		const result = await f.service.executeDevGitOperation(prepared.preview, prepared.decision, signal());
		expect(result.persistence.commit.status).toBe("succeeded");
		expect(result.persistence.push.status).not.toBe("succeeded");
		expect((await f.repo.remoteRef("fixture", "refs/heads/feature")).sha).toBeNull();
		expect(result.persistence.error).toContain("awaiting synchronization");
	});
	test("captures an exact controlled hunk without consuming another hunk in the same file", async () => {
		const f = await fixture();
		const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
		await fs.writeFile(path.join(f.cwd, "code.txt"), `${lines.join("\n")}\n`);
		await f.repo.stageFiles(["code.txt"]);
		const baseline = await f.repo.commitCreate("expanded fixture baseline", {});
		await f.repo.push({ remote: "fixture", refspec: `${baseline}:refs/heads/main`, forceWithLease: false });
		lines[29] = "pre-existing user staged tail";
		await fs.writeFile(path.join(f.cwd, "code.txt"), `${lines.join("\n")}\n`);
		await f.repo.stageFiles(["code.txt"]);
		const capture = await f.service.beginOwnedPaths("requirement-a", "controlled-write", ["code.txt"], signal());
		lines[0] = "owned first-line update";
		await fs.writeFile(path.join(f.cwd, "code.txt"), `${lines.join("\n")}\n`);
		await f.service.endOwnedPaths("requirement-a", capture, signal());
		await f.service.endOwnedPaths("requirement-a", capture, signal());
		const prepared = await prepare(f, "same-file-scope");
		const result = await f.service.executeDevGitOperation(prepared.preview, prepared.decision, signal());
		expect(result.persistence.commit.status).toBe("succeeded");
		const bytes = (await f.repo.showBlob(`${result.persistence.commit.sha}:code.txt`)).data.toString();
		expect(bytes).toContain("owned first-line update");
		expect(bytes).toContain("line 30\n");
		expect(bytes).not.toContain("pre-existing user staged tail");
		expect(await f.repo.diffText({ cached: true, files: ["code.txt"] })).toContain("pre-existing user staged tail");
		expect(
			(await f.service.getOwnedChanges("requirement-a", signal())).filter(change => change.layer !== "committed"),
		).toHaveLength(0);
	});
	test("read-only receipt observation never retries a failed push", async () => {
		const f = await fixture();
		let attempts = 0;
		Object.defineProperty(f.repo, "push", {
			value: async () => {
				attempts++;
				throw new Error("offline");
			},
		});
		const prepared = await prepare(f, "read-only");
		const failed = await f.service.executeDevGitOperation(prepared.preview, prepared.decision, signal());
		const before = await f.repo.headSha();
		const observed = await f.service.readDevGitOperation("requirement-a", "read-only", signal());
		expect(observed.persistence.commit.sha).toBe(failed.persistence.commit.sha);
		expect(attempts).toBe(1);
		expect(await f.repo.headSha()).toBe(before);
	});
	test("discovers an ordinary existing branch topology without custom omp configuration", async () => {
		const f = await fixture();
		const targets = await f.service.discoverDevGitTargets("requirement-a", signal());
		expect(targets).toContainEqual(f.target);
	});
	test("recovers an actually saved operation after its save response is lost", async () => {
		const f = await fixture();
		let saves = 0;
		const records: DevGitRecords = {
			read: id => readDevRequirement(f.cwd, id),
			save: async (value, version) => {
				saves++;
				await saveDevRequirement(f.cwd, value, version);
				throw new Error("fixture lost save response");
			},
			list: async () => [],
		};
		const service = new DevGitService({ cwd: f.cwd, repo: f.repo, records });
		const prepared = await prepare(f, "save-response-lost");
		const first = await service.executeDevGitOperation(prepared.preview, prepared.decision, signal());
		expect(first.persistence.save).toBe("succeeded");
		expect(first.persistence.commit.sha).toBeNull();
		expect(await service.getPendingCommitOperation("requirement-a")).toBe("save-response-lost");
		const resumed = await service.resumeDevGitOperation("requirement-a", "save-response-lost", signal());
		expect(resumed.persistence.push.status).toBe("succeeded");
		expect(saves).toBe(1);
		expect(resumed.snapshot.record.decisions).toHaveLength(1);
		expect((await f.repo.commitDetails(resumed.persistence.commit.sha!)).parents).toEqual([f.initial]);
	});
	test("separates save failure from native commit and publication", async () => {
		const f = await fixture();
		const records: DevGitRecords = {
			read: id => readDevRequirement(f.cwd, id),
			save: async () => {
				throw new Error("fixture save denied");
			},
			list: async () => [],
		};
		const service = new DevGitService({ cwd: f.cwd, repo: f.repo, records });
		const prepared = await prepare(f, "save-fails");
		const result = await service.executeDevGitOperation(prepared.preview, prepared.decision, signal());
		expect(result.persistence.save).toBe("failed");
		expect(result.persistence.commit.sha).toBeNull();
		expect(await f.repo.headSha()).toBe(f.initial);
	});
	test("binds a human test-state decision to the same committed operation", async () => {
		const f = await fixture();
		const service = new DevGitService({
			cwd: f.cwd,
			repo: f.repo,
			applyDecision: (current, accepted, operation) => {
				expect(operation).toBe("set-test-state");
				return { ...current, testing: "failed", decisions: [...current.decisions, accepted] };
			},
		});
		const actionBinding = binding(f.stored, "human-test-state");
		const accepted = decision(actionBinding);
		const preview = await service.previewDevGitOperation(
			f.stored.record,
			{ binding: actionBinding, operation: "set-test-state", target: f.target, files: [] },
			signal(),
		);
		const result = await service.executeDevGitOperation(preview, accepted, signal());
		expect(result.persistence.push.status).toBe("succeeded");
		const committed = JSON.parse(
			(
				await f.repo.showBlob(`${result.persistence.commit.sha}:docs/dev-requirements/requirement-a.json`)
			).data.toString(),
		) as DevRequirementRecord;
		expect(committed.testing).toBe("failed");
		expect(committed.decisions[0]).toEqual(accepted);
		expect(committed.gitOperations[0].kind).toBe("set-test-state");
		expect(committed.marks).toEqual({});
	});
	test("distinguishes pre-existing dirty files from new unowned writes without claiming either", async () => {
		const f = await fixture(true);
		await fs.writeFile(path.join(f.cwd, "unowned-new.txt"), "unknown shell or external writer\n");
		const conflicts = await f.service.getOwnershipConflicts("requirement-a", signal());
		expect(conflicts.map(conflict => conflict.path)).toContain("unowned-new.txt");
		expect(conflicts.some(conflict => conflict.path === "other.txt")).toBe(false);
		expect(
			(await f.service.getOwnedChanges("requirement-a", signal())).some(change => change.path === "unowned-new.txt"),
		).toBe(false);
	});
	test("preserves the saved decision when native signing fails before HEAD movement", async () => {
		const f = await fixture();
		await f.repo.configSet("commit.gpgsign", "true");
		await f.repo.configSet("gpg.program", path.join(f.cwd, "not-an-installed-signing-program"));
		const prepared = await prepare(f, "signing-failure");
		const result = await f.service.executeDevGitOperation(prepared.preview, prepared.decision, signal());
		expect(result.persistence.save).toBe("succeeded");
		expect(result.persistence.commit.status).toBe("failed");
		expect(result.persistence.commit.sha).toBeNull();
		expect(await f.repo.headSha()).toBe(f.initial);
		expect((await f.repo.remoteRef("fixture", "refs/heads/feature")).sha).toBeNull();
		expect(await f.service.getPendingCommitOperation("requirement-a")).toBe("signing-failure");
	});
	test("keeps cancellation authoritative until the exact committed tombstone is atomically published", async () => {
		const f = await fixture();
		let failFinalSave = true;
		const records: DevGitRecords = {
			read: id => readDevRequirement(f.cwd, id),
			save: async (value, version) => {
				if (value.lifecycle === "cancelled" && failFinalSave) throw new Error("fixture final publication denied");
				return saveDevRequirement(f.cwd, value, version);
			},
			list: async () => [],
		};
		const service = new DevGitService({ cwd: f.cwd, repo: f.repo, records });
		const actionBinding = binding(f.stored, "cancel-final-publish");
		const accepted = decision(actionBinding);
		const preview = await service.previewCancellation(
			f.stored.record,
			{ binding: actionBinding, target: f.target, files: [], paths: [], patch: "", stagedPatch: "" },
			signal(),
		);
		await saveDevRequirement(
			f.cwd,
			{ ...f.stored.record, lifecycle: "cancelling", decisions: [accepted] },
			f.stored.recordVersion,
		);
		const prepared = await service.executeDevGitOperation(preview, accepted, signal());
		expect(prepared.persistence.push.status, JSON.stringify(prepared.persistence)).toBe("succeeded");
		expect(prepared.snapshot.record.lifecycle).toBe("cancelling");
		const sha = prepared.persistence.commit.sha!;
		const blob = (await f.repo.showBlob(`${sha}:docs/dev-requirements/requirement-a.json`)).data;
		expect((JSON.parse(blob.toString()) as DevRequirementRecord).lifecycle).toBe("cancelled");
		const failed = await service.finalizeDevCancellation("requirement-a", "cancel-final-publish", signal());
		expect(failed.persistence.save).toBe("failed");
		expect(failed.snapshot.record.lifecycle).toBe("cancelling");
		failFinalSave = false;
		const resumed = await service.resumeDevGitOperation("requirement-a", "cancel-final-publish", signal());
		expect(resumed.persistence.commit.sha).toBe(sha);
		const final = await service.finalizeDevCancellation("requirement-a", "cancel-final-publish", signal());
		expect(final.snapshot.record.lifecycle).toBe("cancelled");
		expect(final.snapshot.recordVersion).toBe(artifactVersion(blob));
		expect(await f.repo.headSha()).toBe(sha);
		expect((await f.repo.commitDetails(sha)).parents).toEqual([f.initial]);
	});
	test("uses canonical native scope trees while binding raw CRLF worktree versions", async () => {
		const f = await fixture();
		await f.repo.configSet("core.autocrlf", "true");
		const original = "one\r\ntwo\r\nthree\r\n";
		const updated = "one\r\nowned update\r\nthree\r\n";
		await fs.writeFile(path.join(f.cwd, "code.txt"), original);
		const capture = await f.service.beginOwnedPaths("requirement-a", "crlf-owned", ["code.txt"], signal());
		await fs.writeFile(path.join(f.cwd, "code.txt"), updated);
		await f.service.endOwnedPaths("requirement-a", capture, signal());
		const prepared = await prepare(f, "crlf-commit");
		const result = await f.service.executeDevGitOperation(prepared.preview, prepared.decision, signal());
		expect(result.persistence.push.status).toBe("succeeded");
		expect((await f.repo.showBlob(`${result.persistence.commit.sha}:code.txt`)).data.toString()).toBe(
			"one\nowned update\nthree\n",
		);
		expect(await fs.readFile(path.join(f.cwd, "code.txt"), "utf8")).toBe(updated);
		const owned = (await f.service.getOwnedChanges("requirement-a", signal())).find(
			change => change.path === "code.txt",
		)!;
		const reverse = await f.repo.previewOwnedPatch(owned.patch, { reverse: true }, signal());
		expect(reverse.expected.find(file => file.path === "code.txt")).toEqual({
			path: "code.txt",
			beforeVersion: artifactVersion(updated),
			afterVersion: artifactVersion(original),
		});
	});
	test("preserves both rename endpoints in one non-audit committed ownership group", async () => {
		const f = await fixture();
		const capture = await f.service.beginOwnedPaths(
			"requirement-a",
			"owned-rename",
			["code.txt", "moved.txt"],
			signal(),
		);
		await fs.rename(path.join(f.cwd, "code.txt"), path.join(f.cwd, "moved.txt"));
		await f.service.endOwnedPaths("requirement-a", capture, signal());
		const stored = await readDevRequirement(f.cwd, "requirement-a");
		const files = [{ path: "moved.txt", version: artifactVersion(await fs.readFile(path.join(f.cwd, "moved.txt"))) }];
		const actionBinding = { ...binding(stored, "rename-commit"), files };
		const preview = await f.service.previewDevGitOperation(
			stored.record,
			{ binding: actionBinding, operation: "commit", target: f.target, files, paths: ["code.txt", "moved.txt"] },
			signal(),
		);
		const result = await f.service.executeDevGitOperation(preview, decision(actionBinding), signal());
		expect(result.persistence.push.status).toBe("succeeded");
		expect(await f.repo.lsTree(result.persistence.commit.sha!, ["code.txt", "moved.txt"])).toEqual(["moved.txt"]);
		const groups = (await f.service.getOwnedChanges("requirement-a", signal())).filter(
			change => change.layer === "committed",
		);
		expect(groups).toHaveLength(1);
		expect(new Set(groups[0].paths)).toEqual(new Set(["code.txt", "moved.txt"]));
		const reverse = await f.repo.previewOwnedPatch(groups[0].patch, { reverse: true }, signal());
		expect(new Set(reverse.expected.map(file => file.path))).toEqual(new Set(["code.txt", "moved.txt"]));
		expect(reverse.expected.find(file => file.path === "code.txt")?.afterVersion).toBe(
			artifactVersion("one\ntwo\nthree\n"),
		);
		expect(reverse.expected.find(file => file.path === "moved.txt")?.afterVersion).toBeNull();
	});
	test.each(["pre-commit", "pre-push"])("blocks an effective %s hook requirement before saving", async hookName => {
		const f = await fixture();
		const hooks = path.join(f.cwd, "owned-hooks");
		await fs.mkdir(hooks);
		const marker = path.join(f.cwd, "hook-executed");
		const hook = path.join(hooks, hookName);
		await fs.writeFile(hook, `#!/bin/sh\nprintf executed > '${marker.replaceAll("\\", "/")}'\n`);
		await fs.chmod(hook, 0o755);
		await f.repo.configSet("core.hooksPath", hooks);
		await expect(prepare(f, "hook-blocked")).rejects.toThrow(hookName);
		expect((await readDevRequirement(f.cwd, "requirement-a")).record.gitOperations).toHaveLength(0);
		expect(await f.repo.headSha()).toBe(f.initial);
		expect(await Bun.file(marker).exists()).toBe(false);
	});
});

describe("exact Forge facts and recovery", () => {
	test("queries an exact PR and never treats a closed unmerged PR as merged", async () => {
		const calls: string[][] = [];
		const runner: typeof github = {
			...github,
			async json<T>(_cwd: string, args: string[]): Promise<T> {
				calls.push(args);
				const value: unknown = JSON.parse(
					JSON.stringify({
						number: 7,
						html_url: "https://github.com/acme/repo/pull/7",
						state: "closed",
						merged: false,
						merge_commit_sha: "not-a-merge",
						head: { ref: "feature", sha: "head" },
						base: { ref: "main", sha: "base" },
					}),
				);
				return value as T;
			},
		};
		const service = new DevForgeService({ cwd: os.tmpdir(), githubRunner: runner });
		const fact = await service.observeDevPr(
			{
				forge: "github",
				repository: "github.com/acme/repo",
				number: 7,
				url: "https://github.com/acme/repo/pull/7",
				sourceRef: "feature",
				baseRef: "main",
			},
			signal(),
		);
		expect(fact.state).toBe("closed");
		expect(fact.mergeSha).toBeNull();
		expect(calls).toEqual([["api", "--hostname", "github.com", "repos/acme/repo/pulls/7"]]);
	});
	test("does not fabricate PR facts when a query fails", async () => {
		const runner: typeof github = {
			...github,
			async json<T>(): Promise<T> {
				throw new Error("fixture auth denied");
			},
		};
		const service = new DevForgeService({ cwd: os.tmpdir(), githubRunner: runner });
		await expect(
			service.observeDevPr(
				{
					forge: "github",
					repository: "github.com/acme/repo",
					number: 8,
					url: "https://github.com/acme/repo/pull/8",
					sourceRef: "feature",
					baseRef: "main",
				},
				signal(),
			),
		).rejects.toThrow("auth denied");
	});
	test("recovers a created GitHub PR after a lost create response without creating another", async () => {
		let created = false;
		let creates = 0;
		const payload = {
			number: 9,
			html_url: "https://github.com/acme/repo/pull/9",
			state: "open",
			merged: false,
			merge_commit_sha: null,
			body: "<!-- omp-requirement:req -->",
			head: { ref: "feature", sha: "head", repo: { full_name: "acme/repo" } },
			base: { ref: "main", sha: "base" },
		};
		const runner: typeof github = {
			...github,
			async json<T>(_cwd: string, args: string[]): Promise<T> {
				if (args.includes("POST")) {
					creates++;
					created = true;
					throw new Error("fixture dropped create response");
				}
				const value: unknown = args[3].includes("?") ? (created ? [payload] : []) : payload;
				return value as T;
			},
		};
		const service = new DevForgeService({ cwd: os.tmpdir(), githubRunner: runner });
		const target: DevGitTarget = {
			localSourceRef: "refs/heads/feature",
			sourceRepository: "github.com/acme/repo",
			sourceRef: "feature",
			baseRepository: "github.com/acme/repo",
			baseRef: "main",
			remote: "fixture",
			remoteUrl: "https://github.com/acme/repo.git",
			targetRef: "refs/heads/feature",
			observedTip: "head",
		};
		const input = { requirementId: "req", target, title: "Exact PR", body: "Authorized change" };
		expect((await service.createDevPr(input, signal())).pr.number).toBe(9);
		expect((await service.createDevPr(input, signal())).pr.number).toBe(9);
		expect(creates).toBe(1);
	});
	test("creates GitLab fork MRs on the actual source project and recovers a lost close response", async () => {
		const calls: string[][] = [];
		let created = false;
		let state = "opened";
		const payload = () => ({
			iid: 4,
			web_url: "https://gitlab.com/upstream/repo/-/merge_requests/4",
			state,
			source_branch: "feature",
			target_branch: "main",
			sha: "head",
			diff_refs: { head_sha: "head", base_sha: "merge-base-not-current-target" },
			merge_commit_sha: null,
			source_project_id: 11,
			description: "<!-- omp-requirement:req -->",
		});
		const runner: typeof gitlab = {
			...gitlab,
			async json<T>(_cwd: string, args: string[]): Promise<T> {
				calls.push(args);
				const endpoint = args[3];
				let value: unknown;
				if (args.includes("POST")) {
					expect(endpoint).toBe("projects/fork%2Frepo/merge_requests");
					expect(args).toContain("target_project_id=22");
					created = true;
					value = payload();
				} else if (args.includes("PUT")) {
					state = "closed";
					throw new Error("fixture dropped close response");
				} else if (endpoint.includes("/repository/branches/")) value = { commit: { id: "actual-base-tip" } };
				else if (endpoint === "projects/fork%2Frepo") value = { id: 11 };
				else if (endpoint === "projects/upstream%2Frepo") value = { id: 22 };
				else if (endpoint.includes("?")) value = created ? [payload()] : [];
				else value = payload();
				return value as T;
			},
		};
		const service = new DevForgeService({ cwd: os.tmpdir(), gitlabRunner: runner });
		const target: DevGitTarget = {
			localSourceRef: "refs/heads/feature",
			sourceRepository: "gitlab.com/fork/repo",
			sourceRef: "feature",
			baseRepository: "gitlab.com/upstream/repo",
			baseRef: "main",
			remote: "fork",
			remoteUrl: "https://gitlab.com/fork/repo.git",
			targetRef: "refs/heads/feature",
			observedTip: "head",
		};
		const fact = await service.createDevPr(
			{ requirementId: "req", target, title: "Exact MR", body: "Authorized change" },
			signal(),
		);
		expect(fact.baseSha).toBe("actual-base-tip");
		const closed = await service.closeDevPr(fact.pr, signal());
		expect(closed.state).toBe("closed");
		expect(closed.mergeSha).toBeNull();
		expect(calls.filter(args => args.includes("POST"))).toHaveLength(1);
	});
	test("redacts embedded credentials from persistent publication targets", () => {
		expect(sanitizeDevRemoteUrl("https://person:secret@example.test/acme/repo.git?token=secret")).toBe(
			"https://example.test/acme/repo.git",
		);
	});
});
