import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { Settings } from "../../src/config/settings";
import { ModelRegistry } from "../../src/config/model-registry";
import { createAgentSession } from "../../src/sdk";
import { AuthStorage } from "../../src/session/auth-storage";
import { AgentStorage } from "../../src/session/agent-storage";
import { HistoryStorage } from "../../src/session/history-storage";
import { SessionManager } from "../../src/session/session-manager";
import { closeSessionIndex } from "../../src/session/session-index";
import { artifactVersion } from "../../src/spec-driven/artifacts";
import { SpecDrivenController, type SpecRuntimeFactory } from "../../src/spec-driven/controller";
import { DevGitService } from "../../src/spec-driven/git";
import { SpecAdmissionError } from "../../src/spec-driven/orchestrator";
import { readDevRequirement, saveDevRequirement } from "../../src/spec-driven/records";
import { createSpecDrivenRuntime, type SpecDrivenRuntime } from "../../src/spec-driven/runtime";
import type {
	DevActionIntent,
	DevActionPreview,
	DevGitTarget,
	DevRequirementRecord,
	DevRequirementSnapshot,
} from "../../src/spec-driven/types";
import { DevWorkspace } from "../../src/spec-driven/workspace";
import { createProviderFixture, rolePayload } from "./provider-fixture";

const business =
	"# 业务需求：订单\n\n" +
	[
		"基本信息",
		"业务背景与目标",
		"实际使用场景与现状",
		"期望结果",
		"业务规则与边界",
		"典型例子",
		"业务验收预期",
		"待确认事项",
		"资料来源",
		"业务确认与交接",
	]
		.map(heading => `## ${heading}\n已确认的完整事实 Ω。\n`)
		.join("\n");
