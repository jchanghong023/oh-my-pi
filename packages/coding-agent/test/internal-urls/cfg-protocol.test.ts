import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { getAgentDbPath } from "@oh-my-pi/pi-utils/dirs";
import {
	type CfgAppliedChange,
	type CfgChangeRequest,
	CfgProtocolHandler,
	setCfgApprovalHost,
} from "@oh-my-pi/pi-coding-agent/internal-urls/cfg-protocol";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

import { cfgAdvisorEnabled, cfgAdvisorSyncBacklog } from "@oh-my-pi/pi-coding-agent/advisor/settings";
import { cfgEditFuzzyMatch } from "@oh-my-pi/pi-coding-agent/edit/settings";
import { cfgBashPatterns } from "@oh-my-pi/pi-coding-agent/exec/settings";
import { cfgModelRoles } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { cfgSearxngEndpoint } from "@oh-my-pi/pi-coding-agent/web/settings";
import { cfgTeamMembers } from "@oh-my-pi/pi-coding-agent/team/settings";
import type { InternalWriteResult } from "@oh-my-pi/pi-coding-agent/internal-urls/types";

function sessionWith(settings: Settings, caller: Partial<ToolSession> = {}): ToolSession {
	return { settings, hasUI: true, settingsApproval: true, taskDepth: 0, ...caller } as unknown as ToolSession;
}

const handler = new CfgProtocolHandler();
const read = (url: string, settings: Settings) =>
	handler.resolve(parseInternalUrl(url), { session: sessionWith(settings) });
const write = (url: string, content: string, settings: Settings, caller?: Partial<ToolSession>) =>
	handler.write(parseInternalUrl(url), content, { session: sessionWith(settings, caller) });
const textOf = (result: InternalWriteResult) => (result.content[0]?.type === "text" ? result.content[0].text : "");

