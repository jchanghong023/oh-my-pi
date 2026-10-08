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
	priorBlockingStatus: "not-applicable",
};
const revision: TeamRevisionOutput = {
	revisedProposal: "Use the existing interface with a documented adapter.",
	revisionSummary: "revision-change-marker: document the existing adapter",
	responses: [
		{
			finding: "The compatibility premise is wrong",
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

function blockedRecord(): TeamProposalRecord {
	return {
		label: "A",
		participant,
		originalProposal: proposal,
		latestProposal: proposal,
		reviews: [blockingReview],
		roundsUsed: 0,
		unresolvedBlocking: [blockingReview.findings[0]!.issue],
		proposerFailed: false,
		reviewFailed: false,
		recheckFailed: false,
		pendingRecheck: false,
		revisionFailed: false,
		excludedFromOptions: false,
		blockedAfterRoundCap: false,
	};
}

function reportWithBody(reportMarkdown: string) {
	return assembleTeamReport({
		alignment,
		synthesis: { ...synthesis, recommendedProposal: "", reportMarkdown },
		proposals: [blockedRecord()],
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
							priorBlockingStatus: canAdjudicate ? "resolved" : "unresolved",
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

	it.each(["方案 **A** 可以采用。", "方案 `A` 可以作为最终选项。", "方案 [A](#a) 可采用。"])(
		"rejects a visible adoption claim for a blocked Markdown-formatted label: %s",
		body => {
			const result = reportWithBody(body);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error).toContain("尚不可采用");
		},
	);

	it.each(["方案 **A** 不可以采用。", "方案 **A** 若阻断问题解决后才可采用。"])(
		"keeps a formatted negation or explicitly conditional adoption distinct from current approval: %s",
		body => {
			const result = reportWithBody(body);
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.markdown).toContain("| 方案 A | ⛔ 尚不可采用");
		},
	);

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
