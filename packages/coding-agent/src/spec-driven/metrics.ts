export interface SpecRequestMeasurement {
	id: string;
	node: string;
	model: string;
	startedAt: number;
	endedAt: number;
	inputTokens: number | null;
	outputTokens: number | null;
	cacheReadTokens: number | null;
	cacheWriteTokens: number | null;
	cost: { amount: number; currency: string } | null;
	evidence: string;
}
export interface SpecQualityObservation {
	id: string;
	kind: "delivery-defect" | "omission" | "unauthorized-action" | "unsupported-release" | "human-correction";
	description: string;
	evidence: string;
	accepted: boolean;
}
export interface SpecRunMeasurement {
	task: string;
	codeBaseline: string;
	modelConfiguration: string;
	acceptanceCriteria: string;
	mode: "baseline" | "workflow";
	startedAt: number;
	endedAt: number;
	requests: SpecRequestMeasurement[];
	observations: SpecQualityObservation[];
	plannedDecisionWaitMs: number | null;
	executionWaitMs: number | null;
	assessmentComplete: boolean;
}
/** Positive provider-priced usage is known; absent or zero pricing stays explicitly unknown. */
export function specRequestCost(value: unknown): { amount: number; currency: string } | null {
	if (value === null || typeof value !== "object" || !("total" in value)) return null;
	const total = value.total;
	if (typeof total !== "number" || !Number.isFinite(total) || total <= 0) return null;
	return { amount: total, currency: "USD" };
}

export interface SpecRunSummary {
	requests: number;
	inputTokens: number | null;
	outputTokens: number | null;
	cacheReadTokens: number | null;
	cacheWriteTokens: number | null;
	costs: Record<string, number>;
	unknownCostRequests: number;
	elapsedMs: number;
	plannedDecisionWaitMs: number | null;
	executionWaitMs: number | null;
	acceptedFindings: Record<SpecQualityObservation["kind"], number | null>;
}
export interface SpecPairedReport {
	baseline: SpecRunMeasurement;
	workflow: SpecRunMeasurement;
	baselineSummary: SpecRunSummary;
	workflowSummary: SpecRunSummary;
	attribution: { upstream: string[]; orchestration: string[] };
	conclusion: string;
}
function nonnegative(value: number | null): void {
	if (value !== null && (!Number.isFinite(value) || value < 0))
		throw new Error("Measurement must be observed nonnegative finite data or null");
}
export function summarizeSpecRun(run: SpecRunMeasurement): SpecRunSummary {
	if (!Number.isFinite(run.startedAt) || !Number.isFinite(run.endedAt) || run.endedAt < run.startedAt)
		throw new Error("Invalid observed run timing");
	nonnegative(run.plannedDecisionWaitMs);
	nonnegative(run.executionWaitMs);
	if (
		new Set(run.requests.map(request => request.id)).size !== run.requests.length ||
		new Set(run.observations.map(item => item.id)).size !== run.observations.length
	)
		throw new Error("Duplicate measurement identity");
	const costs: Record<string, number> = {};
	let unknownCostRequests = 0;
	for (const request of run.requests) {
		if (
			!request.id ||
			!request.model ||
			!request.evidence ||
			!Number.isFinite(request.startedAt) ||
			!Number.isFinite(request.endedAt) ||
			request.startedAt < run.startedAt ||
			request.endedAt > run.endedAt ||
			request.endedAt < request.startedAt
		)
			throw new Error("Request requires real identity, evidence and in-run timing");
		for (const value of [
			request.inputTokens,
			request.outputTokens,
			request.cacheReadTokens,
			request.cacheWriteTokens,
		])
			nonnegative(value);
		if (request.cost === null) unknownCostRequests++;
		else {
			nonnegative(request.cost.amount);
			if (!request.cost.currency) throw new Error("Known cost requires a currency");
			costs[request.cost.currency] = (costs[request.cost.currency] ?? 0) + request.cost.amount;
		}
	}
	const sum = (field: "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens"): number | null => {
		if (!run.requests.length || run.requests.some(request => request[field] === null)) return null;
		return run.requests.reduce((total, request) => total + request[field]!, 0);
	};
	const acceptedFindings: SpecRunSummary["acceptedFindings"] = {
		"delivery-defect": run.assessmentComplete ? 0 : null,
		omission: run.assessmentComplete ? 0 : null,
		"unauthorized-action": run.assessmentComplete ? 0 : null,
		"unsupported-release": run.assessmentComplete ? 0 : null,
		"human-correction": run.assessmentComplete ? 0 : null,
	};
	for (const observation of run.observations) {
		if (!observation.evidence || !observation.description)
			throw new Error("Quality observation requires evidence and description");
		if (observation.accepted) acceptedFindings[observation.kind] = (acceptedFindings[observation.kind] ?? 0) + 1;
	}
	return {
		requests: run.requests.length,
		inputTokens: sum("inputTokens"),
		outputTokens: sum("outputTokens"),
		cacheReadTokens: sum("cacheReadTokens"),
		cacheWriteTokens: sum("cacheWriteTokens"),
		costs,
		unknownCostRequests,
		elapsedMs: run.endedAt - run.startedAt,
		plannedDecisionWaitMs: run.plannedDecisionWaitMs,
		executionWaitMs: run.executionWaitMs,
		acceptedFindings,
	};
}
export function createSpecPairedReport(baseline: SpecRunMeasurement, workflow: SpecRunMeasurement): SpecPairedReport {
	if (baseline.mode !== "baseline" || workflow.mode !== "workflow")
		throw new Error("Paired comparison requires distinct baseline and workflow runs");
	for (const field of ["task", "codeBaseline", "modelConfiguration", "acceptanceCriteria"] as const) {
		if (!baseline[field] || baseline[field] !== workflow[field]) throw new Error(`Unpaired comparison: ${field}`);
	}
	return {
		baseline: structuredClone(baseline),
		workflow: structuredClone(workflow),
		baselineSummary: summarizeSpecRun(baseline),
		workflowSummary: summarizeSpecRun(workflow),
		attribution: {
			upstream: [
				"OpenSpec specification management",
				"Superpowers TDD and independent review",
				"Team investigation and cross-review",
			],
			orchestration: [
				"Stage permissions",
				"Version-bound approvals",
				"Execution evidence association",
				"Mandatory stop gates",
			],
		},
		conclusion:
			"Observed paired results only; unknown costs remain unknown. Planned user decisions are not forced corrections. Additional calls, lower consumption, or simulated orchestration do not establish improved delivery quality or causal attribution.",
	};
}
export function renderSpecPairedReport(report: SpecPairedReport): string {
	return `# Paired specification workflow report\n\n${JSON.stringify(report, null, 2)}\n`;
}
