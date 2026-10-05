import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	CONFIG_DIR_NAME,
	getConfigRootDir,
	normalizePathForComparison,
	setAgentDir,
	TempDir,
} from "@oh-my-pi/pi-utils";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	cfgSkills,
	cfgSkillsIgnoredSkills,
	cfgSkillsEnablePiProject,
} from "@oh-my-pi/pi-coding-agent/extensibility/settings";
import { loadSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { RpcProjectSkillService } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-project-skills";
import type { RpcProjectSkillSummary } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-project-types";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const directories: TempDir[] = [];
const settingsInstances: Settings[] = [];
beforeAll(async () => {
	await Settings.init({ inMemory: true });
});
afterEach(async () => {
	for (const settings of settingsInstances.splice(0)) settings.cancelPendingSaves();
	AgentStorage.close();
	for (const directory of directories.splice(0)) await directory.remove();
	setAgentDir(originalAgentDir ?? path.join(getConfigRootDir(), "agent"));
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
});
function disabledPaths(settings: Settings): string[] {
	const value = settings.getUserSettingValue("skills.disabledPaths");
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string").map(normalizePathForComparison)
		: [];
}

async function fixture() {
	const directory = await TempDir.create("rpc-project-skills-");
	directories.push(directory);
	const cwd = path.resolve(directory.path());
	const agentDir = path.join(cwd, "agent");
	await fs.mkdir(agentDir, { recursive: true });
	setAgentDir(agentDir);
	const settings = await Settings.loadIsolated({ cwd, agentDir });
	settingsInstances.push(settings);
	const emitted: Record<string, unknown>[] = [];
	let refreshCalls = 0;
	const service = new RpcProjectSkillService({
		cwd,
		agentDir,
		getSettings: () => settings,
		emit: frame => emitted.push(frame as Record<string, unknown>),
		refreshSessions: () => {
			refreshCalls++;
			return { adopted: ["session-adopted"], pending: ["session-pending"] };
		},
	});
	const writeSkill = async (
		scope: "user" | "project" | "claude",
		name: string,
		description = `${name} description`,
	) => {
		const baseDir = path.join(
			scope === "user" ? agentDir : cwd,
			scope === "user" ? "skills" : scope === "claude" ? ".claude/skills" : `${CONFIG_DIR_NAME}/skills`,
			name,
		);
		await fs.mkdir(baseDir, { recursive: true });
		await fs.writeFile(
			path.join(baseDir, "SKILL.md"),
			`---\nname: ${name}\ndescription: ${description}\n---\n\nBody for ${name}.\n`,
		);
		return baseDir;
	};
	const row = async (name: string, source?: string): Promise<RpcProjectSkillSummary> => {
		const rows = (await service.list({ view: "management" })).items;
		const match = rows.find(item => item.name === name && (source === undefined || item.source === source));
		if (!match) throw new Error(`Missing skill ${name} (${source ?? "any source"})`);
		return match;
	};
	return { cwd, agentDir, settings, service, emitted, writeSkill, row, refreshCalls: () => refreshCalls };
}

describe("RpcProjectSkillService", () => {
	test("management includes real user/project resources without fabricating session effectiveness", async () => {
		const fx = await fixture();
		await fx.writeSkill("user", "user-probe");
		await fx.writeSkill("project", "project-probe");
		const user = await fx.row("user-probe");
		const project = await fx.row("project-probe");
		expect(user).toMatchObject({
			source: "native:user",
			scope: "user",
			state: "enabled",
			effective: false,
			writableScopes: ["user"],
		});
		expect(project).toMatchObject({ source: "native:project", scope: "project", state: "enabled", effective: false });
		expect(user.skillId).not.toBe(project.skillId);
		expect(user.actions).toContain("delete");
		expect(user.revision).not.toBe(fx.service.revision);
	});

	test("effective rows require a session and retain its adopted content version after disk edits", async () => {
		const fx = await fixture();
		const baseDir = await fx.writeSkill("project", "snapshot", "Original description");
		const snapshot = await loadSkills({ cwd: fx.cwd, ...cfgSkills.get(fx.settings) });
		const options = {
			view: "effective" as const,
			sessionId: "A",
			sessionGeneration: "g-A",
			sessionSkills: snapshot.skills,
		};
		const first = (await fx.service.list(options)).items.find(item => item.name === "snapshot")!;
		expect(first).toMatchObject({ effective: true, state: "enabled", description: "Original description" });
		await fs.writeFile(
			path.join(baseDir, "SKILL.md"),
			"---\nname: snapshot\ndescription: Changed description\n---\n\nChanged body.\n",
		);
		const retained = (await fx.service.list(options)).items.find(item => item.name === "snapshot")!;
		expect(retained.revision).toBe(first.revision);
		expect(retained.description).toBe("Original description");
		expect((await fx.row("snapshot")).revision).not.toBe(first.revision);
		await expect(fx.service.list({ view: "effective" })).rejects.toMatchObject({ code: "invalid_params" });
	});

	test("concrete toggles persist user path flags, report adoption, and never rewrite name ignores", async () => {
		const fx = await fixture();
		await fx.writeSkill("project", "toggle");
		const original = await fx.row("toggle");
		const disabled = await fx.service.setEnabled({
			skillId: original.skillId,
			expectedRevision: original.revision,
			enabled: false,
			scope: "user",
		});
		expect(disabled).toMatchObject({
			enabled: false,
			effective: false,
			adoptedSessions: ["session-adopted"],
			pendingSessions: ["session-pending"],
		});
		expect(cfgSkillsIgnoredSkills.get(fx.settings)).toEqual([]);
		expect(disabledPaths(fx.settings)).toContain(normalizePathForComparison(original.filePath));
		const reloaded = await Settings.loadIsolated({ cwd: fx.cwd, agentDir: fx.agentDir });
		settingsInstances.push(reloaded);
		expect(disabledPaths(reloaded)).toContain(normalizePathForComparison(original.filePath));
		expect(fx.emitted.some(frame => frame.type === "settings_changed" && frame.scope === "user")).toBe(true);
		const current = await fx.row("toggle");
		const enabled = await fx.service.setEnabled({
			skillId: current.skillId,
			expectedRevision: current.revision,
			enabled: true,
			scope: "user",
		});
		expect(enabled).toMatchObject({ enabled: true, effective: true });
		expect(disabledPaths(fx.settings)).not.toContain(normalizePathForComparison(original.filePath));
	});

	test("toggles preserve source switches and glob policies instead of implicitly reopening them", async () => {
		const fx = await fixture();
		await fx.writeSkill("project", "blocked");
		cfgSkillsIgnoredSkills.set(fx.settings, ["block*"]);
		cfgSkillsEnablePiProject.set(fx.settings, false);
		const row = await fx.row("blocked");
		const result = await fx.service.setEnabled({
			skillId: row.skillId,
			expectedRevision: row.revision,
			enabled: true,
			scope: "user",
		});
		expect(result).toMatchObject({ enabled: true, effective: false, pendingReason: "source_disabled" });
		expect(cfgSkillsEnablePiProject.get(fx.settings)).toBe(false);
		expect(cfgSkillsIgnoredSkills.get(fx.settings)).toEqual(["block*"]);
	});

	test("same-name shadowed resources have distinct identities and independent concrete flags", async () => {
		const fx = await fixture();
		await fx.writeSkill("user", "same-name");
		await fx.writeSkill("project", "same-name");
		const user = await fx.row("same-name", "native:user");
		const project = await fx.row("same-name", "native:project");
		expect(user.skillId).not.toBe(project.skillId);
		await fx.service.setEnabled({
			skillId: user.skillId,
			expectedRevision: user.revision,
			enabled: false,
			scope: "user",
		});
		expect((await fx.row("same-name", "native:project")).revision).toBe(project.revision);
		expect(disabledPaths(fx.settings)).toContain(normalizePathForComparison(user.filePath));
		expect(disabledPaths(fx.settings)).not.toContain(normalizePathForComparison(project.filePath));
	});

	test("missing/stale revisions, project settings writes, and in-memory success are rejected", async () => {
		const fx = await fixture();
		const base = await fx.writeSkill("project", "cas");
		const row = await fx.row("cas");
		await expect(
			fx.service.setEnabled({ skillId: row.skillId, enabled: false, scope: "user" } as never),
		).rejects.toMatchObject({ code: "invalid_params" });
		await expect(
			fx.service.setEnabled({
				skillId: row.skillId,
				expectedRevision: row.revision,
				enabled: false,
				scope: "project" as never,
			}),
		).rejects.toMatchObject({ code: "scope_not_allowed" });
		await fs.appendFile(path.join(base, "SKILL.md"), "External change.\n");
		await expect(
			fx.service.setEnabled({ skillId: row.skillId, expectedRevision: row.revision, enabled: false, scope: "user" }),
		).rejects.toMatchObject({ code: "revision_conflict" });
		const memory = new RpcProjectSkillService({
			cwd: fx.cwd,
			agentDir: fx.agentDir,
			getSettings: () => Settings.isolated(),
			emit: () => {},
		});
		const fresh = (await memory.list({ view: "management" })).items.find(item => item.name === "cas")!;
		await expect(
			memory.setEnabled({ skillId: fresh.skillId, expectedRevision: fresh.revision, enabled: false, scope: "user" }),
		).rejects.toMatchObject({ code: "persistence_failed" });
	});

	test("disjoint concrete flags survive concurrent user writes", async () => {
		const fx = await fixture();
		await fx.writeSkill("project", "one");
		await fx.writeSkill("project", "two");
		const one = await fx.row("one");
		const two = await fx.row("two");
		await Promise.all(
			[one, two].map(row =>
				fx.service.setEnabled({
					skillId: row.skillId,
					expectedRevision: row.revision,
					enabled: false,
					scope: "user",
				}),
			),
		);
		const loaded = await Settings.loadIsolated({ cwd: fx.cwd, agentDir: fx.agentDir });
		settingsInstances.push(loaded);
		expect(disabledPaths(loaded)).toEqual(
			expect.arrayContaining([one.filePath, two.filePath].map(normalizePathForComparison)),
		);
	});

	test("delete removes managed files and refuses foreign resource ownership", async () => {
		const fx = await fixture();
		const base = await fx.writeSkill("user", "delete-probe");
		await fx.writeSkill("claude", "foreign-probe");
		const row = await fx.row("delete-probe");
		await fx.service.delete({ skillId: row.skillId, expectedRevision: row.revision });
		expect(await Bun.file(path.join(base, "SKILL.md")).exists()).toBe(false);
		const foreign = await fx.row("foreign-probe");
		await expect(
			fx.service.delete({ skillId: foreign.skillId, expectedRevision: foreign.revision }),
		).rejects.toMatchObject({ code: "unsupported" });
	});

	test("reload observes external metadata and waits for the real adoption callback", async () => {
		const fx = await fixture();
		const base = await fx.writeSkill("project", "reload", "Before reload");
		expect((await fx.row("reload")).description).toBe("Before reload");
		await fs.writeFile(
			path.join(base, "SKILL.md"),
			"---\nname: reload\ndescription: After reload\n---\n\nNew body.\n",
		);
		const receipt = await fx.service.reload("user");
		expect(receipt).toMatchObject({ adoptedSessions: ["session-adopted"], pendingSessions: ["session-pending"] });
		expect(fx.refreshCalls()).toBe(1);
		expect((await fx.row("reload")).description).toBe("After reload");
		const entered = Promise.withResolvers<void>();
		const released = Promise.withResolvers<{ adopted: string[]; pending: string[] }>();
		const waiting = new RpcProjectSkillService({
			cwd: fx.cwd,
			agentDir: fx.agentDir,
			getSettings: () => fx.settings,
			emit: () => {},
			refreshSessions: () => {
				entered.resolve();
				return released.promise;
			},
		});
		let completed = false;
		const pending = waiting.reload("project").then(result => {
			completed = true;
			return result;
		});
		await entered.promise;
		expect(completed).toBe(false);
		released.resolve({ adopted: ["A"], pending: ["B"] });
		await expect(pending).resolves.toMatchObject({ adoptedSessions: ["A"], pendingSessions: ["B"] });
		await expect(fx.service.reload("galaxy" as never)).rejects.toMatchObject({ code: "invalid_params" });
	});
});
