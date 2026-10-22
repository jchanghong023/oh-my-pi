import { describe, expect, test } from "bun:test";
import { createExecutionPolicies } from "../../src/modes/zcode/execution-policies";
import type { ModelExecution } from "../../src/modes/zcode/schema/vendor/model-execution";
import type { OffPeakLifecycleNotification } from "../../src/modes/zcode/schema/vendor/off-peak-execution";

const target = { providerId: "ordinary", modelId: "model" };
function fallback(execution?: Partial<ModelExecution>) {
	return createExecutionPolicies({
		sessionId: "session",
		execution: {
			selectionScope: "execution",
			selectionFallback: {
				providerId: "accelerated",
				target,
				rules: [
					{ reason: "highspeed_card_expired", providerErrorCode: "3402" },
					{ reason: "highspeed_request_failed" },
				],
			},
			...execution,
		},
		capturedSelection: { providerId: "captured", modelId: "model" },
		onCancel() {},
		onOffPeakEvent() {},
	});
}

describe("execution selection fallback", () => {
	test("matches exact provider and first declared structured predicate once", async () => {
		const policy = fallback();
		policy.start();
		expect(await policy.recover({ providerId: "accelerated-other", providerErrorCode: "3402" })).toBeUndefined();
		expect(await policy.recover({ providerId: "accelerated", providerErrorCode: "3402" })).toEqual({
			kind: "fallback",
			reason: "highspeed_card_expired",
			target,
		});
		expect(await policy.recover({ providerId: "accelerated", providerErrorCode: "3402" })).toBeUndefined();
	});
	test("cancel and context overflow never authorize fallback", async () => {
		const policy = fallback();
		policy.start();
		expect(await policy.recover({ providerId: "accelerated", cancelled: true })).toBeUndefined();
		expect(await policy.recover({ providerId: "accelerated", contextOverflow: true })).toBeUndefined();
		expect(await policy.recover({ providerId: "accelerated", providerErrorCode: "other" })).toMatchObject({
			reason: "highspeed_request_failed",
		});
	});
	test("captures selection by value and clears request-only auth on fallback", async () => {
		const captured = { providerId: "original", modelId: "original" };
		const policy = createExecutionPolicies({
			sessionId: "s",
			capturedSelection: captured,
			execution: {
				selectionScope: "execution",
				requestAuth: { apiKey: "temporary" },
				selectionFallback: { providerId: "accelerated", rules: [{ reason: "highspeed_request_failed" }] },
			},
			onCancel() {},
			onOffPeakEvent() {},
		});
		captured.modelId = "changed";
		policy.start();
		expect(await policy.recover({ providerId: "accelerated" })).toMatchObject({ target: { modelId: "original" } });
		expect(policy.requestAuth).toBeUndefined();
	});
	test("unavailable fallback target is a truthful failure", async () => {
		const policy = createExecutionPolicies({
			sessionId: "s",
			execution: {
				selectionScope: "execution",
				selectionFallback: { providerId: "p", rules: [{ reason: "highspeed_request_failed" }] },
			},
			onCancel() {},
			onOffPeakEvent() {},
		});
		policy.start();
		await expect(policy.recover({ providerId: "p" })).rejects.toThrow("Fallback target is unavailable");
	});
	test("selection unavailability matches no fabricated code and emits only at admission", () => {
		const facts: unknown[] = [];
		const policy = createExecutionPolicies({
			sessionId: "s",
			execution: {
				selectionScope: "execution",
				selectionFallback: {
					providerId: "p",
					target,
					rules: [
						{ reason: "highspeed_card_expired", providerErrorCode: "3402" },
						{ reason: "highspeed_selection_unavailable" },
					],
				},
			},
			onCancel() {},
			onOffPeakEvent() {},
			onSelectionFallback(fact) {
				facts.push(fact);
			},
		});
		expect(policy.recoverSelectionUnavailable("wrong")).toBeUndefined();
		expect(policy.recoverSelectionUnavailable("p")).toEqual({
			kind: "fallback",
			target,
			reason: "highspeed_selection_unavailable",
		});
		expect(facts).toEqual([]);
		policy.start();
		expect(facts).toEqual([{ target, reason: "highspeed_selection_unavailable" }]);
		expect(policy.recoverSelectionUnavailable("p")).toBeUndefined();
	});
	test("selection unavailability cannot match a coded-only rule", () => {
		const policy = fallback({
			selectionFallback: {
				providerId: "p",
				target,
				rules: [{ reason: "highspeed_card_expired", providerErrorCode: "3402" }],
			},
		});
		expect(policy.recoverSelectionUnavailable("p")).toBeUndefined();
	});
});

function offPeak() {
	const events: OffPeakLifecycleNotification[] = [];
	let cancelled = 0;
	const policy = createExecutionPolicies({
		sessionId: "s",
		offPeakTaskId: "task",
		execution: {
			selectionScope: "execution",
			requestAuth: { apiKey: "old" },
			offPeak: { executionId: "run", ticketId: "ticket", providerErrorCode: "expired" },
		},
		onCancel() {
			cancelled++;
		},
		onOffPeakEvent(event) {
			events.push(event);
		},
	});
	policy.start();
	return { policy, events, cancelled: () => cancelled };
}

