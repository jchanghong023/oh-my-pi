import { expect, test } from "bun:test";
import type { Message, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { DEFAULT_MAX_BYTES } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { TempDir } from "@oh-my-pi/pi-utils";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
	NativeTaskOutputContent,
	NativeTaskRunsSnapshot,
} from "../../../../vendor/zcode-frontend/packages/shared/src/native-task-runs";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { createAgentSession } from "../../src/sdk";
import type { AgentSession } from "../../src/session/agent-session";
import type { CustomMessage } from "../../src/session/messages";
import { SessionManager } from "../../src/session/session-manager";
import { NativeChildDirectory } from "../../src/webgui/native-subagents";
import { createNativeTaskRunAdapter } from "../../src/webgui/native-task-runs";
import { acquireBrowserProject, type BrowserProjectLease } from "../../src/webgui/project-registry";
import type { WebGuiServiceContext } from "../../src/webgui/rpc-contract";
import { readWebGuiSessionInfo } from "../../src/webgui/session-source";
import { createAssistantMessage, createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { getTestModel } from "../helpers/model-fixtures";

interface Fixture {
	root: AgentSession;
	context: WebGuiServiceContext;
	directory: NativeChildDirectory;
	artifacts: string;
	append(message: Message | CustomMessage): void;
}

async function withRoot(temp: TempDir, work: (fixture: Fixture) => Promise<void>): Promise<void> {
	const authStorage = createInMemoryAuthStorage();
	const model = getTestModel("ascend");
	authStorage.keys.setRuntime(model.provider, "isolated-native-task-fixture");
	const registry = new AgentRegistry();
	const manager = SessionManager.create(temp.path(), temp.join("sessions"));
	manager.appendMessage({
		role: "user",
		content: "Inspect native runs without executing them.",
		timestamp: Date.now(),
	});
	await manager.ensureOnDisk();
	await manager.flush();
	let root: AgentSession | undefined;
	let lease: BrowserProjectLease | undefined;
	let directory: NativeChildDirectory | undefined;
	try {
		({ session: root } = await createAgentSession({
			cwd: temp.path(),
			agentDir: temp.join("agent"),
			sessionManager: manager,
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, temp.join("models.yml")),
			model,
			settings: Settings.isolated({ "compaction.enabled": false, "async.enabled": false }),
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
			agentRegistry: registry,
			agentId: "Main",
			taskDepth: 1,
		}));
		const owner = root;
		const artifacts = manager.getArtifactsDir();
		if (!artifacts) throw new Error("Fixture has no native artifacts root");
		await fs.mkdir(artifacts, { recursive: true });
		lease = await acquireBrowserProject(temp.path(), "webgui");
		await lease.activate(() => readWebGuiSessionInfo(owner), { allowLan: false, nativeSession: owner });
		const context: WebGuiServiceContext = {
			connectionId: crypto.randomUUID(),
			projectId: lease.projectId,
			workspacePath: temp.path(),
			nativeSession: owner,
			signal: new AbortController().signal,
		};
		directory = new NativeChildDirectory(owner);
		await work({
			root: owner,
			context,
			directory,
			artifacts,
			append(message) {
				owner.agent.appendMessage(message);
				manager.appendMessage(message);
			},
		});
	} finally {
		directory?.dispose();
		await lease?.close();
		await root?.dispose();
		authStorage.close();
	}
}

async function child(file: string, cwd: string, answer?: string): Promise<string> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	const manager = await SessionManager.open(file, undefined, undefined, { initialCwd: cwd, suppressBreadcrumb: true });
	try {
		manager.appendMessage({ role: "user", content: "The actual child assignment.", timestamp: Date.now() });
		if (answer) manager.appendMessage(createAssistantMessage(answer));
		await manager.ensureOnDisk();
		await manager.flush();
		return manager.getSessionId();
	} finally {
		await manager.close();
	}
}

