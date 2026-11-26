import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("session runtime boundary regressions", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-runtime-compact-review-");
		authStorage = await AuthStorage.create(":memory:");
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		vi.restoreAllMocks();
		authStorage.close();
		closeModelCache();
		tempDir.removeSync();
	});

	it("persists a first custom report before returning and restores it without an assistant turn", async () => {
		const mock = createMockModel({ provider: "openai", id: "gpt-test" });
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
				convertToLlm,
				streamFn: mock.stream,
			}),
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": false, "prewalk.enabled": false, "todo.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			toolRegistry: new Map(),
		});
		const sessionFile = manager.getSessionFile()!;
		const report = {
			customType: "team-result",
			content: "A reviewed plan with its evidence and adoption conditions.",
			display: true,
			attribution: "agent" as const,
		};
		await session.appendCustomMessage(report);
		expect(await Bun.file(sessionFile).text()).toContain(report.content);
		await session.dispose();
		session = undefined;
		const restored = await SessionManager.open(sessionFile, tempDir.path(), undefined, { throwIfMissing: true });
		try {
			expect(restored.buildSessionContext().messages).toEqual([
				expect.objectContaining({ role: "custom", ...report }),
			]);
			expect(
				restored.getEntries().some(entry => entry.type === "message" && entry.message.role === "assistant"),
			).toBe(false);
		} finally {
			await restored.close();
		}
	});

	it("rejects a report append while newSession has reset live context but has not committed its transcript", async () => {
		const mock = createMockModel({ provider: "openai", id: "gpt-test" });
		const manager = SessionManager.inMemory(tempDir.path());
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: mock.model, systemPrompt: ["Test"], tools: [], messages: [] },
				convertToLlm,
				streamFn: mock.stream,
			}),
			sessionManager: manager,
			settings: Settings.isolated({ "compaction.enabled": false, "prewalk.enabled": false, "todo.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			toolRegistry: new Map(),
		});
		const oldSessionId = manager.getSessionId();
		const flushEntered = Promise.withResolvers<void>();
		const releaseFlush = Promise.withResolvers<void>();
		const originalFlush = manager.flush.bind(manager);
		spyOn(manager, "flush").mockImplementationOnce(async () => {
			flushEntered.resolve();
			await releaseFlush.promise;
			await originalFlush();
		});
		const transition = session.newSession();
		try {
			await flushEntered.promise;
			expect(manager.getSessionId()).toBe(oldSessionId);
			await expect(
				session.appendCustomMessage({
					customType: "team-result",
					content: "STALE_REPORT",
					display: true,
					attribution: "agent",
				}),
			).rejects.toThrow();
			expect(JSON.stringify(manager.getEntries())).not.toContain("STALE_REPORT");
			expect(JSON.stringify(session.agent.state.messages)).not.toContain("STALE_REPORT");
		} finally {
			releaseFlush.resolve();
			await transition;
		}
		expect(manager.getSessionId()).not.toBe(oldSessionId);
		expect(JSON.stringify(session.agent.state.messages)).not.toContain("STALE_REPORT");
	});
});
