import type { SlashCommandRuntime } from "../../slash-commands/types";
import { crawlBrowserRequest, writeCrawlMarkdown } from "./crawl-access";

export interface CrawlOptions {
	url: string;
	recursive: boolean;
	output: string;
	concurrency: number;
	maxPages?: number;
	maxDepth?: number;
}

interface PageInfo {
	url: string;
	contentType: string;
	login: boolean;
	links: string[];
}

interface NavigationResult {
	url: string;
	status: number | null;
	contentType: string;
	attachment: boolean;
	info?: PageInfo;
	markdown?: string;
	extractError?: string;
	endUrl?: string;
}

interface CrawlPage {
	url: string;
	depth: number;
}

function normalizedUrl(value: string, base?: string): string | undefined {
	try {
		const url = new URL(value, base);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		url.hash = "";
		return url.href;
	} catch {
		return undefined;
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function basename(url: string): string {
	const parsed = new URL(url);
	const part = parsed.pathname.split("/").filter(Boolean).at(-1) || parsed.hostname;
	let decoded = part;
	try {
		decoded = decodeURIComponent(part);
	} catch {
		// Retain the encoded path if it is not valid UTF-8.
	}
	return `${
		decoded
			.replace(/[^\p{L}\p{N}._-]+/gu, "-")
			.replace(/^\.+|\.+$/g, "")
			.slice(0, 80) || "page"
	}.md`;
}

/** Restrict main-frame redirects and reject document downloads before Chrome handles them. */
function navigationCode(url: string): string {
	return `const client = await page.createCDPSession();
let mainFrameId;
let attachment = false;
let outsideOrigin = "";
let documentError;
const pending = new Set();
let lastNetworkActivity = Date.now();
const onRequest = event => {
  if (!["Document", "Fetch", "XHR"].includes(event.type)) return;
  try {
    if (new URL(event.request.url).origin !== ${JSON.stringify(new URL(url).origin)}) {
      if (pending.delete(event.requestId)) lastNetworkActivity = Date.now();
      return;
    }
  } catch { return; }
  pending.add(event.requestId);
  lastNetworkActivity = Date.now();
};
const onResponse = event => {
  if (event.type === "Document" && event.frameId === mainFrameId && event.response.status >= 400) {
    documentError = "HTTP " + event.response.status + " navigating to " + event.response.url;
  }
  // An event stream is intentionally long-lived and is not a page load.
  if (pending.has(event.requestId) && /^text\\/event-stream(?:\\s*;|\\s*$)/i.test(event.response.mimeType || "")) {
    pending.delete(event.requestId);
    lastNetworkActivity = Date.now();
  }
};
const onRequestDone = event => {
  if (pending.delete(event.requestId)) lastNetworkActivity = Date.now();
};
const errorRoute = value => {
  try {
    const path = new URL(value).pathname;
    return /^\\/404\\/?$/i.test(path);
  } catch { return false; }
};
const rejectDocumentError = () => {
  if (documentError) throw new Error(documentError);
};
const rejectErrorRoute = value => {
  if (!errorRoute(${JSON.stringify(url)}) && errorRoute(value)) {
    throw new Error("Navigation redirected to an error page: " + value);
  }
};
const onPaused = event => {
  const isMain = event.frameId === mainFrameId;
  const responseStage = event.responseStatusCode !== undefined || event.responseErrorReason !== undefined;
  let blocked = false;
  if (!responseStage && isMain) {
    try { blocked = new URL(event.request.url).origin !== ${JSON.stringify(new URL(url).origin)}; }
    catch { blocked = true; }
    if (blocked) outsideOrigin = event.request.url;
  }
  if (responseStage) {
    const headers = event.responseHeaders || [];
    const disposition = headers.find(h => h.name.toLowerCase() === "content-disposition")?.value || "";
    const contentType = headers.find(h => h.name.toLowerCase() === "content-type")?.value || "";
    const redirect = event.responseStatusCode >= 300 && event.responseStatusCode < 400;
    const isFile = !redirect && (/(?:^|;)\\s*attachment(?:\\s*;|\\s*$)/i.test(disposition) ||
      (isMain && event.responseStatusCode !== undefined && !/^(?:text\\/html|application\\/xhtml\\+xml)(?:\\s*;|\\s*$)/i.test(contentType)));
    if (isFile && isMain) attachment = true;
    blocked ||= !!isFile;
  }
  const method = blocked ? "Fetch.failRequest" : "Fetch.continueRequest";
  const params = blocked ? { requestId: event.requestId, errorReason: "Aborted" } : { requestId: event.requestId };
  void client.send(method, params).catch(() => {});
};
try {
  mainFrameId = (await client.send("Page.getFrameTree")).frameTree.frame.id;
  client.on("Network.requestWillBeSent", onRequest);
  client.on("Network.responseReceived", onResponse);
  client.on("Network.loadingFinished", onRequestDone);
  client.on("Network.loadingFailed", onRequestDone);
  await client.send("Network.enable");
  client.on("Fetch.requestPaused", onPaused);
  await client.send("Fetch.enable", { patterns: [
    { urlPattern: "*", resourceType: "Document", requestStage: "Request" },
    { urlPattern: "*", resourceType: "Document", requestStage: "Response" }
  ] });
  let response;
  try { response = await page.goto(${JSON.stringify(url)}, { waitUntil: "domcontentloaded" }); }
  catch (error) {
    if (outsideOrigin) throw new Error("Navigation redirected outside the entry origin: " + outsideOrigin);
    if (attachment) throw new Error("Navigation returned an attachment or non-HTML document");
    throw error;
  }
  if (attachment) throw new Error("Navigation returned an attachment or non-HTML document");
  const status = response?.status() ?? null;
  const contentType = response?.headers()["content-type"] ?? "";
  if (!status || status >= 400) return { url: page.url(), status, contentType, attachment };
  const started = Date.now();
  const deadline = started + 12000;
  let previous;
  let unchangedSince = started;
  for (;;) {
    if (outsideOrigin) throw new Error("Navigation redirected outside the entry origin: " + outsideOrigin);
    if (attachment) throw new Error("Navigation returned an attachment or non-HTML document");
    rejectDocumentError();
    rejectErrorRoute(page.url());
    const snapshot = await page.evaluate(${JSON.stringify(READINESS_SNAPSHOT)});
    const now = Date.now();
    const state = JSON.stringify([snapshot.url, snapshot.text]);
    if (state !== previous) {
      previous = state;
      unchangedSince = now;
    }
    // Short or empty shells get extra time for delayed SPA rendering.
    const grace = snapshot.text.trim().length >= 80 ? 3000 : 4000;
    if (pending.size === 0 && now - started >= grace &&
        now - unchangedSince >= 1500 && now - lastNetworkActivity >= 1500) break;
    // Long-lived requests and constantly changing text must not block a usable page.
    if (now >= deadline) {
      if (snapshot.text.trim()) break;
      throw new Error("Page did not produce visible content within 12000ms");
    }
    await wait(250);
  }
  const result = { url: page.url(), status, contentType, attachment };
  rejectDocumentError();
  rejectErrorRoute(result.url);
  const info = await page.evaluate(${JSON.stringify(PAGE_INFO)});
  let markdown;
  let extractError;
  try { markdown = await tab.extract("markdown"); }
  catch (error) { extractError = error instanceof Error ? error.message : String(error); }
  rejectErrorRoute(page.url());
  rejectDocumentError();
  if (outsideOrigin) throw new Error("Navigation redirected outside the entry origin: " + outsideOrigin);
  return { ...result, info, markdown, extractError, endUrl: page.url() };
} finally {
  client.off("Network.requestWillBeSent", onRequest);
  client.off("Network.responseReceived", onResponse);
  client.off("Network.loadingFinished", onRequestDone);
  client.off("Network.loadingFailed", onRequestDone);
  await client.send("Network.disable").catch(() => {});
  client.off("Fetch.requestPaused", onPaused);
  await client.send("Fetch.disable").catch(() => {});
  await client.detach().catch(() => {});
}`;
}

// A stable visible document and settled same-origin requests are heuristics, not
// proof that every application has finished rendering.
const READINESS_SNAPSHOT = `(() => {
  return { url: location.href, text: (document.body?.innerText || "").slice(0, 16000) };
})()`;

// Resolve attributes in the disposable crawl tab before browser.extract serializes the DOM.
// The browser's URL resolution honors <base>, fragments, and escaped characters.
const PAGE_INFO = `(() => {
  const links = Array.from(document.querySelectorAll("a[href], area[href]"))
    .filter(a => !a.hasAttribute("download"))
    .map(a => a.href).filter(Boolean);
  const login = Array.from(document.querySelectorAll('input[type="password"]')).some(input => {
    const style = getComputedStyle(input);
    return style.display !== "none" && style.visibility !== "hidden" && input.getClientRects().length > 0;
  });
  for (const element of document.querySelectorAll("a[href], area[href], img[src]")) {
    const attr = element.hasAttribute("href") ? "href" : "src";
    const value = element[attr];
    if (typeof value === "string" && /^https?:/i.test(value)) element.setAttribute(attr, value);
  }
  return { url: location.href, contentType: document.contentType, login, links };
})()`;

/** Save pages through the authorized browser and write accessors, never adopting an existing tab. */
export async function runCrawl(
	runtime: SlashCommandRuntime,
	options: CrawlOptions,
	signal: AbortSignal,
): Promise<void> {
	const entry = normalizedUrl(options.url);
	if (!entry) throw new Error("Crawl requires an HTTP or HTTPS URL");
	const origin = new URL(entry).origin;
	const seen = new Set([entry]);
	const completed = new Set<string>();
	const failures: Array<{ url: string; reason: string }> = [];
	let saved = 0;
	let attempted = 0;
	let current: CrawlPage[] = [{ url: entry, depth: 0 }];
	const maxPages = options.maxPages ?? Number.POSITIVE_INFINITY;
	const concurrency = Math.max(1, Math.floor(options.concurrency));

	const processPage = async (item: CrawlPage, next: CrawlPage[]): Promise<void> => {
		const name = `crawl-${crypto.randomUUID()}`;
		let opened = false;
		let closed = false;
		try {
			await runtime.output(`Crawling ${item.url}`);
			signal.throwIfAborted();
			await crawlBrowserRequest(
				runtime.session,
				{ action: "open", name, url: "about:blank", app: { relay: true } },
				signal,
			);
			opened = true;
			const navResult = await crawlBrowserRequest(
				runtime.session,
				{ action: "run", name, code: navigationCode(item.url) },
				signal,
			);
			await crawlBrowserRequest(runtime.session, { action: "close", name });
			closed = true;
			const navigation = (navResult.details as { value?: NavigationResult } | undefined)?.value;
			if (!navigation || typeof navigation.url !== "string")
				throw new Error("Browser returned no navigation result");
			const finalUrl = normalizedUrl(navigation.url);
			if (!finalUrl || new URL(finalUrl).origin !== origin)
				throw new Error(`Navigation redirected outside the entry origin: ${navigation.url}`);
			if (navigation.attachment) throw new Error("Navigation returned an attachment, not a web page");
			if (typeof navigation.status !== "number" || navigation.status === 0)
				throw new Error("Navigation returned no HTTP response");
			if (navigation.status >= 400) throw new Error(`HTTP ${navigation.status}`);
			if (
				navigation.contentType &&
				!/^(?:text\/html|application\/xhtml\+xml)(?:\s*;|\s*$)/i.test(navigation.contentType)
			) {
				throw new Error(`Not an HTML page: ${navigation.contentType}`);
			}
			if (completed.has(finalUrl)) return;
			completed.add(finalUrl);
			seen.add(finalUrl);
			const info = navigation.info;
			if (!info || normalizedUrl(info.url) !== finalUrl) throw new Error("Page navigated while being inspected");
			if (!/^(?:text\/html|application\/xhtml\+xml)$/i.test(info.contentType))
				throw new Error(`Not an HTML page: ${info.contentType}`);
			if (info.login || /(?:^|\/)(?:login|log-in|signin|sign-in|auth)(?:\/|$)/i.test(new URL(finalUrl).pathname)) {
				throw new Error("Page requires login or redirected to a login page");
			}
			// Discover navigation independently of extraction, including when extraction fails.
			if (options.recursive && (options.maxDepth === undefined || item.depth < options.maxDepth)) {
				for (const link of info.links) {
					const url = normalizedUrl(link, finalUrl);
					if (!url || new URL(url).origin !== origin || seen.has(url)) continue;
					seen.add(url);
					next.push({ url, depth: item.depth + 1 });
				}
			}
			if (navigation.extractError) throw new Error(navigation.extractError);
			const markdown = navigation.markdown;
			if (typeof markdown !== "string" || !markdown.trim()) throw new Error("Page extraction returned no Markdown");
			if (normalizedUrl(navigation.endUrl ?? "") !== finalUrl)
				throw new Error("Page navigated while extracting content");
			signal.throwIfAborted();
			const path = await writeCrawlMarkdown(
				runtime.session,
				options.output,
				basename(finalUrl),
				`Source: ${finalUrl}\n\n${markdown.trim()}\n`,
				signal,
			);
			saved++;
			await runtime.output(`Saved ${finalUrl} → ${path}`);
		} catch (error) {
			if (!signal.aborted) {
				const reason = errorText(error);
				failures.push({ url: item.url, reason });
				await runtime.output(`Failed ${item.url}: ${reason}`);
			}
		} finally {
			// Close with a fresh signal even when the task was cancelled. A failed open
			// can have published its tab before failing, so release its unique name too.
			try {
				if (!closed) await crawlBrowserRequest(runtime.session, { action: "close", name });
			} catch (error) {
				if (opened) {
					const reason = `Could not release crawl tab: ${errorText(error)}`;
					failures.push({ url: item.url, reason });
					await runtime.output(`Failed ${item.url}: ${reason}`);
				}
			}
		}
	};

	while (current.length && !signal.aborted && attempted < maxPages) {
		const next: CrawlPage[] = [];
		let index = 0;
		const worker = async (): Promise<void> => {
			while (!signal.aborted && index < current.length && attempted < maxPages) {
				const item = current[index++];
				if (!item) return;
				attempted++;
				await processPage(item, next);
			}
		};
		await Promise.all(Array.from({ length: Math.min(concurrency, current.length) }, () => worker()));
		current = next;
	}
	await runtime.output(
		`Crawl ${signal.aborted ? "cancelled" : "finished"}: ${saved} saved, ${failures.length} failed${signal.aborted ? "; saved files retained" : ""}.${failures.length ? `\nFailures:\n${failures.map(failure => `- ${failure.url}: ${failure.reason}`).join("\n")}` : ""}`,
	);
}
