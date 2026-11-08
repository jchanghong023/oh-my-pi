import { expect } from "bun:test";
import type { Page } from "puppeteer-core";
import type { BrowserGlobals, BrowserHtmlElement } from "./core-browser-dom";

const DIGEST = '[data-workflow-run-digest="true"][data-workflow-run-id="core-workflow-run"]';
const CONTENT = '[data-testid="core-workflow-content"]';
const ACTOR = '[data-testid="core-workflow-actor-content"]';

type LayoutElement = BrowserHtmlElement & {
	readonly offsetWidth: number;
	readonly offsetHeight: number;
	readonly offsetLeft: number;
	readonly offsetTop: number;
	readonly offsetParent: LayoutElement | null;
	readonly clientLeft: number;
	readonly clientTop: number;
};

async function clickActor(page: Page, scope: string, name: string): Promise<void> {
	const buttons = await page.$$(`${scope} button.wf-pill`);
	try {
		for (const button of buttons) {
			const label = await button.$eval(".wf-pill-name", node => node.textContent?.trim());
			if (label !== name) continue;
			await button.click();
			return;
		}
		throw new Error(`Workflow actor ${name} has no clickable production pill in ${scope}`);
	} finally {
		await Promise.all(buttons.map(button => button.dispose()));
	}
}

async function expectActor(page: Page, site: string, session: string, own: string, other: string): Promise<void> {
	await page.waitForFunction(
		(selector, expected) => {
			const { document } = globalThis as BrowserGlobals;
			return document.querySelector(selector)?.textContent?.includes(expected);
		},
		{},
		ACTOR,
		own,
	);
	const content = await page.$eval(CONTENT, node => ({
		run: node.getAttribute("data-workflow-run-id"),
		parent: node.getAttribute("data-parent-session-id"),
		type: node.getAttribute("data-pane-type"),
	}));
	expect(content).toEqual({
		run: "core-workflow-run",
		parent: "core-workflow-parent",
		type: "workflow-actor-session",
	});
	const actor = await page.$eval(ACTOR, node => ({
		site: node.getAttribute("data-actor-site-id"),
		ordinal: node.getAttribute("data-actor-ordinal"),
		session: node.getAttribute("data-actor-session-id"),
		gate: node.getAttribute("data-actor-gate"),
		text: node.textContent ?? "",
	}));
	expect(actor.site).toBe(site);
	expect(actor.ordinal).toBe("1");
	expect(actor.session).toBe(session);
	expect(actor.gate).toBe("started");
	expect(actor.text).toContain(own);
	expect(actor.text).not.toContain(other);
}

