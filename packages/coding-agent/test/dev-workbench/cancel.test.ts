import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { artifactVersion } from "../../src/spec-driven/artifacts";
import { DevCancellationService, type DevCancellationOptions } from "../../src/spec-driven/cancel";
import { devRepositoryIdentity } from "../../src/spec-driven/forge";
import { DevGitService, type DevOwnedChange } from "../../src/spec-driven/git";
import { readDevRequirement, saveDevRequirement } from "../../src/spec-driven/records";
import type {
	DevActionBinding,
	DevActionResult,
	DevCancelPlan,
	DevDecision,
	DevGitTarget,
	DevPrFact,
	DevRequirementRecord,
	DevRequirementSnapshot,
} from "../../src/spec-driven/types";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

type Tree = Map<string, string>;
interface Edit {
	path: string;
	before: string | null;
	after: string | null;
}
const target: DevGitTarget = {
	localSourceRef: "refs/heads/development",
	sourceRepository: "example/repo",
	sourceRef: "refs/heads/development",
	baseRepository: "example/repo",
	baseRef: "refs/heads/main",
	remote: "origin",
	remoteUrl: "https://example.test/repo.git",
	targetRef: "refs/heads/development",
	observedTip: "C4",
};
const pr: DevPrFact = {
	pr: {
		forge: "github",
		repository: "example/repo",
		number: 7,
		url: "https://example.test/repo/pull/7",
		sourceRef: "development",
		baseRef: "main",
	},
	state: "open",
	headSha: "C4",
	baseSha: "C0",
	mergeSha: null,
	observedAt: "2026-11-07T00:00:00Z",
};
function hash(content: string | null): string | null {
	return content === null ? null : artifactVersion(content);
}
function record(): DevRequirementRecord {
	return {
		schemaVersion: 1,
		requirementId: "cancel-fixture",
		changeId: "cancel-fixture",
		branch: "development",
		stage: "pr",
		lifecycle: "active",
		materials: [
			{
				id: "proposal",
				kind: "proposal",
				path: "openspec/changes/archive/cancel-fixture/proposal.md",
				version: artifactVersion("proposal\n"),
			},
		],
		decisions: [],
		marks: {},
		solutionBasis: null,
		report: { development: null, st: null },
		syncRevisions: [],
		gitOperations: [],
		pr: structuredClone(pr),
		testing: "not-started",
		relatedRequirementIds: [],
	};
}

