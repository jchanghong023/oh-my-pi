/**
 * `tools.approvalMode: always-ask-cached` — resolver semantics, the grant store, the prompt's
 * grant choices, and the wrapper's approve-then-remember cycle.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool, AgentToolContext, ToolTier } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type {
	ExtensionApprovalAnswer,
	ExtensionApprovalPrompt,
	ExtensionUIContext,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { approvalAnswerForChoice, requestApproval, resolveApproval } from "@oh-my-pi/pi-coding-agent/tools/approval";
import {
	APPROVAL_CACHE_FILENAME,
	approvalDirectoryKey,
	approvalGrantKey,
	clearApprovalGrants,
	getApprovalGrants,
} from "@oh-my-pi/pi-coding-agent/tools/approval-cache";
import { approvalTargetKey } from "@oh-my-pi/pi-coding-agent/tools/approval-targets";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { resolveXdevTool, type XdevState } from "@oh-my-pi/pi-coding-agent/tools/xdev";
import { getAgentDir, isRecord, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

/** Tool that keys `args.path` like read/write/edit do. */
function pathTool(name: string, tier: ToolTier, cwd: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} test tool`,
		parameters: {} as never,
		approval: tier,
		approvalCacheTargets: (args: unknown) =>
			isRecord(args) && typeof args.path === "string" ? [approvalTargetKey(cwd, args.path)!] : undefined,
		execute: async () => ({ content: [{ type: "text" as const, text: "executed" }] }),
	};
}

let root: TempDir;
beforeAll(() => {
	root = TempDir.createSync("@pi-approval-cached-");
});
afterAll(() => {
	root.removeSync();
});

/** A fresh agent directory per case, so grants never leak between cases. */
function freshAgentDir(): string {
	return fs.mkdtempSync(path.join(root.path(), "agent-"));
}

function recordingUi() {
	const prompts: ExtensionApprovalPrompt[] = [];
	const ui = {
		select: async () => undefined,
		approve: async (prompt: ExtensionApprovalPrompt) => {
			prompts.push(prompt);
			return "once" as const;
		},
	};
	return { ui, prompts };
}

async function promptFor(
	tool: AgentTool,
	args: unknown,
	options: Parameters<typeof requestApproval>[3] = { grants: true },
): Promise<ExtensionApprovalPrompt> {
	const { ui, prompts } = recordingUi();
	await requestApproval(ui, tool, args, options);
	return prompts[0]!;
}

function chooseAnswer(prompt: ExtensionApprovalPrompt, answer: ExtensionApprovalAnswer): ExtensionUIContext["select"] {
	return async (_title, choices) => {
		for (const choice of choices) {
			const label = typeof choice === "string" ? choice : choice.label;
			const actual = approvalAnswerForChoice(prompt, label);
			const matches =
				typeof answer === "string"
					? actual === answer
					: typeof actual === "object" && actual.grant === answer.grant && actual.always === answer.always;
			if (matches) return label;
		}
		return undefined;
	};
}

describe("always-ask-cached resolution", () => {
	it("allows a call only once every target is granted at its tier or above", () => {
		const agentDir = freshAgentDir();
		const cwd = path.join(agentDir, "work");
		const read = pathTool("read", "read", cwd);
		const write = pathTool("write", "write", cwd);
		const grants = getApprovalGrants(agentDir, "s1");
		const notes = approvalTargetKey(cwd, "notes.txt")!;

		expect(resolveApproval(read, { path: "notes.txt" }, "always-ask-cached", {}, grants)).toMatchObject({
			policy: "prompt",
		});
		grants.record(approvalGrantKey("read", notes), "read", "session");
		expect(resolveApproval(read, { path: "notes.txt" }, "always-ask-cached", {}, grants).policy).toBe("allow");
		// A read grant never lets a write through; a write grant covers reads.
		expect(resolveApproval(write, { path: "notes.txt" }, "always-ask-cached", {}, grants).policy).toBe("prompt");
		grants.record(approvalGrantKey("write", approvalTargetKey(cwd, "other.txt")!), "write", "session");
		expect(resolveApproval(read, { path: "other.txt" }, "always-ask-cached", {}, grants).policy).toBe("allow");
		// Without a store nothing counts as remembered.
		expect(resolveApproval(read, { path: "notes.txt" }, "always-ask-cached", {}).policy).toBe("prompt");
	});

	it("covers a folder grant's own files, never a subfolder or what lies below it", () => {
		const agentDir = freshAgentDir();
		const cwd = path.join(agentDir, "work");
		fs.mkdirSync(path.join(cwd, "dir", "sub"), { recursive: true });
		const read = pathTool("read", "read", cwd);
		const grants = getApprovalGrants(agentDir, "s1");
		grants.record(approvalGrantKey("read", approvalDirectoryKey(path.join(cwd, "dir"))), "read", "session");

		expect(resolveApproval(read, { path: "dir/a.ts" }, "always-ask-cached", {}, grants).policy).toBe("allow");
		expect(resolveApproval(read, { path: "dir/sub/a.ts" }, "always-ask-cached", {}, grants).policy).toBe("prompt");
		const subDir: AgentTool = {
			...read,
			approvalCacheTargets: () => [approvalDirectoryKey(path.join(cwd, "dir", "sub"))],
		};
		expect(resolveApproval(subDir, {}, "always-ask-cached", {}, grants).policy).toBe("prompt");
	});

	it("keys a new file under a symlinked folder by where it will land", () => {
		const agentDir = freshAgentDir();
		const real = path.join(agentDir, "real");
		const link = path.join(agentDir, "link");
		fs.mkdirSync(real);
		try {
			fs.symlinkSync(real, link, "junction");
		} catch {
			return; // Symlinks unavailable on this host.
		}
		// The target does not exist yet: its key still resolves the link, so a folder grant on the
		// link's own parent never covers a file that lands elsewhere.
		expect(approvalTargetKey(agentDir, "link/new.ts")).toBe(approvalTargetKey(agentDir, "real/new.ts"));
	});

	it("leaves read-tier calls without targets auto-approved and prompts write/exec ones", () => {
		const glob = { name: "lsp", approval: "read" as const } as AgentTool;
		const evalTool = { name: "eval", approval: "exec" as const } as AgentTool;
		expect(resolveApproval(glob, {}, "always-ask-cached", {}).policy).toBe("allow");
		expect(resolveApproval(evalTool, {}, "always-ask-cached", {})).toMatchObject({
			policy: "prompt",
			source: "mode",
		});
	});

	it("keeps tool and user policies authoritative over remembered grants", () => {
		const agentDir = freshAgentDir();
		const write = pathTool("write", "write", agentDir);
		const grants = getApprovalGrants(agentDir, "s1");
		grants.record(approvalGrantKey("write", approvalTargetKey(agentDir, "notes.txt")!), "write", "session");
		expect(
			resolveApproval(write, { path: "notes.txt" }, "always-ask-cached", { write: "prompt" }, grants),
		).toMatchObject({ policy: "prompt", source: "user" });
		const guarded: AgentTool = { ...write, approval: () => ({ tier: "write", override: true, reason: "guarded" }) };
		expect(resolveApproval(guarded, { path: "notes.txt" }, "always-ask-cached", {}, grants)).toMatchObject({
			policy: "prompt",
			source: "tool",
		});
	});

	it("keeps native read-only index approval semantics through bare and wrapped xd targets", () => {
		const agentDir = freshAgentDir();
		const nativeTools = ["wiki", "repo", "peek"].map(name => ({
			...pathTool(name, "read", agentDir),
			approvalCacheTargets: undefined,
		}));
		const xdev: XdevState = {
			tools: new Map(nativeTools.map(tool => [tool.name, tool])),
			mountedNames: new Set(nativeTools.map(tool => tool.name)),
			builtInNames: new Set(nativeTools.filter(tool => tool.name !== "peek").map(tool => tool.name)),
			isActive: () => false,
			resolve: name => resolveXdevTool(xdev, name),
		};
		const session: ToolSession = {
			cwd: agentDir,
			hasUI: true,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({}),
			xdev,
		};
		const write = new WriteTool(session);
		const grants = getApprovalGrants(agentDir, "index-query");
		for (const native of nativeTools.filter(tool => tool.name !== "peek")) {
			expect(resolveApproval(native, { query: "needle" }, "always-ask-cached", {}, grants).policy).toBe("allow");
			for (const target of [`xd://${native.name}`, `[xd://${native.name}#ABCD]`]) {
				const args = { path: target, content: JSON.stringify({ query: "needle" }) };
				expect(write.approvalCacheTargets(args)).toBeUndefined();
				expect(resolveApproval(write, args, "always-ask-cached", { write: "deny" }, grants).policy).toBe("allow");
				for (const policy of ["prompt", "deny"] as const) {
					expect(resolveApproval(write, args, "always-ask-cached", { [native.name]: policy }, grants).policy).toBe(
						policy,
					);
				}
			}
		}

		// Other read-only devices still carry their URI target; files remain write-tier.
		for (const target of ["xd://peek", "notes.txt"]) {
			const args = { path: target, content: "{}" };
			expect(write.approvalCacheTargets(args)).toEqual([approvalTargetKey(agentDir, target)!]);
			expect(resolveApproval(write, args, "always-ask-cached", {}, grants).policy).toBe("prompt");
			expect(resolveApproval(write, args, "always-ask-cached", { write: "deny" }, grants).policy).toBe("deny");
		}

		// An extension with an index tool's name is not a recognized built-in.
		const extensionWrite = new WriteTool({ ...session, xdev: { ...xdev, builtInNames: new Set() } });
		expect(extensionWrite.approvalCacheTargets({ path: "xd://wiki" })).toEqual([
			approvalTargetKey(agentDir, "xd://wiki")!,
		]);
	});
});

