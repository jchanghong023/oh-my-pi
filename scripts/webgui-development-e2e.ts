#!/usr/bin/env bun
// Opt-in production acceptance. Never builds, installs, downloads, or uses a mock executor.
// CLI: bun scripts/webgui-development-e2e.ts --browser both --chrome PATH --firefox PATH
// Parents may pass a native-resolved authorized credential in memory to runDevelopmentE2E.
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Readable } from "node:stream";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import { requireGit } from "@oh-my-pi/pi-natives/vcs";
import { withTimeout } from "@oh-my-pi/pi-utils";
import type { Browser, ElementHandle, KeyInput, Page } from "puppeteer-core";
import {
	closeLaunchedBrowser,
	launchHeadlessBrowser,
	removeUserDataDir,
} from "../packages/coding-agent/src/tools/browser/launch";
import { findUserDataDirInArgs, gracefulKillTreeOnce } from "../packages/coding-agent/src/tools/browser/attach";
import { initializeRepository } from "../packages/coding-agent/test/dev-workbench/fixture";
import {
	PlatformPrerequisiteError,
	validateDirectUrl,
	withFirefoxBrowser,
	type DevelopmentBrowser,
	type DevelopmentPage,
} from "./webgui-platform-smoke";
import {
	DEVELOPMENT_MATRIX,
	observe,
	runDevelopmentScenarios,
	type DevelopmentContext,
	type Evidence,
	type NativeRecord,
	type NativeTranscript,
	type ScenarioResult,
} from "./webgui-development-scenarios";