/** Injected native/Forge ports exercise recovery policy, not Git's patch implementation. */
async function fixture() {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cancel-policy-"));
	directories.push(cwd);
	const events: string[] = [];
	const trees = new Map<string, Tree>();
	const indexes = new Map<string, Tree>();
	const edits = new Map<string, Edit[]>();
	const base: Tree = new Map([
		["code.txt", "base\n"],
		["openspec/specs/example/spec.md", "original spec\n"],
		["shared.txt", "existing user content\n"],
	]);
	trees.set("C0", base);
	const changes: DevOwnedChange[] = [];
	function add(
		id: string,
		layer: DevOwnedChange["layer"],
		edit: Edit,
		commitSha: string | null,
		parentSha: string | null,
	): void {
		edits.set(id, [edit]);
		changes.push({
			id,
			path: edit.path,
			layer,
			patch: id,
			beforeVersion: hash(edit.before),
			afterVersion: hash(edit.after),
			baselineIndexVersion: "original-index",
			committedShas: commitSha ? [commitSha] : [],
			commitSha,
			parentSha,
		});
	}
	function apply(tree: Tree, operations: Edit[], reverse: boolean): void {
		for (const edit of operations) {
			const before = reverse ? edit.after : edit.before;
			const after = reverse ? edit.before : edit.after;
			const actual = tree.get(edit.path) ?? null;
			if (actual === before) {
				if (after === null) tree.delete(edit.path);
				else tree.set(edit.path, after);
			} else if (actual !== null && before !== null && after !== null && actual.includes(before))
				tree.set(edit.path, actual.replace(before, after));
			else throw new Error(`Overlapping patch: ${edit.path}`);
		}
	}
	function snapshot(from: string, to: string, operations: Edit[]): void {
		const tree = new Map(trees.get(from)!);
		apply(tree, operations, false);
		trees.set(to, tree);
	}
	add(
		"document",
		"committed",
		{ path: "openspec/changes/cancel-fixture/proposal.md", before: null, after: "proposal\n" },
		"C1",
		"C0",
	);
	snapshot("C0", "C1", edits.get("document")!);
	add("code-1", "committed", { path: "code.txt", before: "base\n", after: "code-1\n" }, "C2", "C1");
	snapshot("C1", "C2", edits.get("code-1")!);
	add("code-2", "committed", { path: "code.txt", before: "code-1\n", after: "code-2\n" }, "C3", "C2");
	snapshot("C2", "C3", edits.get("code-2")!);
	add(
		"archive-add",
		"committed",
		{ path: "openspec/changes/archive/cancel-fixture/proposal.md", before: null, after: "proposal\n" },
		"C4",
		"C3",
	);
	add(
		"archive-remove",
		"committed",
		{ path: "openspec/changes/cancel-fixture/proposal.md", before: "proposal\n", after: null },
		"C4",
		"C3",
	);
	add(
		"main-spec",
		"committed",
		{ path: "openspec/specs/example/spec.md", before: "original spec\n", after: "updated spec\n" },
		"C4",
		"C3",
	);
	snapshot(
		"C3",
		"C4",
		["archive-add", "archive-remove", "main-spec"].flatMap(id => edits.get(id)!),
	);
	const archiveChanges = changes.filter(change => change.commitSha === "C4");
	edits.set(
		"archive-sync-group",
		["archive-add", "archive-remove", "main-spec"].flatMap(id => edits.get(id)!),
	);
	changes.splice(
		changes.findIndex(change => change.commitSha === "C4"),
		archiveChanges.length,
		{
			...archiveChanges[0]!,
			id: "archive-sync-group",
			patch: "archive-sync-group",
			paths: archiveChanges.map(change => change.path),
		},
	);
	add("staged", "staged", { path: "code.txt", before: "code-2\n", after: "staged\n" }, null, null);
	add("unstaged", "unstaged", { path: "code.txt", before: "staged\n", after: "unstaged\n" }, null, null);
	add("untracked", "untracked", { path: "owned-new.md", before: null, after: "owned new\n" }, null, null);
	add(
		"untracked-edit",
		"unstaged",
		{ path: "owned-new.md", before: "owned new\n", after: "owned new revised\n" },
		null,
		null,
	);
	const staged = new Map(trees.get("C4")!);
	apply(staged, edits.get("staged")!, false);
	staged.set("shared.txt", "unrelated staged user content\n");
	const working = new Map(staged);
	apply(working, edits.get("unstaged")!, false);
	apply(working, edits.get("untracked")!, false);
	apply(working, edits.get("untracked-edit")!, false);
	working.set("code.txt", "unstaged\nunrelated later line\n");
	working.set("foreign.md", "external import source\n");
	for (const [file, content] of working) {
		await fs.mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
		await fs.writeFile(path.join(cwd, file), content);
	}
	function delta(before: Tree, after: Tree): Edit[] {
		return [...new Set([...before.keys(), ...after.keys()])]
			.filter(file => before.get(file) !== after.get(file))
			.map(file => ({ path: file, before: before.get(file) ?? null, after: after.get(file) ?? null }));
	}
	let serial = 0;
	function patch(operations: Edit[]): string {
		if (!operations.length) return "";
		const id = `patch-${++serial}`;
		edits.set(id, operations);
		return id;
	}
	let state = record();
	let version = artifactVersion(JSON.stringify(state));
	let prState = structuredClone(pr);
	let observeCount = 0;
	let failPath: string | null = null;
	let stopFailure = false;
	let closeResponseLost = false;
	let mergedAtObservation: number | null = null;
	let publicationFailure = false;
	let stopBarrier: Promise<void> | null = null;
	let executeCount = 0;
	let resumeCount = 0;
	const appliedPaths: string[] = [];
	const commits = ["C0", "C1", "C2", "C3", "C4"];
	const repo: DevCancellationOptions["repo"] = {
		headSha: async () => "C4",
		currentBranch: async () => "development",
		commitDetails: async sha => ({
			sha,
			parents: sha === "C0" ? [] : [commits[commits.indexOf(sha) - 1]],
			author: { name: "Fixture", email: "fixture@example.test" },
			message: sha,
		}),
		mergeBase: async (a, b) => commits[Math.min(commits.indexOf(a), commits.indexOf(b))],
		readTree: async (tree, index) => {
			indexes.set(index!, new Map(trees.get(tree)!));
			return undefined;
		},
		stageFilesIntoIndex: async (files, index) => {
			const tree = indexes.get(index)!;
			for (const file of files) {
				try {
					tree.set(file, await fs.readFile(path.join(cwd, file), "utf8"));
				} catch (error) {
					if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
					tree.delete(file);
				}
			}
			return undefined;
		},
		writeTree: async index => {
			const id = `tree-${++serial}`;
			trees.set(id, new Map(indexes.get(index!)!));
			return id;
		},
		diffText: async options =>
			patch(
				delta(
					trees.get("C4")!,
					options.cached ? staged : new Map([...working].filter(([file]) => trees.get("C4")!.has(file))),
				),
			),
		diffTree: async (before, after) => patch(delta(trees.get(before)!, trees.get(after)!)),
		changedFiles: async options => delta(trees.get(options.base!)!, trees.get(options.head!)!).map(edit => edit.path),
		applyPatch: async (id, options) => {
			if (id) apply(indexes.get(options.indexPath!)!, edits.get(id)!, options.reverse ?? false);
			return undefined;
		},
		canApplyPatch: async (id, options) => {
			try {
				apply(new Map(indexes.get(options.indexPath!)!), edits.get(id)!, options.reverse ?? false);
				return true;
			} catch {
				return false;
			}
		},
		previewOwnedPatch: async (id, options) => {
			const operations = edits.get(id)!;
			return {
				expected: operations.map(edit => ({
					path: edit.path,
					beforeVersion: hash(options.reverse ? edit.after : edit.before),
					afterVersion: hash(options.reverse ? edit.before : edit.after),
				})),
			};
		},
		applyOwnedPatch: async (id, options) => {
			events.push(`apply:${id}`);
			const results: Array<{
				path: string;
				status: "applied" | "unchanged" | "failed";
				actualVersion: string | null;
			}> = [];
			for (const expected of options.expected) {
				const file = path.join(cwd, expected.path);
				let actual: string | null = null;
				try {
					actual = await fs.readFile(file, "utf8");
				} catch (error) {
					if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
				}
				if (hash(actual) === expected.afterVersion) {
					results.push({ path: expected.path, status: "unchanged", actualVersion: hash(actual) });
					continue;
				}
				if (failPath === expected.path) {
					failPath = null;
					results.push({ path: expected.path, status: "failed", actualVersion: hash(actual) });
					continue;
				}
				if (hash(actual) !== expected.beforeVersion) {
					results.push({ path: expected.path, status: "failed", actualVersion: hash(actual) });
					continue;
				}
				const tree: Tree = new Map(actual === null ? [] : [[expected.path, actual]]);
				apply(
					tree,
					edits.get(id)!.filter(edit => edit.path === expected.path),
					options.reverse,
				);
				if (tree.has(expected.path)) {
					await fs.mkdir(path.dirname(file), { recursive: true });
					await fs.writeFile(file, tree.get(expected.path)!);
				} else await fs.rm(file);
				appliedPaths.push(expected.path);
				results.push({
					path: expected.path,
					status: "applied",
					actualVersion: hash(tree.get(expected.path) ?? null),
				});
			}
			return {
				paths: results,
				complete: results.every(result => result.status !== "failed"),
				diagnostic: results.some(result => result.status === "failed") ? "fixture path conflict" : undefined,
			};
		},
	};
	const snapshotState = (): DevRequirementSnapshot => ({
		record: structuredClone(state),
		recordVersion: version,
		runtime: null,
		actions: [],
	});
	function success(): DevActionResult {
		return {
			snapshot: snapshotState(),
			persistence: {
				save: "succeeded",
				commit: { status: "succeeded", sha: "compensation", indexReconciled: true },
				push: { status: "succeeded", target },
			},
		};
	}
	function publish(): DevActionResult {
		if (publicationFailure)
			return {
				snapshot: snapshotState(),
				persistence: {
					save: "succeeded",
					commit: { status: "succeeded", sha: "compensation", indexReconciled: true },
					push: { status: "failed", target },
					error: "publication unavailable",
				},
			};
		return success();
	}
	const options: DevCancellationOptions = {
		cwd,
		repo,
		stop: async () => {
			events.push("stop");
			if (stopFailure) throw new Error("native cleanup pending");
			if (stopBarrier) await stopBarrier;
			events.push("settled");
		},
		snapshot: async () => snapshotState(),
		records: {
			read: async () => ({ record: structuredClone(state), recordVersion: version }),
			save: async (next, expected) => {
				if (expected !== version) throw new Error("CAS mismatch");
				state = structuredClone(next);
				version = artifactVersion(JSON.stringify(state));
				events.push(`save:${state.lifecycle}`);
				return { record: structuredClone(state), recordVersion: version };
			},
		},
		forge: {
			observe: async () => {
				events.push("observe");
				observeCount++;
				if (mergedAtObservation === observeCount) prState = { ...prState, state: "merged", mergeSha: "merge" };
				return structuredClone(prState);
			},
			close: async () => {
				events.push("close");
				prState = { ...prState, state: "closed" };
				if (closeResponseLost) throw new Error("close response lost");
				return structuredClone(prState);
			},
		},
		git: {
			getOwnedChanges: async () => structuredClone(changes),
			getOwnershipConflicts: async () => [],
			previewCancellation: async (_record, input) => {
				events.push("preview");
				return {
					previewId: `preview-${input.binding.operationId}`,
					binding: input.binding,
					headSha: "C4",
					indexVersion: "original-index",
					files: input.files,
					patchHash: artifactVersion(input.patch),
					target,
					proposedTree: "compensated-tree",
					commitsToPublish: [],
					operation: "cancel",
					cancellation: input.cancellation,
				};
			},
			executeDevGitOperation: async () => {
				executeCount++;
				events.push("publish");
				return publish();
			},
			resumeDevGitOperation: async () => {
				resumeCount++;
				events.push("resume");
				return publish();
			},
			finalizeDevCancellation: async () => {
				events.push("finalize");
				state = {
					...state,
					lifecycle: "cancelled",
					materials: [],
					decisions: [],
					marks: {},
					solutionBasis: null,
					report: { development: null, st: null },
					syncRevisions: [],
				};
				version = artifactVersion(JSON.stringify(state));
				return success();
			},
		},
	};
	const service = new DevCancellationService(options);
	const binding: DevActionBinding = {
		requirementId: state.requirementId,
		expectedRecordVersion: version,
		expectedStage: state.stage,
		files: [],
		operationId: "cancel-operation",
		expectedGeneration: null,
	};
	const decision: DevDecision = {
		operationId: binding.operationId,
		stage: binding.expectedStage,
		actor: { name: "Person", source: "local" },
		at: "2026-11-07T00:00:00Z",
		userReply: "Cancel the explicitly listed requirement changes",
		files: [],
	};
	return {
		cwd,
		events,
		options,
		service,
		binding,
		decision,
		changes,
		appliedPaths,
		plan: () => service.planDevCancellation(structuredClone(state), binding, target, new AbortController().signal),
		run: (plan: DevCancelPlan) => service.executeDevCancellation(plan, decision, new AbortController().signal),
		read: (file: string) => fs.readFile(path.join(cwd, file), "utf8"),
		state: () => structuredClone(state),
		counts: () => ({ executeCount, resumeCount, observeCount }),
		failNextPath: (file: string) => {
			failPath = file;
		},
		failStop: () => {
			stopFailure = true;
		},
		loseCloseResponse: () => {
			closeResponseLost = true;
		},
		mergeOnObservation: (count: number) => {
			mergedAtObservation = count;
		},
		failPublication: (value: boolean) => {
			publicationFailure = value;
		},
		blockStop: (promise: Promise<void>) => {
			stopBarrier = promise;
		},
	};
}

