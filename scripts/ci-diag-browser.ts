/**
 * Temporary CI diagnostic: resolve the Chromium the browser tool would use,
 * launch a headless browser the way the tests do, and probe the DevTools HTTP
 * endpoint that `waitForCdp` polls. Also checks whether the reusable-CDP
 * process scan finds the launched instance under the resolved path vs its
 * realpath (Debian/Ubuntu ship google-chrome-stable as a wrapper script that
 * execs /opt/google/chrome/chrome). Deleted with ci-diag.yml.
 */
import { mkdtemp } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Process } from "@oh-my-pi/pi-natives";
import { findReusableCdp, waitForCdp } from "../packages/coding-agent/src/tools/browser/attach";
import { ensureChromiumExecutable, launchHeadlessBrowser } from "../packages/coding-agent/src/tools/browser/launch";

const executable = await ensureChromiumExecutable();
console.log("resolved executable:", executable ?? "(none)");

const launched = await launchHeadlessBrowser({ headless: true });
const ws = launched.browser.wsEndpoint();
console.log("wsEndpoint:", ws);

if (ws) {
	const port = new URL(ws).port;
	console.log("probe port:", port);
	try {
		const response = await fetch(`http://127.0.0.1:${port}/json/version`);
		console.log("json/version status:", response.status);
		console.log("json/version body:", (await response.text()).slice(0, 160));
	} catch (error) {
		console.log("json/version fetch failed:", String(error));
	}
}
console.log("version:", await launched.browser.version());
await launched.browser.close();
console.log("closed ok");

if (!executable) process.exit(0);

const realpathText = await Bun.$`readlink -f ${executable}`.text();
const realpath = realpathText.trim();
console.log("exe path:", executable);
console.log("exe realpath:", realpath);
console.log("Process.fromPath(exe):", Process.fromPath(executable).length);
console.log("Process.fromPath(realpath):", Process.fromPath(realpath).length);

const dir = await mkdtemp(path.join(os.tmpdir(), "ci-diag-borrowed-"));
const profile = path.join(dir, "borrowed");
const listening = Bun.serve({ port: 0, fetch: () => new Response("") });
const port = listening.port;
listening.stop(true);

const child = Bun.spawn(
	[
		executable,
		"--headless=new",
		"--no-sandbox",
		"--no-first-run",
		"--no-default-browser-check",
		`--user-data-dir=${profile}`,
		`--remote-debugging-port=${port}`,
	],
	{ stdin: "ignore", stdout: "ignore", stderr: "ignore" },
);
try {
	await waitForCdp(`http://127.0.0.1:${port}`, 20_000);
	console.log("borrowed chrome is up on port", port);
	const appArgs = ["--headless=new", "--no-sandbox", "--no-first-run", "--no-default-browser-check", "--user-data-dir", profile];
	console.log("findReusableCdp(exe):", await findReusableCdp(executable, { appArgs }));
	console.log("findReusableCdp(realpath):", await findReusableCdp(realpath, { appArgs }));
} catch (error) {
	console.log("borrowed chrome probe failed:", String(error));
} finally {
	child.kill();
}
