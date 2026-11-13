import { expect } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import * as path from "node:path";
import { encodeCustomModelValue } from "../../../../vendor/zcode-frontend/packages/shared/src/custom-model-value";
import {
	testId,
	TID_TASK_ITEM,
	TID_CHAT_MODEL_SELECT_TRIGGER,
	TID_CHAT_MODEL_SELECT_GROUP,
	TID_CHAT_MODEL_SELECT_ITEM,
	TID_TOOL_SUMMARY_TRIGGER,
} from "../../../../vendor/zcode-frontend/packages/shared/src/test-ids";
import { SessionManager } from "../../src/session/session-manager";
import { createAssistantMessage } from "../helpers/agent-session-setup";
import type { BrowserButtonElement, BrowserGlobals } from "./core-browser-dom";
import type { NativeBrowserCase, SeededHistory } from "./core-browser-types";

const EDITOR = '[data-testid="v4-composer-input"]';
const INPUT = `${EDITOR}[contenteditable="true"]`;
const SEND = '[data-testid="v4-composer-send"]';
const MODEL = `[data-testid="${TID_CHAT_MODEL_SELECT_TRIGGER}"]`;
const selected = (model: Model) => ({ provider: model.provider, id: model.id });

/** Port of ZCode I12: native temporary selection and actual requests remain session-owned. */
export async function modelIsolationScenario(native: NativeBrowserCase): Promise<void> {
	const { page, session } = native;
	const ownerId = session.sessionId;
	let current = session;
	const primary = session.model;
	if (!primary) throw new Error("Model isolation fixture requires a native model");
	const secondary = session
		.getAvailableModels()
		.find(model => model.provider === primary.provider && model.id !== primary.id);
	if (!secondary || (secondary.provider === primary.provider && secondary.id === primary.id)) {
		throw new Error(
			"Model isolation fixture needs two authenticated bundled models; no synthetic catalog is substituted",
		);
	}
	const alternate = secondary;
	const defaultBefore = session.settings.getModelRole("default");
	const a = await native.seedHistory("Model isolation A", "MODEL_HISTORY_A", "MODEL_ANSWER_A");
	const crossCwd = path.join(session.sessionManager.getCwd(), "continued-project");
	const b = await native.seedHistory("Model isolation B", "MODEL_HISTORY_B", "MODEL_ANSWER_B", crossCwd);
	for (const history of [a, b]) {
		const manager = await SessionManager.open(history.filePath, undefined, undefined, {
			initialCwd: session.sessionManager.getCwd(),
			suppressBreadcrumb: true,
		});
		try {
			manager.appendModelChange(`${primary.provider}/${primary.id}`, "temporary");
			if (history === b) {
				manager.appendMessage({
					...createAssistantMessage(""),
					api: primary.api,
					provider: primary.provider,
					model: primary.id,
					stopReason: "toolUse",
					content: [{ type: "toolCall", id: "cross-scope-task", name: "task", arguments: {} }],
				});
				manager.appendMessage({
					role: "toolResult",
					toolCallId: "cross-scope-task",
					toolName: "task",
					timestamp: Date.now(),
					content: [{ type: "text", text: "CROSS_SCOPE_NATIVE_OUTPUT" }],
					isError: false,
				});
			}
			await manager.flush();
		} finally {
			await manager.close();
		}
	}
	// A history in another directory can appear in the sidebar only after its project is
	// admitted; the browser proves selection, not that a native admission refreshes the tree.
	await native.resumeHistory(b.sessionId);
	await page.goto(native.url, { waitUntil: "domcontentloaded" });

	const chooseHistory = async (history: SeededHistory) => {
		current = await native.resumeHistory(history.sessionId);
		const row = `[data-testid=${JSON.stringify(testId(TID_TASK_ITEM, history.sessionId))}]`;
		const pane = `[data-session-id=${JSON.stringify(history.sessionId)}]`;
		await page.waitForSelector('[data-testid="project-section"]', { visible: true });
		for (const toggle of await page.$$('[data-testid="virtual-project-toggle"][aria-expanded="false"]')) {
			await toggle.click();
			await toggle.dispose();
		}
		await page.locator(row).click();
		// A row click first changes the selected projection, then resolves admission.
		// Do not treat the resume button's pre-render absence as an editable resident.
		await page.waitForFunction(
			(id, marker, input) => {
				const { document } = globalThis as BrowserGlobals;
				const pane = document.querySelector(`[data-session-id="${id}"]`);
				if (!pane?.querySelector('[data-testid="v4-timeline"]')?.textContent?.includes(marker)) return false;
				const resume = document.querySelector<BrowserButtonElement>(
					`[data-session-id="${id}"] [data-testid="v4-native-history-resume"] button`,
				);
				return Boolean(pane.querySelector(input) || (resume && !resume.disabled));
			},
			{},
			history.sessionId,
			history.userText,
			INPUT,
		);
		const resume = await page.$(`${pane} [data-testid="v4-native-history-resume"] button`);
		if (resume) {
			expect(await page.$(`${pane} ${INPUT}`)).toBeNull();
			await resume.click();
			await resume.dispose();
		}
		await page.waitForSelector(`${pane} ${INPUT}`, { visible: true });
		expect(current.sessionId).toBe(history.sessionId);
		expect(session.sessionId).toBe(ownerId);
		expect(current).not.toBe(session);
	};
	const chooseModel = async (model: Model) => {
		const value = encodeCustomModelValue(model.provider, model.id);
		await page.locator(MODEL).click();
		const group = `[data-testid=${JSON.stringify(testId(TID_CHAT_MODEL_SELECT_GROUP, `native-provider:${model.provider}`))}]`;
		const item = `[data-testid=${JSON.stringify(testId(TID_CHAT_MODEL_SELECT_ITEM, value))}]`;
		await page.waitForSelector(group, { visible: true });
		await page.hover(group);
		await page.locator(item).click();
		await page.waitForFunction(
			(selector, expected) => {
				const { document } = globalThis as BrowserGlobals;
				return document.querySelector(selector)?.getAttribute("data-model-current-value") === expected;
			},
			{},
			MODEL,
			value,
		);
		expect(selected(current.model!)).toEqual(selected(model));
		expect(current.settings.getModelRole("default")).toBe(defaultBefore);
		expect(selected(session.model!)).toEqual(selected(primary));
		expect(session.settings.getModelRole("default")).toBe(defaultBefore);
	};
	let turn = 0;
	const send = async (history: SeededHistory, expected: Model, stage: string) => {
		const marker = `MODEL_ISOLATION_REPLY_${++turn}`;
		const reply = native.setReply(marker, "_DONE", current);
		const provider = current.agent.streamFn;
		const requests: Array<{ provider: string; id: string }> = [];
		current.agent.streamFn = (model, context, options) => {
			requests.push(selected(model));
			return provider(model, context, options);
		};
		try {
			await page.locator(INPUT).fill(`Continue the selected history for ${stage}.`);
			await page.locator(SEND).click();
			await reply.began;
			reply.finish();
			await reply.finished;
			await page.waitForFunction(
				expectedText => {
					const { document } = globalThis as BrowserGlobals;
					return document.querySelector('[data-testid="v4-timeline"]')?.textContent?.includes(expectedText);
				},
				{},
				marker + "_DONE",
			);
			expect(requests).toEqual([selected(expected)]);
			expect(current.sessionId).toBe(history.sessionId);
			expect(selected(current.model!)).toEqual(selected(expected));
			expect(current.settings.getModelRole("default")).toBe(defaultBefore);
			expect(session.sessionId).toBe(ownerId);
			expect(selected(session.model!)).toEqual(selected(primary));
			expect(session.settings.getModelRole("default")).toBe(defaultBefore);
		} finally {
			reply.finish();
		}
	};

	await chooseHistory(a);
	await send(a, primary, "A initial continuation");
	await chooseModel(alternate);
	await send(a, alternate, "A temporary alternate");
	const residentA = current;
	await chooseHistory(b);
	expect(current.sessionManager.getCwd()).toBe(crossCwd);
	// The trimmed WebGUI has no automations page; this history's own transcript is the
	// retained surface that must project its task dispatch.
	const taskRow = `[data-session-id="${b.sessionId}"] [data-testid="${testId(TID_TOOL_SUMMARY_TRIGGER, "cross-scope-task")}"]`;
	await page.waitForSelector(taskRow, { visible: true });
	expect(await page.$eval(taskRow, element => element.textContent ?? "")).toContain("general-purpose");
	await chooseHistory(b);
	await send(b, primary, "B initial continuation");
	await chooseModel(alternate);
	await send(b, alternate, "B temporary alternate");
	expect(selected(residentA.model!)).toEqual(selected(alternate));
	await chooseModel(primary);
	await send(b, primary, "B restored primary");
	expect(selected(residentA.model!)).toEqual(selected(alternate));
	await chooseHistory(a);
	await send(a, alternate, "A restored continuation");
	await chooseHistory(b);
	await send(b, primary, "B restored continuation");
	expect(await page.$eval(EDITOR, element => element.textContent?.trim())).toBe("");
}