async function fixture(configuration: { remote?: boolean; failFinalCancellation?: boolean } = {}) {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-native-controller-"));
	const agentDir = path.join(cwd, "isolated-agent");
	await fs.mkdir(agentDir);
	await fs.mkdir(path.join(cwd, ".git/objects"), { recursive: true });
	await fs.mkdir(path.join(cwd, ".git/refs/heads"), { recursive: true });
	await fs.mkdir(path.join(cwd, ".git/hooks"));
	await fs.writeFile(path.join(cwd, ".git/HEAD"), "ref: refs/heads/main\n");
	await fs.writeFile(
		path.join(cwd, ".git/config"),
		"[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tautocrlf = false\n\thooksPath = .git/hooks\n[commit]\n\tgpgSign = false\n[user]\n\tname = Controller Test\n\temail = controller@example.invalid\n",
	);
	await fs.writeFile(path.join(cwd, "tracked.txt"), "unrelated original bytes\n");
	const repo = vcs.git(cwd);
	if (!repo) throw new Error("Native fixture Git discovery failed");
	await repo.stageFiles(["tracked.txt"]);
	const initial = await repo.commitCreate("fixture", {});
	const remote = configuration.remote ? await fs.mkdtemp(path.join(os.tmpdir(), "omp-controller-bare-remote-")) : null;
	if (remote) {
		for (const directory of ["objects/info", "objects/pack", "refs/heads", "refs/tags", "fixture-hooks"]) {
			await fs.mkdir(path.join(remote, directory), { recursive: true });
		}
		await fs.writeFile(path.join(remote, "HEAD"), "ref: refs/heads/main\n");
		await fs.writeFile(
			path.join(remote, "config"),
			"[core]\n\trepositoryformatversion = 0\n\tbare = true\n\thooksPath = fixture-hooks\n",
		);
		await repo.remoteAdd("fixture", remote);
		await repo.push({ remote: "fixture", refspec: `${initial}:refs/heads/main`, forceWithLease: false });
		await repo.createBranch("feature", initial, false);
		await repo.checkout("feature");
		await repo.fetch("fixture", "refs/heads/main", "refs/remotes/fixture/main");
	}
	let modelGate: Promise<void> | undefined;
	let modelStarted = Promise.withResolvers<void>();
	const provider = createProviderFixture({
		reply: () => ({ text: "继续澄清，不代表批准。" }),
		delay: async () => {
			modelStarted.resolve();
			await modelGate;
		},
	});
	await fs.writeFile(
		path.join(agentDir, "models.yml"),
		`providers:\n  deepseek:\n    baseUrl: ${provider.baseUrl}\n    auth: none\n    api: openai-completions\n    models:\n      - id: chat-a\n        reasoning: false\n        contextWindow: 1000000\n`,
	);
	const settings = await Settings.loadIsolated({
		cwd,
		agentDir,
		inMemory: true,
		overrides: {
			modelRoles: { default: "deepseek/chat-a", smol: "deepseek/chat-a" },
			"compaction.enabled": false,
			"prewalk.enabled": false,
			"tools.xdev": false,
			"async.enabled": false,
			"todo.enabled": false,
			"mcp.startupTimeoutMs": 0,
		},
	});
	const authStorage = await AuthStorage.create(":memory:");
	const registry = new ModelRegistry(authStorage, path.join(agentDir, "models.yml"), { settings });
	const model = registry.find("deepseek", "chat-a");
	if (!model) throw new Error("Local controller fixture model unavailable");
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		settings,
		model,
		authStorage,
		modelRegistry: registry,
		sessionManager: SessionManager.inMemory(),
		contextFiles: [],
		rules: [],
		skills: [],
		promptTemplates: [],
		slashCommands: [],
		disableExtensionDiscovery: true,
		enableMCP: false,
		enableLsp: false,
		autoTitle: false,
		offline: true,
		bindProcessState: false,
	});
	const runtimes: SpecDrivenRuntime[] = [];
	let failStop: boolean | SpecDrivenRuntime = false;
	const factory: SpecRuntimeFactory = async args => {
		const runtime = await createSpecDrivenRuntime(args);
		const stop = runtime.stop.bind(runtime);
		runtime.stop = async () => {
			if (failStop === true || failStop === runtime) throw new Error("native stop failed");
			await stop();
		};
		runtimes.push(runtime);
		return runtime;
	};
	let finalSaveFailures = 0;
	const owner = new SpecDrivenController(
		{ session, settings, cwd },
		factory,
		configuration.failFinalCancellation
			? {
					createGit: options => {
						const records = options.records;
						if (!records) throw new Error("Controller did not provide its actual record store");
						return new DevGitService({
							...options,
							records: {
								...records,
								save: async (record, expected) => {
									if (record.lifecycle === "cancelled" && finalSaveFailures === 0) {
										finalSaveFailures++;
										throw new Error("final tombstone CAS failure");
									}
									return records.save(record, expected);
								},
							},
						});
					},
				}
			: {},
	);
	async function preview(
		snapshot: DevRequirementSnapshot,
		intent: DevActionIntent,
		gitTarget: DevGitTarget | null = null,
	): Promise<DevActionPreview> {
		return owner.prepareDevAction({
			requirementId: snapshot.record.requirementId,
			expectedRecordVersion: snapshot.recordVersion,
			expectedStage: snapshot.record.stage,
			intent,
			gitTarget,
		});
	}
	async function waitForNativeIdle(requirementId: string): Promise<DevRequirementSnapshot> {
		const settled = Promise.withResolvers<DevRequirementSnapshot>();
		const inspect = (snapshot: DevRequirementSnapshot) => {
			if (snapshot.record.requirementId !== requirementId || !snapshot.runtime) return;
			if (snapshot.runtime.execution === "failed") {
				settled.reject(new Error(snapshot.runtime.blockedReason ?? "Native stage failed"));
			} else if (snapshot.runtime.execution === "idle" && snapshot.runtime.recipient) settled.resolve(snapshot);
		};
		const unsubscribe = owner.observe(inspect);
		try {
			inspect(await owner.getRequirement(requirementId));
			return await settled.promise;
		} finally {
			unsubscribe();
		}
	}
	async function confirm(action: DevActionPreview, userReply = "  人员明确原文\n不裁剪 Ω  ") {
		const result = await owner.confirmDevAction({
			operationId: action.action.binding.operationId,
			confirmationToken: action.confirmationToken,
			userReply,
		});
		if (result.persistence.save !== "succeeded" || result.persistence.error) {
			throw new Error(
				`Confirmed ${action.action.kind} did not save: ${result.persistence.error ?? JSON.stringify(result.persistence)}; stage=${result.snapshot.record.stage}`,
			);
		}
		if (action.action.kind === "next" && result.persistence.save === "succeeded" && !result.persistence.error) {
			return { ...result, snapshot: await waitForNativeIdle(action.action.binding.requirementId) };
		}
		return result;
	}
	async function imported() {
		const created = await owner.createRequirement({ source: "import" });
		await owner.importBusiness(created.record.requirementId, {
			kind: "upload",
			name: "orders.md",
			bytes: new TextEncoder().encode(business),
		});
		return owner.getRequirement(created.record.requirementId);
	}
	return {
		cwd,
		owner,
		session,
		settings,
		provider,
		runtimes,
		repo,
		remote,
		preview,
		confirm,
		imported,
		finalSaveFailures: () => finalSaveFailures,
		waitForNativeIdle,
		gateModel(gate: Promise<void>) {
			modelGate = gate;
			modelStarted = Promise.withResolvers<void>();
		},
		waitForModelStart: () => modelStarted.promise,
		failStop(value: boolean, runtime?: SpecDrivenRuntime) {
			failStop = value ? (runtime ?? true) : false;
		},
		async [Symbol.asyncDispose]() {
			failStop = false;
			await owner.dispose();
			await session.dispose();
			await registry.awaitBackgroundRefresh();
			authStorage.close();
			await provider[Symbol.asyncDispose]();
			HistoryStorage.close();
			closeSessionIndex();
			AgentStorage.close();
			closeModelCache();
			await fs.rm(cwd, { recursive: true, force: true });
			if (remote) await fs.rm(remote, { recursive: true, force: true });
		},
	};
}

