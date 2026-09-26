import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type Api, type Model, type ModelSpec, clearCustomApis, registerCustomApi } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { RepoLifecycle } from "../src/repo/lifecycle";
import { RepoService } from "../src/repo/service";
import { repoIndexPath } from "../src/repo/storage";
import { createAgentSession } from "../src/sdk";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { createAssistantMessage } from "./helpers/agent-session-setup";

const temporary: string[] = [];
afterEach(async () => {
	clearCustomApis();
	await Promise.all(temporary.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("repository lifecycle via the real SDK agent and filesystem tools", () => {
	it("updates successful writes and edits before the next query, not rejected edits, then unregisters on disposal", async () => {
		const temp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-repo-lifecycle-"));
		temporary.push(temp);
		const cwd = path.join(temp, "project");
		const agentDir = path.join(temp, "agent");
		await fs.mkdir(cwd);
		await fs.mkdir(agentDir);
		const file = path.join(cwd, "engine.py");
		await fs.writeFile(file, "def old_name(): return 'OLD_NEEDLE'\n");
		const initial = new RepoService({ cwd, agentDir });
		try {
			await initial.build();
		} finally {
			initial.close();
		}
		const actions = [
			{ name: "write", arguments: { path: file, content: "def new_name(): return 'WRITTEN_NEEDLE'\n" } },
			{ name: "edit", arguments: { path: file, old_string: "WRITTEN_NEEDLE", new_string: "EDITED_NEEDLE" } },
			{ name: "edit", arguments: { path: file, old_string: "DOES_NOT_EXIST", new_string: "MUST_NOT_APPEAR" } },
			{ name: "repo", arguments: { action: "search", query: "EDITED_NEEDLE" } },
			{ name: "bash", arguments: { command: "printf 'SHELLNEEDLE\\n' > shell.py" } },
		];
		let requests = 0;
		registerCustomApi("repo-lifecycle-local", () => {
			const turn = Math.floor(requests / 2);
			const toolTurn = requests++ % 2 === 0;
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("done");
				if (toolTurn) {
					const action = actions[turn];
					if (!action) throw new Error(`Unexpected local model request ${requests}`);
					const toolCall = { type: "toolCall" as const, id: `repo-call-${turn}`, ...action };
					message.content = [toolCall];
					message.stopReason = "toolUse";
					stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
					stream.push({
						type: "toolcall_delta",
						contentIndex: 0,
						delta: JSON.stringify(action.arguments),
						partial: message,
					});
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: toolCall as never, partial: message });
					stream.push({ type: "done", reason: "toolUse", message });
				} else stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});
		const model = buildModel({
			id: "repo-lifecycle",
			name: "Local Repo Lifecycle",
			api: "repo-lifecycle-local",
			provider: "ollama",
			baseUrl: "http://127.0.0.1:1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		const settings = await Settings.loadIsolated({
			cwd,
			agentDir,
			inMemory: true,
			overrides: {
				"compaction.enabled": false,
				"edit.mode": "replace",
				"edit.enforceSeenLines": false,
				"bash.autoBackground.enabled": false,
			},
		});
		const auth = await AuthStorage.create(path.join(agentDir, "auth.db"));
		const registry = new ModelRegistry(auth, path.join(agentDir, "models.yml"));
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			settings,
			authStorage: auth,
			modelRegistry: registry,
			sessionManager: SessionManager.inMemory(cwd),
			model,
			disableExtensionDiscovery: true,
			extensions: [],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			toolNames: ["write", "edit", "repo", "bash"],
		});
		try {
			await session.sendUserMessage("write the file");
			const afterWrite = new RepoService({ cwd, agentDir });
			try {
				expect((await afterWrite.search("WRITTEN_NEEDLE")).hits).toEqual([
					expect.objectContaining({
						path: "engine.py",
						snippet: "def new_name(): return 'WRITTEN_NEEDLE'",
					}),
				]);
				expect((await afterWrite.symbol("old_name")).hits).toEqual([]);
			} finally {
				afterWrite.close();
			}
			await session.sendUserMessage("edit the file");
			const editResult = session.agent.state.messages.filter(message => message.role === "toolResult").at(-1);
			expect(editResult?.isError, JSON.stringify(editResult)).toBe(false);
			expect(await Bun.file(file).text()).toBe("def new_name(): return 'EDITED_NEEDLE'\n");
			const afterEdit = new RepoService({ cwd, agentDir });
			let generation: string | null;
			try {
				expect((await afterEdit.search("EDITED_NEEDLE")).hits).toEqual([
					expect.objectContaining({
						path: "engine.py",
						snippet: "def new_name(): return 'EDITED_NEEDLE'",
					}),
				]);
				generation = (await afterEdit.status()).generation;
			} finally {
				afterEdit.close();
			}
			await session.sendUserMessage("attempt an edit whose old text is missing");
			const failedEdit = session.agent.state.messages.filter(message => message.role === "toolResult").at(-1);
			expect(failedEdit?.isError).toBe(true);
			const afterFailure = new RepoService({ cwd, agentDir });
			try {
				expect((await afterFailure.status()).generation).toBe(generation);
				expect((await afterFailure.status()).pendingCount).toBe(0);
				expect((await afterFailure.search("MUST_NOT_APPEAR")).hits).toEqual([]);
			} finally {
				afterFailure.close();
			}
			await session.sendUserMessage("search the edited file using the repo tool");
			const results = session.agent.state.messages.filter(message => message.role === "toolResult");
			const last = results.at(-1);
			expect(last?.isError).toBe(false);
			expect(last?.content).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "text",
						text: expect.stringContaining("[1] engine.py:1-1 [source] def new_name(): return 'EDITED_NEEDLE'"),
					}),
				]),
			);
			await session.sendUserMessage("run a shell command which changes the workspace");
			const afterShell = new RepoService({ cwd, agentDir });
			try {
				expect((await afterShell.status()).needsReconcile).toBe(true);
				await afterShell.reconcile();
				expect((await afterShell.search("SHELLNEEDLE")).hits.map(hit => hit.path)).toEqual(["shell.py"]);
				expect((await afterShell.status()).needsReconcile).toBe(false);
			} finally {
				afterShell.close();
			}
			expect(await session.newSession()).toBe(true);
			const afterSessionChange = new RepoService({ cwd, agentDir });
			try {
				expect((await afterSessionChange.status()).unchecked).toBe(true);
				expect((await afterSessionChange.status()).needsReconcile).toBe(true);
			} finally {
				afterSessionChange.close();
			}
		} finally {
			await session.dispose();
			auth.close();
		}
		await fs.writeFile(file, "def after_disposal(): return 'DISPOSEDBEACON'\n");
		const disposed = new RepoService({ cwd, agentDir });
		try {
			expect((await disposed.status()).pendingCount).toBe(0);
			expect((await disposed.search("DISPOSEDBEACON")).hits).toEqual([]);
		} finally {
			disposed.close();
		}
	});
});

