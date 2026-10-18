import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { sessionResolveContext } from "@oh-my-pi/pi-coding-agent/internal-urls/context";
import {
	registerArtifactsDir,
	resetRegisteredArtifactDirsForTests,
} from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	assembleTeamReport,
	runTeamDiscussion,
	type TeamAlignmentOutput,
	type TeamParticipant,
	type TeamProposalOutput,
	type TeamProposalRecord,
	type TeamReviewOutput,
	type TeamReviewRecord,
	type TeamRevisionOutput,
	type TeamSubagentCall,
	type TeamSubagentRunner,
	type TeamSynthesisOutput,
} from "@oh-my-pi/pi-coding-agent/team";

const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
const participant: TeamParticipant = {
	index: 0,
	modelPattern: `${model.provider}/${model.id}`,
	model,
	isSessionModel: true,
};
const alignment: TeamAlignmentOutput = {
	unifiedUnderstanding: "Preserve the public API.",
	acceptanceCriteria: ["Existing callers continue working"],
	factDifferences: [],
	interpretationDifferences: [],
};
const proposal: TeamProposalOutput = {
	proposal: "original-plan-marker: keep the existing interface",
	noViableProposal: false,
	investigationBlockedReason: "",
	keyAssumptions: [],
	risks: [],
	unknowns: [],
	acceptanceCriteria: ["Existing callers continue working"],
	ambiguityInterpretations: [],
	evidence: [],
};
const blockingReview: TeamReviewOutput = {
	noSubstantiveIssues: false,
	reviewSummary: "Verify compatibility.",
	findings: [
		{
			severity: "blocking",
			issue: "The compatibility premise is wrong",
			impact: "Existing clients fail",
			evidence: "review-source-marker: src/interface.ts:10",
			targetAspect: "Public interface",
		},
	],
	blockingResolutions: [],
};
const revision: TeamRevisionOutput = {
	revisedProposal: "Use the existing interface with a documented adapter.",
	revisionSummary: "revision-change-marker: document the existing adapter",
	responses: [
		{
			findingId: "A-F1",
			disposition: "rejected-with-evidence",
			explanation: "response-evidence-marker: src/adapter.ts:42 already supports old callers",
		},
	],
	reviewFlags: {
		changedCoreDesign: true,
		claimsResolvedBlocking: false,
		newEvidenceChangesAssumptions: false,
		disputesBlockingFinding: true,
	},
};
const synthesis: TeamSynthesisOutput = {
	reportMarkdown: "The compatibility evidence is available.",
	recommendedProposal: "A",
	recommendationReason: "Maintains the public API",
	recommendationPreconditions: "",
	hardConstraintViolations: [],
};

function blockedRecord(label = "A"): TeamProposalRecord {
	const review: TeamReviewRecord = {
		...blockingReview,
		findings: blockingReview.findings.map((finding, index) => ({ ...finding, id: `${label}-F${index + 1}` })),
	};
	return {
		label,
		participant,
		originalProposal: proposal,
		latestProposal: proposal,
		reviews: [review],
		revisionHistory: [],
		roundsUsed: 0,
		unresolvedBlocking: review.findings,
		nextFindingNumber: review.findings.length + 1,
		proposerFailed: false,
		reviewFailed: false,
		recheckFailed: false,
		pendingRecheck: false,
		revisionFailed: false,
		excludedFromOptions: false,
		blockedAfterRoundCap: false,
	};
}

function reportWithBody(
	reportMarkdown: string,
	recommendation: Partial<TeamSynthesisOutput> = {},
	proposals: readonly TeamProposalRecord[] = [blockedRecord(), { ...blockedRecord("B"), unresolvedBlocking: [] }],
) {
	return assembleTeamReport({
		alignment,
		synthesis: { ...synthesis, recommendedProposal: "", reportMarkdown, ...recommendation },
		proposals,
		participationNotes: [],
	});
}

