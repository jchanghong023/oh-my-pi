import { expect } from "bun:test";
import type { Page } from "puppeteer-core";
import type { BrowserGlobals } from "./core-browser-dom";

interface TranscriptState {
	sessionId: string | null;
	seq: number;
	assistantText: string;
}

async function visibleChild(page: Page, sessionId: string, expectedText: string): Promise<TranscriptState> {
	await page.waitForFunction(
		(id, text) => {
			const { document } = globalThis as BrowserGlobals;
			const panel = document.querySelector('[role="tabpanel"][data-state="active"]');
			const transcript = panel?.querySelector('[data-testid="core-transcript"]');
			const assistant = Array.from(transcript?.querySelectorAll("[data-row-id].group\\/assistant-row") ?? [])
				.map(row => row.textContent ?? "")
				.join("\n");
			return transcript?.dataset.sessionId === id && assistant.includes(text);
		},
		{},
		sessionId,
		expectedText,
	);
	return page.evaluate(() => {
		const { document } = globalThis as BrowserGlobals;
		const transcript = document.querySelector(
			'[role="tabpanel"][data-state="active"] [data-testid="core-transcript"]',
		);
		return {
			sessionId: transcript?.dataset.sessionId ?? null,
			seq: Number(transcript?.dataset.projectionSeq ?? 0),
			assistantText: Array.from(transcript?.querySelectorAll("[data-row-id].group\\/assistant-row") ?? [])
				.map(row => row.textContent ?? "")
				.join("\n"),
		};
	});
}

async function assertParentIdentity(page: Page): Promise<void> {
	const parent = await page.$eval('[data-testid="core-parent-history"]', element => ({
		sessionId: element.getAttribute("data-session-id"),
		transcriptSessionId: element.querySelector('[data-testid="core-transcript"]')?.getAttribute("data-session-id"),
		assistantText: Array.from(element.querySelectorAll("[data-row-id].group\\/assistant-row"))
			.map(row => row.textContent ?? "")
			.join("\n"),
	}));
	expect(parent.sessionId).toBe("core-parent-history");
	expect(parent.transcriptSessionId).toBe("core-parent-history");
	expect(parent.assistantText).toContain("PARENT_HISTORY_ASSISTANT");
	expect(parent.assistantText).not.toContain("CHILD_A_ASSISTANT");
	expect(parent.assistantText).not.toContain("CHILD_B_ASSISTANT");
}

/** Retained-component UI/presentation integration; does not exercise native child spawning. */
export async function subagentScenario(page: Page): Promise<void> {
	await page.waitForSelector('[data-testid="core-subagent-case"][data-ready="true"]');
	await assertParentIdentity(page);
	const openA = '[data-testid="v4-subagent-open-side-pane-core-child-a"]';
	const openB = '[data-testid="v4-subagent-open-side-pane-core-child-b"]';
	await page.click(openA);
	const firstA = await visibleChild(page, "core-child-a", "CHILD_A_ASSISTANT");
	expect(firstA.assistantText).not.toContain("CHILD_B_ASSISTANT");
	expect(firstA.assistantText).not.toContain("PARENT_HISTORY_ASSISTANT");
	const tabA = await page.$eval('[data-side-pane-tab-id][data-state="active"]', element =>
		element.getAttribute("data-side-pane-tab-id"),
	);
	expect(tabA).toBeTruthy();
	await page.click(openA);
	await visibleChild(page, "core-child-a", "CHILD_A_ASSISTANT");
	expect(await page.$$eval("[data-side-pane-tab-id]", elements => elements.length)).toBe(1);

	await page.click(openB);
	const firstB = await visibleChild(page, "core-child-b", "CHILD_B_ASSISTANT");
	expect(firstB.assistantText).not.toContain("CHILD_A_ASSISTANT");
	expect(firstB.assistantText).not.toContain("PARENT_HISTORY_ASSISTANT");
	const tabB = await page.$eval('[data-side-pane-tab-id][data-state="active"]', element =>
		element.getAttribute("data-side-pane-tab-id"),
	);
	expect(tabB).not.toBe(tabA);
	expect(await page.$$eval("[data-side-pane-tab-id]", elements => elements.length)).toBe(2);
	await assertParentIdentity(page);

	await page.click('[data-testid="core-update-hidden-a"]');
	const unchangedB = await visibleChild(page, "core-child-b", "CHILD_B_ASSISTANT");
	expect(unchangedB.seq).toBe(firstB.seq);
	expect(unchangedB.assistantText).not.toContain("CHILD_A_ASSISTANT_UPDATED");
	await page.click(`[data-side-pane-tab-id=${JSON.stringify(tabA)}]`);
	const updatedA = await visibleChild(page, "core-child-a", "CHILD_A_ASSISTANT_UPDATED");
	expect(updatedA.seq).toBeGreaterThan(firstA.seq);
	expect(updatedA.assistantText).not.toContain("CHILD_B_ASSISTANT");
	await page.click(`[data-side-pane-tab-id=${JSON.stringify(tabB)}]`);
	const returnedB = await visibleChild(page, "core-child-b", "CHILD_B_ASSISTANT");
	expect(returnedB.assistantText).toBe(firstB.assistantText);
	expect(returnedB.assistantText).not.toContain("CHILD_A_ASSISTANT");
	await page.click(openA);
	await visibleChild(page, "core-child-a", "CHILD_A_ASSISTANT_UPDATED");
	expect(await page.$$eval("[data-side-pane-tab-id]", elements => elements.length)).toBe(2);
	await assertParentIdentity(page);
}
