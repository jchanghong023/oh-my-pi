import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createNativeFileMethods, createNativeFileWatcherMethods } from "../../src/webgui/native-files";
import { nativeReadContext } from "../../src/webgui/native-read-context";
import { acquireBrowserProject, type BrowserProjectLease } from "../../src/webgui/project-registry";
import type { WebGuiServiceContext } from "../../src/webgui/rpc-contract";
import { readWebGuiSessionInfo } from "../../src/webgui/session-source";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { getTestModel } from "../helpers/model-fixtures";

async function fixture(temp: TempDir, directory = "workspace") {
	const cwd = temp.join(directory);
	await fs.mkdir(cwd);
	const authStorage = createInMemoryAuthStorage();
	const settings = await Settings.loadIsolated({
		cwd,
		agentDir: temp.join("agent"),
		overrides: {
			"compaction.enabled": false,
			"memory.backend": "off",
			"async.enabled": false,
		},
	});
	const { session } = await createAgentSession({
		cwd,
		agentDir: temp.join("agent"),
		sessionManager: SessionManager.inMemory(cwd),
		authStorage,
		modelRegistry: new ModelRegistry(authStorage, temp.join("models.yml")),
		settings,
		model: getTestModel("ascend"),
		bindProcessState: false,
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		rules: [],
		preloadedCustomToolPaths: [],
		toolNames: [],
		enableMCP: false,
		enableLsp: false,
		taskDepth: 1,
		agentId: "SubAgent",
	});
	const lease = await acquireBrowserProject(cwd, "webgui");
	await lease.activate(() => readWebGuiSessionInfo(session), { allowLan: false, nativeSession: session });
	const controller = new AbortController();
	const context: WebGuiServiceContext = {
		connectionId: crypto.randomUUID(),
		projectId: lease.projectId,
		workspacePath: lease.root,
		nativeSession: session,
		signal: controller.signal,
	};
	const methods = createNativeFileMethods(context);
	return {
		cwd,
		session,
		lease,
		controller,
		context,
		async call(name: string, input: unknown) {
			const method = methods[name];
			if (!method) throw new Error(`Missing file method: ${name}`);
			return method(input);
		},
		async close() {
			controller.abort(new Error("File fixture closed"));
			try {
				await lease.close();
			} finally {
				try {
					await session.dispose();
				} finally {
					authStorage.close();
				}
			}
		},
	};
}

test("native file DTOs preserve byte offsets, EOF and gitignored workspace search", async () => {
	using temp = TempDir.createSync("@pi-native-files-");
	const f = await fixture(temp);
	try {
		await fs.mkdir(`${f.cwd}/docs`);
		await fs.mkdir(`${f.cwd}/.git`);
		await fs.writeFile(`${f.cwd}/.gitignore`, "ignored-sample.txt\n");
		await fs.writeFile(`${f.cwd}/ignored-sample.txt`, "ignored");
		await fs.writeFile(`${f.cwd}/docs/sample.ts`, "αbeta\nsecond\n");
		const file = await fs.realpath(`${f.cwd}/docs/sample.ts`);
		expect(await f.call("readdir", { path: "." })).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "docs", type: "directory", isSymbolicLink: false })]),
		);
		expect(await f.call("stat", { path: "docs/sample.ts" })).toEqual({
			path: file,
			type: "file",
			size: 14,
			mtimeMs: expect.any(Number),
		});
		expect(await f.call("readTextFile", { path: "docs/sample.ts", offset: 2, length: 4 })).toEqual({
			path: file,
			content: "beta",
			offset: 2,
			bytesRead: 4,
			totalBytes: 14,
			truncated: true,
			isBinary: false,
		});
		expect(await f.call("readFileRange", { path: "docs/sample.ts", offset: 2, length: 4 })).toEqual(
			new Uint8Array([98, 101, 116, 97]),
		);
		expect(await f.call("readFileRange", { path: "docs/sample.ts", offset: 999, length: 4 })).toEqual(
			new Uint8Array(),
		);
		expect(await f.call("searchWorkspaceFiles", { rootPath: f.cwd, query: "sample", limit: 3 })).toEqual([
			{ name: "sample.ts", path: file, relativePath: "docs/sample.ts", type: "file" },
		]);
		await expect(f.call("stat", { path: "missing.txt" })).rejects.toHaveProperty("code", "ENOENT");
	} finally {
		await f.close();
	}
});