describe("CfgProtocolHandler", () => {
	afterEach(() => setCfgApprovalHost(null));

	it("lists a namespace relative to its prefix and a setting with its source", async () => {
		const settings = Settings.isolated({ "advisor.syncBacklog": "3" });

		const namespace = await read("cfg://advisor", settings);
		expect(namespace.content).toContain('syncBacklog: "3"  # off|1|3|5|strict · default "off"');
		expect(namespace.content).not.toContain("advisor:");
		expect(namespace.details?.cfg).toMatchObject({ path: "advisor", modified: 1 });

		const leaf = await read("cfg://Advisor.SyncBacklog", settings);
		expect(leaf.content).toStartWith('advisor.syncBacklog: "3"');
		expect(leaf.content).toContain("source: session override");
	});

	it("redacts credential values", async () => {
		const settings = Settings.isolated({ "auth.broker.token": "sekrit" });
		const resource = await read("cfg://auth", settings);
		expect(resource.content).toContain("token: <redacted>");
		expect(resource.content).not.toContain("sekrit");
	});

	it("refuses writes when no host can ask the user", async () => {
		const settings = Settings.isolated();
		await expect(write("cfg://advisor/enabled", "true", settings)).rejects.toThrow("requires user approval");
		expect(cfgAdvisorEnabled.get(settings)).toBe(false);
	});

	it("refuses subagent and headless writes without prompting the user", async () => {
		const settings = Settings.isolated();
		const asked: CfgChangeRequest[] = [];
		setCfgApprovalHost({
			approve: async request => (asked.push(request), "once"),
			applied: () => {},
			persistentSettings: settings,
		});

		await expect(write("cfg://advisor/enabled", "true", settings, { taskDepth: 1 })).rejects.toThrow(
			"Subagents cannot change settings",
		);
		await expect(write("cfg://advisor/enabled/save", "true", settings, { settingsApproval: false })).rejects.toThrow(
			"no interactive UI",
		);
		expect(asked).toEqual([]);
		expect(cfgAdvisorEnabled.get(settings)).toBe(false);
	});

	it("applies a session change only after approval and leaves disk untouched", async () => {
		const settings = Settings.isolated();
		const persistent = Settings.isolated();
		const asked: CfgChangeRequest[] = [];
		const applied: CfgAppliedChange[] = [];
		let allow = false;
		setCfgApprovalHost({
			approve: async request => (asked.push(request), allow ? "once" : "deny"),
			applied: change => applied.push(change),
			persistentSettings: persistent,
		});

		const declined = await write("cfg://advisor/enabled", "true", settings);
		expect(declined.details?.cfg?.outcome).toBe("declined");
		expect(cfgAdvisorEnabled.get(settings)).toBe(false);
		expect(applied).toEqual([]);

		allow = true;
		const result = await write("cfg://advisor/enabled", "true", settings);
		expect(result.details?.cfg?.outcome).toBe("applied");
		expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain("cfg://advisor/enabled/save");
		// The host must learn about the change to start components (e.g. the advisor) that read it once.
		expect(applied).toEqual([{ path: "advisor.enabled", value: true, settings, save: false }]);
		expect(cfgAdvisorEnabled.get(settings)).toBe(true);
		expect(cfgAdvisorEnabled.isConfigured(persistent)).toBe(false);
		expect(asked).toEqual([
			{ path: "advisor.enabled", previous: "false", value: "true", save: false },
			{ path: "advisor.enabled", previous: "false", value: "true", save: false },
		]);
	});

	it("stops asking for the rest of the session once the user allows it always", async () => {
		const settings = Settings.isolated();
		const asked: CfgChangeRequest[] = [];
		setCfgApprovalHost({
			approve: async request => (asked.push(request), "session"),
			applied: () => {},
			persistentSettings: settings,
		});
		const inSession = (sessionId: string) => ({ getSessionId: () => sessionId });

		await write("cfg://advisor/enabled", "true", settings, inSession("a"));
		await write("cfg://advisor/syncBacklog", '"3"', settings, inSession("a"));
		expect(cfgAdvisorSyncBacklog.get(settings)).toBe("3");
		expect(asked.map(request => request.path)).toEqual(["advisor.enabled"]);

		// A session-change grant does not cover persisting to config.yml ...
		await write("cfg://advisor/syncBacklog/save", '"5"', settings, inSession("a"));
		// ... but the grant given on the save prompt covers later saves.
		await write("cfg://advisor/enabled/save", "false", settings, inSession("a"));
		expect(cfgAdvisorEnabled.get(settings)).toBe(false);
		// Nor does any grant carry over to another session.
		await write("cfg://advisor/syncBacklog", '"1"', settings, inSession("b"));
		expect(asked.map(request => [request.path, request.save])).toEqual([
			["advisor.enabled", false],
			["advisor.syncBacklog", true],
			["advisor.syncBacklog", false],
		]);
	});

	it("fails an unanswered write without changing anything and asks again next time", async () => {
		const settings = Settings.isolated();
		let answer: "timeout" | "once" = "timeout";
		setCfgApprovalHost({ approve: async () => answer, applied: () => {}, persistentSettings: settings });

		await expect(write("cfg://advisor/enabled", "true", settings)).rejects.toThrow();
		expect(cfgAdvisorEnabled.get(settings)).toBe(false);

		answer = "once";
		const retried = await write("cfg://advisor/enabled", "true", settings);
		expect(retried.details?.cfg?.outcome).toBe("applied");
	});

	it("refuses a session change an environment variable overrides without asking the user", async () => {
		const settings = Settings.isolated();
		const asked: CfgChangeRequest[] = [];
		setCfgApprovalHost({
			approve: async request => (asked.push(request), "once"),
			applied: () => {},
			persistentSettings: Settings.isolated(),
		});
		const previous = Bun.env.PI_EDIT_FUZZY;
		Bun.env.PI_EDIT_FUZZY = "1";
		try {
			await expect(write("cfg://edit/fuzzyMatch", "false", settings)).rejects.toThrow("PI_EDIT_FUZZY");
			expect(asked).toEqual([]);
			expect(cfgEditFuzzyMatch.provenance(settings)).toBe("env");
			expect(cfgEditFuzzyMatch.get(settings)).toBe(true);
		} finally {
			if (previous === undefined) delete Bun.env.PI_EDIT_FUZZY;
			else Bun.env.PI_EDIT_FUZZY = previous;
		}
	});

	it("asks normally for writes a fallback environment variable only defaults", async () => {
		const settings = Settings.isolated();
		const asked: CfgChangeRequest[] = [];
		setCfgApprovalHost({
			approve: async request => (asked.push(request), "once"),
			applied: () => {},
			persistentSettings: settings,
		});
		const previous = Bun.env.SEARXNG_ENDPOINT;
		Bun.env.SEARXNG_ENDPOINT = "http://env.example";
		try {
			const session = await write("cfg://searxng/endpoint", '"http://session.example"', settings);
			expect(session.details?.cfg).toMatchObject({ outcome: "applied" });
			expect(cfgSearxngEndpoint.get(settings)).toBe("http://session.example");

			await write("cfg://searxng/endpoint/save", '"http://saved.example"', settings);
			expect(cfgSearxngEndpoint.get(settings)).toBe("http://saved.example");
			expect(asked).toHaveLength(2);
			expect(asked.map(request => request.shadowedBy)).toEqual([undefined, undefined]);
		} finally {
			if (previous === undefined) delete Bun.env.SEARXNG_ENDPOINT;
			else Bun.env.SEARXNG_ENDPOINT = previous;
		}
	});

	it("reports a partial record write as applied, since layers deep-merge", async () => {
		const settings = Settings.isolated();
		cfgModelRoles.set(settings, { default: "anthropic/a" });
		setCfgApprovalHost({ approve: async () => "once", applied: () => {}, persistentSettings: settings });

		const session = await write("cfg://modelRoles", '{"smol":"anthropic/b"}', settings);
		expect(session.details?.cfg?.outcome).toBe("applied");
		expect(session.details?.cfg?.effective).toBeUndefined();
		expect(textOf(session)).toContain("cfg://modelRoles/save");

		const saved = await write("cfg://modelRoles/save", '{"smol":"anthropic/c"}', settings);
		expect(saved.details?.cfg?.effective).toBeUndefined();
		expect(textOf(saved)).not.toContain("Effective value is still");
		expect(cfgModelRoles.get(settings)).toMatchObject({ smol: "anthropic/c" });
	});

	it("reports a saved value a project layer still overrides", async () => {
		const settings = Settings.isolated();
		settings.setProjectModelRole("default", "anthropic/project");
		const asked: CfgChangeRequest[] = [];
		setCfgApprovalHost({
			approve: async request => (asked.push(request), "once"),
			applied: () => {},
			persistentSettings: settings,
		});

		const shadowed = await write("cfg://modelRoles/save", '{"default":"anthropic/global"}', settings);
		expect(asked[0]?.shadowedBy).toContain("project config");
		expect(shadowed.details?.cfg?.effective).toContain("anthropic/project");
		expect(textOf(shadowed)).toContain("project config takes precedence");

		// A key the project layer does not set applies despite the layer owning the record.
		const applied = await write("cfg://modelRoles/save", '{"smol":"anthropic/global"}', settings);
		expect(asked[1]?.shadowedBy).toBeUndefined();
		expect(applied.details?.cfg?.effective).toBeUndefined();

		// Replacing a key the global config supplies is not shadowed, though the project layer owns the record.
		await write("cfg://modelRoles/save", '{"smol":"anthropic/next"}', settings);
		expect(asked[2]?.shadowedBy).toBeUndefined();
		expect(cfgModelRoles.get(settings)).toMatchObject({ default: "anthropic/project", smol: "anthropic/next" });
	});

	it("reports a saved bash.patterns list as applied under project rules that prepend to it", async () => {
		const dir = TempDir.createSync("@omp-cfg-merged-list-");
		const originalCwd = process.cwd();
		const agentDir = path.join(dir.path(), "agent");
		const loadedSettings: Settings[] = [];
		try {
			const projectDir = path.join(dir.path(), "project");
			const resetDir = path.join(dir.path(), "reset");
			await Bun.write(
				path.join(projectDir, ".omp", "config.yml"),
				YAML.stringify({ bash: { patterns: [{ match: "make *", approval: "allow" }] } }),
			);
			await Bun.write(path.join(resetDir, ".omp", "config.yml"), YAML.stringify({ bash: { patterns: [] } }));
			const asked: CfgChangeRequest[] = [];
			const approveAll = (settings: Settings) =>
				setCfgApprovalHost({
					approve: async request => (asked.push(request), "once"),
					applied: () => {},
					persistentSettings: settings,
				});

			const settings = await Settings.loadIsolated({ cwd: projectDir, agentDir });
			loadedSettings.push(settings);
			approveAll(settings);
			const saved = await write("cfg://bash/patterns/save", '[{"match":"git *","approval":"allow"}]', settings);
			expect(asked[0]?.shadowedBy).toBeUndefined();
			expect(saved.details?.cfg?.effective).toBeUndefined();
			expect(textOf(saved)).not.toContain("Effective value is still");
			expect(cfgBashPatterns.get(settings)).toEqual([
				{ match: "make *", approval: "allow" },
				{ match: "git *", approval: "allow" },
			]);

			// A project `[]` resets the list, so the saved global rules do not take effect there.
			const reset = await Settings.loadIsolated({ cwd: resetDir, agentDir });
			loadedSettings.push(reset);
			approveAll(reset);
			const shadowed = await write("cfg://bash/patterns/save", '[{"match":"ls *","approval":"allow"}]', reset);
			expect(asked[1]?.shadowedBy).toContain("project config");
			expect(textOf(shadowed)).toContain("project config takes precedence");
			expect(cfgBashPatterns.get(reset)).toEqual([]);
		} finally {
			setCfgApprovalHost(null);
			for (const settings of loadedSettings) await settings.flush();
			AgentStorage.close(getAgentDbPath(agentDir));
			process.chdir(originalCwd);
			await dir.remove();
		}
	});

	it("persists /save writes to the host settings and mirrors them into a separate session instance", async () => {
		const settings = Settings.isolated();
		const persistent = Settings.isolated();
		const applied: Settings[] = [];
		setCfgApprovalHost({
			approve: async () => "once",
			applied: change => applied.push(change.settings),
			persistentSettings: persistent,
		});

		await write("cfg://advisor/syncBacklog/save", '"5"', settings);
		expect(cfgAdvisorSyncBacklog.get(persistent)).toBe("5");
		expect(cfgAdvisorSyncBacklog.provenance(persistent)).toBe("global");
		expect(cfgAdvisorSyncBacklog.get(settings)).toBe("5");
		expect(applied).toHaveLength(2);
		expect(applied[0]).toBe(persistent);
		expect(applied[1]).toBe(settings);
	});

	describe("Team member writes", () => {
		const first = "deepseek/Qwen3.8-27B";
		const second = "deepseek/Qwen3.8-35B";
		const initial = [first];
		const next = [second, first, second];
		let dir: TempDir;
		let originalCwd: string;
		let auth: AuthStorage;
		let agentDir: string;
		let projectDir: string;
		let configFile: string;

		beforeEach(async () => {
			originalCwd = process.cwd();
			dir = TempDir.createSync("@omp-cfg-team-");
			agentDir = dir.join("agent");
			projectDir = dir.join("project");
			configFile = path.join(agentDir, "config.yml");
			await Bun.write(configFile, YAML.stringify({ team: { members: initial } }));
			await Bun.write(
				path.join(agentDir, "models.yml"),
				YAML.stringify({
					providers: {
						deepseek: {
							baseUrl: "https://example.invalid/v1",
							api: "openai-completions",
							auth: "none",
							models: [
								{ id: "Qwen3.8-27B", name: "Qwen 3.8 27B", supportsTools: true },
								{ id: "Qwen3.8-35B", name: "Qwen 3.8 35B", supportsTools: true },
							],
						},
					},
				}),
			);
			auth = await AuthStorage.create(":memory:");
		});

		afterEach(async () => {
			auth?.close();
			AgentStorage.close(getAgentDbPath(agentDir));
			process.chdir(originalCwd);
			await dir.remove();
		});

		it("shares literal roster validation with /save and checks the session binding after approval", async () => {
			const settings = await Settings.loadIsolated({ cwd: projectDir, agentDir });
			const registry = new ModelRegistry(auth, path.join(agentDir, "models.yml"), { settings });
			const applied: CfgAppliedChange[] = [];
			let disposeOnApproval = false;
			let disposed = false;
			const caller = { modelRegistry: registry, isDisposed: () => disposed };
			setCfgApprovalHost({
				approve: async () => {
					disposed = disposeOnApproval;
					return "once";
				},
				applied: change => applied.push(change),
				persistentSettings: settings,
			});

			for (const [invalidValue, message] of [
				["[7]", "team.members must be an ordered string array"],
				[JSON.stringify([` ${first} `]), "Cannot resolve exact model selector"],
			]) {
				await expect(write("cfg://team/members", invalidValue, settings, caller)).rejects.toMatchObject({
					code: "invalid_params",
					message: expect.stringContaining(message),
				});
				const saved = await write("cfg://team/members/save", invalidValue, settings, caller);
				expect(saved.isError).toBe(true);
				expect(textOf(saved)).toContain("Not saved.");
				expect(textOf(saved)).toContain(message);
			}
			expect(applied).toEqual([]);
			expect(cfgTeamMembers.get(settings)).toEqual(initial);

			const session = await write("cfg://team/members", JSON.stringify(next), settings, caller);
			expect(session.details?.cfg?.outcome).toBe("applied");
			expect(textOf(session)).toContain("cfg://team/members/save");
			expect(cfgTeamMembers.get(settings)).toEqual(next);
			disposeOnApproval = true;
			await expect(write("cfg://team/members", "[]", settings, caller)).rejects.toMatchObject({
				code: "execution_failed",
			});
			expect(cfgTeamMembers.get(settings)).toEqual(next);

			disposeOnApproval = false;
			disposed = false;
			const cleared = await write("cfg://team/members", "[]", settings, caller);
			expect(cleared.details?.cfg?.outcome).toBe("applied");
			expect(cfgTeamMembers.get(settings)).toEqual([]);
			expect(applied).toEqual([
				{ path: "team.members", value: next, settings, save: false },
				{ path: "team.members", value: [], settings, save: false },
			]);
			expect(YAML.parse(await Bun.file(configFile).text())).toEqual({ team: { members: initial } });
		});

		it.each([false, true])("reports the live roster after saving (project null: %s)", async projectNull => {
			if (projectNull) await Bun.write(path.join(projectDir, ".omp", "config.yml"), "team: { members: null }\n");
			const persistent = await Settings.loadIsolated({ cwd: projectDir, agentDir });
			const settings = projectNull ? persistent : Settings.isolated();
			if (!projectNull) cfgTeamMembers.set(settings, initial);
			const registry = new ModelRegistry(auth, path.join(agentDir, "models.yml"), { settings });
			const asked: CfgChangeRequest[] = [];
			setCfgApprovalHost({
				approve: async request => (asked.push(request), "once"),
				applied: () => {},
				persistentSettings: persistent,
			});

			const saved = await write("cfg://team/members/save", JSON.stringify(next), settings, {
				modelRegistry: registry,
			});
			expect(saved.details?.cfg?.outcome).toBe("applied");
			expect(textOf(saved)).toContain("to the global config");
			expect(YAML.parse(await Bun.file(configFile).text())).toEqual({ team: { members: next } });
			if (projectNull) {
				expect(asked[0]?.shadowedBy).toContain("project config");
				expect(saved.details?.cfg?.effective).toBe("[]");
				expect(textOf(saved)).toContain("project config takes precedence");
				expect(cfgTeamMembers.get(settings)).toEqual([]);
			} else {
				expect(asked[0]?.shadowedBy).toBeUndefined();
				expect(textOf(saved)).toContain("The saved Team roster is not active in this session");
				expect(cfgTeamMembers.get(settings)).toEqual(initial);
				expect(cfgTeamMembers.get(persistent)).toEqual(next);
			}
		});
	});

	it("rejects namespace targets and values outside the schema before asking", async () => {
		const settings = Settings.isolated();
		const asked: CfgChangeRequest[] = [];
		setCfgApprovalHost({
			approve: async request => (asked.push(request), "once"),
			applied: () => {},
			persistentSettings: settings,
		});

		await expect(write("cfg://advisor", "true", settings)).rejects.toThrow("is a namespace");
		await expect(write("cfg://advisor/syncBacklog", "7", settings)).rejects.toThrow("Valid values: off, 1, 3, 5");
		await expect(write("cfg://advisr/enabled", "true", settings)).rejects.toThrow("Similar: advisor.enabled");
		expect(asked).toEqual([]);
	});
});
