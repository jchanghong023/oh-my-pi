import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import type { SlashCommandRuntime } from "../../../src/slash-commands/types";
import * as access from "../../../src/tools/browser/crawl-access";
import { type CrawlOptions, runCrawl } from "../../../src/tools/browser/crawl";

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
			const match = /page\.goto\(("(?:[^"\\]|\\.)*")/.exec(args.code ?? "");
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
function scriptedPage(redirectUrl?: string, onWait?: () => void, persistentIndicator = false) {
	let elapsed = 0;
	let requestedUrl = "";
	let extractions = 0;
	let detachments = 0;
	const currentUrl = () => (redirectUrl && elapsed >= 500 ? redirectUrl : requestedUrl);
	const loaded = () => persistentIndicator || elapsed >= 1000;
	const article = persistentIndicator
		? `Article title\n${"A substantive paragraph with useful article content. ".repeat(12)}`
		: "Article title\nThe complete article body.";
	const client = {
		on: () => {},
		off: () => {},
		detach: async () => {
			detachments++;
		},
		send: async (method: string) => (method === "Page.getFrameTree" ? { frameTree: { frame: { id: "main" } } } : {}),
	};
	const page = {
		createCDPSession: async () => client,
		goto: async (url: string) => {
			requestedUrl = url;
			return { status: () => 200, headers: () => ({ "content-type": "text/html" }) };
		},
		url: currentUrl,
		evaluate: async (script: string) => {
			const document = {
				body: { innerText: loaded() ? article : "Article title\nLoading..." },
				contentType: "text/html",
				querySelectorAll: (selector: string) =>
					(persistentIndicator || !loaded()) && selector.split(",").some(part => part.trim() === ".loading")
						? [
								{
									getClientRects: () => [{ width: 5, height: 5 }],
									getBoundingClientRect: () => ({ width: 5, height: 5 }),
								},
							]
						: [],
			};
			const evaluate = new Function("document", "location", "getComputedStyle", `return ${script}`);
			return evaluate(document, { href: currentUrl() }, () => ({ display: "block", visibility: "visible" }));
		},
	};
	const tab = {
		extract: async () => {
			extractions++;
			return loaded() ? `# ${article.replace("\n", "\n\n")}` : "# Article title\n\nLoading...";
		},
	};
	const run = async (code: string) => {
		const execute = new Function("page", "tab", "wait", "Date", `return (async () => { ${code} })();`);
		return execute(
			page,
			tab,
			async (ms: number) => {
				elapsed += ms;
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

	it("does not archive cross-origin redirects, HTTP errors or login pages", async () => {
		const f = fixture({
			"https://example.test/": {
				links: ["https://example.test/redirect", "https://example.test/error", "https://example.test/private"],
			},
			"https://example.test/redirect": { finalUrl: "https://else.test/" },
			"https://example.test/error": { status: 403 },
			"https://example.test/private": { login: true },
		});
		await runCrawl(f.runtime, options, new AbortController().signal);
		expect(f.written).toHaveLength(1);
		expect(f.output.join("\n")).toContain("outside the entry origin");
		expect(f.output.join("\n")).toContain("HTTP 403");
		expect(f.output.join("\n")).toContain("requires login");
	});

	it("reports a client-side redirect to an error route instead of saving it", async () => {
		const url = "https://example.test/article";
		const browser = scriptedPage("https://example.test/404?reason=unavailable");
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

	it("saves substantive content despite a persistent visible decorative loading icon", async () => {
		const url = "https://example.test/article";
		const browser = scriptedPage(undefined, undefined, true);
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
		const browser = scriptedPage(undefined, () => {
			controller.abort();
			controller.signal.throwIfAborted();
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
	it("blocks cross-origin main navigations and attachment responses before Chromium handles them", async () => {
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
		await expect(execute(page, {})).rejects.toThrow("outside the entry origin");
		expect(commands).toContainEqual({ method: "Fetch.continueRequest", params: { requestId: "asset-frame" } });
		expect(commands).toContainEqual({ method: "Fetch.continueRequest", params: { requestId: "redirect" } });
		expect(commands).toContainEqual({
			method: "Fetch.failRequest",
			params: { requestId: "outside", errorReason: "Aborted" },
		});
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
