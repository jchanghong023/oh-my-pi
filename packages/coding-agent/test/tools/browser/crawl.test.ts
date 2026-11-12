import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { Browser } from "puppeteer-core";
import type { SlashCommandRuntime } from "../../../src/slash-commands/types";
import * as access from "../../../src/tools/browser/crawl-access";
import { type CrawlOptions, runCrawl } from "../../../src/tools/browser/crawl";
import { closeLaunchedBrowser, ensureChromiumExecutable, loadPuppeteer } from "../../../src/tools/browser/launch";
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
	const requests: Array<{ action: string; name: string; url?: string; app?: { relay: boolean } }> = [];
	const runtime = {
		session: {},
		output: (text: string) => {
			output.push(text);
		},
	} as unknown as SlashCommandRuntime;
	spyOn(access, "crawlBrowserRequest").mockImplementation(async (_session, parameters, signal) => {
		const args = parameters as { action: string; name: string; code?: string; chain?: Array<{ method: string }> };
		requests.push(parameters as (typeof requests)[number]);
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
	return { runtime, opened, closed, written, output, codes, requests };
}

/** Execute the browser script against a page whose DOM and URL change on a virtual clock. */
function scriptedPage({
	redirectUrl,
	onWait,
	persistentIndicator = false,
	loadDelayMs = 1000,
	requestUrl,
	eventStream = false,
	html,
	scrolling,
	fullArticle,
	links,
}: {
	redirectUrl?: string;
	onWait?: () => void;
	persistentIndicator?: boolean;
	loadDelayMs?: number;
	requestUrl?: string;
	eventStream?: boolean;
	html?: string;
	links?: (batches: number) => string[];
	scrolling?: { container?: boolean; endless?: boolean; stalled?: boolean; onScroll?: () => void };
	fullArticle?: {
		label?: string;
		url?: string;
		form?: boolean;
		noop?: boolean;
		disabled?: boolean;
		download?: boolean;
		onClick?: () => void;
	};
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
		disabled: fullArticle?.disabled ?? false,
		getClientRects: () => [{}],
		getBoundingClientRect: () => ({ top: 0, bottom: 30, left: 0, right: 100 }),
		clientHeight: 30,
		clientWidth: 100,
		scrollHeight: 30,
		scrollTop: 0,
		closest: (selector: string): Element | null =>
			selector === "a[href]" && !fullArticle?.url ? null : (control as unknown as Element),
		getAttribute: (name: string) => (name === "href" ? (fullArticle?.url ?? null) : null),
		hasAttribute: (name: string) =>
			(name === "download" && fullArticle?.download === true) || controlMarkers.has(name),
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
				if (eventStream)
					listeners.get("Network.responseReceived")?.({
						type: "Fetch",
						requestId: "data",
						response: { mimeType: "text/event-stream; charset=utf-8" },
					});
			}
			return { status: () => 200, headers: () => ({ "content-type": "text/html" }) };
		},
		url: currentUrl,
		evaluate: async (script: string | ((...args: unknown[]) => unknown), ...args: unknown[]) => {
			const anchors = (links?.(batches) ?? []).map(href => ({
				href,
				hasAttribute: (name: string) => name === "href",
				setAttribute: () => {},
			}));
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
						: selector === "a[href], area[href]" || selector === "a[href], area[href], img[src]"
							? anchors
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
			if (!scrolling?.stalled) {
				scrollArea.scrollTop = Math.min(
					scrollArea.scrollHeight - scrollArea.clientHeight,
					scrollArea.scrollTop + dy,
				);
			}
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
				if (requestPending && loaded() && !eventStream) {
					requestPending = false;
					listeners.get("Network.loadingFinished")?.({ requestId: "data" });
				}
				onWait?.();
			},
			{ now: () => 10_000 + elapsed },
		);
	};
	return { run, extractionCount: () => extractions, detachmentCount: () => detachments, elapsed: () => elapsed };
}

let closePendingCrawlBrowser: (() => Promise<void>) | undefined;

