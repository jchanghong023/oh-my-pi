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
		revisionHistory: [],
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

	it("gives a recheck all unverified revision responses since the successfully reviewed baseline", () => {
		const record = markerRecord();
		const baseline = { ...record.latestProposal!, proposal: "Audited baseline: use transaction snapshots" };
		const revisions: TeamProposalRecord["revisionHistory"] = [1, 2].map(round => ({
			round,
			revision: {
				revisedProposal: round === 1 ? "Use incremental snapshots" : "Add snapshot expiry",
				revisionSummary: round === 1 ? "Change the snapshot boundary" : "Bound retained history",
				responses: [
					{
						finding: round === 1 ? "Readers may observe a partial transaction" : "Old snapshots may accumulate",
						disposition: "accepted-and-revised",
						explanation:
							round === 1
								? "src/snapshots.ts:63 pins the transaction generation"
								: "Expire after readers release the generation",
					},
				],
				reviewFlags: {
					changedCoreDesign: true,
					claimsResolvedBlocking: true,
					newEvidenceChangesAssumptions: false,
					disputesBlockingFinding: false,
				},
			},
			recheckFailed: round === 1,
		}));
		const task = buildReviewTask({
			question: "How can snapshot storage be bounded?",
			cwd: "/tmp/repo",
			alignment,
			targetLabel: "A",
			proposalText: revisions[1]!.revision.revisedProposal,
			keyAssumptions: baseline.keyAssumptions,
			risks: baseline.risks,
			unknowns: baseline.unknowns,
			evidence: baseline.evidence,
			ambiguityInterpretations: baseline.ambiguityInterpretations,
			round: 2,
			recheck: true,
			recheckContext: { previousProposal: baseline, revisions, reviews: [] },
		});
		expect(task).toContain(baseline.proposal);
		for (const entry of revisions) {
			expect(task).toContain(entry.revision.revisedProposal);
			expect(task).toContain(entry.revision.revisionSummary);
			expect(task).toContain(entry.revision.responses[0]!.finding);
			expect(task).toContain(entry.revision.responses[0]!.explanation);
		}
		expect(task).not.toContain(record.participant.modelPattern);
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

	it("passes every revision/recheck pair, including first-round-only rebuttal evidence, into synthesis", () => {
		const record = markerRecord();
		record.roundsUsed = 2;
		record.revisionHistory = [
			{
				round: 1,
				revision: {
					revisedProposal: "V1: introduce a versioned storage reader",
					revisionSummary: "Keep the rollback path pending review",
					responses: [
						{
							finding: "Rollback may lose previous records",
							disposition: "rejected-with-evidence",
							explanation: "src/storage/reader.ts:87 retains the original records during rollback",
						},
					],
					reviewFlags: {
						changedCoreDesign: true,
						claimsResolvedBlocking: false,
						newEvidenceChangesAssumptions: false,
						disputesBlockingFinding: true,
					},
				},
				recheckFailed: true,
			},
			{
				round: 2,
				revision: {
					revisedProposal: "V2: add reader version negotiation",
					revisionSummary: "Negotiate the storage version before switching readers",
					responses: [
						{
							finding: "Version mismatch",
							disposition: "accepted-and-revised",
							explanation: "Read the stored version before selecting the reader",
						},
					],
					reviewFlags: {
						changedCoreDesign: true,
						claimsResolvedBlocking: true,
						newEvidenceChangesAssumptions: false,
						disputesBlockingFinding: false,
					},
				},
				recheck: {
					noSubstantiveIssues: true,
					reviewSummary: "src/storage/version.ts:24 confirms both reader versions are supported",
					findings: [],
					priorBlockingStatus: "resolved",
				},
				recheckFailed: false,
			},
		];
		const task = buildSynthesisTask({
			question: "How can storage readers be upgraded safely?",
			cwd: "/tmp/repo",
			alignment,
			proposals: [record],
		});
		for (const entry of record.revisionHistory) {
			expect(task).toContain(entry.revision.revisedProposal);
			expect(task).toContain(entry.revision.revisionSummary);
			for (const response of entry.revision.responses) {
				expect(task).toContain(response.finding);
				expect(task).toContain(response.explanation);
			}
			if (entry.recheck) expect(task).toContain(entry.recheck.reviewSummary);
		}
		expect(task).toMatch(/"round":\s*1/);
		expect(task).toMatch(/"round":\s*2/);
		expect(task).toMatch(/"recheckFailed":\s*true/);
		expect(task).toMatch(/"recheckFailed":\s*false/);
	});
});
