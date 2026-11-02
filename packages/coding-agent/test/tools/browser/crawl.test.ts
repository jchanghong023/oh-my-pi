import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import type { SlashCommandRuntime } from "../../../src/slash-commands/types";
import * as access from "../../../src/tools/browser/crawl-access";
import { type CrawlOptions, runCrawl } from "../../../src/tools/browser/crawl";
import {
	extractReadableFromHtml,
	type ReadableExtractOptions,
	type ReadableFormat,
} from "../../../src/tools/browser/readable";

interface FixturePage {
	links?: string[];
	markdown?: string;
	extractError?: string;
	finalUrl?: string;
	status?: number;
	login?: boolean;
}

function fixture(
	pages: Record<string, FixturePage>,
	onNavigate?: (url: string) => void,
	runCode?: (code: string, url: string) => Promise<unknown>,
) {
	const tabs = new Map<string, string>();
	const opened: string[] = [];
	const closed: string[] = [];
	const written: Array<{ content: string; name: string }> = [];
	const output: string[] = [];
	const codes: string[] = [];
	const runtime = {
		session: {},
		output: (text: string) => {
			output.push(text);
		},
	} as unknown as SlashCommandRuntime;
	spyOn(access, "crawlBrowserRequest").mockImplementation(async (_session, parameters, signal) => {
		const args = parameters as { action: string; name: string; code?: string; chain?: Array<{ method: string }> };
		if (args.action === "close") {
			closed.push(args.name);
			tabs.delete(args.name);
			return { content: [], details: {} };
		}
		if (signal?.aborted) throw new Error("aborted");
		if (args.action === "open") {
			opened.push(args.name);
			return { content: [], details: {} };
		}
		if (args.action === "run") {
			codes.push(args.code ?? "");
			const match = /navigate\(("(?:[^"\\]|\\.)*")/.exec(args.code ?? "");
			if (!match) throw new Error("missing navigation URL");
			const url = JSON.parse(match[1]!) as string;
			tabs.set(args.name, url);
			onNavigate?.(url);
			const page = pages[url];
			if (!page) throw new Error(`Unexpected URL ${url}`);
			if (runCode) return { content: [], details: { value: await runCode(args.code ?? "", url) } };
			const finalUrl = page.finalUrl ?? url;
			return {
				content: [],
				details: {
					value: {
						url: finalUrl,
						status: page.status ?? 200,
						contentType: "text/html",
						attachment: false,
						info: {
							url: finalUrl,
							links: page.links ?? [],
							contentType: "text/html",
							login: page.login ?? false,
						},
						markdown: page.markdown ?? "Readable content",
						extractError: page.extractError,
						endUrl: finalUrl,
					},
				},
			};
		}
		throw new Error("unexpected browser call");
	});
	spyOn(access, "writeCrawlMarkdown").mockImplementation(async (_session, _directory, name, content, signal) => {
		signal?.throwIfAborted();
		written.push({ name, content });
		return `/out/${name}`;
	});
	return { runtime, opened, closed, written, output, codes };
}