describe("team consumer regressions", () => {
	it("lets the isolated rechecker adjudicate response-only evidence and compare the prior design", async () => {
		const rechecks: TeamSubagentCall[] = [];
		const runner: TeamSubagentRunner = async call => {
			switch (call.role) {
				case "proposer":
					return { ok: true, data: { ...proposal } };
				case "aligner":
					return { ok: true, data: { ...alignment } };
				case "reviser":
					return { ok: true, data: { ...revision } };
				case "synthesizer":
					return { ok: true, data: { ...synthesis } };
				case "reviewer": {
					if (!call.task.includes(" recheck]")) return { ok: true, data: { ...blockingReview } };
					rechecks.push(call);
					const canAdjudicate = [
						"original-plan-marker",
						"revision-change-marker",
						"response-evidence-marker",
						"review-source-marker",
					].every(marker => call.task.includes(marker));
					return {
						ok: true,
						data: {
							noSubstantiveIssues: true,
							reviewSummary: "Checked the cited compatibility evidence.",
							findings: [],
							blockingResolutions: [
								{
									findingId: "A-F1",
									status: canAdjudicate ? "resolved" : "unresolved",
									basis: canAdjudicate
										? "The response cites the existing adapter preserving old callers."
										: "The prior design and cited compatibility evidence are not available.",
								},
							],
						},
					};
				}
			}
		};
		const result = await runTeamDiscussion({
			question: "Preserve compatibility while extending the API.",
			cwd: "/tmp/repo",
			participants: [participant],
			sessionModelPattern: participant.modelPattern,
			runner,
			signal: new AbortController().signal,
			maxConcurrency: 1,
		});
		expect(result.status).toBe("completed");
		expect(result.reportMarkdown).toContain("【推荐】方案 A");
		expect(result.reportMarkdown).not.toContain("尚不可采用");
		expect(rechecks).toHaveLength(1);
		expect(rechecks[0]!.task).not.toContain(participant.modelPattern);
	});

	it("renders each tracked blocker ID and issue without leaking finding objects", () => {
		const result = reportWithBody("方案 B 满足验收标准。", { recommendedProposal: "B" });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.markdown).toContain("A-F1");
			expect(result.markdown).toContain(blockingReview.findings[0]!.issue);
			expect(result.markdown).not.toContain("[object Object]");
			expect(result.markdown).toContain("| 方案 A | ⛔ 尚不可采用");
			expect(result.markdown).toContain("【推荐】方案 B");
		}
	});

	it.each(["方案 **A** 可以采用。", "方案 `A` 可以作为最终选项。", "方案 [A](#a) 可采用。"])(
		"rejects a visible adoption claim for a blocked Markdown-formatted label: %s",
		body => {
			const result = reportWithBody(body);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error).toContain("尚不可采用");
		},
	);

	it.each([
		"方案 A 比方案 B 更值得推荐。",
		"方案 A 比方案 B 更可以采用。",
		"**A**方案 比方案 [B](#b) 更可以作为最终选项。",
	])("rejects an endorsement of the blocked comparison subject, not the nearer object: %s", body => {
		const result = reportWithBody(body);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("尚不可采用”的方案 A");
	});

	it.each([
		"方案 B 比方案 A 更值得推荐。",
		"方案 `B` 比 **A**方案 更可以采用。",
		"方案 A 比方案 B 更不值得推荐。",
		"方案 **A** 不可以采用；方案 B 比方案 A 更值得推荐。",
		"方案 **A** 若阻断问题解决后才可采用；方案 B 比方案 A 更值得推荐。",
	])("keeps a valid comparison subject despite a blocked object or qualified alternative: %s", body => {
		const result = reportWithBody(body, { recommendedProposal: "B" });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.markdown).toContain("【推荐】方案 B");
			expect(result.markdown).toContain("| 方案 A | ⛔ 尚不可采用");
			expect(result.droppedRecommendation).toBe(false);
		}
	});

	it.each(["方案 **A** 不可以采用。", "方案 **A** 若阻断问题解决后才可采用。"])(
		"keeps a formatted negation or explicitly conditional adoption distinct from current approval: %s",
		body => {
			const result = reportWithBody(body);
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.markdown).toContain("| 方案 A | ⛔ 尚不可采用");
		},
	);

	it.each(["方案 A 不能作为首选。方案 B 满足验收标准。", "不应推荐方案 A。方案 B 满足验收标准。"])(
		"keeps a valid recommendation alongside an ordinary negative statement: %s",
		body => {
			const result = reportWithBody(body, { recommendedProposal: "B" });
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.markdown).toContain(body);
				expect(result.markdown).toContain("【推荐】方案 B");
				expect(result.markdown).toContain("| 方案 A | ⛔ 尚不可采用");
				expect(result.droppedRecommendation).toBe(false);
			}
		},
	);

	it.each(["reportMarkdown", "recommendationReason", "recommendationPreconditions"] as const)(
		"rejects a blocked endorsement in emitted %s despite a valid structured recommendation",
		field => {
			const result = reportWithBody("方案 B 满足验收标准。", {
				recommendedProposal: "B",
				[field]: "方案 A 可以采用，但方案 B 的维护成本更低",
			});
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error).toContain("尚不可采用");
		},
	);

	it("does not let a negative claim mask a later affirmative claim in the same clause", () => {
		const result = reportWithBody("方案 A 不能作为首选，仍可以采用。", { recommendedProposal: "B" });
		expect(result.ok).toBe(false);
	});

	it("preserves negative and conditional adoption language in recommendation prose", () => {
		const recommendationReason = "方案 A 不能作为首选，方案 B 的维护成本更低";
		const recommendationPreconditions = "方案 A 若阻断问题解决后才可采用";
		const result = reportWithBody("方案 B 满足验收标准。", {
			recommendedProposal: "B",
			recommendationReason,
			recommendationPreconditions,
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.markdown).toContain("【推荐】方案 B");
			expect(result.markdown).toContain(recommendationReason);
			expect(result.markdown).toContain(recommendationPreconditions);
		}
	});

	it.each([
		"方案 A 没有推荐价值，仍有未解决阻断。",
		"方案 A 仅在全部阻断问题经复核通过后才可采用。",
		"如果移除新增必填参数并恢复全部缺省兼容路径，再经过一次复核并确认阻断完全解除，方案 A 才可以采用。",
		"## 方案 B 与方案 A 的比较\n推荐前者，因为保留旧调用；后者有未解决阻断。",
		"## 方案 B 与方案 A 的比较\n前者值得推荐；后者尚不可采用。",
	])("delivers explicit negations, resolution conditions and the unblocked former alternative: %s", body => {
		const result = reportWithBody(body, { recommendedProposal: "B" });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.markdown).toContain(body);
			expect(result.markdown).toContain("【推荐】方案 B");
			expect(result.markdown).toContain("| 方案 A | ⛔ 尚不可采用");
		}
	});

	it.each([
		"方案 A 若前提满足，则可以采用",
		"方案 A 若前提满足，那么可以采用",
		"方案 A 阻断解除后，则可以采用",
		"方案 A 阻断解除后，那么可以采用",
	])("limits a resolution condition with an explicit consequence to its next adoption predicate: %s", body => {
		const result = reportWithBody(`${body}。`, { recommendedProposal: "B" });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.markdown).toContain(`${body}。`);
			expect(result.markdown).toContain("【推荐】方案 B");
			expect(result.markdown).toContain("| 方案 A | ⛔ 尚不可采用");
		}
		const conflict = reportWithBody(`${body}，同时仍推荐方案 A。`, { recommendedProposal: "B" });
		expect(conflict.ok).toBe(false);
		if (!conflict.ok) expect(conflict.error).toContain("尚不可采用”的方案 A");
	});

	it.each([
		"方案 A 没有推荐价值，仍然推荐方案 A。",
		"方案 A 没有推荐价值，仍可以采用。",
		"方案 A 仅在全部阻断问题经复核通过后才可采用，同时仍推荐方案 A。",
		"如果移除新增必填参数并恢复全部缺省兼容路径，再经过一次复核并确认阻断完全解除，方案 A 才可以采用，同时仍可采用。",
		"## 方案 B 与方案 A 的比较\n推荐后者。",
		"## 方案 A 与方案 B 的比较\n推荐前者。",
	])("rejects a real blocked endorsement after a qualification or comparison heading: %s", body => {
		const result = reportWithBody(body, { recommendedProposal: "B" });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("尚不可采用”的方案 A");
	});

	it("does not let a resolution condition in one emitted field guard another field", () => {
		const result = reportWithBody("方案 B 满足验收标准。", {
			recommendedProposal: "B",
			recommendationReason: "方案 A 仅在全部阻断问题经复核通过后才可采用。",
			recommendationPreconditions: "方案 A 可以采用。",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("尚不可采用”的方案 A");
	});

	it.each(["reportMarkdown", "recommendationReason", "recommendationPreconditions"] as const)(
		"rejects literal and entity-encoded recommendation markers in emitted %s",
		field => {
			for (const marker of ["【推荐】", "&#12304;&#25512;&#33616;&#12305;", "&#x3010;**推荐**&#x3011;"]) {
				const result = reportWithBody("方案 B 满足验收标准。", {
					recommendedProposal: "B",
					[field]: `${marker}方案 B`,
				});
				expect(result.ok).toBe(false);
				if (!result.ok) expect(result.error).toContain("自行写入了【推荐】");
			}
		},
	);

	it.each([
		"方案 &#65; 可采用。",
		"&#x41;方案 可以采用。",
		"方案&nbsp;**&#65;**&nbsp;可以作为最终选项。",
		"## 方案 &#65;\n推荐。",
		"方案 &#65; 没有推荐价值&#xff0c;仍可以采用。",
	])("rejects a blocked label decoded before sentence segmentation: %s", body => {
		const result = reportWithBody(body);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain("尚不可采用”的方案 A");
	});

	it.each([
		"方案 AA 可以采用。",
		"AA方案 值得推荐。",
		"## 方案 AA\n推荐。",
		"## AA方案\n可以采用。",
		"方案 AA 比方案 A 更值得推荐。",
	])("matches the complete AA label rather than the blocked A prefix: %s", body => {
		const result = reportWithBody(body, { recommendedProposal: "AA" }, [
			blockedRecord("A"),
			{ ...blockedRecord("AA"), unresolvedBlocking: [] },
		]);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.markdown).toContain("【推荐】方案 AA");
	});

	it.each(["方案 AA 可以采用。", "## 方案 AA\n推荐。", "## &#65;&#65;方案\n可采用。"])(
		"does not mistake a blocked AA label for an unblocked A: %s",
		body => {
			const result = reportWithBody(body, { recommendedProposal: "A" }, [
				{ ...blockedRecord("A"), unresolvedBlocking: [] },
				blockedRecord("AA"),
			]);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error).toContain("尚不可采用”的方案 AA");
		},
	);

	it.each([
		"方案 B 没有推荐价值，仍有未解决阻断。",
		"方案 B 仅在全部阻断问题经复核通过后才可采用。",
		"如果移除新增必填参数并恢复全部缺省兼容路径，再经过一次复核并确认阻断完全解除，方案 B 才可以采用。",
		"## 方案 A 与方案 B 的比较\n推荐前者，因为保留旧调用；后者有未解决阻断。",
	])("completes orchestration with valid synthesis prose and retains the blocked alternative: %s", async body => {
		const runner: TeamSubagentRunner = async call => {
			switch (call.role) {
				case "proposer":
					return { ok: true, data: { ...proposal } };
				case "aligner":
					return { ok: true, data: { ...alignment } };
				case "reviewer":
					return {
						ok: true,
						data:
							call.label === "team-review-B"
								? { ...blockingReview }
								: {
										noSubstantiveIssues: true,
										reviewSummary: "Compatible.",
										findings: [],
										blockingResolutions: [],
									},
					};
				case "reviser":
					return {
						ok: true,
						data: {
							...revision,
							responses: [
								{
									findingId: "B-F1",
									disposition: "unresolved",
									explanation: "Compatibility is not yet restored.",
								},
							],
							reviewFlags: {
								changedCoreDesign: false,
								claimsResolvedBlocking: false,
								newEvidenceChangesAssumptions: false,
								disputesBlockingFinding: false,
							},
						},
					};
				case "synthesizer":
					return { ok: true, data: { ...synthesis, reportMarkdown: body } };
			}
		};
		const result = await runTeamDiscussion({
			question: "Preserve compatibility while extending the API.",
			cwd: "/tmp/repo",
			participants: [participant, { ...participant, index: 1 }],
			sessionModelPattern: participant.modelPattern,
			runner,
			signal: new AbortController().signal,
			maxConcurrency: 1,
		});
		expect(result.status).toBe("completed");
		expect(result.reportMarkdown).toContain(body);
		expect(result.reportMarkdown).toContain("【推荐】方案 A");
		expect(result.reportMarkdown).toContain("| 方案 B | ⛔ 尚不可采用");
	});

	it("rejects a model-authored recommendation marker whose letters are emphasized", () => {
		expect(reportWithBody("【**推荐**】方案 A").ok).toBe(false);
	});
});

