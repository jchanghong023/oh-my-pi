import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { signal } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";
import { parseDocument } from "yaml";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import type { InteractiveModeContext } from "../../src/modes/types";
import { AgentStorage } from "../../src/session/agent-storage";
import { TeamConfigService } from "../../src/team/config";
import { showTeamConfig } from "../../src/team/config-ui";
import { initTheme } from "../../src/ui/theme/service";
import { createModeTerminal, type ModeTerminal, pressKey } from "../helpers/mode-terminal";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

// Exercise the public overlay consumer with real catalog, YAML, preview and CAS.
// Drive the real Shell overlay; only the model picker callback is captured.
const originalGetConfig = TeamConfigService.prototype.getConfig;
describe("Team configuration editor", () => {
	let state: SettingsTestState;
	let temporary: TempDir;
	let auth: AuthStorage;
	let settings: Settings;
	let registry: ModelRegistry;
	let ctx: InteractiveModeContext;
	let terminal: ModeTerminal;
	let picker: Parameters<InteractiveModeContext["showModelSelector"]>[0];
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
		initTheme();
		terminal = createModeTerminal({ columns: 120, rows: 40 });
		await terminal.start();
		picker = undefined;
		const liveSettings = signal(settings);
		ctx = {
			session: {
				modelRegistry: registry,
				get model() {
					throw new Error("Global Team editor must not consume a chat model");
				},
				registerSessionChangeCallback: () => () => {},
			},
			get settings() {
				return liveSettings();
			},
			set settings(value: Settings) {
				liveSettings.set(value);
			},
			sessionManager: { getSessionId: () => "editor-session" },
			shell: terminal.frame.shell,
			showModelSelector: (options: typeof picker) => {
				picker = options;
			},
		} as unknown as InteractiveModeContext;
		reads = vi.spyOn(TeamConfigService.prototype, "getConfig");
		saves = vi.spyOn(TeamConfigService.prototype, "setConfig");
	});

	afterEach(async () => {
		terminal?.frame.shell.overlays.closeAll();
		await terminal?.frame.shell.stop();
		terminal?.dispose();
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
		await terminal.settle();
	}
	const press = (key: string) => pressKey(ctx.shell, key);
	const screen = async () => {
		await terminal.settle();
		return terminal.screen().join("\n");
	};
	const members = async () => parseDocument(await Bun.file(file).text()).toJS().team.members;

	it("starts with advanced details collapsed and toggles them with v and V without saving", async () => {
		const before = await Bun.file(file).text();
		await open();
		const rendered = await screen();
		expect(rendered).toContain("有序草稿");
		expect(rendered).toContain("deepseek/team-a");
		expect(rendered).not.toContain("用户原值");
		expect(rendered).not.toContain("实际运行槽位");
		expect(rendered).not.toContain("拟保存用户名单");
		expect(rendered).not.toContain("主模型（对齐/综合）");
		press("v");
		const expanded = await screen();
		for (const detail of ["用户原值", "当前有效名单", "实际运行槽位", "拟保存用户名单", "预计运行槽位"]) {
			expect(expanded).toContain(detail);
		}
		expect(expanded).not.toContain("主模型（对齐/综合）");
		press("shift+v");
		const collapsed = await screen();
		expect(collapsed).not.toContain("用户原值");
		expect(collapsed).not.toContain("拟保存用户名单");
		expect(saves).not.toHaveBeenCalled();
		expect(await Bun.file(file).text()).toBe(before);
	});

	it("keeps long rosters keyboard-scrollable in a narrow terminal without writing settings", async () => {
		await Bun.write(file, `team:\n  members: [${Array.from({ length: 53 }, () => "deepseek/team-a").join(", ")}]\n`);
		await open();
		terminal.resize(28, 12);
		await terminal.settle();
		const initial = terminal.screen();
		for (let index = 0; index < 40; index++) press("down");
		await terminal.settle();
		const selected = terminal.screen();
		expect(selected.length).toBeLessThanOrEqual(12);
		expect(selected).not.toEqual(initial);
		expect(selected.join("\n")).toContain("41.");
		expect(saves).not.toHaveBeenCalled();
		expect(await members()).toHaveLength(53);
	});

	it("keeps ordered duplicates local until one complete save and preserves unrelated YAML", async () => {
		await open();
		const before = await Bun.file(file).text();
		press("c"); // A A B A; selected duplicate is slot 2.
		press("j"); // A B A A
		press("d"); // A B A
		press("u"); // A A B
		await flush();
		expect(await Bun.file(file).text()).toBe(before);
		expect(saves).not.toHaveBeenCalled();
		press("s");
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
		press("e");
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
		press("s");
		await flush();
		expect(await members()).toEqual(["deepseek/team-b", "deepseek/team-b", "deepseek/team-a"]);
	});

	it("requires explicit discard or staying in the panel and never saves cancellation or reset", async () => {
		await open();
		const before = await Bun.file(file).text();
		press("0");
		await flush();
		press("escape");
		expect(ctx.shell.overlays.open()).toBe(true);
		expect(await screen()).toContain("放弃草稿");
		press("n");
		expect(ctx.shell.overlays.open()).toBe(true);
		press("escape");
		press("y");
		expect(ctx.shell.overlays.open()).toBe(false);
		expect(saves).not.toHaveBeenCalled();
		expect(await Bun.file(file).text()).toBe(before);
	});

	it("saves an explicit empty roster only after confirmation", async () => {
		await open();
		press("0");
		await flush();
		expect(saves).not.toHaveBeenCalled();
		press("s");
		await flush();
		expect(await members()).toEqual([]);
		expect(saves.mock.calls[0]![0].members).toEqual([]);
	});

	it("retains an unresolved selector at its position and blocks saving until it is repaired", async () => {
		await Bun.write(file, "team:\n  members: [deepseek/team-a, retired/raw, deepseek/team-a]\n");
		await open();
		expect(await screen()).toContain("2. retired/raw");
		press("s");
		await flush();
		expect(saves).not.toHaveBeenCalled();
		press("down");
		press("d");
		await flush();
		press("s");
		await flush();
		expect(await members()).toEqual(["deepseek/team-a", "deepseek/team-a"]);
	});

	it("preserves a dirty draft across external updates and requires reread before retrying the save", async () => {
		await open();
		press("c");
		await flush();
		const external = new TeamConfigService({ getSettings: () => settings, getModelRegistry: () => registry });
		const current = await external.getConfig();
		await external.setConfig({ scope: "user", expectedRevision: current.revision!, members: [second] });
		await flush();
		const calls = saves.mock.calls.length;
		press("s");
		await flush();
		expect(saves).toHaveBeenCalledTimes(calls);
		expect(await members()).toEqual(["deepseek/team-b"]);
		press("r");
		await flush();
		press("s");
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
		expect(await screen()).not.toContain("Team 配置");
		press("s");
		expect(ctx.shell.overlays.open()).toBe(false);
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
		expect(await screen()).not.toContain("Team 配置");
		press("s");
		expect(ctx.shell.overlays.open()).toBe(false);
		expect(saves).not.toHaveBeenCalled();
	});
});
