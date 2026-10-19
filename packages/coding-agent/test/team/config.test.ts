import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { AgentStorage } from "../../src/session/agent-storage";
import { TeamConfigError, TeamConfigService } from "../../src/team/config";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

// Real YAML, Settings CAS and catalog resolution; no provider requests or replacement storage implementation.
describe("TeamConfigService", () => {
	let state: SettingsTestState;
	let temporary: TempDir;
	let agentDir: string;
	let cwd: string;
	let auth: AuthStorage;
	let settings: Settings;
	let registry: ModelRegistry;
	let service: TeamConfigService;
	let notifications: object[];

	beforeEach(async () => {
		state = beginSettingsTest();
		temporary = TempDir.createSync("omp-team-config-");
		agentDir = temporary.join("agent");
		cwd = temporary.join("project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(cwd, { recursive: true });
		await Bun.write(
			path.join(agentDir, "config.yml"),
			'team:\n  members: ["test/Qwen3.8-27B", "retired old selector", "test/Qwen3.8-27B"]\n',
		);
		await Bun.write(
			path.join(agentDir, "models.yml"),
			`providers:
  test:
    baseUrl: https://example.invalid/v1
    api: openai-completions
    auth: none
    models:
      - id: Qwen3.8-27B
        name: Qwen 3.8 27B
        supportsTools: true
      - id: Qwen3.8-35B
        name: Qwen 3.8 35B
        supportsTools: true
`,
		);
		settings = await Settings.loadIsolated({ agentDir, cwd });
		auth = await AuthStorage.create(":memory:");
		registry = new ModelRegistry(auth, path.join(agentDir, "models.yml"), { settings });
		notifications = [];
		service = new TeamConfigService({
			getSettings: () => settings,
			getModelRegistry: () => registry,
			getSessionModel: () =>
				registry.getAll().find(model => model.provider === "test" && model.id === "Qwen3.8-27B"),
			emit: frame => notifications.push(frame),
		});
	});

	afterEach(() => {
		auth?.close();
		restoreSettingsTestState(state);
		AgentStorage.close();
		Bun.gc(true);
		temporary.removeSync();
	});

	it("retains an invalid string at its original index while allowing a revisioned repair", async () => {
		const before = await service.getConfig();
		expect(before.revision).toBeString();
		expect(before.writableScopes).toEqual(["user"]);
		expect(before.userMembers?.map(slot => slot.rawSelector)).toEqual([
			"test/Qwen3.8-27B",
			"retired old selector",
			"test/Qwen3.8-27B",
		]);
		expect(before.issues).toContainEqual(
			expect.objectContaining({ target: "member", list: "userMembers", index: 1, selector: "retired old selector" }),
		);
		expect(before.participants).toEqual([]);
		const result = await service.setConfig({
			scope: "user",
			expectedRevision: before.revision!,
			members: [
				{ provider: "test", modelId: "Qwen3.8-27B" },
				{ provider: "test", modelId: "Qwen3.8-27B" },
			],
		});
		expect(result.saveState).toBe("complete");
		expect(result.config.participants.map(slot => slot.label)).toEqual(["A", "B", "C"]);
		expect(result.config.userMembers).toHaveLength(2);
		expect(result.effectiveMatchesRequested).toBe(true);
		expect(notifications).toEqual([{ type: "settings_changed", scope: "user" }]);
	});

	it("projects preserved invalid slots and defaults without changing file bytes or actual snapshot", async () => {
		const file = path.join(agentDir, "config.yml");
		const bytes = await Bun.file(file).text();
		const invalid = await service.getConfig({
			clientRevision: "draft-invalid",
			members: [{ rawSelector: "retired old selector" }],
		});
		expect(invalid.preview?.clientRevision).toBe("draft-invalid");
		expect(invalid.preview?.participants).toEqual([]);
		expect(invalid.preview?.issues).toContainEqual(
			expect.objectContaining({ list: "preview.userMembers", index: 0 }),
		);
		const defaults = await service.getConfig({ clientRevision: "draft-default", members: [] });
		expect(defaults.userMembers).toHaveLength(3);
		expect(defaults.preview?.userMembers).toEqual([]);
		expect(defaults.preview?.participants).toHaveLength(3);
		expect(await Bun.file(file).text()).toBe(bytes);
		expect(notifications).toEqual([]);
	});

	it("returns every ambiguous real Chinese-name match without network discovery", () => {
		const candidates = service.getModels("千问3.8 test").models;
		expect(candidates.map(candidate => candidate.model.modelId).sort()).toEqual(["Qwen3.8-27B", "Qwen3.8-35B"]);
		expect(candidates.every(candidate => candidate.selectable)).toBe(true);
		expect(service.getModels("不存在的模型").models).toEqual([]);
	});

	it("keeps higher-priority participants when the user draft contains unavailable slots", async () => {
		settings = settings.overlay({ "team.members": ["test/Qwen3.8-35B"] });
		service = new TeamConfigService({
			getSettings: () => settings,
			getModelRegistry: () => registry,
			getSessionModel: () =>
				registry.getAll().find(model => model.provider === "test" && model.id === "Qwen3.8-27B"),
		});
		const config = await service.getConfig({
			clientRevision: "covered",
			members: [{ rawSelector: "retired old selector" }],
		});
		expect(config.preview?.source).toBe("runtime");
		expect(config.preview?.effectiveMembers?.[0]?.model?.modelId).toBe("Qwen3.8-35B");
		expect(config.preview?.issues).toContainEqual(
			expect.objectContaining({ list: "preview.userMembers", code: "unresolved_model" }),
		);
		expect(config.preview?.participants.map(participant => participant.model)).toEqual([
			{ provider: "test", modelId: "Qwen3.8-35B" },
			{ provider: "test", modelId: "Qwen3.8-35B" },
			{ provider: "test", modelId: "Qwen3.8-35B" },
		]);
	});

	it("allows member repair with no session model, without fabricating runtime slots", async () => {
		service = new TeamConfigService({
			getSettings: () => settings,
			getModelRegistry: () => registry,
			getSessionModel: () => undefined,
		});
		const config = await service.getConfig();
		expect(config.sessionModel).toBeNull();
		const result = await service.setConfig({
			scope: "user",
			expectedRevision: config.revision!,
			members: [{ provider: "test", modelId: "Qwen3.8-27B" }],
		});
		expect(result.saveState).toBe("complete");
		expect(result.config.participants).toEqual([]);
		expect(result.config.issues).toContainEqual(expect.objectContaining({ target: "session_model" }));
		expect(result.config.userMembers?.[0]?.status).toBe("available");
	});

	it("rejects stale revisions before writing and does not emit a commit notification", async () => {
		const config = await service.getConfig();
		const file = path.join(agentDir, "config.yml");
		await Bun.write(file, "team:\n  members: []\n");
		try {
			await service.setConfig({
				scope: "user",
				expectedRevision: config.revision!,
				members: [{ provider: "test", modelId: "Qwen3.8-27B" }],
			});
			throw new Error("Expected a revision conflict");
		} catch (error) {
			expect(error).toBeInstanceOf(TeamConfigError);
			if (!(error instanceof TeamConfigError)) throw error;
			expect(error.code).toBe("revision_conflict");
			expect(error.data?.saveState).toBe("failed");
			expect(error.data?.writes.active.status).toBe("not_attempted");
		}
		expect(notifications).toEqual([]);
		expect(await Bun.file(file).text()).toBe("team:\n  members: []\n");
	});
});
