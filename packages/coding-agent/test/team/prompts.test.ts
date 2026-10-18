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
	type TeamReviewRecord,
	type TeamTrackedFinding,
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
		investigationBlockedReason: "",
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
		nextFindingNumber: 1,
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

function finding(
	id: string,
	evidence: string,
	severity: TeamTrackedFinding["severity"] = "blocking",
): TeamTrackedFinding {
	return {
		id,
		severity,
		issue: "A reader may observe the wrong generation",
		impact: `Unsafe reader path ${id}`,
		evidence,
		targetAspect: `Reader ${id}`,
	};
}

function structuredBlocks(task: string): unknown[] {
	return Array.from(task.matchAll(/```json\n([\s\S]*?)\n```/g), match => JSON.parse(match[1]!));
}

function round(
	number: number,
	ids: readonly string[],
	recheck?: TeamReviewRecord,
): TeamProposalRecord["revisionHistory"][number] {
	return {
		round: number,
		revision: {
			revisedProposal: `V${number}: reader generation strategy`,
			revisionSummary: `Revision ${number}: pin generation before reading`,
			responses: ids.map(findingId => ({
				findingId,
				disposition: "accepted-and-revised",
				explanation: `src/reader.ts:${number * 10} addresses ${findingId}`,
			})),
			reviewFlags: {
				changedCoreDesign: true,
				claimsResolvedBlocking: true,
				newEvidenceChangesAssumptions: false,
				disputesBlockingFinding: false,
			},
		},
		recheck,
		recheckFailed: false,
	};
}

function reviewedRecord(): TeamProposalRecord {
	const record = markerRecord();
	const first = finding("A-F1", "src/reader-a.ts:11 proves the stale-reader path");
	const second = finding("A-F2", "src/reader-b.ts:22 proves a distinct stale-reader path");
	const introduced = finding("A-F3", "src/generation.ts:33 exposes a new lifetime gap");
	const important = finding("A-F4", "src/generation.ts:44 leaves an expensive scan", "important");
	const initial: TeamReviewRecord = {
		noSubstantiveIssues: false,
		reviewSummary: "Two independent reader paths are unsafe",
		findings: [first, second],
		blockingResolutions: [],
	};
	const partial: TeamReviewRecord = {
		noSubstantiveIssues: false,
		reviewSummary: "The first reader is safe; the second remains unsafe and new work needs review",
		findings: [introduced, important],
		blockingResolutions: [
			{ findingId: first.id, status: "resolved", basis: "src/reader-a.ts:61 pins the first generation" },
			{ findingId: second.id, status: "unresolved", basis: "src/reader-b.ts:62 still releases before reading" },
		],
	};
	const final: TeamReviewRecord = {
		noSubstantiveIssues: true,
		reviewSummary: "The new gap is closed, but the second reader still needs a fix",
		findings: [],
		blockingResolutions: [
			{ findingId: second.id, status: "unresolved", basis: "src/reader-b.ts:82 still reads after release" },
			{ findingId: introduced.id, status: "resolved", basis: "src/generation.ts:83 retains the lifetime guard" },
		],
	};
	record.reviews = [initial, partial, final];
	record.revisionHistory = [
		round(1, [first.id, second.id], partial),
		round(2, [introduced.id, important.id, second.id], final),
	];
	record.latestProposal = { ...record.latestProposal!, proposal: record.revisionHistory[1]!.revision.revisedProposal };
	record.unresolvedBlocking = [second];
	record.nextFindingNumber = 5;
	record.roundsUsed = 2;
	record.excludedFromOptions = true;
	record.blockedAfterRoundCap = true;
	record.exclusionReason = "An independent reader path remains unsafe";
	return record;
}

