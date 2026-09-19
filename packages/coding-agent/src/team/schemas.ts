/**
 * `/team` structured-output schemas and validators.
 *
 * Every stage yields schema-constrained output: the JSON Schemas below are
 * handed to the subagent yield tool (`outputSchemaMode: "strict"`), so the
 * provider-side tool schema and the post-mortem validator both enforce them.
 * The hand-rolled parsers double as the orchestrator's trust boundary — data
 * that bypassed the yield validation (schema override after retries) is still
 * shape-checked and budget-truncated here before any stage consumes it.
 *
 * Output budgets are mechanical: the proposal document is capped at 4000
 * chars and the review narrative at 1500 chars by `maxLength` in the schemas
 * and by {@link enforceTextBudget} in the parsers.
 */
import type {
	TeamAlignmentOutput,
	TeamAssumption,
	TeamAmbiguityInterpretation,
	TeamDisposition,
	TeamEvidenceItem,
	TeamFactDifference,
	TeamFinding,
	TeamInterpretationDifference,
	TeamInterpretationView,
	TeamProposalOutput,
	TeamRevisionOutput,
	TeamRevisionResponse,
	TeamReviewOutput,
	TeamSeverity,
	TeamSynthesisOutput,
} from "./types";

export const TEAM_PROPOSAL_BUDGET = 4000;
export const TEAM_REVIEW_BUDGET = 1500;
export const TEAM_REVISION_BUDGET = 4000;
export const TEAM_SYNTHESIS_BUDGET = 12000;

const TRUNCATION_MARKER = "…（超出输出预算，已截断）";

/** Hard-truncate to the budget, marking the cut so readers see it. */
export function enforceTextBudget(text: string, budget: number): string {
	if (text.length <= budget) return text;
	return text.slice(0, Math.max(0, budget - TRUNCATION_MARKER.length)) + TRUNCATION_MARKER;
}

type JsonSchema = Record<string, unknown>;

function obj(properties: Record<string, JsonSchema>, required: string[]): JsonSchema {
	return { type: "object", additionalProperties: false, properties, required };
}
function str(maxLength: number, description: string): JsonSchema {
	return { type: "string", description, maxLength };
}
function bool(description: string): JsonSchema {
	return { type: "boolean", description };
}
function strArray(maxItems: number, maxLength: number, description: string): JsonSchema {
	return { type: "array", maxItems, description, items: { type: "string", maxLength } };
}
function enumOf<T extends string>(values: readonly T[], description: string): JsonSchema {
	return { type: "string", enum: [...values], description };
}

const SEVERITIES: readonly TeamSeverity[] = ["blocking", "important", "minor"];
const DISPOSITIONS: readonly TeamDisposition[] = [
	"accepted-and-revised",
	"rejected-with-evidence",
	"genuine-tradeoff",
	"unresolved",
];

const assumptionSchema = obj(
	{
		content: str(400, "假设内容：一旦不成立，方案就需要明显改变或不能采用"),
		basis: str(400, "现有依据（需求条款 / wiki / 代码位置），没有则写“无”"),
		status: enumOf(["verified", "unverified", "falsified"] as const, "验证状态"),
		impactIfWrong: str(400, "假设错误时的影响"),
	},
	["content", "basis", "status", "impactIfWrong"],
);

const ambiguitySchema = obj(
	{
		ambiguity: str(300, "存在多种解读的需求点"),
		interpretation: str(400, "本方案采用的解读"),
		impact: str(300, "该解读对方案与验收的影响"),
	},
	["ambiguity", "interpretation", "impact"],
);

const evidenceSchema = obj(
	{
		claim: str(400, "结论或判断"),
		source: str(400, "可回查的来源位置（文件路径、wiki 章节等）"),
	},
	["claim", "source"],
);