describe("record-driven native controller", () => {
	test("cold lists and imports without actors, and preview cannot approve or invoke a model", async () => {
		await using f = await fixture();
		expect(await f.owner.listRequirements()).toEqual([]);
		const snapshot = await f.imported();
		expect(snapshot.record.stage).toBe("business");
		expect(snapshot.runtime).toBeNull();
		expect(f.runtimes).toEqual([]);
		expect(f.provider.requests).toEqual([]);
		const preview = await f.preview(snapshot, { kind: "next" });
		expect(preview.action.binding.operationId.length).toBeGreaterThan(0);
		expect(preview.confirmationToken.length).toBeGreaterThan(0);
		expect(preview.action.binding.expectedRecordVersion).toBe(snapshot.recordVersion);
		expect(preview.action.binding.files).toContainEqual({
			path: `docs/business-requirements/${snapshot.record.changeId}.md`,
			version: artifactVersion(business),
		});
		expect(preview.action.previewId).toBeNull();
		expect(preview.git).toBeNull();
		expect(f.provider.requests).toEqual([]);
		expect(f.owner.nativeSession(snapshot.record.requirementId)).toBeUndefined();
		expect((await f.owner.getRequirement(snapshot.record.requirementId)).record.decisions).toEqual([]);
	}, 120_000);

	test("first confirmed Next hands complete imported bytes and raw decision to the real requirements session without changing ordinary ownership", async () => {
		await using f = await fixture();
		const snapshot = await f.imported();
		const ordinaryId = f.session.sessionId;
		const ordinaryMessages = structuredClone(f.session.messages);
		const action = await f.preview(snapshot, { kind: "next" });
		const result = await f.confirm(action);
		expect(result.persistence.save).toBe("succeeded");
		expect(result.persistence.error).toBeUndefined();
		expect(result.snapshot.record.stage).toBe("requirements");
		expect(result.snapshot.record.decisions[0]?.userReply).toBe("  人员明确原文\n不裁剪 Ω  ");
		expect(result.snapshot.record.decisions[0]?.operationId).toBe(action.action.binding.operationId);
		expect(f.runtimes[0]?.nativeSession("business")).toBeUndefined();
		const native = f.owner.nativeSession(snapshot.record.requirementId);
		expect(native).toBeDefined();
		expect(f.runtimes[0]?.originalRequest()).toBe("");
		expect(native).not.toBe(f.session);
		expect(f.owner.rootSession()).toBe(f.session);
		expect(f.session.sessionId).toBe(ordinaryId);
		expect(f.session.messages).toEqual(ordinaryMessages);
		const input = f.provider.requests.map(rolePayload).find(item => item?.specDrivenRole === "requirements")?.input;
		expect(input?.files).toContainEqual({
			path: `docs/business-requirements/${snapshot.record.changeId}.md`,
			content: business,
			version: artifactVersion(business),
		});
		expect(input?.userReply).toBe("  人员明确原文\n不裁剪 Ω  ");
		expect(input?.request).not.toContain("人员明确原文");
	}, 120_000);

	test("requires host-issued confirmation, rejects altered files and preserves duplicate operation identity", async () => {
		await using f = await fixture();
		const snapshot = await f.imported();
		const preview = await f.preview(snapshot, { kind: "next" });
		await expect(
			f.owner.confirmDevAction({
				operationId: preview.action.binding.operationId,
				confirmationToken: "wrong",
				userReply: "同意",
			}),
		).rejects.toThrow();
		await expect(
			f.owner.dispatch({ ...preview.action, userReply: "伪造直接动作" }, { name: "forged", source: "collab" }),
		).rejects.toThrow();
		const result = await f.confirm(preview);
		const requests = f.provider.requests.length;
		const repeated = await f.confirm(preview, "第二次不同原文不替换第一次");
		expect(repeated.snapshot.record.decisions).toEqual(result.snapshot.record.decisions);
		expect(f.provider.requests).toHaveLength(requests);
		await expect(f.preview(snapshot, { kind: "next" })).rejects.toThrow();
		const current = await readDevRequirement(f.cwd, snapshot.record.requirementId);
		expect(current.record.decisions).toHaveLength(1);
	}, 120_000);

	test("material edits after preview invalidate confirmation without preparing a successor", async () => {
		await using f = await fixture();
		const snapshot = await f.imported();
		const preview = await f.preview(snapshot, { kind: "next" });
		const target = path.join(f.cwd, `docs/business-requirements/${snapshot.record.changeId}.md`);
		await fs.writeFile(target, `${business}\n人工在确认后修改。\n`);
		await expect(f.confirm(preview)).rejects.toThrow();
		expect((await f.owner.getRequirement(snapshot.record.requirementId)).record.stage).toBe("business");
		expect((await f.owner.getRequirement(snapshot.record.requirementId)).record.decisions).toEqual([]);
		expect(f.provider.requests).toEqual([]);
		expect(f.owner.nativeSession(snapshot.record.requirementId)).toBeUndefined();
	}, 120_000);

	test("a failed initial business-record save never starts a runtime or conversation", async () => {
		await using f = await fixture();
		await fs.writeFile(path.join(f.cwd, "docs"), "blocks business record directory");
		await expect(f.owner.createRequirement({ source: "conversation", request: "不应调用模型" })).rejects.toThrow();
		expect(f.runtimes).toEqual([]);
		expect(f.provider.requests).toEqual([]);
		expect(await fs.readFile(path.join(f.cwd, "docs"), "utf8")).toBe("blocks business record directory");
	}, 120_000);

	test("failed native settlement attempts every owned runtime and retains the canonical lease until retry", async () => {
		await using f = await fixture();
		const snapshot = await f.imported();
		await f.confirm(await f.preview(snapshot, { kind: "next" }));
		f.failStop(true);
		await expect(f.owner.stop(snapshot.record.requirementId)).rejects.toThrow("native stop failed");
		await expect(DevWorkspace.acquire(f.cwd)).rejects.toThrow();
		expect((await f.owner.getRequirement(snapshot.record.requirementId)).record.stage).toBe("requirements");
		f.failStop(false);
		await f.owner.stop(snapshot.record.requirementId);
		expect((await f.owner.getRequirement(snapshot.record.requirementId)).runtime?.execution).toBe("interrupted");
		expect((await f.owner.readMaterial(snapshot.record.requirementId, "business")).content).toBe(business);
		await f.owner.startLocalBusiness("独立本地业务会话");
		const localSession = f.owner.nativeSession()!;
		f.failStop(true, f.runtimes[0]);
		let failure: unknown;
		try {
			await f.owner.dispose();
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(AggregateError);
		expect((failure as AggregateError).errors.map((error: Error) => error.message)).toEqual(["native stop failed"]);
		expect(localSession.isDisposed).toBe(true);
		expect(f.owner.nativeSession()).toBeUndefined();
		expect(f.owner.nativeSession(snapshot.record.requirementId)?.isDisposed).toBe(true);
		expect(f.session.isDisposed).toBe(false);
		await expect(DevWorkspace.acquire(f.cwd)).rejects.toThrow();
		f.failStop(false);
		await f.owner.dispose();
		const lease = await DevWorkspace.acquire(f.cwd);
		lease.release();
		expect(f.session.isDisposed).toBe(false);
	}, 120_000);

	test("cancelled native jobs remain busy until actual descendant settlement, and unsubscribe does not stop the owner", async () => {
		await using f = await fixture();
		const snapshot = await f.imported();
		await f.confirm(await f.preview(snapshot, { kind: "next" }));
		const native = f.owner.nativeSession(snapshot.record.requirementId)!;
		const jobs = native.asyncJobManager;
		if (!jobs) throw new Error("Expected native job manager");
		const release = Promise.withResolvers<string>();
		const entered = Promise.withResolvers<void>();
		const jobId = jobs.register(
			"bash",
			"unsettled fixture",
			() => {
				entered.resolve();
				return release.promise;
			},
			{ ownerId: native.getAgentId()! },
		);
		try {
			await entered.promise;
			jobs.cancel(jobId);
			expect(jobs.getJob(jobId)?.endTime).toBeUndefined();
			const unsubscribe = f.owner.observe(() => {});
			unsubscribe();
			expect(jobs.getJob(jobId)?.endTime).toBeUndefined();
			await expect(
				f.preview(await f.owner.getRequirement(snapshot.record.requirementId), { kind: "back" }),
			).rejects.toThrow();
			release.resolve("settled");
			await jobs.getJob(jobId)!.promise;
			const before = f.provider.requests.length;
			const back = await f.confirm(
				await f.preview(await f.owner.getRequirement(snapshot.record.requirementId), { kind: "back" }),
			);
			expect(back.snapshot.record.stage).toBe("business");
			expect(f.provider.requests).toHaveLength(before);
		} finally {
			release.resolve("settled");
			await jobs.getJob(jobId)?.promise;
		}
	}, 120_000);
});

test("an incomplete import requires admission, and a confirmed replacement updates an existing runtime before Next", async () => {
	await using f = await fixture();
	const created = await f.owner.createRequirement({ source: "import" });
	const bytes = "# 业务需求：订单\n\n## 基本信息\n导入不等于批准。\n";
	const document = await f.owner.importBusiness(created.record.requirementId, {
		kind: "upload",
		name: "incomplete.md",
		bytes: new TextEncoder().encode(bytes),
	});
	const snapshot = await f.owner.getRequirement(created.record.requirementId);
	await expect(f.preview(snapshot, { kind: "next" })).rejects.toThrow();
	const after = await f.owner.getRequirement(created.record.requirementId);
	expect(after.record.stage).toBe("business");
	expect(after.record.decisions).toEqual([]);
	expect(after.runtime?.recipient ?? null).toBeNull();
	expect(await fs.readFile(path.join(f.cwd, document.path), "utf8")).toBe(bytes);
	expect(f.provider.requests).toEqual([]);
	const replacement = await f.owner.importBusiness(
		created.record.requirementId,
		{ kind: "upload", name: "complete.md", bytes: new TextEncoder().encode(business) },
		document.version,
	);
	const replaced = await f.owner.getRequirement(created.record.requirementId);
	expect(replaced.record.stage).toBe("business");
	expect(replaced.record.decisions).toEqual([]);
	expect(replaced.record.materials.find(material => material.kind === "business")?.version).toBe(replacement.version);
	expect(f.provider.requests).toEqual([]);
	const next = await f.preview(replaced, { kind: "next" });
	expect(next.action.binding.files.find(file => file.path === document.path)?.version).toBe(replacement.version);
	const advanced = await f.confirm(next);
	expect(advanced.snapshot.record.stage).toBe("requirements");
	expect(advanced.snapshot.record.decisions[0].files.find(file => file.path === document.path)?.version).toBe(
		replacement.version,
	);
	expect(await fs.readFile(path.join(f.cwd, document.path), "utf8")).toBe(business);
}, 120_000);

test("cold records are readable without native history or legacy-state adoption", async () => {
	await using f = await fixture();
	const snapshot = await f.imported();
	const legacy = path.join(f.cwd, ".omp/dev/state.json");
	await fs.mkdir(path.dirname(legacy), { recursive: true });
	await fs.writeFile(legacy, "{legacy malformed state");
	await f.owner.dispose();
	const cold = new SpecDrivenController({ session: f.session, settings: f.settings, cwd: f.cwd });
	try {
		const listed = await cold.listRequirements();
		expect(listed.map(item => item.record)).toEqual([snapshot.record]);
		expect(listed[0]?.runtime).toBeNull();
		expect((await cold.getRequirement(snapshot.record.requirementId)).recordVersion).toBe(snapshot.recordVersion);
		expect(f.provider.requests).toEqual([]);
		expect(await fs.readFile(legacy, "utf8")).toBe("{legacy malformed state");
		const lease = await DevWorkspace.acquire(f.cwd);
		lease.release();
	} finally {
		await cold.dispose();
	}
}, 120_000);

test("native target resolution binds the actual requirement, session and generation", async () => {
	await using f = await fixture();
	const snapshot = await f.imported();
	const result = await f.confirm(await f.preview(snapshot, { kind: "next" }));
	const native = f.owner.nativeSession(snapshot.record.requirementId)!;
	const target = {
		requirementId: snapshot.record.requirementId,
		sessionId: native.sessionId,
		generation: result.snapshot.runtime!.generation,
	};
	expect(f.owner.resolveSession(target)).toBe(native);
	expect(() => f.owner.resolveSession({ ...target, sessionId: f.session.sessionId })).toThrow();
	expect(() => f.owner.resolveSession({ ...target, generation: target.generation + 1 })).toThrow();
	expect(() => f.owner.resolveSession({ ...target, requirementId: "other-requirement" })).toThrow();
	expect(() => f.owner.resolveSession({ ...target, requirementId: null })).toThrow();
}, 120_000);

test("local business preparation creates no Git requirement and does not occupy the development slot", async () => {
	await using f = await fixture();
	const local = await f.owner.startLocalBusiness("只在本地澄清业务，不启动开发");
	expect(local.recipient.role).toBe("business");
	expect(local.document).toBeNull();
	expect(await f.owner.listRequirements()).toEqual([]);
	const native = f.owner.nativeSession();
	expect(native).toBeDefined();
	expect(native).not.toBe(f.session);
	const imported = await f.owner.createRequirement({ source: "import" });
	expect(imported.record.stage).toBe("business");
	expect(imported.runtime).toBeNull();
	expect((await f.owner.listRequirements()).map(snapshot => snapshot.record.requirementId)).toEqual([
		imported.record.requirementId,
	]);
}, 120_000);

test("Next returns durable phase facts while its real native model continues in the background", async () => {
	await using f = await fixture();
	const snapshot = await f.imported();
	const preview = await f.preview(snapshot, { kind: "next" });
	const release = Promise.withResolvers<void>();
	f.gateModel(release.promise);
	try {
		const result = await f.owner.confirmDevAction({
			operationId: preview.action.binding.operationId,
			confirmationToken: preview.confirmationToken,
			userReply: "确认业务并后台开始需求澄清",
		});
		expect(result.persistence.save, result.persistence.error ?? JSON.stringify(result.persistence)).toBe("succeeded");
		expect(result.snapshot.record.stage).toBe("requirements");
		await f.waitForModelStart();
		expect((await f.owner.getRequirement(snapshot.record.requirementId)).runtime?.execution).toBe("running");
		const requests = f.provider.requests.length;
		const unsubscribe = f.owner.observe(() => {});
		unsubscribe();
		expect((await f.owner.getRequirement(snapshot.record.requirementId)).runtime?.execution).toBe("running");
		expect(f.provider.requests).toHaveLength(requests);
		release.resolve();
		const settled = await f.waitForNativeIdle(snapshot.record.requirementId);
		expect(settled.runtime?.execution).toBe("idle");
		expect(settled.record.decisions).toHaveLength(1);
	} finally {
		release.resolve();
	}
}, 120_000);

test("a draft commit requires an explicit discovered Git target without approving the template or starting an actor", async () => {
	await using f = await fixture();
	const created = await f.owner.createRequirement({ source: "import" });
	const draft = "# 业务草稿\n\n十章节仍待完善。\n";
	await f.owner.importBusiness(created.record.requirementId, {
		kind: "upload",
		name: "draft.md",
		bytes: new TextEncoder().encode(draft),
	});
	const before = await f.owner.getRequirement(created.record.requirementId);
	await expect(f.preview(before, { kind: "commit" })).rejects.toThrow("Git");
	const after = await f.owner.getRequirement(created.record.requirementId);
	expect(after.record).toEqual(before.record);
	expect(after.record.stage).toBe("business");
	expect(after.record.decisions).toEqual([]);
	expect(f.owner.nativeSession(created.record.requirementId)).toBeUndefined();
	expect(f.provider.requests).toEqual([]);
	expect((await f.owner.readMaterial(created.record.requirementId, "business")).content).toBe(draft);
}, 120_000);

test("the same controller cancellation confirmation resumes final tombstone CAS after a successful fixed-SHA publication", async () => {
	await using f = await fixture({ remote: true, failFinalCancellation: true });
	const snapshot = await f.imported();
	const id = snapshot.record.requirementId;
	const targets = await f.owner.discoverDevGitTargets(id);
	const target = targets.find(
		candidate =>
			candidate.localSourceRef === "refs/heads/feature" &&
			candidate.sourceRef === "refs/heads/feature" &&
			candidate.baseRef === "refs/heads/main",
	);
	if (!target) throw new Error("Native controller did not discover the existing fixture source/base target");
	const preview = await f.preview(snapshot, { kind: "cancel" }, target);
	const confirmation = {
		operationId: preview.action.binding.operationId,
		confirmationToken: preview.confirmationToken,
		userReply: "确认撤销本需求全部范围并提交推送，不影响原有文件",
	};
	const first = await f.owner.confirmDevAction(confirmation);
	const diagnostic = JSON.stringify({
		persistence: first.persistence,
		lifecycle: first.snapshot.record.lifecycle,
		finalSaveFailures: f.finalSaveFailures(),
	});
	expect(first.persistence.commit.status, diagnostic).toBe("succeeded");
	expect(first.persistence.commit.indexReconciled, diagnostic).toBe(true);
	expect(first.persistence.push.status, diagnostic).toBe("succeeded");
	expect(first.persistence.save, diagnostic).toBe("failed");
	expect(first.persistence.error, diagnostic).toContain("final tombstone CAS failure");
	expect(first.snapshot.record.lifecycle).toBe("cancelling");
	const sha = first.persistence.commit.sha;
	if (!sha) throw new Error("Expected the already-published cancellation SHA");
	expect(await f.repo.headSha()).toBe(sha);
	expect((await f.repo.remoteRef("fixture", "refs/heads/feature")).sha).toBe(sha);
	const committed = JSON.parse((await f.repo.showBlob(`${sha}:docs/dev-requirements/${id}.json`)).data.toString());
	expect(committed.lifecycle).toBe("cancelled");
	expect((await readDevRequirement(f.cwd, id)).record.lifecycle).toBe("cancelling");
	await expect(f.owner.createRequirement({ source: "import" })).rejects.toThrow();
	const resumed = await f.owner.confirmDevAction(confirmation);
	expect(resumed.persistence.save).toBe("succeeded");
	expect(resumed.persistence.error).toBeUndefined();
	expect(resumed.snapshot.record.lifecycle).toBe("cancelled");
	expect(resumed.persistence.commit.sha).toBe(sha);
	expect(await f.repo.headSha()).toBe(sha);
	expect((await f.repo.remoteRef("fixture", "refs/heads/feature")).sha).toBe(sha);
	expect((await readDevRequirement(f.cwd, id)).record.lifecycle).toBe("cancelled");
	expect(f.finalSaveFailures()).toBe(1);
	expect(await fs.readFile(path.join(f.cwd, "tracked.txt"), "utf8")).toBe("unrelated original bytes\n");
	await expect(
		fs.stat(path.join(f.cwd, `docs/business-requirements/${snapshot.record.changeId}.md`)),
	).rejects.toMatchObject({ code: "ENOENT" });
	const successor = await f.owner.createRequirement({ source: "import" });
	expect(successor.record.requirementId).not.toBe(id);
	expect(successor.record.stage).toBe("business");
	expect(successor.runtime).toBeNull();
	expect(f.provider.requests).toEqual([]);
}, 120_000);

test("cancelling material reads tolerate a removed recorded archive without changing cancellation facts", async () => {
	await using f = await fixture();
	const initial = await f.imported();
	await f.owner.dispose();
	const id = initial.record.requirementId;
	const archive = `openspec/changes/archive/2026-11-07-${initial.record.changeId}`;
	const proposalPath = `${archive}/proposal.md`;
	const content =
		"## Why\n\nThe requirement's archived proposal is retained until its explicitly confirmed cancellation removes the owned materials.\n\n## What Changes\n\n- Preserve material history as a read-only cancellation fact.\n";
	await fs.mkdir(path.join(f.cwd, archive), { recursive: true });
	await fs.writeFile(path.join(f.cwd, proposalPath), content);
	const proposal = {
		id: "proposal",
		kind: "proposal" as const,
		path: proposalPath,
		version: artifactVersion(content),
	};
	const archived: DevRequirementRecord = {
		...initial.record,
		stage: "pr",
		materials: [...initial.record.materials, proposal],
		syncRevisions: [
			{
				operationId: "recorded-archive-before-cancellation",
				files: [{ path: proposal.path, version: proposal.version }],
				mainSpecs: [],
				archivedChangePath: archive,
				progress: { synced: true, archivedChangePath: archive },
			},
		],
	};
	let stored = await saveDevRequirement(f.cwd, archived, initial.recordVersion);
	const reader = new SpecDrivenController({ session: f.session, settings: f.settings, cwd: f.cwd });
	try {
		expect(await reader.listMaterials(id)).toContainEqual(proposal);
		expect((await reader.readMaterial(id, proposal.id)).content).toBe(content);
		await fs.rm(path.join(f.cwd, archive), { recursive: true });
		const activeBytes = await fs.readFile(path.join(f.cwd, `docs/dev-requirements/${id}.json`));
		await expect(reader.listMaterials(id)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(reader.readMaterial(id, proposal.id)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readDevRequirement(f.cwd, id)).toEqual(stored);
		expect(await fs.readFile(path.join(f.cwd, `docs/dev-requirements/${id}.json`))).toEqual(activeBytes);
		stored = await saveDevRequirement(f.cwd, { ...stored.record, lifecycle: "cancelling" }, stored.recordVersion);
		for (const lifecycle of ["cancelling", "cancelled"] as const) {
			if (stored.record.lifecycle !== lifecycle)
				stored = await saveDevRequirement(f.cwd, { ...stored.record, lifecycle }, stored.recordVersion);
			const bytes = await fs.readFile(path.join(f.cwd, `docs/dev-requirements/${id}.json`));
			expect(await reader.listMaterials(id)).toEqual([]);
			await expect(reader.readMaterial(id, proposal.id)).rejects.toBeInstanceOf(SpecAdmissionError);
			expect(await readDevRequirement(f.cwd, id)).toEqual(stored);
			expect(await fs.readFile(path.join(f.cwd, `docs/dev-requirements/${id}.json`))).toEqual(bytes);
			await expect(fs.stat(path.join(f.cwd, archive))).rejects.toMatchObject({ code: "ENOENT" });
			await expect(fs.stat(path.join(f.cwd, `openspec/changes/${initial.record.changeId}`))).rejects.toMatchObject({
				code: "ENOENT",
			});
		}
		expect(f.provider.requests).toEqual([]);
	} finally {
		await reader.dispose();
	}
}, 120_000);
