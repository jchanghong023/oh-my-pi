import type { ModelExecution, ModelExecutionSelectionFallbackReason } from "./schema/vendor/model-execution";
import type { ModelSelection } from "./schema/vendor/model-selection";
import type {
	OffPeakControlParams,
	OffPeakControlResult,
	OffPeakLifecycleEvent,
	OffPeakLifecycleNotification,
	OffPeakOutcome,
} from "./schema/vendor/off-peak-execution";

export interface ExecutionPolicyFailure {
	providerId: string;
	providerErrorCode?: string;
	cancelled?: boolean;
	contextOverflow?: boolean;
}
export type ExecutionPolicyRecovery =
	| { kind: "fallback"; target: ModelSelection; reason: ModelExecutionSelectionFallbackReason }
	| { kind: "ticket"; requestAuth: NonNullable<ModelExecution["requestAuth"]> };
export interface ZCodeExecutionPolicyOptions {
	sessionId: string;
	execution: ModelExecution;
	capturedSelection?: ModelSelection;
	offPeakTaskId?: string;
	signal?: AbortSignal;
	onOffPeakEvent: (event: OffPeakLifecycleNotification) => void;
	onCancel: () => void;
	onSelectionFallback?: (fallback: { target: ModelSelection; reason: ModelExecutionSelectionFallbackReason }) => void;
}

/** Held by the original admitted execution lease, never a scheduler or current-execution registry. */
export class ZCodeExecutionPolicies {
	readonly #options: ZCodeExecutionPolicyOptions;
	readonly #execution: ModelExecution;
	readonly #capturedSelection?: ModelSelection;
	#auth?: ModelExecution["requestAuth"];
	#started = false;
	#terminal = false;
	#fallbackUsed = false;
	#userOwned = false;
	#backgroundWaiting = false;
	#admissionFallback?: Extract<ExecutionPolicyRecovery, { kind: "fallback" }>;
	#ticketId?: string;
	#renewalId = 0;
	#pending?: { renewalId: number; resolve: (recovery: ExecutionPolicyRecovery | undefined) => void };
	readonly #abort = () => this.complete("stopped");

	constructor(options: ZCodeExecutionPolicyOptions) {
		if (options.execution.offPeak && !options.offPeakTaskId)
			throw new Error("Off-peak execution requires its task identity");
		this.#options = options;
		this.#execution = structuredClone(options.execution);
		this.#capturedSelection = options.capturedSelection && structuredClone(options.capturedSelection);
		this.#auth = this.#execution.requestAuth;
		this.#ticketId = this.#execution.offPeak?.ticketId;
	}

	get requestAuth(): ModelExecution["requestAuth"] {
		return this.#terminal ? undefined : this.#auth && structuredClone(this.#auth);
	}

