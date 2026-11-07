import { afterEach, describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import {
	allocateDevRequirementId,
	devRequirementPath,
	loadDevRequirements,
	occupiesDevDevelopment,
	readDevRequirement,
	resolveDevOperationCommit,
	saveDevRequirement,
	serializeDevRequirement,
	validateDevRequirementRecord,
} from "../../src/spec-driven/records";
import type { DevDecision, DevGitOperation, DevRequirementRecord } from "../../src/spec-driven/types";
import { DevWorkspace } from "../../src/spec-driven/workspace";

const roots: string[] = [];
const owners: DevWorkspace[] = [];
const sha = "a".repeat(40);
const hash = "b".repeat(64);
const actor = { name: "Records Test", source: "local" } as const;
const target = {
	localSourceRef: "refs/heads/main",
	sourceRepository: "fixture",
	sourceRef: "refs/heads/main",
	baseRepository: "fixture",
	baseRef: "refs/heads/main",
	remote: "origin",
	remoteUrl: "fixture",
	targetRef: "refs/heads/main",
	observedTip: null,
};
afterEach(async () => {
	for (const owner of owners.splice(0)) owner.release();
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-dev-records-"));
	roots.push(root);
	for (const directory of ["objects", "refs/heads", "refs/tags", "hooks"])
		await fs.mkdir(path.join(root, ".git", directory), { recursive: true });
	await fs.writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
	await fs.writeFile(
		path.join(root, ".git", "config"),
		`[core]\nrepositoryformatversion = 0\nbare = false\nautocrlf = false\nhooksPath = ${path.join(root, ".git", "hooks").replaceAll("\\", "/")}\n[user]\nname = Records Test\nemail = records@example.invalid\n[commit]\ngpgsign = false\n`,
	);
	return root;
}
function record(requirementId = "example"): DevRequirementRecord {
	return {
		schemaVersion: 1,
		requirementId,
		changeId: requirementId,
		branch: "main",
		stage: "business",
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
function decision(operationId = "merge"): DevDecision {
	return {
		operationId,
		stage: "pr",
		actor,
		at: "2026-11-07T00:00:00.000Z",
		userReply: "Mark the observed merge",
		files: [],
	};
}
function merged(value: DevRequirementRecord): DevRequirementRecord {
	value.stage = "testing";
	value.marks["pr-merged"] = decision();
	value.pr = {
		pr: {
			forge: "github",
			repository: "test/project",
			number: 1,
			url: "https://example.invalid/pr/1",
			sourceRef: "main",
			baseRef: "release",
		},
		state: "merged",
		headSha: sha,
		baseSha: sha,
		mergeSha: sha,
		observedAt: "2026-11-07T00:00:00.000Z",
	};
	return value;
}
async function owner(cwd: string): Promise<DevWorkspace> {
	const workspace = await DevWorkspace.acquire(cwd);
	owners.push(workspace);
	return workspace;
}
async function commit(cwd: string, message: string): Promise<string> {
	const repo = vcs.requireGit(cwd);
	await repo.stageFiles([devRequirementPath("example")]);
	return repo.commitCreate(message, {});
}

describe("Git requirement records", () => {
	test("cold reads ignore old state, do not take ownership and preserve exact byte versions", async () => {
		const cwd = await fixture();
		await fs.mkdir(path.join(cwd, ".omp", "dev"), { recursive: true });
		await fs.writeFile(path.join(cwd, ".omp", "dev", "state.json"), "not new state");
		expect(await loadDevRequirements(cwd)).toEqual([]);
		await expect(fs.stat(path.join(cwd, ".omp", "dev-workbench"))).rejects.toMatchObject({ code: "ENOENT" });
		const saved = await saveDevRequirement(cwd, record(), null);
		const held = await owner(cwd);
		const bytes = await fs.readFile(path.join(cwd, devRequirementPath("example")));
		expect(saved.recordVersion).toBe(crypto.createHash("sha256").update(bytes).digest("hex"));
		expect(bytes).toEqual(Buffer.from(serializeDevRequirement(saved.record)));
		expect(await readDevRequirement(cwd, "example")).toEqual(saved);
		expect(await loadDevRequirements(cwd)).toEqual([saved]);
		expect(await held.readLocal("native-state", value => value)).toBeNull();
		expect(JSON.parse(bytes.toString())).toEqual(record());
		await expect(fs.stat(path.join(cwd, ".omp", "dev-workbench", "native-state.json"))).rejects.toMatchObject({
			code: "ENOENT",
		});
		expect(await fs.readFile(path.join(cwd, ".omp", "dev", "state.json"), "utf8")).toBe("not new state");
	});

	test("CAS compares actual bytes, rejects duplicate creation and serializes retained-owner writes", async () => {
		const cwd = await fixture();
		const saved = await saveDevRequirement(cwd, record(), null);
		await expect(saveDevRequirement(cwd, record(), null)).rejects.toThrow("CAS");
		const held = await owner(cwd);
		const first = { ...saved.record, stage: "requirements" as const };
		const second = { ...saved.record, stage: "solution" as const };
		const results = await Promise.allSettled([
			held.saveRequirement(first, saved.recordVersion),
			held.saveRequirement(second, saved.recordVersion),
		]);
		expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
		const current = await readDevRequirement(cwd, "example");
		const sameRecordDifferentBytes = JSON.stringify(current.record);
		await fs.writeFile(path.join(cwd, devRequirementPath("example")), sameRecordDifferentBytes);
		await expect(held.saveRequirement(first, current.recordVersion)).rejects.toThrow("CAS");
		expect((await readDevRequirement(cwd, "example")).record).toEqual(first);
	});

	test("unknown and damaged new records produce named diagnostics without removing anything", async () => {
		const cwd = await fixture();
		await saveDevRequirement(cwd, record(), null);
		const malformed = path.join(cwd, "docs/dev-requirements/broken.json");
		const unknown = path.join(cwd, "docs/dev-requirements/future.json");
		await fs.writeFile(malformed, "{broken");
		await fs.writeFile(unknown, JSON.stringify({ ...record("future"), schemaVersion: 2 }));
		await expect(loadDevRequirements(cwd)).rejects.toThrow("broken.json");
		await expect(loadDevRequirements(cwd)).rejects.toThrow("future.json");
		expect(await fs.readFile(malformed, "utf8")).toBe("{broken");
		expect(JSON.parse(await fs.readFile(unknown, "utf8")).schemaVersion).toBe(2);
		expect((await readDevRequirement(cwd, "example")).record.requirementId).toBe("example");
	});

	test("schema excludes chat, token, body and runtime state even in nested fields", () => {
		for (const extra of [
			{ conversation: [] },
			{ confirmationToken: "secret" },
			{ runtime: {} },
			{ recordVersion: hash },
			{ content: "body" },
		])
			expect(() => validateDevRequirementRecord({ ...record(), ...extra })).toThrow("unknown field");
		expect(() =>
			validateDevRequirementRecord({
				...record(),
				report: { development: null, st: { path: "report.md", version: hash, content: "body" } },
			}),
		).toThrow("unknown field");
		expect(() =>
			validateDevRequirementRecord({
				...record(),
				materials: [{ id: "source", kind: "business", path: "../source.md", version: hash }],
			}),
		).toThrow("canonical path");
		expect(() => devRequirementPath("../other")).toThrow("identifier");
	});

	test("sync ownership and nullable expected file versions survive strict record serialization", async () => {
		const cwd = await fixture();
		const value = record();
		value.syncRevisions = [
			{
				operationId: "sync-one",
				files: [],
				mainSpecs: [],
				archivedChangePath: null,
				progress: {
					synced: true,
					targetVersions: [{ path: "openspec/specs/retired/spec.md", version: null }],
					ownership: { captureId: "capture-one", state: "pending" },
					sideEffects: {
						paths: ["openspec/specs/current/spec.md"],
						diagnostic: "Native sync ownership capture needs settlement",
						expectedVersions: [{ path: "openspec/specs/current/spec.md", version: hash }],
					},
				},
			},
		];
		const saved = await saveDevRequirement(cwd, value, null);
		expect((await readDevRequirement(cwd, value.requirementId)).record.syncRevisions).toEqual(value.syncRevisions);
		const invalidOwnership: unknown = {
			...saved.record,
			syncRevisions: [
				{ ...value.syncRevisions[0], progress: { ownership: { captureId: "capture-one", state: "finished" } } },
			],
		};
		expect(() => validateDevRequirementRecord(invalidOwnership)).toThrow("pending | settled");
	});

	test("native references and operation recovery remain local and cannot become business facts", async () => {
		const cwd = await fixture();
		const saved = await saveDevRequirement(cwd, record(), null);
		const held = await owner(cwd);
		await held.saveLocal("native-state", {
			requirementId: "example",
			sessions: { business: { sessionId: "native", sessionFile: "native.jsonl" } },
		});
		await held.saveLocal("operation-recovery", { operationId: "pending", confirmationToken: "local-only" });
		expect(await held.readLocal("operation-recovery", value => value)).toEqual({
			operationId: "pending",
			confirmationToken: "local-only",
		});
		expect(await readDevRequirement(cwd, "example")).toEqual(saved);
		await expect(held.saveLocal("../record", {})).rejects.toThrow("Unsafe");
	});

	test("review and cancelling records retain the development slot; observed merge alone does not release", async () => {
		const cwd = await fixture();
		const original = record();
		original.stage = "pr";
		const saved = await saveDevRequirement(cwd, original, null);
		await expect(saveDevRequirement(cwd, record("second"), null)).rejects.toThrow("占用");
		const cancelling = { ...saved.record, lifecycle: "cancelling" as const };
		const pending = await saveDevRequirement(cwd, cancelling, saved.recordVersion);
		await expect(saveDevRequirement(cwd, record("second"), null)).rejects.toThrow("占用");
		const observed = merged({ ...pending.record, marks: {}, lifecycle: "active" });
		observed.marks = {};
		expect(occupiesDevDevelopment(observed)).toBe(true);
		const released = merged({ ...pending.record, lifecycle: "active" });
		await saveDevRequirement(cwd, released, pending.recordVersion);
		await saveDevRequirement(cwd, record("second"), null);
		expect((await loadDevRequirements(cwd)).length).toBe(2);
	});

	test("merged testing updates only its own record while next development occupies the slot", async () => {
		const cwd = await fixture();
		const saved = await saveDevRequirement(cwd, merged(record()), null);
		await saveDevRequirement(cwd, record("second"), null);
		const failed = await saveDevRequirement(cwd, { ...saved.record, testing: "failed" }, saved.recordVersion);
		expect(failed.record.testing).toBe("failed");
		await expect(saveDevRequirement(cwd, record("third"), null)).rejects.toThrow("占用");
		expect((await readDevRequirement(cwd, "second")).record.stage).toBe("business");
	});

	test("pending local cancellation receipt retains admission when terminal Git cancellation facts exist", async () => {
		const cwd = await fixture();
		const saved = await saveDevRequirement(cwd, record(), null);
		const directory = path.join(cwd, ".omp/dev-workbench/git-operations/cancel-one");
		await fs.mkdir(directory, { recursive: true });
		const receipt = {
			state: { preview: { binding: { requirementId: "example" }, operation: "cancel" } },
			result: {
				save: "succeeded",
				commit: { status: "succeeded", indexReconciled: true },
				push: { status: "failed" },
			},
		};
		await fs.writeFile(path.join(directory, "receipt.json"), JSON.stringify(receipt));
		await saveDevRequirement(cwd, { ...saved.record, lifecycle: "cancelled" }, saved.recordVersion);
		await expect(saveDevRequirement(cwd, record("second"), null)).rejects.toThrow("未结清取消");
		receipt.result.push.status = "succeeded";
		await fs.writeFile(path.join(directory, "receipt.json"), JSON.stringify(receipt));
		await saveDevRequirement(cwd, record("second"), null);
	});

	test("cancellation remains occupied through final PR settlement even after Git effects succeed", async () => {
		const cwd = await fixture();
		const saved = await saveDevRequirement(cwd, record(), null);
		const journalDirectory = path.join(cwd, ".omp/dev-workbench/cancellations");
		const receiptDirectory = path.join(cwd, ".omp/dev-workbench/git-operations/cancel-one");
		await fs.mkdir(journalDirectory, { recursive: true });
		await fs.mkdir(receiptDirectory, { recursive: true });
		const preview = { binding: { requirementId: "example" }, operation: "cancel" };
		const journal = { plan: { preview }, started: true, complete: false };
		await fs.writeFile(path.join(journalDirectory, "cancel-one.json"), JSON.stringify(journal));
		await fs.writeFile(
			path.join(receiptDirectory, "receipt.json"),
			JSON.stringify({
				state: { preview },
				result: {
					save: "succeeded",
					commit: { status: "succeeded", indexReconciled: true },
					push: { status: "succeeded" },
				},
			}),
		);
		await saveDevRequirement(cwd, { ...saved.record, lifecycle: "cancelled" }, saved.recordVersion);
		await expect(saveDevRequirement(cwd, record("second"), null)).rejects.toThrow("未结清取消");
		journal.complete = true;
		await fs.writeFile(path.join(journalDirectory, "cancel-one.json"), JSON.stringify(journal));
		await saveDevRequirement(cwd, record("second"), null);
	});

	test("record and identity namespaces stay isolated by directory and reserve IDs across dates and tombstones", async () => {
		const cwd = await fixture();
		const other = await fixture();
		const saved = await saveDevRequirement(cwd, record(), null);
		await saveDevRequirement(cwd, { ...saved.record, lifecycle: "cancelled" }, saved.recordVersion);
		for (const relative of [
			"openspec/changes/archive/2020-01-01-example-2",
			"docs/business-requirements/example-3.md",
			"docs/superpowers/plans/2021-01-01-example-4-completion.md",
			"docs/superpowers/plans/2022-01-01-example-5-solutions.json",
		]) {
			const full = path.join(cwd, relative);
			if (path.extname(relative)) {
				await fs.mkdir(path.dirname(full), { recursive: true });
				await fs.writeFile(full, "reserved");
			} else await fs.mkdir(full, { recursive: true });
		}
		expect(await allocateDevRequirementId(cwd, "example")).toBe("example-6");
		expect(await allocateDevRequirementId(other, "example")).toBe("example");
		await saveDevRequirement(other, record(), null);
		await expect(readDevRequirement(cwd, "../example")).rejects.toThrow("identifier");
	});

	test("completed records are immutable and persistence failures never return a success", async () => {
		const cwd = await fixture();
		const completed = merged(record());
		completed.lifecycle = "completed";
		completed.testing = "tested";
		completed.marks.tested = { ...decision("tested"), stage: "testing" };
		const saved = await saveDevRequirement(cwd, completed, null);
		await expect(saveDevRequirement(cwd, saved.record, saved.recordVersion)).rejects.toThrow("read-only");
		const failedRoot = await fixture();
		await fs.mkdir(path.join(failedRoot, "docs"));
		await fs.writeFile(path.join(failedRoot, "docs", "dev-requirements"), "not a directory");
		await expect(saveDevRequirement(failedRoot, record(), null)).rejects.toThrow();
		expect(await fs.readFile(path.join(failedRoot, "docs", "dev-requirements"), "utf8")).toBe("not a directory");
	});

	test("operation SHA is resolved from actual commit record content and parent introduction", async () => {
		const cwd = await fixture();
		const operation: DevGitOperation = {
			operationId: "first-operation",
			kind: "commit",
			actor,
			at: "2026-11-07T00:00:00.000Z",
			files: [],
			target,
			authorizedCommits: [],
			knownCommitShas: [],
		};
		const initial = record();
		initial.gitOperations = [operation];
		const saved = await saveDevRequirement(cwd, initial, null);
		const firstSha = await commit(cwd, "unrelated subject without requirement or operation identity");
		const changed = {
			...saved.record,
			stage: "requirements" as const,
			gitOperations: [{ ...operation, knownCommitShas: [firstSha] }],
		};
		await saveDevRequirement(cwd, changed, saved.recordVersion);
		await commit(cwd, "example first-operation (not the operation introduction)");
		expect(await resolveDevOperationCommit(cwd, "example", "first-operation")).toBe(firstSha);
		expect(await resolveDevOperationCommit(cwd, "example", "only-mentioned-in-subject")).toBeNull();
		expect(
			JSON.parse(await fs.readFile(path.join(cwd, devRequirementPath("example")), "utf8")).gitOperations[0]
				.knownCommitShas,
		).toEqual([firstSha]);
	});
});

describe("merged record branch identity", () => {
	test("cold merged testing can update on another existing branch without changing its source identity", async () => {
		const cwd = await fixture();
		const saved = await saveDevRequirement(cwd, merged(record()), null);
		const firstSha = await commit(cwd, "example merged record");
		const repo = vcs.requireGit(cwd);
		await repo.createBranch("release", firstSha, false);
		await repo.checkout("release");
		const next = { ...record("second"), branch: "release" };
		await saveDevRequirement(cwd, next, null);
		const tested = await saveDevRequirement(cwd, { ...saved.record, testing: "failed" }, saved.recordVersion);
		expect(tested.record.branch).toBe("main");
		expect(tested.record.testing).toBe("failed");
		await expect(saveDevRequirement(cwd, record("third"), null)).rejects.toThrow("branch");
	});
});

describe("record filesystem identity", () => {
	test("subdirectories and directory aliases cold-read while another process owner remains held", async () => {
		const cwd = await fixture();
		const saved = await saveDevRequirement(cwd, record(), null);
		await fs.mkdir(path.join(cwd, "nested", "deeper"), { recursive: true });
		const parent = await fs.mkdtemp(path.join(os.tmpdir(), "omp-record-alias-"));
		roots.push(parent);
		const alias = path.join(parent, "alias");
		await fs.symlink(cwd, alias, process.platform === "win32" ? "junction" : "dir");
		const held = await owner(cwd);
		expect(await readDevRequirement(path.join(alias, "nested", "deeper"), "example")).toEqual(saved);
		const module = new URL("../../src/spec-driven/records.ts", import.meta.url).href;
		const child = Bun.spawn(
			[
				process.execPath,
				"--eval",
				`import { readDevRequirement } from ${JSON.stringify(module)}; const result = await readDevRequirement(${JSON.stringify(alias)}, "example"); console.log(result.recordVersion);`,
			],
			{ stdin: "ignore", stdout: "pipe", stderr: "pipe" },
		);
		const [code, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(stderr).toBe("");
		expect(code).toBe(0);
		expect(stdout.trim()).toBe(saved.recordVersion);
		await expect(DevWorkspace.acquire(alias)).rejects.toThrow("占用");
		held.release();
	}, 15_000);

	test("linked record directories and hard-linked records cannot redirect reads or CAS writes", async () => {
		const cwd = await fixture();
		const other = await fixture();
		await saveDevRequirement(cwd, record(), null);
		await fs.mkdir(path.join(other, "docs"), { recursive: true });
		await fs.symlink(
			path.join(cwd, "docs/dev-requirements"),
			path.join(other, "docs/dev-requirements"),
			process.platform === "win32" ? "junction" : "dir",
		);
		await expect(readDevRequirement(other, "example")).rejects.toThrow("link");
		await expect(saveDevRequirement(other, record(), null)).rejects.toThrow("link");
		await fs.link(path.join(cwd, devRequirementPath("example")), path.join(cwd, "copied-record.json"));
		await expect(readDevRequirement(cwd, "example")).rejects.toThrow("regular file");
		await expect(saveDevRequirement(cwd, record(), null)).rejects.toThrow("regular file");
		expect(JSON.parse(await fs.readFile(path.join(cwd, "copied-record.json"), "utf8")).requirementId).toBe("example");
	});
});
