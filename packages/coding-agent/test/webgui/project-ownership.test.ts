import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ptree } from "@oh-my-pi/pi-utils";

const registryModule = JSON.stringify(path.join(import.meta.dir, "../../src/webgui/project-registry.ts"));
const serverModule = JSON.stringify(path.join(import.meta.dir, "../../src/webgui/server.ts"));
const processTreeModule = JSON.stringify(path.join(import.meta.dir, "../../../utils/src/ptree.ts"));

interface OwnershipAttempt {
	outcome: "acquired" | "rejected";
	projectId?: string;
	root?: string;
	mode?: "webgui";
	error?: string;
}

// Every contender has its own native lock handles and module state, not just a separate lease object.
const contenderScript = `
import { acquireBrowserProject } from ${registryModule};
let lease;
let result;
try {
	try {
		lease = await acquireBrowserProject(process.env.OWNERSHIP_PROJECT);
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
	const assetsRoot = path.join(root, "vendor", "zcode-frontend", "build", "webgui");
	await fs.mkdir(assetsRoot, { recursive: true });
	// The test exercises the real listener, not the frontend bundle.
	await fs.writeFile(path.join(assetsRoot, "index.html"), "<!doctype html><title>WebGUI ownership test</title>");
	const script = `
import * as path from "node:path";
import { acquireBrowserProject, listBrowserProjects, readBrowserProject } from ${registryModule};
import { closeWebServer, ensureWebServer } from ${serverModule};
import * as ptree from ${processTreeModule};
const root = process.env.OWNERSHIP_FIXTURE_ROOT;
const contenderScript = ${JSON.stringify(contenderScript)};
async function contend(project, overrides = {}) {
	const child = Bun.spawn([process.execPath, "--eval", contenderScript], {
		cwd: root,
		env: { ...process.env, ...overrides, OWNERSHIP_PROJECT: project },
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
			PI_PACKAGE_DIR: path.join(root, "packages", "coding-agent"),
			PI_BUNDLED: "",
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

test("a live WebGUI owner locks the real Git root across directory aliases, profiles and config roots", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-project-owner-"));
	try {
		const project = path.join(root, "project");
		const gitDir = path.join(project, ".git");
		await Promise.all(
			[path.join(project, "nested"), path.join(gitDir, "objects"), path.join(gitDir, "refs", "heads")].map(
				directory => fs.mkdir(directory, { recursive: true }),
			),
		);
		await fs.writeFile(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
		await fs.writeFile(path.join(gitDir, "config"), "[core]\nrepositoryformatversion = 0\nbare = false\n");
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
	const owner = await acquireBrowserProject(path.join(project, "nested"));
	try {
		const aliasAttempt = await contend(alias);
		const profileAttempt = await contend(project, { OMP_PROFILE: "other", PI_PROFILE: "other" });
		const configAttempt = await contend(alias, alternateConfig);
		await owner.close();
		const afterClose = await contend(alias, alternateConfig);
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
		a = await acquireBrowserProject(path.join(root, "a"));
		b = await acquireBrowserProject(path.join(root, "b"));
		const summarize = records => records.map(({ root, mode }) => ({ root, mode }));
		const projects = summarize(await listBrowserProjects());
		await a.markExiting();
		const exitingPhase = (await readBrowserProject(a.projectId))?.phase;
		const whileExiting = await contend(a.root);
		await a.close();
		const afterClose = await contend(a.root);
		await a.close();
		const otherProject = await contend(b.root);
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
			{ root: canonicalB, mode: "webgui" },
		]);
		expect(result.exitingPhase).toBe("exiting");
		expectOccupied(result.whileExiting);
		expect(result.afterClose).toMatchObject({ outcome: "acquired", root: canonicalA, mode: "webgui" });
		expectOccupied(result.otherProject);
		expect(result.released).toBeNull();
		expect(result.remaining).toEqual([{ root: canonicalB, mode: "webgui" }]);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}, 60_000);

test("the WebGUI runtime publishes only local projects and stops only its own listener", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-project-runtime-"));
	try {
		await Promise.all(["a", "b", "peer"].map(name => fs.mkdir(path.join(root, name))));
		const peerScript = `
import { acquireBrowserProject } from ${registryModule};
import { closeWebServer, ensureWebServer } from ${serverModule};
const project = await acquireBrowserProject(process.env.OWNERSHIP_PROJECT);
try {
	const server = await ensureWebServer();
	await project.activate(() => ({ bound: false }), { allowLan: false });
	console.log(JSON.stringify({ url: server.loopbackUrl, projectId: project.projectId }));
	await Bun.stdin.text();
} finally {
	await project.close();
	await closeWebServer();
}
`;
		const result = await runScenario<{
			reused: boolean;
			independentListener: boolean;
			projects: { root: string; mode: string }[];
			projectIdsPublished: boolean;
			activeInfo: number[];
			exitingInfo: number;
			closedInfo: number;
			survivingInfo: number;
			localStopped: boolean;
			foreignInfo: number;
			peerSurviving: number;
			peerExit: number | null;
		}>(
			root,
			`
	const peer = ptree.spawn([process.execPath, "--eval", ${JSON.stringify(peerScript)}], {
		cwd: root, env: { ...process.env, OWNERSHIP_PROJECT: path.join(root, "peer") },
		stdin: "pipe", stderr: "full", timeout: 35_000, subreaper: true,
	});
	let peerDone;
	let a;
	let b;
	try {
		const reader = peer.stdout.getReader();
		let ready = "";
		try {
			const decoder = new TextDecoder();
			while (!ready.includes("\\n")) {
				const chunk = await reader.read();
				if (chunk.done) throw new Error("Independent native process exited before readiness (exit " + await peer.exited + "): " + await new Response(peer.stderr).text());
				ready += decoder.decode(chunk.value, { stream: true });
			}
		} finally {
			reader.releaseLock();
		}
		peerDone = peer.wait({ allowNonZero: true, allowAbort: true });
		const peerAddress = JSON.parse(ready.slice(0, ready.indexOf("\\n")));
		const server = await ensureWebServer();
		const reused = (await ensureWebServer()).loopbackUrl === server.loopbackUrl;
		a = await acquireBrowserProject(path.join(root, "a"));
		b = await acquireBrowserProject(path.join(root, "b"));
		await a.activate(() => ({ bound: false }), { allowLan: false });
		await b.activate(() => ({ bound: false }), { allowLan: false });
		async function status(url) {
			const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
			await response.body?.cancel();
			return response.status;
		}
		const infoUrl = (projectId, url = server.loopbackUrl) => url + "api/omp/session-info?projectId=" + projectId;
		const activeInfo = await Promise.all([status(infoUrl(a.projectId)), status(infoUrl(b.projectId))]);
		const foreignInfo = await status(infoUrl(peerAddress.projectId));
		const projectsResponse = await fetch(server.loopbackUrl + "api/omp/projects", {
			signal: AbortSignal.timeout(5_000),
		});
		if (projectsResponse.status !== 200) throw new Error("Process project list is unavailable");
		const { projects: publicProjects } = await projectsResponse.json();
		const projects = publicProjects.map(({ root, mode }) => ({ root, mode }));
		const projectIdsPublished = [a, b].every(lease => publicProjects.some(project => project.projectId === lease.projectId));
		await a.markExiting();
		const exitingInfo = await status(infoUrl(a.projectId));
		await a.close();
		const closedInfo = await status(infoUrl(a.projectId));
		const survivingInfo = await status(infoUrl(b.projectId));
		await b.close();
		await closeWebServer();
		let localStopped = false;
		try {
			await status(server.loopbackUrl + "api/omp/projects");
		} catch {
			localStopped = true;
		}
		const peerSurviving = await status(infoUrl(peerAddress.projectId, peerAddress.url));
		peer.stdin.end();
		const stopped = await peerDone;
		return {
			reused,
			independentListener: peerAddress.url !== server.loopbackUrl,
			projects, projectIdsPublished, activeInfo, exitingInfo, closedInfo, survivingInfo, foreignInfo,
			localStopped, peerSurviving,
			peerExit: stopped.exitCode,
		};
	} finally {
		try {
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
			independentListener: true,
			projects: [
				{ root: await fs.realpath(path.join(root, "a")), mode: "webgui" },
				{ root: await fs.realpath(path.join(root, "b")), mode: "webgui" },
			],
			projectIdsPublished: true,
			activeInfo: [200, 200],
			exitingInfo: 409,
			closedInfo: 404,
			survivingInfo: 200,
			localStopped: true,
			foreignInfo: 404,
			peerSurviving: 200,
			peerExit: 0,
		});
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}, 60_000);

test("failed native root cleanup retains real project locks until retry and never releases independent owners", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-project-strict-exit-"));
	try {
		await Promise.all(["a", "b", "independent", "peer"].map(name => fs.mkdir(path.join(root, name))));
		const peerScript = `
import { acquireBrowserProject } from ${registryModule};
const lease = await acquireBrowserProject(process.env.OWNERSHIP_PROJECT);
try {
	console.log(JSON.stringify({ ready: true }));
	await Bun.stdin.text();
} finally {
	await lease.close();
}
`;
		const result = await runScenario<{
			errors: string[];
			failedPhase: string | undefined;
			routeRetained: boolean;
			independentRootSettled: boolean;
			cleanupCallsAfterFailure: number;
			cleanupCallsAfterRetry: number;
			closeCalls: number;
			afterFailure: OwnershipAttempt;
			independentLeaseAfterFailure: OwnershipAttempt;
			afterRetry: OwnershipAttempt;
			independentLeaseAfterRetry: OwnershipAttempt;
			peerAfterFailure: OwnershipAttempt;
			peerAfterRetry: OwnershipAttempt;
			newOwnerAfterRepeatedExit: OwnershipAttempt;
			projectsAfterRetry: { root: string; mode: string }[];
		}>(
			root,
			`
	const { spyOn } = await import("bun:test");
	const { getTestModel } = await import(${JSON.stringify(path.join(import.meta.dir, "../helpers/model-fixtures.ts"))});
	const { ModelRegistry } = await import(${JSON.stringify(path.join(import.meta.dir, "../../src/config/model-registry.ts"))});
	const { Settings } = await import(${JSON.stringify(path.join(import.meta.dir, "../../src/config/settings.ts"))});
	const { createInMemoryAuthStorage } = await import(${JSON.stringify(path.join(import.meta.dir, "../helpers/agent-session-setup.ts"))});
	const { activateNativeWebGuiComposition } = await import(${JSON.stringify(path.join(import.meta.dir, "../../src/webgui/native-composition.ts"))});
	const { createWebGuiNativeSession, enableWebGuiNativeSessions, openWebGuiNativeProject } = await import(${JSON.stringify(path.join(import.meta.dir, "../../src/webgui/native-session-host.ts"))});
	const { closeAllWebGuis } = await import(${JSON.stringify(path.join(import.meta.dir, "../../src/webgui/host.ts"))});
	const peer = ptree.spawn([process.execPath, "--eval", ${JSON.stringify(peerScript)}], {
		cwd: root, env: { ...process.env, OWNERSHIP_PROJECT: path.join(root, "peer") },
		stdin: "pipe", timeout: 35_000, subreaper: true,
	});
	let peerDone;
	let independentLease;
	let nextOwner;
	let closeSpy;
	let failing = true;
	const auth = createInMemoryAuthStorage();
	try {
		const reader = peer.stdout.getReader();
		let ready = "";
		try {
			const decoder = new TextDecoder();
			while (!ready.includes("\\n")) {
				const chunk = await reader.read();
				if (chunk.done) throw new Error("Independent owner exited before acquiring its lease");
				ready += decoder.decode(chunk.value, { stream: true });
			}
		} finally {
			reader.releaseLock();
		}
		peerDone = peer.wait({ allowNonZero: true, allowAbort: true });
		activateNativeWebGuiComposition();
		enableWebGuiNativeSessions();
		independentLease = await acquireBrowserProject(path.join(root, "independent"));
		const a = await openWebGuiNativeProject(path.join(root, "a"));
		const b = await openWebGuiNativeProject(path.join(root, "b"));
		const model = getTestModel("ascend");
		auth.keys.setRuntime(model.provider, "test-key");
		const options = {
			agentDir: path.join(root, "agent"), authStorage: auth,
			modelRegistry: new ModelRegistry(auth, path.join(root, "models.yml")),
			model, offline: true, disableExtensionDiscovery: true,
			settings: Settings.isolated({
				"async.enabled": false, "browser.enabled": false, "computer.enabled": false,
				"compaction.enabled": false, "todo.enabled": false,
			}),
			skills: [], contextFiles: [], promptTemplates: [], slashCommands: [], rules: [],
			enableMCP: false, enableLsp: false,
		};
		const context = project => ({
			connectionId: "strict-exit-fixture", projectId: project.projectId,
			workspacePath: project.root, signal: new AbortController().signal,
		});
		const current = await createWebGuiNativeSession(context(a), a.root, options);
		const sibling = await createWebGuiNativeSession(context(b), b.root, options);
		const ref = current.agentRegistry.get(current.getAgentId());
		const close = current.sessionManager.close.bind(current.sessionManager);
		let closeCalls = 0;
		closeSpy = spyOn(current.sessionManager, "close").mockImplementation(async () => {
			closeCalls++;
			if (failing) throw new Error("owned transcript refuses close");
			await close();
		});
		const toolSession = Reflect.get(sibling.getToolByName("read"), "session");
		if (!toolSession.registerDisposeCallback) throw new Error("expected native resource cleanup registration");
		let cleanupCalls = 0;
		toolSession.registerDisposeCallback(async () => { cleanupCalls++; });
		let failure;
		try { await closeAllWebGuis(); } catch (error) { failure = error; }
		const errorMessages = error => error instanceof AggregateError
			? error.errors.flatMap(errorMessages) : [String(error)];
		const errors = failure ? errorMessages(failure) : [];
		const failedPhase = readBrowserProject(a.projectId)?.phase;
		const routeRetained = current.agentRegistry.get(current.getAgentId()) === ref &&
			ref?.session === current && readBrowserProject(a.projectId)?.nativeSessions?.has(current);
		const independentRootSettled = !sibling.agentRegistry.get(sibling.getAgentId());
		const cleanupCallsAfterFailure = cleanupCalls;
		const afterFailure = await contend(a.root);
		const independentLeaseAfterFailure = await contend(independentLease.root);
		const peerAfterFailure = await contend(path.join(root, "peer"));
		failing = false;
		await closeAllWebGuis();
		const cleanupCallsAfterRetry = cleanupCalls;
		const afterRetry = await contend(a.root);
		const independentLeaseAfterRetry = await contend(independentLease.root);
		const peerAfterRetry = await contend(path.join(root, "peer"));
		const projectsAfterRetry = listBrowserProjects().map(({ root, mode }) => ({ root, mode }));
		nextOwner = await acquireBrowserProject(a.root);
		await closeAllWebGuis();
		const newOwnerAfterRepeatedExit = await contend(a.root);
		return {
			errors, failedPhase, routeRetained: Boolean(routeRetained), independentRootSettled,
			cleanupCallsAfterFailure, cleanupCallsAfterRetry, closeCalls, afterFailure, afterRetry,
			independentLeaseAfterFailure, independentLeaseAfterRetry, peerAfterFailure, peerAfterRetry,
			newOwnerAfterRepeatedExit, projectsAfterRetry,
		};
	} finally {
		failing = false;
		closeSpy?.mockRestore();
		try {
			await closeAllWebGuis();
			await Promise.all([nextOwner?.close(), independentLease?.close()]);
			await closeWebServer();
		} finally {
			auth.close();
			peer.kill();
			await (peerDone ?? peer.wait({ allowNonZero: true, allowAbort: true }));
		}
	}
`,
		);
		expect(result.errors).toContain("Error: owned transcript refuses close");
		expect(result.failedPhase).toBe("exiting");
		expect(result.routeRetained).toBe(true);
		expect(result.independentRootSettled).toBe(true);
		expect(result.cleanupCallsAfterFailure).toBe(1);
		expect(result.cleanupCallsAfterRetry).toBe(1);
		expect(result.closeCalls).toBe(2);
		expectOccupied(result.afterFailure);
		expect(result.afterRetry).toMatchObject({
			outcome: "acquired",
			root: await fs.realpath(path.join(root, "a")),
			mode: "webgui",
		});
		expectOccupied(result.independentLeaseAfterFailure);
		expectOccupied(result.independentLeaseAfterRetry);
		expectOccupied(result.peerAfterFailure);
		expectOccupied(result.peerAfterRetry);
		expectOccupied(result.newOwnerAfterRepeatedExit);
		expect(result.projectsAfterRetry).toEqual([
			{ root: await fs.realpath(path.join(root, "independent")), mode: "webgui" },
		]);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}, 60_000);

test("borrowed native exit retries strict async cleanup without disposing the original TUI session", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-borrowed-strict-exit-"));
	try {
		const project = path.join(root, "project");
		await fs.mkdir(project);
		await fs.writeFile(path.join(project, "resume.txt"), "ORIGINAL_TUI_TOOL_STILL_WORKS");
		const result = await runScenario<{
			ordinaryAbortLeavesJobRunning: boolean;
			errors: string[];
			pendingAfterFailure: boolean;
			routeRetained: boolean;
			afterFailure: OwnershipAttempt;
			afterRetry: OwnershipAttempt;
			cleanupCalls: number;
			pendingAfterRetry: boolean;
			independentJobRunning: boolean;
			resumedToolRead: boolean;
			resumedReply: boolean;
		}>(
			root,
			`
	const { spyOn } = await import("bun:test");
	const { createMockModel } = await import(${JSON.stringify(path.join(import.meta.dir, "../../../ai/src/providers/mock.ts"))});
	const { getTestModel } = await import(${JSON.stringify(path.join(import.meta.dir, "../helpers/model-fixtures.ts"))});
	const { ModelRegistry } = await import(${JSON.stringify(path.join(import.meta.dir, "../../src/config/model-registry.ts"))});
	const { Settings } = await import(${JSON.stringify(path.join(import.meta.dir, "../../src/config/settings.ts"))});
	const { AgentRegistry } = await import(${JSON.stringify(path.join(import.meta.dir, "../../src/registry/agent-registry.ts"))});
	const { createAgentSession } = await import(${JSON.stringify(path.join(import.meta.dir, "../../src/sdk.ts"))});
	const { SessionManager } = await import(${JSON.stringify(path.join(import.meta.dir, "../../src/session/session-manager.ts"))});
	const { createInMemoryAuthStorage } = await import(${JSON.stringify(path.join(import.meta.dir, "../helpers/agent-session-setup.ts"))});
	const { activateNativeWebGuiComposition } = await import(${JSON.stringify(path.join(import.meta.dir, "../../src/webgui/native-composition.ts"))});
	const { closeAllWebGuis, startWebGui } = await import(${JSON.stringify(path.join(import.meta.dir, "../../src/webgui/host.ts"))});
	const auth = createInMemoryAuthStorage();
	const registry = AgentRegistry.global();
	const finishOwnedCleanup = Promise.withResolvers<void>();
	const finishIndependent = Promise.withResolvers<void>();
	let current;
	let waitSpy;
	try {
		const cwd = path.join(root, "project");
		const model = getTestModel("ascend");
		auth.keys.setRuntime(model.provider, "test-key");
		({ session: current } = await createAgentSession({
			cwd, agentDir: path.join(root, "agent"), agentRegistry: registry,
			sessionManager: SessionManager.inMemory(cwd), authStorage: auth,
			modelRegistry: new ModelRegistry(auth, path.join(root, "models.yml")),
			model, offline: true, bindProcessState: false, disableExtensionDiscovery: true,
			settings: Settings.isolated({
				"async.enabled": true, "browser.enabled": false, "computer.enabled": false,
				"compaction.enabled": false, "todo.enabled": false,
			}),
			skills: [], contextFiles: [], promptTemplates: [], slashCommands: [], rules: [],
			workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			enableMCP: false, enableLsp: false,
		}));
		const manager = current.asyncJobManager;
		if (!manager) throw new Error("expected real root-owned async manager");
		const ref = registry.get(current.getAgentId());
		const started = Promise.withResolvers<void>();
		let cleanupCalls = 0;
		const ownedJob = manager.register("eval", "owned async resource", async ({ signal }) => {
			const cancelled = Promise.withResolvers<void>();
			signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
			started.resolve();
			await cancelled.promise;
			await finishOwnedCleanup.promise;
			cleanupCalls++;
			return "owned cleanup finished";
		}, { ownerId: current.getAgentId(), suppressDelivery: true });
		const independentJob = manager.register("eval", "independent owner", async () => {
			await finishIndependent.promise;
			return "independent finished";
		}, { ownerId: "OtherRoot", suppressDelivery: true });
		await started.promise;
		await current.abort();
		const ordinaryAbortLeavesJobRunning = manager.getJob(ownedJob)?.status === "running" &&
			!manager.getJob(ownedJob)?.abortController.signal.aborted;
		activateNativeWebGuiComposition();
		const handle = await startWebGui(current);
		const waitForOwnerJobs = manager.waitForOwnerJobs.bind(manager);
		waitSpy = spyOn(manager, "waitForOwnerJobs")
			.mockRejectedValueOnce(new Error("owned async cleanup cannot settle yet"))
			.mockImplementation(waitForOwnerJobs);
		let failure;
		try { await closeAllWebGuis(); } catch (error) { failure = error; }
		const errorMessages = error => error instanceof AggregateError
			? error.errors.flatMap(errorMessages) : [String(error)];
		const errors = failure ? errorMessages(failure) : [];
		const pendingAfterFailure = current.hasUnsettledAsyncJobTree();
		const routeRetained = registry.get(current.getAgentId()) === ref &&
			ref?.session === current && readBrowserProject(handle.projectId)?.nativeSessions?.has(current);
		const afterFailure = await contend(cwd);
		finishOwnedCleanup.resolve();
		await closeAllWebGuis();
		const afterRetry = await contend(cwd);
		const pendingAfterRetry = current.hasUnsettledAsyncJobTree();
		const independentJobRunning = manager.getJob(independentJob)?.status === "running" &&
			!manager.getJob(independentJob)?.abortController.signal.aborted;
		current.agent.streamFn = createMockModel({ responses: [
			{ content: [{ type: "toolCall", name: "read", arguments: { path: path.join(cwd, "resume.txt") } }] },
			{ content: ["The original TUI resumed after WebGUI exit."] },
		] }).stream;
		await current.prompt("Read resume.txt with the native read tool, then confirm the original TUI resumed.");
		const resumedToolRead = current.agent.state.messages.some(message =>
			message.role === "toolResult" && message.toolName === "read" && !message.isError &&
			JSON.stringify(message.content).includes("ORIGINAL_TUI_TOOL_STILL_WORKS"));
		const resumedReply = current.agent.state.messages.some(message =>
			message.role === "assistant" &&
			JSON.stringify(message.content).includes("The original TUI resumed after WebGUI exit."));
		return {
			ordinaryAbortLeavesJobRunning, errors, pendingAfterFailure, routeRetained: Boolean(routeRetained),
			afterFailure, afterRetry, cleanupCalls, pendingAfterRetry, independentJobRunning,
			resumedToolRead, resumedReply,
		};
	} finally {
		finishOwnedCleanup.resolve();
		finishIndependent.resolve();
		waitSpy?.mockRestore();
		try {
			await closeAllWebGuis();
			await current?.dispose({ strict: true });
		} finally {
			auth.close();
			await closeWebServer();
		}
	}
`,
		);
		expect(result.ordinaryAbortLeavesJobRunning).toBe(true);
		expect(result.errors).toContain("Error: owned async cleanup cannot settle yet");
		expect(result.pendingAfterFailure).toBe(true);
		expect(result.routeRetained).toBe(true);
		expectOccupied(result.afterFailure);
		expect(result.afterRetry).toMatchObject({
			outcome: "acquired",
			root: await fs.realpath(project),
			mode: "webgui",
		});
		expect(result.cleanupCalls).toBe(1);
		expect(result.pendingAfterRetry).toBe(false);
		expect(result.independentJobRunning).toBe(true);
		expect(result.resumedToolRead).toBe(true);
		expect(result.resumedReply).toBe(true);
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}, 60_000);

test("failed child SDK startup remains owned by its WebGUI root until resource cleanup really succeeds", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-child-startup-owner-"));
	try {
		const project = path.join(root, "project");
		await fs.mkdir(project);
		await fs.writeFile(path.join(project, "parent.txt"), "PARENT_SURVIVES_CHILD_STARTUP");
		const result = await runScenario<{
			startupErrors: string[];
			exitErrors: string[];
			parentRouteRetained: boolean;
			childRouteRetained: boolean;
			parentToolRead: boolean;
			parentClosesAfterChildFailure: number;
			parentClosesAfterFailedExit: number;
			parentClosesAfterRetry: number;
			completedCleanups: number;
			failedCleanupCalls: number;
			failedChildCloses: number;
			afterFailure: OwnershipAttempt;
			afterRetry: OwnershipAttempt;
		}>(
			root,
			`
	const { spyOn } = await import("bun:test");
	const { createMockModel } = await import(${JSON.stringify(path.join(import.meta.dir, "../../../ai/src/providers/mock.ts"))});
	const { getTestModel } = await import(${JSON.stringify(path.join(import.meta.dir, "../helpers/model-fixtures.ts"))});
	const { ModelRegistry } = await import(${JSON.stringify(path.join(import.meta.dir, "../../src/config/model-registry.ts"))});
	const { Settings } = await import(${JSON.stringify(path.join(import.meta.dir, "../../src/config/settings.ts"))});
	const { createAgentSession } = await import(${JSON.stringify(path.join(import.meta.dir, "../../src/sdk.ts"))});
	const { SessionManager } = await import(${JSON.stringify(path.join(import.meta.dir, "../../src/session/session-manager.ts"))});
	const { createInMemoryAuthStorage } = await import(${JSON.stringify(path.join(import.meta.dir, "../helpers/agent-session-setup.ts"))});
	const { activateNativeWebGuiComposition } = await import(${JSON.stringify(path.join(import.meta.dir, "../../src/webgui/native-composition.ts"))});
	const { createWebGuiNativeSession, enableWebGuiNativeSessions, openWebGuiNativeProject } = await import(${JSON.stringify(path.join(import.meta.dir, "../../src/webgui/native-session-host.ts"))});
	const { closeAllWebGuis } = await import(${JSON.stringify(path.join(import.meta.dir, "../../src/webgui/host.ts"))});
	const auth = createInMemoryAuthStorage();
	let failCleanup = true;
	let attachSpy;
	let parentClose;
	let childClose;
	try {
		const cwd = path.join(root, "project");
		const model = getTestModel("ascend");
		auth.keys.setRuntime(model.provider, "test-key");
		const options = {
			agentDir: path.join(root, "agent"), authStorage: auth,
			modelRegistry: new ModelRegistry(auth, path.join(root, "models.yml")),
			model, offline: true, bindProcessState: false, disableExtensionDiscovery: true,
			settings: Settings.isolated({
				"async.enabled": false, "browser.enabled": false, "computer.enabled": false,
				"compaction.enabled": false, "todo.enabled": false,
			}),
			skills: [], contextFiles: [], promptTemplates: [], slashCommands: [], rules: [],
			workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			enableMCP: false, enableLsp: false,
		};
		activateNativeWebGuiComposition();
		enableWebGuiNativeSessions();
		const binding = await openWebGuiNativeProject(cwd);
		const context = {
			connectionId: "failed-child-startup", projectId: binding.projectId,
			workspacePath: cwd, signal: new AbortController().signal,
		};
		const parent = await createWebGuiNativeSession(context, cwd, options);
		const registry = parent.agentRegistry;
		const parentRef = registry.get(parent.getAgentId());
		parentClose = spyOn(parent.sessionManager, "close");
		const childId = "FailedStartupChild";
		const initError = new Error("child initialization failed after native attachment");
		const resourceError = new Error("child initialization resource remains busy");
		let completedCleanups = 0;
		let failedCleanupCalls = 0;
		const attachSession = registry.attachSession.bind(registry);
		attachSpy = spyOn(registry, "attachSession").mockImplementation((id, session, file, expected) => {
			const attached = attachSession(id, session, file, expected);
			if (!attached || id !== childId) return attached;
			childClose = spyOn(session.sessionManager, "close");
			const native = Reflect.get(session.getToolByName("read"), "session");
			if (!native.registerDisposeCallback) throw new Error("expected native child resource registration");
			native.registerDisposeCallback(async () => { completedCleanups++; });
			native.registerDisposeCallback(async () => {
				failedCleanupCalls++;
				if (failCleanup) throw resourceError;
			});
			throw initError;
		});
		let failure;
		try {
			await createAgentSession({
				...options, cwd, agentId: childId, parentTaskPrefix: childId,
				parentAgentId: parent.getAgentId(), agentRegistry: registry,
				sessionManager: SessionManager.inMemory(cwd),
			});
		} catch (error) { failure = error; }
		attachSpy.mockRestore();
		const errors = error => error instanceof AggregateError ? error.errors.flatMap(errors) : [String(error)];
		const startupErrors = failure ? errors(failure) : [];
		const childRef = registry.get(childId);
		const parentClosesAfterChildFailure = parentClose.mock.calls.length;
		const parentRouteRetained = registry.get(parent.getAgentId()) === parentRef &&
			parentRef?.session === parent && readBrowserProject(binding.projectId)?.nativeSessions?.has(parent);
		parent.agent.streamFn = createMockModel({ responses: [
			{ content: [{ type: "toolCall", name: "read", arguments: { path: path.join(cwd, "parent.txt") } }] },
			{ content: ["The parent remains available after the child's failed startup."] },
		] }).stream;
		await parent.prompt("Read parent.txt with the native read tool after the failed child startup.");
		const parentToolRead = parent.agent.state.messages.some(message =>
			message.role === "toolResult" && message.toolName === "read" && !message.isError &&
			JSON.stringify(message.content).includes("PARENT_SURVIVES_CHILD_STARTUP"));
		let exitFailure;
		try { await closeAllWebGuis(); } catch (error) { exitFailure = error; }
		const exitErrors = exitFailure ? errors(exitFailure) : [];
		const childRouteRetained = Boolean(childRef?.session) && registry.get(childId) === childRef;
		const parentClosesAfterFailedExit = parentClose.mock.calls.length;
		const afterFailure = await contend(cwd);
		failCleanup = false;
		await closeAllWebGuis();
		const afterRetry = await contend(cwd);
		return {
			startupErrors, exitErrors, parentRouteRetained: Boolean(parentRouteRetained),
			childRouteRetained, parentToolRead, parentClosesAfterChildFailure,
			parentClosesAfterFailedExit, parentClosesAfterRetry: parentClose.mock.calls.length,
			completedCleanups, failedCleanupCalls, failedChildCloses: childClose?.mock.calls.length ?? 0,
			afterFailure, afterRetry,
		};
	} finally {
		failCleanup = false;
		attachSpy?.mockRestore();
		try { await closeAllWebGuis(); }
		finally {
			parentClose?.mockRestore();
			childClose?.mockRestore();
			auth.close();
			await closeWebServer();
		}
	}
`,
		);
		expect(result.startupErrors).toContain("Error: child initialization failed after native attachment");
		expect(result.startupErrors).toContain("Error: child initialization resource remains busy");
		expect(result.exitErrors).toContain("Error: child initialization resource remains busy");
		expect(result.parentRouteRetained).toBe(true);
		expect(result.childRouteRetained).toBe(true);
		expect(result.parentToolRead).toBe(true);
		expect(result.parentClosesAfterChildFailure).toBe(0);
		expect(result.parentClosesAfterFailedExit).toBe(0);
		expect(result.parentClosesAfterRetry).toBe(1);
		expect(result.completedCleanups).toBe(1);
		expect(result.failedCleanupCalls).toBe(3);
		expect(result.failedChildCloses).toBe(1);
		expectOccupied(result.afterFailure);
		expect(result.afterRetry).toMatchObject({
			outcome: "acquired",
			root: await fs.realpath(project),
			mode: "webgui",
		});
	} finally {
		await fs.rm(root, { recursive: true, force: true });
	}
}, 60_000);
