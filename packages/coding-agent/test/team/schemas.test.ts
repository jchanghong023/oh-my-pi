import { describe, expect, it } from "bun:test";
import {
	enforceTextBudget,
	parseTeamAlignment,
	parseTeamProposal,
	parseTeamReview,
	parseTeamRevision,
	parseTeamSynthesis,
	TEAM_REVIEW_SCHEMA,
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
	priorBlockingStatus: "not-applicable" as const,
});
const revision = () => ({
	revisedProposal: "Preserve data in the existing path.",
	revisionSummary: "Addressed data loss.",
	responses: [{ finding: "Data loss", disposition: "accepted-and-revised" as const, explanation: "Preserve records" }],
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
			parseTeamRevision({ ...revision(), revisedProposal: "v".repeat(5000) })?.revisedProposal.length,
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

	it("requires non-empty finding fields in both the yield schema and the parser (§2.4)", () => {
		const fields = (
			(TEAM_REVIEW_SCHEMA.properties as Record<string, { items: { properties: Record<string, { minLength?: number }> } }>)
				.findings!.items!.properties
		);
		for (const field of ["issue", "impact", "evidence", "targetAspect"]) {
			expect(fields[field]!.minLength).toBe(1);
		}
		for (const field of ["impact", "evidence", "targetAspect"]) {
			const data = { ...review(), findings: [{ ...review().findings[0]!, [field]: " " }] };
			expect(parseTeamReview(data)).toBeUndefined();
		}
	});

	it.each([
		{ ...review(), findings: [{ ...review().findings[0], severity: "catastrophic" }] },
		{ ...review(), findings: [{ severity: "blocking", issue: "Source omitted" }] },
		{ ...review(), priorBlockingStatus: "probably-fixed" },
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
		expect(parseTeamRevision(data)).toBeUndefined();
	});

	it("preserves valid revision flags so new claims require recheck", () => {
		expect(parseTeamRevision(revision())).toEqual(revision());
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
