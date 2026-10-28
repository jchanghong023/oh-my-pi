import { describe, expect, it } from "bun:test";
import { hasExplicitRepairIntent, SpecDrivenOrchestrator } from "../../src/spec-driven/orchestrator";
import type {
	SpecAgentInput,
	SpecDocument,
	SpecDrivenPorts,
	SpecSavedRun,
	SpecSolution,
	SpecStageRole,
} from "../../src/spec-driven/types";

describe("explicit repair intent", () => {
	it("distinguishes constrained repairs from questions, discussion and general prohibitions", () => {
		for (const text of [
			"repair closing 明确只移除同步路径障碍，不修改已批准材料",
			"修复这个错误，不要修改公开 API",
			"修复报告中区别不清的问题",
			"请修正批准范围内的失败测试",
			"Please fix the obstruction, without changing the approved files",
			"修复：仅修复归档目录阻塞，删除刚才夹具自有的标记文件和目标目录；不修改已验收材料、不执行业务实现、不运行同步归档，等待我 /dev next。",
		]) {
			expect(hasExplicitRepairIntent(text)).toBe(true);
		}
		for (const text of [
			"修复这个错误是否会影响现有调用？先解释，不要改代码",
			"修正这个问题需要改哪些文件",
			"改正这个错误会影响哪些调用",
			"不要修复，只解释",
			"修复这个错误，不要改代码",
			"修复这个错误，不修改已批准材料和代码",
			"好的",
		]) {
			expect(hasExplicitRepairIntent(text)).toBe(false);
		}
	});
});

function fixture(saved?: SpecSavedRun) {
	const document = (path: string): SpecDocument => ({ path, version: `${path}-v1`, content: `完整原文 ${path} Ω` });
	const docs = {
		proposal: document("proposal.md"),
		spec: document("spec.md"),
		solution: document("solutions.json"),
		plan: document("plan.md"),
		report: document("completion.md"),
	};
	const inputs: SpecAgentInput[] = [];
	const events: string[] = [];
	const reads: string[] = [];
	const persisted: SpecSavedRun[] = [];
	const settings = {
		team: false,
		saveFailure: false,
		prepareFailure: false,
		closeFailure: false,
		runFailure: false,
		sessionSuffix: "",
		bad: "",
		busy: false,
		candidates: ["one"],
		closeCalls: 0,
		syncCalls: 0,
	};
	let onRead: ((name: keyof typeof docs) => void) | undefined;
	const sessions = new Set<SpecStageRole>();
	const read = (name: keyof typeof docs) => {
		reads.push(name);
		onRead?.(name);
		if (settings.bad === name) throw new Error(`${docs[name].path}: invalid structure`);
		return structuredClone(docs[name]);
	};
	const ports: SpecDrivenPorts = {
		agents: {
			async prepare(role) {
				events.push(`prepare:${role}`);
				if (settings.prepareFailure) throw new Error("prepare failed");
				sessions.add(role);
			},
			recipient: role =>
				sessions.has(role)
					? {
							role,
							actorId: role,
							sessionId: `session-${role}${settings.sessionSuffix}`,
							sessionFile: `${role}${settings.sessionSuffix}.jsonl`,
						}
					: undefined,
			originalRequest: () => "原始需求 Ω",
			async run(input) {
				events.push(`run:${input.role}`);
				inputs.push(structuredClone(input));
				if (settings.runFailure) throw new Error("provider failed");
				return { text: "同意，完成" };
			},
		},
		artifacts: {
			async initialize() {
				return {
					requirements: [docs.proposal.path, docs.spec.path],
					solution: docs.solution.path,
					plan: docs.plan.path,
					report: docs.report.path,
				};
			},
			async readRequirements() {
				return { files: [read("proposal"), read("spec")], version: "requirements-v1" };
			},
			async readSolution() {
				return {
					...read("solution"),
					candidates: settings.candidates.map(id => ({ id, title: id, content: `完整方案 ${id}` })),
					recommendedCandidateId: settings.candidates[0]!,
				};
			},
			async readPlan() {
				return read("plan");
			},
			async readReport() {
				return read("report");
			},
			async checkVersions(files) {
				const changed = files
					.filter(file => !Object.values(docs).some(doc => doc.path === file.path && doc.version === file.version))
					.map(file => ({ path: file.path, reason: "bytes changed" }));
				return { matches: !changed.length, changed };
			},
			async close(input) {
				settings.closeCalls++;
				if (!input.progress?.synced) {
					settings.syncCalls++;
					await input.onProgress?.({ synced: true });
				}
				if (settings.closeFailure) throw new Error("archive failed");
				await input.onProgress?.({ synced: true, archivedChangePath: "archive/change" });
				return { archivedChangePath: "archive/change" };
			},
		},
	};
	const core = new SpecDrivenOrchestrator(ports, {
		runId: saved?.runId ?? "run",
		getUseTeam: () => settings.team,
		async persist(run) {
			events.push(`save:${run.phase}`);
			if (settings.saveFailure) throw new Error("disk full");
			persisted.push(structuredClone(run));
		},
		onStatusChange: status => events.push(`notify:${status.phase}`),
		assertTransitionAllowed() {
			if (settings.busy) throw new Error("native work pending");
		},
	});
	return {
		core,
		docs,
		inputs,
		reads,
		events,
		persisted,
		settings,
		onRead(callback: typeof onRead) {
			onRead = callback;
		},
	};
}
async function execution(f: { core: SpecDrivenOrchestrator }) {
	await f.core.start("原始需求 Ω", "change");
	await f.core.next();
	await f.core.next();
	await f.core.next();
}