export interface DevelopmentE2EOptions {
	browser: "chrome" | "firefox" | "both";
	chrome?: string;
	firefox?: string;
	headless?: boolean;
	evidenceDir?: string;
	timeoutMs?: number;
	/** Existing production build; the runner never generates or modifies it. */
	productionDir?: string;
	/** Optional attachment to a parent-owned, isolated real CLI. No cleanup of that parent is attempted. */
	url?: string;
	attachedContext?: {
		root: string;
		agentDir: string;
		projectA: string;
		projectB: string;
		createdProject: string;
		stop(): Promise<Evidence>;
	};
}
export interface DevelopmentAuthorization {
	credential?: string;
}
interface ResourceIdentity {
	path: string;
	size: number;
	sha256: string;
	mime?: string;
}
interface BrowserReport {
	browser: "chrome" | "firefox";
	status: "passed" | "failed" | "blocked";
	identity?: Record<string, unknown>;
	isolation?: Record<string, unknown>;
	productionResources?: ResourceIdentity[];
	actuallyLoadedResources?: ResourceIdentity[];
	nativeDownloads?: ResourceIdentity[];
	auxiliaryFailurePaths?: { status: "unobserved-by-this-runner"; sources: string[] };
	model: Record<string, unknown>;
	scenarios: ScenarioResult[];
	cleanup?: Evidence;
	browserCleanup?: Evidence;
	error?: string;
}
interface NativeDevelopmentContextHandle {
	context: DevelopmentContext;
	cleanup(): Promise<Evidence>;
}
const repository = path.resolve(import.meta.dir, "..");
const digest = (value: Uint8Array | string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
async function filesUnder(root: string): Promise<string[]> {
	const found: string[] = [];
	for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
		const file = path.join(root, entry.name);
		if (entry.isDirectory()) found.push(...(await filesUnder(file)));
		else if (entry.isFile()) found.push(file);
	}
	return found;
}
async function installed(file: string | undefined, prerequisite: string): Promise<string> {
	if (
		!file ||
		!(await fs.stat(file).then(
			value => value.isFile(),
			() => false,
		))
	)
		throw new PlatformPrerequisiteError(
			prerequisite,
			`An installed executable is required: ${file ?? "not supplied"}; downloads are disabled`,
		);
	return path.resolve(file);
}
async function productionIdentity(root: string): Promise<ResourceIdentity[]> {
	const files = await filesUnder(root);
	if (!files.some(file => path.basename(file) === "index.html"))
		throw new PlatformPrerequisiteError(
			"production-assets",
			`Existing production WebGUI index.html required in ${root}; build separately, never inside this runner`,
		);
	return Promise.all(
		files.sort().map(async file => {
			const bytes = await fs.readFile(file);
			return { path: path.relative(root, file).replaceAll("\\", "/"), size: bytes.length, sha256: digest(bytes) };
		}),
	);
}
async function loadedIdentity(
	page: DevelopmentPage,
	url: string,
	source: ResourceIdentity[],
): Promise<ResourceIdentity[]> {
	const names = await page.evaluate<string[]>(
		"(function(){var names=Array.prototype.map.call(document.querySelectorAll('script[src],link[rel=stylesheet]'),function(e){return e.src||e.href;});return names.concat(performance.getEntriesByType('resource').map(function(e){return e.name;}));})()",
	);
	const origin = new URL(url).origin;
	const expected = new Map(source.map(resource => [resource.path, resource]));
	const resources: ResourceIdentity[] = [];
	for (const name of new Set([url, ...names])) {
		const address = new URL(name, url);
		if (address.origin !== origin) continue;
		const relative = address.pathname.replace(/^\//, "") || "index.html";
		const local =
			expected.get(relative) ??
			(address.pathname === new URL(url).pathname ? expected.get("index.html") : undefined);
		if (!local) continue; // HTTP/WS business responses are not static resources.
		const response = await fetch(address, { signal: AbortSignal.timeout(30_000) });
		if (!response.ok)
			throw new Error(`Actually loaded production resource now fails: ${address.pathname}: ${response.status}`);
		const bytes = new Uint8Array(await response.arrayBuffer());
		if (digest(bytes) !== local.sha256)
			throw new Error(`Production resource bytes do not match build: ${local.path}`);
		const mime = response.headers.get("content-type") ?? "";
		if (
			(/\.m?js$/.test(local.path) && !/javascript/.test(mime)) ||
			(/\.css$/.test(local.path) && !/text\/css/.test(mime))
		)
			throw new Error(`Wrong production resource MIME: ${local.path}: ${mime}`);
		resources.push({ ...local, mime });
	}
	if (
		!resources.some(resource => /\.js$/.test(resource.path)) ||
		!resources.some(resource => /\.css$/.test(resource.path))
	)
		throw new Error("Browser did not actually load matching production JavaScript and CSS");
	return resources;
}
function chromePage(page: Page, exclusive: <T>(operation: () => Promise<T>) => Promise<T>): DevelopmentPage {
	// Puppeteer's native click awaits an IntersectionObserver during scrolling.
	// A background tab may never deliver it; select the actual tab, then keep
	// selection and its complete native interaction atomic across all pages.
	const selected = <T>(operation: () => Promise<T>) =>
		exclusive(async () => {
			await page.bringToFront();
			return operation();
		});
	const wrapper: DevelopmentPage = {
		navigate: url =>
			selected(async () => {
				await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
			}),
		reload: () =>
			selected(async () => {
				await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
			}),
		evaluate: expression => selected(() => page.evaluate(expression)),
		hover: selector => selected(() => page.hover(selector)),
		click: selector =>
			selected(async () => {
				try {
					await page.locator(selector).click();
				} catch (error) {
					const controls = await withTimeout(
						page.evaluate(
							`(function(){return Array.prototype.slice.call(document.querySelectorAll(${JSON.stringify(selector)}),0,6).map(function(e){var r=e.getBoundingClientRect();var question=e.closest('[data-interaction-id]');return {tag:e.tagName,text:(e.textContent||'').slice(0,1000),role:e.getAttribute('role'),selected:e.getAttribute('aria-selected'),disabled:e.matches(':disabled'),visibility:getComputedStyle(e).visibility,rect:{x:r.x,y:r.y,width:r.width,height:r.height},interactionId:question&&question.getAttribute('data-interaction-id'),interactionBusy:question&&question.getAttribute('aria-busy')};});})()`,
						),
						5000,
						"Failed native click DOM context",
					).catch(diagnostic => ({ diagnosticError: String(diagnostic).slice(0, 1000) }));
					throw new Error(
						`Native Chrome click failed; selector=${selector}; controls=${JSON.stringify(controls)}; cause=${String(error)}`,
						{ cause: error },
					);
				}
			}),
		type: (selector, text) =>
			selected(async () => {
				await page.locator(selector).click();
				// Native insertion avoids key bindings for literal text (including tabs).
				// Newlines must be explicit Shift+Enter, never an implicit Send key.
				const lines = text.replace(/\r\n?/g, "\n").split("\n");
				for (let index = 0; index < lines.length; index++) {
					if (index) {
						await page.keyboard.down("Shift");
						try {
							await page.keyboard.press("Enter");
						} finally {
							await page.keyboard.up("Shift");
						}
					}
					if (lines[index]) await page.keyboard.sendCharacter(lines[index]!);
				}
			}),
		clear: selector =>
			selected(async () => {
				await page.locator(selector).click();
				await page.keyboard.down(process.platform === "darwin" ? "Meta" : "Control");
				await page.keyboard.press("KeyA");
				await page.keyboard.up(process.platform === "darwin" ? "Meta" : "Control");
				await page.keyboard.press("Backspace");
			}),
		press: (selector, key) =>
			selected(async () => {
				await page.locator(selector).click();
				await page.keyboard.press(key as KeyInput);
			}),
		upload: (selector, files) =>
			selected(async () => {
				const input = await page.$(selector);
				if (!input) throw new Error(`File upload control absent: ${selector}`);
				try {
					await (input as ElementHandle<HTMLInputElement>).uploadFile(...files);
				} finally {
					await input.dispose();
				}
			}),
		screenshot: file =>
			selected(async () => {
				await page.screenshot({ path: file, fullPage: true });
			}),
		draw: (selector, points) =>
			selected(async () => {
				if (points.length < 2) throw new Error("A real canvas stroke requires at least two points");
				const rectangle = await page.evaluate<{ left: number; top: number }>(
					`(function(){var r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {left:r.left,top:r.top};})()`,
				);
				await page.mouse.move(rectangle.left + points[0]!.x, rectangle.top + points[0]!.y);
				await page.mouse.down();
				try {
					for (const point of points.slice(1))
						await page.mouse.move(rectangle.left + point.x, rectangle.top + point.y, { steps: 8 });
				} finally {
					await page.mouse.up();
				}
			}),
		close: () =>
			exclusive(async () => {
				if (!page.isClosed()) await page.close();
			}),
		typeDraft: text => wrapper.type('[data-testid="v4-composer-input"]', text),
		clearDraft: () => wrapper.clear('[data-testid="v4-composer-input"]'),
	};
	return wrapper;
}
function failureText(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	const nested = error instanceof AggregateError ? Array.from(error.errors, failureText) : [];
	if (error.cause !== undefined) nested.push(`Caused by: ${failureText(error.cause)}`);
	return [error.stack ?? String(error), ...nested].join("\n");
}
/** Observe Puppeteer's opt-in dumpio streams without replacing process stdio. */
async function captureChromeStartup<T>(
	output: { stdout: string; stderr: string },
	launch: () => Promise<T>,
): Promise<T> {
	const listeners: Array<{ source: Readable; listener: (chunk: Buffer | string) => void }> = [];
	const observe = (kind: keyof typeof output) => (source: Readable) => {
		const listener = (chunk: Buffer | string) => {
			output[kind] = (output[kind] + chunk.toString()).slice(-16_384);
		};
		source.on("data", listener);
		listeners.push({ source, listener });
	};
	const stdoutPipe = observe("stdout");
	const stderrPipe = observe("stderr");
	process.stdout.on("pipe", stdoutPipe);
	process.stderr.on("pipe", stderrPipe);
	try {
		return await launch();
	} finally {
		process.stdout.off("pipe", stdoutPipe);
		process.stderr.off("pipe", stderrPipe);
		for (const { source, listener } of listeners) source.off("data", listener);
	}
}
async function withChrome<T>(
	options: DevelopmentE2EOptions,
	run: (browser: DevelopmentBrowser) => Promise<T>,
	recordCleanup: (evidence: Evidence) => void,
): Promise<T> {
	const executable = await installed(options.chrome, "chrome-executable");
	const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-development-chrome-"));
	let browser: Browser | undefined;
	let launchStarted = false;
	let endpoint: string | undefined;
	let result!: T;
	const failures: unknown[] = [];
	let pid: number | undefined;
	const diagnostics: Array<{ type: string; url: string; message: string }> = [];
	const startupOutput = { stdout: "", stderr: "" };
	const wrappers = new WeakMap<Page, DevelopmentPage>();
	// Chrome's foreground selection is browser-global, just like Marionette's
	// selected window. Never interleave another tab's activation with input.
	let pendingOperation = Promise.resolve();
	const exclusive = <T>(operation: () => Promise<T>): Promise<T> => {
		const result = pendingOperation.then(operation);
		pendingOperation = result.then(
			() => {},
			() => {},
		);
		return result;
	};
	const downloadDirectory = path.join(options.evidenceDir ?? profile, "downloads");
	try {
		await fs.mkdir(downloadDirectory, { recursive: true });
		for (const directory of ["home", "appdata", "localappdata", "tmp"])
			await fs.mkdir(path.join(profile, directory), { recursive: true });
		// The central launcher owns transport/lifecycle behavior; an explicit executable
		// bypasses its resolver and all download paths without changing global settings.
		launchStarted = true;
		const launched = await captureChromeStartup(startupOutput, () =>
			launchHeadlessBrowser({
				executablePath: executable,
				env: chromeEnvironment(profile),
				dumpio: true,
				headless: options.headless ?? true,
				viewport: { width: 1440, height: 1000 },
				args: [`--user-data-dir=${profile}`],
			}),
		);
		browser = launched.browser;
		endpoint = launched.wsEndpoint;
		pid = browser.process()?.pid;
		const cdp = await browser.target().createCDPSession();
		await cdp.send("Browser.setDownloadBehavior", {
			behavior: "allow",
			downloadPath: downloadDirectory,
			eventsEnabled: true,
		});
		await cdp.detach();
		const prepare = async (page: Page) => {
			const existing = wrappers.get(page);
			if (existing) return existing;
			page.on("pageerror", error =>
				diagnostics.push({ type: "pageerror", url: page.url(), message: String(error) }),
			);
			page.on("requestfailed", request =>
				diagnostics.push({
					type: "requestfailed",
					url: request.url(),
					message: request.failure()?.errorText ?? "",
				}),
			);
			const wrapper = chromePage(page, exclusive);
			wrappers.set(page, wrapper);
			return wrapper;
		};
		const page = await browser.newPage();
		const userAgent = await page.evaluate(() => navigator.userAgent);
		const version = await browser.version();
		if (!/Chrome\//.test(userAgent) || /Edg\/|Chromium\//.test(userAgent) || !/chrome(?:\.exe)?$/i.test(executable))
			throw new PlatformPrerequisiteError(
				"actual-chrome",
				`Installed Google Chrome required, not Chromium/Edge: ${executable}; ${version}`,
			);
		result = await run({
			page: await prepare(page),
			identity: {
				executable,
				version,
				userAgent,
				profile,
				downloadDirectory,
				isolatedProfile: true,
				pid,
				endpoint,
				diagnostics,
			},
			newPage: () => exclusive(async () => prepare(await browser!.newPage())),
			pages: () => exclusive(async () => Promise.all((await browser!.pages()).map(prepare))),
		});
	} catch (error) {
		failures.unshift(error);
	} finally {
		let settled = !launchStarted;
		if (browser) {
			try {
				await closeLaunchedBrowser(browser, { strict: true });
				settled = true;
			} catch (error) {
				failures.push(error);
			}
		}
		if (launchStarted && !browser) {
			try {
				// Puppeteer may reject before returning its Browser and close asynchronously.
				// Only the exact executable with our fresh, uniquely owned profile is ours.
				const processes = Process.fromPath(executable).filter(
					process => findUserDataDirInArgs(process.args()) === profile,
				);
				pid ??= processes[0]?.pid;
				const visited = new Set(processes.map(process => process.pid));
				for (let index = 0; index < processes.length; index++) {
					for (const child of processes[index]!.children()) {
						if (visited.has(child.pid)) continue;
						visited.add(child.pid);
						processes.push(child);
					}
				}
				for (const process of processes) {
					if (await process.waitForExit({ timeoutMs: 0 })) continue;
					if (!(await process.terminate({ gracefulMs: 2000, timeoutMs: 500 })))
						throw new Error(`Owned Chrome startup process ${process.pid} did not exit`);
				}
				if (Process.fromPath(executable).some(process => findUserDataDirInArgs(process.args()) === profile))
					throw new Error(`Owned Chrome profile still has a running process: ${profile}`);
				settled = true;
			} catch (error) {
				failures.push(error);
			}
		}
		let profileRemoved = false;
		if (settled) {
			try {
				await removeUserDataDir(profile, { strict: true });
				profileRemoved = true;
			} catch (error) {
				failures.push(error);
			}
		}
		recordCleanup({
			executable,
			profile,
			pid,
			endpoint,
			startupOutput,
			ownedProcessExited: settled,
			profileRemoved,
			...(failures.length ? { failures: failures.map(failureText) } : {}),
		});
	}
	if (failures.length === 1) throw failures[0];
	if (failures.length) throw new AggregateError(failures, "Chrome acceptance or owned cleanup failed");
	return result;
}
function isolatedEnvironment(root: string, credential: string): Record<string, string> {
	const environment: Record<string, string> = {};
	for (const key of [
		"PATH",
		"Path",
		"PATHEXT",
		"SystemRoot",
		"SYSTEMROOT",
		"WINDIR",
		"COMSPEC",
		"TEMP",
		"TMP",
		"LANG",
		"LC_ALL",
		"TERM",
		"NUMBER_OF_PROCESSORS",
		"PROCESSOR_ARCHITECTURE",
	])
		if (process.env[key]) environment[key] = process.env[key]!;
	return {
		...environment,
		HOME: path.join(root, "home"),
		USERPROFILE: path.join(root, "home"),
		APPDATA: path.join(root, "appdata"),
		LOCALAPPDATA: path.join(root, "localappdata"),
		TEMP: path.join(root, "tmp"),
		TMP: path.join(root, "tmp"),
		TMPDIR: path.join(root, "tmp"),
		OMP_CONFIG_ROOT: path.join(root, "config"),
		OMP_WEBGUI_NO_OPEN: "1",
		OPENCODE_API_KEY: credential,
		GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"),
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
		PUPPETEER_SKIP_DOWNLOAD: "true",
		PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
		BUN_INSTALL_CACHE_DIR: path.join(root, "bun-cache"),
	};
}
function nonSecretEnvironment(root: string): Record<string, string> {
	const environment = isolatedEnvironment(root, "");
	delete environment.OPENCODE_API_KEY;
	return environment;
}
/**
 * Chrome compares Windows known folders with the actual OS account directories.
 * Replacing those identities can make a fresh explicit profile look like the
 * default profile and disable DevTools. Keep only non-secret OS variables;
 * --user-data-dir still isolates every Chrome preference, session and extension.
 * Native OMP and Firefox retain their existing isolated environments.
 */
function chromeEnvironment(root: string): Record<string, string> {
	const environment: Record<string, string> = {
		HOME: path.join(root, "home"),
		TEMP: path.join(root, "tmp"),
		TMP: path.join(root, "tmp"),
		TMPDIR: path.join(root, "tmp"),
	};
	const allowed = new Set([
		"PATH",
		"PATHEXT",
		"SYSTEMROOT",
		"WINDIR",
		"COMSPEC",
		"LANG",
		"LC_ALL",
		"NUMBER_OF_PROCESSORS",
		"PROCESSOR_ARCHITECTURE",
		...(process.platform === "win32"
			? [
					"HOME",
					"USERPROFILE",
					"APPDATA",
					"LOCALAPPDATA",
					"SYSTEMDRIVE",
					"PROGRAMFILES",
					"PROGRAMFILES(X86)",
					"PROGRAMW6432",
					"COMMONPROGRAMFILES",
					"COMMONPROGRAMFILES(X86)",
					"COMMONPROGRAMW6432",
					"PROGRAMDATA",
					"ALLUSERSPROFILE",
					"HOMEDRIVE",
					"HOMEPATH",
					"USERNAME",
					"USERDOMAIN",
					"COMPUTERNAME",
					"OS",
					"PROCESSOR_ARCHITEW6432",
				]
			: []),
	]);
	// Windows environment names are case-insensitive; emit one spelling per key.
	const inherited = new Set<string>();
	for (const [key, value] of Object.entries(process.env)) {
		const canonical = key.toUpperCase();
		if (!allowed.has(canonical) || inherited.has(canonical) || value === undefined) continue;
		environment[canonical] = value;
		inherited.add(canonical);
	}
	return environment;
}
async function fixtureProject(directory: string): Promise<void> {
	await fs.mkdir(directory, { recursive: true });
	await fs.writeFile(path.join(directory, "README.txt"), "Isolated real WebGUI development acceptance workspace.\n");
	const skill = path.join(directory, ".omp", "skills", "acceptance-local", "SKILL.md");
	await fs.mkdir(path.dirname(skill), { recursive: true });
	await fs.writeFile(
		skill,
		`---\nname: acceptance-local\ndescription: Native acceptance local skill\n---\nUse the native write tool in the selected project to create skill-result.txt containing exactly native-effective-skill-${crypto.randomUUID()}.\n`,
	);
	await initializeRepository(directory);
	const repository = requireGit(directory);
	await repository.stageFiles(["README.txt"]);
	await repository.commitCreate("Isolated acceptance fixture", {});
}
async function readTranscripts(agentDir: string): Promise<NativeTranscript[]> {
	const transcripts: NativeTranscript[] = [];
	for (const file of (await filesUnder(agentDir)).filter(file => file.endsWith(".jsonl"))) {
		const lines = (await fs.readFile(file, "utf8")).split(/\r?\n/).filter(Boolean);
		const entries: NativeRecord[] = [];
		for (let index = 0; index < lines.length; index++) {
			try {
				entries.push(JSON.parse(lines[index]!) as NativeRecord);
			} catch (error) {
				if (index !== lines.length - 1) throw error;
			} // A concurrent append may have one incomplete trailing line.
		}
		const headerIndex = entries.findIndex(entry => entry.type === "session");
		if (headerIndex >= 0)
			transcripts.push({ file, header: entries[headerIndex]!, entries: entries.slice(headerIndex + 1) });
	}
	return transcripts;
}
function ownedProcessTree(pid: number): Process[] {
	const root = Process.fromPid(pid);
	if (!root) return [];
	const queue = [root];
	const seen = new Set<number>();
	const processes: Process[] = [];
	while (queue.length) {
		const current = queue.pop()!;
		if (seen.has(current.pid)) continue;
		seen.add(current.pid);
		processes.push(current);
		queue.push(...current.children());
	}
	return processes;
}
/** A single explicit negative HTTP fixture; every successful reply is upstream Beam bytes. */
function createRetryFaultRelay(model: DevelopmentContext["model"]) {
	const bundled = getBundledModels("opencode-go").find(
		candidate => candidate.provider === model.provider && candidate.id === model.id,
	);
	if (!bundled) throw new Error("Retry fixture requires the authoritative bundled Beam Free endpoint");
	const upstream = new URL(bundled.baseUrl);
	let targetSession: string | undefined;
	let injectedRequests = 0;
	const requests: Evidence[] = [];
	const marker = `acceptance-one-request-transport-fault-${crypto.randomUUID()}`;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const incoming = new URL(request.url);
			const url = new URL(`${incoming.pathname}${incoming.search}`, upstream.origin);
			const bytes = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
			let requestedModel: string | undefined;
			const payload = bytes ? new TextDecoder().decode(bytes) : "";
			if (bytes) {
				try {
					requestedModel = (JSON.parse(payload) as { model?: string }).model;
				} catch {
					// Non-inference endpoints are transparently forwarded, not interpreted.
				}
			}
			const sessionId = request.headers.get("x-opencode-session");
			const identity = {
				method: request.method,
				upstream: url.href,
				sessionId,
				nativeSessionIdFromInput: targetSession && payload.includes(targetSession) ? targetSession : undefined,
				model: requestedModel,
				...(bytes ? { requestSha256: digest(new Uint8Array(bytes)) } : {}),
			};
			if (
				targetSession &&
				identity.nativeSessionIdFromInput === targetSession &&
				requestedModel === model.id &&
				injectedRequests === 0
			) {
				injectedRequests++;
				requests.push({ ...identity, outcome: "explicit-negative-http-fixture", status: 400, marker });
				return Response.json(
					{ error: { message: marker, type: "invalid_request_error", code: "acceptance_transport_fault" } },
					{ status: 400 },
				);
			}
			const headers = new Headers(request.headers);
			headers.delete("host");
			headers.delete("content-length");
			const response = await fetch(url, { method: request.method, headers, body: bytes, signal: request.signal });
			requests.push({ ...identity, outcome: "real-provider-forwarded", status: response.status });
			const responseHeaders = new Headers(response.headers);
			// fetch exposes decoded bytes; Bun supplies their transfer framing.
			for (const name of ["content-length", "content-encoding", "transfer-encoding", "connection"])
				responseHeaders.delete(name);
			return new Response(response.body, { status: response.status, headers: responseHeaders });
		},
	});
	return {
		baseUrl: `${server.url.origin}${upstream.pathname.replace(/\/$/, "")}`,
		fixture: {
			arm(sessionId: string) {
				if (targetSession || injectedRequests)
					throw new Error("The one-request negative fixture cannot be rearmed");
				targetSession = sessionId;
			},
			evidence: () => ({
				marker,
				injectedRequests,
				requests: [...requests],
				positiveReplies: "unmodified-real-provider-streams",
			}),
		},
		close: () => server.stop(true),
	};
}
async function startContext(
	options: DevelopmentE2EOptions,
	browser: DevelopmentBrowser,
	evidenceDir: string,
	credential: string,
	model: DevelopmentContext["model"],
	name: string,
): Promise<NativeDevelopmentContextHandle> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), `omp-webgui-${name.replace(/[^a-z0-9-]/gi, "-")}-`));
	const agentDir = path.join(root, "config", "profiles", "acceptance", "agent");
	const projectA = path.join(root, "project-a");
	const projectB = path.join(root, "project-b");
	const createdProject = path.join(root, "created-project");
	const fixtureDir = path.join(root, "fixtures");
	const redact = (text: string) => (credential ? text.split(credential).join("[REDACTED]") : text);
	let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
	let log = "";
	let errorLog = "";
	let streams: Promise<void>[] = [];
	let closed = false;
	let cleanupEvidence: Evidence | undefined;
	let observedProcesses: Process[] = [];
	const captureAbort = new AbortController();
	const captureFailures: string[] = [];
	let retryRelay: ReturnType<typeof createRetryFaultRelay> | undefined;
	const attached = options.url && options.attachedContext;
	async function drain(stream: ReadableStream<Uint8Array>, append: (text: string) => void): Promise<void> {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		const cancel = () => {
			void reader.cancel().catch(error => captureFailures.push(redact(String(error))));
		};
		captureAbort.signal.addEventListener("abort", cancel, { once: true });
		try {
			for (;;) {
				const next = await reader.read();
				if (next.done) break;
				append(decoder.decode(next.value, { stream: true }));
			}
			append(decoder.decode());
		} finally {
			captureAbort.signal.removeEventListener("abort", cancel);
			reader.releaseLock();
		}
	}
	async function stop(): Promise<Evidence> {
		if (cleanupEvidence) return cleanupEvidence;
		if (attached) return options.attachedContext!.stop();
		if (!child) return { ownedProcessStarted: false };
		observedProcesses = ownedProcessTree(child.pid);
		const processTreeBefore = observedProcesses.map(process => ({
			pid: process.pid,
			ppid: process.ppid,
			status: process.status(),
		}));
		if (child.exitCode === null) {
			child.stdin.write("/webgui\n");
			await child.stdin.flush();
		}
		const deadline = Promise.withResolvers<never>();
		const timer = setTimeout(
			() =>
				deadline.reject(
					new Error("Native WebGUI settlement did not complete; resources must not be reported released"),
				),
			60_000,
		);
		const settle = async () => {
			const code = await child!.exited;
			await Promise.all(streams);
			return code;
		};
		const code = await Promise.race([settle(), deadline.promise]).finally(() => clearTimeout(timer));
		await fs.writeFile(path.join(evidenceDir, `${name}-stdout.log`), redact(log));
		await fs.writeFile(path.join(evidenceDir, `${name}-stderr.log`), redact(errorLog));
		if (code !== 0) throw new Error(`Native CLI settlement exited ${code}: ${redact(errorLog.slice(-4000))}`);
		const processTreeAfter = observedProcesses.map(process => ({ pid: process.pid, status: process.status() }));
		if (processTreeAfter.some(process => process.status === ProcessStatus.Running))
			throw new Error(`Owned native subprocesses survived successful CLI exit: ${JSON.stringify(processTreeAfter)}`);
		cleanupEvidence = {
			pid: child.pid,
			exitCode: code,
			nativeExit: "/webgui",
			ownedProcessExited: true,
			forced: false,
			processTreeBefore,
			processTreeAfter,
		};
		closed = true;
		return cleanupEvidence;
	}
	try {
		await fs.mkdir(evidenceDir, { recursive: true });
		await fs.mkdir(agentDir, { recursive: true });
		await fs.mkdir(fixtureDir, { recursive: true });
		for (const directory of ["home", "appdata", "localappdata", "tmp"])
			await fs.mkdir(path.join(root, directory), { recursive: true });
		await fixtureProject(projectA);
		await fixtureProject(projectB);
		await fs.writeFile(path.join(projectB, "outside-context.txt"), "must-not-be-read-from-project-a");
		// Native config path/keys: utils/dirs.ts profile root + config/model-settings.ts.
		// No credentials enter config.yml; all inference roles stay on the authoritative Beam Free id.
		const selectableModel = getBundledModels("opencode-go").find(
			candidate => candidate.id !== model.id && candidate.input.includes("text"),
		);
		await fs.writeFile(
			path.join(agentDir, "config.yml"),
			`enabledProviders:\n  - opencode-go\nenabledModels:\n  - opencode-go/${model.id}\n${selectableModel ? `  - opencode-go/${selectableModel.id}\n` : ""}modelRoles:\n${["default", "smol", "slow", "plan", "vision", "task", "advisor"].map(role => `  ${role}: opencode-go/${model.id}\n`).join("")}retry:\n  modelFallback: false\nstartup:\n  setupWizard: false\ncomposer:\n  predictions: false\ntools:\n  approval:\n    write: allow\n`,
		);
		if (name === "failed-retry-transport") {
			retryRelay = createRetryFaultRelay(model);
			await fs.writeFile(
				path.join(agentDir, "models.yml"),
				`providers:\n  ${model.provider}:\n    baseUrl: ${JSON.stringify(retryRelay.baseUrl)}\n`,
			);
		}
		let url: string;
		if (attached) url = validateDirectUrl(options.url!);
		else {
			child = Bun.spawn(
				[
					process.execPath,
					path.join(repository, "packages", "coding-agent", "src", "cli.ts"),
					"--profile",
					"acceptance",
					"webgui",
				],
				{ cwd: root, env: isolatedEnvironment(root, credential), stdin: "pipe", stdout: "pipe", stderr: "pipe" },
			);
			streams = [
				drain(child.stdout, text => {
					log += redact(text);
				}),
				drain(child.stderr, text => {
					errorLog += redact(text);
				}),
			];
			url = await observe(
				async () => {
					if (child!.exitCode !== null)
						throw new Error(`Real standalone CLI exited before readiness: ${redact(errorLog)}`);
					return log.match(/http:\/\/(?:127\.0\.0\.1|localhost):\d+[^\s\x1b]*/)?.[0] ?? "";
				},
				Boolean,
				"real standalone CLI published loopback URL",
				60_000,
			);
		}
		const isolation = attached ? options.attachedContext! : { root, agentDir, projectA, projectB, createdProject };
		const context: DevelopmentContext = {
			...isolation,
			fixtureDir,
			evidenceDir,
			browser,
			get url() {
				return url;
			},
			model,
			selectableModel: selectableModel ? { provider: selectableModel.provider, id: selectableModel.id } : undefined,
			timeoutMs: options.timeoutMs ?? 180_000,
			redact,
			transcripts: () => readTranscripts(isolation.agentDir),
			stop,
			...(retryRelay ? { providerFault: retryRelay.fixture } : {}),
			artifactFiles: async () => [
				...(await filesUnder(path.join(isolation.root, "tmp"))),
				...(await filesUnder(isolation.agentDir)),
				...(typeof browser.identity.downloadDirectory === "string"
					? await filesUnder(browser.identity.downloadDirectory)
					: []),
			],
			isListening: () =>
				fetch(url, { signal: AbortSignal.timeout(2000) }).then(
					response => response.ok,
					() => false,
				),
			async waitForRestart() {
				if (attached || !child)
					throw new PlatformPrerequisiteError(
						"restart-process-observation",
						"Native process restart must run in the harness-owned isolated CLI",
					);
				const previousUrl = url;
				const restarted = await observe(
					async () => {
						const published = [...log.matchAll(/http:\/\/(?:127\.0\.0\.1|localhost):\d+[^\s\x1b]*/g)].map(
							match => match[0],
						);
						if (published.length < 2) return undefined;
						const candidate = published.at(-1)!;
						const ready = await fetch(candidate, { signal: AbortSignal.timeout(2000) }).then(
							response => response.ok,
							() => false,
						);
						return ready ? candidate : undefined;
					},
					value => value !== undefined,
					"native restarted CLI published a live production listener",
					60_000,
				);
				url = restarted!;
				return {
					previousUrl,
					url,
					observedProcesses: ownedProcessTree(child.pid).map(process => ({
						pid: process.pid,
						ppid: process.ppid,
					})),
				};
			},
			async isolated<T>(label: string, run: (context: DevelopmentContext) => Promise<T>) {
				const nestedDir = path.join(evidenceDir, label);
				const nestedBrowser = { ...browser, page: await browser.newPage() };
				const nested = await startContext(
					{ ...options, url: undefined, attachedContext: undefined },
					nestedBrowser,
					nestedDir,
					credential,
					model,
					label,
				);
				try {
					return await run(nested.context);
				} finally {
					try {
						await nested.cleanup();
					} finally {
						await nestedBrowser.page.close();
					}
				}
			},
		};
		return {
			context,
			async cleanup() {
				const failures: string[] = [];
				try {
					await stop();
				} catch (error) {
					failures.push(redact(String(error)));
				}
				if (child && child.exitCode === null) {
					// Last-resort cleanup applies only to our exact child, never taskkill by image or port.
					await gracefulKillTreeOnce(child.pid);
					await child.exited;
					cleanupEvidence = { pid: child.pid, forced: true, nativeSettlementSucceeded: false };
				}
				for (const process of observedProcesses) {
					if (process.status() !== ProcessStatus.Running) continue;
					if (
						!(await process.terminate({ gracefulMs: 1000, timeoutMs: 2000 })) &&
						process.status() === ProcessStatus.Running
					) {
						process.killTree();
						if (!(await process.waitForExit({ timeoutMs: 2000 })))
							failures.push(`Owned process ${process.pid} did not exit after scoped hard cleanup`);
					}
					cleanupEvidence = { ...cleanupEvidence, forced: true, nativeSettlementSucceeded: false };
				}
				captureAbort.abort();
				for (const result of await Promise.allSettled(streams))
					if (result.status === "rejected") failures.push(redact(String(result.reason)));
				failures.push(...captureFailures);
				await retryRelay?.close();
				await fs.writeFile(path.join(evidenceDir, `${name}-stdout.log`), redact(log));
				await fs.writeFile(path.join(evidenceDir, `${name}-stderr.log`), redact(errorLog));
				// Preserve isolated native records/workspaces as evidence; remove no personal files.
				return {
					...cleanupEvidence,
					root,
					evidencePreserved: true,
					closed,
					...(failures.length ? { failures } : {}),
				};
			},
		};
	} catch (error) {
		const failures: unknown[] = [error];
		await retryRelay?.close();
		try {
			if (child && child.exitCode === null) {
				await gracefulKillTreeOnce(child.pid);
				await withTimeout(child.exited, 5000, "Native startup child exit remains unsettled");
			}
		} catch (cleanupError) {
			failures.push(cleanupError);
		}
		try {
			for (const result of await withTimeout(
				Promise.allSettled(streams),
				5000,
				"Native startup stdout/stderr remain open",
			))
				if (result.status === "rejected") failures.push(result.reason);
		} catch (captureError) {
			failures.push(captureError);
		} finally {
			captureAbort.abort();
			await Promise.allSettled(streams);
		}
		failures.push(...captureFailures);
		for (const [suffix, text] of [
			["stdout", log],
			["stderr", errorLog],
		]) {
			try {
				await fs.writeFile(path.join(evidenceDir, `${name}-${suffix}.log`), redact(text!));
			} catch (captureError) {
				failures.push(captureError);
			}
		}
		if (failures.length === 1) throw error;
		throw new AggregateError(failures, "Native startup and cleanup failed");
	}
}

