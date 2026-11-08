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
} from "../../../../vendor/zcode-frontend/packages/shared/src/test-ids";
import { SessionManager } from "../../src/session/session-manager";
import { getTestModel } from "../helpers/model-fixtures";
import { createAssistantMessage } from "../helpers/agent-session-setup";
import type { BrowserGlobals } from "./core-browser-dom";
import type { NativeBrowserCase, SeededHistory } from "./core-browser-types";

const EDITOR = '[data-testid="v4-composer-input"]';
const INPUT = `${EDITOR}[contenteditable="true"]`;
const SEND = '[data-testid="v4-composer-send"]';
const MODEL = `[data-testid="${TID_CHAT_MODEL_SELECT_TRIGGER}"]`;
const selected = (model: Model) => ({ provider: model.provider, id: model.id });

/** Port of ZCode I12: native temporary selection and actual requests remain session-owned. */
export async function modelIsolationScenario(native: NativeBrowserCase): Promise<void> {
	const { page, session } = native;
	const primary = session.model;
	if (!primary) throw new Error("Model isolation fixture requires a native model");
	let secondary = session
		.getAvailableModels()
		.find(model => model.provider === primary.provider && model.id !== primary.id);
	if (!secondary) {
		const candidate = getTestModel("anthropic");
		session.modelRegistry.authStorage.keys.setRuntime(candidate.provider, "isolated-browser-model-key");
		secondary = session
			.getAvailableModels()
			.find(model => model.provider === candidate.provider && model.id === candidate.id);
	}
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
	await page.goto(native.url, { waitUntil: "domcontentloaded" });

	const chooseHistory = async (history: SeededHistory) => {
		const previousId = session.sessionId;
		const row = `[data-testid=${JSON.stringify(testId(TID_TASK_ITEM, history.sessionId))}]`;
		await page.waitForSelector('[data-testid="project-section"]', { visible: true });
		for (const toggle of await page.$$('[data-testid="virtual-project-toggle"][aria-expanded="false"]')) {
			await toggle.click();
			await toggle.dispose();
		}
		await page.locator(row).click();
		if (previousId !== history.sessionId) {
			await page.waitForSelector('[data-testid="v4-native-history-resume"] button', { visible: true });
			expect(session.sessionId).toBe(previousId);
			expect(await page.$(INPUT)).toBeNull();
			await page.locator('[data-testid="v4-native-history-resume"] button').click();
		}
		await page.waitForSelector(INPUT, { visible: true });
		expect(session.sessionId).toBe(history.sessionId);
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
		expect(selected(session.model!)).toEqual(selected(model));
		expect(session.settings.getModelRole("default")).toBe(defaultBefore);
	};
	let turn = 0;
	const send = async (history: SeededHistory, expected: Model, stage: string) => {
		const marker = `MODEL_ISOLATION_REPLY_${++turn}`;
		const reply = native.setReply(marker, "_DONE");
		const provider = session.agent.streamFn;
		const requests: Array<{ provider: string; id: string }> = [];
		session.agent.streamFn = (model, context, options) => {
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
			expect(session.sessionId).toBe(history.sessionId);
			expect(selected(session.model!)).toEqual(selected(expected));
			expect(session.settings.getModelRole("default")).toBe(defaultBefore);
		} finally {
			reply.finish();
		}
	};

	await chooseHistory(a);
	await send(a, primary, "A initial continuation");
	await chooseModel(alternate);
	await send(a, alternate, "A temporary alternate");
	await chooseHistory(b);
	expect(session.sessionManager.getCwd()).toBe(crossCwd);
	await page.locator('[data-testid="automations-open"]').click();
	await page.locator('[data-testid="automations-page-tab-workflow"]').click();
	await page.waitForFunction(() => {
		const { document } = globalThis as BrowserGlobals;
		return document.querySelector("[data-automations-content]")?.textContent?.includes("cross-scope-task");
	});
	const outputButtons = await page.$$("[data-automations-content] button");
	try {
		let opened = false;
		for (const button of outputButtons) {
			if ((await button.evaluate(node => node.textContent?.trim())) !== "task tool result") continue;
			await button.click();
			opened = true;
			break;
		}
		if (!opened) throw new Error("Cross-directory native task result has no output button");
	} finally {
		await Promise.all(outputButtons.map(button => button.dispose()));
	}
	await page.waitForFunction(() => {
		const { document } = globalThis as BrowserGlobals;
		return document.querySelector("[data-automations-content]")?.textContent?.includes("CROSS_SCOPE_NATIVE_OUTPUT");
	});
	await chooseHistory(b);
	await send(b, primary, "B initial continuation");
	await chooseModel(primary);
	await chooseHistory(a);
	await send(a, alternate, "A restored continuation");
	await chooseHistory(b);
	await send(b, primary, "B restored continuation");
	expect(await page.$eval(EDITOR, element => element.textContent?.trim())).toBe("");
}
