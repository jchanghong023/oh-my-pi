import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ptree } from "@oh-my-pi/pi-utils";

const registryModule = JSON.stringify(path.join(import.meta.dir, "../../src/webgui/project-registry.ts"));
const sharedServerModule = JSON.stringify(path.join(import.meta.dir, "../../src/webgui/shared-server.ts"));
const processTreeModule = JSON.stringify(path.join(import.meta.dir, "../../../utils/src/ptree.ts"));

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
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { acquireBrowserProject, listBrowserProjects, readBrowserProject, webGuiRuntimeDir } from ${registryModule};
import { ensureSharedWebServer } from ${sharedServerModule};
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
		}>(root, `
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
`);
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

test("projects retain independent leases through exiting and close, and stale discovery cannot revive an owner", async () => {
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
			stale: unknown;
			remaining: { root: string; mode: string }[];
		}>(root, `
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
		const recordPath = path.join(webGuiRuntimeDir(), "projects", a.projectId + ".json");
		const staleRecord = await fs.readFile(recordPath, "utf8");
		await a.close();
		const afterClose = await contend(a.root, "dev");
		await a.close();
		const otherProject = await contend(b.root, "webgui");
		// Recreate the real persisted registration, as after an unclean owner shutdown.
		await fs.writeFile(recordPath, staleRecord);
		const stale = await readBrowserProject(a.projectId);
		const remaining = summarize(await listBrowserProjects());
		return { projects, exitingPhase, whileExiting, afterClose, otherProject, stale, remaining };
	} finally {
		await Promise.all([a?.close(), b?.close()]);
	}
`);
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
		expect(result.stale).toBeNull();
		expect(result.remaining).toEqual([{ root: canonicalB, mode: "dev" }]);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}, 60_000);

