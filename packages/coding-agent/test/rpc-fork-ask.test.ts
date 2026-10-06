import { describe, expect, test } from "bun:test";
import { RpcForkAskBroker } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-fork-ask";
import { RpcForkHost, type RpcForkContext } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-fork-host";
import type { ExtensionAskDialogQuestion } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";

const makeContext = (emitted: object[]): RpcForkContext => ({
	emit: frame => emitted.push(frame),
});

const twoQuestions: ExtensionAskDialogQuestion[] = [
	{
		id: "q1",
		question: "Pick one",
		header: "Choice",
		options: [{ label: "Alpha", description: "first" }, { label: "Beta" }],
		recommended: 1,
	},
	{
		id: "q2",
		question: "Pick many",
		options: [{ label: "One" }, { label: "Two" }, { label: "Three" }],
		multi: true,
	},
];

function setup() {
	const emitted: object[] = [];
	const host = new RpcForkHost(makeContext(emitted));
	const broker = new RpcForkAskBroker(host, frame => emitted.push(frame));
	return { emitted, host, broker };
}

describe("RpcForkAskBroker (4.3)", () => {
	test("inactive until v3: getAskDialog returns undefined", () => {
		const { host, broker } = setup();
		expect(host.isActive).toBe(false);
		expect(broker.getAskDialog()).toBeUndefined();
		host.activate();
		expect(broker.getAskDialog()).toBeTypeOf("function");
	});

	test("ask_request carries questions, timeout, and deadline; answers map back", async () => {
		const { emitted, host, broker } = setup();
		host.activate();
		const ask = broker.getAskDialog()!;
		const pending = ask(twoQuestions, { timeout: 5000 });

		await Bun.sleep(0);
		expect(emitted).toHaveLength(1);
		const request = emitted[0] as Record<string, unknown>;
		expect(request.type).toBe("ask_request");
		expect(typeof request.id).toBe("string");
		expect(request.timeoutMs).toBe(5000);
		expect(request.deadlineAt).toBeGreaterThan(Date.now() - 1000);
		const questions = request.questions as Array<Record<string, unknown>>;
		expect(questions).toHaveLength(2);
		expect(questions[0]).toMatchObject({ id: "q1", header: "Choice", recommended: 1 });
		expect(questions[0]!.options).toEqual([{ label: "Alpha", description: "first" }, { label: "Beta" }]);
		expect(questions[1]!.multi).toBe(true);

		// Multi empty submission is a valid "select none"; unknown labels drop.
		const askId = request.id as string;
		expect(
			host.handleControlFrame({
				type: "ask_response",
				id: askId,
				answers: [
					{ questionId: "q1", selected: ["Alpha", "Ghost"], other: "  custom  " },
					{ questionId: "q2", selected: [] },
					{ questionId: "qUnknown", selected: ["X"] },
				],
			}),
		).toBe(true);

		const result = await pending;
		expect(result).toEqual({
			kind: "submit",
			results: [
				{
					id: "q1",
					question: "Pick one",
					options: ["Alpha", "Beta"],
					multi: false,
					selectedOptions: [],
					customInput: "custom",
				},
				{
					id: "q2",
					question: "Pick many",
					options: ["One", "Two", "Three"],
					multi: true,
					selectedOptions: [],
				},
			],
		});
	});

	test("single-select answer maps to selectedOptions; chat and cancelled paths settle", async () => {
		const { emitted, host, broker } = setup();
		host.activate();
		const ask = broker.getAskDialog()!;

		const single = ask([twoQuestions[0]!], {});
		await Bun.sleep(0);
		const id1 = (emitted.at(-1) as Record<string, unknown>).id as string;
		host.handleControlFrame({ type: "ask_response", id: id1, answers: [{ questionId: "q1", selected: ["Beta"] }] });
		await expect(single).resolves.toMatchObject({
			kind: "submit",
			results: [{ id: "q1", selectedOptions: ["Beta"] }],
		});

		const chat = ask(twoQuestions, {});
		await Bun.sleep(0);
		const id2 = (emitted.at(-1) as Record<string, unknown>).id as string;
		host.handleControlFrame({ type: "ask_response", id: id2, chat: true });
		await expect(chat).resolves.toEqual({ kind: "chat" });

		const cancelled = ask(twoQuestions, {});
		await Bun.sleep(0);
		const id3 = (emitted.at(-1) as Record<string, unknown>).id as string;
		host.handleControlFrame({ type: "ask_response", id: id3, cancelled: true });
		await expect(cancelled).resolves.toBeUndefined();

		// Unknown ids are consumed but ignored.
		expect(host.handleControlFrame({ type: "ask_response", id: "nope", cancelled: true })).toBe(true);
	});

	test("malformed ask_response (non-array answers) settles undefined instead of hanging", async () => {
		const { emitted, host, broker } = setup();
		host.activate();
		const ask = broker.getAskDialog()!;
		const pending = ask(twoQuestions, { timeout: 30_000 });

		await Bun.sleep(0);
		const id = (emitted.at(-1) as Record<string, unknown>).id as string;
		host.handleControlFrame({ type: "ask_response", id, answers: "oops" });
		await expect(pending).resolves.toBeUndefined();
	});

	test("ask_pause idempotently cancels the countdown; server never auto-submits after pause", async () => {
		const { emitted, host, broker } = setup();
		host.activate();
		const ask = broker.getAskDialog()!;
		const pending = ask(twoQuestions, { timeout: 60 });

		await Bun.sleep(0);
		const id = (emitted.at(-1) as Record<string, unknown>).id as string;
		expect(host.handleControlFrame({ type: "ask_pause", targetId: id })).toBe(true);
		// Idempotent: repeated pauses are consumed no-ops.
		expect(host.handleControlFrame({ type: "ask_pause", targetId: id })).toBe(true);

		await Bun.sleep(150);
		const settled = await Promise.race([pending.then(() => true), Bun.sleep(10).then(() => false)]);
		expect(settled).toBe(false);

		host.handleControlFrame({ type: "ask_response", id, cancelled: true });
		await expect(pending).resolves.toBeUndefined();
	});

	test("unpaused countdown expires into recommended auto-submit with timedOut", async () => {
		const { emitted, host, broker } = setup();
		host.activate();
		const ask = broker.getAskDialog()!;
		const result = await ask(twoQuestions, { timeout: 40 });
		await Bun.sleep(120);
		expect(result).toEqual({
			kind: "submit",
			results: [
				{
					id: "q1",
					question: "Pick one",
					options: ["Alpha", "Beta"],
					multi: false,
					selectedOptions: ["Beta"],
					timedOut: true,
				},
				{
					id: "q2",
					question: "Pick many",
					options: ["One", "Two", "Three"],
					multi: true,
					selectedOptions: ["One"],
					timedOut: true,
				},
			],
		});
		expect(emitted.at(-1)).toMatchObject({
			type: "extension_ui_request",
			method: "cancel",
			targetId: (emitted[0] as Record<string, unknown>).id,
		});
		expect(host.hasPendingRequests).toBe(false);
	});

	test("abort resolves undefined and emits a cancel frame targeting the ask id", async () => {
		const { emitted, host, broker } = setup();
		host.activate();
		const ask = broker.getAskDialog()!;
		const controller = new AbortController();
		const pending = ask(twoQuestions, { signal: controller.signal });

		await Bun.sleep(0);
		const id = (emitted.at(-1) as Record<string, unknown>).id as string;
		controller.abort();
		await expect(pending).resolves.toBeUndefined();
		const cancel = emitted.at(-1) as Record<string, unknown>;
		expect(cancel).toMatchObject({ type: "extension_ui_request", method: "cancel", targetId: id });
	});
	test("pre-aborted requests emit nothing, and captured dialog functions fail after disconnect", async () => {
		const { emitted, host, broker } = setup();
		host.activate();
		const ask = broker.getAskDialog()!;
		const controller = new AbortController();
		controller.abort();
		await expect(ask(twoQuestions, { signal: controller.signal })).resolves.toBeUndefined();
		expect(emitted).toEqual([]);
		expect(host.hasPendingRequests).toBe(false);

		const pending = ask(twoQuestions);
		expect(host.hasPendingRequests).toBe(true);
		const failure = pending.catch(error => error);
		host.dispose("closed");
		expect(await failure).toBeInstanceOf(Error);
		expect(host.hasPendingRequests).toBe(false);
		await expect(ask(twoQuestions)).rejects.toThrow("closed");
		expect(emitted).toHaveLength(1);
	});

	test("client disconnect fails pending asks (fail-closed)", async () => {
		const { host, broker } = setup();
		host.activate();
		const ask = broker.getAskDialog()!;
		const pending = ask(twoQuestions, { timeout: 30_000 });
		await Bun.sleep(0);

		host.dispose("RPC client disconnected before fork request completed");
		await expect(pending).rejects.toThrow("RPC client disconnected before fork request completed");
	});
});
