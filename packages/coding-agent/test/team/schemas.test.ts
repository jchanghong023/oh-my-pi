/**
 * `/team` schema and parser tests: output budgets declared in the schemas
 * (mechanically enforced at the yield tool), budget truncation, and parser
 * shape handling for every stage payload.
 */
import { describe, expect, it } from "bun:test";
import {
	TEAM_ALIGNMENT_SCHEMA,
	TEAM_PROPOSAL_BUDGET,
	TEAM_PROPOSAL_SCHEMA,
	TEAM_REVIEW_BUDGET,
	TEAM_REVIEW_SCHEMA,
	TEAM_REVISION_SCHEMA,
	TEAM_SYNTHESIS_SCHEMA,
	enforceTextBudget,
	parseTeamAlignment,
	parseTeamProposal,
	parseTeamReview,
	parseTeamRevision,
	parseTeamSynthesis,
} from "@oh-my-pi/pi-coding-agent/team";

describe("team output budget schemas", () => {
	it("caps the proposal document at 4000 chars in the schema", () => {
		const properties = TEAM_PROPOSAL_SCHEMA.properties as Record<string, { maxLength?: number; type?: string }>;
		expect(properties.proposal!.maxLength).toBe(TEAM_PROPOSAL_BUDGET);
		expect(TEAM_PROPOSAL_BUDGET).toBe(4000);
		expect(properties.proposal!.type).toBe("string");
	});

	it("caps the review narrative at 1500 chars in the schema", () => {
		const properties = TEAM_REVIEW_SCHEMA.properties as Record<string, { maxLength?: number }>;
		expect(properties.reviewSummary!.maxLength).toBe(TEAM_REVIEW_BUDGET);
		expect(TEAM_REVIEW_BUDGET).toBe(1500);
	});

	it("declares every stage schema as a closed object with required fields", () => {
		for (const schema of [
			TEAM_PROPOSAL_SCHEMA,
			TEAM_REVIEW_SCHEMA,
			TEAM_REVISION_SCHEMA,
			TEAM_ALIGNMENT_SCHEMA,
			TEAM_SYNTHESIS_SCHEMA,
		]) {
			expect(schema.type).toBe("object");
			expect(schema.additionalProperties).toBe(false);
			expect(Array.isArray(schema.required)).toBe(true);
			expect((schema.required as string[]).length).toBeGreaterThan(0);
		}
	});

	it("truncates over-budget text with a visible marker", () => {
		const over = "x".repeat(TEAM_PROPOSAL_BUDGET + 500);
		const truncated = enforceTextBudget(over, TEAM_PROPOSAL_BUDGET);
		expect(truncated.length).toBe(TEAM_PROPOSAL_BUDGET);
		expect(truncated).toContain("已截断");
		expect(enforceTextBudget("short", 100)).toBe("short");
	});
});