/** Execute the browser script against a page whose DOM and URL change on a virtual clock. */
function scriptedPage({
	redirectUrl,
	onWait,
	persistentIndicator = false,
	loadDelayMs = 1000,
	requestUrl,
	html,
	scrolling,
	fullArticle,
}: {
	redirectUrl?: string;
	onWait?: () => void;
	persistentIndicator?: boolean;
	loadDelayMs?: number;
	requestUrl?: string;
	html?: string;
	scrolling?: { container?: boolean; endless?: boolean; onScroll?: () => void };
	fullArticle?: { label?: string; url?: string; form?: boolean; noop?: boolean; onClick?: () => void };
} = {}) {
	let elapsed = 0;
	let requestedUrl = "";
	let extractions = 0;
	let detachments = 0;
	const currentUrl = () => (redirectUrl && elapsed >= 500 ? redirectUrl : requestedUrl);
	const loaded = () => persistentIndicator || elapsed >= loadDelayMs;
	const article = persistentIndicator
		? `Article title\n${"A substantive paragraph with useful article content. ".repeat(12)}`
		: "Article title\nThe complete article body.";
	const listeners = new Map<string, (event: Record<string, unknown>) => void>();
	let requestPending = false;
	let batches = 1;
	let nextBatchAt: number | undefined;
	let expanded = false;
	let expansionAt: number | undefined;
	const controlMarkers = new Set<string>();
	const control = {
		tagName: fullArticle?.url ? "A" : "BUTTON",
		get innerText() {
			return expanded ? "收起全文" : (fullArticle?.label ?? "查看全文");
		},
		type: fullArticle?.form ? "submit" : "button",
		form: fullArticle?.form ? {} : null,
		disabled: false,
		getClientRects: () => [{}],
		getBoundingClientRect: () => ({ top: 0, bottom: 30, left: 0, right: 100 }),
		clientHeight: 30,
		clientWidth: 100,
		scrollHeight: 30,
		scrollTop: 0,
		closest: (selector: string): Element | null =>
			selector === "a[href]" && !fullArticle?.url ? null : (control as unknown as Element),
		getAttribute: (name: string) => (name === "href" ? (fullArticle?.url ?? null) : null),
		hasAttribute: (name: string) => controlMarkers.has(name),
		setAttribute: (name: string) => controlMarkers.add(name),
		removeAttribute: (name: string) => controlMarkers.delete(name),
	};
	const markers = new Set<string>();
	const scrollArea = {
		scrollTop: 0,
		clientHeight: 100,
		clientWidth: 100,
		get scrollHeight() {
			return scrolling ? (batches + 1) * 100 : 100;
		},
		getAttribute: () => null,
		getBoundingClientRect: () => ({ top: 0, bottom: 100, left: 0, right: 100 }),
		setAttribute: (name: string) => markers.add(name),
		removeAttribute: (name: string) => markers.delete(name),
	};
	const renderedText = () => {
		if (fullArticle && !expanded) return `Article title\nPreview only\n${fullArticle.label ?? "查看全文"}`;
		return scrolling
			? `${article}\n${Array.from({ length: batches }, (_, index) => `Lazy section ${index + 1}`).join("\n")}`
			: article;
	};
	const client = {
		on: (event: string, listener: (event: Record<string, unknown>) => void) => listeners.set(event, listener),
		off: (event: string) => listeners.delete(event),
		detach: async () => {
			detachments++;
		},
		send: async (method: string) => (method === "Page.getFrameTree" ? { frameTree: { frame: { id: "main" } } } : {}),
	};
	const page = {
		createCDPSession: async () => client,
		goto: async (url: string) => {
			requestedUrl = url;
			if (url === fullArticle?.url) expanded = true;
			if (requestUrl) {
				requestPending = true;
				listeners.get("Network.requestWillBeSent")?.({
					type: "Fetch",
					requestId: "data",
					request: { url: requestUrl },
				});
			}
			return { status: () => 200, headers: () => ({ "content-type": "text/html" }) };
		},
		url: currentUrl,
		evaluate: async (script: string | ((...args: unknown[]) => unknown), ...args: unknown[]) => {
			const document = {
				body: { innerText: loaded() ? renderedText() : "Article title\nLoading..." },
				contentType: "text/html",
				readyState: "complete",
				scrollingElement: scrolling?.container
					? { scrollTop: 0, clientHeight: 100, clientWidth: 100, scrollHeight: 100 }
					: scrollArea,
				querySelectorAll: (selector: string) =>
					selector === "body *"
						? [...(scrolling?.container ? [scrollArea] : []), ...(fullArticle ? [control] : [])]
						: selector.startsWith("[data-omp-crawl-")
							? [
									...(markers.has(selector.slice(1, -1)) ? [scrollArea] : []),
									...(controlMarkers.has(selector.slice(1, -1)) ? [control] : []),
								]
							: (persistentIndicator || !loaded()) &&
								  selector.split(",").some(part => part.trim() === ".loading")
								? [
										{
											getClientRects: () => [{ width: 5, height: 5 }],
											getBoundingClientRect: () => ({ width: 5, height: 5 }),
										},
									]
								: [],
			};
			const evaluate = new Function(
				"document",
				"location",
				"getComputedStyle",
				"innerHeight",
				"innerWidth",
				"args",
				typeof script === "string" ? `return ${script}` : `return (${script.toString()})(...args)`,
			);
			return evaluate(
				document,
				{ href: currentUrl() },
				() => ({ display: "block", visibility: "visible", overflowY: "auto", cursor: "pointer" }),
				100,
				100,
				args,
			);
		},
	};
	const tab = {
		click: async () => {
			fullArticle?.onClick?.();
			if (!fullArticle?.noop) {
				expansionAt = elapsed + 2000;
				listeners.get("Network.requestWillBeSent")?.({
					type: "Fetch",
					requestId: "full-article",
					request: { url: "https://api.example.test/full" },
				});
			}
		},
		scroll: async (_dx: number, dy: number) => {
			scrollArea.scrollTop = Math.min(scrollArea.scrollHeight - scrollArea.clientHeight, scrollArea.scrollTop + dy);
			if (
				scrollArea.scrollTop + scrollArea.clientHeight >= scrollArea.scrollHeight &&
				(batches < 3 || scrolling?.endless) &&
				nextBatchAt === undefined
			) {
				nextBatchAt = elapsed + 2000;
				listeners.get("Network.requestWillBeSent")?.({
					type: "Fetch",
					requestId: "scroll-data",
					request: { url: "https://api.example.test/next" },
				});
			}
			scrolling?.onScroll?.();
		},
		extract: async (format: ReadableFormat, opts?: ReadableExtractOptions) => {
			extractions++;
			if (html) return (await extractReadableFromHtml(html, currentUrl(), format, opts))?.markdown;
			return loaded() ? `# ${renderedText().replace("\n", "\n\n")}` : "# Article title\n\nLoading...";
		},
	};
	const run = async (code: string) => {
		const execute = new Function("page", "tab", "wait", "Date", `return (async () => { ${code} })();`);
		return execute(
			page,
			tab,
			async (ms: number) => {
				elapsed += ms;
				if (expansionAt !== undefined && elapsed >= expansionAt) {
					expanded = true;
					expansionAt = undefined;
					listeners.get("Network.loadingFinished")?.({ requestId: "full-article" });
				}
				if (nextBatchAt !== undefined && elapsed >= nextBatchAt) {
					batches++;
					nextBatchAt = undefined;
					listeners.get("Network.loadingFinished")?.({ requestId: "scroll-data" });
				}
				if (requestPending && loaded()) {
					requestPending = false;
					listeners.get("Network.loadingFinished")?.({ requestId: "data" });
				}
				onWait?.();
			},
			{ now: () => 10_000 + elapsed },
		);
	};
	return { run, extractionCount: () => extractions, detachmentCount: () => detachments };
}