describe("requirement cancellation policy", () => {
	test("create then edit before any commit follows the terminal owned postimage, not the creation layer", async () => {
		const f = await fixture();
		expect(await f.read("owned-new.md")).toBe("owned new revised\n");
		const plan = await f.plan();
		expect(plan.conflicts).toEqual([]);
		expect(
			plan.preview
				.cancellation!.changes.filter(change => change.path === "owned-new.md")
				.map(change => change.layer),
		).toEqual(["untracked", "unstaged"]);
		expect((await f.run(plan)).snapshot.record.lifecycle).toBe("cancelled");
		expect(await Bun.file(path.join(f.cwd, "owned-new.md")).exists()).toBe(false);
	});
	test("compensates all commit batches, dirty layers, archive and main-spec writes without deleting unrelated content", async () => {
		const f = await fixture();
		const plan = await f.plan();
		expect(plan.conflicts).toEqual([]);
		expect(new Set(plan.committedShas)).toEqual(new Set(["C1", "C2", "C3", "C4"]));
		expect(plan.paths).toContain("openspec/specs/example/spec.md");
		expect(plan.paths).toContain("owned-new.md");
		expect(new Set(plan.preview.cancellation!.changes.map(change => change.layer))).toEqual(
			new Set(["committed", "staged", "unstaged", "untracked"]),
		);
		expect(plan.preview.cancellation!.mainSpecs).toContain("openspec/specs/example/spec.md");
		expect(plan.preview.cancellation!.archivePaths).toContain("openspec/changes/archive/cancel-fixture/proposal.md");
		expect(plan.preview.cancellation!.changes.filter(change => change.commitSha === "C4")).toHaveLength(1);
		expect(plan.preview.cancellation!.changes.find(change => change.commitSha === "C4")!.paths).toEqual([
			"openspec/changes/archive/cancel-fixture/proposal.md",
			"openspec/changes/cancel-fixture/proposal.md",
			"openspec/specs/example/spec.md",
		]);
		expect(f.state().lifecycle).toBe("active");
		const result = await f.run(plan);
		expect(result.snapshot.record.lifecycle).toBe("cancelled");
		expect(await f.read("code.txt")).toBe("base\nunrelated later line\n");
		expect(await f.read("shared.txt")).toBe("unrelated staged user content\n");
		expect(await f.read("foreign.md")).toBe("external import source\n");
		expect(await f.read("openspec/specs/example/spec.md")).toBe("original spec\n");
		expect(await Bun.file(path.join(f.cwd, "owned-new.md")).exists()).toBe(false);
		expect(await Bun.file(path.join(f.cwd, "openspec/changes/archive/cancel-fixture/proposal.md")).exists()).toBe(
			false,
		);
		expect(await Bun.file(path.join(f.cwd, "openspec/changes/cancel-fixture/proposal.md")).exists()).toBe(false);
		expect(f.events.indexOf("save:cancelling")).toBeLessThan(f.events.indexOf("stop"));
		expect(f.events.indexOf("settled")).toBeLessThan(f.events.indexOf("close"));
		expect(f.events.indexOf("close")).toBeLessThan(f.events.findIndex(event => event.startsWith("apply:")));
	});

	test("native cleanup failure retains cancelling ownership and does not close PR or reverse files", async () => {
		const f = await fixture();
		const plan = await f.plan();
		f.failStop();
		const result = await f.run(plan);
		expect(result.snapshot.record.lifecycle).toBe("cancelling");
		expect(result.persistence.error).toContain("native cleanup pending");
		expect(f.events).not.toContain("close");
		expect(f.appliedPaths).toEqual([]);
		expect(await f.read("code.txt")).toBe("unstaged\nunrelated later line\n");
	});

	test("a merge race after confirmation stops before destructive compensation", async () => {
		const f = await fixture();
		const plan = await f.plan();
		f.mergeOnObservation(f.counts().observeCount + 2);
		const result = await f.run(plan);
		expect(result.snapshot.record.lifecycle).toBe("cancelling");
		expect(result.persistence.error).toContain("merged");
		expect(f.appliedPaths).toEqual([]);
		expect(f.counts().executeCount).toBe(0);
	});

	test("lost close response is resolved by a fresh PR fact rather than a second close", async () => {
		const f = await fixture();
		const plan = await f.plan();
		f.loseCloseResponse();
		expect((await f.run(plan)).snapshot.record.lifecycle).toBe("cancelled");
		expect(f.events.filter(event => event === "close")).toHaveLength(1);
	});

	test("partially applied cancellation resumes only remaining steps", async () => {
		const f = await fixture();
		const plan = await f.plan();
		f.failNextPath("code.txt");
		const failed = await f.run(plan);
		expect(failed.snapshot.record.lifecycle).toBe("cancelling");
		expect(failed.persistence.error).toContain("partially applied");
		expect(f.appliedPaths.filter(file => file === "owned-new.md")).toHaveLength(1);
		const resumed = await f.run(plan);
		expect(resumed.snapshot.record.lifecycle).toBe("cancelled");
		expect(f.appliedPaths.filter(file => file === "owned-new.md")).toHaveLength(1);
		expect(f.events.filter(event => event === "stop")).toHaveLength(1);
	});

	test("failed publication resumes the existing Git operation without applying inverse patches again", async () => {
		const f = await fixture();
		const plan = await f.plan();
		f.failPublication(true);
		expect((await f.run(plan)).persistence.push.status).toBe("failed");
		const appliedCount = f.appliedPaths.length;
		await fs.writeFile(
			path.join(f.cwd, "code.txt"),
			"base\nunrelated later line\nnew user edit after compensation\n",
		);
		f.failPublication(false);
		expect((await f.run(plan)).snapshot.record.lifecycle).toBe("cancelled");
		expect(f.appliedPaths).toHaveLength(appliedCount);
		expect(await f.read("code.txt")).toBe("base\nunrelated later line\nnew user edit after compensation\n");
		expect(f.counts().executeCount).toBe(1);
		expect(f.counts().resumeCount).toBe(1);
	});

	test("two confirmations of one operation share native settlement and publication", async () => {
		const f = await fixture();
		const plan = await f.plan();
		const stop = Promise.withResolvers<void>();
		f.blockStop(stop.promise);
		const first = f.run(plan);
		const second = f.run(plan);
		expect(first).toBe(second);
		stop.resolve();
		expect((await first).snapshot.record.lifecycle).toBe("cancelled");
		expect(f.counts().executeCount).toBe(1);
	});

	test("missing dirty ownership baseline is reported in preview and never applied", async () => {
		const f = await fixture();
		f.changes.find(change => change.id === "unstaged")!.baselineIndexVersion = "";
		const plan = await f.plan();
		expect(
			plan.conflicts.some(conflict => conflict.path === "code.txt" && conflict.reason.includes("baseline")),
		).toBe(true);
		await expect(f.run(plan)).rejects.toThrow("unresolved conflicts");
		expect(f.state().lifecycle).toBe("active");
		expect(f.appliedPaths).toEqual([]);
	});

	test("changed untracked ownership and unknown merge mainline are explicit conflicts", async () => {
		const f = await fixture();
		await fs.writeFile(path.join(f.cwd, "owned-new.md"), "someone else's later content\n");
		f.changes.find(change => change.id === "code-2")!.parentSha = null;
		const plan = await f.plan();
		expect(plan.conflicts.some(conflict => conflict.path === "owned-new.md")).toBe(true);
		expect(plan.conflicts.some(conflict => conflict.path === "code.txt" && conflict.reason.includes("parent"))).toBe(
			true,
		);
		await expect(f.run(plan)).rejects.toThrow("unresolved conflicts");
		expect(await f.read("owned-new.md")).toBe("someone else's later content\n");
	});
	test("already merged PRs reject deletion before recording any cancellation", async () => {
		const f = await fixture();
		f.mergeOnObservation(1);
		await expect(f.plan()).rejects.toThrow("merged");
		expect(f.state().lifecycle).toBe("active");
		expect(f.events).not.toContain("stop");
		expect(f.appliedPaths).toEqual([]);
	});

	test("PR query uncertainty after settlement retains ownership and never pretends cancellation succeeded", async () => {
		const f = await fixture();
		const plan = await f.plan();
		const observe = f.options.forge!.observe;
		let calls = 0;
		f.options.forge!.observe = async (reference, signal) => {
			if (++calls === 2) throw new Error("PR state unknown");
			return observe(reference, signal);
		};
		const result = await f.run(plan);
		expect(result.snapshot.record.lifecycle).toBe("cancelling");
		expect(result.persistence.error).toContain("PR state unknown");
		expect(f.appliedPaths).toEqual([]);
		expect(f.counts().executeCount).toBe(0);
	});

	test("reopened PR during compensation preserves actual progress without publishing cancellation", async () => {
		const f = await fixture();
		const plan = await f.plan();
		const observe = f.options.forge!.observe;
		f.options.forge!.observe = async (reference, signal) => {
			const fact = await observe(reference, signal);
			return f.appliedPaths.length ? { ...fact, state: "open" } : fact;
		};
		const result = await f.run(plan);
		expect(result.snapshot.record.lifecycle).toBe("cancelling");
		expect(result.persistence.error).toContain("reopened");
		expect(f.appliedPaths).toContain("owned-new.md");
		expect(await f.read("code.txt")).toBe("base\nunrelated later line\n");
		expect(f.counts().executeCount).toBe(0);
	});

	test("resuming a prepared operation cannot overwrite persisted applied progress", async () => {
		const f = await fixture();
		const plan = await f.plan();
		f.failNextPath("code.txt");
		await f.run(plan);
		const preparedAgain = await f.service.planDevCancellation(
			f.state(),
			f.binding,
			target,
			new AbortController().signal,
		);
		expect(preparedAgain).toEqual(plan);
		expect((await f.run(preparedAgain)).snapshot.record.lifecycle).toBe("cancelled");
		expect(f.appliedPaths.filter(file => file === "owned-new.md")).toHaveLength(1);
	});
	test("a merge during Git publication preserves successful Git facts but never publishes the final tombstone", async () => {
		const f = await fixture();
		const plan = await f.plan();
		const observe = f.options.forge!.observe;
		f.options.forge!.observe = async (reference, signal) => {
			const fact = await observe(reference, signal);
			return f.counts().executeCount ? { ...fact, state: "merged", mergeSha: "racing-merge" } : fact;
		};
		const result = await f.run(plan);
		expect(result.snapshot.record.lifecycle).toBe("cancelling");
		expect(result.persistence.commit.status).toBe("succeeded");
		expect(result.persistence.push.status).toBe("succeeded");
		expect(result.persistence.error).toContain("merged");
		expect(f.events).not.toContain("finalize");
		const journal = JSON.parse(
			await fs.readFile(path.join(f.cwd, ".omp/dev-workbench/cancellations/cancel-operation.json"), "utf8"),
		);
		expect(journal.complete).toBe(false);
		expect(journal.lastObservedPr.mergeSha).toBe("racing-merge");
	});

	test("failed final record publication retains cancelling and retries only the final settlement", async () => {
		const f = await fixture();
		const plan = await f.plan();
		const finalize = f.options.git.finalizeDevCancellation;
		f.options.git.finalizeDevCancellation = async () => {
			throw new Error("final record publication blocked");
		};
		const failed = await f.run(plan);
		expect(failed.snapshot.record.lifecycle).toBe("cancelling");
		expect(failed.persistence.commit.status).toBe("succeeded");
		expect(failed.persistence.push.status).toBe("succeeded");
		expect(failed.persistence.error).toContain("final record publication blocked");
		const applied = f.appliedPaths.length;
		f.options.git.finalizeDevCancellation = finalize;
		expect((await f.run(plan)).snapshot.record.lifecycle).toBe("cancelled");
		expect(f.appliedPaths).toHaveLength(applied);
		expect(f.counts().executeCount).toBe(1);
	});
	test("an unstaged owned patch moved into the index requires explicit ownership reconfirmation", async () => {
		const f = await fixture();
		const check = f.options.repo.canApplyPatch;
		f.options.repo.canApplyPatch = async (patch, options, signal) =>
			patch === "untracked" || check(patch, options, signal);
		const plan = await f.plan();
		expect(
			plan.conflicts.some(conflict => conflict.path === "owned-new.md" && conflict.reason.includes("now staged")),
		).toBe(true);
		await expect(f.run(plan)).rejects.toThrow("unresolved conflicts");
		expect(f.state().lifecycle).toBe("active");
		expect(f.appliedPaths).toEqual([]);
	});
	test("ambiguous changes outside the proven ownership ledger block cancellation without claiming or deleting them", async () => {
		const f = await fixture();
		const ambiguity = { path: "foreign.md", reason: "No reliable start baseline for this later dirty path" };
		f.options.git.getOwnershipConflicts = async () => [ambiguity];
		const plan = await f.plan();
		expect(plan.conflicts).toContainEqual(ambiguity);
		expect(plan.preview.cancellation!.conflicts).toContainEqual(ambiguity);
		await expect(f.run(plan)).rejects.toThrow("unresolved conflicts");
		expect(await f.read("foreign.md")).toBe("external import source\n");
		expect(f.state().lifecycle).toBe("active");
	});
});

