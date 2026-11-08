#!/usr/bin/env bun
// Opt-in only: attach to an already-running OMP URL; never build, download, or start OMP.
// Firefox uses W3C WebDriver and an isolated temporary profile. Android requires a
// physical USB-debuggable device and an isolated CDP browser context (no emulation).
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createServer } from "node:net";
import type { Browser, BrowserContext } from "puppeteer-core";
import { loadPuppeteer } from "../packages/coding-agent/src/tools/browser/launch";

export class PlatformPrerequisiteError extends Error {
	constructor(
		readonly prerequisite: string,
		message: string,
	) {
		super(message);
		this.name = "PlatformPrerequisiteError";
	}
}

function prerequisite(code: string, message: string): never {
	throw new PlatformPrerequisiteError(code, message);
}

export function assertFirefox68Identity(version: string, userAgent: string): void {
	if (!/^68(?:\.|$)/.test(version) || !/Firefox\/68(?:\.|\s|$)/.test(userAgent)) {
		prerequisite("firefox68-version", `Actual Firefox 68 required; WebDriver=${version}, userAgent=${userAgent}`);
	}
}

export interface AndroidDeviceIdentity {
	serial: string;
	manufacturer: string;
	model: string;
	androidVersion: string;
	qemu: string;
	characteristics: string;
}

export function assertPhysicalAndroid(identity: AndroidDeviceIdentity, userAgent?: string): void {
	if (
		identity.qemu.trim() === "1" ||
		/^emulator-/i.test(identity.serial) ||
		/emulator|sdk_gphone|sdk_phone|goldfish|ranchu/i.test(`${identity.manufacturer} ${identity.model}`)
	)
		prerequisite("physical-android", "An Android emulator is not a physical-phone acceptance result");
	if (
		!identity.serial ||
		!identity.model ||
		!identity.androidVersion ||
		(userAgent !== undefined && (!/Android/.test(userAgent) || !/Mobile/.test(userAgent)))
	) {
		prerequisite(
			"android-phone-identity",
			"ADB physical-device identity and an actual Android Mobile browser user agent are required",
		);
	}
}

export function selectAndroidSerial(output: string, requested?: string): string {
	const devices = output
		.split(/\r?\n/)
		.map(line => line.trim().split(/\s+/))
		.filter(parts => parts[0] && parts[0] !== "List" && parts.length >= 2);
	if (requested) {
		const device = devices.find(parts => parts[0] === requested);
		if (!device || device[1] !== "device")
			prerequisite(
				"android-device",
				`ADB device ${requested} is ${device?.[1] ?? "absent"}; connect it, unlock it, and authorize USB debugging`,
			);
		return requested;
	}
	const connected = devices.filter(parts => parts[1] === "device");
	if (connected.length !== 1)
		prerequisite(
			"android-device",
			`Expected one authorized ADB device; found ${connected.length}. Connect/authorize a physical phone or pass --serial. ADB: ${output.trim()}`,
		);
	return connected[0]![0]!;
}

export function validateDirectUrl(value: string, android = false): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return prerequisite("omp-url", "Pass --url with the complete direct OMP HTTP(S) WebGUI URL");
	}
	if (!/^https?:$/.test(url.protocol) || url.username || url.password)
		prerequisite(
			"omp-url",
			"Use the direct OMP HTTP(S) URL, not a Relay/WebSocket URL or credential-bearing proxy URL",
		);
	if (android && (/^127\./.test(url.hostname) || ["localhost", "[::1]", "0.0.0.0", "[::]"].includes(url.hostname)))
		prerequisite(
			"android-lan-url",
			"Pass the OMP LAN HTTP(S) URL reachable from the phone; phone localhost is not the OMP host",
		);
	return url.href;
}

const INPUT = '[data-testid="v4-composer-input"][contenteditable="true"]';
const timeout = 30_000;
const delay = () => Bun.sleep(100);

async function waitUntil<T>(read: () => Promise<T>, ready: (value: T) => boolean, description: string): Promise<T> {
	const deadline = Date.now() + timeout;
	do {
		const value = await read();
		if (ready(value)) return value;
		await delay();
	} while (Date.now() < deadline);
	throw new Error(`Timed out waiting for ${description}`);
}

