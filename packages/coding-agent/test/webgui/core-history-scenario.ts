import { expect } from "bun:test";
import * as fs from "node:fs/promises";
import {
	TID_TASK_ITEM,
	TID_V4_RETRY_SUBSCRIBE,
	TID_V4_TIMELINE,
	testId,
} from "../../../../vendor/zcode-frontend/packages/shared/src/test-ids";
import type { BrowserGlobals } from "./core-browser-dom";
import type { NativeBrowserCase, SeededHistory } from "./core-browser-types";

/** Real browser/native-RPC history reads; no historical session is resumed for execution. */
export async function historyScenario(native: NativeBrowserCase): Promise<void> {
	const { page, session } = native;
	const ownerId = session.sessionId;
	const ownerCwd = session.sessionManager.getCwd();
	const a = await native.seedHistory("Core history A", "CORE_HISTORY_A_QUESTION", "CORE_HISTORY_A_ANSWER");
	const b = await native.seedHistory("Core history B", "CORE_HISTORY_B_QUESTION", "CORE_HISTORY_B_ANSWER");
	const originalA = await fs.readFile(a.filePath);
	const originalB = await fs.readFile(b.filePath);
	const home = '[data-mobile-page="home"]';
	const chat = '[data-mobile-page="chat"]';
	const timeline = `${chat} [data-testid="${TID_V4_TIMELINE}"]`;
	const row = (history: SeededHistory) => `${home} [data-testid="${testId(TID_TASK_ITEM, history.sessionId)}"]`;
	const assertOwner = () => {
		expect(session.sessionId).toBe(ownerId);
		expect(session.sessionManager.getCwd()).toBe(ownerCwd);
	};
	const returnToList = async () => {
		await page.waitForSelector(`${home}, ${chat}`, { visible: true });
		if (await page.$(chat)) {
			await page.locator(`${chat} button[aria-label="返回任务首页"]`).click();
		}
		await page.waitForSelector(home, { visible: true });
		// Expand retained project groups using their public controls, not their store state.
		await page.waitForSelector(`${row(a)}, ${home} [data-testid="virtual-project-toggle"]`, { visible: true });
		const collapsed = await page.$$(`${home} [data-testid="virtual-project-toggle"][aria-expanded="false"]`);
		for (const toggle of collapsed) {
			await toggle.click();
			await toggle.dispose();
		}
		await page.waitForSelector(row(a), { visible: true });
		await page.waitForSelector(row(b), { visible: true });
		expect(await page.$eval(row(a), element => element.textContent)).toContain(a.title);
		expect(await page.$eval(row(b), element => element.textContent)).toContain(b.title);
		assertOwner();
	};
	const assertHistory = async (selected: SeededHistory, absent: SeededHistory) => {
		await page.waitForFunction(
			(selector, userText, assistantText) => {
				const { document } = globalThis as BrowserGlobals;
				const text = document.querySelector(selector)?.textContent ?? "";
				return text.includes(userText) && text.includes(assistantText);
			},
			{},
			timeline,
			selected.userText,
			selected.assistantText,
		);
		const body = await page.$eval(chat, element => element.textContent ?? "");
		expect(body).toContain(selected.userText);
		expect(body).toContain(selected.assistantText);
		expect(body).not.toContain(absent.userText);
		expect(body).not.toContain(absent.assistantText);
		assertOwner();
	};

	await page.setViewport({ width: 390, height: 844 });
	await page.goto(native.url, { waitUntil: "domcontentloaded" });
	await returnToList();
	await page.locator(row(a)).click();
	await assertHistory(a, b);
	await returnToList();

	// The index is already visible, but B has never been subscribed. Move only its
	// private fixture journal so the real native reader fails at its filesystem boundary.
	const unavailablePath = `${b.filePath}.core-history-unavailable`;
	await fs.rename(b.filePath, unavailablePath);
	try {
		await page.locator(row(b)).click();
		await page.waitForSelector(`${chat} [data-testid="${TID_V4_RETRY_SUBSCRIBE}"]`, { visible: true });
		const failure = await page.$eval(chat, element => element.textContent ?? "");
		expect(failure).toMatch(/ENOENT|no such file|not found/i);
		expect(failure).not.toContain("[object Object]");
		expect(failure).not.toContain(a.userText);
		expect(failure).not.toContain(a.assistantText);
		expect(failure).not.toContain(b.assistantText);
		assertOwner();
	} finally {
		await fs.rename(unavailablePath, b.filePath);
	}
	await page.locator(`${chat} [data-testid="${TID_V4_RETRY_SUBSCRIBE}"]`).click();
	await assertHistory(b, a);
	await returnToList();
	await page.locator(row(a)).click();
	await assertHistory(a, b);
	await returnToList();

	// Reload the real app, then select both persisted histories again from its list.
	await page.reload({ waitUntil: "domcontentloaded" });
	await returnToList();
	await page.locator(row(b)).click();
	await assertHistory(b, a);
	await returnToList();
	await page.locator(row(a)).click();
	await assertHistory(a, b);
	expect(await fs.readFile(a.filePath)).toEqual(originalA);
	expect(await fs.readFile(b.filePath)).toEqual(originalB);
	assertOwner();
}
