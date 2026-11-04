import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { Browser } from "puppeteer-core";
import { loadOpenWikiVendor } from "../../src/openwiki/vendor-loader";
import { getOpenWikiVisualAssets } from "../../src/openwiki/visual-assets";
import { closeLaunchedBrowser, ensureChromiumExecutable, loadPuppeteer } from "../../src/tools/browser/launch";

let closePendingWikiBrowser: (() => Promise<void>) | undefined;

describe("OMP OpenWiki real browser consumer", () => {
	afterEach(async () => {
		const close = closePendingWikiBrowser;
		closePendingWikiBrowser = undefined;
		await close?.();
	});

	// Both modes run the shipped browser modules, not source-string assertions.
	it.each(["live", "static"] as const)(
		"renders graph, Markdown, links and Mermaid in %s mode",
		async mode => {
			using dir = TempDir.createSync("@omp-openwiki-browser-");
			const wikiRoot = dir.join("openwiki");
			await mkdir(wikiRoot);
			const quickstart =
				"---\ntitle: Quickstart\ntype: Guide\n---\n# Quickstart\n\nSee [Architecture](architecture.md).\n";
			const architecture =
				"---\ntitle: Architecture\ntype: Guide\n---\n# Architecture\n\n**BROWSER_READER_BEACON**\n\n```mermaid\ngraph TD\nA[Source] --> B[Wiki]\n```\n";
			await writeFile(path.join(wikiRoot, "quickstart.md"), quickstart);
			await writeFile(path.join(wikiRoot, "architecture.md"), architecture);
			const executablePath = await ensureChromiumExecutable();
			if (!executablePath)
				throw new Error("OpenWiki browser acceptance requires a locally available Chromium executable");
			const puppeteer = await loadPuppeteer();
			const profile = dir.join("browser-profile");
			const home = dir.join("home");
			// SHGetFolderPath verifies %USERPROFILE%\AppData\Local on Windows,
			// independently of LOCALAPPDATA; both must resolve to an existing private folder.
			const config = dir.join("home", "AppData", "Roaming");
			const cache = dir.join("cache");
			const data = dir.join("home", "AppData", "Local");
			const temp = dir.join("tmp");
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
			let closeServer: (() => Promise<void>) | undefined;
			let closePromise: Promise<void> | undefined;
			const closeOwnedFixture = () =>
				(closePromise ??= (async () => {
					if (launchedBrowser) await closeLaunchedBrowser(launchedBrowser);
					else launchAbort.abort();
					await closeServer?.();
				})());
			// Bun's test deadline can interrupt launch without entering its finally.
			closePendingWikiBrowser = closeOwnedFixture;
			const browser = await puppeteer
				.launch({
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
				})
				.catch(async error => {
					await closeOwnedFixture();
					closePendingWikiBrowser = undefined;
					throw error;
				});
			launchedBrowser = browser;
			try {
				const vendor = await loadOpenWikiVendor();
				const assets = await getOpenWikiVisualAssets();
				let url: string;
				if (mode === "live") {
					const server = await vendor.startEmbeddedVisualizeServer({ wikiRoot, port: 0, open: false, assets });
					url = server.url;
					closeServer = server.close;
				} else {
					const outputDir = dir.join("export");
					await vendor.exportStaticVisualizer({ wikiRoot, outputDir, assets });
					const server = Bun.serve({
						hostname: "127.0.0.1",
						port: 0,
						fetch(request) {
							const pathname = new URL(request.url).pathname;
							if (!pathname.startsWith("/docs/wiki/")) return new Response("not found", { status: 404 });
							const name = pathname.slice("/docs/wiki/".length);
							if (name.includes("..") || name.includes("/")) return new Response("not found", { status: 404 });
							return new Response(Bun.file(path.join(outputDir, name || "index.html")));
						},
					});
					url = `http://127.0.0.1:${server.port}/docs/wiki/index.html`;
					closeServer = async () => {
						await server.stop(true);
					};
				}
				const page = await browser.newPage();
				const external: string[] = [];
				const requested: string[] = [];
				await page.setRequestInterception(true);
				page.on("request", request => {
					requested.push(new URL(request.url()).pathname);
					if (new URL(request.url()).hostname !== "127.0.0.1") {
						external.push(request.url());
						void request.abort();
					} else void request.continue();
				});
				await page.goto(url, { waitUntil: "domcontentloaded" });
				await page.waitForSelector('#sidebar button[data-id="quickstart"]');
				await page.waitForSelector("#graph canvas");
				expect(await page.$$eval("#sidebar button.nav-item", buttons => buttons.length)).toBe(2);
				await page.click('#sidebar button[data-id="quickstart"]');
				await page.waitForSelector('#detail a.wikilink[href="architecture.md"]');
				await page.click('#detail a.wikilink[href="architecture.md"]');
				await page.waitForSelector("#detail .mermaid svg");
				expect(await page.$eval("#detail .doc-title", element => element.textContent)).toBe("Architecture");
				expect(await page.$eval("#detail .md strong", element => element.textContent)).toBe(
					"BROWSER_READER_BEACON",
				);
				if (mode === "live") {
					await writeFile(
						path.join(wikiRoot, "architecture.md"),
						architecture.replace("BROWSER_READER_BEACON", "BROWSER_REFRESHED_BEACON"),
					);
					await page.waitForFunction(
						'document.querySelector("#detail .md strong")?.textContent === "BROWSER_REFRESHED_BEACON"',
					);
					expect(requested).toContain("/events");
				} else {
					expect(requested).toContain("/docs/wiki/graph.json");
					expect(requested).not.toContain("/events");
					expect(requested).not.toContain("/api/graph");
				}
				expect(external).toEqual([]);
			} finally {
				await closeOwnedFixture();
				closePendingWikiBrowser = undefined;
			}
		},
		45_000,
	);
});
