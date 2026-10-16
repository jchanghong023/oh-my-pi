import { describe, expect, it } from "bun:test";
import {
	enforceTextBudget,
	parseTeamAlignment,
	parseTeamProposal,
	parseTeamReview,
	parseTeamRevision,
	parseTeamSynthesis,
} from "@oh-my-pi/pi-coding-agent/team";

const proposal = () => ({
	proposal: "Extend the existing path.",
	noViableProposal: false,
	keyAssumptions: [
		{ content: "API is public", basis: "src/api.ts:10", status: "verified" as const, impactIfWrong: "Change scope" },
	],
	risks: ["Downstream callers"],
	unknowns: ["External consumers"],
	acceptanceCriteria: ["Existing callers continue working"],
	ambiguityInterpretations: [
		{ ambiguity: "Compatibility", interpretation: "Keep the current API", impact: "No migration" },
	],
	evidence: [{ claim: "There is an existing API", source: "src/api.ts:10" }],
});
const review = () => ({
	noSubstantiveIssues: false,
	reviewSummary: "One reachable blocker.",
	findings: [
		{
			severity: "blocking" as const,
			issue: "Data loss",
			evidence: "src/store.ts:42",
			impact: "Corrupt records",
			targetAspect: "Storage",
		},
	],
	blockingResolutions: [],
});
const revision = () => ({
	revisedProposal: "Preserve data in the existing path.",
	revisionSummary: "Addressed data loss.",
	responses: [{ findingId: "A-F1", disposition: "accepted-and-revised" as const, explanation: "Preserve records" }],
	reviewFlags: {
		changedCoreDesign: true,
		claimsResolvedBlocking: false,
		newEvidenceChangesAssumptions: false,
		disputesBlockingFinding: false,
	},
});
const alignment = () => ({
	unifiedUnderstanding: "Keep the existing API while preserving data.",
	acceptanceCriteria: ["No lost records"],
	interpretationDifferences: [
		{
			ambiguity: "Compatibility",
			interpretations: [{ view: "Keep API", impact: "No migration" }],
			affectsChoice: true,
		},
	],
	factDifferences: [
		{
			topic: "Storage",
			contradiction: "Durability differs",
			proposalsInvolved: ["A", "B"],
			sourceToCheck: "src/store.ts:42",
		},
	],
});