	/** Called only after the authoritative input admission, never while it is still queued. */
	start(): void {
		if (this.#started || this.#terminal) return;
		this.#started = true;
		if (this.#options.signal?.aborted) {
			this.complete("stopped");
			return;
		}
		this.#options.signal?.addEventListener("abort", this.#abort, { once: true });
		this.#emit({ type: "state_changed", state: "running_idle" });
		if (this.#admissionFallback) {
			const { target, reason } = this.#admissionFallback;
			this.#admissionFallback = undefined;
			this.#options.onSelectionFallback?.({ target: structuredClone(target), reason });
		}
	}

	/** Registry unavailability is not a provider response and cannot invent a provider error code. */
	recoverSelectionUnavailable(providerId: string): Extract<ExecutionPolicyRecovery, { kind: "fallback" }> | undefined {
		if (this.#started || this.#terminal || this.#fallbackUsed || this.#options.signal?.aborted) return undefined;
		const fallback = this.#execution.selectionFallback;
		if (!fallback || fallback.providerId !== providerId) return undefined;
		const rule = fallback.rules.find(rule => rule.providerErrorCode === undefined);
		if (!rule) return undefined;
		const target = fallback.target ?? this.#capturedSelection;
		if (!target) throw new Error("Fallback target is unavailable");
		this.#fallbackUsed = true;
		this.#auth = undefined;
		this.#admissionFallback = { kind: "fallback", target: structuredClone(target), reason: rule.reason };
		return structuredClone(this.#admissionFallback);
	}

	/** Only the failed provider request is retried. The caller must not replay the prompt or tools. */
	async recover(failure: ExecutionPolicyFailure): Promise<ExecutionPolicyRecovery | undefined> {
		if (
			!this.#started ||
			this.#terminal ||
			this.#options.signal?.aborted ||
			failure.cancelled ||
			failure.contextOverflow
		)
			return undefined;
		const offPeak = this.#execution.offPeak;
		if (offPeak && !this.#userOwned && failure.providerErrorCode === offPeak.providerErrorCode) {
			// Concurrent/duplicate failures cannot create a second ticket consumer.
			if (this.#pending) return undefined;
			const renewalId = ++this.#renewalId;
			const expiredTicketId = this.#ticketId!;
			this.#auth = undefined;
			const { promise, resolve } = Promise.withResolvers<ExecutionPolicyRecovery | undefined>();
			this.#pending = { renewalId, resolve };
			this.#emit({ type: "state_changed", state: "waiting_ticket" });
			this.#emit({ type: "ticket_needed", renewalId, expiredTicketId });
			const recovery = await promise;
			return this.#terminal || this.#userOwned || this.#options.signal?.aborted ? undefined : recovery;
		}
		const fallback = this.#execution.selectionFallback;
		if (!fallback || this.#fallbackUsed || failure.providerId !== fallback.providerId) return undefined;
		const rule = fallback.rules.find(
			rule => rule.providerErrorCode === undefined || rule.providerErrorCode === failure.providerErrorCode,
		);
		if (!rule) return undefined;
		const target = fallback.target ?? this.#capturedSelection;
		if (!target) throw new Error("Fallback target is unavailable");
		this.#fallbackUsed = true;
		this.#auth = undefined;
		const recovery = { kind: "fallback" as const, target: structuredClone(target), reason: rule.reason };
		this.#options.onSelectionFallback?.({ target: structuredClone(target), reason: rule.reason });
		return recovery;
	}

	offPeakControl(control: OffPeakControlParams): OffPeakControlResult {
		const offPeak = this.#execution.offPeak;
		if (
			!offPeak ||
			!this.#started ||
			this.#terminal ||
			this.#userOwned ||
			this.#options.signal?.aborted ||
			control.sessionId !== this.#options.sessionId ||
			control.executionId !== offPeak.executionId
		)
			return { accepted: false };
		if (control.action === "cancel") {
			this.complete("stopped");
			this.#options.onCancel();
			return { accepted: true };
		}
		const pending = this.#pending;
		if (!pending || control.renewalId !== pending.renewalId || control.ticketId === this.#ticketId)
			return { accepted: false };
		this.#pending = undefined;
		this.#releaseTicket();
		this.#ticketId = control.ticketId;
		this.#auth = structuredClone(control.requestAuth);
		this.#emit({ type: "state_changed", state: "running_idle" });
		pending.resolve({ kind: "ticket", requestAuth: structuredClone(control.requestAuth) });
		return { accepted: true };
	}

	/** Projects the original session's owned async-work wait; never starts or schedules work. */
	setBackgroundWaiting(waiting: boolean): void {
		if (
			!this.#started ||
			this.#terminal ||
			this.#userOwned ||
			this.#pending ||
			!this.#execution.offPeak ||
			this.#options.signal?.aborted ||
			waiting === this.#backgroundWaiting
		)
			return;
		this.#backgroundWaiting = waiting;
		this.#emit({ type: "state_changed", state: waiting ? "waiting_background" : "running_idle" });
	}

	userTakeover(): void {
		if (!this.#started || this.#terminal || this.#userOwned || !this.#execution.offPeak) return;
		this.#userOwned = true;
		this.#auth = undefined;
		const pending = this.#pending;
		this.#pending = undefined;
		pending?.resolve(undefined);
		this.#emit({ type: "user_takeover" });
		this.#releaseTicket();
		this.#emit({ type: "state_changed", state: "running_user" });
	}

	complete(outcome: OffPeakOutcome): void {
		if (this.#terminal) return;
		this.#terminal = true;
		this.#options.signal?.removeEventListener("abort", this.#abort);
		this.#auth = undefined;
		const pending = this.#pending;
		this.#pending = undefined;
		pending?.resolve(undefined);
		if (!this.#started) return;
		this.#releaseTicket();
		this.#emit({ type: "state_changed", state: outcome === "stopped" ? "cancelled" : "completed" });
		this.#emit({ type: "completed", outcome });
	}

	#releaseTicket(): void {
		if (!this.#ticketId) return;
		const ticketId = this.#ticketId;
		this.#ticketId = undefined;
		this.#emit({ type: "ticket_released", ticketId });
	}

	#emit(
		event:
			| Omit<Extract<OffPeakLifecycleEvent, { type: "state_changed" }>, "executionId" | "offPeakTaskId">
			| Omit<Extract<OffPeakLifecycleEvent, { type: "ticket_needed" }>, "executionId" | "offPeakTaskId">
			| Omit<Extract<OffPeakLifecycleEvent, { type: "ticket_released" }>, "executionId" | "offPeakTaskId">
			| Omit<Extract<OffPeakLifecycleEvent, { type: "completed" }>, "executionId" | "offPeakTaskId">
			| { type: "user_takeover" },
	): void {
		const offPeak = this.#execution.offPeak;
		if (!offPeak) return;
		this.#options.onOffPeakEvent({
			...event,
			sessionId: this.#options.sessionId,
			executionId: offPeak.executionId,
			offPeakTaskId: this.#options.offPeakTaskId!,
		});
	}
}

export function createExecutionPolicies(options: ZCodeExecutionPolicyOptions): ZCodeExecutionPolicies {
	return new ZCodeExecutionPolicies(options);
}