describe("approval grant store", () => {
	it("keeps session grants to their conversation and global grants for every session", () => {
		const agentDir = freshAgentDir();
		const key = approvalGrantKey("read", "/x");
		getApprovalGrants(agentDir, "one").record(key, "read", "session");
		expect(getApprovalGrants(agentDir, "one").present([key]).has(key)).toBe(true);
		expect(getApprovalGrants(agentDir, "two").present([key]).has(key)).toBe(false);
		// A caller that cannot name its conversation sees global grants only.
		expect(getApprovalGrants(agentDir).present([key]).has(key)).toBe(false);

		getApprovalGrants(agentDir, "one").record(key, "read", "global");
		expect(getApprovalGrants(agentDir, "two").present([key]).has(key)).toBe(true);
		expect(getApprovalGrants(agentDir).present([key]).has(key)).toBe(true);
	});

	it("creates no database until a grant is persisted, and honors deleting it", () => {
		const agentDir = freshAgentDir();
		const file = path.join(agentDir, APPROVAL_CACHE_FILENAME);
		const key = approvalGrantKey("read", "/x");
		expect(getApprovalGrants(agentDir).present([key]).size).toBe(0);
		expect(fs.existsSync(file)).toBe(false);
		getApprovalGrants(agentDir, "one").record(key, "read", "global");
		expect(fs.existsSync(file)).toBe(true);
		fs.rmSync(file);
		expect(getApprovalGrants(agentDir, "one").present([key]).size).toBe(0);
	});

	it("forgets both tiers for every conversation when cleared", () => {
		const agentDir = freshAgentDir();
		const sessionKey = approvalGrantKey("read", "/session");
		const globalKey = approvalGrantKey("read", "/global");
		getApprovalGrants(agentDir, "one").record(sessionKey, "read", "session");
		getApprovalGrants(agentDir, "two").record(globalKey, "read", "global");
		clearApprovalGrants(agentDir);
		expect(getApprovalGrants(agentDir, "one").present([sessionKey, globalKey]).size).toBe(0);
		expect(getApprovalGrants(agentDir, "two").present([sessionKey, globalKey]).size).toBe(0);
	});
});

