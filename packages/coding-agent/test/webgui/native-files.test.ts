import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createNativeFileMethods } from "../../src/webgui/native-files";
import { acquireBrowserProject } from "../../src/webgui/project-registry";
import type { WebGuiServiceContext } from "../../src/webgui/rpc-contract";
import { readWebGuiSessionInfo } from "../../src/webgui/session-source";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { getTestModel } from "../helpers/model-fixtures";

async function fixture(temp: TempDir) {
	const cwd = temp.join("workspace");
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

test("reads follow the same native session's admitted cwd and reject stale roots, links, unbound access and cancellation", async () => {
	using temp = TempDir.createSync("@pi-native-file-scope-");
	const f = await fixture(temp);
	const next = temp.join("next-workspace");
	await fs.mkdir(next);
	await fs.writeFile(`${f.cwd}/marker.txt`, "FIRST");
	await fs.writeFile(`${next}/marker.txt`, "SECOND");
	await fs.symlink(next, `${f.cwd}/outside`, "junction");
	const targetLease = await acquireBrowserProject(next, "webgui");
	await targetLease.activate(() => readWebGuiSessionInfo(f.session), { allowLan: false, nativeSession: f.session });
	try {
		await expect(f.call("readTextFile", { path: "../next-workspace/marker.txt" })).rejects.toThrow(/escapes/);
		await expect(f.call("readTextFile", { path: "outside/marker.txt" })).rejects.toThrow(/escapes/);
		expect(await f.call("readTextFile", { path: "marker.txt" })).toEqual(
			expect.objectContaining({ content: "FIRST" }),
		);
		f.session.sessionManager.setCwdWithoutRelocation(next);
		expect(await f.call("readTextFile", { path: "marker.txt" })).toEqual(
			expect.objectContaining({ content: "SECOND" }),
		);
		await expect(f.call("stat", { path: `${f.cwd}/marker.txt` })).rejects.toThrow(/escapes/);
		const unbound = createNativeFileMethods({ connectionId: f.context.connectionId, signal: f.context.signal });
		const stat = unbound.stat;
		if (!stat) throw new Error("Missing stat method");
		await expect(Promise.resolve().then(() => stat({ path: next }))).rejects.toThrow(/no active native owner/);
		f.controller.abort(new Error("Disconnected file client"));
		await expect(f.call("stat", { path: "marker.txt" })).rejects.toThrow("Disconnected file client");
	} finally {
		await targetLease.close();
		await f.close();
	}
});