async function freePort(): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const server = createServer();
	server.once("error", reject);
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		if (!address || typeof address === "string") {
			server.close();
			reject(new Error("No local TCP port allocated"));
			return;
		}
		server.close(error => (error ? reject(error) : resolve(address.port)));
	});
	return promise;
}

interface PageSnapshot {
	url: string;
	title: string;
	userAgent: string;
	width: number;
	height: number;
	ready: boolean;
	draft: string;
}

// ES5 source is intentional: these expressions also run in actual Firefox 68.
function visibleExpression(selector: string): string {
	return `(function(){var e=document.querySelector(${JSON.stringify(selector)}); if(!e)return false;var r=e.getBoundingClientRect();var s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';})()`;
}
const snapshotExpression = `(function(){var e=document.querySelector(${JSON.stringify(INPUT)});return {url:location.href,title:document.title,userAgent:navigator.userAgent,width:innerWidth,height:innerHeight,ready:${visibleExpression(INPUT)},draft:e?e.textContent:''};})()`;

interface ProbePage {
	navigate(url: string): Promise<void>;
	reload(): Promise<void>;
	evaluate<T>(expression: string): Promise<T>;
	click(selector: string): Promise<void>;
	typeDraft(text: string): Promise<void>;
	clearDraft(): Promise<void>;
}

interface ProbeOptions {
	platform: "firefox68" | "android";
	url: string;
	navigation: string;
	destination: string;
	menu?: string;
	session?: string;
	firefox?: string;
	geckodriver?: string;
	adb?: string;
	serial?: string;
	socket: string;
}

async function exercise(page: ProbePage, options: ProbeOptions): Promise<object> {
	const readyComposer = async () => {
		if (options.session) {
			await waitUntil(
				() => page.evaluate<boolean>(`${visibleExpression(INPUT)} || ${visibleExpression(options.session!)}`),
				Boolean,
				"native composer or existing-session navigation",
			);
			if (!(await page.evaluate<boolean>(visibleExpression(INPUT)))) await page.click(options.session);
		}
		return waitUntil(
			() => page.evaluate<PageSnapshot>(snapshotExpression),
			value => value.ready,
			"native-session composer (use /webgui in an active OMP conversation; on a phone pass --session-selector for its existing session)",
		);
	};
	await page.navigate(options.url);
	const first = await readyComposer();
	if (new URL(first.url).origin !== new URL(options.url).origin)
		throw new Error(`Navigation left direct OMP origin: ${first.url}`);
	await page.reload();
	await readyComposer();
	if (options.menu) await page.click(options.menu);
	await waitUntil(
		() => page.evaluate<boolean>(visibleExpression(options.navigation)),
		Boolean,
		"retained navigation control",
	);
	if (await page.evaluate<boolean>(visibleExpression(options.destination)))
		throw new Error(
			"Navigation destination was already visible; choose a control and destination that demonstrate a real page change",
		);
	await page.click(options.navigation);
	await waitUntil(
		() => page.evaluate<boolean>(visibleExpression(options.destination)),
		Boolean,
		"retained navigation destination",
	);
	await page.navigate(options.url);
	await readyComposer();
	const before = await page.evaluate<PageSnapshot>(snapshotExpression);
	if (before.draft.trim())
		prerequisite(
			"empty-draft",
			"Probe refuses to replace an existing draft; use an empty draft in the native session",
		);
	const marker = `OMP platform input ${crypto.randomUUID()}`;
	try {
		await page.typeDraft(marker);
		await waitUntil(
			() => page.evaluate<PageSnapshot>(snapshotExpression),
			value => value.draft === marker,
			"actual browser keyboard input",
		);
	} finally {
		await page.clearDraft();
	}
	const final = await page.evaluate<PageSnapshot>(snapshotExpression);
	if (final.draft.trim()) throw new Error("Probe draft was not cleared");
	return {
		initialPage: first,
		finalPage: final,
		checks: ["page-startup", "refresh", "retained-navigation", "keyboard-draft-input", "draft-cleared"],
		promptSubmitted: false,
	};
}