describe("explicit Dev file decisions", () => {
	it("advances four times only and closes without another model call", async () => {
		const f = fixture();
		await execution(f);
		expect(f.core.status().phase).toBe("executing");
		expect(f.inputs.map(input => input.role)).toEqual(["requirements", "solution", "planner", "executor"]);
		expect(f.settings.closeCalls).toBe(0);
		await f.core.next();
		expect(f.core.status().phase).toBe("idle");
		expect(f.inputs).toHaveLength(4);
	});
	it("never reads structure on stage replies or ordinary agreement", async () => {
		const f = fixture();
		f.settings.bad = "proposal";
		await f.core.start("原始需求 Ω", "change");
		await f.core.converse("同意，继续");
		expect(f.reads).toEqual([]);
		expect(f.core.status().phase).toBe("requirements");
		await expect(f.core.next()).rejects.toThrow("proposal.md");
		expect(f.core.status().phase).toBe("requirements");
		expect(f.core.save().approvals).toEqual({});
	});
	it("hands complete files and exact selection text to the planner", async () => {
		const f = fixture();
		await f.core.start("原始需求 Ω", "change");
		await f.core.next(undefined, "需求决定原文\n Ω ");
		const raw = " /dev next one\n 保留 Ω ";
		await f.core.next("one", raw);
		const solution: SpecSolution = {
			...f.docs.solution,
			candidates: [{ id: "one", title: "one", content: "完整方案 one" }],
			recommendedCandidateId: "one",
		};
		expect(f.inputs[2].files).toEqual([f.docs.proposal, f.docs.spec, solution]);
		expect(f.inputs[2].userReply).toBe(raw);
		expect(f.inputs[2].candidateId).toBe("one");
	});
	it("passes all alternatives and the recommendation while respecting a different user selection", async () => {
		const f = fixture();
		f.settings.candidates = ["one", "two"];
		await f.core.start("原始需求", "change");
		await f.core.next();
		await f.core.next("two", "/dev next two");
		expect(f.inputs[2].files.at(-1)).toMatchObject({
			candidates: [
				{ id: "one", title: "one", content: "完整方案 one" },
				{ id: "two", title: "two", content: "完整方案 two" },
			],
			recommendedCandidateId: "one",
		});
		expect(f.inputs[2].candidateId).toBe("two");
		expect(f.inputs[2].userReply).toBe("/dev next two");
	});
	it("hands approved executor originals, raw decisions and report path without narrowing business scope", async () => {
		const f = fixture();
		await f.core.start("原始需求 Ω", "change");
		await f.core.next(undefined, "需求决定 Ω");
		await f.core.next("one", "方案决定 Ω");
		await f.core.next(undefined, "计划决定 Ω");
		expect(f.inputs.at(-1)).toMatchObject({
			role: "executor",
			request: "原始需求 Ω",
			files: [
				f.docs.proposal,
				f.docs.spec,
				{
					...f.docs.solution,
					candidates: [{ id: "one", title: "one", content: "完整方案 one" }],
					recommendedCandidateId: "one",
				},
				f.docs.plan,
			],
			userReply: "计划决定 Ω",
			decisions: { requirements: "需求决定 Ω", solution: "方案决定 Ω", planner: "计划决定 Ω" },
			candidateId: "one",
			outputPaths: ["completion.md"],
		});
	});
	for (const phase of ["solution", "planning", "executing"] as const) {
		it(`rejects requirement bytes changed during ${phase} reads without approving, handing off or closing`, async () => {
			const f = fixture();
			await f.core.start("request", "change");
			await f.core.next();
			if (phase !== "solution") await f.core.next();
			if (phase === "executing") await f.core.next();
			const before = f.core.save();
			const runs = f.inputs.length;
			f.onRead(name => {
				if (name === "proposal") {
					f.docs.spec.version = "spec-v2";
					f.docs.spec.content = "unapproved v2";
				}
			});
			await expect(f.core.next()).rejects.toThrow("重新确认");
			expect(f.core.save()).toEqual(before);
			expect(f.inputs).toHaveLength(runs);
			expect(f.settings.closeCalls).toBe(0);
			expect(f.core.status().phase).toBe(phase);
		});
	}
	for (const material of ["solution", "plan"] as const) {
		it(`rejects ${material} bytes changed after the approval check at final acceptance`, async () => {
			const f = fixture();
			await execution(f);
			const before = f.core.save();
			f.onRead(name => {
				if (name === material) f.docs[material].version = "unapproved-v2";
			});
			await expect(f.core.next()).rejects.toThrow("重新确认");
			expect(f.core.save()).toEqual(before);
			expect(f.settings.closeCalls).toBe(0);
		});
	}
	it("compares actual handoff versions even when disk versions return to approved bytes after the read", async () => {
		const f = fixture();
		await f.core.start("request", "change");
		await f.core.next();
		const original = structuredClone(f.docs.proposal);
		f.onRead(name => {
			if (name === "proposal") f.docs.proposal.version = "transient-unapproved-v2";
			if (name === "spec") Object.assign(f.docs.proposal, original);
		});
		await expect(f.core.next()).rejects.toThrow("重新确认");
		expect((await f.core.checkApproved()).matches).toBe(true);
		expect(f.inputs).toHaveLength(2);
		expect(f.core.status().phase).toBe("solution");
	});
	it("clears a recovered native failure after successful conversation but retains approval mismatch", async () => {
		const f = fixture();
		await execution(f);
		f.settings.prepareFailure = true;
		await expect(f.core.back()).rejects.toThrow("prepare failed");
		expect(f.core.status().blockedReason).toBe("prepare failed");
		f.settings.prepareFailure = false;
		await f.core.converse("重试原生对话");
		expect(f.core.status().blockedReason).toBeUndefined();
		f.docs.spec.version = "changed";
		await expect(f.core.next()).rejects.toThrow("重新确认");
		const blocked = f.core.status().blockedReason;
		await f.core.converse("解释材料变化");
		expect(f.core.status().blockedReason).toBe(blocked);
	});
	it("defaults a single candidate but rejects invalid and missing multi-candidate IDs", async () => {
		const f = fixture();
		await f.core.start("request", "change");
		await f.core.next();
		await expect(f.core.next("missing")).rejects.toThrow("有效方案 ID");
		f.settings.candidates = ["one", "two"];
		await expect(f.core.next()).rejects.toThrow("有效方案 ID");
		expect(f.core.status().phase).toBe("solution");
		await f.core.next("two");
		expect(f.core.status().selection?.candidateId).toBe("two");
	});
	it("rejects stage-inapplicable parameters and native unsettled work", async () => {
		const f = fixture();
		await expect(f.core.next()).rejects.toThrow("/dev new");
		await f.core.start("request", "change");
		await expect(f.core.next("one")).rejects.toThrow("仅方案阶段");
		f.settings.busy = true;
		await expect(f.core.next()).rejects.toThrow("native work pending");
		expect(f.core.status().phase).toBe("requirements");
	});
	it("checks approved bytes without changing phase or decisions", async () => {
		const f = fixture();
		await execution(f);
		const before = f.core.save();
		f.docs.spec.version = "changed";
		f.reads.length = 0;
		expect((await f.core.checkApproved()).matches).toBe(false);
		await expect(f.core.next()).rejects.toThrow("重新确认");
		await f.core.converse("解释不一致原因");
		expect(f.inputs.at(-1)?.readOnly).toBe(true);
		await expect(f.core.converse("修复", undefined, undefined, "repair")).rejects.toThrow("重新确认");
		expect(f.core.save()).toEqual(before);
		expect(f.core.status().phase).toBe("executing");
		expect(f.reads).toEqual([]);
	});
	it("backs only one stage, revokes target approval, and runs no work", async () => {
		const f = fixture();
		await execution(f);
		const count = f.inputs.length;
		await f.core.back();
		expect(f.core.status().phase).toBe("planning");
		expect(Object.keys(f.core.save().approvals)).toEqual(["requirements", "solution"]);
		await f.core.back();
		expect(f.core.status().phase).toBe("solution");
		expect(Object.keys(f.core.save().approvals)).toEqual(["requirements"]);
		await f.core.back();
		expect(f.core.status().phase).toBe("requirements");
		await expect(f.core.back()).rejects.toThrow("不能回退");
		expect(f.inputs).toHaveLength(count);
	});
	it("prepares and saves before publishing and running", async () => {
		const f = fixture();
		await f.core.start("request", "change");
		expect(f.events.slice(0, 4)).toEqual([
			"prepare:requirements",
			"save:requirements",
			"notify:requirements",
			"run:requirements",
		]);
		f.settings.saveFailure = true;
		await expect(f.core.next()).rejects.toThrow("disk full");
		expect(f.core.status().phase).toBe("requirements");
		expect(f.inputs).toHaveLength(1);
		expect(f.core.save().approvals).toEqual({});
	});
	it("does not change phase or call a model when session preparation fails", async () => {
		const f = fixture();
		await f.core.start("request", "change");
		f.settings.prepareFailure = true;
		await expect(f.core.next()).rejects.toThrow("prepare failed");
		expect(f.core.status().phase).toBe("requirements");
		expect(f.inputs).toHaveLength(1);
	});
	it("uses one Team configuration source and never reruns Team for conversation", async () => {
		const f = fixture();
		f.settings.team = true;
		await f.core.start("request", "change");
		await f.core.next();
		expect(f.inputs[1].useTeam).toBe(true);
		f.reads.length = 0;
		await f.core.converse("原始追问");
		expect(f.inputs[2]).toMatchObject({ entry: false, feedback: "原始追问", files: [], request: "", useTeam: false });
		expect(f.reads).toEqual([]);
	});
	it("lets the user explicitly accept a report disclosing failed and unverified work", async () => {
		const f = fixture();
		await execution(f);
		f.docs.report.content =
			"# 完成报告\n\n## 完成情况\n部分实施。\n\n## 验证结果\n测试失败，审查未运行。\n\n## 未完成项\n修复测试并完成审查。";
		await f.core.observeReport();
		expect(f.core.status().awaitingAcceptance).toBe(true);
		await f.core.converse("解释验证限制");
		expect(f.inputs.at(-1)?.readOnly).toBe(true);
		const modelCalls = f.inputs.length;
		await f.core.next(undefined, "/dev next 接受已披露的限制");
		expect(f.settings.closeCalls).toBe(1);
		expect(f.inputs).toHaveLength(modelCalls);
		expect(f.core.save().approvals.executor?.userReply).toBe("/dev next 接受已披露的限制");
		expect(f.core.status().phase).toBe("idle");
	});
	it("marks report writes without structure reads and revokes stale report eligibility on business repair", async () => {
		const f = fixture();
		await execution(f);
		f.reads.length = 0;
		await f.core.observeReport();
		expect(f.reads).toEqual([]);
		await f.core.converse("解释验证限制");
		expect(f.inputs.at(-1)?.readOnly).toBe(true);
		await f.core.converse("修复范围内缺陷", undefined, undefined, "repair");
		expect(f.core.status().awaitingAcceptance).toBe(true);
		expect(f.core.save().reportNeedsUpdate).toBeUndefined();
		await f.core.beginRepair();
		expect(f.core.status().awaitingAcceptance).toBe(false);
		await expect(f.core.next()).rejects.toThrow("更新完成报告");
		await f.core.observeReport();
		await f.core.next();
		expect(f.core.status().phase).toBe("idle");
	});
	it("blocks back when a failed sync left unrestored side effects without an archive", async () => {
		const f = fixture();
		await execution(f);
		const saved = f.core.save();
		saved.closing = { sideEffects: { paths: ["openspec/specs/example/spec.md"], diagnostic: "rollback failed" } };
		const restored = fixture(saved);
		await restored.core.restore(saved);
		await expect(restored.core.back()).rejects.toThrow("实际结果");
		expect(restored.core.status().phase).toBe("executing");
	});
	it("preserves acceptance and actual closing progress, keeps executor conversation, retries remaining work", async () => {
		const f = fixture();
		await execution(f);
		f.settings.closeFailure = true;
		await expect(f.core.next()).rejects.toThrow("archive failed");
		const accepted = f.core.save().approvals.executor;
		expect(f.core.currentRole()).toBe("executor");
		expect(f.core.save().closing).toEqual({ synced: true });
		await expect(f.core.back()).rejects.toThrow("实际结果");
		await f.core.converse("解释收尾错误");
		expect(f.inputs.at(-1)?.readOnly).toBe(true);
		await f.core.converse("修复直接收尾故障", undefined, undefined, "repair");
		await f.core.beginRepair();
		expect(f.core.save().approvals.executor).toEqual(accepted);
		f.settings.closeFailure = false;
		const modelCalls = f.inputs.length;
		await f.core.next(undefined, "重试，不重新验收");
		expect(f.settings.syncCalls).toBe(1);
		expect(f.inputs).toHaveLength(modelCalls);
		expect(f.core.save().approvals.executor).toEqual(accepted);
	});
	it("refuses changed accepted material during closing without losing progress", async () => {
		const f = fixture();
		await execution(f);
		f.settings.closeFailure = true;
		await expect(f.core.next()).rejects.toThrow();
		f.docs.report.version = "external-change";
		await expect(f.core.next()).rejects.toThrow("重新确认");
		expect(f.settings.closeCalls).toBe(1);
		expect(f.core.status().phase).toBe("executing");
		expect(f.core.save().closing?.synced).toBe(true);
	});
	it("restores native session references without models, structure reads, or stored bodies", async () => {
		const f = fixture();
		await execution(f);
		const saved = f.core.save();
		expect(JSON.stringify(saved)).not.toContain("完整原文");
		expect(JSON.stringify(saved)).not.toContain("原始需求");
		const restored = fixture(saved);
		await restored.core.restore(saved);
		expect(restored.core.status().phase).toBe("executing");
		expect(restored.core.recipient()?.sessionFile).toBe("executor.jsonl");
		expect(restored.inputs).toEqual([]);
		expect(restored.reads).toEqual([]);
	});
	it("restores mismatched approvals without clearing decisions or running work", async () => {
		const f = fixture();
		await execution(f);
		const saved = f.core.save();
		const restored = fixture(saved);
		restored.docs.spec.version = "changed";
		await restored.core.restore(saved);
		expect(restored.core.status().blockedReason).toContain("bytes changed");
		expect(restored.core.save().approvals).toEqual(saved.approvals);
		expect(restored.inputs).toEqual([]);
	});
	it("resumes only remaining closing work after restoration without reading structure", async () => {
		const f = fixture();
		await execution(f);
		f.settings.closeFailure = true;
		await expect(f.core.next()).rejects.toThrow("archive failed");
		const saved = f.core.save();
		const restored = fixture(saved);
		await restored.core.restore(saved);
		await restored.core.next();
		expect(restored.reads).toEqual([]);
		expect(restored.inputs).toEqual([]);
		expect(restored.settings.syncCalls).toBe(0);
		expect(restored.settings.closeCalls).toBe(1);
		expect(restored.core.status().phase).toBe("idle");
	});
	it("sends native attachments and busy follow-ups without a Dev queue", async () => {
		const f = fixture();
		await f.core.start("request", "change");
		f.settings.busy = true;
		const images = [{ type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" }];
		await f.core.converse("  原始输入 Ω\n", images, ["https://example.test/image.png"]);
		expect(f.inputs.at(-1)).toMatchObject({
			entry: false,
			feedback: "  原始输入 Ω\n",
			images,
			imageLinks: ["https://example.test/image.png"],
			files: [],
			request: "",
			useTeam: false,
		});
		expect(f.reads).toEqual([]);
		expect(f.core.save().phase).toBe("requirements");
	});
	it("retains the saved target phase when native model work fails after entry", async () => {
		const f = fixture();
		await f.core.start("request", "change");
		f.settings.runFailure = true;
		await expect(f.core.next()).rejects.toThrow("provider failed");
		expect(f.core.status().phase).toBe("solution");
		expect(f.core.save().approvals.requirements?.userReply).toBe("/dev next");
		expect(f.persisted.at(-1)?.phase).toBe("solution");
	});
	it("persists actual re-prepared native session references on restore", async () => {
		const f = fixture();
		await execution(f);
		const saved = f.core.save();
		const restored = fixture(saved);
		restored.settings.sessionSuffix = "-recovered";
		await restored.core.restore(saved);
		expect(restored.core.save().sessions.executor?.sessionFile).toBe("executor-recovered.jsonl");
		expect(restored.persisted.at(-1)?.sessions.executor?.sessionFile).toBe("executor-recovered.jsonl");
		expect(restored.inputs).toEqual([]);
	});
	it("retains the saved phase and decisions when native history preparation fails", async () => {
		const f = fixture();
		await execution(f);
		const saved = f.core.save();
		const restored = fixture(saved);
		restored.settings.prepareFailure = true;
		await expect(restored.core.restore(saved)).rejects.toThrow("prepare failed");
		expect(restored.core.status().phase).toBe("executing");
		expect(restored.core.save().approvals).toEqual(saved.approvals);
		expect(restored.core.status().blockedReason).toBe("prepare failed");
		expect(restored.inputs).toEqual([]);
	});
});
