import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { type Component } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";
import { parseDocument } from "yaml";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import type { InteractiveModeContext } from "../../src/modes/types";
import { AgentStorage } from "../../src/session/agent-storage";
import { TeamConfigService } from "../../src/team/config";
import { showTeamConfig } from "../../src/team/config-ui";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

// Exercise the public overlay consumer with real catalog, YAML, preview and CAS.
// The terminal host is captured, not the panel's draft or private implementation.
const originalGetConfig = TeamConfigService.prototype.getConfig;
describe("Team configuration editor", () => {
	let state: SettingsTestState;
	let temporary: TempDir;
	let auth: AuthStorage;
	let settings: Settings;
	let registry: ModelRegistry;
	let ctx: InteractiveModeContext;
	let panel: Component & { handleInput(data: string): void };
	let picker: Parameters<InteractiveModeContext["showModelSelector"]>[0];
	let hidden: boolean;
	let file: string;
	let reads: Mock<TeamConfigService["getConfig"]>;
	let saves: Mock<TeamConfigService["setConfig"]>;
	const first = { provider: "deepseek", modelId: "team-a" };
	const second = { provider: "deepseek", modelId: "team-b" };

	beforeEach(async () => {
		state = beginSettingsTest();
		temporary = TempDir.createSync("omp-team-panel-");
		const agentDir = temporary.join("agent");
		const cwd = temporary.join("project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(cwd, { recursive: true });
		file = path.join(agentDir, "config.yml");
		await Bun.write(
			file,
			"# preserve comment\nother: preserve\nteam:\n  members: [deepseek/team-a, deepseek/team-b, deepseek/team-a]\n",
		);
		await Bun.write(
			path.join(agentDir, "models.yml"),
			`providers:
  deepseek:
    baseUrl: https://example.invalid/v1
    api: openai-completions
    auth: none
    models:
      - id: team-a
        name: Team A
        supportsTools: true
      - id: team-b
        name: Team B
        supportsTools: true
`,
		);
		settings = await Settings.loadIsolated({ agentDir, cwd });
		auth = await AuthStorage.create(":memory:");
		registry = new ModelRegistry(auth, path.join(agentDir, "models.yml"), { settings });
		hidden = false;
		picker = undefined;
		ctx = {
			session: {
				modelRegistry: registry,
				get model() {
					throw new Error("Global Team editor must not consume a chat model");
				},
			},
			settings,
			sessionManager: { getSessionId: () => "editor-session" },
			ui: {
				terminal: { rows: 200 },
				showOverlay: (component: Component) => {
					panel = component as typeof panel;
					return {
						hide: () => {
							hidden = true;
						},
						setHidden: () => {},
					};
				},
				setFocus: () => {},
				requestRender: () => {},
			},
			showModelSelector: (options: typeof picker) => {
				picker = options;
			},
		} as unknown as InteractiveModeContext;
		reads = vi.spyOn(TeamConfigService.prototype, "getConfig");
		saves = vi.spyOn(TeamConfigService.prototype, "setConfig");
	});

	afterEach(() => {
		if (panel && !hidden) {
			panel.handleInput("\x1b");
			panel.handleInput("y");
		}
		vi.restoreAllMocks();
		auth?.close();
		restoreSettingsTestState(state);
		AgentStorage.close();
		temporary.removeSync();
	});

	async function flush(): Promise<void> {
		let count: number;
		do {
			count = reads.mock.calls.length + saves.mock.calls.length;
			await Promise.all([...reads.mock.results, ...saves.mock.results].map(result => result.value).filter(Boolean));
			await Promise.resolve();
		} while (count !== reads.mock.calls.length + saves.mock.calls.length);
	}
	async function open() {
		showTeamConfig(ctx);
		await flush();
	}
	const screen = () => panel.render(120).join("\n");
	const members = async () => parseDocument(await Bun.file(file).text()).toJS().team.members;

	it("hides advanced storage and run details by default and never presents a chat main model", async () => {
		await open();
		const rendered = screen();
		expect(rendered).toContain("有序草稿");
		expect(rendered).toContain("deepseek/team-a");
		expect(rendered).not.toContain("用户原值");
		expect(rendered).not.toContain("实际运行槽位");
		expect(rendered).not.toContain("拟保存用户名单");
		expect(rendered).not.toContain("主模型（对齐/综合）");
	});

	it("toggles advanced read-only details with v and V without saving or exposing a chat model", async () => {
		await open();
		const before = await Bun.file(file).text();
		panel.handleInput("v");
		const expanded = screen();
		for (const detail of ["用户原值", "当前有效名单", "实际运行槽位", "拟保存用户名单", "预计运行槽位"]) {
			expect(expanded).toContain(detail);
		}
		expect(expanded).not.toContain("主模型（对齐/综合）");
		panel.handleInput("V");
		expect(screen()).not.toContain("用户原值");
		expect(screen()).not.toContain("拟保存用户名单");
		expect(saves).not.toHaveBeenCalled();
		expect(await Bun.file(file).text()).toBe(before);
	});

	it("keeps long rosters keyboard-scrollable in a narrow terminal without writing settings", async () => {
		await Bun.write(file, `team:\n  members: [${Array.from({ length: 53 }, () => "deepseek/team-a").join(", ")}]\n`);
		await open();
		Object.defineProperty(ctx.ui.terminal, "rows", { value: 12 });
		const initial = panel.render(28);
		for (let index = 0; index < 40; index++) panel.handleInput("\x1b[B");
		const selected = panel.render(28);
		expect(selected.length).toBeLessThanOrEqual(12);
		expect(selected).not.toEqual(initial);
		expect(selected.join("\n")).toContain("41.");
		expect(saves).not.toHaveBeenCalled();
		expect(await members()).toHaveLength(53);
	});

	it("keeps ordered duplicates local until one complete save and preserves unrelated YAML", async () => {
		await open();
		const before = await Bun.file(file).text();
		panel.handleInput("c"); // A A B A; selected duplicate is slot 2.
		panel.handleInput("j"); // A B A A
		panel.handleInput("d"); // A B A
		panel.handleInput("u"); // A A B
		await flush();
		expect(await Bun.file(file).text()).toBe(before);
		expect(saves).not.toHaveBeenCalled();
		panel.handleInput("s");
		await flush();
		expect(saves).toHaveBeenCalledTimes(1);
		expect(saves.mock.calls[0]![0].members).toEqual([first, first, second]);
		expect(await members()).toEqual(["deepseek/team-a", "deepseek/team-a", "deepseek/team-b"]);
		expect(await Bun.file(file).text()).toContain("# preserve comment");
		expect(parseDocument(await Bun.file(file).text()).toJS().other).toBe("preserve");
	});

	it("uses the full Team candidate pool in selectOnly mode and replaces without switching a chat model", async () => {
		await open();
		const before = await Bun.file(file).text();
		panel.handleInput("e");
		if (!picker?.selectOnly) throw new Error("Expected native selectOnly model picker");
		expect(
			picker.selectOnly
				.getCandidates?.("")
				.map(model => model.id)
				.filter(id => id.startsWith("team-")),
		).toEqual(["team-a", "team-b"]);
		picker.selectOnly.onSelect("deepseek/team-b");
		await flush();
		expect(await Bun.file(file).text()).toBe(before);
		panel.handleInput("s");
		await flush();
		expect(await members()).toEqual(["deepseek/team-b", "deepseek/team-b", "deepseek/team-a"]);
	});

	it("requires explicit discard or staying in the panel and never saves cancellation or reset", async () => {
		await open();
		const before = await Bun.file(file).text();
		panel.handleInput("0");
		await flush();
		panel.handleInput("\x1b");
		expect(hidden).toBe(false);
		expect(screen()).toContain("放弃草稿");
		panel.handleInput("n");
		expect(hidden).toBe(false);
		panel.handleInput("\x1b");
		panel.handleInput("y");
		expect(hidden).toBe(true);
		expect(saves).not.toHaveBeenCalled();
		expect(await Bun.file(file).text()).toBe(before);
	});

	it("saves an explicit empty roster only after confirmation", async () => {
		await open();
		panel.handleInput("0");
		await flush();
		expect(saves).not.toHaveBeenCalled();
		panel.handleInput("s");
		await flush();
		expect(await members()).toEqual([]);
		expect(saves.mock.calls[0]![0].members).toEqual([]);
	});

	it("retains an unresolved selector at its position and blocks saving until it is repaired", async () => {
		await Bun.write(file, "team:\n  members: [deepseek/team-a, retired/raw, deepseek/team-a]\n");
		await open();
		expect(screen()).toContain("2. retired/raw");
		panel.handleInput("s");
		await flush();
		expect(saves).not.toHaveBeenCalled();
		panel.handleInput("\x1b[B");
		panel.handleInput("d");
		await flush();
		panel.handleInput("s");
		await flush();
		expect(await members()).toEqual(["deepseek/team-a", "deepseek/team-a"]);
	});

	it("preserves a dirty draft across external updates and requires reread before retrying the save", async () => {
		await open();
		panel.handleInput("c");
		await flush();
		const external = new TeamConfigService({ getSettings: () => settings, getModelRegistry: () => registry });
		const current = await external.getConfig();
		await external.setConfig({ scope: "user", expectedRevision: current.revision!, members: [second] });
		await flush();
		const calls = saves.mock.calls.length;
		panel.handleInput("s");
		await flush();
		expect(saves).toHaveBeenCalledTimes(calls);
		expect(await members()).toEqual(["deepseek/team-b"]);
		panel.handleInput("r");
		await flush();
		panel.handleInput("s");
		await flush();
		expect(await members()).toEqual(["deepseek/team-a", "deepseek/team-a", "deepseek/team-b", "deepseek/team-a"]);
	});

	it("handles a context-invalidated in-flight read without saving into its replacement", async () => {
		const release = Promise.withResolvers<void>();
		reads.mockImplementationOnce(async function (this: TeamConfigService, preview) {
			const result = await originalGetConfig.call(this, preview);
			await release.promise;
			return result;
		});
		showTeamConfig(ctx);
		const pendingRead = reads.mock.results[0];
		if (pendingRead?.type !== "return") throw new Error("Opening the panel must start an asynchronous read");
		const rejectedRead = pendingRead.value.then(
			() => {
				throw new Error("A context-invalidated read must reject");
			},
			(error: unknown) => error,
		);
		ctx.settings = Settings.isolated();
		release.resolve();
		expect(await rejectedRead).toMatchObject({ code: "execution_failed" });
		await Promise.resolve();
		expect(panel.render(120)).toEqual([]);
		expect(hidden).toBe(true);
		panel.handleInput("s");
		expect(saves).not.toHaveBeenCalled();
	});

	it("discards a successful but late snapshot after its configuration context is replaced", async () => {
		const loaded = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		reads.mockImplementationOnce(async function (this: TeamConfigService, preview) {
			const result = await originalGetConfig.call(this, preview);
			loaded.resolve();
			await release.promise;
			return result;
		});
		showTeamConfig(ctx);
		const pendingRead = reads.mock.results[0];
		try {
			if (pendingRead?.type !== "return") throw new Error("Opening the panel must start an asynchronous read");
			await Promise.race([
				loaded.promise,
				pendingRead.value.then(() => {
					throw new Error("The intercepted read settled without reaching the loaded snapshot barrier");
				}),
			]);
			ctx.settings = Settings.isolated();
		} finally {
			release.resolve();
			await flush();
		}
		expect(panel.render(120)).toEqual([]);
		expect(hidden).toBe(true);
		panel.handleInput("s");
		expect(saves).not.toHaveBeenCalled();
	});
});