async function firefoxProbe(options: ProbeOptions): Promise<object> {
	const binary = options.firefox;
	if (
		!binary ||
		!(await fs.stat(binary).then(
			value => value.isFile(),
			() => false,
		))
	)
		prerequisite(
			"firefox68-binary",
			"Pass --firefox with an installed Firefox 68 executable; this probe never downloads browsers",
		);
	const driver = options.geckodriver ?? Bun.which("geckodriver");
	if (!driver)
		prerequisite(
			"geckodriver",
			"Install a Firefox-68-compatible geckodriver (for example 0.26.x) and pass --geckodriver or put it on PATH",
		);
	const port = await freePort();
	const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-firefox68-"));
	let child: Bun.Subprocess<"ignore", "ignore", "pipe"> | undefined;
	let sessionId: string | undefined;
	let diagnostics: Promise<string> | undefined;
	const endpoint = `http://127.0.0.1:${port}`;
	async function request<T>(method: string, resource: string, body?: object): Promise<T> {
		const response = await fetch(`${endpoint}${resource}`, {
			method,
			headers: { "Content-Type": "application/json" },
			...(body ? { body: JSON.stringify(body) } : {}),
			signal: AbortSignal.timeout(timeout),
		});
		const payload = (await response.json()) as { value: T & { error?: string; message?: string } };
		if (!response.ok || payload.value?.error)
			throw new Error(`WebDriver ${method} ${resource}: ${payload.value?.message ?? response.status}`);
		return payload.value;
	}
	try {
		try {
			child = Bun.spawn([driver, "--host", "127.0.0.1", "--port", String(port)], {
				stdin: "ignore",
				stdout: "ignore",
				stderr: "pipe",
			});
		} catch (error) {
			prerequisite("geckodriver", `Unable to start ${driver}: ${String(error)}`);
		}
		diagnostics = new Response(child.stderr).text();
		await waitUntil(
			async () => {
				if (child?.exitCode !== null)
					prerequisite("geckodriver", `geckodriver exited before becoming ready: ${await diagnostics}`);
				return fetch(`${endpoint}/status`, { signal: AbortSignal.timeout(1000) }).then(
					response => response.ok,
					() => false,
				);
			},
			Boolean,
			"geckodriver readiness",
		);
		let session: {
			sessionId: string;
			capabilities: {
				browserName: string;
				browserVersion: string;
				platformName: string;
				"moz:geckodriverVersion"?: string;
			};
		};
		try {
			session = await request("POST", "/session", {
				capabilities: {
					alwaysMatch: { browserName: "firefox", "moz:firefoxOptions": { binary, args: ["-profile", profile] } },
				},
			});
		} catch (error) {
			return prerequisite(
				"firefox-webdriver-session",
				`Firefox 68 and compatible geckodriver must start with a temporary profile: ${String(error)}`,
			);
		}
		sessionId = session.sessionId;
		const route = `/session/${sessionId}`;
		await request("POST", `${route}/timeouts`, { implicit: 0, pageLoad: timeout, script: timeout });
		const evaluate = <T>(expression: string) =>
			request<T>("POST", `${route}/execute/sync`, { script: `return ${expression};`, args: [] });
		const userAgent = await evaluate<string>("navigator.userAgent");
		if (session.capabilities.browserName.toLowerCase() !== "firefox")
			prerequisite("firefox68-version", "WebDriver did not launch Firefox");
		assertFirefox68Identity(session.capabilities.browserVersion, userAgent);
		const element = async (selector: string) => {
			const result = await request<Record<string, string>>("POST", `${route}/element`, {
				using: "css selector",
				value: selector,
			});
			const id = result["element-6066-11e4-a52e-4f735466cecf"];
			if (!id) throw new Error(`WebDriver returned no element for ${selector}`);
			return `${route}/element/${encodeURIComponent(id)}`;
		};
		const result = await exercise(
			{
				evaluate,
				async navigate(url) {
					await request("POST", `${route}/url`, { url });
				},
				async reload() {
					await request("POST", `${route}/refresh`, {});
				},
				async click(selector) {
					await request("POST", `${await element(selector)}/click`, {});
				},
				async typeDraft(text) {
					const input = await element(INPUT);
					await request("POST", `${input}/click`, {});
					await request("POST", `${input}/value`, { text, value: text.split("") });
				},
				async clearDraft() {
					const input = await element(INPUT);
					await request("POST", `${input}/clear`, {});
				},
			},
			options,
		);
		return {
			executable: binary,
			geckodriver: driver,
			capabilities: session.capabilities,
			userAgent,
			profile: "temporary; removed after session",
			...result,
		};
	} finally {
		try {
			if (sessionId) await request("DELETE", `/session/${sessionId}`);
		} finally {
			if (child) {
				child.kill();
				await child.exited;
			}
			await fs.rm(profile, { recursive: true, force: true });
		}
	}
}