test("the shared gateway isolates project selection and only shuts down after its final owner closes", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-project-gateway-"));
	try {
		await Promise.all([fs.mkdir(path.join(root, "a")), fs.mkdir(path.join(root, "b"))]);
		const workerScript = `import { runSharedWebServerWorker } from ${sharedServerModule}; await runSharedWebServerWorker();`;
		const result = await runScenario<{
			reused: boolean;
			devInfo: number;
			webInfo: number;
			missingCapability: number;
			wrongCapability: number;
			browserBootstrap: number;
			scopedBrowserCookie: boolean;
			publicTargetHidden: boolean;
			closedInfo: number;
			survivingInfo: number;
			occupiedShutdown: number;
			emptyShutdown: number;
			workerExit: number;
		}>(root, `
	const workerEnv = { ...process.env };
	delete workerEnv.BUN_BE_BUN;
	const worker = ptree.spawn([process.execPath, "--eval", ${JSON.stringify(workerScript)}], {
		cwd: root, env: workerEnv, stdin: "ignore", timeout: 40_000, subreaper: true,
	});
	const workerDone = worker.wait({ allowNonZero: true, allowAbort: true });
	let a;
	let b;
	let native;
	try {
		const descriptorPath = path.join(webGuiRuntimeDir(), "server.json");
		const deadline = Date.now() + 30_000;
		let discovery;
		while (Date.now() < deadline) {
			if (worker.exitCode !== null) throw new Error("Shared gateway worker exited before readiness");
			try {
				const candidate = JSON.parse(await fs.readFile(descriptorPath, "utf8"));
				const response = await fetch(candidate.apiOrigin + "/internal/omp/ready", {
					headers: { Authorization: "Bearer " + candidate.token },
					signal: AbortSignal.timeout(1_000),
				});
				await response.body?.cancel();
				if (response.status === 200) { discovery = candidate; break; }
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
			await Bun.sleep(50);
		}
		if (!discovery) throw new Error("Shared gateway did not publish a ready descriptor");
		// Ensure must discover this explicitly owned worker, never start an untracked service.
		const server = await ensureSharedWebServer();
		a = await acquireBrowserProject(path.join(root, "a"), "dev");
		b = await acquireBrowserProject(path.join(root, "b"), "webgui");
		const capability = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
		const nativePrefix = "/" + capability + "/";
		let nativeOrigin;
		// Protocol fixture: the native boundary must receive both the capability and rewritten browser headers.
		native = Bun.serve({
			hostname: "127.0.0.1", port: 0,
			fetch(request) {
				const url = new URL(request.url);
				if (request.headers.get("host") !== new URL(nativeOrigin).host ||
					request.headers.get("origin") !== nativeOrigin) return new Response(null, { status: 403 });
				if (url.pathname !== nativePrefix + "api/browser") return new Response(null, { status: 404 });
				if (request.method !== "GET") return new Response(null, { status: 405 });
				return Response.json({ browserId: "fixture-browser" }, {
					headers: { "Set-Cookie": "omp_dev_fixture=fixture-browser; Path=" + nativePrefix + "; HttpOnly; SameSite=Strict" },
				});
			},
		});
		nativeOrigin = "http://127.0.0.1:" + native.port;
		await a.activate(() => ({ bound: false }), nativeOrigin + nativePrefix);
		await b.activate(() => ({ bound: false }));
		async function status(url, options = {}) {
			const response = await fetch(url, { ...options, signal: AbortSignal.timeout(5_000) });
			await response.body?.cancel();
			return response.status;
		}
		const infoUrl = project => server.loopbackUrl + "api/omp/session-info?projectId=" + project.projectId;
		const shutdown = () => status(discovery.apiOrigin + "/internal/omp/shutdown", {
			method: "POST", headers: { Authorization: "Bearer " + discovery.token },
		});
		const devInfo = await status(infoUrl(a));
		const webInfo = await status(infoUrl(b));
		const publicDevBase = server.loopbackUrl + "dev/" + a.projectId + "/";
		const publicDevPrefix = "/dev/" + a.projectId + "/" + capability + "/";
		const browserHeaders = { Origin: new URL(server.loopbackUrl).origin };
		const missingCapability = await status(publicDevBase + "api/browser", { headers: browserHeaders });
		const wrongCapability = await status(publicDevBase +
			(capability[0] === "0" ? "1" : "0") + capability.slice(1) + "/api/browser", { headers: browserHeaders });
		const bootstrap = await fetch(server.loopbackUrl + publicDevPrefix.slice(1) + "api/browser", {
			headers: browserHeaders, signal: AbortSignal.timeout(5_000),
		});
		const browserBootstrap = bootstrap.status;
		const cookiePath = bootstrap.headers.get("set-cookie")?.split(";")
			.map(part => part.trim()).find(part => part.toLowerCase().startsWith("path="))?.slice(5);
		const scopedBrowserCookie = cookiePath === publicDevPrefix;
		await bootstrap.body?.cancel();
		const projectsResponse = await fetch(server.loopbackUrl + "api/omp/projects", {
			signal: AbortSignal.timeout(5_000),
		});
		const publicProjects = await projectsResponse.json();
		const listedDev = publicProjects.projects.find(project => project.projectId === a.projectId);
		if (!listedDev) throw new Error("Public project discovery omitted the live Dev owner");
		const publicTargetHidden = !JSON.stringify(publicProjects).includes(capability);
		await a.close();
		const closedInfo = await status(infoUrl(a));
		const survivingInfo = await status(infoUrl(b));
		const occupiedShutdown = await shutdown();
		await b.close();
		const emptyShutdown = await shutdown();
		const stopped = await workerDone;
		return {
			reused: server.loopbackUrl === discovery.loopbackUrl,
			devInfo, webInfo, closedInfo, survivingInfo, occupiedShutdown, emptyShutdown,
			missingCapability, wrongCapability, browserBootstrap, scopedBrowserCookie, publicTargetHidden,
			workerExit: stopped.exitCode,
		};
	} finally {
		try {
			await Promise.all([a?.close(), b?.close(), native?.stop(true)]);
		} finally {
			worker.kill();
			await workerDone;
		}
	}
`);
		expect(result).toEqual({
			reused: true,
			devInfo: 409,
			webInfo: 200,
			missingCapability: 404,
			wrongCapability: 404,
			browserBootstrap: 200,
			scopedBrowserCookie: true,
			publicTargetHidden: true,
			closedInfo: 404,
			survivingInfo: 200,
			occupiedShutdown: 409,
			emptyShutdown: 200,
			workerExit: 0,
		});
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}, 60_000);
