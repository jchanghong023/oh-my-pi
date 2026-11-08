import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ptree } from "@oh-my-pi/pi-utils";

const registryModule = JSON.stringify(path.join(import.meta.dir, "../../src/webgui/project-registry.ts"));
const serverModule = JSON.stringify(path.join(import.meta.dir, "../../src/webgui/server.ts"));
const nativeServerModule = JSON.stringify(path.join(import.meta.dir, "../../src/dev-workbench/server.ts"));
const processTreeModule = JSON.stringify(path.join(import.meta.dir, "../../../utils/src/ptree.ts"));

const bootstrapFixture = `
import { closeWebServer, ensureWebServer } from ${serverModule};
import { startDevWorkbenchServer } from ${nativeServerModule};
async function startBootstrap(projectId) {
	// Bootstrap must not require native sessions, models or business callbacks.
	const host = new Proxy({}, {
		get() { throw new Error("Bootstrap unexpectedly accessed the native host"); },
	});
	const html = new TextEncoder().encode("<!doctype html><title>Native bootstrap fixture</title>");
	return startDevWorkbenchServer(host, {
		basePath: "/dev/" + projectId + "/",
		offline: false,
		asset: async assetPath => assetPath === "/" ? { bytes: html, contentType: "text/html; charset=utf-8" } : null,
	});
}
`;

interface OwnershipAttempt {
	outcome: "acquired" | "rejected";
	projectId?: string;
	root?: string;
	mode?: "dev" | "webgui";
	error?: string;
}

// Every contender has its own native lock handles and module state, not just a separate lease object.
const contenderScript = `
import { acquireBrowserProject } from ${registryModule};
let lease;
let result;
try {
	try {
		lease = await acquireBrowserProject(process.env.OWNERSHIP_PROJECT, process.env.OWNERSHIP_MODE);
		result = { outcome: "acquired", projectId: lease.projectId, root: lease.root, mode: lease.mode };
	} catch (error) {
		result = { outcome: "rejected", error: String(error) };
	}
} finally {
	await lease?.close();
}
console.log(JSON.stringify(result));
`;

async function runScenario<T>(root: string, body: string): Promise<T> {
	const script = `
import * as path from "node:path";
import { acquireBrowserProject, listBrowserProjects, readBrowserProject } from ${registryModule};
${bootstrapFixture}
import * as ptree from ${processTreeModule};
const root = process.env.OWNERSHIP_FIXTURE_ROOT;
const contenderScript = ${JSON.stringify(contenderScript)};
async function contend(project, mode, overrides = {}) {
	const child = Bun.spawn([process.execPath, "--eval", contenderScript], {
		cwd: root,
		env: { ...process.env, ...overrides, OWNERSHIP_PROJECT: project, OWNERSHIP_MODE: mode },
		stdin: "ignore", stdout: "pipe", stderr: "pipe",
	});
	const timer = setTimeout(() => child.kill(), 10_000);
	try {
		const [exitCode, stdout, stderr] = await Promise.all([
			child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
		]);
		if (exitCode !== 0) throw new Error("Ownership contender failed: " + stderr);
		return JSON.parse(stdout);
	} finally {
		clearTimeout(timer);
		child.kill();
		await child.exited;
	}
}
const result = await (async () => {
${body}
})();
console.log(JSON.stringify(result));
`;
	const child = ptree.spawn([process.execPath, "--eval", script], {
		cwd: root,
		env: {
			...process.env,
			HOME: path.join(root, "home"),
			USERPROFILE: path.join(root, "home"),
			OMP_CONFIG_ROOT: path.join(root, "config"),
			OMP_PROFILE: "owner",
			PI_PROFILE: "owner",
			PI_CODING_AGENT_DIR: "",
			OWNERSHIP_FIXTURE_ROOT: root,
		},
		stdin: "ignore",
		timeout: 45_000,
		subreaper: true,
	});
	const completion = child.wait({ allowNonZero: true, allowAbort: true });
	try {
		const { exitCode, stdout, stderr } = await completion;
		expect(exitCode, stderr).toBe(0);
		return JSON.parse(stdout) as T;
	} finally {
		child.kill();
		await completion;
	}
}

function expectOccupied(attempt: OwnershipAttempt): void {
	expect(attempt.outcome).toBe("rejected");
	expect(attempt.error).toMatch(/占用|occupied|in use/i);
}

