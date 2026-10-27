import * as crypto from "node:crypto";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import type { StructuredSubagentRequest } from "../task/structured-subagent";

const ENTRY = "dev-execution-evidence";
type Fact = "reset" | "worker" | "worker-failed" | "reviewer" | "reviewer-failed";
type JournalEntry = { type: string; customType?: string; data?: unknown };

/** Native task lifecycle facts only. The executor session branch is the durable owner. */
export class ExecutionEvidence {
	readonly #pending = new Map<StructuredSubagentRequest, { id: string; writable: boolean; reviewWorker: number }>();
	constructor(
		private readonly journal: { getBranch(): JournalEntry[]; appendCustomEntry(type: string, data: unknown): string },
		private readonly sessionId: string,
	) {}

	#record(fact: Fact): void {
		this.journal.appendCustomEntry(ENTRY, fact);
	}

	#facts(): Fact[] {
		const facts: Fact[] = [];
		for (const entry of this.journal.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== ENTRY) continue;
			if (entry.data === "reset") facts.length = 0;
			else if (["worker", "worker-failed", "reviewer", "reviewer-failed"].includes(String(entry.data)))
				facts.push(entry.data as Fact);
		}
		return facts;
	}

	#hasUnsettled(): boolean {
		const pending = new Set<string>();
		for (const entry of this.journal.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== ENTRY) continue;
			if (entry.data === "reset") {
				pending.clear();
				continue;
			}
			if (!entry.data || typeof entry.data !== "object") continue;
			const marker = entry.data as { kind?: unknown; id?: unknown };
			if (typeof marker.id !== "string") continue;
			if (marker.kind === "start") pending.add(marker.id);
			else if (marker.kind === "finish") pending.delete(marker.id);
		}
		return pending.size > 0;
	}

	reset(): void {
		this.#pending.clear();
		this.#record("reset");
	}

	start(request: StructuredSubagentRequest): void {
		if (this.#pending.has(request)) return;
		if (request.invocationKind !== "task" || request.session.sessionManager?.getSessionId?.() !== this.sessionId)
			return;
		const facts = this.#facts();
		const worker = facts.lastIndexOf("worker");
		const reviewWorker = worker > facts.lastIndexOf("worker-failed") ? worker : -1;
		const id = crypto.randomUUID();
		this.journal.appendCustomEntry(ENTRY, { kind: "start", id });
		this.#pending.set(request, { id, writable: false, reviewWorker });
	}

	observeSession(request: StructuredSubagentRequest, writable: boolean): void {
		const pending = this.#pending.get(request);
		if (pending) pending.writable = writable;
	}

	failed(request: StructuredSubagentRequest): void {
		const pending = this.#pending.get(request);
		if (!pending) return;
		this.#pending.delete(request);
		if (request.agent === "reviewer") this.#record("reviewer-failed");
		else if (pending.writable) this.#record("worker-failed");
		this.journal.appendCustomEntry(ENTRY, { kind: "finish", id: pending.id });
	}

	settled(request: StructuredSubagentRequest, result: SingleResult): void {
		const pending = this.#pending.get(request);
		if (!pending) return;
		this.#pending.delete(request);
		const success =
			result.exitCode === 0 &&
			!result.error &&
			!result.aborted &&
			(result.structuredOutput === undefined || result.structuredOutput.status === "valid");
		if (request.agent === "reviewer" && result.agent === "reviewer") {
			const facts = this.#facts();
			this.#record(
				success && pending.reviewWorker >= 0 && pending.reviewWorker === facts.lastIndexOf("worker")
					? "reviewer"
					: "reviewer-failed",
			);
		} else if (request.agent === "reviewer") {
			this.#record("reviewer-failed");
		} else if (pending.writable && result.agent !== "reviewer") {
			this.#record(success ? "worker" : "worker-failed");
		}
		this.journal.appendCustomEntry(ENTRY, { kind: "finish", id: pending.id });
	}

	check(): void {
		if (this.#pending.size || this.#hasUnsettled())
			throw new Error("仍有执行子代理尚未结清或历史结果不可恢复；请等待结果，或返回后重新进入执行阶段。");
		const facts = this.#facts();
		const worker = facts.lastIndexOf("worker");
		if (worker < 0 || worker < facts.lastIndexOf("worker-failed"))
			throw new Error("缺少可写 task 子代理成功结清的事实；请先派发实施子代理并等待结果。");
		const reviewer = facts.lastIndexOf("reviewer");
		if (reviewer <= worker || reviewer < facts.lastIndexOf("reviewer-failed"))
			throw new Error("缺少实施后成功结清的 reviewer 审查子代理；请派发审查并等待结果。");
	}
}
