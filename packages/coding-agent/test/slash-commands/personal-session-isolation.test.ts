import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getTestModel } from "../helpers/model-fixtures";
import { getProjectDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { createAgentSession, type CreateAgentSessionResult } from "../../src/sdk";
import { SessionManager } from "../../src/session/session-manager";
import * as sessionWorktree from "../../src/session/session-worktree";
import { executeRpcBuiltinSlashCommand } from "../../src/slash-commands/acp-builtins";
import type { RpcSlashCommandRuntime } from "../../src/slash-commands/types";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});

async function fixture() {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-personal-session-")));
	cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
	const source = path.join(root, "source");
	const target = path.join(root, "target");
	await Promise.all([source, target].map(directory => fs.mkdir(directory)));
	const created: CreateAgentSessionResult[] = [];
	const auth = createInMemoryAuthStorage();
	auth.keys.setRuntime("ascend", "personal-session-fixture-key");
	cleanups.push(async () => {
		for (const result of created.reverse()) await result.session.dispose();
		auth.close();
	});
	async function make(cwd: string) {
		const settings = Settings.isolated({ "compaction.enabled": false });
		const manager = SessionManager.inMemory(cwd);
		const result = await createAgentSession({
			cwd,
			agentDir: path.join(root, "profile"),
			sessionManager: manager,
			settings,
			authStorage: auth,
			modelRegistry: new ModelRegistry(auth, path.join(root, "models.yml")),
			model: getTestModel("ascend"),
			bindProcessState: false,
			offline: true,
			disableExtensionDiscovery: true,
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read"],
			restrictToolNames: true,
		});
		created.push(result);
		const output: string[] = [];
		const rebindCwd = vi.fn(async (newCwd: string): Promise<void> => {
			runtime.cwd = newCwd;
		});
		const runtime = {
			session: result.session,
			sessionManager: manager,
			settings,
			cwd,
			rebindCwd,
			output: (text: string) => {
				output.push(text);
			},
			refreshCommands: async () => {},
			reloadPlugins: async () => {},
		} as unknown as RpcSlashCommandRuntime;
		return { ...result, runtime, manager, settings, output, rebindCwd };
	}
	return { root, source, target, make };
}

