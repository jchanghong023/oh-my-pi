/**
 * Regression guard for issue #3827.
 *
 * `/mcp list` and the `/extensions` dashboard MUST agree on whether a given MCP
 * server is enabled or disabled. The two read paths historically diverged: the
 * dashboard's `loadAllExtensions` only consulted the dashboard-private
 * `disabledExtensions` settings array, while `/mcp list` (and the MCP runtime
 * itself) honored both the per-server `enabled` flag in `mcp.json` and the
 * user-level `disabledServers` denylist.
 *
 * The fixtures below cover both inputs and the round-trip helper the
 * dashboard's MCP toggle uses.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getManagedSkillsDir } from "@oh-my-pi/pi-coding-agent/autolearn/managed-skills";
import type { Skill as CapabilitySkill } from "@oh-my-pi/pi-coding-agent/capability/skill";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	disableProvider,
	enableProvider,
	enableUserSource,
	initializeWithSettings,
	loadCapability,
	reset as resetDiscoveryCache,
} from "@oh-my-pi/pi-coding-agent/discovery";
import {
	cfgSkills,
	cfgSkillsCustomDirectories,
	cfgSkillsEnableClaudeProject,
	cfgSkillsEnableClaudeUser,
	cfgSkillsEnabled,
	cfgSkillsIgnoredSkills,
	cfgSkillsIncludeSkills,
} from "@oh-my-pi/pi-coding-agent/extensibility/settings";
import { loadSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { readMCPConfigFile, setMcpServerEnabled, setServerDisabled } from "@oh-my-pi/pi-coding-agent/mcp/config-writer";
import { createExtensionDashboardRuntime } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/dashboard-runtime";
import { loadAllExtensions } from "@oh-my-pi/pi-coding-agent/modes/components/extensions/state-manager";
import { __resetDirsFromEnvForTests, getMCPConfigPath, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import type { ExtensionDashboardRuntime } from "@oh-my-pi/pi-tui/overlays/extensions/extension-dashboard";
import {
	applyDisabledExtensionsToState,
	createInitialState,
	refreshState,
} from "@oh-my-pi/pi-tui/overlays/extensions/state-manager";
import { isShadowedExtension } from "@oh-my-pi/pi-tui/overlays/extensions/types";
import { restoreEnvValue } from "./helpers/settings-test-state";

describe("loadAllExtensions MCP parity with /mcp list (issue #3827)", () => {
	let projectDir = "";
	let userAgentDir = "";

	beforeEach(async () => {
		resetSettingsForTest();
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-3827-project-"));
		userAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-3827-user-"));

		// Redirect user-scoped mcp.json (resolved via getAgentDir() at the call
		// site) into the per-test temp directory so neither the discovery loader
		// nor the denylist reader touches the real user profile.
		setAgentDir(userAgentDir);

		await fs.mkdir(path.join(projectDir, ".omp"), { recursive: true });
		await fs.writeFile(
			path.join(projectDir, ".omp", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					"denylisted-server": { command: "echo", args: ["denylisted"] },
					"flag-disabled-server": { command: "echo", args: ["flag"], enabled: false },
					"active-server": { command: "echo", args: ["active"] },
				},
			}),
		);

		// User-level mcp.json carries the denylist; this is what `/mcp disable`
		// writes through setServerDisabled().
		await fs.writeFile(
			path.join(userAgentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {},
				disabledServers: ["denylisted-server"],
			}),
		);

		const settings = await Settings.init({ inMemory: true, cwd: projectDir });
		initializeWithSettings(settings);
	});

	afterEach(async () => {
		resetSettingsForTest();
		__resetDirsFromEnvForTests();
		await removeWithRetries(projectDir);
		await removeWithRetries(userAgentDir);
	});

	test("treats a server in user-level disabledServers as disabled (matches /mcp list)", async () => {
		const extensions = await loadAllExtensions(projectDir, []);
		const denylisted = extensions.find(e => e.id === "mcp:denylisted-server");
		expect(denylisted).toBeDefined();
		expect(denylisted!.state).toBe("disabled");
		expect(denylisted!.disabledReason).toBe("item-disabled");
	});

	test("treats a server with enabled:false as disabled (matches /mcp list)", async () => {
		const extensions = await loadAllExtensions(projectDir, []);
		const flagDisabled = extensions.find(e => e.id === "mcp:flag-disabled-server");
		expect(flagDisabled).toBeDefined();
		expect(flagDisabled!.state).toBe("disabled");
		expect(flagDisabled!.disabledReason).toBe("item-disabled");
	});

	test("leaves untouched servers active", async () => {
		const extensions = await loadAllExtensions(projectDir, []);
		const active = extensions.find(e => e.id === "mcp:active-server");
		expect(active).toBeDefined();
		expect(active!.state).toBe("active");
		expect(active!.disabledReason).toBeUndefined();
	});

	test("setServerDisabled round-trips through the dashboard view", async () => {
		// Re-enable `denylisted-server` through the canonical writer the
		// dashboard's MCP toggle now calls. The dashboard view MUST flip to
		// active on the next load.
		await setServerDisabled(getMCPConfigPath("user", projectDir), "denylisted-server", false);
		const reenabled = (await loadAllExtensions(projectDir, [])).find(e => e.id === "mcp:denylisted-server");
		expect(reenabled).toBeDefined();
		expect(reenabled!.state).toBe("active");

		// The inverse path: disabling `active-server` via the writer flips the
		// dashboard view to disabled.
		await setServerDisabled(getMCPConfigPath("user", projectDir), "active-server", true);
		const disabled = (await loadAllExtensions(projectDir, [])).find(e => e.id === "mcp:active-server");
		expect(disabled).toBeDefined();
		expect(disabled!.state).toBe("disabled");
		expect(disabled!.disabledReason).toBe("item-disabled");
	});

	test("dashboard re-enable flips enabled:false in mcp.json (PR #3829 review)", async () => {
		// The bug: when a server has `enabled: false` in mcp.json, the dashboard
		// toggle previously only removed it from the user-level denylist, so
		// state-manager's `server.enabled === false` check kept it disabled.
		// setMcpServerEnabled MUST overwrite the per-server flag.
		const projectMcpPath = path.join(projectDir, ".omp", "mcp.json");

		await setMcpServerEnabled({
			userPath: getMCPConfigPath("user", projectDir),
			projectPath: getMCPConfigPath("project", projectDir),
			name: "flag-disabled-server",
			enabled: true,
		});

		const projectConfig = await readMCPConfigFile(projectMcpPath);
		expect(projectConfig.mcpServers?.["flag-disabled-server"]?.enabled).toBe(true);

		const reenabled = (await loadAllExtensions(projectDir, [])).find(e => e.id === "mcp:flag-disabled-server");
		expect(reenabled).toBeDefined();
		expect(reenabled!.state).toBe("active");
	});

	test("dashboard re-enable also clears a stale denylist entry on a config-resident server", async () => {
		// Manually disable `active-server` via BOTH the per-server flag and the
		// denylist, simulating a server that's been toggled off multiple ways.
		const projectMcpPath = path.join(projectDir, ".omp", "mcp.json");
		const initial = await readMCPConfigFile(projectMcpPath);
		await Bun.write(
			projectMcpPath,
			JSON.stringify({
				...initial,
				mcpServers: {
					...initial.mcpServers,
					"active-server": { ...initial.mcpServers!["active-server"], enabled: false },
				},
			}),
		);
		await setServerDisabled(getMCPConfigPath("user", projectDir), "active-server", true);

		await setMcpServerEnabled({
			userPath: getMCPConfigPath("user", projectDir),
			projectPath: getMCPConfigPath("project", projectDir),
			name: "active-server",
			enabled: true,
		});

		const userConfig = await readMCPConfigFile(getMCPConfigPath("user", projectDir));
		expect(userConfig.disabledServers ?? []).not.toContain("active-server");

		const reenabled = (await loadAllExtensions(projectDir, [])).find(e => e.id === "mcp:active-server");
		expect(reenabled).toBeDefined();
		expect(reenabled!.state).toBe("active");
	});

	test("dashboard disable on a config-resident server writes enabled:false (not denylist)", async () => {
		await setMcpServerEnabled({
			userPath: getMCPConfigPath("user", projectDir),
			projectPath: getMCPConfigPath("project", projectDir),
			name: "active-server",
			enabled: false,
		});

		const projectConfig = await readMCPConfigFile(path.join(projectDir, ".omp", "mcp.json"));
		expect(projectConfig.mcpServers?.["active-server"]?.enabled).toBe(false);

		// The denylist is reserved for discovered (config-less) servers; a
		// config-resident server's `enabled: false` flag is the canonical signal.
		const userConfig = await readMCPConfigFile(getMCPConfigPath("user", projectDir));
		expect(userConfig.disabledServers ?? []).not.toContain("active-server");

		const disabled = (await loadAllExtensions(projectDir, [])).find(e => e.id === "mcp:active-server");
		expect(disabled).toBeDefined();
		expect(disabled!.state).toBe("disabled");
	});

	test("dashboard re-enable updates the row's non-primary source mcp.json before denylisting", async () => {
		const alternatePath = path.join(projectDir, ".omp", ".mcp.json");
		await Bun.write(
			alternatePath,
			JSON.stringify({
				mcpServers: {
					"alternate-server": { command: "echo", args: ["alternate"], enabled: false },
				},
			}),
		);

		const disabled = (await loadAllExtensions(projectDir, [])).find(e => e.id === "mcp:alternate-server");
		expect(disabled).toBeDefined();
		expect(disabled!.state).toBe("disabled");

		await setMcpServerEnabled({
			userPath: getMCPConfigPath("user", projectDir),
			projectPath: getMCPConfigPath("project", projectDir),
			sourcePath: alternatePath,
			name: "alternate-server",
			enabled: true,
		});

		const alternateConfig = await readMCPConfigFile(alternatePath);
		expect(alternateConfig.mcpServers?.["alternate-server"]?.enabled).toBe(true);

		const userConfig = await readMCPConfigFile(getMCPConfigPath("user", projectDir));
		expect(userConfig.disabledServers ?? []).not.toContain("alternate-server");

		const reenabled = (await loadAllExtensions(projectDir, [])).find(e => e.id === "mcp:alternate-server");
		expect(reenabled).toBeDefined();
		expect(reenabled!.state).toBe("active");
	});
	test("dashboard re-enable force-enables a tool-owned source (opencode.json) via enabledServers", async () => {
		// OpenCode is a non-writable source: the dashboard must NOT mutate
		// opencode.json, but the user-level enabledServers allowlist still has
		// to flip the row active. Modeled after the codex review on PR #3829.
		const opencodePath = path.join(projectDir, "opencode.json");
		await Bun.write(
			opencodePath,
			JSON.stringify({
				mcp: {
					"opencode-server": {
						type: "local",
						command: ["echo", "opencode"],
						enabled: false,
					},
				},
			}),
		);
		// beforeEach's Settings.init() already cached an absent opencode.json
		// for this projectDir, so drop the capability fs cache before the first
		// dashboard load picks the file up.
		resetDiscoveryCache();

		const before = (await loadAllExtensions(projectDir, [])).find(e => e.id === "mcp:opencode-server");
		expect(before).toBeDefined();
		expect(before!.source.provider).toBe("opencode");
		expect(before!.state).toBe("disabled");

		// The dashboard withholds sourcePath for tool-owned sources, mirroring
		// the #writableMcpSourcePath gate.
		await setMcpServerEnabled({
			userPath: getMCPConfigPath("user", projectDir),
			projectPath: getMCPConfigPath("project", projectDir),
			name: "opencode-server",
			enabled: true,
		});

		// opencode.json MUST stay untouched.
		const opencodeRaw = JSON.parse(await Bun.file(opencodePath).text()) as {
			mcp: { "opencode-server": { enabled: boolean } };
		};
		expect(opencodeRaw.mcp["opencode-server"].enabled).toBe(false);

		// The override lands in the user mcp.json's enabledServers list.
		const userConfig = await readMCPConfigFile(getMCPConfigPath("user", projectDir));
		expect(userConfig.enabledServers ?? []).toContain("opencode-server");

		const after = (await loadAllExtensions(projectDir, [])).find(e => e.id === "mcp:opencode-server");
		expect(after).toBeDefined();
		expect(after!.state).toBe("active");

		// Disabling again clears the override.
		await setMcpServerEnabled({
			userPath: getMCPConfigPath("user", projectDir),
			projectPath: getMCPConfigPath("project", projectDir),
			name: "opencode-server",
			enabled: false,
		});

		const userConfigAfter = await readMCPConfigFile(getMCPConfigPath("user", projectDir));
		expect(userConfigAfter.enabledServers ?? []).not.toContain("opencode-server");
		expect(userConfigAfter.disabledServers ?? []).toContain("opencode-server");

		const offAgain = (await loadAllExtensions(projectDir, [])).find(e => e.id === "mcp:opencode-server");
		expect(offAgain).toBeDefined();
		expect(offAgain!.state).toBe("disabled");
	});

	test("dashboard toggles on a discovered (config-less) server use the denylist", async () => {
		// `phantom-server` is not in any config; only the denylist can suppress it.
		await setMcpServerEnabled({
			userPath: getMCPConfigPath("user", projectDir),
			projectPath: getMCPConfigPath("project", projectDir),
			name: "phantom-server",
			enabled: false,
		});

		let userConfig = await readMCPConfigFile(getMCPConfigPath("user", projectDir));
		expect(userConfig.disabledServers ?? []).toContain("phantom-server");

		await setMcpServerEnabled({
			userPath: getMCPConfigPath("user", projectDir),
			projectPath: getMCPConfigPath("project", projectDir),
			name: "phantom-server",
			enabled: true,
		});

		userConfig = await readMCPConfigFile(getMCPConfigPath("user", projectDir));
		expect(userConfig.disabledServers ?? []).not.toContain("phantom-server");
	});
});

describe("shared skill runtime/dashboard parity", () => {
	let root = "";
	let projectDir = "";
	let sharedDir = "";
	let settings: Settings;
	let runtime: ExtensionDashboardRuntime;
	let restoreDiscovery: () => void;
	let restoreHome: () => void;
	let previousSharedDir: string | undefined;
	let previousClaudeConfigDir: string | undefined;

	const writeSkill = async (directory: string, description: string, name = "panel-shared") => {
		const skillDir = path.join(directory, name);
		await fs.mkdir(skillDir, { recursive: true });
		const filePath = path.join(skillDir, "SKILL.md");
		await fs.writeFile(filePath, `---\nname: ${name}\ndescription: ${description}\n---\n${description}\n`);
		return filePath;
	};

	beforeEach(async () => {
		resetSettingsForTest();
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-shared-dashboard-")));
		projectDir = path.join(root, "project");
		sharedDir = path.join(root, "shared");
		await fs.mkdir(projectDir, { recursive: true });
		const homeSpy = spyOn(os, "homedir").mockReturnValue(root);
		restoreHome = () => homeSpy.mockRestore();
		setAgentDir(path.join(root, "personal"));
		previousSharedDir = process.env.OMP_SKILLS_DIR;
		restoreEnvValue("OMP_SKILLS_DIR", sharedDir);
		previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
		restoreEnvValue("CLAUDE_CONFIG_DIR", undefined);
		await writeSkill(sharedDir, "Shared version");
		await writeSkill(path.join(root, "personal", "skills"), "Personal version");
		await writeSkill(path.join(projectDir, "configured"), "Configured version");
		settings = await Settings.init({
			inMemory: true,
			cwd: projectDir,
			overrides: {
				"skills.customDirectories": [path.join(projectDir, "configured")],
			},
		});
		restoreDiscovery = initializeWithSettings(settings);
		runtime = createExtensionDashboardRuntime({ cwd: projectDir, settings });
	});

	afterEach(async () => {
		restoreDiscovery();
		restoreEnvValue("OMP_SKILLS_DIR", previousSharedDir);
		restoreEnvValue("CLAUDE_CONFIG_DIR", previousClaudeConfigDir);
		restoreHome();
		resetSettingsForTest();
		resetDiscoveryCache();
		__resetDirsFromEnvForTests();
		await removeWithRetries(root);
	});

	const loadAndCompare = async () => {
		const rows = (await runtime.loadExtensions(runtime.getDisabledExtensions())).filter(row => row.kind === "skill");
		const loaded = await loadSkills({
			...cfgSkills.get(settings),
			cwd: projectDir,
			disabledExtensions: runtime.getDisabledExtensions(),
		});
		expect(
			rows
				.filter(row => row.state === "active")
				.map(row => ({
					name: row.name,
					filePath: row.path,
					source: `${row.source.provider}:${row.source.level}`,
				}))
				.sort((a, b) => a.name.localeCompare(b.name)),
		).toEqual(
			loaded.skills
				.map(({ name, filePath, source }) => ({ name, filePath, source }))
				.sort((a, b) => a.name.localeCompare(b.name)),
		);
		for (const skill of loaded.skills) {
			const row = rows.find(candidate => candidate.name === skill.name)!;
			expect(row.source).toEqual({
				provider: skill._source!.provider,
				providerName: skill._source!.providerName,
				level: skill._source!.level,
			});
			expect(isShadowedExtension(row)).toBe(false);
		}
		return rows;
	};

	test("shows the shared bare winner and both invocable namespace versions", async () => {
		const rows = await loadAndCompare();
		expect(rows.map(row => row.name).sort()).toEqual([
			"configured/panel-shared",
			"panel-shared",
			"personal/panel-shared",
		]);
		const shared = rows.find(row => row.name === "panel-shared")!;
		expect(shared.path).toBe(path.join(sharedDir, "panel-shared", "SKILL.md"));
		expect(shared.source.providerName).toBe("Shared");
		expect(rows.find(row => row.name === "personal/panel-shared")?.path).toBe(
			path.join(root, "personal", "skills", "panel-shared", "SKILL.md"),
		);
	});

	test("keeps parent and child dashboard skill settings local while the child hold is bound", async () => {
		const parentDirectory = path.join(projectDir, "parent-skills");
		const childDirectory = path.join(projectDir, "child-skills");
		const parentPath = await writeSkill(parentDirectory, "Parent session only", "review-parent-only");
		const childPath = await writeSkill(childDirectory, "Child session only", "review-child-only");
		cfgSkillsCustomDirectories.override(settings, [parentDirectory]);
		const childSettings = settings.overlay({ "skills.customDirectories": [childDirectory] });
		expect(cfgSkillsCustomDirectories.get(settings)).toEqual([parentDirectory]);
		expect(cfgSkillsCustomDirectories.get(childSettings)).toEqual([childDirectory]);
		const releaseChild = initializeWithSettings(childSettings);
		try {
			const childRuntime = createExtensionDashboardRuntime({ cwd: projectDir, settings: childSettings });
			const parentRows = await loadAndCompare();
			expect(parentRows.find(row => row.path === parentPath)?.state).toBe("active");
			expect(parentRows.some(row => row.path === childPath)).toBe(false);
			const childRows = (await childRuntime.loadExtensions(childRuntime.getDisabledExtensions())).filter(
				row => row.kind === "skill" && row.state === "active",
			);
			const childExecution = await loadSkills({ ...cfgSkills.get(childSettings), cwd: projectDir });
			expect(childRows.map(row => ({ name: row.name, path: row.path }))).toEqual(
				childExecution.skills.map(skill => ({ name: skill.name, path: skill.filePath })),
			);
			expect(childRows.some(row => row.path === parentPath)).toBe(false);
			expect(childRows.some(row => row.path === childPath)).toBe(true);

			const configuredDirectory = path.join(projectDir, "configured");
			cfgSkillsCustomDirectories.override(settings, [configuredDirectory]);
			expect(cfgSkillsCustomDirectories.get(settings)).toEqual([configuredDirectory]);
			expect(cfgSkillsCustomDirectories.get(childSettings)).toEqual([childDirectory]);
			const reloadedParentRows = await loadAndCompare();
			expect(reloadedParentRows.some(row => row.path === parentPath || row.path === childPath)).toBe(false);
			expect(
				reloadedParentRows.find(row => row.path === path.join(configuredDirectory, "panel-shared", "SKILL.md"))
					?.state,
			).toBe("active");
			const reloadedChildRows = await childRuntime.loadExtensions(childRuntime.getDisabledExtensions());
			expect(reloadedChildRows.find(row => row.path === childPath)?.state).toBe("active");
			expect(reloadedChildRows.some(row => row.path === parentPath)).toBe(false);
		} finally {
			releaseChild();
		}
	});

	test("keeps disabled rows through the existing toggle and refresh state APIs without editing skills", async () => {
		const initial = await loadAndCompare();
		const originalBytes = await Promise.all(initial.map(row => fs.readFile(row.path, "utf8")));
		const providers = runtime.getProviders();
		let state = createInitialState(initial, providers);
		const aliasId = "skill:personal/panel-shared";
		runtime.setDisabledExtensions([aliasId]);
		state = applyDisabledExtensionsToState(state, runtime.getDisabledExtensions(), providers);
		expect(state.extensions.find(row => row.id === aliasId)?.state).toBe("disabled");
		state = refreshState(state, await loadAndCompare(), providers);
		expect(state.extensions).toHaveLength(3);
		expect(state.extensions.find(row => row.id === aliasId)?.disabledReason).toBe("item-disabled");
		expect(state.extensions.find(row => row.name === "panel-shared")?.state).toBe("active");

		runtime.setDisabledExtensions([]);
		state = refreshState(state, await loadAndCompare(), providers);
		expect(state.extensions.every(row => row.state === "active")).toBe(true);

		runtime.setDisabledExtensions(["skill:panel-shared"]);
		const disabled = await loadAndCompare();
		expect(disabled).toHaveLength(3);
		expect(disabled.every(row => row.state === "disabled")).toBe(true);
		runtime.setDisabledExtensions([]);
		await loadAndCompare();
		expect(await Promise.all(initial.map(row => fs.readFile(row.path, "utf8")))).toEqual(originalBytes);
	});

	test("keeps configured include, ignore, and master-disabled skills visible for management", async () => {
		cfgSkillsIncludeSkills.set(settings, ["personal/*"]);
		const included = await loadAndCompare();
		expect(included).toHaveLength(3);
		expect(included.filter(row => row.state === "active").map(row => row.name)).toEqual(["personal/panel-shared"]);
		cfgSkillsIgnoredSkills.set(settings, ["personal/*"]);
		expect((await loadAndCompare()).every(row => row.state === "disabled")).toBe(true);
		cfgSkillsIncludeSkills.set(settings, []);
		cfgSkillsIgnoredSkills.set(settings, []);
		cfgSkillsEnabled.set(settings, false);
		expect((await loadAndCompare()).every(row => row.state === "disabled")).toBe(true);
	});

	for (const disabledReason of ["user-opt-in", "provider-disabled"] as const) {
		for (const identical of [false, true]) {
			test(`keeps managed fallback and an independently addressable ${disabledReason} row with ${
				identical ? "identical" : "different"
			} content`, async () => {
				cfgSkillsEnableClaudeUser.set(settings, false);
				cfgSkillsEnableClaudeProject.set(settings, false);
				if (disabledReason === "provider-disabled") disableProvider("claude");
				const name = "managed-fallback";
				const managedPath = await writeSkill(getManagedSkillsDir(), "Managed fallback", name);
				const inactivePath = await writeSkill(
					path.join(root, ".claude", "skills"),
					identical ? "Managed fallback" : "Inactive authored version",
					name,
				);

				const rows = await loadAndCompare();
				expect(new Set(rows.map(row => row.id)).size).toBe(rows.length);
				const managed = rows.find(row => row.path === managedPath)!;
				const inactive = rows.find(row => row.path === inactivePath)!;
				expect(managed.name).toBe(name);
				expect(managed.id).toBe(`skill:${name}`);
				expect(managed.state).toBe("active");
				expect(managed.source.provider).toBe("omp-managed");
				expect(inactive.name).toBe(`claude/${name}`);
				expect(inactive.id).toBe(`skill:claude/${name}`);
				expect(inactive.state).toBe("disabled");
				expect(inactive.disabledReason).toBe(disabledReason);

				runtime.setDisabledExtensions([inactive.id]);
				const toggled = await loadAndCompare();
				expect(toggled.find(row => row.id === inactive.id)?.disabledReason).toBe("item-disabled");
				expect(toggled.find(row => row.id === managed.id)?.state).toBe("active");
				expect(toggled.find(row => row.id === managed.id)?.path).toBe(managedPath);
				runtime.setDisabledExtensions([]);
				expect((await loadAndCompare()).find(row => row.id === inactive.id)?.disabledReason).toBe(disabledReason);

				if (disabledReason === "provider-disabled") {
					const execution = await loadCapability<CapabilitySkill>("skills", { cwd: projectDir });
					expect(execution.all.some(skill => skill._source.provider === "claude")).toBe(false);
					expect(execution.items.find(skill => skill.name === name)?._source.provider).toBe("omp-managed");
					const inventory = await loadCapability<CapabilitySkill>("skills", {
						cwd: projectDir,
						includeDisabled: true,
					});
					expect(inventory.all.some(skill => skill.path === inactivePath)).toBe(true);
					const managedDiscovery = inventory.all.find(skill => skill.path === managedPath);
					expect(managedDiscovery).toBeDefined();
					expect(managedDiscovery?._shadowed).not.toBe(true);
					enableProvider("claude");
				}
				enableUserSource("claude");
				const restored = await loadAndCompare();
				const authored = restored.find(row => row.path === inactivePath)!;
				expect(authored.id).toBe(`skill:${name}`);
				expect(authored.state).toBe("active");
				expect(restored.some(row => row.path === managedPath)).toBe(false);
			});
		}
	}

	test("refresh follows a changed shared root while preserving personal and configured versions", async () => {
		await loadAndCompare();
		const replacementDir = path.join(root, "replacement");
		const replacementPath = await writeSkill(replacementDir, "Replacement shared version");
		restoreEnvValue("OMP_SKILLS_DIR", replacementDir);
		const refreshed = await loadAndCompare();
		expect(refreshed).toHaveLength(3);
		expect(refreshed.find(row => row.name === "panel-shared")?.path).toBe(replacementPath);
		expect(refreshed.find(row => row.name === "panel-shared")?.description).toBe("Replacement shared version");
		expect(refreshed.find(row => row.name === "personal/panel-shared")?.state).toBe("active");
	});
});