test("a live native owner excludes another mode across directory aliases, profiles and config roots", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-project-owner-"));
	try {
		const project = path.join(root, "project");
		await fs.mkdir(project);
		await fs.symlink(project, path.join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
		const result = await runScenario<{
			ownerId: string;
			alias: OwnershipAttempt;
			profile: OwnershipAttempt;
			config: OwnershipAttempt;
			afterClose: OwnershipAttempt;
		}>(
			root,
			`
	const project = path.join(root, "project");
	const alias = path.join(root, "alias");
	const alternateConfig = { OMP_CONFIG_ROOT: path.join(root, "other-config"), OMP_PROFILE: "other", PI_PROFILE: "other" };
	const owner = await acquireBrowserProject(project, "dev");
	try {
		const aliasAttempt = await contend(alias, "webgui");
		const profileAttempt = await contend(project, "webgui", { OMP_PROFILE: "other", PI_PROFILE: "other" });
		const configAttempt = await contend(alias, "webgui", alternateConfig);
		await owner.close();
		const afterClose = await contend(alias, "webgui", alternateConfig);
		return { ownerId: owner.projectId, alias: aliasAttempt, profile: profileAttempt, config: configAttempt, afterClose };
	} finally {
		await owner.close();
	}
`,
		);
		expectOccupied(result.alias);
		expectOccupied(result.profile);
		expectOccupied(result.config);
		expect(result.afterClose).toEqual({
			outcome: "acquired",
			projectId: result.ownerId,
			root: await fs.realpath(project),
			mode: "webgui",
		});
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}, 60_000);

test("projects retain independent process-local leases through exiting and close", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-project-owners-"));
	try {
		const projectA = path.join(root, "a");
		const projectB = path.join(root, "b");
		await Promise.all([fs.mkdir(projectA), fs.mkdir(projectB)]);
		const result = await runScenario<{
			projects: { root: string; mode: string }[];
			exitingPhase: string;
			whileExiting: OwnershipAttempt;
			afterClose: OwnershipAttempt;
			otherProject: OwnershipAttempt;
			released: unknown;
			remaining: { root: string; mode: string }[];
		}>(
			root,
			`
	let a;
	let b;
	try {
		a = await acquireBrowserProject(path.join(root, "a"), "webgui");
		b = await acquireBrowserProject(path.join(root, "b"), "dev");
		const summarize = records => records.map(({ root, mode }) => ({ root, mode }));
		const projects = summarize(await listBrowserProjects());
		await a.markExiting();
		const exitingPhase = (await readBrowserProject(a.projectId))?.phase;
		const whileExiting = await contend(a.root, "dev");
		await a.close();
		const afterClose = await contend(a.root, "dev");
		await a.close();
		const otherProject = await contend(b.root, "webgui");
		const released = await readBrowserProject(a.projectId);
		const remaining = summarize(await listBrowserProjects());
		return { projects, exitingPhase, whileExiting, afterClose, otherProject, released, remaining };
	} finally {
		await Promise.all([a?.close(), b?.close()]);
	}
`,
		);
		const canonicalA = await fs.realpath(projectA);
		const canonicalB = await fs.realpath(projectB);
		expect(result.projects).toEqual([
			{ root: canonicalA, mode: "webgui" },
			{ root: canonicalB, mode: "dev" },
		]);
		expect(result.exitingPhase).toBe("exiting");
		expectOccupied(result.whileExiting);
		expect(result.afterClose).toMatchObject({ outcome: "acquired", root: canonicalA, mode: "dev" });
		expectOccupied(result.otherProject);
		expect(result.released).toBeNull();
		expect(result.remaining).toEqual([{ root: canonicalB, mode: "dev" }]);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}, 60_000);

test("the native process runtime isolates project modes and closes only its own listener", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-project-runtime-"));
	try {
		await Promise.all([fs.mkdir(path.join(root, "a")), fs.mkdir(path.join(root, "b"))]);
		const peerScript = `
${bootstrapFixture}
const native = await startBootstrap("independent-process");
try {
	console.log(JSON.stringify({ url: native.loopbackUrl }));
	await Bun.stdin.text();
} finally {
	await native.close();
	await closeWebServer();
}
`;
		const result = await runScenario<{
			reused: boolean;
			sameNativeListener: boolean;
			independentListener: boolean;
			devInfo: number;
			webInfo: number;
			missingCapability: number;
			wrongCapability: number;
			wrongOrigin: number;
			wrongHost: number;
			browserBootstrap: number;
			scopedBrowserCookie: boolean;
			browserCookieReused: boolean;
			browserCookieRequired: number;
			publicTargetHidden: boolean;
			closedInfo: number;
			closedNative: number;
			survivingInfo: number;
			localStopped: boolean;
			peerSurviving: number;
			peerExit: number | null;
		}>(
			root,
			`
	const peer = ptree.spawn([process.execPath, "--eval", ${JSON.stringify(peerScript)}], {
		cwd: root, env: { ...process.env }, stdin: "pipe", timeout: 35_000, subreaper: true,
	});
	let peerDone;
	let a;
	let b;
	let native;
	try {
		const reader = peer.stdout.getReader();
		let ready = "";
		try {
			const decoder = new TextDecoder();
			while (!ready.includes("\\n")) {
				const chunk = await reader.read();
				if (chunk.done) throw new Error("Independent native process exited before readiness");
				ready += decoder.decode(chunk.value, { stream: true });
			}
		} finally {
			reader.releaseLock();
		}
		peerDone = peer.wait({ allowNonZero: true, allowAbort: true });
		const peerUrl = JSON.parse(ready.slice(0, ready.indexOf("\\n"))).url;
		const server = await ensureWebServer();
		const reused = (await ensureWebServer()).loopbackUrl === server.loopbackUrl;
		a = await acquireBrowserProject(path.join(root, "a"), "dev");
		b = await acquireBrowserProject(path.join(root, "b"), "webgui");
		native = await startBootstrap(a.projectId);
		await a.activate(() => ({ bound: false }), { allowLan: false });
		await b.activate(() => ({ bound: false }), { allowLan: false });
		async function status(url, options = {}) {
			const response = await fetch(url, { ...options, signal: AbortSignal.timeout(5_000) });
			await response.body?.cancel();
			return response.status;
		}
		const infoUrl = project => server.loopbackUrl + "api/omp/session-info?projectId=" + project.projectId;
		const devInfo = await status(infoUrl(a));
		const webInfo = await status(infoUrl(b));
		const nativeUrl = new URL(native.loopbackUrl);
		const publicDevBase = server.loopbackUrl + "dev/" + a.projectId + "/";
		const capability = nativeUrl.pathname.slice(new URL(publicDevBase).pathname.length, -1);
		const browserHeaders = { Origin: nativeUrl.origin };
		const missingCapability = await status(publicDevBase + "api/browser", { headers: browserHeaders });
		const wrongCapability = await status(publicDevBase +
			(capability[0] === "0" ? "1" : "0") + capability.slice(1) + "/api/browser", { headers: browserHeaders });
		const bootstrapUrl = new URL("api/browser", nativeUrl);
		const wrongOrigin = await status(bootstrapUrl, { headers: { Origin: "http://attacker.invalid" } });
		const wrongHost = await status(bootstrapUrl, { headers: { Host: "attacker.invalid" } });
		const bootstrap = await fetch(bootstrapUrl, {
			headers: browserHeaders, signal: AbortSignal.timeout(5_000),
		});
		const browserBootstrap = bootstrap.status;
		const setCookie = bootstrap.headers.get("set-cookie");
		const cookiePath = setCookie?.split(";")
			.map(part => part.trim()).find(part => part.toLowerCase().startsWith("path="))?.slice(5);
		const scopedBrowserCookie = cookiePath === nativeUrl.pathname;
		const browser = await bootstrap.json();
		const repeated = await fetch(bootstrapUrl, {
			headers: { ...browserHeaders, Cookie: setCookie?.split(";")[0] ?? "" },
			signal: AbortSignal.timeout(5_000),
		});
		const repeatedBrowser = await repeated.json();
		const browserCookieReused = repeated.status === 200 && repeatedBrowser.browserId === browser.browserId;
		const browserCookieRequired = await status(new URL("api/requirements", nativeUrl), { headers: browserHeaders });
		const projectsResponse = await fetch(server.loopbackUrl + "api/omp/projects", {
			signal: AbortSignal.timeout(5_000),
		});
		if (projectsResponse.status !== 200) throw new Error("Process project list is unavailable");
		const publicProjects = await projectsResponse.json();
		if (!publicProjects.projects.some(project => project.projectId === a.projectId && project.mode === "dev") ||
			!publicProjects.projects.some(project => project.projectId === b.projectId && project.mode === "webgui"))
			throw new Error("Process project list omitted an owned mode");
		const publicTargetHidden = !JSON.stringify(publicProjects).includes(capability);
		await native.close();
		await a.close();
		const closedInfo = await status(infoUrl(a));
		const closedNative = await status(bootstrapUrl, { headers: browserHeaders });
		const survivingInfo = await status(infoUrl(b));
		await b.close();
		await closeWebServer();
		let localStopped = false;
		try {
			await status(server.loopbackUrl + "api/omp/projects");
		} catch {
			localStopped = true;
		}
		const peerSurviving = await status(new URL("api/browser", peerUrl), {
			headers: { Origin: new URL(peerUrl).origin },
		});
		peer.stdin.end();
		const stopped = await peerDone;
		return {
			reused,
			sameNativeListener: nativeUrl.origin === new URL(server.loopbackUrl).origin,
			independentListener: new URL(peerUrl).origin !== nativeUrl.origin,
			devInfo, webInfo, closedInfo, closedNative, survivingInfo, localStopped, peerSurviving,
			missingCapability, wrongCapability, wrongOrigin, wrongHost, browserBootstrap,
			scopedBrowserCookie, browserCookieReused, browserCookieRequired, publicTargetHidden,
			peerExit: stopped.exitCode,
		};
	} finally {
		try {
			await native?.close();
			await Promise.all([a?.close(), b?.close()]);
			await closeWebServer();
		} finally {
			peer.kill();
			await (peerDone ?? peer.wait({ allowNonZero: true, allowAbort: true }));
		}
	}
`,
		);
		expect(result).toEqual({
			reused: true,
			sameNativeListener: true,
			independentListener: true,
			devInfo: 409,
			webInfo: 200,
			missingCapability: 404,
			wrongCapability: 404,
			wrongOrigin: 403,
			wrongHost: 403,
			browserBootstrap: 200,
			scopedBrowserCookie: true,
			browserCookieReused: true,
			browserCookieRequired: 401,
			publicTargetHidden: true,
			closedInfo: 404,
			closedNative: 404,
			survivingInfo: 200,
			localStopped: true,
			peerSurviving: 200,
			peerExit: 0,
		});
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}, 60_000);