async function androidProbe(options: ProbeOptions): Promise<object> {
	const adb = options.adb ?? Bun.which("adb");
	if (!adb)
		prerequisite(
			"adb",
			"Install Android platform-tools and pass --adb or put adb on PATH; no downloads are automatic",
		);
	async function command(args: string[]): Promise<string> {
		let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
		try {
			child = Bun.spawn([adb!, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout });
		} catch (error) {
			return prerequisite("adb", `Unable to start ${adb}: ${String(error)}`);
		}
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (code !== 0)
			prerequisite("adb-command", `adb ${args.join(" ")} failed (${code}): ${stderr.trim() || stdout.trim()}`);
		return stdout.trim();
	}
	const serial = selectAndroidSerial(await command(["devices", "-l"]), options.serial);
	const device = (args: string[]) => command(["-s", serial, ...args]);
	const property = (key: string) => device(["shell", "getprop", key]);
	const identity: AndroidDeviceIdentity = {
		serial,
		manufacturer: await property("ro.product.manufacturer"),
		model: await property("ro.product.model"),
		androidVersion: await property("ro.build.version.release"),
		qemu: await property("ro.kernel.qemu"),
		characteristics: await property("ro.build.characteristics"),
	};
	// Reject emulators before connecting. Browser identity is checked again below.
	assertPhysicalAndroid(identity);
	let forwarded: string | undefined;
	let browser: Browser | undefined;
	let context: BrowserContext | undefined;
	try {
		forwarded = await device(["forward", "tcp:0", `localabstract:${options.socket}`]);
		if (!/^\d+$/.test(forwarded)) prerequisite("android-cdp", `ADB did not allocate a debugger port: ${forwarded}`);
		const browserURL = `http://127.0.0.1:${forwarded}`;
		const versionResponse = await fetch(`${browserURL}/json/version`, { signal: AbortSignal.timeout(timeout) }).catch(
			error =>
				prerequisite(
					"android-cdp",
					`Open Chrome on the authorized phone with CDP available (${options.socket}): ${String(error)}`,
				),
		);
		if (!versionResponse.ok)
			prerequisite(
				"android-cdp",
				`Phone browser CDP returned HTTP ${versionResponse.status}; open Chrome and enable USB debugging`,
			);
		const cdpIdentity = (await versionResponse.json()) as {
			Browser?: string;
			"User-Agent"?: string;
			webSocketDebuggerUrl?: string;
		};
		assertPhysicalAndroid(identity, cdpIdentity["User-Agent"] ?? "");
		const puppeteer = await loadPuppeteer();
		browser = await puppeteer.connect({ browserURL, defaultViewport: null, protocolTimeout: timeout });
		try {
			context = await browser.createBrowserContext();
		} catch (error) {
			return prerequisite(
				"android-isolated-context",
				`This phone/browser must support an isolated temporary CDP browser context; personal tabs/profile will not be used: ${String(error)}`,
			);
		}
		const page = await context.newPage();
		page.setDefaultTimeout(timeout);
		page.setDefaultNavigationTimeout(timeout);
		const errors: string[] = [];
		page.on("pageerror", error => errors.push(String(error)));
		const result = await exercise(
			{
				async evaluate<T>(expression: string) {
					return (await page.evaluate(expression)) as T;
				},
				async navigate(url) {
					const response = await page.goto(url, { waitUntil: "load" });
					if (!response?.ok()) throw new Error(`OMP page HTTP ${response?.status() ?? "unavailable"}`);
				},
				async reload() {
					await page.reload({ waitUntil: "load" });
				},
				async click(selector) {
					await page.tap(selector);
				},
				async typeDraft(text) {
					await page.tap(INPUT);
					await page.keyboard.type(text);
				},
				async clearDraft() {
					await page.tap(INPUT);
					await page.keyboard.down("Control");
					await page.keyboard.press("KeyA");
					await page.keyboard.up("Control");
					await page.keyboard.press("Backspace");
				},
			},
			options,
		);
		const userAgent = await page.evaluate(() => navigator.userAgent);
		assertPhysicalAndroid(identity, userAgent);
		if (errors.length) throw new Error(`Phone page uncaught errors: ${errors.join("; ")}`);
		return {
			device: identity,
			cdpIdentity,
			userAgent,
			browserVersion: await browser.version(),
			emulation: false,
			profile: "isolated temporary CDP browser context",
			...result,
		};
	} finally {
		try {
			await context?.close();
		} finally {
			browser?.disconnect();
			if (forwarded && /^\d+$/.test(forwarded)) await device(["forward", "--remove", `tcp:${forwarded}`]);
		}
	}
}

