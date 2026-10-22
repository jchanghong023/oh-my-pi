import { afterEach, beforeEach, describe, expect, test, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type ContextFile, contextFileCapability } from "@oh-my-pi/pi-coding-agent/capability/context-file";
import { cfgDisabledProviders, cfgEnabledProviders } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { resetSettingsForTest, Settings, withActiveSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	getDisabledProviders,
	getEnabledProviders,
	initializeWithSettings,
	loadCapability,
	resetCapabilityForTests,
	setDisabledProviders,
	setEnabledProviders,
} from "@oh-my-pi/pi-coding-agent/discovery";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

describe("session-scoped capability discovery", () => {
	let root: string;
	let homeSpy: { mockRestore(): void };
	const releases: Array<() => void> = [];

	beforeEach(async () => {
		resetCapabilityForTests();
		resetSettingsForTest();
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-capability-scope-"));
		homeSpy = spyOn(os, "homedir").mockReturnValue(root);
		await fs.mkdir(path.join(root, ".gemini"), { recursive: true });
		await fs.writeFile(path.join(root, ".gemini", "GEMINI.md"), "User Gemini context\n");
	});

	afterEach(async () => {
		for (const release of releases.splice(0).reverse()) release();
		resetCapabilityForTests();
		resetSettingsForTest();
		homeSpy.mockRestore();
		await removeWithRetries(root);
	});

	async function workspace(name: string, overrides: Record<string, unknown> = {}): Promise<Settings> {
		const cwd = path.join(root, name);
		const agentDir = path.join(root, `${name}-agent`);
		await fs.mkdir(path.join(cwd, ".gemini"), { recursive: true });
		await fs.mkdir(agentDir, { recursive: true });
		await fs.writeFile(path.join(cwd, ".gemini", "GEMINI.md"), `${name} project context\n`);
		return Settings.loadIsolated({ cwd, agentDir, inMemory: true, overrides });
	}

	function discover(settings: Settings) {
		return loadCapability<ContextFile>(contextFileCapability.id, {
			cwd: settings.getCwd(),
			agentDir: settings.getAgentDir(),
			// Unlike `providers`, exclusions do not implicitly opt foreign user sources in.
			excludeProviders: contextFileCapability.providers
				.filter(provider => provider.id !== "gemini")
				.map(provider => provider.id),
		});
	}

	test("concurrent explicit workspaces use their own provider and extension policies, not the newest hold", async () => {
		const enabled = await workspace("enabled", { enabledProviders: ["gemini"] });
		const extensionDisabled = await workspace("extension-disabled", {
			enabledProviders: ["gemini"],
			disabledExtensions: ["context-file:project:GEMINI.md"],
		});
		const providerDisabled = await workspace("provider-disabled", { disabledProviders: ["gemini"] });
		releases.push(initializeWithSettings(providerDisabled));

		const [first, second, third] = await Promise.all([
			discover(enabled),
			discover(extensionDisabled),
			discover(providerDisabled),
		]);
		expect(first.items.map(item => item.content).sort()).toEqual([
			"User Gemini context\n",
			"enabled project context\n",
		]);
		expect(second.items.map(item => item.content)).toEqual(["User Gemini context\n"]);
		expect(third.items).toEqual([]);
		expect(getDisabledProviders()).toEqual(["gemini"]);
	});

	test("explicit agentDir distinguishes settings for the same cwd outside async scope", async () => {
		const enabled = await workspace("agent-dir", { enabledProviders: ["gemini"] });
		const disabled = await Settings.loadIsolated({
			cwd: enabled.getCwd(),
			agentDir: path.join(root, "other-agent"),
			inMemory: true,
			overrides: { disabledProviders: ["gemini"] },
		});
		releases.push(initializeWithSettings(disabled));
		const [visible, hidden] = await Promise.all([discover(enabled), discover(disabled)]);
		expect(visible.items.map(item => item.content).sort()).toEqual([
			"User Gemini context\n",
			"agent-dir project context\n",
		]);
		expect(hidden.items).toEqual([]);
	});

	test("same-cwd sessions keep actual async scope across awaits and concurrent discovery", async () => {
		const enabled = await workspace("shared", { enabledProviders: ["gemini"] });
		const disabled = enabled.overlay({ disabledProviders: ["gemini"] });
		releases.push(initializeWithSettings(disabled));
		const { promise: barrier, resolve: start } = Promise.withResolvers<void>();
		const first = withActiveSettings(enabled, async () => {
			await barrier;
			return discover(enabled);
		});
		const second = withActiveSettings(disabled, async () => {
			await barrier;
			return discover(disabled);
		});
		start();
		const [visible, hidden] = await Promise.all([first, second]);
		expect(visible.items.map(item => item.content).sort()).toEqual([
			"User Gemini context\n",
			"shared project context\n",
		]);
		expect(hidden.items).toEqual([]);
		expect(getDisabledProviders()).toEqual(["gemini"]);
	});

	test("user-source opt-in and extension disablement remain scoped for same-cwd sessions", async () => {
		const optedIn = await workspace("source", { enabledProviders: ["gemini"] });
		const optedOut = optedIn.overlay({ enabledProviders: [] });
		const hiddenProject = optedIn.overlay({ disabledExtensions: ["context-file:project:GEMINI.md"] });
		releases.push(initializeWithSettings(hiddenProject));
		const [all, projectOnly, userOnly] = await Promise.all([
			withActiveSettings(optedIn, () => discover(optedIn)),
			withActiveSettings(optedOut, () => discover(optedOut)),
			withActiveSettings(hiddenProject, () => discover(hiddenProject)),
		]);
		expect(all.items.map(item => item.content).sort()).toEqual(["User Gemini context\n", "source project context\n"]);
		expect(projectOnly.items.map(item => item.content)).toEqual(["source project context\n"]);
		expect(userOnly.items.map(item => item.content)).toEqual(["User Gemini context\n"]);
	});

	test("scoped setters affect only their session and ordinary setters keep the bound holder", async () => {
		// Provider setters edit the mutable global layer, not pinned runtime overrides.
		const first = await workspace("setter");
		cfgEnabledProviders.set(first, ["gemini"]);
		const bound = first.overlay();
		cfgDisabledProviders.set(bound, ["gemini"]);
		releases.push(initializeWithSettings(bound));
		await withActiveSettings(first, async () => {
			await Promise.resolve();
			setEnabledProviders([]);
			setDisabledProviders([]);
			expect(getEnabledProviders()).toEqual([]);
			expect((await discover(first)).items.map(item => item.content)).toEqual(["setter project context\n"]);
		});
		expect(getDisabledProviders()).toEqual(["gemini"]);
		setDisabledProviders([]);
		setEnabledProviders(["gemini"]);
		expect((await withActiveSettings(bound, () => discover(bound))).items).toHaveLength(2);
		expect(withActiveSettings(first, getEnabledProviders)).toEqual([]);
	});
});