test("reads use selected admitted session roots and reject stale cwd, cross-project paths, links, unbound access and cancellation", async () => {
	using temp = TempDir.createSync("@pi-native-file-scope-");
	const f = await fixture(temp);
	const target = await fixture(temp, "next-workspace");
	const next = target.cwd;
	await fs.writeFile(`${f.cwd}/marker.txt`, "FIRST");
	await fs.writeFile(`${next}/marker.txt`, "SECOND");
	await fs.symlink(next, `${f.cwd}/outside`, "junction");
	try {
		await expect(f.call("readTextFile", { path: "../next-workspace/marker.txt" })).rejects.toThrow(/escapes/);
		await expect(f.call("readTextFile", { path: "outside/marker.txt" })).rejects.toThrow(/escapes/);
		expect(await f.call("readTextFile", { path: "marker.txt" })).toEqual(
			expect.objectContaining({ content: "FIRST" }),
		);
		f.session.sessionManager.setCwdWithoutRelocation(next);
		await expect(f.call("readTextFile", { path: "marker.txt" })).rejects.toThrow(/no active owner/);
		f.session.sessionManager.setCwdWithoutRelocation(f.cwd);
		expect(await target.call("readTextFile", { path: "marker.txt" })).toEqual(
			expect.objectContaining({ content: "SECOND" }),
		);
		await expect(target.call("stat", { path: `${f.cwd}/marker.txt` })).rejects.toThrow(/escapes/);
		await expect(f.call("readTextFile", { path: "marker.txt", sessionId: target.session.sessionId })).rejects.toThrow(
			/not resident/,
		);
		const stale = createNativeFileMethods({ ...target.context, nativeSession: f.session });
		await expect(stale.readTextFile!({ path: "marker.txt" })).rejects.toThrow(/no longer owned/);
		expect(await f.call("readTextFile", { path: "marker.txt" })).toEqual(
			expect.objectContaining({ content: "FIRST" }),
		);
		const unbound = createNativeFileMethods({ connectionId: f.context.connectionId, signal: f.context.signal });
		const stat = unbound.stat;
		if (!stat) throw new Error("Missing stat method");
		await expect(Promise.resolve().then(() => stat({ path: next }))).rejects.toThrow();
		target.controller.abort(new Error("Disconnected file client"));
		await expect(target.call("stat", { path: "marker.txt" })).rejects.toThrow("Disconnected file client");
	} finally {
		try {
			await target.close();
		} finally {
			await f.close();
		}
	}
});

test("an admitted read cannot survive replacement of its project owner", async () => {
	using temp = TempDir.createSync("@pi-native-file-owner-");
	const f = await fixture(temp);
	let replacement: BrowserProjectLease | undefined;
	try {
		await fs.writeFile(`${f.cwd}/marker.txt`, "OWNER");
		const read = await nativeReadContext(f.context);
		await f.lease.close();
		replacement = await acquireBrowserProject(f.cwd, "webgui");
		await replacement.activate(() => readWebGuiSessionInfo(f.session), {
			allowLan: false,
			nativeSession: f.session,
		});
		expect(read.assertCurrent).toThrow(/no active owner/);
		expect(await f.call("readTextFile", { path: "marker.txt" })).toEqual(
			expect.objectContaining({ content: "OWNER" }),
		);
	} finally {
		try {
			await replacement?.close();
		} finally {
			await f.close();
		}
	}
});

