import { prompt } from "@oh-my-pi/pi-utils";
import alignerPrompt from "../prompts/team/aligner.md" with { type: "text" };
import proposerPrompt from "../prompts/team/proposer.md" with { type: "text" };
import reviewerPrompt from "../prompts/team/reviewer.md" with { type: "text" };
import reviserPrompt from "../prompts/team/reviser.md" with { type: "text" };
import synthesizerPrompt from "../prompts/team/synthesizer.md" with { type: "text" };
import type {
	TeamAlignmentOutput,
	TeamAmbiguityInterpretation,
	TeamEvidenceItem,
	TeamProposalRecord,
	TeamProposalOutput,
	TeamReviewRecord,
	TeamRole,
	TeamTrackedFinding,
} from "./types";

const TASK_TEMPLATE_MARKER = "<!-- TEAM TASK TEMPLATE -->";

function splitPromptTemplate(source: string): { system: string; task: string } {
	const marker = source.indexOf(TASK_TEMPLATE_MARKER);
	if (marker < 0) throw new Error("Team prompt is missing its task template section");
	return {
		system: source.slice(0, marker).trim(),
		task: source.slice(marker + TASK_TEMPLATE_MARKER.length).trim(),
	};
}

const promptTemplates: Record<TeamRole, { system: string; task: string }> = {
	proposer: splitPromptTemplate(proposerPrompt),
	reviewer: splitPromptTemplate(reviewerPrompt),
	reviser: splitPromptTemplate(reviserPrompt),
	aligner: splitPromptTemplate(alignerPrompt),
	synthesizer: splitPromptTemplate(synthesizerPrompt),
};

export const TEAM_ROLE_SYSTEM_PROMPTS: Record<TeamRole, string> = {
	proposer: promptTemplates.proposer.system,
	reviewer: promptTemplates.reviewer.system,
	reviser: promptTemplates.reviser.system,
	aligner: promptTemplates.aligner.system,
	synthesizer: promptTemplates.synthesizer.system,
};

function renderTask(template: string, context: object): string {
	return prompt.render(template, context as prompt.TemplateContext).trim();
}

export function buildProposalTask(args: { question: string; cwd: string }): string {
	return renderTask(promptTemplates.proposer.task, { question: args.question.trim(), cwd: args.cwd.trim() });
}

export function buildAlignmentTask(args: {
	question: string;
	cwd: string;
	proposals: readonly TeamProposalRecord[];
}): string {
	return renderTask(promptTemplates.aligner.task, {
		question: args.question.trim(),
		cwd: args.cwd.trim(),
		proposals: args.proposals,
	});
}

/** Keep full history; replace only bodies already present in this prompt. */
function revisionHistoryForPrompt(
	history: readonly TeamProposalRecord["revisionHistory"][number][],
	currentProposal: string,
	previousProposal?: string,
) {
	return history.map(entry => {
		const reference =
			entry.revision.revisedProposal === currentProposal
				? "current"
				: entry.revision.revisedProposal === previousProposal
					? "previous"
					: undefined;
		return reference
			? {
					...entry,
					revision: { ...entry.revision, revisedProposal: undefined, revisedProposalReference: reference },
				}
			: entry;
	});
}

export function buildReviewTask(args: {
	question: string;
	cwd: string;
	alignment: TeamAlignmentOutput;
	targetLabel: string;
	proposalText: string;
	keyAssumptions: readonly { content: string; basis: string; status: string; impactIfWrong: string }[];
	risks: readonly string[];
	unknowns: readonly string[];
	evidence: readonly TeamEvidenceItem[];
	ambiguityInterpretations: readonly TeamAmbiguityInterpretation[];
	round: number;
	recheck: boolean;
	unresolvedBlocking?: readonly TeamTrackedFinding[];
	recheckContext?: {
		previousProposal: TeamProposalOutput;
		/** All revisions since the last successfully reviewed proposal. */
		revisions: readonly TeamProposalRecord["revisionHistory"][number][];
		reviews: readonly TeamReviewRecord[];
	};
}): string {
	return renderTask(promptTemplates.reviewer.task, {
		...args,
		question: args.question.trim(),
		cwd: args.cwd.trim(),
		unresolvedBlocking: args.unresolvedBlocking ?? [],
		recheckContext: args.recheckContext
			? {
					...args.recheckContext,
					revisions: revisionHistoryForPrompt(
						args.recheckContext.revisions,
						args.proposalText,
						args.recheckContext.previousProposal.proposal,
					),
				}
			: undefined,
		sameReviewedProposal: args.recheckContext?.previousProposal.proposal === args.proposalText,
	});
}

export function buildRevisionTask(args: {
	question: string;
	cwd: string;
	targetLabel: string;
	round: number;
	alignment: TeamAlignmentOutput;
	proposal: TeamProposalOutput;
	review: TeamReviewRecord;
	unresolvedBlocking: readonly TeamTrackedFinding[];
}): string {
	const responseFindings = new Map(args.review.findings.map(finding => [finding.id, finding]));
	for (const finding of args.unresolvedBlocking) {
		if (!responseFindings.has(finding.id)) responseFindings.set(finding.id, finding);
	}
	return renderTask(promptTemplates.reviser.task, {
		...args,
		question: args.question.trim(),
		cwd: args.cwd.trim(),
		responseFindings: [...responseFindings.values()],
		review: {
			noSubstantiveIssues: args.review.noSubstantiveIssues,
			reviewSummary: args.review.reviewSummary,
			blockingResolutions: args.review.blockingResolutions,
		},
		unresolvedBlockingIds: args.unresolvedBlocking.map(finding => finding.id),
		proposalStructured: {
			keyAssumptions: args.proposal.keyAssumptions,
			risks: args.proposal.risks,
			unknowns: args.proposal.unknowns,
			acceptanceCriteria: args.proposal.acceptanceCriteria,
			ambiguityInterpretations: args.proposal.ambiguityInterpretations,
			evidence: args.proposal.evidence,
		},
	});
}

export function buildSynthesisTask(args: {
	question: string;
	cwd: string;
	alignment: TeamAlignmentOutput;
	proposals: readonly TeamProposalRecord[];
}): string {
	return renderTask(promptTemplates.synthesizer.task, {
		question: args.question.trim(),
		cwd: args.cwd.trim(),
		alignment: args.alignment,
		proposals: args.proposals.map(record => ({
			...record,
			revisionHistory: revisionHistoryForPrompt(record.revisionHistory, record.latestProposal?.proposal ?? ""),
		})),
	});
}