describe("team parsers", () => {
	it("accepts a well-formed proposal and normalizes optional fields", () => {
		const parsed = parseTeamProposal({
			proposal: "方案：扩展模块。",
			noViableProposal: false,
			keyAssumptions: [{ content: "a", basis: "b", status: "verified", impactIfWrong: "c" }],
			risks: ["r"],
			unknowns: [],
			acceptanceCriteria: ["ac"],
			ambiguityInterpretations: [],
			evidence: [],
		})!;
		expect(parsed.proposal).toBe("方案：扩展模块。");
		expect(parsed.keyAssumptions[0]!.status).toBe("verified");
	});

	it("rejects proposals without document text unless noViableProposal is set", () => {
		expect(
			parseTeamProposal({
				proposal: "",
				noViableProposal: false,
				keyAssumptions: [],
				risks: [],
				unknowns: [],
				acceptanceCriteria: [],
				ambiguityInterpretations: [],
				evidence: [],
			}),
		).toBeUndefined();
		const noViable = parseTeamProposal({
			proposal: "",
			noViableProposal: true,
			keyAssumptions: [],
			risks: [],
			unknowns: [],
			acceptanceCriteria: [],
			ambiguityInterpretations: [],
			evidence: [],
		})!;
		expect(noViable.noViableProposal).toBe(true);
	});

	it("truncates over-budget proposal text even when the schema was overridden", () => {
		const parsed = parseTeamProposal({
			proposal: "y".repeat(TEAM_PROPOSAL_BUDGET + 100),
			noViableProposal: false,
			keyAssumptions: [],
			risks: [],
			unknowns: [],
			acceptanceCriteria: [],
			ambiguityInterpretations: [],
			evidence: [],
		})!;
		expect(parsed.proposal.length).toBe(TEAM_PROPOSAL_BUDGET);
	});

	it("normalizes unknown severity, disposition, and status values conservatively", () => {
		const review = parseTeamReview({
			noSubstantiveIssues: true,
			reviewSummary: "ok",
			findings: [{ severity: "catastrophic", issue: "i", impact: "m", evidence: "e", targetAspect: "t" }],
			priorBlockingStatus: "weird",
		})!;
		expect(review.findings[0]!.severity).toBe("minor");
		expect(review.priorBlockingStatus).toBe("not-applicable");
		// noSubstantiveIssues cannot stand alongside actual findings.
		expect(review.noSubstantiveIssues).toBe(false);

		const revision = parseTeamRevision({
			revisedProposal: "p",
			revisionSummary: "s",
			responses: [{ finding: "f", disposition: "unknown-value", explanation: "e" }],
			reviewFlags: {
				changedCoreDesign: "yes",
				claimsResolvedBlocking: false,
				newEvidenceChangesAssumptions: false,
				disputesBlockingFinding: false,
			},
		})!;
		expect(revision.responses[0]!.disposition).toBe("unresolved");
		expect(revision.reviewFlags.changedCoreDesign).toBe(false);
	});

	it("rejects a vacuous review with no findings, no summary, and no explicit no-issues record", () => {
		// §2.5/§2.8: an all-empty payload is not a review — passing it through
		// would let an unexamined proposal reach "✅ 可作为选项".
		expect(
			parseTeamReview({
				noSubstantiveIssues: false,
				reviewSummary: "",
				findings: [],
				priorBlockingStatus: "not-applicable",
			}),
		).toBeUndefined();
		expect(
			parseTeamReview({
				noSubstantiveIssues: false,
				reviewSummary: "   ",
				findings: [{ severity: "blocking", issue: "  ", impact: "m", evidence: "e", targetAspect: "t" }],
				priorBlockingStatus: "not-applicable",
			}),
		).toBeUndefined();
	});

	it("accepts an explicit no-findings review and a summary-only review", () => {
		const explicit = parseTeamReview({
			noSubstantiveIssues: true,
			reviewSummary: "",
			findings: [],
			priorBlockingStatus: "not-applicable",
		})!;
		expect(explicit.noSubstantiveIssues).toBe(true);

		const summaryOnly = parseTeamReview({
			noSubstantiveIssues: false,
			reviewSummary: "复核了事实差异，未发现新问题",
			findings: [],
			priorBlockingStatus: "resolved",
		})!;
		expect(summaryOnly.noSubstantiveIssues).toBe(false);
		expect(summaryOnly.priorBlockingStatus).toBe("resolved");
	});

	it("parses alignment and synthesis payloads", () => {
		const alignment = parseTeamAlignment({
			unifiedUnderstanding: "u",
			acceptanceCriteria: ["a"],
			factDifferences: [{ topic: "t", contradiction: "c", proposalsInvolved: ["A"], sourceToCheck: "s" }],
			interpretationDifferences: [
				{ ambiguity: "q", interpretations: [{ view: "v", impact: "i" }], affectsChoice: true },
			],
		})!;
		expect(alignment.interpretationDifferences[0]!.affectsChoice).toBe(true);

		const synthesis = parseTeamSynthesis({
			reportMarkdown: "## 报告",
			recommendedProposal: "A",
			recommendationReason: "r",
			recommendationPreconditions: "p",
		})!;
		expect(synthesis.recommendedProposal).toBe("A");
		expect(parseTeamAlignment({ unifiedUnderstanding: "" })).toBeUndefined();
		expect(parseTeamSynthesis({ reportMarkdown: "" })).toBeUndefined();
	});
});