test("native watcher consumers receive only their project and stop at unwatch, unsubscribe and disconnect", async () => {
	using tempA = TempDir.createSync("@pi-native-watch-a-");
	using tempB = TempDir.createSync("@pi-native-watch-b-");
	const a = await fixture(tempA);
	const b = await fixture(tempB).catch(async error => {
		await a.close();
		throw error;
	});
	const watchesA = createNativeFileWatcherMethods(a.context);
	const watchesB = createNativeFileWatcherMethods(b.context);
	const observerController = new AbortController();
	const observer = createNativeFileWatcherMethods({
		...a.context,
		connectionId: crypto.randomUUID(),
		signal: observerController.signal,
	});
	const subscriptions: Array<{ dispose(): void }> = [];
	const events: string[] = [];
	// Native watchers may coalesce repeated writes to one path; each phase needs its own event identity.
	const markerA = path.join(a.lease.root, "visible-marker.txt");
	let markerB = path.join(b.lease.root, "initial-marker.txt");
	let observedMarker = markerA;
	const nextA = Promise.withResolvers<void>();
	let nextB = Promise.withResolvers<void>();
	let observed = Promise.withResolvers<void>();
	try {
		const watchA = watchesA.methods.watch!;
		const watchB = watchesB.methods.watch!;
		await expect(Promise.resolve().then(() => watchA({ path: b.cwd }))).rejects.toThrow(/outside/);
		const first = (await watchA({ path: "." })) as { id: string };
		const second = (await watchB({ path: "." })) as { id: string };
		const sentinel = (await observer.methods.watch!({ path: "." })) as { id: string };
		subscriptions.push(
			watchesA.dynamicEvents.onDynamicChange(first.id)(event => {
				if (event.changedPath?.endsWith("marker.txt")) {
					events.push(event.changedPath);
					if (event.changedPath === markerA) nextA.resolve();
				}
			}),
		);
		subscriptions.push(
			watchesB.dynamicEvents.onDynamicChange(second.id)(event => {
				if (event.changedPath === markerB) nextB.resolve();
			}),
		);
		subscriptions.push(
			observer.dynamicEvents.onDynamicChange(sentinel.id)(event => {
				if (event.changedPath === observedMarker) observed.resolve();
			}),
		);
		await fs.writeFile(markerB, "B only");
		await nextB.promise;
		await new Promise<void>(resolve => setImmediate(resolve));
		expect(events).toEqual([]);
		await fs.writeFile(markerA, "A visible");
		await nextA.promise;
		await observed.promise;
		await new Promise<void>(resolve => setImmediate(resolve));
		expect(events).toContain(markerA);
		const delivered = events.length;
		await watchesA.methods.unwatch!({ id: first.id });
		expect(() => watchesA.dynamicEvents.onDynamicChange(first.id)).toThrow(/does not exist/);
		observed = Promise.withResolvers<void>();
		observedMarker = path.join(a.lease.root, "unwatched-marker.txt");
		await fs.writeFile(observedMarker, "after unwatch");
		await observed.promise;
		await new Promise<void>(resolve => setImmediate(resolve));
		expect(events).toHaveLength(delivered);

		const disconnected = (await watchA({ path: "." })) as { id: string };
		subscriptions.push(watchesA.dynamicEvents.onDynamicChange(disconnected.id)(() => events.push("after abort")));
		a.controller.abort(new Error("Browser disconnected"));
		expect(() => watchesA.dynamicEvents.onDynamicChange(disconnected.id)).toThrow(/does not exist/);
		observed = Promise.withResolvers<void>();
		observedMarker = path.join(a.lease.root, "disconnected-marker.txt");
		await fs.writeFile(observedMarker, "after disconnect");
		await observed.promise;
		await new Promise<void>(resolve => setImmediate(resolve));
		expect(events).toHaveLength(delivered);

		const released = (await watchB({ path: "." })) as { id: string };
		const subscription = watchesB.dynamicEvents.onDynamicChange(released.id)(() => events.push("after unsubscribe"));
		subscription.dispose();
		subscription.dispose();
		expect(() => watchesB.dynamicEvents.onDynamicChange(released.id)).toThrow(/does not exist/);
		nextB = Promise.withResolvers<void>();
		markerB = path.join(b.lease.root, "unsubscribed-marker.txt");
		await fs.writeFile(markerB, "after unsubscribe");
		await nextB.promise;
		await new Promise<void>(resolve => setImmediate(resolve));
		expect(events).toHaveLength(delivered);
	} finally {
		for (const subscription of subscriptions) subscription.dispose();
		watchesA.dispose();
		watchesB.dispose();
		observerController.abort();
		observer.dispose();
		try {
			await a.close();
		} finally {
			await b.close();
		}
	}
});