export async function runDevelopmentE2E(
	options: DevelopmentE2EOptions,
	authorization: DevelopmentAuthorization = {},
): Promise<{ status: "passed" | "failed" | "blocked"; evidenceDir: string; browsers: BrowserReport[] }> {
	const credential = authorization.credential ?? process.env.OPENCODE_API_KEY;
	if (!credential)
		throw new PlatformPrerequisiteError(
			"opencode-authorization",
			"An authorized OpenCode credential must be inherited or passed in memory; no personal credentials are copied or persisted",
		);
	const model = getBundledModels("opencode-go").find(
		candidate => candidate.id === "beam-free" && candidate.name === "Beam Free",
	);
	if (!model)
		throw new PlatformPrerequisiteError(
			"beam-free-catalog",
			"Authoritative @oh-my-pi/pi-catalog/models lacks OpenCode Go Beam Free; no model substitution is allowed",
		);
	const runId = `run-${Date.now()}-${crypto.randomUUID()}`;
	const evidenceDir = options.evidenceDir
		? path.join(path.resolve(options.evidenceDir), runId)
		: path.join(os.tmpdir(), `omp-webgui-evidence-${runId}`);
	await fs.mkdir(evidenceDir, { recursive: true });
	const source = await productionIdentity(
		path.resolve(options.productionDir ?? path.join(repository, "vendor", "zcode-frontend", "build", "webgui")),
	);
	const sourceFingerprint = digest(JSON.stringify(source));
	const reports: BrowserReport[] = [];
	for (const name of options.browser === "both" ? (["chrome", "firefox"] as const) : [options.browser]) {
		const browserDir = path.join(evidenceDir, name);
		await fs.mkdir(browserDir, { recursive: true });
		for (const directory of ["home", "appdata", "localappdata", "tmp"])
			await fs.mkdir(path.join(browserDir, directory), { recursive: true });
		const downloadDirectory = path.join(browserDir, "downloads");
		await fs.mkdir(downloadDirectory, { recursive: true });
		const report: BrowserReport = {
			browser: name,
			status: "failed",
			model: {
				provider: model.provider,
				id: model.id,
				name: model.name,
				api: model.api,
				input: model.input,
				catalog: "@oh-my-pi/pi-catalog/models:getBundledModels(opencode-go)",
				configSource: "isolated profile agent/config.yml modelRoles",
				sourceFingerprint,
			},
			scenarios: [],
			productionResources: source,
		};
		report.auxiliaryFailurePaths = {
			status: "unobserved-by-this-runner",
			sources: [
				"packages/coding-agent/test/webgui/native-interactions.test.ts",
				"packages/coding-agent/test/webgui/native-attachments.test.ts",
				"packages/coding-agent/test/webgui/native-files.test.ts",
				"packages/agent/test/pause-gate.test.ts",
				"packages/coding-agent/test/webgui/core-browser.e2e.test.ts",
				"packages/coding-agent/test/webgui/project-ownership.test.ts",
				"packages/coding-agent/test/webgui/native-cwd.test.ts",
			],
		};
		let owned: NativeDevelopmentContextHandle | undefined;
		try {
			const run = async (browser: DevelopmentBrowser) => {
				report.identity = browser.identity;
				owned = await startContext(
					options,
					browser,
					browserDir,
					credential,
					{ provider: model.provider, id: model.id, input: model.input },
					name,
				);
				const context = owned.context;
				report.isolation = {
					root: context.root,
					agentDir: context.agentDir,
					projectA: context.projectA,
					projectB: context.projectB,
					createdProject: context.createdProject,
					publicUrl: context.url,
					sameProductionFingerprint: sourceFingerprint,
				};
				await browser.page.navigate(context.url);
				await observe(
					() => browser.page.evaluate<boolean>("document.readyState==='complete'"),
					Boolean,
					"production page readiness",
				);
				report.actuallyLoadedResources = await loadedIdentity(browser.page, context.url, source);
				context.captureResources = async () => {
					const loaded = new Map<string, ResourceIdentity>();
					for (const resource of report.actuallyLoadedResources ?? []) loaded.set(resource.path, resource);
					for (const candidate of await browser.pages()) {
						const currentUrl = new URL(await candidate.evaluate<string>("location.href"));
						if (currentUrl.origin !== new URL(context.url).origin) continue;
						for (const resource of await loadedIdentity(candidate, context.url, source))
							loaded.set(resource.path, resource);
					}
					report.actuallyLoadedResources = [...loaded.values()];
				};
				report.scenarios = await runDevelopmentScenarios(context);
				report.nativeDownloads = await Promise.all(
					(await filesUnder(downloadDirectory)).map(async file => {
						const bytes = await fs.readFile(file);
						return { path: path.relative(downloadDirectory, file), size: bytes.length, sha256: digest(bytes) };
					}),
				);
				const unexpected = (await context.transcripts())
					.flatMap(source => source.entries)
					.filter(
						entry =>
							entry.message?.role === "assistant" &&
							(entry.message.provider !== model.provider || entry.message.model !== model.id),
					);
				if (unexpected.length)
					throw new Error(
						`Native inference substituted a different provider/model: ${JSON.stringify(unexpected.map(entry => ({ id: entry.id, provider: entry.message?.provider, model: entry.message?.model })))}`,
					);
				// All fifteen independent results are required; a partial browser run cannot pass.
				report.status =
					report.scenarios.length === DEVELOPMENT_MATRIX.length &&
					report.scenarios.every(scenario => scenario.status === "passed")
						? "passed"
						: report.scenarios.some(scenario => scenario.status === "blocked")
							? "blocked"
							: "failed";
			};
			const failures: unknown[] = [];
			try {
				if (name === "chrome")
					await withChrome({ ...options, evidenceDir: browserDir }, run, evidence => {
						report.browserCleanup = evidence;
					});
				else
					await withFirefoxBrowser(
						{
							firefox: options.firefox,
							headless: options.headless ?? true,
							viewport: { width: 1440, height: 1000 },
							downloadDirectory,
							environment: nonSecretEnvironment(browserDir),
						},
						run,
					);
			} catch (error) {
				failures.push(error);
			}
			if (owned) {
				try {
					report.cleanup = await owned.cleanup();
				} catch (error) {
					failures.push(error);
				}
			}
			if (failures.length === 1) throw failures[0];
			if (failures.length) throw new AggregateError(failures, "Acceptance and native cleanup failed");
			if (report.cleanup?.forced || report.cleanup?.failures || report.browserCleanup?.failures)
				report.status = "failed";
		} catch (error) {
			report.status = error instanceof PlatformPrerequisiteError ? "blocked" : "failed";
			report.error = failureText(error).split(credential).join("[REDACTED]");
		}
		for (const id of DEVELOPMENT_MATRIX)
			if (!report.scenarios.some(scenario => scenario.id === id))
				report.scenarios.push({
					id,
					status: "unverified",
					startedAt: new Date().toISOString(),
					durationMs: 0,
					evidence: [],
					error: "Browser prerequisite/startup prevented this behavior from running",
				});
		reports.push(report);
		await fs.writeFile(
			path.join(browserDir, "report.json"),
			JSON.stringify(report, null, 2).split(credential).join("[REDACTED]"),
		);
	}
	// Re-read build identity after both browsers: no rebuild/cutover may masquerade as same resources.
	const after = await productionIdentity(
		path.resolve(options.productionDir ?? path.join(repository, "vendor", "zcode-frontend", "build", "webgui")),
	);
	if (digest(JSON.stringify(after)) !== sourceFingerprint)
		for (const report of reports) {
			report.status = "failed";
			report.error = [report.error, "Production resources changed during the two-browser run"]
				.filter(Boolean)
				.join("\n");
		}
	const status =
		reports.every(report => report.status === "passed") && (options.browser !== "both" || reports.length === 2)
			? "passed"
			: reports.some(report => report.status === "blocked")
				? "blocked"
				: "failed";
	const result = { status, evidenceDir, browsers: reports } as const;
	await fs.writeFile(
		path.join(evidenceDir, "report.json"),
		JSON.stringify(result, null, 2).split(credential).join("[REDACTED]"),
	);
	return result;
}
function argumentsFrom(args: string[]): DevelopmentE2EOptions {
	const values = new Map<string, string>();
	const allowed = new Set([
		"browser",
		"chrome",
		"firefox",
		"evidence-dir",
		"timeout-ms",
		"production-dir",
		"headless",
	]);
	for (let index = 0; index < args.length; index += 2) {
		const key = args[index]?.replace(/^--/, "");
		const value = args[index + 1];
		if (!key || !allowed.has(key) || !value || value.startsWith("--"))
			throw new PlatformPrerequisiteError(
				"arguments",
				"Use --browser both|chrome|firefox [--chrome PATH --firefox PATH --evidence-dir DIR --timeout-ms N --production-dir DIR --headless true|false]",
			);
		values.set(key, value);
	}
	const browser = values.get("browser");
	if (browser !== "both" && browser !== "chrome" && browser !== "firefox")
		throw new PlatformPrerequisiteError(
			"browser",
			"Explicit --browser both|chrome|firefox is required; this is opt-in, not a default gate",
		);
	const timeoutMs = values.has("timeout-ms") ? Number(values.get("timeout-ms")) : undefined;
	if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0))
		throw new PlatformPrerequisiteError("timeout-ms", "--timeout-ms must be a positive integer");
	return {
		browser,
		chrome:
			values.get("chrome") ??
			process.env.CHROME_EXECUTABLE ??
			(process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : undefined),
		firefox:
			values.get("firefox") ??
			process.env.FIREFOX_EXECUTABLE ??
			(process.platform === "win32" ? "C:/Program Files (x86)/Mozilla Firefox/firefox.exe" : undefined),
		evidenceDir: values.get("evidence-dir"),
		productionDir: values.get("production-dir"),
		timeoutMs,
		headless: values.get("headless") !== "false",
	};
}
if (import.meta.main) {
	try {
		const report = await runDevelopmentE2E(argumentsFrom(process.argv.slice(2)));
		console.log(
			JSON.stringify(
				{
					status: report.status,
					evidenceDir: report.evidenceDir,
					browsers: report.browsers.map(browser => ({
						browser: browser.browser,
						status: browser.status,
						scenarios: browser.scenarios.map(scenario => ({ id: scenario.id, status: scenario.status })),
					})),
				},
				null,
				2,
			),
		);
		process.exitCode = report.status === "passed" ? 0 : report.status === "blocked" ? 2 : 1;
	} catch (error) {
		const secret = process.env.OPENCODE_API_KEY;
		console.error(
			JSON.stringify({
				status: error instanceof PlatformPrerequisiteError ? "blocked" : "failed",
				error: secret ? String(error).split(secret).join("[REDACTED]") : String(error),
			}),
		);
		process.exitCode = error instanceof PlatformPrerequisiteError ? 2 : 1;
	}
}
