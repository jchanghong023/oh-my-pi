import { expect } from "bun:test";
import type { BrowserGlobals } from "./core-browser-dom";
import type { NativeBrowserCase } from "./core-browser-types";

/** Removing MCP configuration must leave the real native Skill catalog usable. */
export async function settingsScenario(native: NativeBrowserCase): Promise<void> {
	const { page } = native;
	await page.goto(native.url, { waitUntil: "domcontentloaded" });
	await page.locator('[data-testid="task-settings-button"]').click();
	await page.waitForSelector('[data-settings-section-nav="skill"]', { visible: true });
	expect(await page.$('[data-settings-section-nav="mcp"]')).toBeNull();
	await page.locator('[data-settings-section-nav="skill"]').click();
	await page.waitForFunction(() => {
		const { document } = globalThis as BrowserGlobals;
		return document.querySelector('[data-active-section="skill"]')?.textContent?.includes("webgui-retained-skill");
	});
	expect(await page.$('[data-active-section="mcp"]')).toBeNull();
}