function parseOptions(args: string[]): ProbeOptions {
	const values = new Map<string, string>();
	const allowed = new Set([
		"platform",
		"url",
		"nav-selector",
		"nav-ready-selector",
		"menu-selector",
		"session-selector",
		"firefox",
		"geckodriver",
		"adb",
		"serial",
		"socket",
	]);
	for (let index = 0; index < args.length; index += 2) {
		const key = args[index]?.replace(/^--/, "");
		const value = args[index + 1];
		if (!key || !allowed.has(key) || !value || value.startsWith("--"))
			prerequisite(
				"arguments",
				"Use --platform firefox68|android --url DIRECT_OMP_URL --nav-selector CSS --nav-ready-selector CSS [--menu-selector CSS --session-selector CSS] [--firefox PATH --geckodriver PATH] [--adb PATH --serial SERIAL --socket chrome_devtools_remote]",
			);
		values.set(key, value);
	}
	const platform = values.get("platform");
	if (platform !== "firefox68" && platform !== "android")
		prerequisite(
			"platform",
			"Explicit --platform firefox68 or --platform android is required; this is never a Chromium mobile-emulation pass",
		);
	const navigation = values.get("nav-selector");
	const destination = values.get("nav-ready-selector");
	if (!navigation || !destination)
		prerequisite(
			"navigation-selectors",
			"Pass --nav-selector and --nav-ready-selector for a retained read-only navigation action and its initially-hidden destination; do not select send/run/delete actions",
		);
	return {
		platform,
		url: validateDirectUrl(values.get("url") ?? "", platform === "android"),
		navigation,
		destination,
		menu: values.get("menu-selector"),
		session: values.get("session-selector"),
		firefox: values.get("firefox") ?? process.env.FIREFOX68_EXECUTABLE,
		geckodriver: values.get("geckodriver") ?? process.env.GECKODRIVER_EXECUTABLE,
		adb: values.get("adb") ?? process.env.ADB_EXECUTABLE,
		serial: values.get("serial") ?? process.env.ANDROID_SERIAL,
		socket: values.get("socket") ?? "chrome_devtools_remote",
	};
}

if (import.meta.main) {
	try {
		const options = parseOptions(process.argv.slice(2));
		const evidence = await (options.platform === "firefox68" ? firefoxProbe(options) : androidProbe(options));
		console.log(
			JSON.stringify(
				{
					status: "passed",
					platform: options.platform,
					directOmpUrl: options.url,
					host: { platform: os.platform(), release: os.release(), arch: os.arch() },
					evidence,
					unverified: [
						"manual visual review",
						"OS keyboard/IME",
						"all business operations",
						...(options.platform === "firefox68"
							? ["phone hardware", "pre-load browser error collection", "Firefox release channel"]
							: ["soft keyboard/IME"]),
					],
				},
				null,
				2,
			),
		);
	} catch (error) {
		const blocked = error instanceof PlatformPrerequisiteError;
		console.log(
			JSON.stringify(
				{
					status: blocked ? "blocked" : "failed",
					...(blocked ? { prerequisite: error.prerequisite } : {}),
					error: error instanceof Error ? error.message : String(error),
					passed: false,
				},
				null,
				2,
			),
		);
		process.exitCode = blocked ? 2 : 1;
	}
}