export const TEAM_PROPOSAL_SCHEMA = obj(
	{
		proposal: str(
			TEAM_PROPOSAL_BUDGET,
			"方案全文（markdown）：方向、主要实施步骤、影响范围、依据；不输出详细实现代码。全文 ≤ 4000 字",
		),
		noViableProposal: bool("依据不足、未形成可行方案时为 true，并在 proposal 中说明缺口"),
		keyAssumptions: { type: "array", maxItems: 12, description: "关键假设（含状态与影响）", items: assumptionSchema },
		risks: strArray(12, 300, "主要风险"),
		unknowns: strArray(12, 300, "未知的资料、接口行为或无法确认的事项"),
		acceptanceCriteria: strArray(12, 300, "验收建议：如何确认完成"),
		ambiguityInterpretations: {
			type: "array",
			maxItems: 12,
			description: "需求歧义与本方案的解读",
			items: ambiguitySchema,
		},
		evidence: { type: "array", maxItems: 20, description: "关键证据（结论 + 来源位置）", items: evidenceSchema },
	},
	[
		"proposal",
		"noViableProposal",
		"keyAssumptions",
		"risks",
		"unknowns",
		"acceptanceCriteria",
		"ambiguityInterpretations",
		"evidence",
	],
);

const findingSchema = obj(
	{
		severity: enumOf(SEVERITIES, "问题分级：blocking=不解决就不能采用；important=重要；minor=次要"),
		issue: str(800, "具体问题（对应方案、哪一点、为什么）"),
		impact: str(400, "影响：错误/遗漏会导致什么"),
		evidence: str(400, "依据：可回查的资料位置，或明确的逻辑推导/反例；不得冒充已运行的验证结果"),
		targetAspect: str(200, "针对方案的哪个部分"),
	},
	["severity", "issue", "impact", "evidence", "targetAspect"],
);

export const TEAM_REVIEW_SCHEMA = obj(
	{
		noSubstantiveIssues: bool("未发现实质问题时为 true；不必凑问题数量"),
		reviewSummary: str(TEAM_REVIEW_BUDGET, "审查意见全文，≤ 1500 字"),
		findings: { type: "array", maxItems: 10, description: "发现的问题；无实质问题时为空数组", items: findingSchema },
		priorBlockingStatus: enumOf(
			["resolved", "partially-resolved", "unresolved", "not-applicable"] as const,
			"仅复核轮使用：上一轮阻断问题是否已解决；初次审查固定填 not-applicable",
		),
	},
	["noSubstantiveIssues", "reviewSummary", "findings", "priorBlockingStatus"],
);

const revisionResponseSchema = obj(
	{
		finding: str(400, "对应的审查意见（摘要）"),
		disposition: enumOf(DISPOSITIONS, "处理方式：接受并修订 / 举证不接受 / 保留为真实取舍 / 说明仍无法解决"),
		explanation: str(600, "说明：改了什么、为什么，或不接受的证据"),
	},
	["finding", "disposition", "explanation"],
);

export const TEAM_REVISION_SCHEMA = obj(
	{
		revisedProposal: str(TEAM_REVISION_BUDGET, "修订后的方案全文（无改动时原样给出），≤ 4000 字"),
		revisionSummary: str(TEAM_REVIEW_BUDGET, "修改内容与理由摘要"),
		responses: { type: "array", maxItems: 10, description: "逐项回应审查意见", items: revisionResponseSchema },
		reviewFlags: obj(
			{
				changedCoreDesign: bool("是否修改了核心设计、接口、数据变化或兼容策略"),
				claimsResolvedBlocking: bool("是否声称解决了已确认的阻断（或严重）问题"),
				newEvidenceChangesAssumptions: bool("是否有新证据改变了关键假设、需求理解或适用约束"),
				disputesBlockingFinding: bool("是否举证反驳了阻断或重要问题的成立性"),
			},
			["changedCoreDesign", "claimsResolvedBlocking", "newEvidenceChangesAssumptions", "disputesBlockingFinding"],
		),
	},
	["revisedProposal", "revisionSummary", "responses", "reviewFlags"],
);

const factDifferenceSchema = obj(
	{
		topic: str(200, "分歧主题（接口存在性、规范适用性等事实）"),
		contradiction: str(600, "各提案的矛盾说法"),
		proposalsInvolved: {
			type: "array",
			maxItems: 12,
			description: "涉及的方案标签",
			items: { type: "string", maxLength: 8 },
		},
		sourceToCheck: str(400, "需回查的来源位置"),
	},
	["topic", "contradiction", "proposalsInvolved", "sourceToCheck"],
);

const interpretationDifferenceSchema = obj(
	{
		ambiguity: str(300, "无法通过现有资料查清的歧义"),
		interpretations: {
			type: "array",
			maxItems: 12,
			description: "各提案的不同理解",
			items: obj(
				{
					view: str(400, "一种理解"),
					impact: str(300, "该理解下方案与验收的后果"),
				},
				["view", "impact"],
			),
		},
		affectsChoice: bool("该差异是否实质影响方案选择"),
	},
	["ambiguity", "interpretations", "affectsChoice"],
);

