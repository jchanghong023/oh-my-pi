// Unit coverage for CommandCatalogService (modes/zcode/hosts/command-catalog.ts):
// live-session catalog snapshots with execution verdicts, zero-side-effect
// name/argument completion, strict resolution, and revision drift.

import { beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgSkills } from "@oh-my-pi/pi-coding-agent/extensibility/settings";
import type { LoadedCustomCommand } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands";
import {
	CommandCatalogError,
	CommandCatalogService,
	scoreCommandText,
} from "@oh-my-pi/pi-coding-agent/modes/zcode/hosts/command-catalog";
import type { CommandDescriptor } from "@oh-my-pi/pi-coding-agent/modes/zcode/hosts/types";
import { BUILTIN_SLASH_COMMANDS_INTERNAL } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { loadSpecDrivenSkill } from "../../src/spec-driven/resources";

let globalSettingsReady: Promise<unknown> | undefined;

beforeAll(async () => {
	// Skill discovery and settings access route through the process-global
	// settings singleton; tests initialize it in memory (never touches the
	// user's real config).
	globalSettingsReady ??= Settings.init({ inMemory: true });
	await globalSettingsReady;
});

/** Write one project skill under `<root>/.omp/skills/<name>/SKILL.md`. */
async function writeProjectSkill(root: string, name: string, description: string): Promise<void> {
	const skillDir = path.join(root, ".omp", "skills", name);
	await fs.mkdir(skillDir, { recursive: true });
	await fs.writeFile(
		path.join(skillDir, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${description}\n---\n\nProbe body for catalog tests.\n`,
	);
}

function byName(commands: readonly CommandDescriptor[]): Map<string, CommandDescriptor> {
	return new Map(commands.map(command => [command.name, command]));
}

describe("CommandCatalogService", () => {
	test("offers manual OpenSpec skills instead of builtins and rejects removed entrypoints", async () => {
		const cwd = process.cwd();
		const service = new CommandCatalogService({ cwd });
		const visible = ["opsx-explore", "opsx-update", "opsx-propose", "opsx-sync", "opsx-archive", "opsx-verify"];
		const session = {
			customCommands: [],
			setSlashCommands() {},
			sessionManager: { getCwd: () => cwd },
			skills: await Promise.all(visible.map(name => loadSpecDrivenSkill("openspec", name))),
			skillsSettings: { ...cfgSkills.get(Settings.isolated()), enableSkillCommands: true },
		};
		const catalog = await service.buildCatalog(session);
		const completion = await service.complete({ text: "/skill:opsx-", cursor: 12, session });
		expect(
			catalog
				.filter(command => command.source === "skill")
				.map(command => command.name)
				.sort(),
		).toEqual(visible.map(name => `skill:${name}`).toSorted());
		for (const name of visible) {
			expect(await service.resolve(`/skill:${name} change-name`, session)).toMatchObject({ kind: "skill" });
			expect(completion.items.some(item => item.label.includes(name))).toBe(true);
		}
		for (const name of [...visible, "opsx-new", "opsx-continue"]) {
			expect(await service.resolve(`/${name} change-name`, session)).toMatchObject({ kind: "unknown", name });
		}
	});

	test("live session catalog lists builtins, skills, and terminal-only verdicts", async () => {
		await using temp = await TempDir.create("zcode-hosts-catalog-");
		const cwd = path.resolve(temp.path());
		await writeProjectSkill(cwd, "probe", "Probe skill for the catalog");
		const service = new CommandCatalogService({ cwd });
		const session = {
			customCommands: [],
			setSlashCommands: () => {},
			sessionManager: { getCwd: () => cwd },
			skills: [
				{
					name: "probe",
					description: "Probe skill for the catalog",
					filePath: `${cwd}/.omp/skills/probe/SKILL.md`,
					baseDir: cwd,
					source: "native:project",
				},
			],
			skillsSettings: { ...cfgSkills.get(Settings.isolated()), enableSkillCommands: true },
		};
		const catalog = byName(await service.buildCatalog(session));
		// 目录必须覆盖真实 registry；新增普通 builtin 不需要再维护 ZCode 命令名单。
		const registered = BUILTIN_SLASH_COMMANDS_INTERNAL.filter(command =>
			Boolean(command.handle || command.handleRpc || command.handleTui),
		);
		expect(
			[...catalog.values()].filter(command => command.source === "builtin").map(command => command.name),
		).toEqual(registered.map(command => command.name));
		for (const command of registered) {
			expect(catalog.get(command.name)).toMatchObject({
				name: command.name,
				description: command.acpDescription ?? command.description,
				...(command.aliases?.length ? { aliases: command.aliases } : {}),
				...((command.acpInputHint ?? command.inlineHint)
					? { inputHint: command.acpInputHint ?? command.inlineHint }
					: {}),
			});
			for (const alias of command.aliases ?? []) {
				expect(await service.resolve(`/${alias}`, session)).toMatchObject({ kind: "builtin", name: command.name });
			}
		}
		expect(catalog.get("model")).toMatchObject({
			source: "builtin",
			execution: "omp",
			availability: { available: true },
		});
		expect(catalog.get("skill:probe")).toMatchObject({ source: "skill", execution: "omp" });
		for (const name of [
			"wiki",
			"repo",
			"team",
			"plan",
			"loop",
			"goal",
			"advisor",
			"ultrathink",
			"orchestrate",
			"workflowz",
			"fullsend",
			"compact",
		]) {
			expect(catalog.get(name)).toMatchObject({ execution: "omp", availability: { available: true } });
		}
		// Terminal-only business commands stay listed but report themselves.
		const tuiOnly = [...catalog.values()].find(command => command.execution === "tui");
		expect(tuiOnly?.availability).toMatchObject({ available: false, reason: "tui_only" });
		// No session: the catalog is empty (the fork surface is session-scoped).
		expect(await service.buildCatalog()).toEqual([]);
	});

	test("lists native loaded custom commands without executing their side effects", async () => {
		await using temp = await TempDir.create("zcode-native-catalog-");
		const cwd = path.resolve(temp.path());
		let effects = 0;
		const nativeCommand: LoadedCustomCommand = {
			path: "native-catalog-probe.ts",
			resolvedPath: path.join(cwd, "native-catalog-probe.ts"),
			source: "project",
			command: {
				name: "native-catalog-probe",
				description: "Native side-effect-only command",
				execute: () => {
					effects++;
					return undefined;
				},
			},
		};
		const session = {
			customCommands: [nativeCommand],
			setSlashCommands: () => {},
			sessionManager: { getCwd: () => cwd },
			skills: [],
			skillsSettings: cfgSkills.get(Settings.isolated()),
		};
		const service = new CommandCatalogService({ cwd });
		expect(byName(await service.buildCatalog(session)).get("native-catalog-probe")).toMatchObject({
			source: "custom",
			execution: "omp",
			availability: { available: true },
		});
		const text = "/native-catalog";
		expect((await service.complete({ text, cursor: text.length, session })).items).toEqual(
			expect.arrayContaining([expect.objectContaining({ label: "native-catalog-probe" })]),
		);
		expect(effects).toBe(0);
	});

	test("name and directory completion honor cursor ranges and the session's current project", async () => {
		await using temp = await TempDir.create("zcode-hosts-complete-name-");
		const cwd = path.resolve(temp.path());
		let currentCwd = cwd;
		const service = new CommandCatalogService({ cwd });
		const session = {
			customCommands: [],
			setSlashCommands: () => {},
			sessionManager: { getCwd: () => currentCwd },
			skills: [],
			skillsSettings: { ...cfgSkills.get(Settings.isolated()), enableSkillCommands: true },
		};
		const result = await service.complete({ text: "/mo", cursor: 3, session });
		expect(result.items.length).toBeGreaterThan(0);
		expect(result.items[0]!.label).toBe("model");
		expect(result.items[0]!.insertText).toBe("/model ");
		expect(result.items[0]!.replaceStart).toBe(0);
		expect(result.items[0]!.replaceEnd).toBe(3);
		expect(scoreCommandText("model", "model")).toBe(1000);
		expect(scoreCommandText("Model", "MO")).toBe(900);
		expect(scoreCommandText("Model", "ODE")).toBe(700);
		expect(scoreCommandText("model", "mo")).toBe(900);
		expect(scoreCommandText("model", "ode")).toBe(700);
		expect(scoreCommandText("model", "zzz")).toBe(0);
		// Non-command text and invalid cursors.
		expect((await service.complete({ text: "hello", cursor: 5, session })).items).toEqual([]);
		expect(() => service.complete({ text: "/mo", cursor: 99, session })).toThrow(CommandCatalogError);
		await fs.mkdir(path.join(cwd, "startup-only"));
		const movedCwd = path.join(cwd, "moved");
		await fs.mkdir(path.join(movedCwd, "destination-only"), { recursive: true });
		const beforeMove = await service.complete({ text: "/move ", cursor: 6, session });
		expect(beforeMove.items.some(item => item.label === "startup-only/")).toBe(true);
		currentCwd = movedCwd;
		const afterMove = await service.complete({ text: "/move dest", cursor: 10, session });
		expect(afterMove.items).toContainEqual({
			label: "destination-only/",
			insertText: "destination-only/",
			replaceStart: 6,
			replaceEnd: 10,
			kind: "argument",
		});
		expect((await service.complete({ text: "/move ", cursor: 6, session })).items.map(item => item.label)).toEqual([
			"destination-only/",
		]);
		// /move treats the whole argument as a path, not whitespace-delimited
		// tokens. Completing in the middle must replace its remaining suffix.
		await fs.mkdir(path.join(movedCwd, "destination with spaces"));
		const pathText = "/move destination with spaces/outdated";
		const pathCompletion = await service.complete({
			text: pathText,
			cursor: "/move destination with".length,
			session,
		});
		const directoryItem = pathCompletion.items.find(item => item.label === "destination with spaces/")!;
		expect(directoryItem).toMatchObject({ replaceStart: 6, replaceEnd: pathText.length });
		expect(
			pathText.slice(0, directoryItem.replaceStart) +
				directoryItem.insertText +
				pathText.slice(directoryItem.replaceEnd),
		).toBe("/move destination with spaces/");
	});

	test("strict resolution distinguishes builtins, skills, and unknown input", async () => {
		await using temp = await TempDir.create("zcode-hosts-resolve-");
		const cwd = path.resolve(temp.path());
		await writeProjectSkill(cwd, "probe", "Probe skill");
		const service = new CommandCatalogService({ cwd });
		const session = {
			customCommands: [],
			setSlashCommands: () => {},
			sessionManager: { getCwd: () => cwd },
			skills: [
				{
					name: "probe",
					description: "Probe skill",
					filePath: `${cwd}/.omp/skills/probe/SKILL.md`,
					baseDir: cwd,
					source: "native:project",
				},
			],
			skillsSettings: { ...cfgSkills.get(Settings.isolated()), enableSkillCommands: true },
		};
		expect(await service.resolve("/model", session)).toMatchObject({ kind: "builtin", name: "model" });
		expect(await service.resolve("/skill:probe", session)).toMatchObject({ kind: "skill", skillName: "probe" });
		expect(await service.resolve("/definitely-not-a-command", session)).toMatchObject({ kind: "unknown" });
		// Skill commands disabled: the skill no longer resolves.
		const disabled = { ...session, skillsSettings: { ...session.skillsSettings, enableSkillCommands: false } };
		expect(await service.resolve("/skill:probe", disabled)).toMatchObject({ kind: "unknown" });
	});

	test("catalog changes are observable through the revision", async () => {
		await using temp = await TempDir.create("zcode-hosts-revision-");
		const cwd = path.resolve(temp.path());
		const service = new CommandCatalogService({ cwd });
		const session = {
			customCommands: [],
			setSlashCommands: () => {},
			sessionManager: { getCwd: () => cwd },
			skills: [],
			skillsSettings: { ...cfgSkills.get(Settings.isolated()), enableSkillCommands: true },
		};
		const before = service.revision;
		await service.buildCatalog(session);
		expect(service.revision).toBe(before);
		const sessionWithSkill = {
			...session,
			skills: [
				{
					name: "late",
					description: "Late skill",
					filePath: `${temp.path()}/late/SKILL.md`,
					baseDir: temp.path(),
					source: "native:project",
				},
			],
		};
		await service.buildCatalog(sessionWithSkill);
		expect(service.revision).not.toBe(before);
	});
});