describe("repository lifecycle coverage across session and background execution boundaries", () => {
	it("marks a previously fully checked non-Git index unchecked when a session starts or changes", async () => {
		const temp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-repo-session-"));
		temporary.push(temp);
		const cwd = path.join(temp, "project");
		const agentDir = path.join(temp, "agent");
		await fs.mkdir(cwd);
		await fs.writeFile(path.join(cwd, "engine.py"), "def old_name(): pass\n");
		const service = new RepoService({ cwd, agentDir });
		const lifecycle = new RepoLifecycle({ agentDir, getCwd: () => cwd });
		try {
			await service.build();
			expect((await service.status()).unchecked).toBe(false);
			await fs.writeFile(path.join(cwd, "engine.py"), "def changed_while_closed(): pass\n");
			lifecycle.start();
			expect((await service.status()).unchecked).toBe(true);
			expect((await service.status()).needsReconcile).toBe(true);
			await service.reconcile();
			expect((await service.symbol("changed_while_closed")).hits.map(hit => hit.path)).toEqual(["engine.py"]);
			expect((await service.status()).unchecked).toBe(false);
			await fs.writeFile(path.join(cwd, "engine.py"), "def changed_between_sessions(): pass\n");
			lifecycle.onSessionChange();
			expect((await service.status()).unchecked).toBe(true);
			await service.reconcile();
			expect((await service.symbol("changed_between_sessions")).hits.map(hit => hit.path)).toEqual(["engine.py"]);
		} finally {
			lifecycle.dispose();
			service.close();
		}
	});

	it("reopens a cached unreadable lifecycle handle after a separate panel recovers the index", async () => {
		const temp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-repo-recovery-"));
		temporary.push(temp);
		const cwd = path.join(temp, "project");
		const agentDir = path.join(temp, "agent");
		await fs.mkdir(cwd);
		await fs.writeFile(path.join(cwd, "engine.py"), "def recovered_symbol(): pass\n");
		const initial = new RepoService({ cwd, agentDir });
		try {
			await initial.build();
		} finally {
			initial.close();
		}
		await fs.writeFile(repoIndexPath(agentDir, cwd), "corrupt database");
		const lifecycle = new RepoLifecycle({ agentDir, getCwd: () => cwd });
		const panel = new RepoService({ cwd, agentDir });
		try {
			expect(panel.storage.recoveryError).toBeDefined();
			lifecycle.start();
			await panel.recover();
			expect((await panel.status()).unchecked).toBe(false);
			lifecycle.onSessionChange();
			expect((await panel.status()).needsReconcile).toBe(true);
			await panel.reconcile();
			expect((await panel.symbol("recovered_symbol")).hits.map(hit => hit.path)).toEqual(["engine.py"]);
		} finally {
			lifecycle.dispose();
			panel.close();
		}
	});

	it("invalidates a panel reconcile when an async bash job writes after the panel checked the tree", async () => {
		const temp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-repo-async-"));
		temporary.push(temp);
		const cwd = path.join(temp, "project");
		const agentDir = path.join(temp, "agent");
		await fs.mkdir(cwd);
		await fs.mkdir(agentDir);
		const gate = path.join(temp, "release.fifo");
		execFileSync("mkfifo", [gate]);
		await fs.writeFile(path.join(cwd, "engine.py"), "def before(): pass\n");
		const initial = new RepoService({ cwd, agentDir });
		try {
			await initial.build();
		} finally {
			initial.close();
		}
		const command = `read release < '${gate}'; printf 'def after_background(): return "ASYNC_NEEDLE"\\n' > engine.py`;
		let requested = false;
		registerCustomApi("repo-async-local", () => {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				const message = createAssistantMessage("done");
				if (!requested) {
					requested = true;
					const toolCall = {
						type: "toolCall" as const,
						id: "background-bash-call",
						name: "bash",
						arguments: { command, async: true },
					};
					message.content = [toolCall];
					message.stopReason = "toolUse";
					stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: toolCall as never, partial: message });
					stream.push({ type: "done", reason: "toolUse", message });
				} else stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		});
		const model = buildModel({
			id: "repo-async",
			name: "Local Async Lifecycle",
			api: "repo-async-local",
			provider: "ollama",
			baseUrl: "http://127.0.0.1:1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		} as ModelSpec<Api>) as Model<Api>;
		const settings = await Settings.loadIsolated({
			cwd,
			agentDir,
			inMemory: true,
			overrides: { "compaction.enabled": false, "bashInterceptor.enabled": false, "async.enabled": true },
		});
		const auth = await AuthStorage.create(path.join(agentDir, "auth.db"));
		const registry = new ModelRegistry(auth, path.join(agentDir, "models.yml"));
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			settings,
			authStorage: auth,
			modelRegistry: registry,
			sessionManager: SessionManager.inMemory(cwd),
			model,
			disableExtensionDiscovery: true,
			extensions: [],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			toolNames: ["bash", "repo"],
		});
		try {
			const panel = new RepoService({ cwd, agentDir });
			try {
				await panel.reconcile();
				await session.sendUserMessage("start the delayed bash write");
				const jobs = session.asyncJobManager?.getRunningJobs({ ownerId: session.getAgentId() });
				expect(jobs?.map(job => job.type)).toEqual(["bash"]);
				const job = jobs![0];
				expect((await panel.status()).needsReconcile).toBe(true);
				await panel.reconcile();
				expect((await panel.status()).unchecked).toBe(false);
				const writer = await fs.open(gate, "w");
				try {
					await writer.writeFile("go\n");
				} finally {
					await writer.close();
				}
				await job.promise;
				expect(await fs.readFile(path.join(cwd, "engine.py"), "utf8")).toContain("ASYNC_NEEDLE");
				expect((await panel.status()).needsReconcile).toBe(true);
				expect((await panel.status()).unchecked).toBe(true);
				await panel.reconcile();
				expect((await panel.symbol("after_background")).hits.map(hit => hit.path)).toEqual(["engine.py"]);
			} finally {
				panel.close();
			}
		} finally {
			await session.dispose();
			auth.close();
		}
	});
});