describe("team yield payload validation", () => {
	it("preserves structured proposal evidence and ambiguity impact", () => {
		const data = proposal();
		expect(parseTeamProposal(data)).toEqual(data);
		expect(parseTeamAlignment(alignment())).toEqual(alignment());
	});

	it("caps model narratives without silently dropping structured findings", () => {
		expect(parseTeamProposal({ ...proposal(), proposal: "p".repeat(5000) })?.proposal.length).toBeLessThan(5000);
		expect(parseTeamReview({ ...review(), reviewSummary: "r".repeat(2000) })).toBeUndefined();
		expect(
			parseTeamReview({ ...review(), findings: [], noSubstantiveIssues: true, reviewSummary: "r".repeat(2000) })
				?.reviewSummary.length,
		).toBeLessThan(2000);
		expect(
			parseTeamRevision({ ...revision(), revisedProposal: "v".repeat(5000) }, ["A-F1"])?.revisedProposal.length,
		).toBeLessThan(5000);
		expect(
			parseTeamSynthesis({
				reportMarkdown: "s".repeat(14000),
				recommendedProposal: "A",
				recommendationReason: "Evidence",
				recommendationPreconditions: "Compatible API",
				hardConstraintViolations: [],
			})?.reportMarkdown.length,
		).toBeLessThan(14000);
		expect(enforceTextBudget("exact", 5)).toBe("exact");
		expect(enforceTextBudget("a".repeat(100), 50)).toHaveLength(50);
	});

	it.each([
		{ ...proposal(), noViableProposal: "false" },
		{ ...proposal(), keyAssumptions: [{ ...proposal().keyAssumptions[0], status: "likely" }] },
		{ ...proposal(), evidence: [{ claim: "Source omitted" }] },
		{ ...proposal(), ambiguityInterpretations: [{ ambiguity: "X", interpretation: "Y" }] },
		{ proposal: "Narrative without structured output" },
	])("rejects malformed proposal metadata instead of discarding it: %j", data => {
		expect(parseTeamProposal(data)).toBeUndefined();
	});

	it("accepts an explicit no-viable-proposal outcome without requiring proposal prose", () => {
		expect(parseTeamProposal({ ...proposal(), proposal: "", noViableProposal: true })?.noViableProposal).toBe(true);
		expect(parseTeamProposal({ ...proposal(), proposal: "" })).toBeUndefined();
	});

	it("rejects a finding with any empty required field (§2.4)", () => {
		for (const field of ["issue", "impact", "evidence", "targetAspect"]) {
			const data = { ...review(), findings: [{ ...review().findings[0]!, [field]: " " }] };
			expect(parseTeamReview(data)).toBeUndefined();
		}
	});

	it.each([
		{ ...review(), findings: [{ ...review().findings[0], severity: "catastrophic" }] },
		{ ...review(), findings: [{ severity: "blocking", issue: "Source omitted" }] },
		{ ...review(), blockingResolutions: "resolved" },
		{ ...review(), priorBlockingStatus: "resolved" },
		{ ...review(), findings: [{ ...review().findings[0], id: "A-F999" }] },
		{ ...review(), noSubstantiveIssues: "yes" },
		{ ...review(), findings: [], noSubstantiveIssues: false },
		{ reviewSummary: "Everything looks fine" },
	])("rejects malformed or indeterminate reviews: %j", data => {
		expect(parseTeamReview(data)).toBeUndefined();
	});

	it("retains a valid blocker and accepts an explicit clean verdict", () => {
		expect(parseTeamReview(review())).toEqual(review());
		const clean = { ...review(), findings: [], noSubstantiveIssues: true };
		expect(parseTeamReview(clean)).toEqual(clean);
	});

	it.each([
		{},
		{ ...revision(), reviewFlags: {} },
		{ ...revision(), reviewFlags: { ...revision().reviewFlags, changedCoreDesign: "yes" } },
		{ ...revision(), responses: ["No structured basis"] },
		{ ...revision(), revisedProposal: "" },
	])("rejects incomplete revision gates: %j", data => {
		expect(parseTeamRevision(data, ["A-F1"])).toBeUndefined();
	});

	it("preserves valid revision flags so new claims require recheck", () => {
		expect(parseTeamRevision(revision(), ["A-F1"])).toEqual(revision());
	});

	it("requires one evidenced decision for each exact pending blocker ID", () => {
		const decisions = [
			{ findingId: "A-F1", status: "resolved" as const, basis: "src/store.ts:42 now preserves records" },
			{ findingId: "A-F2", status: "unresolved" as const, basis: "src/store.ts:90 still drops rollback data" },
		];
		const data = { ...review(), findings: [], noSubstantiveIssues: true, blockingResolutions: decisions };
		expect(parseTeamReview(data, ["A-F1", "A-F2"])).toEqual(data);
		for (const blockingResolutions of [
			[],
			decisions.slice(0, 1),
			[decisions[0], decisions[0]],
			[decisions[0], { ...decisions[1], findingId: "A-F3" }],
			[decisions[0], { ...decisions[1], findingId: "a-f2" }],
			[decisions[0], { ...decisions[1], basis: " " }],
			[decisions[0], { ...decisions[1], status: "partially-resolved" }],
			[decisions[0], "resolved"],
		]) {
			expect(parseTeamReview({ ...data, blockingResolutions }, ["A-F1", "A-F2"])).toBeUndefined();
		}
		expect(parseTeamReview(data)).toBeUndefined();
	});

	it("counts all decision bases toward the review budget without discarding decisions", () => {
		const blockingResolutions = Array.from({ length: 30 }, (_, index) => ({
			findingId: `A-F${index + 1}`,
			status: "unresolved" as const,
			basis: "e".repeat(40),
		}));
		const ids = blockingResolutions.map(decision => decision.findingId);
		const data = {
			...review(),
			reviewSummary: "r".repeat(300),
			findings: [],
			noSubstantiveIssues: true,
			blockingResolutions,
		};
		expect(parseTeamReview(data, ids)).toEqual(data);
		expect(parseTeamReview({ ...data, reviewSummary: "r".repeat(301) }, ids)).toBeUndefined();
		expect(
			parseTeamReview({ ...data, findings: Array.from({ length: 11 }, () => review().findings[0]) }, ids),
		).toBeUndefined();
	});

	it("requires revision responses to exactly reference latest findings and pending blockers", () => {
		const responses = [
			...revision().responses,
			{ findingId: "A-F2", disposition: "unresolved" as const, explanation: "Rollback still lacks durable storage" },
		];
		const data = { ...revision(), responses };
		expect(parseTeamRevision(data, ["A-F1", "A-F2"])).toEqual(data);
		for (const invalidResponses of [
			[],
			responses.slice(0, 1),
			[responses[0], responses[0]],
			[responses[0], { ...responses[1], findingId: "B-F2" }],
			[responses[0], { ...responses[1], findingId: "a-f2" }],
			[responses[0], { ...responses[1], explanation: " " }],
			[{ finding: "Data loss", disposition: "accepted-and-revised", explanation: "Fixed" }, responses[1]],
		]) {
			expect(parseTeamRevision({ ...data, responses: invalidResponses }, ["A-F1", "A-F2"])).toBeUndefined();
		}
		expect(parseTeamRevision(data)).toBeUndefined();
	});

	it("accepts cumulative revision references without silently slicing responses", () => {
		const responses = Array.from({ length: 30 }, (_, index) => ({
			findingId: `A-F${index + 1}`,
			disposition: "unresolved" as const,
			explanation: "Still pending source confirmation",
		}));
		const ids = responses.map(response => response.findingId);
		const data = { ...revision(), responses };
		expect(parseTeamRevision(data, ids)).toEqual(data);
		expect(
			parseTeamRevision(
				{ ...data, responses: responses.map(response => ({ ...response, explanation: "e".repeat(601) })) },
				ids,
			),
		).toBeUndefined();
	});

	it("fails closed on incomplete alignment and synthesis output", () => {
		expect(parseTeamAlignment({ unifiedUnderstanding: "Only narrative" })).toBeUndefined();
		expect(
			parseTeamAlignment({
				...alignment(),
				interpretationDifferences: [{ ambiguity: "X", interpretations: [], affectsChoice: "yes" }],
			}),
		).toBeUndefined();
		expect(parseTeamSynthesis({ reportMarkdown: "Only narrative" })).toBeUndefined();
		const complete = {
			reportMarkdown: "Complete report",
			recommendedProposal: "A",
			recommendationReason: "Evidence",
			recommendationPreconditions: "Compatible API",
			hardConstraintViolations: [],
		};
		const { hardConstraintViolations: _violations, ...incomplete } = complete;
		expect(parseTeamSynthesis(incomplete)).toBeUndefined();
		expect(
			parseTeamSynthesis({
				...complete,
				hardConstraintViolations: [{ proposalLabel: "A", issue: "Compatibility broken", evidence: " " }],
			}),
		).toBeUndefined();
	});
});