async function initializeNativeRepository(root: string, bare: boolean): Promise<void> {
	const metadata = bare ? root : path.join(root, ".git");
	await fs.mkdir(path.join(metadata, "objects"), { recursive: true });
	await fs.mkdir(path.join(metadata, "refs", "heads"), { recursive: true });
	await fs.writeFile(path.join(metadata, "HEAD"), `ref: refs/heads/${bare ? "main" : "development"}\n`);
	await fs.writeFile(
		path.join(metadata, "config"),
		`[core]\nrepositoryformatversion = 0\nbare = ${bare}\nautocrlf = false\nhooksPath = disabled-hooks\n[user]\nname = Cancellation Fixture\nemail = cancellation@example.test\n[commit]\ngpgsign = false\n`,
	);
}

test.each(["lf", "crlf"] as const)(
	"native cancellation preserves real history, archive and unrelated staged hunks with %s worktree bytes",
	async eol => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cancel-native-"));
		directories.push(root);
		const cwd = path.join(root, "checkout");
		const remote = path.join(root, "remote.git");
		await initializeNativeRepository(cwd, false);
		await initializeNativeRepository(remote, true);
		const repo = vcs.requireGit(cwd);
		const signal = new AbortController().signal;
		const code = (first: string, last = "original user line") =>
			`${first}\n${"unchanged context\n".repeat(15)}${last}\n`.replaceAll("\n", eol === "crlf" ? "\r\n" : "\n");
		await fs.mkdir(path.join(cwd, "openspec", "specs", "example"), { recursive: true });
		await fs.writeFile(path.join(cwd, ".gitignore"), ".omp/\n");
		await fs.writeFile(path.join(cwd, ".gitattributes"), `* text eol=lf\ncode.txt text eol=${eol}\n`);
		await fs.writeFile(path.join(cwd, "code.txt"), code("base"));
		await fs.writeFile(path.join(cwd, "openspec/specs/example/spec.md"), "original specification\n");
		const retiredSpec = "openspec/specs/retired/spec.md";
		await fs.mkdir(path.dirname(path.join(cwd, retiredSpec)), { recursive: true });
		await fs.writeFile(path.join(cwd, retiredSpec), "preexisting retired specification\n");
		await fs.writeFile(path.join(cwd, "captured-a.txt"), "original capture A\n");
		await fs.writeFile(path.join(cwd, "captured-b.txt"), "original capture B\n");
		await repo.stageFiles(
			[
				".gitignore",
				".gitattributes",
				"code.txt",
				"openspec/specs/example/spec.md",
				retiredSpec,
				"captured-a.txt",
				"captured-b.txt",
			],
			signal,
		);
		const initial = await repo.commitCreate("fixture baseline", {}, signal);
		await repo.remoteAdd("origin", remote, signal);
		await repo.push({ remote: "origin", refspec: `${initial}:refs/heads/main`, forceWithLease: false }, signal);
		let current = record();
		current.pr = null;
		const activeProposal = "openspec/changes/cancel-fixture/proposal.md";
		const archivedProposal = "openspec/changes/archive/cancel-fixture/proposal.md";
		current.materials = [
			{
				id: "proposal",
				kind: "proposal",
				path: archivedProposal,
				version: artifactVersion("requirement proposal\n"),
			},
		];
		const created = await saveDevRequirement(cwd, current, null);
		current = created.record;
		const git = new DevGitService({
			cwd,
			repo,
			applyDecision: (previous, _decision, operation) => {
				if (operation !== "cancel") throw new Error("This fixture only authorizes cancellation");
				return {
					...previous,
					lifecycle: "cancelled",
					materials: [],
					decisions: [],
					marks: {},
					solutionBasis: null,
					report: { development: null, st: null },
					syncRevisions: [],
				};
			},
		});
		const ownedShas: string[] = [];
		async function commitOwned(file: string, content: string): Promise<void> {
			const parent = (await repo.headSha(signal))!;
			const existed = (await repo.lsTree(parent, [file], signal)).includes(file);
			const beforeVersion = existed
				? artifactVersion((await repo.showBlob(`${parent}:${file}`, undefined, signal)).data)
				: null;
			await fs.mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
			await fs.writeFile(path.join(cwd, file), content);
			await repo.stageFiles([file, "docs/dev-requirements/cancel-fixture.json"], signal);
			const sha = await repo.commitCreate(`cancel-fixture owned ${file}`, {}, signal);
			ownedShas.push(sha);
			await git.registerOwnedPatch(
				current.requirementId,
				{
					patch: await repo.diffText({ base: parent, head: sha, files: [file], binary: true }, signal),
					files: [
						{
							path: file,
							beforeVersion,
							afterVersion: artifactVersion(content),
							layer: "committed",
							parentSha: parent,
							commitSha: sha,
						},
					],
					baselineIndexVersion: "",
				},
				signal,
			);
		}
		await commitOwned(activeProposal, "requirement proposal\n");
		await commitOwned("code.txt", code("owned code-1"));
		await commitOwned("code.txt", code("owned code-2"));
		await commitOwned("openspec/specs/example/spec.md", "owned synchronized specification\n");
		await commitOwned(archivedProposal, "requirement proposal\n");
		const archiveParent = (await repo.headSha(signal))!;
		await fs.rm(path.join(cwd, activeProposal));
		await repo.stageFiles([activeProposal], signal);
		const archiveRemoval = await repo.commitCreate("cancel-fixture archive source cleanup", {}, signal);
		ownedShas.push(archiveRemoval);
		await git.registerOwnedPatch(
			current.requirementId,
			{
				patch: await repo.diffText(
					{ base: archiveParent, head: archiveRemoval, files: [activeProposal], binary: true },
					signal,
				),
				files: [
					{
						path: activeProposal,
						beforeVersion: artifactVersion("requirement proposal\n"),
						afterVersion: null,
						layer: "committed",
						parentSha: archiveParent,
						commitSha: archiveRemoval,
					},
				],
				baselineIndexVersion: "",
			},
			signal,
		);
		const retirementParent = (await repo.headSha(signal))!;
		await fs.rm(path.join(cwd, retiredSpec));
		await repo.stageFiles([retiredSpec], signal);
		const retirementSha = await repo.commitCreate("cancel-fixture retire main specification", {}, signal);
		ownedShas.push(retirementSha);
		await git.registerOwnedPatch(
			current.requirementId,
			{
				patch: await repo.diffText(
					{ base: retirementParent, head: retirementSha, files: [retiredSpec], binary: true },
					signal,
				),
				files: [
					{
						path: retiredSpec,
						beforeVersion: artifactVersion("preexisting retired specification\n"),
						afterVersion: null,
						layer: "committed",
						parentSha: retirementParent,
						commitSha: retirementSha,
					},
				],
				baselineIndexVersion: "",
			},
			signal,
		);
		const head = (await repo.headSha(signal))!;
		await repo.push({ remote: "origin", refspec: `${head}:refs/heads/development`, forceWithLease: false }, signal);
		const baselineIndexVersion = artifactVersion(await fs.readFile(path.join(repo.info().gitDir, "index")));
		await fs.writeFile(path.join(cwd, "code.txt"), code("owned staged"));
		const stagedPatch = await repo.diffText({ files: ["code.txt"], binary: true }, signal);
		await git.registerOwnedPatch(
			current.requirementId,
			{
				patch: stagedPatch,
				baselineIndexVersion,
				files: [
					{
						path: "code.txt",
						layer: "staged",
						beforeVersion: artifactVersion(code("owned code-2")),
						afterVersion: artifactVersion(code("owned staged")),
					},
				],
			},
			signal,
		);
		await repo.stageFiles(["code.txt"], signal);
		await fs.writeFile(path.join(cwd, "code.txt"), code("owned staged", "unrelated user staged line"));
		await repo.stageFiles(["code.txt"], signal);
		await fs.writeFile(path.join(cwd, "code.txt"), code("owned unstaged", "unrelated user staged line"));
		await git.registerOwnedPatch(
			current.requirementId,
			{
				patch: await repo.diffText({ files: ["code.txt"], binary: true }, signal),
				baselineIndexVersion,
				files: [
					{
						path: "code.txt",
						layer: "unstaged",
						beforeVersion: artifactVersion(code("owned staged", "unrelated user staged line")),
						afterVersion: artifactVersion(code("owned unstaged", "unrelated user staged line")),
					},
				],
			},
			signal,
		);
		const creationCapture = await git.beginOwnedPaths(
			current.requirementId,
			"native-create-untracked",
			["owned-untracked.md"],
			signal,
		);
		await fs.writeFile(path.join(cwd, "owned-untracked.md"), "owned transient document\n");
		await git.endOwnedPaths(current.requirementId, creationCapture, signal);
		const revisionCapture = await git.beginOwnedPaths(
			current.requirementId,
			"native-revise-untracked",
			["owned-untracked.md"],
			signal,
		);
		await fs.writeFile(
			path.join(cwd, "owned-untracked.md"),
			"owned transient document after a second controlled write\n",
		);
		await git.endOwnedPaths(current.requirementId, revisionCapture, signal);
		const [captureA, captureB] = await Promise.all([
			git.beginOwnedPaths(current.requirementId, "native-concurrent-a", ["captured-a.txt"], signal),
			git.beginOwnedPaths(current.requirementId, "native-concurrent-b", ["captured-b.txt"], signal),
		]);
		await fs.writeFile(path.join(cwd, "captured-a.txt"), "owned mutation A\n");
		await fs.writeFile(path.join(cwd, "captured-b.txt"), "owned mutation B\n");
		await Promise.all([
			git.endOwnedPaths(current.requirementId, captureA, signal),
			git.endOwnedPaths(current.requirementId, captureB, signal),
		]);
		await fs.writeFile(path.join(root, "external-import.md"), "never delete the external source\n");
		const stored = await readDevRequirement(cwd, current.requirementId);
		const remoteIdentity = devRepositoryIdentity(remote);
		const nativeTarget: DevGitTarget = {
			...target,
			sourceRepository: remoteIdentity,
			baseRepository: remoteIdentity,
			remoteUrl: remote,
			observedTip: head,
		};
		const binding: DevActionBinding = {
			requirementId: current.requirementId,
			expectedRecordVersion: stored.recordVersion,
			expectedStage: current.stage,
			files: [],
			operationId: "native-cancellation",
			expectedGeneration: null,
		};
		let settled = false;
		const service = new DevCancellationService({
			cwd,
			repo,
			git,
			stop: async () => {
				settled = true;
			},
			snapshot: async id => ({ ...(await readDevRequirement(cwd, id)), runtime: null, actions: [] }),
		});
		const plan = await service.planDevCancellation(stored.record, binding, nativeTarget, signal);
		expect(plan.conflicts).toEqual([]);
		expect(new Set(plan.committedShas)).toEqual(new Set(ownedShas));
		const result = await service.executeDevCancellation(
			plan,
			{
				operationId: binding.operationId,
				stage: binding.expectedStage,
				actor: { name: "Fixture", source: "local" },
				at: "2026-11-07T00:00:00Z",
				files: [],
				userReply: "Cancel these exact native changes",
			},
			signal,
		);
		expect(result.persistence.error).toBeUndefined();
		expect(result.persistence.commit.status).toBe("succeeded");
		expect(result.persistence.push.status).toBe("succeeded");
		expect(result.snapshot.record.lifecycle).toBe("cancelled");
		expect(settled).toBe(true);
		expect(await fs.readFile(path.join(cwd, "code.txt"), "utf8")).toBe(code("base", "unrelated user staged line"));
		expect(await fs.readFile(path.join(cwd, "openspec/specs/example/spec.md"), "utf8")).toBe(
			"original specification\n",
		);
		expect(await fs.readFile(path.join(cwd, retiredSpec), "utf8")).toBe("preexisting retired specification\n");
		expect(await fs.readFile(path.join(cwd, "captured-a.txt"), "utf8")).toBe("original capture A\n");
		expect(await fs.readFile(path.join(cwd, "captured-b.txt"), "utf8")).toBe("original capture B\n");
		expect(await Bun.file(path.join(cwd, activeProposal)).exists()).toBe(false);
		expect(await Bun.file(path.join(cwd, archivedProposal)).exists()).toBe(false);
		expect(await Bun.file(path.join(cwd, "owned-untracked.md")).exists()).toBe(false);
		expect(await fs.readFile(path.join(root, "external-import.md"), "utf8")).toBe(
			"never delete the external source\n",
		);
		expect(await repo.diffText({ cached: true, files: ["code.txt"] }, signal)).toContain(
			"+unrelated user staged line",
		);
		const committedCode = await repo.showBlob(`${result.persistence.commit.sha}:code.txt`, undefined, signal);
		expect(committedCode.data.toString("utf8")).toBe(code("base").replaceAll("\r\n", "\n"));
		const committedRecord = await repo.showBlob(
			`${result.persistence.commit.sha}:docs/dev-requirements/cancel-fixture.json`,
			undefined,
			signal,
		);
		expect(committedRecord.data).toEqual(
			await fs.readFile(path.join(cwd, "docs/dev-requirements/cancel-fixture.json")),
		);
		expect(await repo.headSha(signal)).toBe(result.persistence.commit.sha);
		expect((await repo.commitDetails(result.persistence.commit.sha!, signal)).parents).toEqual([head]);
		for (const sha of ownedShas) expect(await repo.refExists(sha, signal)).toBe(true);
	},
);