describe("team prompt handoff", () => {
	it("preserves proposal evidence and constraints through isolated anonymous stage boundaries", () => {
		const record = markerRecord();
		const proposal = record.latestProposal!;
		const review: TeamReviewRecord = {
			noSubstantiveIssues: true,
			reviewSummary: "No new issue",
			findings: [],
			blockingResolutions: [],
		};
		const question = "Keep the existing reader interface while bounding snapshot storage";
		const tasks = [
			buildAlignmentTask({ question, cwd: "/tmp/repo", proposals: [record] }),
			buildReviewTask({
				question,
				cwd: "/tmp/repo",
				alignment,
				targetLabel: record.label,
				proposalText: proposal.proposal,
				keyAssumptions: proposal.keyAssumptions,
				risks: proposal.risks,
				unknowns: proposal.unknowns,
				evidence: proposal.evidence,
				ambiguityInterpretations: proposal.ambiguityInterpretations,
				round: 1,
				recheck: false,
			}),
			buildRevisionTask({
				question,
				cwd: "/tmp/repo",
				alignment,
				targetLabel: record.label,
				round: 1,
				proposal,
				review,
				unresolvedBlocking: [],
			}),
			buildSynthesisTask({ question, cwd: "/tmp/repo", alignment, proposals: [record] }),
		];
		for (const task of tasks) {
			expect(task).toContain(question);
			for (const marker of Object.values(MARKERS)) expect(task).toContain(marker);
			expect(task).not.toContain(record.participant.modelPattern);
			expect(task).not.toContain(MODEL.id);
		}
	});

	it("gives the reviser exactly the latest findings plus older pending IDs with their original evidence", () => {
		const record = reviewedRecord();
		const review = record.reviews[1]!;
		const olderPending = record.reviews[0]!.findings[1]!;
		const newPending = review.findings[0]!;
		const task = buildRevisionTask({
			question: "Make both reader paths safe",
			cwd: "/tmp/repo",
			alignment,
			targetLabel: record.label,
			round: 2,
			proposal: record.latestProposal!,
			review,
			unresolvedBlocking: [olderPending, newPending],
		});
		const arrays = structuredBlocks(task).filter((value): value is unknown[] => Array.isArray(value));
		const complete = arrays.find(items => items.length === 3)! as TeamTrackedFinding[];
		expect(complete.map(item => item.id)).toEqual(["A-F3", "A-F4", "A-F2"]);
		expect(new Set(complete.map(item => item.id)).size).toBe(complete.length);
		expect(complete.find(item => item.id === "A-F2")?.evidence).toBe(olderPending.evidence);
		expect(complete.find(item => item.id === "A-F3")?.evidence).toBe(newPending.evidence);
		expect(complete.some(item => item.id === "A-F1")).toBe(false);
		expect(arrays.find(items => items.length === 2 && typeof items[0] === "string")).toEqual(["A-F2", "A-F3"]);
		const handedReview = structuredBlocks(task).find(
			value =>
				!Array.isArray(value) && typeof value === "object" && value !== null && "blockingResolutions" in value,
		) as TeamReviewRecord;
		expect(handedReview.blockingResolutions.map(item => [item.findingId, item.status])).toEqual([
			["A-F1", "resolved"],
			["A-F2", "unresolved"],
		]);
	});

	it("keeps failed-recheck cumulative changes joined to exact blocker evidence for a fresh reviewer", () => {
		const record = reviewedRecord();
		const baseline = record.originalProposal!;
		const initial = record.reviews[0]!;
		const revisions = [round(1, ["A-F1", "A-F2"]), round(2, ["A-F1", "A-F2"])];
		revisions[0]!.recheckFailed = true;
		revisions[0]!.revision.responses[0]!.disposition = "rejected-with-evidence";
		revisions[0]!.revision.responses[0]!.explanation = "src/reader-a.ts:50 preserves A-F1's original snapshot";
		revisions[0]!.revision.reviewFlags.disputesBlockingFinding = true;
		const task = buildReviewTask({
			question: "Make both reader paths safe",
			cwd: "/tmp/repo",
			alignment,
			targetLabel: record.label,
			proposalText: revisions[1]!.revision.revisedProposal,
			keyAssumptions: baseline.keyAssumptions,
			risks: baseline.risks,
			unknowns: baseline.unknowns,
			evidence: baseline.evidence,
			ambiguityInterpretations: baseline.ambiguityInterpretations,
			round: 2,
			recheck: true,
			unresolvedBlocking: initial.findings,
			recheckContext: { previousProposal: baseline, revisions, reviews: [initial] },
		});
		const arrays = structuredBlocks(task).filter(Array.isArray);
		const history = arrays.find(items => items[0]?.revision) as TeamProposalRecord["revisionHistory"];
		const reviews = arrays.find(items => items[0]?.blockingResolutions) as TeamReviewRecord[];
		const pending = arrays.find(items => items[0]?.id) as TeamTrackedFinding[];
		expect(history.map(entry => [entry.round, entry.recheckFailed])).toEqual([
			[1, true],
			[2, false],
		]);
		expect(history[0]!.revision.revisedProposal).toBe(revisions[0]!.revision.revisedProposal);
		expect(history[1]!.revision).toMatchObject({ revisedProposalReference: "current" });
		expect(history[1]!.revision).not.toHaveProperty("revisedProposal");
		expect(task.split(revisions[1]!.revision.revisedProposal)).toHaveLength(2);
		const byId = new Map(reviews.flatMap(review => review.findings).map(item => [item.id, item]));
		for (const entry of history) {
			for (const response of entry.revision.responses) {
				const original = byId.get(response.findingId)!;
				expect(pending.find(item => item.id === response.findingId)?.evidence).toBe(original.evidence);
				expect(response.explanation).toContain(response.findingId);
			}
		}
		expect(pending[0]!.issue).toBe(pending[1]!.issue);
		expect(pending[0]!.evidence).not.toBe(pending[1]!.evidence);
		expect(task).toContain(baseline.proposal);
		expect(task).toContain(revisions[0]!.revision.revisedProposal);
		expect(task).not.toContain(record.participant.modelPattern);
	});

	it.each([false, true])("resolves baseline-body references when current equals baseline: %s", same => {
		const record = reviewedRecord();
		const baseline = record.originalProposal!;
		const current = same ? baseline.proposal : "Changed reader lifetime strategy";
		const revisions = [round(1, ["A-F1", "A-F2"]), round(2, ["A-F1", "A-F2"])];
		revisions[0]!.revision.revisedProposal = baseline.proposal;
		revisions[0]!.recheckFailed = true;
		revisions[1]!.revision.revisedProposal = current;
		const originalHistory = JSON.stringify(revisions);
		const task = buildReviewTask({
			question: "Make both reader paths safe",
			cwd: "/tmp/repo",
			alignment,
			targetLabel: record.label,
			proposalText: current,
			keyAssumptions: baseline.keyAssumptions,
			risks: baseline.risks,
			unknowns: baseline.unknowns,
			evidence: baseline.evidence,
			ambiguityInterpretations: baseline.ambiguityInterpretations,
			round: 2,
			recheck: true,
			unresolvedBlocking: record.reviews[0]!.findings,
			recheckContext: { previousProposal: baseline, revisions, reviews: [record.reviews[0]!] },
		});
		const history = structuredBlocks(task).find(
			value => Array.isArray(value) && value[0]?.revision,
		) as TeamProposalRecord["revisionHistory"];
		expect(history[0]!.revision).toMatchObject({ revisedProposalReference: same ? "current" : "previous" });
		expect(history[0]!.revision).not.toHaveProperty("revisedProposal");
		expect(history[1]!.revision).toMatchObject({ revisedProposalReference: "current" });
		expect(history[1]!.revision).not.toHaveProperty("revisedProposal");
		for (const body of new Set([baseline.proposal, current])) expect(task.split(body)).toHaveLength(2);
		expect(JSON.stringify(revisions)).toBe(originalHistory);
	});

	it("preserves each round's decisions and evidence without confusing closed and still-pending blockers in synthesis", () => {
		const record = reviewedRecord();
		const task = buildSynthesisTask({
			question: "Make both reader paths safe",
			cwd: "/tmp/repo",
			alignment,
			proposals: [record],
		});
		const arrays = structuredBlocks(task).filter(Array.isArray);
		const reviews = arrays.find(items => items[0]?.blockingResolutions) as TeamReviewRecord[];
		const history = arrays.find(items => items[0]?.revision) as TeamProposalRecord["revisionHistory"];
		const pending = arrays.find(items => items[0]?.id) as TeamTrackedFinding[];
		expect(reviews).toHaveLength(3);
		expect(history.map(entry => entry.round)).toEqual([1, 2]);
		expect(history[0]!.revision.revisedProposal).toBe(record.revisionHistory[0]!.revision.revisedProposal);
		expect(history[1]!.revision).toMatchObject({ revisedProposalReference: "current" });
		expect(history[1]!.revision).not.toHaveProperty("revisedProposal");
		expect(task.split(record.latestProposal!.proposal)).toHaveLength(2);
		expect(pending.map(item => item.id)).toEqual(["A-F2"]);
		const evidenceById = new Map(reviews.flatMap(review => review.findings).map(item => [item.id, item.evidence]));
		expect(evidenceById.size).toBe(4);
		const pendingEvidence = evidenceById.get("A-F2");
		if (pendingEvidence === undefined) throw new Error("Missing fixture evidence for A-F2");
		expect(pending[0]!.evidence).toBe(pendingEvidence);
		expect(evidenceById.get("A-F1")).not.toBe(evidenceById.get("A-F2"));
		expect(
			reviews.slice(1).map(review => review.blockingResolutions.map(item => [item.findingId, item.status])),
		).toEqual([
			[
				["A-F1", "resolved"],
				["A-F2", "unresolved"],
			],
			[
				["A-F2", "unresolved"],
				["A-F3", "resolved"],
			],
		]);
		for (const entry of history) {
			for (const response of entry.revision.responses) expect(evidenceById.has(response.findingId)).toBe(true);
			const acceptedReview = reviews.find(review => review.reviewSummary === entry.recheck?.reviewSummary)!;
			expect(entry.recheck?.blockingResolutions).toEqual(acceptedReview.blockingResolutions);
			for (const decision of acceptedReview.blockingResolutions) {
				expect(evidenceById.has(decision.findingId)).toBe(true);
				expect(decision.basis).toContain("src/");
			}
		}
		expect(task).not.toContain(record.participant.modelPattern);
	});
});
