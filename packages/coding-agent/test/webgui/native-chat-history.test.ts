import { expect, test } from "bun:test";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { NativeChatRuntime } from "../../src/webgui/native-chat";
import { acquireBrowserProject, readBrowserProject, type BrowserProjectLease } from "../../src/webgui/project-registry";
import type { WebGuiServiceContext } from "../../src/webgui/rpc-contract";
import { readWebGuiSessionInfo } from "../../src/webgui/session-source";
import { createAssistantMessage, createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { getTestModel } from "../helpers/model-fixtures";

test("reading historical native chat projects V4 content without changing its journal or the active owner", async () => {
	using temp = TempDir.createSync("@pi-native-chat-history-");
	const activeCwd = temp.join("active-project");
	const historicalCwd = temp.join("historical-project");
	await Promise.all([mkdir(activeCwd), mkdir(historicalCwd)]);
	const historicalManager = SessionManager.create(historicalCwd, temp.join("history"));
	const historicalUser = "What is the saved deployment target?";
	const historicalAssistant = createAssistantMessage("The saved deployment target is staging.");
	const timestamp = historicalAssistant.timestamp;
	historicalManager.appendMessage({ role: "user", content: historicalUser, timestamp: timestamp - 1 });
	historicalManager.appendMessage(historicalAssistant);
	try {
		await historicalManager.ensureOnDisk();
		await historicalManager.flush();
	} finally {
		await historicalManager.close();
	}
	const historicalPath = historicalManager.getSessionFile();
	if (!historicalPath) throw new Error("Persisted history fixture has no journal path");

	// Imported/older journals can report tokens without cache counters or prices.
	// Encode that persisted boundary after closing the manager, which normalizes new appends.
	const journal = (await readFile(historicalPath, "utf8"))
		.trimEnd()
		.split("\n")
		.map(line => {
			const entry: { type: string; message?: { role: string; usage?: unknown } } = JSON.parse(line);
			if (entry.type === "message" && entry.message?.role === "assistant") {
				entry.message.usage = { input: 13, output: 5 };
			}
			return JSON.stringify(entry);
		})
		.join("\n");
	await writeFile(historicalPath, `${journal}\n`);
	const historicalBytes = await readFile(historicalPath);
	const historicalInfo: SessionInfo = {
		id: historicalManager.getSessionId(),
		path: historicalPath,
		cwd: historicalCwd,
		created: new Date(historicalManager.getHeader()!.timestamp),
		modified: new Date(timestamp),
		messageCount: 2,
		size: (await stat(historicalPath)).size,
		firstMessage: historicalUser,
		allMessagesText: `${historicalUser}\nThe saved deployment target is staging.`,
	};

	const activeManager = SessionManager.inMemory(activeCwd);
	activeManager.appendMessage({ role: "user", content: "Keep working in the active project.", timestamp });
	activeManager.appendMessage(createAssistantMessage("The active project remains open."));
	const authStorage = createInMemoryAuthStorage();
	let session: AgentSession | undefined;
	let lease: BrowserProjectLease | undefined;
	let release: (() => void) | undefined;
	try {
		({ session } = await createAgentSession({
			cwd: activeCwd,
			agentDir: temp.join("agent"),
			sessionManager: activeManager,
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, temp.join("models.yml")),
			settings: Settings.isolated({ "compaction.enabled": false }),
			model: getTestModel("ascend"),
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
		}));
		const nativeSession = session;
		lease = await acquireBrowserProject(activeCwd, "webgui");
		await lease.activate(() => readWebGuiSessionInfo(nativeSession), { allowLan: false, nativeSession });
		const context: WebGuiServiceContext = {
			connectionId: crypto.randomUUID(),
			projectId: lease.projectId,
			workspacePath: lease.root,
			signal: new AbortController().signal,
			nativeSession,
		};
		const runtime = new NativeChatRuntime(nativeSession);
		release = runtime.retain();
		// Supplying only fixture metadata keeps history resolution away from listAll().
		runtime.recordHistory([historicalInfo]);
		const activeId = nativeSession.sessionId;
		const activeMessages = nativeSession.messages;
		const activeContent = structuredClone(activeMessages);
		const activeLeaf = activeManager.getLeafId();
		const owner = readBrowserProject(lease.projectId);
		expect(activeId).not.toBe(historicalInfo.id);

		const messages = await runtime.messages(context, historicalInfo.id);
		expect(messages).toEqual([
			expect.objectContaining({ role: "user", content: historicalUser }),
			expect.objectContaining({
				role: "assistant",
				content: [{ type: "text", text: "The saved deployment target is staging." }],
				usage: {
					input: 13,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 18,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			}),
		]);
		const snapshot = await runtime.snapshot(context, historicalInfo.id);
		expect(snapshot.sessionId).toBe(historicalInfo.id);
		expect(snapshot.rows.window).toEqual([
			expect.objectContaining({ kind: "turnHeader", origin: "userInput", state: "completedSuccess" }),
			expect.objectContaining({ kind: "userInput", origin: "realUser", text: historicalUser }),
			expect.objectContaining({
				kind: "assistantText",
				text: "The saved deployment target is staging.",
				state: "complete",
			}),
		]);
		expect(snapshot.control.phase).toBe("completedSuccess");
		expect(snapshot.inputRouting).toEqual({ mode: "reject", reasonCode: "guard.nativeHistoryWorkingDirectory" });
		expect(snapshot.usage.cumulative).toEqual({
			inputTokens: 13,
			outputTokens: 5,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		});
		expect(nativeSession.sessionId).toBe(activeId);
		expect(nativeSession.sessionManager).toBe(activeManager);
		expect(activeManager.getCwd()).toBe(activeCwd);
		expect(activeManager.getLeafId()).toBe(activeLeaf);
		expect(nativeSession.messages).toBe(activeMessages);
		expect(nativeSession.messages).toEqual(activeContent);
		expect(readBrowserProject(lease.projectId)).toBe(owner);
		expect(owner?.nativeSession).toBe(nativeSession);
		expect(await readFile(historicalPath)).toEqual(historicalBytes);
	} finally {
		release?.();
		try {
			await lease?.close();
		} finally {
			try {
				await session?.dispose();
			} finally {
				authStorage.close();
			}
		}
	}
});