/** Run the generated crawl program in a private Chromium profile against loopback HTML. */
async function crawlDomFixture(pages: Record<string, string>, entry = "/article/preview") {
	using directory = TempDir.createSync("@omp-crawl-dom-");
	const requested: string[] = [];
	let closeOwnedFixture: (() => Promise<void>) | undefined;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const pathname = new URL(request.url).pathname;
			requested.push(pathname);
			const html = pages[pathname];
			return new Response(html ?? "Not found", {
				status: html === undefined ? 404 : 200,
				headers: { "content-type": "text/html; charset=utf-8" },
			});
		},
	});
	try {
		const executablePath = await ensureChromiumExecutable();
		if (!executablePath) throw new Error("Crawl DOM acceptance requires a locally available Chromium executable");
		const puppeteer = await loadPuppeteer();
		const profile = directory.join("browser-profile");
		const home = directory.join("home");
		// SHGetFolderPath verifies %USERPROFILE%\AppData\Local on Windows,
		// independently of LOCALAPPDATA; both must resolve to an existing private folder.
		const config = directory.join("home", "AppData", "Roaming");
		const cache = directory.join("cache");
		const data = directory.join("home", "AppData", "Local");
		const temp = directory.join("tmp");
		await Promise.all([profile, home, config, cache, data, temp].map(path => mkdir(path, { recursive: true })));
		const privateEnv: NodeJS.ProcessEnv = {
			HOME: home,
			USERPROFILE: home,
			APPDATA: config,
			LOCALAPPDATA: data,
			XDG_CONFIG_HOME: config,
			XDG_CACHE_HOME: cache,
			XDG_DATA_HOME: data,
			CHROME_CONFIG_HOME: config,
			CHROME_USER_DATA_DIR: undefined,
			TMP: temp,
			TEMP: temp,
			TMPDIR: temp,
		};
		const privateEnvNames = new Set(Object.keys(privateEnv));
		const inheritedEnv = Object.fromEntries(
			Object.entries(process.env).filter(([name]) => !privateEnvNames.has(name.toUpperCase())),
		);
		const launchAbort = new AbortController();
		let launchedBrowser: Browser | undefined = undefined;
		let closePromise: Promise<void> | undefined;
		closeOwnedFixture = () =>
			(closePromise ??= (async () => {
				if (launchedBrowser) await closeLaunchedBrowser(launchedBrowser);
				else launchAbort.abort();
				await server.stop(true);
			})());
		// Bun's test deadline can interrupt launch without entering its finally.
		closePendingCrawlBrowser = closeOwnedFixture;
		const browser = await puppeteer.launch({
			executablePath,
			headless: true,
			userDataDir: profile,
			// Use loopback WebSocket CDP: Bun's Windows pipe transport can stall target discovery.
			args: [
				"--remote-debugging-port=0",
				"--remote-debugging-address=127.0.0.1",
				"--no-sandbox",
				"--disable-dev-shm-usage",
			],
			pipe: false,
			signal: launchAbort.signal,
			// Remove case variants before merging: Windows environment names are case-insensitive.
			env: { ...inheritedEnv, ...privateEnv },
		});
		launchedBrowser = browser;
		try {
			const page = await browser.newPage();
			const initialTabs = (await browser.pages()).length;
			let createdTabs = 0;
			browser.on("targetcreated", target => {
				if (target.type() === "page") createdTabs++;
			});
			const navigations: string[] = [];
			page.on("framenavigated", frame => {
				if (frame === page.mainFrame()) navigations.push(frame.url());
			});
			// Do not allow fixture HTML to contact external sites.
			await page.setRequestInterception(true);
			page.on("request", request => {
				if (new URL(request.url()).origin === server.url.origin) void request.continue();
				else void request.abort();
			});
			const url = new URL(entry, server.url).href;
			const extractedAnchors: string[][] = [];
			const tab = {
				click: (selector: string) => page.click(selector),
				extract: async (format: ReadableFormat, opts?: ReadableExtractOptions) => {
					extractedAnchors.push(
						await page.$$eval("a[href]", anchors => anchors.map(anchor => anchor.getAttribute("href")!)),
					);
					const result = await extractReadableFromHtml(await page.content(), page.url(), format, opts);
					if (!result?.markdown) throw new Error("No readable fixture content");
					return result.markdown;
				},
			};
			const f = fixture({ [url]: {} }, undefined, async code => {
				const execute = new Function("page", "tab", "wait", `return (async () => { ${code} })();`);
				return execute(page, tab, (ms: number) => new Promise(resolve => setTimeout(resolve, ms)));
			});
			const savedPaths: string[] = [];
			spyOn(access, "writeCrawlMarkdown").mockImplementation(async (_session, _output, name, content, signal) => {
				signal?.throwIfAborted();
				const destination = directory.join(name);
				await writeFile(destination, content);
				savedPaths.push(destination);
				return destination;
			});
			await runCrawl(
				f.runtime,
				{
					url,
					recursive: false,
					output: directory.path(),
					concurrency: 1,
					wait: 0,
					scroll: false,
				},
				new AbortController().signal,
			);
			expect(f.output.at(-1)).toContain("1 saved, 0 failed");
			expect(savedPaths).toHaveLength(1);
			expect(f.opened).toHaveLength(1);
			expect(f.closed).toEqual(f.opened);
			expect(createdTabs).toBe(0);
			expect((await browser.pages()).length).toBe(initialTabs);
			return {
				markdown: await readFile(savedPaths[0]!, "utf8"),
				url: page.url(),
				origin: server.url.origin,
				navigations,
				requested,
				extractedAnchors,
			};
		} finally {
			await closeOwnedFixture();
		}
	} finally {
		await closeOwnedFixture?.();
		closePendingCrawlBrowser = undefined;
		if (!closeOwnedFixture) await server.stop(true);
	}
}

