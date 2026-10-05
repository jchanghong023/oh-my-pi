/**
 * `/team` prompt handoff tests: the structured proposal fields (risks,
 * unknowns, assumption impact, evidence) must survive the stage boundaries.
 * Alignment, review and synthesis prompts are rendered for fresh, isolated
 * subagents that never saw the proposal stage's structured output, so anything
 * not rendered here is lost to that stage.
 */
import { describe, expect, it } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	buildAlignmentTask,
	buildReviewTask,
	buildRevisionTask,
	buildSynthesisTask,
	type TeamAlignmentOutput,
	type TeamProposalOutput,
	type TeamProposalRecord,
} from "@oh-my-pi/pi-coding-agent/team";

const MODEL: Model = getBundledModel("anthropic", "claude-sonnet-4-5")!;

const MARKERS = {
	risk: "RISK-MARKER-7f3a",
	unknown: "UNKNOWN-MARKER-91c",
	impact: "IMPACT-MARKER-4b2",
	basis: "ASSUMPTION-SOURCE-MARKER-12a",
	ambiguity: "AMBIGUITY-MARKER-91f",
	interpretation: "INTERPRETATION-MARKER-41c",
	ambiguityImpact: "AMBIGUITY-IMPACT-MARKER-91a",
	evidenceClaim: "EVIDENCE-CLAIM-MARKER-6d1",
	evidenceSource: "EVIDENCE-SOURCE-MARKER-55e",
} as const;

function markerRecord(): TeamProposalRecord {
	const latest: TeamProposalOutput = {
		proposal: "方案正文：扩展现有模块。",
		noViableProposal: false,
		keyAssumptions: [
			{ content: "假设甲", basis: MARKERS.basis, status: "unverified", impactIfWrong: MARKERS.impact },
		],
		risks: [MARKERS.risk],
		unknowns: [MARKERS.unknown],
		acceptanceCriteria: ["现有测试全绿"],
		ambiguityInterpretations: [
			{ ambiguity: MARKERS.ambiguity, interpretation: MARKERS.interpretation, impact: MARKERS.ambiguityImpact },
		],
		evidence: [{ claim: MARKERS.evidenceClaim, source: MARKERS.evidenceSource }],
	};
	return {
		label: "A",
		participant: { index: 0, modelPattern: "provider/model-x", model: MODEL, isSessionModel: false },
		originalProposal: latest,
		latestProposal: latest,
		reviews: [],
		roundsUsed: 0,
		unresolvedBlocking: [],
		proposerFailed: false,
		reviewFailed: false,
		recheckFailed: false,
		pendingRecheck: false,
		revisionFailed: false,
		excludedFromOptions: false,
		blockedAfterRoundCap: false,
	};
}

const alignment: TeamAlignmentOutput = {
	unifiedUnderstanding: "统一理解：实现 A 功能。",
	acceptanceCriteria: ["功能可用"],
	factDifferences: [],
	interpretationDifferences: [],
};

describe("team prompt handoff", () => {
	it("passes risks, unknowns, assumption impact and evidence into the alignment prompt", () => {
		const task = buildAlignmentTask({ question: "如何实现 X？", cwd: "/tmp/repo", proposals: [markerRecord()] });
		for (const marker of Object.values(MARKERS)) expect(task).toContain(marker);
	});

	it("passes them into the anonymous review prompt without author identity", () => {
		const latest = markerRecord().latestProposal!;
		const task = buildReviewTask({
			question: "如何实现 X？",
			cwd: "/tmp/repo",
			alignment,
			targetLabel: "A",
			proposalText: latest.proposal,
			keyAssumptions: latest.keyAssumptions,
			risks: latest.risks,
			unknowns: latest.unknowns,
			evidence: latest.evidence,
			ambiguityInterpretations: latest.ambiguityInterpretations,
			round: 1,
			recheck: false,
		});
		for (const marker of Object.values(MARKERS)) expect(task).toContain(marker);
		// Structured fields must not smuggle author identity into the review.
		expect(task).not.toContain("provider/model-x");
	});

	it("gives the isolated reviser the common acceptance criteria and complete proposal evidence", () => {
		const task = buildRevisionTask({
			question: "如何实现 X？",
			cwd: "/tmp/repo",
			alignment,
			targetLabel: "A",
			round: 1,
			proposal: markerRecord().latestProposal!,
			review: {
				noSubstantiveIssues: false,
				reviewSummary: "审查",
				findings: [],
				priorBlockingStatus: "not-applicable",
			},
			unresolvedBlocking: [],
		});
		for (const marker of Object.values(MARKERS)) expect(task).toContain(marker);
		for (const criterion of alignment.acceptanceCriteria) expect(task).toContain(criterion);
	});

	it("passes them into the synthesis prompt", () => {
		const task = buildSynthesisTask({
			question: "如何实现 X？",
			cwd: "/tmp/repo",
			alignment,
			proposals: [markerRecord()],
		});
		for (const marker of Object.values(MARKERS)) expect(task).toContain(marker);
	});
});
