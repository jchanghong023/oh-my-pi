import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession, type CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

import { cfgEditMode } from "@oh-my-pi/pi-coding-agent/edit/settings";
import { cfgBashEnabled } from "@oh-my-pi/pi-coding-agent/exec/settings";
import { cfgGithubEnabled, cfgGrepEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { pythonBackend } from "@oh-my-pi/pi-coding-agent/eval";
import * as pyKernel from "@oh-my-pi/pi-coding-agent/eval/py/kernel";

// Tool-gating settings (`grep.enabled`, `*.enabled`, ...) must reconcile a live
// session's tools and prompt instead of waiting for the next session.
describe("settings-gated tools in a live session", () => {
	let registryDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		registryDir = path.join(os.tmpdir(), `pi-settings-gated-tools-${Snowflake.next()}`);
		fs.mkdirSync(registryDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(registryDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(registryDir, "models.yml"));
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose().catch(() => {});
		vi.restoreAllMocks();
	});

	afterAll(() => {
		authStorage.close();
		if (fs.existsSync(registryDir)) removeSyncWithRetries(registryDir);
	});

	async function startSession(
		settings: Settings,
		toolNames?: string[],
		extra: Pick<
			CreateAgentSessionOptions,
			"offline" | "sessionManager" | "parentTaskPrefix" | "taskDepth" | "agentId"
		> = {},
	): Promise<AgentSession> {
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableLsp: false,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
			workspaceTree: { rootPath: registryDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			toolNames,
			...extra,
		});
		sessions.push(session);
		return session;
	}

	/** Lets the coalesced watch fire, then waits for the reconcile it queued on the registry lock. */
	async function settle(session: AgentSession): Promise<void> {
		await Promise.resolve();
		await session.runToolRegistryMutation(async () => {});
	}

	it.each([false, true])(
		"creates fresh, resumed and child Python-enabled sessions without probing (offline=%s)",
		async offline => {
			const available = vi.spyOn(pythonBackend, "checkAvailability").mockResolvedValue({
				ok: false,
				reason: "fixture Python cannot start",
			});
			const kernelProbe = vi.spyOn(pyKernel, "checkPythonKernelAvailability");
			const kernelStart = vi.spyOn(pyKernel.PythonKernel, "start");
			const resumed = SessionManager.inMemory(registryDir);
			resumed.appendMessage({ role: "user", content: "restored conversation", timestamp: 0 });
			for (const extra of [
				{ offline },
				{ offline, sessionManager: resumed },
				{ offline, parentTaskPrefix: "PythonChild", taskDepth: 1, agentId: "PythonChild" },
			]) {
				const session = await startSession(
					Settings.isolated({ "eval.py": true, "eval.js": false }),
					["eval"],
					extra,
				);
				expect(session.getAllToolNames()).toContain("eval");
			}
			expect(available).not.toHaveBeenCalled();
			expect(kernelProbe).not.toHaveBeenCalled();
			expect(kernelStart).not.toHaveBeenCalled();
			const tool = sessions[0]!.getToolByName("eval")!;
			await expect(tool.execute("missing-python", { language: "py", code: "print(1)" })).rejects.toThrow(
				"fixture Python cannot start",
			);
			expect(available).toHaveBeenCalledTimes(1);
			expect(kernelStart).not.toHaveBeenCalled();
		},
	);

	const GREP_POLICY = "NEVER shell `grep`/`rg`/`awk`";

	it("removes and restores grep in the request tools and system prompt", async () => {
		const settings = Settings.isolated({});
		const session = await startSession(settings);
		expect(session.getActiveToolNames()).toContain("grep");
		expect(session.systemPrompt.join("\n")).toContain(GREP_POLICY);

		cfgGrepEnabled.set(settings, false);
		await settle(session);
		expect(session.getActiveToolNames()).not.toContain("grep");
		expect(session.getToolByName("grep")).toBeUndefined();
		expect(session.systemPrompt.join("\n")).not.toContain(GREP_POLICY);
		expect(session.getActiveToolNames()).toContain("read");

		cfgGrepEnabled.set(settings, true);
		await settle(session);
		expect(session.getActiveToolNames()).toContain("grep");
		expect(session.systemPrompt.join("\n")).toContain(GREP_POLICY);
	});

	it("edit.mode none swaps edit out and keeps bash despite bash.enabled", async () => {
		const settings = Settings.isolated({ "bash.enabled": false });
		const session = await startSession(settings);
		expect(session.getActiveToolNames()).toContain("edit");
		expect(session.getActiveToolNames()).not.toContain("bash");

		cfgEditMode.set(settings, "none");
		await settle(session);
		expect(session.getToolByName("edit")).toBeUndefined();
		expect(session.getActiveToolNames()).not.toContain("edit");
		expect(session.getActiveToolNames()).toContain("bash");

		cfgEditMode.set(settings, "replace");
		await settle(session);
		expect(session.getActiveToolNames()).toContain("edit");
		expect(session.getToolByName("bash")).toBeUndefined();
	});

	it("never widens an explicit tool list", async () => {
		const settings = Settings.isolated({ "grep.enabled": false, "github.enabled": false });
		const session = await startSession(settings, ["read", "bash"]);
		const before = session.getActiveToolNames();
		expect(before).not.toContain("grep");

		cfgGrepEnabled.set(settings, true);
		cfgGithubEnabled.set(settings, true);
		await settle(session);
		expect(session.getActiveToolNames()).toEqual(before);
		expect(session.getToolByName("grep")).toBeUndefined();

		cfgBashEnabled.set(settings, false);
		await settle(session);
		expect(session.getActiveToolNames()).not.toContain("bash");
		expect(session.getActiveToolNames()).toContain("read");
	});
});
