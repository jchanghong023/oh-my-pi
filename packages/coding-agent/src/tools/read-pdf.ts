import { pathToFileURL } from "node:url";
import { untilAborted } from "@oh-my-pi/pi-utils";
import type { ToolSession } from "../sdk";
import type { BrowserHandle } from "./browser/registry";
import type { ScreenshotResult } from "./browser/tab-protocol";
import { ToolAbortError } from "./tool-errors";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

const PDF_IMAGE_MEMBER_RE = /^(.*\.pdf):(.*)$/i;
const PDF_PAGE_MEMBER_RE = /^(?:p|page[-_]?)(\d+)(?:[-_].*)?\.png$/i;
const PDF_RENDER_TIMEOUT_MS = 30_000;
// The viewer fits the page into the tab (`view=Fit`). A square viewport gives
// portrait and landscape pages the same long side; in the default landscape
// tab (returned at 1024x576) a letter page came back 441x568, too small to
// read 8 pt print.
const PDF_VIEWPORT = { width: 874, height: 874, deviceScaleFactor: 1 };

// The PDF plugin paints out of process after navigation. Chrome exposes its
// viewer as a frame; Edge exposes a separate webview target, while its
// about:blank plugin frame does not answer JavaScript evaluation.
// Capture the viewport: full-page capture often omits the plugin's frame.
const PDF_SCREENSHOT_CODE = `
let viewerFrame;
let edgeSession;
const pageSession = await page.createCDPSession();
try {
	const requestedPage = Number(new URL(page.url()).hash.match(/(?:^|[&#])page=(\\d+)/)?.[1] ?? 1);
	const pageId = (await pageSession.send("Target.getTargetInfo")).targetInfo.targetId;
	await wait(async () => {
		for (const frame of page.frames()) {
			if (frame !== page.mainFrame() && !frame.url().startsWith("chrome-extension://")) continue;
			try {
				const loaded = await frame.evaluate(() => {
					const viewer = document.querySelector("pdf-viewer");
					const toolbar = viewer?.shadowRoot?.querySelector("viewer-toolbar");
					const pageLength = toolbar
						?.shadowRoot?.querySelector("viewer-page-selector")
						?.shadowRoot?.querySelector("#pagelength")
						?.textContent;
					if (Number(pageLength) > 0 && !toolbar?.hasAttribute("loading_")) return true;
					const plugin = document.querySelector('embed[type="application/x-google-chrome-pdf"]');
					const sizer = document.querySelector("#sizer");
					return plugin !== null && sizer !== null && sizer.clientWidth > 0 && sizer.clientHeight > 0;
				});
				if (loaded) {
					viewerFrame = frame;
					return true;
				}
			} catch {}
		}
		if (!edgeSession) {
			const { targetInfos } = await pageSession.send("Target.getTargets");
			const info = targetInfos.find(target =>
				target.parentId === pageId && target.type === "webview" &&
				target.url.startsWith("chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/edge_pdf/"),
			);
			const target = info && browser.targets().find(candidate => candidate._targetId === info.targetId);
			if (target) edgeSession = await target.createCDPSession();
		}
		if (!edgeSession) return false;
		const { result } = await edgeSession.send("Runtime.evaluate", {
			expression: \`(() => {
				const plugin = document.querySelector('embed[type="application/x-google-chrome-pdf"]');
				const selector = document.querySelector("#pageselector");
				const count = document.querySelector("#pagelength")?.textContent?.match(/\\\\d+/);
				return !!plugin && !!selector && !selector.disabled && Number(count?.[0]) > 0 &&
					Number(selector.value) === \${requestedPage};
			})()\`,
			returnByValue: true,
		});
		return result.value === true;
	});
	if (edgeSession) {
		// Edge's #view=Fit can leave the plugin at its previous zoom even
		// though the toolbar reports page fit. Toggle through width first,
		// then explicitly select page fit using the viewer's own control.
		await edgeSession.send("Runtime.evaluate", {
			expression: \`(() => {
				const button = document.querySelector("#pagefit");
				if (button?.querySelector("#fit-to-width-icon")) button.click();
			})()\`,
			returnByValue: true,
		});
		await wait(async () => {
			const { result } = await edgeSession.send("Runtime.evaluate", {
				expression: '!!document.querySelector("#pagefit #fit-to-page-icon")',
				returnByValue: true,
			});
			return result.value === true;
		});
		await edgeSession.send("Runtime.evaluate", {
			expression: 'document.querySelector("#pagefit").click()',
			returnByValue: true,
		});
		await wait(async () => {
			const { result } = await edgeSession.send("Runtime.evaluate", {
				expression: '!!document.querySelector("#pagefit #fit-to-width-icon")',
				returnByValue: true,
			});
			return result.value === true;
		});
	}
	// Force an initial compositor capture, then let the actual viewer advance
	// several frames before taking the returned screenshot.
	await page.screenshot({ type: "png" });
	if (viewerFrame) {
		await viewerFrame.evaluate(() => new Promise(resolve =>
			requestAnimationFrame(() => requestAnimationFrame(() =>
				requestAnimationFrame(() => requestAnimationFrame(resolve)),
			)),
		));
	} else {
		await edgeSession.send("Runtime.evaluate", {
			expression: "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))))",
			awaitPromise: true,
		});
	}
	return await tab.screenshot({ silent: true });
} finally {
	await edgeSession?.detach();
	await pageSession.detach();
}
`;

