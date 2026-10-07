// Unit coverage for RpcForkCommandCatalogService (rpc-fork-commands.ts):
// live-session catalog snapshots with execution verdicts, zero-side-effect
// name/argument completion, strict resolution, and revision invalidation.

import { beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgSkills } from "@oh-my-pi/pi-coding-agent/extensibility/settings";
import {
	RpcCommandCatalogError,
	RpcForkCommandCatalogService,
	scoreCommandText,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-fork-commands";
import type { RpcCommandDescriptor } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-fork-types";

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

function byName(commands: readonly RpcCommandDescriptor[]): Map<string, RpcCommandDescriptor> {
	return new Map(commands.map(command => [command.name, command]));
}

describe("RpcForkCommandCatalogService", () => {
	test("live session catalog lists builtins, skills, and terminal-only verdicts", async () => {
		await using temp = await TempDir.create("rpc-fork-catalog-");
		const cwd = path.resolve(temp.path());
		await writeProjectSkill(cwd, "probe", "Probe skill for the catalog");
		const service = new RpcForkCommandCatalogService({ cwd });
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
		expect(catalog.get("model")).toMatchObject({
			source: "builtin",
			execution: "omp",
			availability: { available: true },
		});
		expect(catalog.get("skill:probe")).toMatchObject({ source: "skill", execution: "omp" });
		// Terminal-only business commands stay listed but report themselves.
		const tuiOnly = [...catalog.values()].find(command => command.execution === "tui");
		expect(tuiOnly?.availability).toMatchObject({ available: false, reason: "tui_only" });
		// No session: the catalog is empty (the fork surface is session-scoped).
		expect(await service.buildCatalog()).toEqual([]);
	});

	test("name completion ranks exact, prefix, substring and drops non-matches", async () => {
		await using temp = await TempDir.create("rpc-fork-complete-name-");
		const cwd = path.resolve(temp.path());
		const service = new RpcForkCommandCatalogService({ cwd });
		const session = {
			customCommands: [],
			setSlashCommands: () => {},
			sessionManager: { getCwd: () => cwd },
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
		expect(scoreCommandText("model", "mo")).toBe(900);
		expect(scoreCommandText("model", "ode")).toBe(700);
		expect(scoreCommandText("model", "zzz")).toBe(0);
		// Non-command text and invalid cursors.
		expect((await service.complete({ text: "hello", cursor: 5, session })).items).toEqual([]);
		expect(() => service.complete({ text: "/mo", cursor: 99, session })).toThrow(RpcCommandCatalogError);
	});

	test("strict resolution distinguishes builtins, skills, and unknown input", async () => {
		await using temp = await TempDir.create("rpc-fork-resolve-");
		const cwd = path.resolve(temp.path());
		await writeProjectSkill(cwd, "probe", "Probe skill");
		const service = new RpcForkCommandCatalogService({ cwd });
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
		await using temp = await TempDir.create("rpc-fork-revision-");
		const cwd = path.resolve(temp.path());
		const service = new RpcForkCommandCatalogService({ cwd });
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
		service.invalidate();
		expect(service.revision).not.toBe(before);
	});
});
