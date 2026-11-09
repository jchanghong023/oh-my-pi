#!/usr/bin/env bun
// Opt-in only: attach to an already-running OMP URL; never build, download, or start OMP.
// Firefox uses Selenium/geckodriver and an isolated temporary profile. Android requires a
// physical USB-debuggable device and an isolated CDP browser context (no emulation).
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Browser, BrowserContext } from "puppeteer-core";
import { loadPuppeteer } from "../packages/coding-agent/src/tools/browser/launch";
import { connectFirefoxSelenium, type FirefoxSelenium } from "./webgui-firefox-selenium";

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

export interface FirefoxIdentity {
	browserName: "firefox";
	browserVersion: string;
	userAgent: string;
	major: number;
}

export function assertFirefoxIdentity(browserName: string, version: string, userAgent: string): FirefoxIdentity {
	const major = Number(/^(\d+)(?:\.|$)/.exec(version)?.[1]);
	const userAgentMajor = Number(/(?:^|\s)Firefox\/(\d+)(?:\.|\s|$)/.exec(userAgent)?.[1]);
	if (
		browserName.toLowerCase() !== "firefox" ||
		!Number.isSafeInteger(major) ||
		major < 128 ||
		major !== userAgentMajor
	) {
		prerequisite(
			"firefox-version",
			`Actual Firefox >=128 with matching WebDriver and user-agent majors required; browser=${browserName}, WebDriver=${version}, userAgent=${userAgent}`,
		);
	}
	return { browserName: "firefox", browserVersion: version, userAgent, major };
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

interface PageSnapshot {
	url: string;
	title: string;
	userAgent: string;
	width: number;
	height: number;
	ready: boolean;
	draft: string;
}

function visibleExpression(selector: string): string {
	return `(function(){var e=document.querySelector(${JSON.stringify(selector)}); if(!e)return false;var r=e.getBoundingClientRect();var s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';})()`;
}
const snapshotExpression = `(function(){var e=document.querySelector(${JSON.stringify(INPUT)});return {url:location.href,title:document.title,userAgent:navigator.userAgent,width:innerWidth,height:innerHeight,ready:${visibleExpression(INPUT)},draft:e?e.textContent:''};})()`;

export interface ProbePage {
	navigate(url: string): Promise<void>;
	reload(): Promise<void>;
	evaluate<T>(expression: string): Promise<T>;
	click(selector: string): Promise<void>;
	typeDraft(text: string): Promise<void>;
	clearDraft(): Promise<void>;
}

/** Native automation only; evaluates observations, never application service calls. */
export interface DevelopmentPage extends ProbePage {
	hover(selector: string): Promise<void>;
	type(selector: string, text: string): Promise<void>;
	clear(selector: string): Promise<void>;
	press(selector: string, key: string): Promise<void>;
	upload(selector: string, files: string[]): Promise<void>;
	screenshot(file: string): Promise<void>;
	draw(selector: string, points: Array<{ x: number; y: number }>): Promise<void>;
	close(): Promise<void>;
}

/** Read rendered editor text only; never touch React/Lexical state or mutate the DOM. */
// Lexical adds a terminal layout <br> (and on Firefox a marked image). Ignore
// only that placeholder, retaining intentional line breaks, blank lines and spaces.
export async function readEditableText(page: ProbePage, selector: string): Promise<string | null> {
	return page.evaluate<string | null>(
		`(function(){var root=document.querySelector(${JSON.stringify(selector)});if(!root)return null;if(root.tagName==='INPUT'||root.tagName==='TEXTAREA')return root.value;function read(e){if(e.nodeType===3)return e.nodeValue||'';if(e.nodeType!==1)return '';if(e.tagName==='BR'){var previous=e.previousSibling;return !e.nextSibling&&(e.parentNode===root||/^(P|DIV)$/.test(e.parentNode.tagName))?'':previous&&previous.nodeType===1&&previous.hasAttribute('data-lexical-linebreak')?'':'\\n';}if(e.hasAttribute('data-lexical-linebreak'))return '';var text='';for(var child=e.firstChild;child;child=child.nextSibling){text+=read(child);if(child.nextSibling&&child.nodeType===1&&/^(P|DIV)$/.test(child.tagName))text+='\\n\\n';}return text;}return read(root);})()`,
	);
}

export interface DevelopmentBrowser {
	identity: Record<string, unknown>;
	page: DevelopmentPage;
	newPage(): Promise<DevelopmentPage>;
	pages(): Promise<DevelopmentPage[]>;
}

export interface FirefoxOptions {
	firefox?: string;
	downloadDirectory?: string;
	environment?: Record<string, string>;
	headless?: boolean;
	viewport?: { width: number; height: number };
}

interface ProbeOptions {
	platform: "firefox" | "android";
	url: string;
	navigation: string;
	destination: string;
	menu?: string;
	session?: string;
	firefox?: string;
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

export async function withFirefoxBrowser<T>(
	options: FirefoxOptions,
	run: (browser: DevelopmentBrowser) => Promise<T>,
): Promise<T> {
	const binary = options.firefox;
	if (
		!binary ||
		!(await fs.stat(binary).then(
			value => value.isFile(),
			() => false,
		))
	)
		prerequisite(
			"firefox-binary",
			"Pass --firefox with an installed Firefox >=128 executable; this probe never downloads browsers",
		);
	const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-firefox-"));
	let client: FirefoxSelenium | undefined;
	let sessionId: string | undefined;
	try {
		const preferences: Record<string, string | number | boolean> = {
			"browser.shell.checkDefaultBrowser": false,
			"browser.startup.page": 0,
			"browser.startup.homepage_override.mstone": "ignore",
			"browser.sessionstore.resume_from_crash": false,
			"datareporting.policy.dataSubmissionPolicyBypassNotification": true,
			"toolkit.telemetry.reportingpolicy.firstRun": false,
			...(options.downloadDirectory
				? {
						"browser.download.folderList": 2,
						"browser.download.dir": options.downloadDirectory,
						"browser.download.useDownloadDir": true,
						"browser.helperApps.neverAsk.saveToDisk":
							"video/webm,video/mp4,application/octet-stream,text/html,text/plain,application/json",
						"browser.download.manager.showWhenStarting": false,
					}
				: {}),
		};
		client = connectFirefoxSelenium(timeout, options.environment);
		const selenium = client;
		const command = <TValue>(name: string, parameters?: object) => selenium.command<TValue>(name, parameters);
		const session = await command<{
			sessionId: string;
			capabilities: { browserName: string; browserVersion: string; platformName: string };
		}>("WebDriver:NewSession", {
			firefox: binary,
			profile,
			headless: options.headless ?? false,
			preferences,
			environment: options.environment,
			acceptInsecureCerts: false,
			timeouts: { implicit: 0, pageLoad: timeout, script: timeout },
		});
		sessionId = session.sessionId;
		if (typeof sessionId !== "string" || !sessionId) throw new Error("Selenium returned no Firefox session ID");
		if (options.viewport) await command("WebDriver:SetWindowRect", options.viewport);
		const evaluate = <TValue>(expression: string) =>
			command<TValue>("WebDriver:ExecuteScript", { script: `return ${expression};`, args: [] });
		const userAgent = await evaluate<string>("navigator.userAgent");
		const identity = assertFirefoxIdentity(
			session.capabilities.browserName,
			session.capabilities.browserVersion,
			userAgent,
		);
		const element = async (selector: string) => {
			const result = await command<Record<string, string>>("WebDriver:FindElement", {
				using: "css selector",
				value: selector,
			});
			const id = result["element-6066-11e4-a52e-4f735466cecf"];
			if (!id) throw new Error(`Selenium returned no element for ${selector}`);
			return id;
		};
		// WebDriver has one selected window per session. Keep each page operation
		// (selection, element lookup and native action) atomic across parallel pages.
		let pendingOperation: Promise<void> = Promise.resolve();
		const exclusive = <TValue>(operation: () => Promise<TValue>): Promise<TValue> => {
			const result = pendingOperation.then(operation);
			pendingOperation = result.then(
				() => {},
				() => {},
			);
			return result;
		};
		const windowHandle = (value: unknown): string => {
			if (typeof value !== "string" || !value.trim())
				throw new Error(`Selenium returned an invalid window handle: ${JSON.stringify(value)}`);
			return value;
		};
		const windowHandles = async (): Promise<string[]> => {
			const values = await command<unknown>("WebDriver:GetWindowHandles");
			if (!Array.isArray(values)) throw new Error("Selenium returned an invalid window handle list");
			const handles = values.map(windowHandle);
			if (new Set(handles).size !== handles.length) throw new Error("Selenium returned duplicate window handles");
			return handles;
		};
		const initial = windowHandle(await command<unknown>("WebDriver:GetWindowHandle"));
		const ownedHandles = new Set(await windowHandles());
		if (!ownedHandles.has(initial)) throw new Error("Selenium's initial window is not in its session handle list");
		const select = async (handle: string) => {
			if (!ownedHandles.has(handle)) throw new Error(`Firefox page is no longer owned: ${handle}`);
			await command("WebDriver:SwitchToWindow", { handle });
			if (windowHandle(await command<unknown>("WebDriver:GetWindowHandle")) !== handle)
				throw new Error(`Selenium did not switch to Firefox window ${handle}`);
		};
		type NativeKeyAction = { type: "keyDown" | "keyUp"; value: string } | { type: "pause"; duration: number };
		// Native Actions keep modifier release explicit and allow editor updates
		// between input events; no application service calls or synthetic DOM input.
		const nativeKeys = async (actions: NativeKeyAction[]) => {
			if (!actions.length) return;
			try {
				await command("WebDriver:PerformActions", {
					actions: [{ type: "key", id: "omp-acceptance-keyboard", actions }],
				});
			} finally {
				await command("WebDriver:ReleaseActions");
			}
		};
		const makePage = (handle: string): DevelopmentPage => {
			windowHandle(handle);
			const selected = <TValue>(operation: () => Promise<TValue>) =>
				exclusive(async () => {
					await select(handle);
					return operation();
				});
			const page: DevelopmentPage = {
				evaluate: <TValue>(expression: string) => selected(() => evaluate<TValue>(expression)),
				navigate: url =>
					selected(async () => {
						await command("WebDriver:Navigate", { url });
					}),
				reload: () =>
					selected(async () => {
						await command("WebDriver:Refresh");
					}),
				click: selector =>
					selected(async () => {
						await command("WebDriver:ElementClick", { id: await element(selector) });
					}),
				hover: selector =>
					selected(async () => {
						await element(selector);
						const point = await evaluate<{ x: number; y: number }>(
							`(function(){var e=document.querySelector(${JSON.stringify(selector)});var r=e.getBoundingClientRect();return {x:Math.floor(r.left+r.width/2),y:Math.floor(r.top+r.height/2)};})()`,
						);
						try {
							await command("WebDriver:PerformActions", {
								actions: [
									{
										type: "pointer",
										id: "omp-acceptance-pointer",
										parameters: { pointerType: "mouse" },
										actions: [{ type: "pointerMove", origin: "viewport", duration: 80, ...point }],
									},
								],
							});
						} finally {
							await command("WebDriver:ReleaseActions");
						}
					}),
				type: (selector, text) =>
					selected(async () => {
						const input = await element(selector);
						await command("WebDriver:ElementClick", { id: input });
						const actions: NativeKeyAction[] = [];
						for (const character of text.replace(/\r\n?/g, "\n")) {
							if (character === "\n") {
								actions.push(
									{ type: "keyDown", value: "\uE008" },
									{ type: "keyDown", value: "\uE006" },
									{ type: "keyUp", value: "\uE006" },
									{ type: "keyUp", value: "\uE008" },
								);
							} else {
								actions.push({ type: "keyDown", value: character }, { type: "keyUp", value: character });
							}
							actions.push({ type: "pause", duration: 1 });
						}
						await nativeKeys(actions);
					}),
				clear: selector =>
					selected(async () => {
						await command("WebDriver:ElementClick", { id: await element(selector) });
						const modifier = /mac|darwin/i.test(session.capabilities.platformName) ? "\uE03D" : "\uE009";
						await nativeKeys([
							{ type: "keyDown", value: modifier },
							{ type: "keyDown", value: "a" },
							{ type: "keyUp", value: "a" },
							{ type: "keyUp", value: modifier },
							{ type: "pause", duration: 1 },
							{ type: "keyDown", value: "\uE003" },
							{ type: "keyUp", value: "\uE003" },
							{ type: "pause", duration: 1 },
						]);
					}),
				press: (selector, key) =>
					selected(async () => {
						const keys: Record<string, string> = {
							Enter: "\uE007",
							Escape: "\uE00C",
							Tab: "\uE004",
							Backspace: "\uE003",
							ArrowDown: "\uE015",
							ArrowUp: "\uE013",
						};
						const value = keys[key];
						if (!value) throw new Error(`Unsupported Selenium key ${key}`);
						await command("WebDriver:ElementClick", { id: await element(selector) });
						await nativeKeys([
							{ type: "keyDown", value },
							{ type: "keyUp", value },
							{ type: "pause", duration: 1 },
						]);
					}),
				upload: (selector, files) =>
					selected(async () => {
						const text = files.join("\n");
						await command("WebDriver:ElementSendKeys", { id: await element(selector), text });
					}),
				draw: (selector, points) =>
					selected(async () => {
						if (points.length < 2) throw new Error("A real canvas stroke requires at least two points");
						const rectangle = await evaluate<{ left: number; top: number }>(
							`(function(){var r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {left:r.left,top:r.top};})()`,
						);
						const move = (point: { x: number; y: number }) => ({
							type: "pointerMove",
							origin: "viewport",
							duration: 80,
							x: Math.round(rectangle.left + point.x),
							y: Math.round(rectangle.top + point.y),
						});
						try {
							await command("WebDriver:PerformActions", {
								actions: [
									{
										type: "pointer",
										id: "omp-acceptance-pointer",
										parameters: { pointerType: "mouse" },
										actions: [
											move(points[0]!),
											{ type: "pointerDown", button: 0 },
											...points.slice(1).map(move),
											{ type: "pointerUp", button: 0 },
										],
									},
								],
							});
						} finally {
							await command("WebDriver:ReleaseActions");
						}
					}),
				close: () =>
					exclusive(async () => {
						if (!ownedHandles.has(handle)) return;
						if ((await windowHandles()).includes(handle)) {
							await select(handle);
							await command("WebDriver:CloseWindow");
						}
						ownedHandles.delete(handle);
					}),
				screenshot: file =>
					selected(async () => {
						const image = await command<string>("WebDriver:TakeScreenshot");
						await fs.writeFile(file, Buffer.from(image, "base64"));
					}),
				typeDraft: text => page.type(INPUT, text),
				clearDraft: () => page.clear(INPUT),
			};
			return page;
		};
		return await run({
			identity: {
				...identity,
				executable: binary,
				automationProtocol: "selenium-geckodriver",
				capabilities: session.capabilities,
				windowRect: await command("WebDriver:GetWindowRect"),
				profile,
				isolatedProfile: true,
				...(options.downloadDirectory ? { downloadDirectory: options.downloadDirectory } : {}),
			},
			page: makePage(initial),
			newPage: () =>
				exclusive(async () => {
					const before = await windowHandles();
					const opened = await command<{ handle: string; type: string }>("WebDriver:NewWindow", {
						type: "tab",
					});
					const handle = windowHandle(opened.handle);
					if (before.includes(handle) || !(await windowHandles()).includes(handle))
						throw new Error(`Selenium did not create a new Firefox window with handle ${handle}`);
					ownedHandles.add(handle);
					await select(handle);
					return makePage(handle);
				}),
			pages: () =>
				exclusive(async () => (await windowHandles()).filter(handle => ownedHandles.has(handle)).map(makePage)),
		});
	} finally {
		try {
			if (sessionId && client) await client.command("WebDriver:DeleteSession");
		} finally {
			try {
				await client?.close();
			} finally {
				await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
			}
		}
	}
}

async function firefoxProbe(options: ProbeOptions): Promise<object> {
	return withFirefoxBrowser(options, async browser => ({
		...browser.identity,
		profile: "temporary; removed after session",
		...(await exercise(browser.page, options)),
	}));
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
				"Use --platform firefox|android --url DIRECT_OMP_URL --nav-selector CSS --nav-ready-selector CSS [--menu-selector CSS --session-selector CSS] [--firefox PATH] [--adb PATH --serial SERIAL --socket chrome_devtools_remote]",
			);
		values.set(key, value);
	}
	const platform = values.get("platform");
	if (platform !== "firefox" && platform !== "android")
		prerequisite(
			"platform",
			"Explicit --platform firefox or --platform android is required; this is never a Chromium mobile-emulation pass",
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
		firefox: values.get("firefox") ?? process.env.FIREFOX_EXECUTABLE,
		adb: values.get("adb") ?? process.env.ADB_EXECUTABLE,
		serial: values.get("serial") ?? process.env.ANDROID_SERIAL,
		socket: values.get("socket") ?? "chrome_devtools_remote",
	};
}

if (import.meta.main) {
	try {
		const options = parseOptions(process.argv.slice(2));
		const evidence = await (options.platform === "firefox" ? firefoxProbe(options) : androidProbe(options));
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
						...(options.platform === "firefox"
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