/** Retained Workflow UI integration, not native Workflow execution or CLI coverage. */
export async function workflowScenario(page: Page): Promise<void> {
	await page.waitForSelector(DIGEST);
	expect(await page.$eval(DIGEST, node => node.getAttribute("data-workflow-run-status"))).toBe("pending");
	expect(
		await page.$$eval(`${DIGEST} [data-testid="workflow-timeline-station"]`, nodes =>
			nodes.map(node => node.getAttribute("data-station-status")),
		),
	).toEqual(["pending", "pending"]);
	expect(await page.$(`${DIGEST} [data-testid="workflow-digest-artifact"]`)).toBeNull();

	// Pending actors do not leak their prepared transcript before the real start-state selector admits them.
	await clickActor(page, DIGEST, "Reviewer");
	expect(
		await page.$eval(ACTOR, node => ({ gate: node.getAttribute("data-actor-gate"), text: node.textContent })),
	).toEqual({ gate: "notStarted", text: "" });
	await page.click('[data-testid="core-workflow-running"]');
	await page.waitForFunction(
		selector => {
			const { document } = globalThis as BrowserGlobals;
			return document.querySelector(selector)?.getAttribute("data-workflow-run-status") === "running";
		},
		{},
		DIGEST,
	);
	expect(
		await page.$$eval(`${DIGEST} [data-testid="workflow-timeline-station"]`, nodes =>
			nodes.map(node => node.getAttribute("data-station-status")),
		),
	).toEqual(["running", "pending"]);
	expect(await page.$eval(ACTOR, node => node.getAttribute("data-actor-gate"))).toBe("notStarted");

	// The retained styles must stop animation without removing the status information or moving layout boxes.
	await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);
	const layoutBefore = await page.$eval(`${DIGEST} [data-testid="workflow-digest-plot"]`, node => {
		// Bounding rectangles include the card's intentional entrance transform.
		// Offset geometry measures layout boxes, which reduced motion must preserve.
		const plot = node as unknown as LayoutElement;
		let left = 0;
		let top = 0;
		for (let ancestor: LayoutElement | null = plot; ancestor; ancestor = ancestor.offsetParent) {
			left += ancestor.offsetLeft;
			top += ancestor.offsetTop;
			left += ancestor.offsetParent?.clientLeft ?? 0;
			top += ancestor.offsetParent?.clientTop ?? 0;
		}
		return { width: plot.offsetWidth, height: plot.offsetHeight, left, top };
	});
	expect(
		await page.$eval(`${DIGEST} .wf-lamp-running`, node => {
			const { getComputedStyle } = globalThis as BrowserGlobals;
			return getComputedStyle(node).animationName;
		}),
	).not.toBe("none");
	await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
	await page.waitForFunction(
		selector => {
			const { document } = globalThis as BrowserGlobals;
			const faces = Array.from(document.querySelectorAll(`${selector} .wf-face`));
			return faces.length > 0 && faces.every(node => node.getAttribute("data-motion") === "idle");
		},
		{},
		DIGEST,
	);
	const reduced = await page.$eval(DIGEST, node => {
		const { getComputedStyle } = globalThis as BrowserGlobals;
		const plot = node.querySelector('[data-testid="workflow-digest-plot"]');
		const lamp = node.querySelector(".wf-lamp-running");
		if (!plot || !lamp) throw new Error("Running Workflow lost its plot or status lamp under reduced motion");
		const layout = plot as LayoutElement;
		let left = 0;
		let top = 0;
		for (let ancestor: LayoutElement | null = layout; ancestor; ancestor = ancestor.offsetParent) {
			left += ancestor.offsetLeft;
			top += ancestor.offsetTop;
			left += ancestor.offsetParent?.clientLeft ?? 0;
			top += ancestor.offsetParent?.clientTop ?? 0;
		}
		return {
			layout: { width: layout.offsetWidth, height: layout.offsetHeight, left, top },
			animation: getComputedStyle(lamp).animationName,
		};
	});
	expect(reduced.layout).toEqual(layoutBefore);
	expect(reduced.animation).toBe("none");
	expect(await page.$eval(DIGEST, node => node.getAttribute("data-workflow-run-status"))).toBe("running");

	await page.click(`${DIGEST} [data-testid="workflow-card-open-details"]`);
	await page.waitForSelector('[data-testid="workflow-run-phases"]');
	expect(
		await page.$eval(CONTENT, node => ({
			run: node.getAttribute("data-workflow-run-id"),
			parent: node.getAttribute("data-parent-session-id"),
			text: node.textContent ?? "",
		})),
	).toMatchObject({ run: "core-workflow-run", parent: "core-workflow-parent" });
	const phases = await page.$eval('[data-testid="workflow-run-phases"]', node => node.textContent ?? "");
	expect(phases).toContain("Planning");
	expect(phases).toContain("Review");
	await clickActor(page, '[data-testid="workflow-run-phases"]', "Planner");
	await expectActor(
		page,
		"actor#planner",
		"core-workflow-planner",
		"Planner private evidence",
		"Reviewer private evidence",
	);

	await page.click('[data-testid="core-workflow-completed"]');
	await page.waitForFunction(
		selector => {
			const { document } = globalThis as BrowserGlobals;
			return document.querySelector(selector)?.getAttribute("data-workflow-run-status") === "completed";
		},
		{},
		DIGEST,
	);
	expect(
		await page.$$eval(`${DIGEST} [data-testid="workflow-timeline-station"]`, nodes =>
			nodes.map(node => node.getAttribute("data-station-status")),
		),
	).toEqual(["done", "done"]);
	await clickActor(page, DIGEST, "Reviewer");
	await expectActor(
		page,
		"actor#reviewer",
		"core-workflow-reviewer",
		"Reviewer private evidence",
		"Planner private evidence",
	);
	await clickActor(page, DIGEST, "Planner");
	await expectActor(
		page,
		"actor#planner",
		"core-workflow-planner",
		"Planner private evidence",
		"Reviewer private evidence",
	);

	await page.click(`${DIGEST} [data-testid="workflow-digest-artifact"][data-artifact-id="release-evidence"]`);
	await page.waitForFunction(() => {
		const { document } = globalThis as BrowserGlobals;
		return document.querySelector('[data-artifact-body="markdown"] h1')?.textContent === "Release evidence";
	});
	const artifact = await page.$eval(CONTENT, node => ({
		run: node.getAttribute("data-workflow-run-id"),
		parent: node.getAttribute("data-parent-session-id"),
		type: node.getAttribute("data-pane-type"),
		id: node.querySelector('[data-testid="core-workflow-artifact-content"]')?.getAttribute("data-artifact-id"),
		heading: node.querySelector('[data-artifact-body="markdown"] h1')?.textContent,
		strong: node.querySelector('[data-artifact-body="markdown"] strong')?.textContent,
		text: node.textContent ?? "",
	}));
	expect(artifact).toMatchObject({
		run: "core-workflow-run",
		parent: "core-workflow-parent",
		type: "workflow-artifact",
		id: "release-evidence",
		heading: "Release evidence",
		strong: "Reviewer",
	});
	expect(artifact.text).toContain("Verified release notes");
	expect(artifact.text).not.toContain("Planner private evidence");
	expect(artifact.text).not.toContain("Reviewer private evidence");
	expect(await page.$(ACTOR)).toBeNull();
}