describe("grant choices in the prompt", () => {
	it("offers the folder and the file, and names and lists the folder a grant would cover", async () => {
		const agentDir = freshAgentDir();
		const desktop = path.join(agentDir, "Desktop");
		fs.mkdirSync(path.join(desktop, "TestFolder"), { recursive: true });
		fs.writeFileSync(path.join(desktop, "notes.txt"), "x");
		fs.writeFileSync(path.join(desktop, "alpha.txt"), "x");
		const { ui, prompts } = recordingUi();
		await requestApproval(ui, pathTool("read", "read", desktop), { path: "notes.txt" }, { grants: true });
		expect(prompts[0]!.grants?.map(grant => grant.scope)).toEqual(["folder", "target"]);
		for (const entry of ["TestFolder/", "alpha.txt", "notes.txt"]) {
			expect(prompts[0]!.full).toContain(entry);
		}
	});

	it("offers only the directory answer for a call that names just that directory", async () => {
		const agentDir = freshAgentDir();
		const dir = path.join(agentDir, "Listed");
		fs.mkdirSync(dir);
		const { ui, prompts } = recordingUi();
		const listing: AgentTool = {
			...pathTool("read", "read", agentDir),
			approvalCacheTargets: () => [approvalDirectoryKey(dir)],
		};
		await requestApproval(ui, listing, {}, { grants: true });
		expect(prompts[0]!.grants?.map(grant => grant.scope)).toEqual(["folder"]);
	});

	it("allows a one-time approval without grants, and denies a grant the prompt never offered", async () => {
		const agentDir = freshAgentDir();
		const write = pathTool("write", "write", agentDir);
		const prompt = await promptFor(write, { path: "a.txt" }, {});
		expect(await requestApproval({ select: chooseAnswer(prompt, "once") }, write, { path: "a.txt" })).toBe("once");

		const answer = await requestApproval(
			{ select: async () => undefined, approve: async () => ({ grant: "folder", always: true }) as const },
			write,
			{ path: "a.txt" },
		);
		expect(answer).toBe("deny");
	});

	it("maps select labels back to grants for hosts without a dialog", async () => {
		const agentDir = freshAgentDir();
		const write = pathTool("write", "write", agentDir);
		const prompt = await promptFor(write, { path: "a.txt" });
		for (const answer of [{ grant: "target", always: true }, { grant: "folder", always: false }, "once"] as const) {
			const ui = { select: chooseAnswer(prompt, answer) };
			expect(await requestApproval(ui, write, { path: "a.txt" }, { grants: true })).toEqual(answer);
		}
	});
});

