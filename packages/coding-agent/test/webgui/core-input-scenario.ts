import { expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import {
	TID_V4_QUEUE_ITEM,
	TID_V4_QUEUE_ITEM_SEND_NOW,
	TID_V4_ROW,
	testId,
} from "../../../../vendor/zcode-frontend/packages/shared/src/test-ids";
import type {
	CommandAck,
	CommandPayloadMap,
	CommandType,
} from "../../../../vendor/zcode-frontend/packages/shared/src/zcode-protocol-v4/command";
import type { ConversationSnapshot } from "../../../../vendor/zcode-frontend/packages/shared/src/zcode-protocol-v4/snapshot";
import type { AgentSession } from "../../src/session/agent-session";
import { loadSessionMessagesReadOnly } from "../../src/session/session-loader";
import { nativeChatRuntimeForSession } from "../../src/webgui/native-chat";
import { nativeWebGuiQuestions } from "../../src/webgui/native-interactions";
import { createAgentServices } from "../../src/webgui/services-agent";
import type { BrowserButtonElement, BrowserGlobals, BrowserHtmlElement } from "./core-browser-dom";
import type { NativeBrowserCase } from "./core-browser-types";

const EDITOR = '[data-testid="v4-composer-input"]';
const INPUT = `${EDITOR}[contenteditable="true"]`;
const SEND = '[data-testid="v4-composer-send"]';
const LOADING = '[data-testid="v4-timeline"] [data-testid="chat-loading"]';
const ERROR = '[data-testid="chat-error-banner"]';
const USER_ROWS = '[data-testid="v4-timeline"] [data-row-id][class~="group/user-row"]';
const ASSISTANT_TEXT =
	'[data-testid="v4-timeline"] [data-row-id][class~="group/assistant-row"] [data-conversation-selectable="true"]';

/** Exercise retained browser input, native admission, and the actual streaming message renderer. */
export async function inputScenario(native: NativeBrowserCase): Promise<void> {
	const { page, session } = native;
	const prompt = "Keep this browser draft until native admission succeeds.";
	// Neither assistant marker occurs in the prompt: a user-row echo cannot satisfy streaming assertions.
	const prefix = "Browser assistant partial response";
	const suffix = " and its final persisted continuation.";
	const acceptedUsersBefore = session.messages.filter(message => message.role === "user").length;

	await page.goto(native.url, { waitUntil: "domcontentloaded" });
	await page.waitForSelector(INPUT, { visible: true });
	await page.click(INPUT);
	await page.keyboard.type(prompt);
	await page.waitForFunction(
		(input, send, text) => {
			const { document } = globalThis as BrowserGlobals;
			const editor = document.querySelector(input);
			const button = document.querySelector<BrowserButtonElement>(send);
			return editor?.textContent === text && button !== null && !button.disabled;
		},
		{},
		INPUT,
		SEND,
		prompt,
	);

	native.rejectNextPrompt("Core browser admission rejected before accepting the draft");
	await page.click(SEND);
	await page.waitForSelector(`${ERROR}[data-error-code="SEND_FAILED"]`, { visible: true });
	expect(await page.$eval(ERROR, element => element.textContent?.trim().length ?? 0)).toBeGreaterThan(0);
	expect(await page.$eval(INPUT, element => element.textContent)).toBe(prompt);
	expect(session.messages.filter(message => message.role === "user")).toHaveLength(acceptedUsersBefore);
	expect(
		await page.$$eval(USER_ROWS, (rows, text) => rows.filter(row => row.textContent?.includes(text)).length, prompt),
	).toBe(0);
	expect(await page.$(LOADING)).toBeNull();
	expect(session.isStreaming).toBe(false);

	const reply = native.setReply(prefix, suffix);
	try {
		await page.waitForFunction(
			send => {
				const { document } = globalThis as BrowserGlobals;
				const button = document.querySelector<BrowserButtonElement>(send);
				return button !== null && !button.disabled;
			},
			{},
			SEND,
		);
		// Resend the retained draft with the real control, without replacing its editor contents.
		await page.click(SEND);
		await page.waitForFunction(
			(assistant, partial, final, loading) => {
				const { document } = globalThis as BrowserGlobals;
				const bodies = Array.from(document.querySelectorAll<BrowserHtmlElement>(assistant));
				return (
					bodies.some(body => body.checkVisibility() && body.innerText.trim() === partial) &&
					!bodies.some(body => body.textContent?.includes(final)) &&
					document.querySelector<BrowserHtmlElement>(loading)?.checkVisibility() === true
				);
			},
			{},
			ASSISTANT_TEXT,
			prefix,
			suffix,
			LOADING,
		);
		await reply.began;
		expect(session.isStreaming).toBe(true);
		expect(await page.$(ERROR)).toBeNull();
		expect(session.messages.filter(message => message.role === "user")).toHaveLength(acceptedUsersBefore + 1);
		expect(
			await page.$$eval(
				USER_ROWS,
				(rows, text) => rows.filter(row => row.textContent?.includes(text)).length,
				prompt,
			),
		).toBe(1);

		reply.finish();
		await reply.finished;
		expect(session.isStreaming).toBe(false);
		await page.waitForFunction(
			(assistant, complete, loading, send, input) => {
				const { document } = globalThis as BrowserGlobals;
				const button = document.querySelector<BrowserButtonElement>(send);
				return (
					Array.from(document.querySelectorAll<BrowserHtmlElement>(assistant)).some(
						body => body.checkVisibility() && body.innerText.trim() === complete,
					) &&
					document.querySelector(loading) === null &&
					button !== null &&
					document.querySelector<BrowserHtmlElement>(input)?.checkVisibility() === true
				);
			},
			{},
			ASSISTANT_TEXT,
			prefix + suffix,
			LOADING,
			SEND,
			INPUT,
		);
		expect(await page.$eval(INPUT, element => element.textContent?.trim())).toBe("");

		await page.reload({ waitUntil: "domcontentloaded" });
		await page.waitForFunction(
			(assistant, users, complete, text, input, loading, send) => {
				const { document } = globalThis as BrowserGlobals;
				const replies = Array.from(document.querySelectorAll<BrowserHtmlElement>(assistant));
				const prompts = Array.from(document.querySelectorAll<BrowserHtmlElement>(users));
				return (
					replies.filter(body => body.checkVisibility() && body.innerText.trim() === complete).length === 1 &&
					prompts.filter(row => row.innerText.includes(text)).length === 1 &&
					document.querySelector<BrowserHtmlElement>(input)?.checkVisibility() === true &&
					document.querySelector(loading) === null &&
					document.querySelector(send) !== null
				);
			},
			{},
			ASSISTANT_TEXT,
			USER_ROWS,
			prefix + suffix,
			prompt,
			INPUT,
			LOADING,
			SEND,
		);
		expect(session.messages.filter(message => message.role === "user")).toHaveLength(acceptedUsersBefore + 1);
		expect(await page.$eval(INPUT, element => element.textContent?.trim())).toBe("");
	} finally {
		// Release the provider even if a browser assertion fails while its stream is held open.
		reply.finish();
	}
}

/** Dispatch the same validated V4 service commands consumed by the production browser. */
function nativeCommands(native: NativeBrowserCase) {
	const context = native.contextFor(native.session);
	const services = createAgentServices(context);
	const agent = services.find(service => service.name === "zcode-agent");
	if (!agent) throw new Error("Missing native agent RPC channel");
	const snapshot = (session: AgentSession): Promise<ConversationSnapshot> =>
		nativeChatRuntimeForSession(session).snapshot(context, session.sessionId);
	return {
		snapshot,
		async command<T extends CommandType>(session: AgentSession, type: T, payload: CommandPayloadMap[T]) {
			const before = await snapshot(session);
			return agent.call<CommandAck>(context, "sendConversationCommandV4", [
				{
					workspacePath: context.workspacePath,
					envelope: {
						commandId: crypto.randomUUID(),
						clientId: "core-native-consumer",
						sessionId: session.sessionId,
						baseRevision: before.revision,
						baseLogEpoch: before.logEpoch,
						type,
						payload,
						issuedAt: Date.now(),
					},
				},
			]);
		},
		close() {
			for (const service of services) service.dispose?.();
		},
	};
}

async function waitForQuestion(session: AgentSession): Promise<string> {
	const broker = nativeWebGuiQuestions(session);
	const ready = Promise.withResolvers<string>();
	const check = () => {
		const question = broker.pendingInteractions[0];
		if (question) ready.resolve(question.interactionId);
	};
	const unsubscribe = broker.subscribe(check);
	const timer = setTimeout(
		() => ready.reject(new Error("The native ask tool never reached its browser waiter")),
		20_000,
	);
	try {
		check();
		return await ready.promise;
	} finally {
		clearTimeout(timer);
		unsubscribe();
	}
}

/** Deterministic native SDK + RPC isolation; scripted provider replies are not real-model acceptance. */
export async function parallelInputScenario(native: NativeBrowserCase): Promise<void> {
	const a = native.session;
	const b = await native.createSibling();
	const rpc = nativeCommands(native);
	const aReply = native.setReply("A native execution", " completed", a);
	const initialProvider = a.agent.streamFn;
	const guideReply = native.setReply("A native guide response", " completed", a);
	const guideProvider = a.agent.streamFn;
	const followupReply = native.setReply("A native follow-up response", " completed", a);
	const followupProvider = a.agent.streamFn;
	const bReply = native.setReply("B remains independently active", " completed", b);
	const requests: string[] = [];
	const providers = [initialProvider, guideProvider, followupProvider];
	a.agent.streamFn = (model, context, options) => {
		const provider = providers[requests.length];
		if (!provider) throw new Error("Unexpected native provider request after the queued follow-up");
		requests.push(JSON.stringify(context.messages));
		return provider(model, context, options);
	};
	try {
		await native.page.goto(native.url, { waitUntil: "domcontentloaded" });
		await native.page.waitForSelector(INPUT, { visible: true });
		expect((await rpc.command(a, "sendText", { text: "Start project A work" })).status).toBe("accepted");
		expect((await rpc.command(b, "sendText", { text: "Start project B work" })).status).toBe("accepted");
		await Promise.all([aReply.began, bReply.began]);
		const queued = await rpc.command(a, "sendText", { text: "A_FOLLOW_UP_ONLY" });
		const guided = await rpc.command(a, "sendText", { text: "A_GUIDE_ONLY", requestedDelivery: "guide" });
		expect(queued).toMatchObject({ status: "accepted", result: { type: "inputAccepted", delivery: "queue" } });
		expect(guided).toMatchObject({ status: "accepted", result: { type: "inputAccepted", delivery: "guide" } });
		const waiting = await rpc.snapshot(a);
		expect(waiting.queue.items).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ text: "A_FOLLOW_UP_ONLY", delivery: { requested: "queue", admitted: "queue" } }),
				expect.objectContaining({ text: "A_GUIDE_ONLY", delivery: { requested: "guide", admitted: "guide" } }),
			]),
		);
		expect((await rpc.snapshot(b)).queue.items).toHaveLength(0);
		const queuedInput = waiting.queue.items.find(item => item.text === "A_FOLLOW_UP_ONLY");
		const guidedInput = waiting.queue.items.find(item => item.text === "A_GUIDE_ONLY");
		if (!queuedInput || !guidedInput) throw new Error("Native admission omitted an accepted input");
		const queuedRow = `[data-testid="${testId(TID_V4_QUEUE_ITEM, queuedInput.queueItemId)}"]`;
		const sendQueuedNow = `[data-testid="${testId(TID_V4_QUEUE_ITEM_SEND_NOW, queuedInput.queueItemId)}"]`;
		const pendingGuideRow = `[data-v4-pending-guide-list="true"] [data-testid="${testId(
			TID_V4_ROW,
			String(-(guidedInput.order.admissionSeq + 1)),
		)}"]`;
		// Guides wait at the current model-step boundary; follow-ups belong to the future-turn queue.
		await native.page.waitForFunction(
			(queuedSelector, guideSelector, sendNowSelector) => {
				const { document } = globalThis as BrowserGlobals;
				const queued = document.querySelector<BrowserHtmlElement>(queuedSelector);
				const guide = document.querySelector<BrowserHtmlElement>(guideSelector);
				const sendNow = document.querySelector<BrowserButtonElement>(sendNowSelector);
				const guideBubble = guide?.querySelector('[data-v4-user-input-bubble="true"]');
				const guideStatus = document.querySelector<BrowserHtmlElement>(
					`${guideSelector} [data-v4-user-input-status="true"]`,
				);
				return (
					queued?.checkVisibility() === true &&
					queued.getAttribute("data-delivery-requested") === "queue" &&
					queued.getAttribute("data-delivery-admitted") === "queue" &&
					queued.getAttribute("data-dispatch-state") === "queued" &&
					queued.textContent?.includes("A_FOLLOW_UP_ONLY") &&
					!queued.textContent.includes("A_GUIDE_ONLY") &&
					sendNow?.checkVisibility() === true &&
					!sendNow.disabled &&
					guide?.checkVisibility() === true &&
					guideBubble?.textContent === "A_GUIDE_ONLY" &&
					guideStatus?.checkVisibility() === true &&
					(guideStatus.textContent?.trim().length ?? 0) > 0 &&
					!guide.querySelector("[data-queue-item-id]")
				);
			},
			{},
			queuedRow,
			pendingGuideRow,
			sendQueuedNow,
		);
		expect(requests).toHaveLength(1);
		expect(requests[0]).not.toContain("A_FOLLOW_UP_ONLY");
		expect(requests[0]).not.toContain("A_GUIDE_ONLY");
		aReply.finish();
		await guideReply.began;
		expect(requests).toHaveLength(2);
		expect(requests[1]).toContain("A_GUIDE_ONLY");
		expect(requests[1]).not.toContain("A_FOLLOW_UP_ONLY");
		const guiding = await rpc.snapshot(a);
		expect(guiding.queue.items.map(item => item.queueItemId)).toEqual([queuedInput.queueItemId]);
		const consumedGuide = guiding.rows.window.find(row => row.kind === "userInput" && row.text === "A_GUIDE_ONLY");
		if (!consumedGuide || consumedGuide.kind !== "userInput") throw new Error("Missing consumed native guide row");
		expect(consumedGuide.guided).toBe(true);
		const guideHistoryRow = `[data-testid="${testId(TID_V4_ROW, String(consumedGuide.rowId))}"]`;
		await native.page.waitForFunction(
			(queuedSelector, pendingSelector, historySelector) => {
				const { document } = globalThis as BrowserGlobals;
				const queued = document.querySelector<BrowserHtmlElement>(queuedSelector);
				const history = document.querySelector<BrowserHtmlElement>(historySelector);
				return (
					queued?.checkVisibility() === true &&
					queued.getAttribute("data-dispatch-state") === "queued" &&
					queued.textContent?.includes("A_FOLLOW_UP_ONLY") &&
					document.querySelector(pendingSelector) === null &&
					history?.checkVisibility() === true &&
					history.querySelector('[data-v4-user-input-bubble="true"]')?.textContent === "A_GUIDE_ONLY" &&
					history.querySelector('[data-v4-user-input-status="true"]') === null
				);
			},
			{},
			queuedRow,
			pendingGuideRow,
			guideHistoryRow,
		);
		expect(b.isStreaming).toBe(true);
		expect((await rpc.snapshot(b)).queue.items).toHaveLength(0);
		guideReply.finish();
		await followupReply.began;
		expect(requests).toHaveLength(3);
		const followingUp = await rpc.snapshot(a);
		expect(followingUp.queue.items).toHaveLength(0);
		const consumedFollowup = followingUp.rows.window.find(
			row => row.kind === "userInput" && row.text === "A_FOLLOW_UP_ONLY",
		);
		if (!consumedFollowup || consumedFollowup.kind !== "userInput")
			throw new Error("Missing consumed native follow-up row");
		expect(consumedFollowup.guided).not.toBe(true);
		await native.page.waitForFunction(
			(queuedSelector, pendingSelector, guideSelector, followupSelector) => {
				const { document } = globalThis as BrowserGlobals;
				const guide = document.querySelector<BrowserHtmlElement>(guideSelector);
				const followup = document.querySelector<BrowserHtmlElement>(followupSelector);
				return (
					document.querySelector(queuedSelector) === null &&
					document.querySelector(pendingSelector) === null &&
					guide?.checkVisibility() === true &&
					guide.querySelector('[data-v4-user-input-bubble="true"]')?.textContent === "A_GUIDE_ONLY" &&
					followup?.checkVisibility() === true &&
					followup.querySelector('[data-v4-user-input-bubble="true"]')?.textContent === "A_FOLLOW_UP_ONLY" &&
					followup.querySelector('[data-v4-user-input-status="true"]') === null
				);
			},
			{},
			queuedRow,
			pendingGuideRow,
			guideHistoryRow,
			`[data-testid="${testId(TID_V4_ROW, String(consumedFollowup.rowId))}"]`,
		);
		followupReply.finish();
		await Promise.all([aReply.finished, guideReply.finished, followupReply.finished]);
		// Queue echoes cannot satisfy this: the actual provider must receive both native inputs.
		expect(requests.slice(1).some(request => request.includes("A_FOLLOW_UP_ONLY"))).toBe(true);
		expect(requests.slice(1).some(request => request.includes("A_GUIDE_ONLY"))).toBe(true);
		expect(requests.findIndex(request => request.includes("A_GUIDE_ONLY"))).toBeLessThan(
			requests.findIndex(request => request.includes("A_FOLLOW_UP_ONLY")),
		);
		expect((await rpc.snapshot(a)).queue.items).toHaveLength(0);
		expect(b.isStreaming).toBe(true);
		expect(JSON.stringify(b.messages)).not.toContain("A_FOLLOW_UP_ONLY");
		expect(JSON.stringify(b.messages)).not.toContain("A_GUIDE_ONLY");
		expect(
			(await rpc.command(a, "sendText", { text: "Do not silently start this guide", requestedDelivery: "guide" }))
				.status,
		).toBe("rejected");

		const priorWork = path.join(a.sessionManager.getCwd(), "keep-cancelled-work.txt");
		await fs.writeFile(priorWork, "Previously completed workspace work.");
		const stopped = native.setReply("A cancellation partial", " must not become a complete reply", a);
		expect((await rpc.command(a, "sendText", { text: "A separately cancellable turn" })).status).toBe("accepted");
		await stopped.began;
		expect((await rpc.command(a, "stop", {})).status).toBe("accepted");
		await stopped.finished;
		expect(a.isStreaming).toBe(false);
		expect(b.isStreaming).toBe(true);
		expect((await rpc.snapshot(a)).control.phase).toBe("completedInterrupted");
		expect(await fs.readFile(priorWork, "utf8")).toBe("Previously completed workspace work.");
		bReply.finish();
		await bReply.finished;

		const questionModel = () =>
			createMockModel({
				responses: [
					{
						content: [
							{
								type: "toolCall",
								name: "ask",
								arguments: {
									questions: [
										{
											id: "deployment",
											question: "Choose the native deployment target",
											options: [{ label: "staging" }, { label: "production" }],
										},
									],
								},
							},
						],
					},
					{ content: ["The selected native answer has been consumed."] },
				],
			});
		const askedA = questionModel();
		const askedB = questionModel();
		a.agent.streamFn = askedA.stream;
		b.agent.streamFn = askedB.stream;
		expect((await rpc.command(a, "sendText", { text: "Ask before deploying A" })).status).toBe("accepted");
		expect((await rpc.command(b, "sendText", { text: "Ask before deploying B" })).status).toBe("accepted");
		const [questionA, questionB] = await Promise.all([waitForQuestion(a), waitForQuestion(b)]);
		expect(questionA).not.toBe(questionB);
		expect((await rpc.snapshot(a)).pendingInteractions).toContainEqual(
			expect.objectContaining({ interactionId: questionA }),
		);
		await native.page.waitForFunction(() => {
			const { document } = globalThis as BrowserGlobals;
			return document.querySelector("body")?.textContent?.includes("Choose the native deployment target");
		});
		expect(
			(await rpc.command(b, "resolveInteraction", { interactionId: questionA, answer: { freeText: "staging" } }))
				.status,
		).toBe("rejected");
		expect(nativeWebGuiQuestions(b).pendingInteractions[0]?.interactionId).toBe(questionB);
		expect(
			(await rpc.command(a, "resolveInteraction", { interactionId: questionA, answer: { freeText: "staging" } }))
				.status,
		).toBe("accepted");
		await a.waitForIdle();
		expect(askedA.calls).toHaveLength(2);
		expect(JSON.stringify(askedA.calls[1])).toContain("staging");
		expect(
			a.messages.some(message => message.role === "toolResult" && message.toolName === "ask" && !message.isError),
		).toBe(true);
		expect(
			(await rpc.command(a, "resolveInteraction", { interactionId: questionA, answer: { freeText: "production" } }))
				.status,
		).toBe("rejected");
		expect(nativeWebGuiQuestions(b).pendingInteractions[0]?.interactionId).toBe(questionB);
		expect((await rpc.command(b, "stop", {})).status).toBe("accepted");
		expect(nativeWebGuiQuestions(b).pendingInteractions).toHaveLength(0);
	} finally {
		aReply.finish();
		guideReply.finish();
		followupReply.finish();
		bReply.finish();
		rpc.close();
	}
}