function git(cwd: string, ...args: string[]): string {
	const child = Bun.spawnSync(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (child.exitCode !== 0) throw new Error(child.stderr.toString());
	return child.stdout.toString().trim();
}

describe("personal command session isolation", () => {
	it("rebinds a moved RPC session without changing the process or sibling session directory", async () => {
		const f = await fixture();
		await Bun.write(path.join(f.source, "location.txt"), "source-session-content");
		await Bun.write(path.join(f.target, "location.txt"), "target-session-content");
		const first = await f.make(f.source);
		const sibling = await f.make(f.source);
		const processDirectory = getProjectDir();
		const nativeProcessDirectory = process.cwd();
		const firstIdentity = first.manager.getSessionId();
		const siblingIdentity = sibling.manager.getSessionId();
		expect(await executeRpcBuiltinSlashCommand(`/move ${f.target}`, first.runtime)).toEqual({ consumed: true });
		expect(first.rebindCwd).toHaveBeenCalledWith(f.target);
		expect(first.manager.getCwd()).toBe(f.target);
		expect(first.runtime.cwd).toBe(f.target);
		expect(first.manager.getSessionId()).toBe(firstIdentity);
		expect(sibling.manager.getCwd()).toBe(f.source);
		expect(sibling.runtime.cwd).toBe(f.source);
		expect(sibling.manager.getSessionId()).toBe(siblingIdentity);
		expect(getProjectDir()).toBe(processDirectory);
		expect(process.cwd()).toBe(nativeProcessDirectory);
		for (const [owner, expected] of [
			[first, "target-session-content"],
			[sibling, "source-session-content"],
		] as const) {
			const read = owner.session.getToolByName("read")!;
			const result = await read.execute("verify-session-cwd", { path: "location.txt" });
			expect(result.content).toContainEqual(
				expect.objectContaining({ type: "text", text: expect.stringContaining(expected) }),
			);
		}
	});

	it("skips same-branch worktree relocation and keeps staged, unstaged and untracked source content", async () => {
		const f = await fixture();
		git(f.source, "init", "-q", "-b", "main");
		await Bun.write(path.join(f.source, "tracked.txt"), "committed\n");
		git(f.source, "add", ".");
		git(f.source, "commit", "-q", "-m", "initial");
		await Bun.write(path.join(f.source, "tracked.txt"), "staged\n");
		git(f.source, "add", "tracked.txt");
		await Bun.write(path.join(f.source, "tracked.txt"), "unstaged\n");
		await Bun.write(path.join(f.source, "untracked.txt"), "untracked\n");
		const before = git(f.source, "status", "--porcelain");
		const staged = git(f.source, "diff", "--cached");
		const host = await f.make(f.source);
		const sibling = await f.make(f.source);
		const identity = host.manager.getSessionId();
		const siblingIdentity = sibling.manager.getSessionId();
		const processDirectory = getProjectDir();
		const nativeProcessDirectory = process.cwd();
		const worktree = vi.spyOn(sessionWorktree, "createSessionWorktree");
		const move = vi.spyOn(host.session, "moveSession");
		expect(await executeRpcBuiltinSlashCommand("/wt main", host.runtime)).toEqual({ consumed: true });
		expect(worktree).toHaveBeenCalledTimes(1);
		expect(worktree).toHaveBeenCalledWith(f.source, host.settings, "main");
		await expect(worktree.mock.results[0]!.value).resolves.toMatchObject({
			path: f.source,
			branch: "main",
			created: false,
			createdBranch: false,
		});
		expect(host.manager.getCwd()).toBe(f.source);
		expect(host.runtime.cwd).toBe(f.source);
		expect(host.manager.getSessionId()).toBe(identity);
		expect(sibling.manager.getCwd()).toBe(f.source);
		expect(sibling.manager.getSessionId()).toBe(siblingIdentity);
		expect(getProjectDir()).toBe(processDirectory);
		expect(process.cwd()).toBe(nativeProcessDirectory);
		expect(move).not.toHaveBeenCalled();
		expect(host.rebindCwd).not.toHaveBeenCalled();
		expect(git(f.source, "status", "--porcelain")).toBe(before);
		expect(git(f.source, "diff", "--cached")).toBe(staged);
		expect(await Bun.file(path.join(f.source, "tracked.txt")).text()).toBe("unstaged\n");
		expect(await Bun.file(path.join(f.source, "untracked.txt")).text()).toBe("untracked\n");
	});

	it("clears real conversation state in place while retaining durable identity, title, directory and model", async () => {
		const f = await fixture();
		const host = await f.make(f.source);
		const sibling = await f.make(f.source);
		const siblingMessages = [{ role: "user" as const, content: "keep sibling context", timestamp: 2 }];
		sibling.session.agent.replaceMessages(siblingMessages);
		const siblingIdentity = sibling.manager.getSessionId();
		const processDirectory = getProjectDir();
		const nativeProcessDirectory = process.cwd();
		await host.manager.setSessionName("keep-session-title", "user");
		const message = { role: "user" as const, content: "discard this context", timestamp: 1 };
		host.manager.appendMessage(message);
		host.session.agent.replaceMessages([message]);
		const identity = host.manager.getSessionId();
		const model = host.session.model;
		expect(await executeRpcBuiltinSlashCommand("/clear", host.runtime)).toEqual({ consumed: true });
		expect(host.session.agent.state.messages).toEqual([]);
		expect(host.manager.getSessionId()).toBe(identity);
		expect(host.manager.getSessionName()).toBe("keep-session-title");
		expect(host.manager.getCwd()).toBe(f.source);
		expect(host.session.model).toBe(model);
		expect(host.session.settings).toBe(host.settings);
		expect(host.session.isDisposed).toBe(false);
		expect(host.manager.buildSessionContext().messages).toEqual([]);
		expect(sibling.session.agent.state.messages).toEqual(siblingMessages);
		expect(sibling.manager.getSessionId()).toBe(siblingIdentity);
		expect(sibling.manager.getCwd()).toBe(f.source);
		expect(getProjectDir()).toBe(processDirectory);
		expect(process.cwd()).toBe(nativeProcessDirectory);
	});
});