test.each(["confirmed-publication", "unrelated-descendant", "changed-after-preview"] as const)(
	"native cancellation binds refreshed PR head to confirmed publication: %s",
	async scenario => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cancel-pr-head-"));
		directories.push(root);
		const cwd = path.join(root, "checkout");
		const remote = path.join(root, "remote.git");
		await initializeNativeRepository(cwd, false);
		await initializeNativeRepository(remote, true);
		const repo = vcs.requireGit(cwd);
		const signal = new AbortController().signal;
		await fs.writeFile(path.join(cwd, ".gitignore"), ".omp/\n");
		await fs.writeFile(path.join(cwd, "code.txt"), "original user bytes\n");
		await repo.stageFiles([".gitignore", "code.txt"], signal);
		const initial = await repo.commitCreate("PR fixture baseline", {}, signal);
		await repo.remoteAdd("origin", remote, signal);
		await repo.push({ remote: "origin", refspec: `${initial}:refs/heads/main` }, signal);
		await repo.push({ remote: "origin", refspec: `${initial}:refs/heads/development` }, signal);
		const identity = devRepositoryIdentity(remote);
		const nativeTarget: DevGitTarget = {
			...target,
			sourceRepository: identity,
			baseRepository: identity,
			remoteUrl: remote,
			observedTip: initial,
		};
		const current = record();
		current.materials = [];
		current.pr = {
			...structuredClone(pr),
			pr: { ...pr.pr, repository: identity },
			headSha: initial,
			baseSha: initial,
		};
		await saveDevRequirement(cwd, current, null);
		const git = new DevGitService({
			cwd,
			repo,
			applyDecision: (previous, decision, operation) =>
				operation === "cancel"
					? {
							...previous,
							lifecycle: "cancelled",
							materials: [],
							decisions: [],
							marks: {},
							solutionBasis: null,
							report: { development: null, st: null },
							syncRevisions: [],
						}
					: { ...previous, marks: { ...previous.marks, "pr-submitted": decision } },
		});
		await git.initializeRequirementGit(current.requirementId, signal);
		const capture = await git.beginOwnedPaths(current.requirementId, "owned-PR-change", ["code.txt"], signal);
		await fs.writeFile(path.join(cwd, "code.txt"), "confirmed requirement bytes\n");
		await git.endOwnedPaths(current.requirementId, capture, signal);
		const stored = await readDevRequirement(cwd, current.requirementId);
		const files = [{ path: "code.txt", version: artifactVersion("confirmed requirement bytes\n") }];
		const publicationBinding: DevActionBinding = {
			requirementId: current.requirementId,
			expectedRecordVersion: stored.recordVersion,
			expectedStage: current.stage,
			expectedGeneration: null,
			operationId: "confirmed-PR-publication",
			files,
		};
		const decision: DevDecision = {
			operationId: publicationBinding.operationId,
			stage: current.stage,
			actor: { name: "Fixture human", source: "local" },
			at: "2026-11-07T00:00:00Z",
			files,
			userReply: "Submit and publish this exact requirement scope",
		};
		const publicationPreview = await git.previewDevGitOperation(
			stored.record,
			{ binding: publicationBinding, operation: "pr-submitted", target: nativeTarget, files },
			signal,
		);
		const published = await git.executeDevGitOperation(publicationPreview, decision, signal);
		expect(published.persistence.error).toBeUndefined();
		expect(published.persistence.push.status).toBe("succeeded");
		const publishedSha = published.persistence.commit.sha!;
		expect(publishedSha).not.toBe(initial);
		expect(published.snapshot.record.pr?.headSha).toBe(initial);
		let closed = false;
		let closeCount = 0;
		const service = new DevCancellationService({
			cwd,
			repo,
			git,
			stop: async () => {},
			snapshot: async id => ({ ...(await readDevRequirement(cwd, id)), runtime: null, actions: [] }),
			forge: {
				observe: async () => ({
					...current.pr!,
					state: closed ? "closed" : "open",
					headSha: (await repo.remoteRef("origin", "refs/heads/development", signal)).sha!,
				}),
				close: async () => {
					closed = true;
					closeCount++;
					return {
						...current.pr!,
						state: "closed",
						headSha: (await repo.remoteRef("origin", "refs/heads/development", signal)).sha!,
					};
				},
			},
		});
		const advanceUnrelatedRemoteHead = async () => {
			const tree = await repo.writeTree(undefined, signal);
			const foreignSha = await repo.commitTree(
				tree,
				[publishedSha],
				"Unrelated external PR-head advance",
				undefined,
				signal,
			);
			await repo.push({ remote: "origin", refspec: `${foreignSha}:refs/heads/development` }, signal);
			expect(await repo.headSha(signal)).toBe(publishedSha);
			return foreignSha;
		};
		if (scenario === "unrelated-descendant") await advanceUnrelatedRemoteHead();
		const latest = await readDevRequirement(cwd, current.requirementId);
		const binding: DevActionBinding = {
			...publicationBinding,
			expectedRecordVersion: latest.recordVersion,
			operationId: "cancel-published-PR",
			files: [],
		};
		const cancellationTarget = { ...nativeTarget, observedTip: publishedSha };
		if (scenario === "unrelated-descendant") {
			await expect(service.planDevCancellation(latest.record, binding, cancellationTarget, signal)).rejects.toThrow(
				"PR source/head/base changed",
			);
			expect(closeCount).toBe(0);
			expect((await readDevRequirement(cwd, current.requirementId)).record.lifecycle).toBe("active");
			expect(await fs.readFile(path.join(cwd, "code.txt"), "utf8")).toBe("confirmed requirement bytes\n");
			return;
		}
		const plan = await service.planDevCancellation(latest.record, binding, cancellationTarget, signal);
		expect(plan.conflicts).toEqual([]);
		expect(plan.pr?.headSha).toBe(publishedSha);
		if (scenario === "changed-after-preview") await advanceUnrelatedRemoteHead();
		const result = await service.executeDevCancellation(
			plan,
			{ ...decision, operationId: binding.operationId, files: [], userReply: "Cancel this frozen actual PR scope" },
			signal,
		);
		if (scenario === "changed-after-preview") {
			expect(result.persistence.error).toContain("PR source/head/base changed");
			expect(closeCount).toBe(0);
			expect(result.snapshot.record.lifecycle).toBe("active");
			expect(await fs.readFile(path.join(cwd, "code.txt"), "utf8")).toBe("confirmed requirement bytes\n");
		} else {
			expect(result.persistence.error).toBeUndefined();
			expect(result.persistence.push.status).toBe("succeeded");
			expect(result.snapshot.record.lifecycle).toBe("cancelled");
			expect(result.snapshot.record.pr?.state).toBe("closed");
			expect(closeCount).toBe(1);
			expect(await fs.readFile(path.join(cwd, "code.txt"), "utf8")).toBe("original user bytes\n");
		}
	},
);
