import { reduceWorkflowRunsState } from "../schema/vendor/zcode-protocol-v4/workflow-runs-reducer.js";
import { workflowRunsStateSchema, type WorkflowRunsState } from "../schema/vendor/zcode-protocol-v4/workflow-runs.js";
import type { BackgroundWorkSummary } from "../schema/vendor/zcode-protocol-v4/snapshot.js";
import type { OmpWorkflowJournal } from "./journal.js";
import type { RunRecord, StoredEvent } from "./vendor/dynamic-workflow/index.js";

export function workflowEventPayload(stored: StoredEvent) {
	const { type, ...payload } = stored.event;
	const bounded = boundWorkflowPayload(payload);
	return { sequence: stored.sequence, type, ...bounded };
}

/** Original contracts dynamic-workflow-run.port.ts payload bounds, shared by queries and projection. */
function boundWorkflowPayload(payload: Record<string, unknown>) {
	let truncated = false;
	const visit = (value: unknown, depth: number): unknown => {
		if (value === null || typeof value === "boolean") return value;
		if (typeof value === "number") return Number.isFinite(value) ? value : null;
		if (typeof value === "string") {
			if (value.length <= 2048) return value;
			truncated = true;
			const cut = value.slice(0, 2048);
			const last = cut.charCodeAt(cut.length - 1);
			return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
		}
		if (typeof value !== "object") return undefined;
		if (depth >= 6) {
			truncated = true;
			return undefined;
		}
		if (Array.isArray(value)) {
			if (value.length > 32) truncated = true;
			return value.slice(0, 32).map(item => visit(item, depth + 1) ?? null);
		}
		const entries = Object.entries(value as Record<string, unknown>);
		if (entries.length > 32) truncated = true;
		const out: Record<string, unknown> = {};
		for (const [key, item] of entries.slice(0, 32)) {
			const bounded = visit(item, depth + 1);
			if (bounded !== undefined) Object.defineProperty(out, key, { value: bounded, enumerable: true });
		}
		return out;
	};
	return { payload: visit(payload, 0) as Record<string, unknown>, ...(truncated ? { truncated: true as const } : {}) };
}
export function workflowRunResumable(run: RunRecord) {
	return run.status === "stopped" && run.stopReason !== "superseded";
}
/** Both live refresh and cold reconstruction read the same durable events and strict reducer. */
export function projectWorkflowSession(journal: OmpWorkflowJournal, sessionId: string, defaultConcurrency: number) {
	let state: WorkflowRunsState = { revision: 0, runs: [] };
	const runs = journal.listRuns({ parentSessionId: sessionId, limit: 8 }).reverse();
	const backgroundWorks: BackgroundWorkSummary[] = [];
	for (const run of runs) {
		let afterSequence = 0;
		for (;;) {
			const page = journal.getEvents(run.runId, { types: "all", reportItems: "all", afterSequence, limit: 256 });
			for (const stored of page) {
				const event = workflowEventPayload(stored);
				const payload: Record<string, unknown> = { ...event.payload };
				if (event.type === "run-started" || event.type === "run-caps-changed")
					payload.concurrencyCeiling = defaultConcurrency;
				if (event.type === "run-settled") payload.resumable = workflowRunResumable(run);
				const original = stored.event;
				const actorRef = "actor" in original ? original.actor : undefined;
				const actor = actorRef ? journal.getActor(run.runId, actorRef.siteId, actorRef.ordinal) : undefined;
				if (actor?.resolvedModel)
					payload[original.type === "actor-created" ? "model" : "actorModel"] = actor.resolvedModel;
				state =
					reduceWorkflowRunsState(state, {
						runId: run.runId,
						toolCallId: run.toolCallId,
						sequence: stored.sequence,
						eventType: event.type,
						payload,
						actorSessionId: actor?.sessionId,
					}) ?? state;
				afterSequence = stored.sequence;
			}
			if (page.length < 256) break;
		}
		// Historical rows remain inspectable in workflowRuns; only truly live executions are background work.
		if (run.status === "running" || run.status === "pending")
			backgroundWorks.push({
				workId: run.runId,
				kind: "workflow",
				title: run.name ?? run.runId,
				status: "running",
				startedAt: run.createdAt,
				cancellable: true,
				anchorRowId: null,
			});
	}
	return { workflowRuns: workflowRunsStateSchema.parse(state), backgroundWorks };
}