describe("always-ask-cached wrapper cycle", () => {
	let agentDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let originalAgentDir: string;

	beforeAll(async () => {
		authStorage = await AuthStorage.create(path.join(root.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});
	afterAll(() => {
		authStorage.close();
	});
	beforeEach(() => {
		originalAgentDir = getAgentDir();
		agentDir = freshAgentDir();
		setAgentDir(agentDir);
	});
	afterEach(() => {
		setAgentDir(originalAgentDir);
	});

	function runnerWith(sessionManager: SessionManager, select: ExtensionUIContext["select"]): ExtensionRunner {
		const runner = new ExtensionRunner([], new ExtensionRuntime(), agentDir, sessionManager, modelRegistry);
		runner.initialize(
			{
				sendMessage: () => {},
				sendUserMessage: () => {},
				appendEntry: () => {},
				setLabel: () => {},
				getActiveTools: () => [],
				getAllTools: () => [],
				setActiveTools: async () => {},
				getCommands: () => [],
				setModel: async () => false,
				getThinkingLevel: () => undefined,
				setThinkingLevel: () => {},
				getSessionName: () => undefined,
				setSessionName: async () => {},
			},
			{
				getModel: () => undefined,
				isIdle: () => true,
				abort: () => {},
				hasPendingMessages: () => false,
				shutdown: () => {},
				getContextUsage: () => undefined,
				compact: async () => {},
				getSystemPrompt: () => [],
			},
			undefined,
			{
				select,
				confirm: async () => false,
				input: async () => undefined,
				notify: () => {},
				onTerminalInput: () => () => {},
				setStatus: () => {},
				setWorkingMessage: () => {},
				setWidget: () => {},
				setFooter: () => {},
				setHeader: () => {},
				setTitle: () => {},
				custom: async <T>() => undefined as T,
				pasteToEditor: () => {},
				setEditorText: () => {},
				getEditorText: () => "",
				editor: async () => undefined,
				addAutocompleteProvider: () => {},
				setEditorComponent: () => {},
				getEditorComponent: () => undefined,
				get theme() {
					return {} as never;
				},
				getAllThemes: async () => [],
				getTheme: async () => undefined,
				setTheme: async () => ({ success: false, error: "not implemented" }),
				getToolsExpanded: () => false,
				setToolsExpanded: () => {},
			} satisfies ExtensionUIContext,
		);
		return runner;
	}

	function context(sessionManager: SessionManager): AgentToolContext {
		return {
			sessionManager,
			modelRegistry,
			model: undefined,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
			settings: Settings.isolated({ "tools.approvalMode": "always-ask-cached" }),
		} as AgentToolContext;
	}

	it("remembers a session grant for its conversation only, and an Always grant for every one", async () => {
		const cwd = path.join(agentDir, "work");
		const tool = pathTool("write", "write", cwd);
		const first = SessionManager.inMemory(cwd);
		const prompt = await promptFor(tool, { path: "a.txt" });
		const select = vi.fn(chooseAnswer(prompt, { grant: "target", always: false }));
		const wrapper = new ExtensionToolWrapper(tool, runnerWith(first, select));

		await wrapper.execute("w1", { path: "a.txt" }, undefined, undefined, context(first));
		await wrapper.execute("w2", { path: "a.txt" }, undefined, undefined, context(first));
		expect(select).toHaveBeenCalledTimes(1);

		// Another conversation in the same process asks again.
		const second = SessionManager.inMemory(cwd);
		const always = vi.fn(chooseAnswer(prompt, { grant: "target", always: true }));
		const secondWrapper = new ExtensionToolWrapper(tool, runnerWith(second, always));
		await secondWrapper.execute("w3", { path: "a.txt" }, undefined, undefined, context(second));
		expect(always).toHaveBeenCalledTimes(1);

		// The Always grant reaches a third conversation without a prompt.
		const third = SessionManager.inMemory(cwd);
		const never = vi.fn(chooseAnswer(prompt, "deny"));
		await new ExtensionToolWrapper(tool, runnerWith(third, never)).execute(
			"w4",
			{ path: "a.txt" },
			undefined,
			undefined,
			context(third),
		);
		expect(never).not.toHaveBeenCalled();
	});

	it("records nothing for Approve Once or Deny", async () => {
		const cwd = path.join(agentDir, "work");
		const tool = pathTool("write", "write", cwd);
		const session = SessionManager.inMemory(cwd);
		const prompt = await promptFor(tool, { path: "a.txt" });
		const answers: ExtensionApprovalAnswer[] = ["once", "deny", "once"];
		const select = vi.fn<ExtensionUIContext["select"]>(async (title, choices, options) =>
			chooseAnswer(prompt, answers.shift()!)(title, choices, options),
		);
		const wrapper = new ExtensionToolWrapper(tool, runnerWith(session, select));
		await wrapper.execute("o1", { path: "a.txt" }, undefined, undefined, context(session));
		await expect(wrapper.execute("o2", { path: "a.txt" }, undefined, undefined, context(session))).rejects.toThrow(
			"denied by user",
		);
		await wrapper.execute("o3", { path: "a.txt" }, undefined, undefined, context(session));
		expect(select).toHaveBeenCalledTimes(3);
	});

	it("offers an exec call without targets the session answer, not grants", async () => {
		const session = SessionManager.inMemory(path.join(agentDir, "work"));
		const tool: AgentTool = { ...pathTool("probe_exec", "exec", agentDir), approvalCacheTargets: undefined };
		const prompt = await promptFor(tool, {}, { sessionSubject: "probe_exec" });
		const select = vi.fn(chooseAnswer(prompt, "session"));
		const wrapper = new ExtensionToolWrapper(tool, runnerWith(session, select));
		await wrapper.execute("e1", {}, undefined, undefined, context(session));
		await wrapper.execute("e2", {}, undefined, undefined, context(session));
		expect(select).toHaveBeenCalledTimes(1);
	});
});