describe("crawl real DOM reading contracts", () => {
	afterEach(async () => {
		const close = closePendingCrawlBrowser;
		closePendingCrawlBrowser = undefined;
		await close?.();
	});

	it("absolutizes relative body anchors before serializing saved Markdown", async () => {
		const result = await crawlDomFixture({
			"/article/preview": `<html><head><base href="/docs/v2/"></head><body><article>
				<h1>Link resolution</h1><p>Read the <a href="../guide?mode=all&amp;lang=en#install">installation guide</a>
				and <a href="/reference">API reference</a> for complete setup instructions.</p>
			</article></body></html>`,
		});
		const guide = `${result.origin}/docs/guide?mode=all&lang=en#install`;
		expect(result.extractedAnchors).toEqual([[guide, `${result.origin}/reference`]]);
		expect(result.markdown).toContain(`[installation guide](${guide})`);
		expect(result.markdown).toContain(`[API reference](${result.origin}/reference)`);
		expect(result.navigations).toEqual([`${result.origin}/article/preview`]);
	}, 30_000);

	it("prefers an in-page expander over a later full-article navigation candidate", async () => {
		const result = await crawlDomFixture({
			"/article/preview": `<html><body><article><h1>Preferred expansion</h1>
				<p id="body">PREVIEW_ONLY</p>
				<button onclick="document.querySelector('#body').textContent='INLINE_COMPLETE_ARTICLE';this.remove()">查看全文</button>
				<a href="/navigation-candidate">阅读全文</a>
			</article></body></html>`,
			"/navigation-candidate": "<html><body>WRONG_NAVIGATION_ARTICLE</body></html>",
		});
		expect(result.markdown).toContain("INLINE_COMPLETE_ARTICLE");
		expect(result.markdown).not.toContain("PREVIEW_ONLY");
		expect(result.markdown).not.toContain("WRONG_NAVIGATION_ARTICLE");
		expect(result.navigations).toEqual([`${result.origin}/article/preview`]);
		expect(result.requested).not.toContain("/navigation-candidate");
	}, 30_000);

	it("activates the actionable ancestor of a nested full-article label", async () => {
		const result = await crawlDomFixture({
			"/article/preview": `<html><body><article><h1>Nested reading control</h1>
				<p id="body">NESTED_PREVIEW</p><button onclick="document.querySelector('#body').textContent='NESTED_COMPLETE_ARTICLE';this.remove()">
				<span><strong>展开全文</strong></span></button>
			</article></body></html>`,
		});
		expect(result.markdown).toContain("NESTED_COMPLETE_ARTICLE");
		expect(result.markdown).not.toContain("NESTED_PREVIEW");
		expect(result.navigations).toEqual([`${result.origin}/article/preview`]);
	}, 30_000);

	it("navigates a target blank full-article anchor in the same owned tab without clicking it", async () => {
		const result = await crawlDomFixture({
			"/article/preview": `<html><body><h1>Preview</h1><p>BLANK_PREVIEW</p>
				<a target="_blank" href="/article/full" onclick="fetch('/anchor-clicked')">Read the full article</a></body></html>`,
			"/article/full": "<html><body><h1>Complete article</h1><p>SAME_TAB_FULL_CONTENT</p></body></html>",
		});
		expect(result.url).toBe(`${result.origin}/article/full`);
		expect(result.navigations).toEqual([`${result.origin}/article/preview`, `${result.origin}/article/full`]);
		expect(result.markdown).toContain(`Source: ${result.origin}/article/full\n`);
		expect(result.markdown).toContain("SAME_TAB_FULL_CONTENT");
		expect(result.markdown).not.toContain("BLANK_PREVIEW");
		expect(result.requested).not.toContain("/anchor-clicked");
	}, 30_000);

	it("stops following reading links after one full article instead of chasing recommendations", async () => {
		const result = await crawlDomFixture({
			"/article/preview": `<html><body><h1>Preview</h1><a href="/article/full">阅读全文</a></body></html>`,
			"/article/full": `<html><body><article><h1>Original full article</h1><p>ORIGINAL_COMPLETE_CONTENT</p>
				<aside><h2>Recommended stories</h2><a href="/recommendation">Read more</a></aside></article></body></html>`,
			"/recommendation": "<html><body><h1>Different article</h1><p>RECOMMENDED_CONTENT</p></body></html>",
		});
		expect(result.url).toBe(`${result.origin}/article/full`);
		expect(result.navigations).toEqual([`${result.origin}/article/preview`, `${result.origin}/article/full`]);
		expect(result.requested).not.toContain("/recommendation");
		expect(result.markdown).toContain("ORIGINAL_COMPLETE_CONTENT");
		expect(result.markdown).not.toContain("RECOMMENDED_CONTENT");
		expect(result.markdown).toContain(`[Read more](${result.origin}/recommendation)`);
	}, 30_000);
});

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

	it("navigates to a hash route with its full query and saves the routed page's source", async () => {
		const url = "https://example.test/#/docs/article?id=123&next=a%3Fb%26c&tag=x&tag=y";
		const browser = scriptedPage();
		const f = fixture({ [url]: {} }, undefined, browser.run);
		await runCrawl(f.runtime, { ...options, url, recursive: false }, new AbortController().signal);
		expect(f.written.map(file => file.content)).toEqual([
			`Source: ${url}\n\n# Article title\n\nThe complete article body.\n`,
		]);
		expect(f.closed).toEqual(f.opened);
	});

	it("recurses into distinct hash routes and query variants without revisiting the same route", async () => {
		const entry = "https://example.test/#/docs/list?project=1";
		const first = "https://example.test/#/docs/article?id=1&lang=zh";
		const second = "https://example.test/#/docs/article?id=2&lang=zh";
		const other = "https://example.test/#/docs/other?id=1&lang=zh";
		const f = fixture({
			[entry]: {
				links: [
					"#/docs/article?id=1&lang=zh",
					"#/docs/article?id=2&lang=zh",
					"#/docs/other?id=1&lang=zh",
					first,
					entry,
					"https://else.test/#/docs/article?id=3&lang=zh",
				],
			},
			[first]: { links: [entry] },
			[second]: {},
			[other]: {},
		});
		await runCrawl(f.runtime, { ...options, url: entry }, new AbortController().signal);
		expect(f.written.map(file => file.content)).toEqual(
			[entry, first, second, other].map(url => `Source: ${url}\n\nReadable content\n`),
		);
		expect(f.opened).toHaveLength(4);
		expect(f.closed.sort()).toEqual(f.opened.sort());
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

	it("reports a scroll that cannot advance instead of repeatedly scrolling until the page deadline", async () => {
		const url = "https://example.test/feed";
		const browser = scriptedPage({ scrolling: { container: true, stalled: true } });
		const f = fixture({ [url]: {} }, undefined, browser.run);
		await runCrawl(f.runtime, { ...options, url, recursive: false }, new AbortController().signal);
		expect(f.written).toEqual([]);
		expect(f.output.join("\n")).toContain("Scrolling made no progress");
		expect(browser.extractionCount()).toBe(0);
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

	it("caps concurrent child pages at the requested worker count", async () => {
		const children = Array.from({ length: 5 }, (_, index) => `https://example.test/child-${index}`);
		const pages = Object.fromEntries(["https://example.test/", ...children].map(url => [url, {}]));
		const release = Promise.withResolvers<void>();
		const saturated = Promise.withResolvers<void>();
		let active = 0;
		let maximum = 0;
		const f = fixture(pages, undefined, async (_code, url) => {
			if (url !== options.url) {
				active++;
				maximum = Math.max(maximum, active);
				if (active === 2) saturated.resolve();
				await release.promise;
				active--;
			}
			return {
				url,
				status: 200,
				contentType: "text/html",
				attachment: false,
				info: { url, links: url === options.url ? children : [], contentType: "text/html", login: false },
				markdown: `Content for ${url}`,
				endUrl: url,
			};
		});
		const running = runCrawl(f.runtime, options, new AbortController().signal);
		try {
			await saturated.promise;
			expect(active).toBe(2);
			expect(maximum).toBe(2);
		} finally {
			release.resolve();
			await running;
		}
		expect(maximum).toBe(2);
		expect(f.written).toHaveLength(6);
		expect(f.closed.sort()).toEqual(f.opened.sort());
	});

	it("retains saved pages on cancellation and restarts from the entry without resuming its queue", async () => {
		const controller = new AbortController();
		let cancelChildren = true;
		const f = fixture(
			{
				[options.url]: { links: ["https://example.test/child"] },
				"https://example.test/child": {},
			},
			url => {
				if (cancelChildren && url !== options.url) controller.abort();
			},
		);
		await runCrawl(f.runtime, options, controller.signal);
		expect(f.written.map(file => file.content)).toEqual([`Source: ${options.url}\n\nReadable content\n`]);
		expect(f.output.at(-1)).toContain("Crawl cancelled: 1 saved, 0 failed; saved files retained.");
		cancelChildren = false;
		await runCrawl(f.runtime, { ...options, recursive: false }, new AbortController().signal);
		expect(f.written.map(file => file.content)).toEqual([
			`Source: ${options.url}\n\nReadable content\n`,
			`Source: ${options.url}\n\nReadable content\n`,
		]);
		expect(f.closed.sort()).toEqual(f.opened.sort());
	});

	it("uses only owned Relay tabs and never adopts or focuses user tabs", async () => {
		const f = fixture({ "https://example.test/": {} });
		await runCrawl(f.runtime, { ...options, recursive: false }, new AbortController().signal);
		expect(f.requests.map(request => request.action)).toEqual(["open", "run", "close"]);
		expect(f.requests[0]).toMatchObject({ url: "about:blank", app: "relay" });
		expect(new Set(f.requests.map(request => request.name)).size).toBe(1);
		expect(f.requests[0]?.name).toMatch(/^crawl-/);
		expect(f.written).toHaveLength(1);
	});

	it("discovers links after scrolling and also reads and scrolls recursive child pages", async () => {
		const child = "https://example.test/child";
		const rootPage = scriptedPage({ scrolling: {}, links: batches => (batches >= 3 ? [child, child] : []) });
		const childPage = scriptedPage({ scrolling: { container: true }, fullArticle: { label: "阅读全文" } });
		const f = fixture({ [options.url]: {}, [child]: {} }, undefined, (code, url) =>
			(url === options.url ? rootPage : childPage).run(code),
		);
		await runCrawl(f.runtime, options, new AbortController().signal);
		expect(f.written).toHaveLength(2);
		expect(f.written[1]?.content).toContain(`Source: ${child}\n`);
		expect(f.written[1]?.content).toContain("The complete article body.");
		expect(f.written[1]?.content).toContain("Lazy section 3");
		expect(f.closed.sort()).toEqual(f.opened.sort());
	});

	it.each(["disabled", "download"] as const)(
		"fails an unavailable full-article control (%s) without clicking or saving its preview",
		async boundary => {
			let clicks = 0;
			const browser = scriptedPage({
				fullArticle: {
					url: "https://example.test/full",
					[boundary]: true,
					onClick: () => clicks++,
				},
			});
			const f = fixture({ [options.url]: {} }, undefined, browser.run);
			await runCrawl(f.runtime, { ...options, recursive: false }, new AbortController().signal);
			expect(f.written).toEqual([]);
			expect(clicks).toBe(0);
			expect(f.output.join("\n")).toContain(boundary === "disabled" ? "disabled" : "download");
			expect(f.closed).toEqual(f.opened);
		},
	);

	it("does not wait for a persistent event stream to end before saving stable rendered content", async () => {
		const browser = scriptedPage({ requestUrl: "https://api.example.test/events", eventStream: true });
		const f = fixture({ [options.url]: {} }, undefined, browser.run);
		await runCrawl(f.runtime, { ...options, recursive: false }, new AbortController().signal);
		expect(f.written).toHaveLength(1);
		expect(f.written[0]?.content).toContain("The complete article body.");
		expect(f.output.at(-1)).toContain("1 saved, 0 failed");
		expect(browser.detachmentCount()).toBe(1);
		expect(f.closed).toEqual(f.opened);
	});

	it.each(["查看全文", "阅读全文", "显示全文", "继续阅读", "Read more", "Read the full article", "Continue reading"])(
		"reads an explicit full-article control labelled %s without scroll opt-in",
		async label => {
			const url = "https://example.test/article";
			const browser = scriptedPage({ fullArticle: { label } });
			const f = fixture({ [url]: {} }, undefined, browser.run);
			await runCrawl(f.runtime, { ...options, url, recursive: false, scroll: false }, new AbortController().signal);
			expect(f.written[0]?.content).toContain("The complete article body.");
			expect(f.written[0]?.content).not.toContain("Preview only");
			expect(browser.detachmentCount()).toBe(1);
		},
	);

	it("navigates to cross-origin full text in its owned tab and records the final source", async () => {
		const url = "https://example.test/preview";
		const full = "https://articles.test/full";
		let clicks = 0;
		const browser = scriptedPage({ fullArticle: { url: full, onClick: () => clicks++ } });
		const f = fixture({ [url]: {} }, undefined, browser.run);
		await runCrawl(f.runtime, { ...options, url, recursive: false }, new AbortController().signal);
		expect(f.written[0]?.content).toContain(`Source: ${full}\n`);
		expect(f.written[0]?.content).toContain("The complete article body.");
		expect(f.opened).toHaveLength(1);
		expect(clicks).toBe(0);
		expect(f.closed).toEqual(f.opened);
	});

	it.each(["mailto:owner@example.test", "file:///private/full"])(
		"refuses a non-web full-article target %s without saving a preview",
		async full => {
			const url = "https://example.test/preview";
			let clicks = 0;
			const browser = scriptedPage({ fullArticle: { url: full, onClick: () => clicks++ } });
			const f = fixture({ [url]: {} }, undefined, browser.run);
			await runCrawl(f.runtime, { ...options, url, recursive: false }, new AbortController().signal);
			expect(f.written).toEqual([]);
			expect(clicks).toBe(0);
			expect(f.output.join("\n")).toContain("not an HTTP or HTTPS webpage");
			expect(f.closed).toEqual(f.opened);
		},
	);

	it.each(["加载更多", "Like", "Submit", "评论"])(
		"never activates an unrelated business control labelled %s",
		async label => {
			let clicks = 0;
			const url = "https://example.test/dashboard";
			const browser = scriptedPage({ fullArticle: { label, onClick: () => clicks++ } });
			const f = fixture({ [url]: {} }, undefined, browser.run);
			await runCrawl(f.runtime, { ...options, url, recursive: false }, new AbortController().signal);
			expect(clicks).toBe(0);
			expect(f.written).toHaveLength(1);
			expect(f.closed).toEqual(f.opened);
		},
	);

	it("waits at least the default five seconds before extracting lazy content", async () => {
		const url = "https://example.test/feed";
		const browser = scriptedPage({ scrolling: {} });
		const f = fixture({ [url]: {} }, undefined, browser.run);
		await runCrawl(f.runtime, { ...options, url, recursive: false }, new AbortController().signal);
		expect(browser.elapsed()).toBeGreaterThanOrEqual(5_000);
		expect(f.written[0]?.content).toContain("Lazy section 3");
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