const options: CrawlOptions = { url: "https://example.test/", recursive: true, output: "/out", concurrency: 2 };
afterEach(() => vi.restoreAllMocks());

describe("crawl engine", () => {
	it("continues from an extraction failure, deduplicates fragments, preserves queries and obeys depth", async () => {
		const f = fixture({
			"https://example.test/": {
				extractError: "no readable content",
				links: [
					"https://example.test/a#one",
					"https://example.test/a#two",
					"https://example.test/a?q=1",
					"https://else.test/",
					"https://example.test:444/a",
				],
			},
			"https://example.test/a": { links: ["https://example.test/deeper"] },
			"https://example.test/a?q=1": {},
		});
		await runCrawl(f.runtime, { ...options, maxDepth: 1 }, new AbortController().signal);
		expect(f.written).toHaveLength(2);
		expect(f.written.map(file => file.content)).toContain("Source: https://example.test/a?q=1\n\nReadable content\n");
		expect(f.opened).toHaveLength(3);
		expect(f.closed.sort()).toEqual(f.opened.sort());
		expect(f.output.at(-1)).toContain("2 saved, 1 failed");
		expect(f.output.at(-1)).toContain("https://example.test/: no readable content");
	});

	it("follows cross-origin redirects while still rejecting HTTP errors and login pages", async () => {
		const f = fixture({
			"https://example.test/": {
				links: ["https://example.test/redirect", "https://example.test/error", "https://example.test/private"],
			},
			"https://example.test/redirect": { finalUrl: "https://else.test/" },
			"https://example.test/error": { status: 403 },
			"https://example.test/private": { login: true },
		});
		await runCrawl(f.runtime, options, new AbortController().signal);
		expect(f.written).toHaveLength(2);
		expect(f.written.map(file => file.content)).toContain("Source: https://else.test/\n\nReadable content\n");
		expect(f.output.join("\n")).toContain("HTTP 403");
		expect(f.output.join("\n")).toContain("requires login");
	});

	it("uses the redirected entry origin for recursion without following other sites' navigation links", async () => {
		const f = fixture({
			"https://example.test/": {
				finalUrl: "https://blog.test/entry",
				links: ["https://blog.test/child", "https://example.test/old", "https://external.test/other"],
			},
			"https://blog.test/child": {
				finalUrl: "https://docs.test/article",
				links: ["https://docs.test/next"],
			},
		});
		await runCrawl(f.runtime, options, new AbortController().signal);
		expect(f.written.map(file => file.content)).toEqual([
			"Source: https://blog.test/entry\n\nReadable content\n",
			"Source: https://docs.test/article\n\nReadable content\n",
		]);
		expect(f.output.at(-1)).toContain("2 saved, 0 failed");
	});

	it("reports a client-side redirect to an error route instead of saving it", async () => {
		const url = "https://example.test/article";
		const browser = scriptedPage({ redirectUrl: "https://example.test/404?reason=unavailable" });
		const f = fixture({ [url]: {} }, undefined, browser.run);
		await runCrawl(f.runtime, { ...options, url, recursive: false }, new AbortController().signal);
		expect(f.written).toEqual([]);
		expect(browser.extractionCount()).toBe(0);
		expect(browser.detachmentCount()).toBe(1);
		expect(f.opened).toHaveLength(1);
		expect(f.closed).toEqual(f.opened);
		expect(f.output.join("\n")).toContain(`Failed ${url}:`);
		expect(f.output.join("\n")).toContain(
			"Navigation redirected to an error page: https://example.test/404?reason=unavailable",
		);
		expect(f.output.join("\n")).toContain("0 saved, 1 failed");
	});

	it("extracts the asynchronously loaded article instead of its loading placeholder", async () => {
		const url = "https://example.test/article";
		const browser = scriptedPage();
		const f = fixture({ [url]: {} }, undefined, browser.run);
		await runCrawl(f.runtime, { ...options, url, recursive: false }, new AbortController().signal);
		expect(f.written).toEqual([
			{ name: "article.md", content: `Source: ${url}\n\n# Article title\n\nThe complete article body.\n` },
		]);
		expect(browser.extractionCount()).toBe(1);
		expect(browser.detachmentCount()).toBe(1);
		expect(f.opened).toHaveLength(1);
		expect(f.closed).toEqual(f.opened);
		expect(f.output.join("\n")).toContain("1 saved, 0 failed");
	});

	it("waits for slow cross-origin application data instead of saving the shell", async () => {
		const url = "https://example.test/article";
		const browser = scriptedPage({ loadDelayMs: 20000, requestUrl: "https://api.example.test/data" });
		const f = fixture({ [url]: {} }, undefined, browser.run);
		await runCrawl(f.runtime, { ...options, url, recursive: false }, new AbortController().signal);
		expect(f.written).toEqual([
			{ name: "article.md", content: `Source: ${url}\n\n# Article title\n\nThe complete article body.\n` },
		]);
		expect(f.closed).toEqual(f.opened);
	});

	it("reports a loading timeout instead of archiving a shell whose data never arrives", async () => {
		const url = "https://example.test/article";
		const browser = scriptedPage({
			loadDelayMs: Number.POSITIVE_INFINITY,
			requestUrl: "https://api.example.test/data",
		});
		const f = fixture({ [url]: {} }, undefined, browser.run);
		await runCrawl(f.runtime, { ...options, url, recursive: false }, new AbortController().signal);
		expect(f.written).toEqual([]);
		expect(f.output.join("\n")).toContain("Page did not finish loading");
		expect(browser.extractionCount()).toBe(0);
		expect(browser.detachmentCount()).toBe(1);
		expect(f.closed).toEqual(f.opened);
	});

	it("honors an explicit wait for application rendering that starts after network idle", async () => {
		const url = "https://example.test/article";
		const browser = scriptedPage({ loadDelayMs: 8000 });
		const f = fixture({ [url]: {} }, undefined, browser.run);
		await runCrawl(f.runtime, { ...options, url, recursive: false, wait: 10 }, new AbortController().signal);
		expect(f.written).toEqual([
			{ name: "article.md", content: `Source: ${url}\n\n# Article title\n\nThe complete article body.\n` },
		]);
	});

	it("retains enterprise tables and business sections outside an article", async () => {
		const url = "https://example.test/dashboard";
		const browser = scriptedPage({
			html: `<html><body><article><h1>Company news</h1><p>${"General company announcement. ".repeat(30)}</p></article>
				<section><h2>Project status</h2><table><thead><tr><th>Project</th><th>Status</th></tr></thead>
				<tbody><tr><td>Chip Alpha</td><td>Verification complete</td></tr></tbody></table></section>
				<section><h2>Release approvals</h2><ul><li>Chip Beta: awaiting sign-off</li></ul></section></body></html>`,
		});
		const f = fixture({ [url]: {} }, undefined, browser.run);
		await runCrawl(f.runtime, { ...options, url, recursive: false }, new AbortController().signal);
		expect(f.written[0]?.content).toContain("Chip Alpha");
		expect(f.written[0]?.content).toContain("Verification complete");
		expect(f.written[0]?.content).toContain("Chip Beta: awaiting sign-off");
	});

	for (const container of [false, true]) {
		it(`loads appended content by scrolling the ${container ? "nested panel" : "document"}`, async () => {
			const url = "https://example.test/feed";
			const browser = scriptedPage({ scrolling: { container } });
			const f = fixture({ [url]: {} }, undefined, browser.run);
			await runCrawl(f.runtime, { ...options, url, recursive: false }, new AbortController().signal);
			expect(f.written[0]?.content).toContain("Lazy section 1");
			expect(f.written[0]?.content).toContain("Lazy section 3");
			expect(f.output.at(-1)).toContain("1 saved, 0 failed");
			expect(f.closed).toEqual(f.opened);
		});
	}

	it("honors an explicit scroll opt-out", async () => {
		const url = "https://example.test/feed";
		const browser = scriptedPage({ scrolling: {} });
		const f = fixture({ [url]: {} }, undefined, browser.run);
		await runCrawl(f.runtime, { ...options, url, recursive: false, scroll: false }, new AbortController().signal);
		expect(f.written[0]?.content).toContain("Lazy section 1");
		expect(f.written[0]?.content).not.toContain("Lazy section 2");
	});

	it("reports an endless feed instead of saving a falsely complete archive", async () => {
		const url = "https://example.test/feed";
		const browser = scriptedPage({ scrolling: { endless: true } });
		const f = fixture({ [url]: {} }, undefined, browser.run);
		await runCrawl(f.runtime, { ...options, url, recursive: false }, new AbortController().signal);
		expect(f.written).toEqual([]);
		expect(f.output.join("\n")).toContain("stable scroll end");
		expect(browser.detachmentCount()).toBe(1);
		expect(f.closed).toEqual(f.opened);
	});

	it("cancels and releases the owned tab while scrolling", async () => {
		const controller = new AbortController();
		const browser = scriptedPage({
			scrolling: {
				onScroll: () => {
					controller.abort();
					controller.signal.throwIfAborted();
				},
			},
		});
		const f = fixture({ "https://example.test/": {} }, undefined, browser.run);
		await runCrawl(f.runtime, { ...options, recursive: false }, controller.signal);
		expect(f.written).toEqual([]);
		expect(f.output.at(-1)).toContain("Crawl cancelled");
		expect(browser.detachmentCount()).toBe(1);
		expect(f.closed).toEqual(f.opened);
	});

	it("expands a similar reading control and waits for the complete article by default", async () => {
		const url = "https://example.test/article";
		const browser = scriptedPage({ fullArticle: { label: " 展开全文 » " } });
		const f = fixture({ [url]: {} }, undefined, browser.run);
		await runCrawl(f.runtime, { ...options, url, recursive: false }, new AbortController().signal);
		expect(f.written[0]?.content).toContain("The complete article body.");
		expect(f.written[0]?.content).not.toContain("Preview only");
		expect(f.closed).toEqual(f.opened);
	});

	it("does not save a preview when a full-article control fails to reveal content", async () => {
		const url = "https://example.test/article";
		const browser = scriptedPage({ fullArticle: { noop: true } });
		const f = fixture({ [url]: {} }, undefined, browser.run);
		await runCrawl(f.runtime, { ...options, url, recursive: false }, new AbortController().signal);
		expect(f.written).toEqual([]);
		expect(f.output.join("\n")).toContain("did not reveal");
	});

	it("refuses a form submission even when its button is labelled as a full-article control", async () => {
		const url = "https://example.test/article";
		let submissions = 0;
		const browser = scriptedPage({
			fullArticle: {
				form: true,
				onClick: () => {
					submissions++;
				},
			},
		});
		const f = fixture({ [url]: {} }, undefined, browser.run);
		await runCrawl(f.runtime, { ...options, url, recursive: false }, new AbortController().signal);
		expect(f.written).toEqual([]);
		expect(submissions).toBe(0);
		expect(f.output.join("\n")).toContain("form");
	});

	it("saves substantive content despite a persistent visible decorative loading icon", async () => {
		const url = "https://example.test/article";
		const browser = scriptedPage({ persistentIndicator: true });
		const f = fixture({ [url]: {} }, undefined, browser.run);
		await runCrawl(f.runtime, { ...options, url, recursive: false }, new AbortController().signal);
		expect(f.written).toHaveLength(1);
		expect(f.written[0]?.content).toContain("A substantive paragraph with useful article content.");
		expect(browser.extractionCount()).toBe(1);
		expect(browser.detachmentCount()).toBe(1);
		expect(f.closed).toEqual(f.opened);
		expect(f.output.at(-1)).toContain("1 saved, 0 failed");
	});

	it("closes the tab and detaches the browser session when readiness is cancelled", async () => {
		const controller = new AbortController();
		const browser = scriptedPage({
			onWait: () => {
				controller.abort();
				controller.signal.throwIfAborted();
			},
		});
		const f = fixture({ "https://example.test/": {} }, undefined, browser.run);
		await runCrawl(f.runtime, { ...options, recursive: false }, controller.signal);
		expect(f.written).toEqual([]);
		expect(browser.extractionCount()).toBe(0);
		expect(browser.detachmentCount()).toBe(1);
		expect(f.opened).toHaveLength(1);
		expect(f.closed).toEqual(f.opened);
		expect(f.output.join("\n")).toContain("Crawl cancelled: 0 saved, 0 failed");
	});

	it("stops scheduling and closes owned tabs on cancellation", async () => {
		const controller = new AbortController();
		const f = fixture({ "https://example.test/": { links: ["https://example.test/a"] } }, () => controller.abort());
		await runCrawl(f.runtime, options, controller.signal);
		expect(f.opened).toHaveLength(1);
		expect(f.closed).toEqual(f.opened);
		expect(f.written).toHaveLength(0);
		expect(f.output.join("\n")).toContain("cancelled");
	});

	it("honors the page cap and the non-recursive default", async () => {
		const pages = { "https://example.test/": { links: ["https://example.test/a"] }, "https://example.test/a": {} };
		const f = fixture(pages);
		await runCrawl(f.runtime, { ...options, maxPages: 1 }, new AbortController().signal);
		expect(f.opened).toHaveLength(1);
		await runCrawl(f.runtime, { ...options, recursive: false }, new AbortController().signal);
		expect(f.opened).toHaveLength(2);
	});
	it("allows redirect responses but blocks attachment responses before Chromium handles them", async () => {
		const f = fixture({ "https://example.test/": {} });
		await runCrawl(f.runtime, { ...options, recursive: false }, new AbortController().signal);
		const code = f.codes[0]!;
		const commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
		let paused: ((event: Record<string, unknown>) => void) | undefined;
		const client = {
			on: (_event: string, listener: typeof paused) => {
				paused = listener;
			},
			off: () => {},
			detach: async () => {},
			send: async (method: string, params?: Record<string, unknown>) => {
				commands.push({ method, params });
				if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
				return {};
			},
		};
		const page = {
			createCDPSession: async () => client,
			goto: async () => {
				paused!({ requestId: "asset-frame", frameId: "child", request: { url: "https://else.test/frame" } });
				paused!({
					requestId: "redirect",
					frameId: "main",
					responseStatusCode: 302,
					responseHeaders: [{ name: "Content-Type", value: "text/plain" }],
				});
				paused!({ requestId: "outside", frameId: "main", request: { url: "https://else.test/" } });
				throw new Error("net::ERR_ABORTED");
			},
		};
		const execute = new Function("page", "tab", `return (async () => { ${code} })();`);
		await expect(execute(page, {})).rejects.toThrow("net::ERR_ABORTED");
		expect(commands).toContainEqual({ method: "Fetch.continueRequest", params: { requestId: "asset-frame" } });
		expect(commands).toContainEqual({ method: "Fetch.continueRequest", params: { requestId: "redirect" } });
		expect(commands).toContainEqual({ method: "Fetch.continueRequest", params: { requestId: "outside" } });
		expect(commands).toContainEqual({ method: "Fetch.disable", params: undefined });

		commands.length = 0;
		page.goto = async () => {
			paused!({
				requestId: "download",
				frameId: "main",
				responseStatusCode: 200,
				responseHeaders: [{ name: "Content-Disposition", value: "attachment; filename=report" }],
			});
			throw new Error("net::ERR_ABORTED");
		};
		await expect(execute(page, {})).rejects.toThrow("attachment");
		expect(commands).toContainEqual({
			method: "Fetch.failRequest",
			params: { requestId: "download", errorReason: "Aborted" },
		});
	});
});