test("native task runs retain real ancestry and read only owned bounded outputs without resuming a session", async () => {
	using temp = TempDir.createSync("@pi-native-task-runs-");
	await withRoot(temp, async ({ root, context, directory, artifacts, append }) => {
		append({
			...createAssistantMessage(""),
			content: [{ type: "toolCall", id: "call-task", name: "task", arguments: { i: "Inspect ownership" } }],
		});
		const workerFile = path.join(artifacts, "Worker.jsonl");
		const workerId = await child(workerFile, temp.path(), "The child found the real answer.");
		const nestedId = await child(
			path.join(artifacts, "Worker", "Nested.jsonl"),
			temp.path(),
			"Nested native output.",
		);
		const foreignId = await child(temp.join("foreign-root", "Foreign.jsonl"), temp.path(), "Private foreign answer.");
		const outputFile = path.join(artifacts, "Worker.md");
		await fs.writeFile(outputFile, "x".repeat(DEFAULT_MAX_BYTES + 200));
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call-task",
			toolName: "task",
			timestamp: Date.now(),
			content: [{ type: "text", text: "The native task completed." }],
			isError: false,
			details: {
				results: [{ id: "Worker", agent: "scout", exitCode: 0, outputPath: outputFile }],
				outputPaths: [outputFile, temp.join("foreign-root", "Foreign.jsonl")],
			},
		};
		append(result);
		const originalManager = root.sessionManager;
		const originalRootId = root.sessionId;
		const originalTranscript = await fs.readFile(workerFile);
		const adapter = createNativeTaskRunAdapter(context, directory);
		try {
			const snapshot = (await adapter.methods.listNativeTaskRuns({
				sessionId: root.sessionId,
			})) as NativeTaskRunsSnapshot;
			expect(snapshot.runs).toHaveLength(1);
			const run = snapshot.runs[0];
			expect(run).toMatchObject({ toolCallId: "call-task", sessionId: root.sessionId, status: "completed" });
			expect(run.actors).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ agentId: "Worker", sessionId: workerId, parentSessionId: root.sessionId }),
					expect.objectContaining({ agentId: "Nested", sessionId: nestedId, parentSessionId: workerId }),
				]),
			);
			expect(run.actors.some(actor => actor.sessionId === foreignId)).toBe(false);
			const workerOutput = run.outputs.find(output => output.sessionId === workerId);
			if (!workerOutput) throw new Error("Missing actual child transcript output");
			const content = (await adapter.methods.readNativeTaskOutput({
				sessionId: root.sessionId,
				runId: run.runId,
				outputId: workerOutput.id,
			})) as NativeTaskOutputContent;
			expect(content.content).toContain("The child found the real answer.");
			const file = run.outputs.find(output => output.kind === "file");
			if (!file) throw new Error("Missing authorized native output file");
			expect(run.outputs.filter(output => output.kind === "file")).toHaveLength(1);
			const fileContent = (await adapter.methods.readNativeTaskOutput({
				sessionId: root.sessionId,
				runId: run.runId,
				outputId: file.id,
			})) as NativeTaskOutputContent;
			expect(Buffer.byteLength(fileContent.content)).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
			await expect(
				adapter.methods.readNativeTaskOutput({ sessionId: root.sessionId, runId: run.runId, outputId: outputFile }),
			).rejects.toThrow("not found");
			await expect(
				adapter.methods.readNativeTaskOutput({
					sessionId: root.sessionId,
					runId: "another-run",
					outputId: workerOutput.id,
				}),
			).rejects.toThrow("not found");
			await expect(adapter.methods.listNativeTaskRuns({ sessionId: foreignId })).rejects.toThrow("current root");
			expect(root.sessionId).toBe(originalRootId);
			expect(root.sessionManager).toBe(originalManager);
			expect(await fs.readFile(workerFile)).toEqual(originalTranscript);
			expect(root.agentRegistry?.get("Worker")).toBeUndefined();
		} finally {
			adapter.dispose();
		}
	});
});

test("workpool projection requires native observations and does not call parked history a success", async () => {
	using temp = TempDir.createSync("@pi-native-pool-runs-");
	await withRoot(temp, async ({ root, context, directory, artifacts, append }) => {
		append({
			...createAssistantMessage(""),
			content: [
				{ type: "toolCall", id: "call-pool", name: "eval", arguments: { code: "workpool creation" } },
				{
					type: "toolCall",
					id: "call-not-pool",
					name: "eval",
					arguments: { code: "workpool('not actually invoked')" },
				},
			],
		});
		const workerId = await child(path.join(artifacts, "PoolWorker.jsonl"), temp.path());
		append({
			role: "toolResult",
			toolCallId: "call-pool",
			toolName: "eval",
			timestamp: Date.now(),
			isError: false,
			content: [{ type: "text", text: "Native pool created." }],
			details: { statusEvents: [{ op: "workpool", action: "create", pool: "InspectPool", count: 1 }] },
		});
		append({
			role: "toolResult",
			toolCallId: "call-not-pool",
			toolName: "eval",
			timestamp: Date.now(),
			isError: false,
			content: [{ type: "text", text: "A string is not an observed invocation." }],
		});
		append({
			role: "custom",
			customType: "irc:workpool",
			timestamp: Date.now(),
			display: true,
			attribution: "agent",
			content: "[pool InspectPool → PoolWorker]\n\nNative dispatch",
			details: {
				pool: "InspectPool",
				to: "PoolWorker",
				from: "pool:InspectPool",
				body: "Native dispatch",
				mode: "spawned",
			},
		});
		const adapter = createNativeTaskRunAdapter(context, directory);
		try {
			const snapshot = (await adapter.methods.listNativeTaskRuns({
				sessionId: root.sessionId,
			})) as NativeTaskRunsSnapshot;
			expect(snapshot.runs).toHaveLength(1);
			expect(snapshot.runs[0]).toMatchObject({ toolCallId: "call-pool", status: "unknown" });
			expect(snapshot.runs[0].actors).toEqual([expect.objectContaining({ sessionId: workerId, status: "unknown" })]);
			expect(snapshot.runs[0].endedAt).toBeUndefined();
		} finally {
			adapter.dispose();
		}
	});
});
