import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { dropRead } from "@oh-my-pi/pi-coding-agent/tools/browser/interactions";
import { releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import type { ElementHandle } from "puppeteer-core";
import { rejectionOf } from "../helpers/rejection";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

// Drop zones that read `files`, read only `items`, read them after awaiting in an async drop handler, are delegated
// from one document listener (React 16 and older, jQuery `.on("drop", selector)`), or are taken by a document capture
// listener the page registered before the upload ran, which stops the drop there; and a plain element that neither
// opens a chooser nor takes a drop, though it reads `items` on dragenter, and again deferred to a microtask on
// dragover, as zones do to style themselves. Like react-dropzone, the page cancels dragover and drop everywhere so a
// file dropped outside a zone does not navigate away.
const html = `<!doctype html>
<style>div { display: block; margin: 8px; padding: 8px; }</style>
<div id="drop">Drop files here</div>
<div id="items">Drop files here too</div>
<div id="awaited">Async drop zone</div>
<div id="delegated"><span>Delegated drop zone</span></div>
<div id="captured">Captured drop zone</div>
<div id="inert">Not a drop zone</div>
<script>
window.log = [];
document.addEventListener("drop", event => {
  if (event.target.id !== "captured") return;
  event.preventDefault();
  event.stopImmediatePropagation();
  log.push({ id: "captured", names: [...event.dataTransfer.files].map(file => file.name) });
}, true);
const drop = document.getElementById("drop");
drop.addEventListener("dragover", event => event.preventDefault());
drop.addEventListener("drop", event => {
  event.preventDefault();
  log.push({ id: "drop", names: [...event.dataTransfer.files].map(file => file.name) });
});
document.getElementById("items").addEventListener("drop", event => {
  event.preventDefault();
  log.push({ id: "items", names: Array.from(event.dataTransfer.items, item => item.getAsFile().name) });
});
document.getElementById("awaited").addEventListener("drop", async event => {
  event.preventDefault();
  await null;
  await Promise.resolve();
  log.push({ id: "awaited", names: [...event.dataTransfer.files].map(file => file.name) });
});
const inert = document.getElementById("inert");
inert.addEventListener("dragenter", event => log.push({ id: "inert-dragenter", items: event.dataTransfer.items.length }));
inert.addEventListener("dragover", event =>
  queueMicrotask(() => log.push({ id: "inert-dragover", items: event.dataTransfer.items.length })),
);
inert.addEventListener("drop", event => log.push({ id: "inert", names: [] }));
document.addEventListener("drop", event => {
  if (!event.target.closest("#delegated")) return;
  log.push({ id: "delegated", names: [...event.dataTransfer.files].map(file => file.name) });
});
document.addEventListener("dragover", event => event.preventDefault());
document.addEventListener("drop", event => event.preventDefault());
</script>`;

let tempDir = "";
let site: Bun.Server<undefined> | undefined;
let url = "";

function makeSession(): ToolSession {
	return {
		cwd: tempDir,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({
			"browser.enabled": true,
			"browser.headless": true,
			"browser.cmux": false,
			"browser.tern": false,
			"tools.maxTimeout": 0,
		}),
	};
}

beforeAll(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-browser-upload-"));
	await Bun.write(path.join(tempDir, "alpha.txt"), "alpha");
	site = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response(html, { headers: { "content-type": "text/html" } }),
	});
	url = `http://127.0.0.1:${site.port}/`;
});

afterAll(async () => {
	await releaseAllTabs({ kill: true });
	await disposeAllVmContexts();
	site?.stop(true);
	if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

describe.skipIf(!CHROMIUM_AVAILABLE)("browser uploadFile", () => {
	test("fails when the target neither opens a chooser nor accepts a drop", async () => {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const context = { session, toolCallId: "browser-upload-inert" };
		const name = `upload-${crypto.randomUUID()}`;
		await prelude.invoke({ action: "open", name, url }, context);
		try {
			const result = await prelude.invoke(
				{
					action: "run",
					name,
					timeout: 15,
					code: `const errors = [];
for (const selector of ["#drop", "#items", "#awaited", "#delegated", "#captured", "#inert"]) {
	try { await tab.uploadFile(selector, "alpha.txt"); errors.push(null); }
	catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
}
return { errors, log: await tab.evaluate(() => window.log) };`,
				},
				context,
			);
			const details = result.details;
			if (!details || typeof details !== "object" || !("value" in details)) throw new Error("run returned no value");
			// `run` details carry the cell's return value untyped.
			const { errors, log } = details.value as { errors: (string | null)[]; log: unknown[] };
			expect(errors).toEqual([
				null,
				null,
				null,
				null,
				null,
				expect.stringContaining("nothing on the page took the dropped files"),
			]);
			// The inert element and the document saw the drag events but did not take the drop's files; the inert
			// element's deferred dragover read settles before the drop.
			expect(log).toEqual([
				{ id: "drop", names: ["alpha.txt"] },
				{ id: "items", names: ["alpha.txt"] },
				{ id: "awaited", names: ["alpha.txt"] },
				{ id: "delegated", names: ["alpha.txt"] },
				{ id: "captured", names: ["alpha.txt"] },
				{ id: "inert-dragenter", items: 1 },
				{ id: "inert-dragover", items: 1 },
				{ id: "inert", names: [] },
			]);
		} finally {
			await prelude.invoke({ action: "close", name, kill: true }, context).catch(() => undefined);
		}
	}, 60_000);
});

test.each(["adoptHandle", "evaluateHandle"] as const)(
	"releases what %s returns after the upload was cancelled",
	async step => {
		const { promise: late, resolve: land } = Promise.withResolvers<unknown>();
		const controller = new AbortController();
		const released: string[] = [];
		// Only what the watch touches before the drop: adopting the zone into the main world and installing the
		// watch; the cancel interrupts `step`.
		const steps = {
			adoptHandle: async () => ({ dispose: async () => {} }) as unknown,
			evaluateHandle: async () => ({}) as unknown,
		};
		const realm = {
			...steps,
			[step]: () => {
				controller.abort();
				return late;
			},
		};
		const zone = { frame: { mainRealm: () => realm } } as unknown as ElementHandle;
		let dropped = false;
		await rejectionOf(
			dropRead(
				zone,
				async () => {
					dropped = true;
				},
				controller.signal,
			),
		);
		land({
			evaluate: async () => {
				released.push("ended");
			},
			dispose: async () => {
				released.push("disposed");
			},
		});
		for (let turn = 0; turn < 5; turn++) await Promise.resolve();
		expect(dropped).toBe(false);
		// A late watch is ended before its handle goes; a late adoption only has a handle to release.
		expect(released).toEqual(step === "evaluateHandle" ? ["ended", "disposed"] : ["disposed"]);
	},
);