export const TEAM_ALIGNMENT_SCHEMA = obj(
	{
		unifiedUnderstanding: str(3000, "统一的需求理解（可查清部分）与共同验收标准的说明"),
		acceptanceCriteria: strArray(15, 300, "共同验收标准（各提案建议用于查漏，不得各自降低标准）"),
		factDifferences: { type: "array", maxItems: 12, description: "事实差异清单", items: factDifferenceSchema },
		interpretationDifferences: {
			type: "array",
			maxItems: 12,
			description: "需求理解差异清单",
			items: interpretationDifferenceSchema,
		},
	},
	["unifiedUnderstanding", "acceptanceCriteria", "factDifferences", "interpretationDifferences"],
);

export const TEAM_SYNTHESIS_SCHEMA = obj(
	{
		reportMarkdown: str(
			TEAM_SYNTHESIS_BUDGET,
			"最终报告正文（markdown），包含：需求与验收标准、各核心方案（方向/主要步骤/影响范围，不含实现代码）、关键依据、主要取舍、风险与关键假设、执行前检查、需求理解差异、未采纳方向说明。不得包含“【推荐】”标记和“尚不可采用”判定——这两者由结构化追踪生成",
		),
		recommendedProposal: {
			type: "string",
			maxLength: 8,
			description: '推荐方案的标签（如 "A"）；没有明确优势时留空字符串',
		},
		recommendationReason: str(1500, "推荐理由（说明成立的前提）；无推荐时留空"),
		recommendationPreconditions: str(800, "推荐成立的前提条件；无推荐时留空"),
	},
	["reportMarkdown", "recommendedProposal", "recommendationReason", "recommendationPreconditions"],
);

// ── Parsers ──────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function asStringArray(value: unknown, maxItems: number): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string").slice(0, maxItems);
}

function asObjectArray(value: unknown, maxItems: number): Record<string, unknown>[] {
	if (!Array.isArray(value)) return [];
	return value.filter(isRecord).slice(0, maxItems);
}

function parseAssumption(value: Record<string, unknown>): TeamAssumption {
	const status = asString(value.status);
	return {
		content: asString(value.content),
		basis: asString(value.basis),
		status: status === "verified" || status === "falsified" ? status : "unverified",
		impactIfWrong: asString(value.impactIfWrong),
	};
}

function parseAmbiguity(value: Record<string, unknown>): TeamAmbiguityInterpretation {
	return {
		ambiguity: asString(value.ambiguity),
		interpretation: asString(value.interpretation),
		impact: asString(value.impact),
	};
}

function parseEvidence(value: Record<string, unknown>): TeamEvidenceItem {
	return { claim: asString(value.claim), source: asString(value.source) };
}

/** Parse + shape-check + budget-enforce a proposal payload. Returns undefined when the shape is unusable. */
export function parseTeamProposal(data: unknown): TeamProposalOutput | undefined {
	if (!isRecord(data)) return undefined;
	const proposal = asString(data.proposal).trim();
	if (!proposal && !asBoolean(data.noViableProposal)) return undefined;
	return {
		proposal: enforceTextBudget(proposal, TEAM_PROPOSAL_BUDGET),
		noViableProposal: asBoolean(data.noViableProposal),
		keyAssumptions: asObjectArray(data.keyAssumptions, 12).map(parseAssumption),
		risks: asStringArray(data.risks, 12),
		unknowns: asStringArray(data.unknowns, 12),
		acceptanceCriteria: asStringArray(data.acceptanceCriteria, 12),
		ambiguityInterpretations: asObjectArray(data.ambiguityInterpretations, 12).map(parseAmbiguity),
		evidence: asObjectArray(data.evidence, 20).map(parseEvidence),
	};
}