/** A legacy PDF image-member path interpreted as a page screenshot request. */
export interface PdfImageReadTarget {
	/** PDF path before the member delimiter. */
	pdfPath: string;
	/** Original member text after the delimiter. */
	member: string;
	/** One-indexed page inferred from names such as `p2-img0.png`; defaults to page 1. */
	page: number;
}

/** A page read's physical PDF input, separate from its public read identity. */
export interface PdfPageReadOptions {
	readPath: string;
	absolutePdfPath: string;
	page: number;
	pdfFileSize: number;
	question?: string;
	suffixResolution?: { from: string; to: string };
	signal?: AbortSignal;
}

/** Parse a former PDF image-member path as a Chromium page screenshot request. */
export function splitPdfImageReadPath(readPath: string): PdfImageReadTarget | null {
	const match = PDF_IMAGE_MEMBER_RE.exec(readPath);
	const pdfPath = match?.[1];
	const member = match?.[2];
	if (!pdfPath || member === undefined) return null;
	const pageText = PDF_PAGE_MEMBER_RE.exec(member)?.[1];
	const parsedPage = pageText === undefined ? 1 : Number(pageText);
	const page = Number.isSafeInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
	return { pdfPath, member, page };
}

/** Render one PDF page through the browser capability's shared headless Chromium. */
export async function renderPdfPageScreenshot(
	session: ToolSession,
	absolutePdfPath: string,
	page: number,
	signal?: AbortSignal,
): Promise<ScreenshotResult> {
	const [{ acquireBrowser, holdBrowser, releaseBrowser }, { acquireTab, releaseTab, runInTab }] = await Promise.all([
		import("./browser/registry"),
		import("./browser/tab-supervisor"),
	]);
	// Capture the render deadline start so `acquireTab` counts its
	// worker-init time against this same budget (browser acquisition above
	// already consumed part of it) instead of restarting the clock.
	const deadlineStart = performance.now();
	const timeoutSignal = AbortSignal.timeout(PDF_RENDER_TIMEOUT_MS);
	const renderSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	const tabName = `read-pdf-${Bun.randomUUIDv7()}`;
	const url = pathToFileURL(absolutePdfPath);
	url.hash = `page=${page}&toolbar=0&navpanes=0&view=Fit`;

	let browserLease = false;
	let browser: BrowserHandle | undefined;
	try {
		const acquiredBrowser = await untilAborted(renderSignal, () =>
			acquireBrowser({ kind: "headless", headless: true }, { cwd: session.cwd, signal: renderSignal }),
		);
		browser = acquiredBrowser;
		holdBrowser(acquiredBrowser);
		browserLease = true;
		await untilAborted(renderSignal, () =>
			acquireTab(tabName, acquiredBrowser, {
				url: url.href,
				viewport: PDF_VIEWPORT,
				waitUntil: "load",
				timeoutMs: PDF_RENDER_TIMEOUT_MS,
				deadlineStartMs: deadlineStart,
				signal: renderSignal,
				ownerSessionId: session.getSessionId?.() ?? undefined,
			}),
		);
		await releaseBrowser(acquiredBrowser, { kill: false });
		browserLease = false;

		const result = await runInTab(tabName, {
			code: PDF_SCREENSHOT_CODE,
			timeoutMs: PDF_RENDER_TIMEOUT_MS,
			signal: renderSignal,
			session,
		});
		const screenshot = result.screenshots.at(-1);
		if (!screenshot) throw new ToolError(`Chromium did not capture PDF page ${page}.`);
		return screenshot;
	} catch (error) {
		if (signal?.aborted) throw new ToolAbortError();
		if (timeoutSignal.aborted) {
			throw new ToolError(`Timed out rendering PDF page ${page} in Chromium.`);
		}
		throw error;
	} finally {
		try {
			// A timed-out navigation keeps the published tab, so release it by name.
			await releaseTab(tabName, { kill: false });
		} finally {
			if (browserLease && browser) await releaseBrowser(browser, { kill: false });
		}
	}
}
