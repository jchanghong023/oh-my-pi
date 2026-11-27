import type { SlashCommandRuntime } from "../../slash-commands/types";
import type { CrawlBrowserRoute, CrawlBrowserTab } from "../browser";
import { TOOL_TIMEOUTS } from "../tool-timeouts";
import { crawlBrowserRequest, writeCrawlMarkdown } from "./crawl-access";
import { isNavigatedContextError } from "./navigation";

export interface CrawlOptions {
	url: string;
	recursive: boolean;
	output: string;
	concurrency: number;
	maxPages?: number;
	maxDepth?: number;
	wait?: number;
	scroll?: boolean;
}

/** Leave room for navigation and extraction inside the browser's per-call ceiling. */
export const MAX_CRAWL_WAIT_SECONDS = TOOL_TIMEOUTS.browser.max - 60;

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
		// Hash-router paths (including their queries) identify pages, not in-page anchors.
		if (!url.hash.startsWith("#/")) url.hash = "";
		return url.href;
	} catch {
		return undefined;
	}
}

function errorText(error: unknown): string {
	return redactCrawlUrls(error instanceof Error ? error.message : String(error));
}

const URL_USERINFO = /^(https?:\/\/)[^/?#\s]*@/i;

/** A displayed or archived source keeps the URL's query and route verbatim. */
function redactCrawlUrl(url: string): string {
	return url.replace(URL_USERINFO, "$1");
}

function redactCrawlUrls(text: string): string {
	return text.replace(/https?:\/\/[^\s<>"`]+/gi, redactCrawlUrl);
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

/** Use browser-native navigation and reject document downloads before Chrome handles them. */
function navigationCode(url: string, waitSeconds: number, scroll: boolean): string {
	const attribute = `data-omp-crawl-${crypto.randomUUID()}`;
	return `const client = await page.createCDPSession();
let mainFrameId;
let attachment = false;
let documentError;
const pending = new Set();
let lastNetworkActivity = Date.now();
const onRequest = event => {
  if (!["Document", "Fetch", "XHR"].includes(event.type)) return;
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
  if (responseStage) {
    const headers = event.responseHeaders || [];
    const disposition = headers.find(h => h.name.toLowerCase() === "content-disposition")?.value || "";
    const contentType = headers.find(h => h.name.toLowerCase() === "content-type")?.value.trim() || "";
    const redirect = event.responseStatusCode >= 300 && event.responseStatusCode < 400;
    const isFile = !redirect && (/(?:^|;)\\s*attachment(?:\\s*;|\\s*$)/i.test(disposition) ||
      (isMain && contentType !== "" && !/^(?:text\\/html|application\\/xhtml\\+xml)(?:\\s*;|\\s*$)/i.test(contentType)));
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
    { urlPattern: "*", resourceType: "Document", requestStage: "Response" }
  ] });
  const minimumWait = ${JSON.stringify(waitSeconds * 1000)};
  const readinessTimeout = ${(TOOL_TIMEOUTS.browser.max - 45 + waitSeconds) * 1000};
  const deadline = Date.now() + readinessTimeout;
  const navigate = async destination => {
    let response;
    try { response = await page.goto(destination, { waitUntil: "domcontentloaded" }); }
    catch (error) {
      if (attachment) throw new Error("Navigation returned an attachment or non-HTML document");
      throw error;
    }
    if (attachment) throw new Error("Navigation returned an attachment or non-HTML document");
    return response;
  };
  const attribute = ${JSON.stringify(attribute)};
  const response = await navigate(${JSON.stringify(url)});
  let status = response?.status() ?? null;
  let contentType = response?.headers()["content-type"]?.trim() ?? "";
  if (!status || status >= 400) return { url: page.url(), status, contentType, attachment };
  const timeoutError = () => new Error(
    ${JSON.stringify(scroll ? "Page did not finish loading or reach a stable scroll end" : "Page did not finish loading")} +
    " within " + readinessTimeout + "ms; content was not saved"
  );
  const contextWasReplaced = ${isNavigatedContextError.toString()};
  const waitForReady = async minimum => {
    const waitStarted = Date.now();
    let previous;
    let unchangedSince = waitStarted;
    for (;;) {
      if (attachment) throw new Error("Navigation returned an attachment or non-HTML document");
      rejectDocumentError();
      rejectErrorRoute(page.url());
      let snapshot;
      try {
        snapshot = await page.evaluate(${JSON.stringify(READINESS_SNAPSHOT)});
      } catch (error) {
        if (!contextWasReplaced(error)) throw error;
        if (Date.now() >= deadline) throw timeoutError();
        previous = undefined;
        await wait(250);
        continue;
      }
      const now = Date.now();
      if (now >= deadline) throw timeoutError();
      const state = JSON.stringify([snapshot.url, snapshot.text]);
      if (state !== previous) {
        previous = state;
        unchangedSince = now;
      }
      if (snapshot.readyState === "complete" && snapshot.text.trim() && pending.size === 0 &&
          now - waitStarted >= minimum && now - unchangedSince >= 1500 &&
          now - lastNetworkActivity >= 1500) return snapshot;
      await wait(250);
    }
  };
  let ready = await waitForReady(minimumWait);
  let bottomState;
  let scrollState;
  let followReadingLinks = true;
  for (;;) {
    if (Date.now() >= deadline) throw timeoutError();
    const reading = await page.evaluate(${FULL_ARTICLE_TARGET}, attribute, followReadingLinks);
    if (reading.error) throw new Error(reading.error);
    if (reading.selector) {
      const before = ready;
      if (reading.url) {
        const nextResponse = await navigate(reading.url);
        if (nextResponse) {
          status = nextResponse.status();
          contentType = nextResponse.headers()["content-type"]?.trim() ?? "";
        }
      } else {
        await tab.click(reading.selector);
      }
      ready = await waitForReady(minimumWait);
      if (ready.text === before.text) {
        // An ordinary fragment change is not a page or hash-route navigation.
        const [documentUrl, fragment] = ready.url.split("#", 2);
        if (ready.url === before.url || (documentUrl === before.url.split("#", 1)[0] && !fragment?.startsWith("/"))) {
          throw new Error("The full-article control did not reveal content; preview was not saved");
        }
      }
      followReadingLinks = false;
      bottomState = undefined;
      scrollState = undefined;
      continue;
    }
    if (!${scroll}) break;
    const target = await page.evaluate(${SCROLL_TARGET}, attribute);
    const state = JSON.stringify([target.state, ready.url, ready.text]);
    if (target.selector) {
      if (state === scrollState) throw new Error("Scrolling made no progress; content was not saved");
      scrollState = state;
      bottomState = undefined;
      await tab.scroll(0, target.delta, { selector: target.selector });
    } else {
      scrollState = undefined;
      if (state === bottomState) break;
      bottomState = state;
    }
    ready = await waitForReady(0);
  }
  const result = { url: page.url(), status, contentType, attachment };
  rejectDocumentError();
  rejectErrorRoute(result.url);
  const info = await page.evaluate(${JSON.stringify(PAGE_INFO)});
  let markdown;
  let extractError;
  try { markdown = await tab.extract("markdown", { selector: "body" }); }
  catch (error) { extractError = error instanceof Error ? error.message : String(error); }
  rejectErrorRoute(page.url());
  rejectDocumentError();
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

// Network idle and stable rendered text are heuristics; --wait handles delayed application startup.
const READINESS_SNAPSHOT = `(() => {
  return { url: location.href, readyState: document.readyState, text: document.body?.innerText || "" };
})()`;

// Only explicitly labelled reading controls may be activated; never submit forms or follow downloads.
const FULL_ARTICLE_TARGET = `(attribute, followLinks) => {
  const done = attribute + "-expanded";
  let navigation;
  let unavailable;
  const select = (control, url) => {
    for (const marked of document.querySelectorAll("[" + attribute + "]")) marked.removeAttribute(attribute);
    control.setAttribute(attribute, "");
    control.setAttribute(done, "");
    return { selector: "[" + attribute + "]", url };
  };
  for (const element of Array.from(document.querySelectorAll("body *")).reverse()) {
    const label = (element.getAttribute("aria-label") || element.innerText || element.textContent || "")
      .replace(/[\\s\\u200b]/g, "").replace(/[›»→>…]+$/, "").toLowerCase();
    if (!/^(?:查看全文|阅读全文|展开全文|显示全文|查看完整(?:文章|内容)|阅读完整(?:文章|内容)|继续阅读|阅读更多|readmore|read(?:the)?full(?:article|post)|continuereading)$/.test(label)) continue;
    const control = element.closest("a,button,input[type='image'],input[type='submit'],[role='button'],summary,[onclick]") || element;
    const style = getComputedStyle(control);
    if (control.hasAttribute(done) || style.display === "none" || style.visibility === "hidden" ||
        !control.getClientRects().length || control.getAttribute("aria-hidden") === "true") continue;
    if (!/^(?:A|BUTTON|SUMMARY)$/.test(control.tagName) && control.getAttribute("role") !== "button" &&
        !control.hasAttribute("onclick") && style.cursor !== "pointer") continue;
    if (control.tagName === "SUMMARY" && control.parentElement?.open) continue;
    const link = control.closest("a[href]");
    const href = link?.getAttribute("href")?.trim() ?? "";
    const target = link ? new URL(href, link.baseURI) : undefined;
    const frame = link
      ? (link.getAttribute("target") || document.querySelector("base[target]")?.getAttribute("target") || "_self").toLowerCase()
      : "_self";
    const placeholder = /^javascript:\\s*(?:void\\s*\\(\\s*0\\s*\\)|;)\\s*;?$/i.test(href);
    const sameDocument = target && target.href.split("#")[0] === location.href.split("#")[0];
    const expandsFragment = sameDocument && (!href || target.href.includes("#"));
    const navigates = link && !(frame === "_self" && (placeholder || expandsFragment));
    if (!followLinks && (navigates || (sameDocument && target.hash.startsWith("#/")))) continue;
    const error = control.disabled || control.getAttribute("aria-disabled") === "true"
      ? "The full-article control is disabled; preview was not saved"
      : control.form && (control.type === "submit" || control.type === "image")
        ? "Refusing to submit a form to open the full article"
        : link?.hasAttribute("download")
          ? "The full-article link is a download, not a webpage"
          : navigates && target.protocol !== "http:" && target.protocol !== "https:"
            ? "The full-article link is not an HTTP or HTTPS webpage"
            : undefined;
    if (error) {
      unavailable ??= error;
      continue;
    }
    if (!navigates) return select(control);
    navigation ??= { control, url: target.href };
  }
  return navigation ? select(navigation.control, navigation.url) : { error: unavailable };
}`;

// Pick an on-screen nested scroll panel before moving the document, so its lazy loaders stay visible.
// The actual scroll goes through tab.scroll and its existing cancellation/action handling.
const SCROLL_TARGET = `attribute => {
  const root = document.scrollingElement;
  const candidates = Array.from(document.querySelectorAll("body *")).reverse();
  if (root) candidates.push(root);
  const dimensions = [];
  let next;
  for (const element of candidates) {
    if (element.clientHeight <= 0 || element.clientWidth <= 0) continue;
    if (element !== root) {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (!/^(?:auto|scroll|overlay)$/.test(style.overflowY) ||
          style.visibility === "hidden" || style.display === "none" ||
          rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth) continue;
    }
    dimensions.push([element.scrollTop, element.clientHeight, element.scrollHeight]);
    if (!next && element.scrollTop + element.clientHeight < element.scrollHeight - 1) next = element;
  }
  if (!next) return { state: JSON.stringify(dimensions) };
  for (const element of document.querySelectorAll("[" + attribute + "]")) element.removeAttribute(attribute);
  next.setAttribute(attribute, "");
  return {
    state: JSON.stringify(dimensions),
    selector: "[" + attribute + "]",
    delta: Math.max(1, Math.floor(next.clientHeight * 0.8))
  };
}`;

// Resolve and redact link targets before Markdown conversion, without rewriting link labels.
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
    if (typeof value === "string" && /^https?:/i.test(value)) element.setAttribute(attr, value.replace(${URL_USERINFO}, "$1"));
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
	const waitSeconds = options.wait ?? 5;
	let origin = new URL(entry).origin;
	const seen = new Set([entry]);
	const writes = new Map<string, Promise<string>>();
	const failures: Array<{ url: string; reason: string }> = [];
	let saved = 0;
	let attempted = 0;
	let current: CrawlPage[] = [{ url: entry, depth: 0 }];
	const maxPages = options.maxPages ?? Number.POSITIVE_INFINITY;
	const concurrency = Math.max(1, Math.floor(options.concurrency));
	let route: CrawlBrowserRoute | undefined;
	let tabReleaseFailed = false;

	const release = async (tab: CrawlBrowserTab, url: string): Promise<void> => {
		try {
			await tab.release();
		} catch (error) {
			// Do not open more tabs if one may still occupy its concurrency slot.
			tabReleaseFailed = true;
			const reason = `Could not release crawl tab: ${errorText(error)}`;
			failures.push({ url, reason });
			await runtime.output(`Failed ${url}: ${reason}`);
		}
	};

	const processPage = async (item: CrawlPage, next: CrawlPage[]): Promise<void> => {
		const displayUrl = redactCrawlUrl(item.url);
		let owned: CrawlBrowserTab | undefined;
		try {
			await runtime.output(`Crawling ${displayUrl}`);
			signal.throwIfAborted();
			if (tabReleaseFailed) return;
			await crawlBrowserRequest(
				runtime.session,
				{ action: "open", name: `crawl-${crypto.randomUUID()}`, app: "relay" },
				signal,
				{
					kind: "open",
					route,
					onOpen: tab => {
						owned = tab;
						if (item.depth === 0) route = tab.route;
					},
				},
			);
			const tab = owned;
			if (!tab) throw new Error("Browser did not create an owned crawl tab");
			const result = await crawlBrowserRequest(
				runtime.session,
				{
					action: "run",
					name: tab.name,
					code: navigationCode(item.url, waitSeconds, options.scroll ?? true),
					timeout: TOOL_TIMEOUTS.browser.max,
				},
				signal,
				{ kind: "run", tab, waitSeconds },
			);
			owned = undefined;
			await release(tab, displayUrl);
			const navigation = (result.details as { value?: NavigationResult } | undefined)?.value;
			if (!navigation || typeof navigation.url !== "string")
				throw new Error("Browser returned no navigation result");
			const finalUrl = normalizedUrl(navigation.url);
			if (!finalUrl) throw new Error("Navigation did not end on an HTTP or HTTPS webpage");
			if (item.depth === 0) origin = new URL(finalUrl).origin;
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
			seen.add(finalUrl);
			const info = navigation.info;
			if (!info || normalizedUrl(info.url) !== finalUrl) throw new Error("Page navigated while being inspected");
			if (!/^(?:text\/html|application\/xhtml\+xml)$/i.test(info.contentType))
				throw new Error(`Not an HTML page: ${info.contentType}`);
			if (info.login) throw new Error("Page requires login or redirected to a login page");
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
			const sourceUrl = redactCrawlUrl(finalUrl);
			for (;;) {
				signal.throwIfAborted();
				const pending = writes.get(sourceUrl);
				if (pending) {
					if (
						await pending.then(
							() => true,
							() => false,
						)
					)
						return;
					continue; // A failed writer did not reserve this URL.
				}
				const write = writeCrawlMarkdown(
					runtime.session,
					options.output,
					basename(sourceUrl),
					`Source: ${sourceUrl}\n\n${markdown.trim()}\n`,
					signal,
				).catch(error => {
					writes.delete(sourceUrl);
					throw error;
				});
				writes.set(sourceUrl, write);
				const path = await write;
				saved++;
				await runtime.output(`Saved ${sourceUrl} → ${path}`);
				return;
			}
		} catch (error) {
			if (!signal.aborted) {
				const reason = errorText(error);
				failures.push({ url: displayUrl, reason });
				await runtime.output(`Failed ${displayUrl}: ${reason}`);
			}
		} finally {
			if (owned) await release(owned, displayUrl);
		}
	};

	while (current.length && !signal.aborted && !tabReleaseFailed && attempted < maxPages) {
		const next: CrawlPage[] = [];
		let index = 0;
		const worker = async (): Promise<void> => {
			while (!signal.aborted && !tabReleaseFailed && index < current.length && attempted < maxPages) {
				const item = current[index++];
				if (!item) return;
				attempted++;
				await processPage(item, next);
			}
		};
		const results = await Promise.allSettled(
			Array.from({ length: Math.min(concurrency, current.length) }, () => worker()),
		);
		for (const result of results) {
			if (result.status === "rejected") throw result.reason;
		}
		current = next;
	}
	await runtime.output(
		`Crawl ${signal.aborted ? "cancelled" : "finished"}: ${saved} saved, ${failures.length} failed${signal.aborted ? "; saved files retained" : ""}.${failures.length ? `\nFailures:\n${failures.map(failure => `- ${failure.url}: ${failure.reason}`).join("\n")}` : ""}`,
	);
}