export function parseTeamReview(data: unknown): TeamReviewOutput | undefined {
	if (!isRecord(data)) return undefined;
	const findings = asObjectArray(data.findings, 10)
		.map((value): TeamFinding => {
			const severity = asString(value.severity);
			return {
				severity: severity === "blocking" || severity === "important" ? severity : "minor",
				issue: asString(value.issue),
				impact: asString(value.impact),
				evidence: asString(value.evidence),
				targetAspect: asString(value.targetAspect),
			};
		})
		.filter(finding => finding.issue.trim().length > 0);
	const summary = enforceTextBudget(asString(data.reviewSummary).trim(), TEAM_REVIEW_BUDGET);
	const noSubstantiveIssues = asBoolean(data.noSubstantiveIssues) && findings.length === 0;
	// §2.5: a review must carry findings, explicitly record "no substantive
	// issues", or say something in its summary. An all-empty payload is not a
	// review — passing it through would mark an unexamined proposal as
	// reviewed (§2.8: failure must not read as "no issues found").
	if (findings.length === 0 && !noSubstantiveIssues && !summary) return undefined;
	const status = asString(data.priorBlockingStatus);
	return {
		noSubstantiveIssues,
		reviewSummary: summary,
		findings,
		priorBlockingStatus:
			status === "resolved" || status === "partially-resolved" || status === "unresolved"
				? status
				: "not-applicable",
	};
}

export function parseTeamRevision(data: unknown): TeamRevisionOutput | undefined {
	if (!isRecord(data)) return undefined;
	const flags = isRecord(data.reviewFlags) ? data.reviewFlags : {};
	const parseFlag = (value: unknown) => asBoolean(value, false);
	const responses = asObjectArray(data.responses, 10)
		.map((value): TeamRevisionResponse => {
			const disposition = asString(value.disposition);
			return {
				finding: asString(value.finding),
				disposition: (DISPOSITIONS as readonly string[]).includes(disposition)
					? (disposition as TeamDisposition)
					: "unresolved",
				explanation: asString(value.explanation),
			};
		})
		.filter(response => response.finding.trim().length > 0);
	return {
		revisedProposal: enforceTextBudget(asString(data.revisedProposal).trim(), TEAM_REVISION_BUDGET),
		revisionSummary: enforceTextBudget(asString(data.revisionSummary).trim(), TEAM_REVIEW_BUDGET),
		responses,
		reviewFlags: {
			changedCoreDesign: parseFlag(flags.changedCoreDesign),
			claimsResolvedBlocking: parseFlag(flags.claimsResolvedBlocking),
			newEvidenceChangesAssumptions: parseFlag(flags.newEvidenceChangesAssumptions),
			disputesBlockingFinding: parseFlag(flags.disputesBlockingFinding),
		},
	};
}

function parseFactDifference(value: Record<string, unknown>): TeamFactDifference {
	return {
		topic: asString(value.topic),
		contradiction: asString(value.contradiction),
		proposalsInvolved: asStringArray(value.proposalsInvolved, 12),
		sourceToCheck: asString(value.sourceToCheck),
	};
}

function parseInterpretationDifference(value: Record<string, unknown>): TeamInterpretationDifference {
	return {
		ambiguity: asString(value.ambiguity),
		interpretations: asObjectArray(value.interpretations, 12).map((item): TeamInterpretationView => ({
			view: asString(item.view),
			impact: asString(item.impact),
		})),
		affectsChoice: asBoolean(value.affectsChoice),
	};
}

export function parseTeamAlignment(data: unknown): TeamAlignmentOutput | undefined {
	if (!isRecord(data)) return undefined;
	const unified = asString(data.unifiedUnderstanding).trim();
	if (!unified) return undefined;
	return {
		unifiedUnderstanding: enforceTextBudget(unified, 3000),
		acceptanceCriteria: asStringArray(data.acceptanceCriteria, 15),
		factDifferences: asObjectArray(data.factDifferences, 12).map(parseFactDifference),
		interpretationDifferences: asObjectArray(data.interpretationDifferences, 12).map(parseInterpretationDifference),
	};
}

export function parseTeamSynthesis(data: unknown): TeamSynthesisOutput | undefined {
	if (!isRecord(data)) return undefined;
	const reportMarkdown = asString(data.reportMarkdown).trim();
	if (!reportMarkdown) return undefined;
	return {
		reportMarkdown: enforceTextBudget(reportMarkdown, TEAM_SYNTHESIS_BUDGET),
		recommendedProposal: asString(data.recommendedProposal).trim(),
		recommendationReason: asString(data.recommendationReason).trim(),
		recommendationPreconditions: asString(data.recommendationPreconditions).trim(),
	};
}
