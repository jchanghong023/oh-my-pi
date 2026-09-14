/**
 * Temporary CI diagnostic: resolve the Chromium the browser tool would use,
 * launch a headless browser the way the tests do, and probe the DevTools HTTP
 * endpoint that `waitForCdp` polls. Deleted with ci-diag.yml.
 */
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
	try {
		const alt = await fetch(`http://localhost:${port}/json/version`);
		console.log("localhost status:", alt.status);
	} catch (error) {
		console.log("localhost fetch failed:", String(error));
	}
}

console.log("version:", await launched.browser.version());
await launched.browser.close();
console.log("closed ok");
