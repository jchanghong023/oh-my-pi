import { afterAll, beforeAll, describe, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Page } from "puppeteer-core";
import { createCoreBrowserFixture } from "./core-browser-fixture";
import type { CoreBrowserFixture } from "./core-browser-types";
import { historyScenario } from "./core-history-scenario";
import { inputScenario } from "./core-input-scenario";
import { subagentScenario } from "./core-subagent-scenario";
import { workflowScenario } from "./core-workflow-scenario";
import { modelIsolationScenario } from "./core-model-isolation-scenario";
import { parallelSubagentScenario } from "./core-parallel-subagent-scenario";
import { settingsScenario } from "./core-settings-scenario";

const diagnosticsPath = path.join(os.tmpdir(), `omp-core-browser-failures-${process.pid}.jsonl`);

async function diagnoseFailure(page: Page, run: () => Promise<void>): Promise<void> {
	try {
		await run();
	} catch (error) {
		const details = await page
			.evaluate(() => {
				const browser = globalThis as unknown as {
					location: { href: string };
					document: {
						body: { innerText: string };
						querySelectorAll(selector: string): ArrayLike<{
							getAttribute(name: string): string | null;
							textContent: string | null;
						}>;
					};
				};
				return {
					url: browser.location.href,
					text: browser.document.body.innerText.slice(-8000),
					transcripts: Array.from(browser.document.querySelectorAll('[data-testid="core-transcript"]')).map(
						element => ({
							sessionId: element.getAttribute("data-session-id"),
							seq: element.getAttribute("data-projection-seq"),
							text: element.textContent,
						}),
					),
				};
			})
			.catch(diagnosticError => ({ diagnosticError: String(diagnosticError) }));
		await fs.appendFile(diagnosticsPath, `${JSON.stringify({ at: new Date().toISOString(), ...details })}\n`);
		process.stderr.write(`[core-browser failure] ${diagnosticsPath} ${JSON.stringify(details)}\n`);
		throw error;
	}
}

// A single Bun runner shares one frontend build, loopback server and Chromium.
// Native cases exercise SDK + RPC; component-only child/Workflow cases cover retained presentation.
describe.serial("retained WebGUI core browser integration", () => {
	let fixture: CoreBrowserFixture;
	beforeAll(async () => {
		fixture = await createCoreBrowserFixture();
	}, 120_000);
	afterAll(async () => {
		await fixture?.close();
	}, 30_000);

	test("native chat history switches, reloads and isolates failed history reads", async () => {
		const native = await fixture.nativeCase();
		try {
			await diagnoseFailure(native.page, () => historyScenario(native));
		} finally {
			await native.close();
		}
	}, 60_000);

	test("native text input streams and retains drafts rejected before admission", async () => {
		const native = await fixture.nativeCase();
		try {
			await diagnoseFailure(native.page, () => inputScenario(native));
		} finally {
			await native.close();
		}
	}, 60_000);

	test("settings omit MCP configuration while the native Skill catalog remains readable", async () => {
		const native = await fixture.nativeCase({ withSkill: true });
		try {
			await diagnoseFailure(native.page, () => settingsScenario(native));
		} finally {
			await native.close();
		}
	}, 30_000);

	test("subagent presentation preserves identity, deduplicates tabs and isolates messages", async () => {
		const page = await fixture.componentPage("subagent");
		try {
			await diagnoseFailure(page, () => subagentScenario(page));
		} finally {
			await page.close();
		}
	}, 30_000);

	test("Workflow presentation navigates status, Actors and artifacts with reduced motion", async () => {
		const page = await fixture.componentPage("workflow");
		try {
			await diagnoseFailure(page, () => workflowScenario(page));
		} finally {
			await page.close();
		}
	}, 30_000);

	test("migrated additional: temporary model selection stays isolated across native sessions", async () => {
		const native = await fixture.nativeCase();
		try {
			await diagnoseFailure(native.page, () => modelIsolationScenario(native));
		} finally {
			await native.close();
		}
	}, 60_000);

	test("migrated additional: parallel native children remain complete during delayed journal visibility and task switching", async () => {
		const native = await fixture.nativeCase();
		try {
			await diagnoseFailure(native.page, () => parallelSubagentScenario(native));
		} finally {
			await native.close();
		}
	}, 60_000);
});