describe("off peak execution lifecycle", () => {
	test("renews only matching execution and renewal; replaces request-local auth", async () => {
		const { policy, events } = offPeak();
		expect(await policy.recover({ providerId: "p", providerErrorCode: "wrong" })).toBeUndefined();
		const pending = policy.recover({ providerId: "p", providerErrorCode: "expired" });
		expect(events.at(-1)).toMatchObject({ type: "ticket_needed", renewalId: 1, expiredTicketId: "ticket" });
		const control = {
			sessionId: "s",
			executionId: "run",
			action: "replace_ticket" as const,
			renewalId: 1,
			ticketId: "next",
			requestAuth: { apiKey: "new" },
		};
		expect(policy.offPeakControl({ ...control, sessionId: "other" }).accepted).toBe(false);
		expect(policy.offPeakControl({ ...control, executionId: "other" }).accepted).toBe(false);
		expect(policy.offPeakControl({ ...control, renewalId: 2 }).accepted).toBe(false);
		expect(policy.offPeakControl(control).accepted).toBe(true);
		expect(await pending).toEqual({ kind: "ticket", requestAuth: { apiKey: "new" } });
		expect(policy.offPeakControl(control).accepted).toBe(false);
		expect(policy.requestAuth).toEqual({ apiKey: "new" });
		policy.complete("succeeded");
		expect(events.at(-1)).toMatchObject({ type: "completed", outcome: "succeeded" });
	});
	test("cancel invalidates pending auth and late ticket cannot resurrect", async () => {
		const { policy, cancelled, events } = offPeak();
		const pending = policy.recover({ providerId: "p", providerErrorCode: "expired" });
		expect(policy.offPeakControl({ sessionId: "s", executionId: "run", action: "cancel" }).accepted).toBe(true);
		expect(await pending).toBeUndefined();
		expect(cancelled()).toBe(1);
		expect(
			policy.offPeakControl({
				sessionId: "s",
				executionId: "run",
				action: "replace_ticket",
				renewalId: 1,
				ticketId: "late",
				requestAuth: { apiKey: "late" },
			}).accepted,
		).toBe(false);
		expect(policy.requestAuth).toBeUndefined();
		expect(events.filter(event => event.type === "completed")).toHaveLength(1);
	});
	test("cancel after ticket delivery but before recovery resumes cannot resurrect auth", async () => {
		const { policy } = offPeak();
		const pending = policy.recover({ providerId: "p", providerErrorCode: "expired" });
		expect(
			policy.offPeakControl({
				sessionId: "s",
				executionId: "run",
				action: "replace_ticket",
				renewalId: 1,
				ticketId: "next",
				requestAuth: { apiKey: "new" },
			}).accepted,
		).toBe(true);
		policy.offPeakControl({ sessionId: "s", executionId: "run", action: "cancel" });
		expect(await pending).toBeUndefined();
		expect(policy.requestAuth).toBeUndefined();
	});
	test("renewal generations reject old delivery without affecting another execution", async () => {
		const first = offPeak();
		const second = offPeak();
		const old = first.policy.recover({ providerId: "p", providerErrorCode: "expired" });
		first.policy.offPeakControl({
			sessionId: "s",
			executionId: "run",
			action: "replace_ticket",
			renewalId: 1,
			ticketId: "next",
			requestAuth: { apiKey: "new" },
		});
		await old;
		const current = first.policy.recover({ providerId: "p", providerErrorCode: "expired" });
		expect(first.events.at(-1)).toMatchObject({ type: "ticket_needed", renewalId: 2, expiredTicketId: "next" });
		expect(
			first.policy.offPeakControl({
				sessionId: "s",
				executionId: "run",
				action: "replace_ticket",
				renewalId: 1,
				ticketId: "stale",
				requestAuth: { apiKey: "stale" },
			}).accepted,
		).toBe(false);
		first.policy.complete("stopped");
		expect(await current).toBeUndefined();
		expect(second.policy.requestAuth).toEqual({ apiKey: "old" });
		second.policy.complete("succeeded");
	});
	test("background wait projects owned work only and cannot override ticket wait or terminal state", async () => {
		const { policy, events } = offPeak();
		policy.setBackgroundWaiting(true);
		expect(events.at(-1)).toMatchObject({ type: "state_changed", state: "waiting_background" });
		const count = events.length;
		policy.setBackgroundWaiting(true);
		expect(events).toHaveLength(count);
		policy.setBackgroundWaiting(false);
		expect(events.at(-1)).toMatchObject({ type: "state_changed", state: "running_idle" });
		const pending = policy.recover({ providerId: "p", providerErrorCode: "expired" });
		policy.setBackgroundWaiting(true);
		expect(events.at(-1)).toMatchObject({ type: "ticket_needed" });
		policy.complete("stopped");
		await pending;
		const terminalCount = events.length;
		policy.setBackgroundWaiting(true);
		expect(events).toHaveLength(terminalCount);
	});
	test("takeover releases ticket and disables renewal", async () => {
		const { policy, events } = offPeak();
		policy.userTakeover();
		expect(events).toContainEqual({
			sessionId: "s",
			executionId: "run",
			offPeakTaskId: "task",
			type: "user_takeover",
		});
		expect(await policy.recover({ providerId: "p", providerErrorCode: "expired" })).toBeUndefined();
		policy.complete("succeeded");
		expect(events.filter(event => event.type === "ticket_released")).toHaveLength(1);
	});
});