describe("team restricted protocol isolation", () => {
	let tempDir: TempDir;
	let artifactsDir: string;

	function session(restricted: boolean, allowCrossAgentReads?: boolean): ToolSession {
		return {
			cwd: tempDir.path(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getArtifactsDir: () => artifactsDir,
			getAgentId: () => "Proposer",
			settings: Settings.isolated(),
			restrictToolNames: restricted,
			enableIrc: false,
			localProtocolOptions: {
				getArtifactsDir: () => artifactsDir,
				getSessionId: () => "Proposer",
				allowCrossAgentReads,
			},
		};
	}

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		InternalUrlRouter.resetForTests();
		resetRegisteredArtifactDirsForTests();
		tempDir = TempDir.createSync("omp-team-isolation-");
		artifactsDir = tempDir.path();
		registerArtifactsDir(artifactsDir);
		AgentRegistry.global().register({
			id: "Sibling",
			displayName: "Independent proposer",
			kind: "sub",
			status: "running",
			session: {
				messages: [
					{ role: "assistant", content: [{ type: "text", text: "private sibling proposal" }], timestamp: 1 },
				],
				sessionManager: { getArtifactsDir: () => artifactsDir },
			} as unknown as AgentSession,
		});
	});

	afterEach(() => {
		InternalUrlRouter.resetForTests();
		AgentRegistry.resetGlobalForTests();
		resetRegisteredArtifactDirsForTests();
		tempDir.removeSync();
	});

	it.each(["history://", "history://Sibling", "agent://Sibling"])(
		"prevents the restricted ReadTool from exposing a global sibling roster or live proposal: %s",
		async uri => {
			const tool = new ReadTool(session(true, false));
			await expect(tool.execute("isolated-read", { path: uri })).rejects.toThrow("Cross-agent");
		},
	);

	it("blocks the located-file path as well as virtual history and suppresses peer completions", async () => {
		await Bun.write(path.join(artifactsDir, "Sibling.md"), "private published proposal");
		const caller = session(true, false);
		const context = sessionResolveContext(caller);
		const router = InternalUrlRouter.instance();
		await expect(new ReadTool(caller).execute("isolated-output", { path: "agent://Sibling:1-1" })).rejects.toThrow(
			"Cross-agent",
		);
		await expect(router.locate("history://Sibling", context)).rejects.toThrow("Cross-agent");
		await expect(router.resolve("agent://Sibling", context)).rejects.toThrow("Cross-agent");
		expect(await router.complete("agent", "", context)).toEqual([]);
		expect(await router.complete("history", "", context)).toEqual([]);
	});

	it("preserves ordinary-session peer history, roster and output reads even when messaging is disabled", async () => {
		const tool = new ReadTool(session(false));
		for (const uri of ["history://", "history://Sibling", "agent://Sibling"]) {
			const result = await tool.execute("ordinary-read", { path: uri });
			const text = result.content
				.filter(part => part.type === "text")
				.map(part => part.text)
				.join("\\n");
			expect(text).toContain(uri === "history://" ? "Sibling" : "private sibling proposal");
		}
	});

	it("does not reinterpret a non-opt-in restricted session as transcript isolation", async () => {
		const tool = new ReadTool(session(true));
		const result = await tool.execute("restricted-peer-read", { path: "history://Sibling" });
		const text = result.content
			.filter(part => part.type === "text")
			.map(part => part.text)
			.join("\n");
		expect(text).toContain("private sibling proposal");
	});

	it("keeps full self-history bound to the restricted caller rather than the global registry", async () => {
		const branch: SessionEntry[] = [
			{
				type: "message",
				id: "self-message",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "own investigation", timestamp: 1 },
			},
		];
		const result = await InternalUrlRouter.instance().resolve("history://current/full", {
			...sessionResolveContext(session(true, false)),
			experimentalContextManagement: true,
			getSessionBranch: () => branch,
		});
		expect(result.content).toContain("own investigation");
		expect(result.content).not.toContain("private sibling proposal");
	});
});