/** Branch and retry execute real native prompts while preserving workspace and original history. */
export async function editRetryScenario(native: NativeBrowserCase): Promise<void> {
	const { page, session } = native;
	const other = await native.createSibling();
	const rpc = nativeCommands(native);
	const originalId = session.sessionId;
	const originalPath = session.sessionManager.getSessionFile();
	if (!originalPath) throw new Error("Branch regression requires a persisted native journal");
	const preservedFile = path.join(session.sessionManager.getCwd(), "keep-existing-work.txt");
	const first = native.setReply("Original native answer", " persisted");
	try {
		expect((await rpc.command(session, "sendText", { text: "Original branchable question" })).status).toBe(
			"accepted",
		);
		await first.began;
		first.finish();
		await first.finished;
		await session.sessionManager.flush();
		await fs.writeFile(preservedFile, "Workspace changes must survive editing a question.");
		const before = await rpc.snapshot(session);
		const user = before.rows.window.find(row => row.kind === "userInput");
		if (!user?.entityId) throw new Error("Native user row has no editable identity");
		expect(
			(
				await rpc.command(other, "editUserQuery", {
					target: { rowId: user.rowId, entityId: user.entityId },
					newText: "Must not branch another owner",
				})
			).status,
		).toBe("rejected");
		expect(other.messages).toHaveLength(0);
		const edited = native.setReply("Edited branch answer", " persisted");
		const branch = await rpc.command(session, "editUserQuery", {
			target: { rowId: user.rowId, entityId: user.entityId },
			newText: "Edited branch question",
		});
		expect(branch).toMatchObject({ status: "accepted", result: { type: "editUserQuery", disposition: "fork" } });
		await edited.began;
		expect(session.sessionId).not.toBe(originalId);
		edited.finish();
		await edited.finished;
		expect(await fs.readFile(preservedFile, "utf8")).toBe("Workspace changes must survive editing a question.");
		const oldMessages = await loadSessionMessagesReadOnly(originalPath);
		expect(JSON.stringify(oldMessages)).toContain("Original branchable question");
		expect(JSON.stringify(oldMessages)).not.toContain("Edited branch question");
		expect(JSON.stringify(session.messages)).toContain("Edited branch question");
		expect(JSON.stringify(session.messages)).not.toContain("Original native answer");

		native.setFailure("Native deterministic request failed");
		expect((await rpc.command(session, "sendText", { text: "Retry this precise native request" })).status).toBe(
			"accepted",
		);
		await session.waitForIdle();
		const failure = await rpc.snapshot(session);
		expect(failure.control.phase).toBe("error");
		const failedRow = failure.rows.window.findLast(row => row.kind === "assistantText" && row.state === "failed");
		if (!failedRow?.entityId) throw new Error("Native failed response has no retryable identity");
		expect(
			(
				await rpc.command(other, "retryTurn", {
					target: { rowId: failedRow.rowId, entityId: failedRow.entityId },
				})
			).status,
		).toBe("rejected");
		expect(other.messages).toHaveLength(0);
		const usersBefore = session.messages.filter(message => message.role === "user").length;
		await page.goto(native.url, { waitUntil: "domcontentloaded" });
		await page.waitForSelector(INPUT, { visible: true });
		const draft = "Unsent browser draft survives the native retry.";
		await page.locator(INPUT).fill(draft);
		const retried = native.setReply("Retried native answer", " persisted");
		expect(
			(await rpc.command(session, "retryTurn", { target: { rowId: failedRow.rowId, entityId: failedRow.entityId } }))
				.status,
		).toBe("accepted");
		await retried.began;
		retried.finish();
		await retried.finished;
		expect(session.messages.filter(message => message.role === "user")).toHaveLength(usersBefore);
		expect(session.messages.findLast(message => message.role === "user")?.content).toEqual([
			{ type: "text", text: "Retry this precise native request" },
		]);
		expect((await rpc.snapshot(session)).control.phase).toBe("completedSuccess");
		expect(
			(await rpc.command(session, "retryTurn", { target: { rowId: failedRow.rowId, entityId: failedRow.entityId } }))
				.status,
		).toBe("rejected");
		// The production renderer must display the native retry result, not only an RPC ACK.
		await page.waitForFunction(
			text => {
				const { document } = globalThis as BrowserGlobals;
				return document.querySelector('[data-testid="v4-timeline"]')?.textContent?.includes(text);
			},
			{},
			"Retried native answer persisted",
		);
		expect(await page.$eval(INPUT, element => element.textContent)).toBe(draft);
	} finally {
		first.finish();
		rpc.close();
	}
}
