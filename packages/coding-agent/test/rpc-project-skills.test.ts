// Unit tests for the fork RPC project-mode skill catalog + management service
// (requirement R1, rpc-ui-protocol.md §6/§14.6): the management/effective
// list_skills views, set_skill_enabled write-through into skills.ignoredSkills,
// copy_skill / delete_skill against real skill directories, and reload_skills
// cache refresh — all against real SKILL.md files in temp dirs and an isolated
// in-memory Settings instance (the process-global settings singleton is
// initialized in memory so nothing here touches the developer's real config).
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getConfigRootDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgSkillsIgnoredSkills } from "@oh-my-pi/pi-coding-agent/extensibility/settings";
import { RpcProjectSkillError, RpcProjectSkillService } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-project-skills";

let globalSettingsReady: Promise<unknown> | undefined;

beforeAll(async () => {
	// Settings is a process-global singleton; initialize it in memory (never
	// touches the user's real configuration). Matches rpc-fork-config.test.ts.
	globalSettingsReady ??= Settings.init({ inMemory: true });
	await globalSettingsReady;
});

// User-level native skills are discovered through the process-global agent dir
// (getAgentDir()), not the service's injected agentDir, so each test redirects
// it at its own temp agent dir and the original is restored afterwards
// (same pattern as agent-session-rules-reload.test.ts).
const originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
const fallbackAgentDir = path.join(getConfigRootDir(), "agent");

function restoreAgentDir(): void {
	if (originalAgentDirEnv) {
		setAgentDir(originalAgentDirEnv);
	} else {
		setAgentDir(fallbackAgentDir);
		delete process.env.PI_CODING_AGENT_DIR;
	}
}

afterEach(restoreAgentDir);

interface SkillFixture {
	service: RpcProjectSkillService;
	settings: Settings;
	emitted: object[];
	refreshCalls: () => number;
}

function setupService(dirs: { cwd: string; agentDir: string }): SkillFixture {
	const emitted: object[] = [];
	const settings = Settings.isolated();
	let refreshCalls = 0;
	const service = new RpcProjectSkillService({
		cwd: dirs.cwd,
		agentDir: dirs.agentDir,
		getSettings: () => settings,
		refreshSessions: () => {
			refreshCalls++;
			return { adopted: ["session-adopted"], pending: ["session-pending"] };
		},
		emit: frame => emitted.push(frame),
	});
	return { service, settings, emitted, refreshCalls: () => refreshCalls };
}

/** Write `<skillsRoot>/<name>/SKILL.md` with the standard frontmatter; returns the skill directory. */
async function writeSkill(skillsRoot: string, name: string, description: string): Promise<string> {
	const baseDir = path.join(skillsRoot, name);
	await fs.mkdir(baseDir, { recursive: true });
	await fs.writeFile(
		path.join(baseDir, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nSkill body for ${name}.\n`,
	);
	return baseDir;
}

/** Capture a rejection (or undefined on unexpected success) for code assertions. */
async function failure(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => undefined,
		error => error,
	);
}

describe("RpcProjectSkillService (R1, rpc-ui-protocol.md §6/§14.6)", () => {
	test("list management view returns native user and project skills with stable skillIds", async () => {
		await using cwdTemp = await TempDir.create("rpc-project-skills-cwd-");
		await using agentTemp = await TempDir.create("rpc-project-skills-agent-");
		const cwd = path.resolve(cwdTemp.path());
		const agentDir = path.resolve(agentTemp.path());
		setAgentDir(agentDir);
		const fx = setupService({ cwd, agentDir });
		const userSkills = path.join(agentDir, "skills");
		const projectSkills = path.join(cwd, CONFIG_DIR_NAME, "skills");
		await writeSkill(userSkills, "mgmt-user-probe", "User-scope management probe skill.");
		await writeSkill(projectSkills, "mgmt-project-probe", "Project-scope management probe skill.");

		const result = await fx.service.list({ view: "management" });

		const user = result.items.find(item => item.skillId === "native:user/mgmt-user-probe");
		expect(user).toBeDefined();
		expect(user).toMatchObject({
			name: "mgmt-user-probe",
			description: "User-scope management probe skill.",
			source: "native:user",
			scope: "user",
			state: "enabled",
			effective: true,
			revision: fx.service.revision,
		});
		expect(path.resolve(user!.filePath)).toBe(path.join(userSkills, "mgmt-user-probe", "SKILL.md"));
		expect(user!.actions).toContain("delete");

		const project = result.items.find(item => item.skillId === "native:project/mgmt-project-probe");
		expect(project).toBeDefined();
		expect(project).toMatchObject({
			name: "mgmt-project-probe",
			source: "native:project",
			scope: "project",
			state: "enabled",
			effective: true,
		});
		expect(path.resolve(project!.filePath)).toBe(path.join(projectSkills, "mgmt-project-probe", "SKILL.md"));

		expect(Array.isArray(result.warnings)).toBe(true);
	}, 15_000);

	test("list effective view with default skills settings reports the enabled set", async () => {
		await using cwdTemp = await TempDir.create("rpc-project-skills-cwd-");
		await using agentTemp = await TempDir.create("rpc-project-skills-agent-");
		const cwd = path.resolve(cwdTemp.path());
		const agentDir = path.resolve(agentTemp.path());
		setAgentDir(agentDir);
		const fx = setupService({ cwd, agentDir });
		await writeSkill(path.join(agentDir, "skills"), "eff-user-probe", "User-scope effective probe skill.");
		await writeSkill(
			path.join(cwd, CONFIG_DIR_NAME, "skills"),
			"eff-project-probe",
			"Project-scope effective probe skill.",
		);

		const result = await fx.service.list({ view: "effective" });

		const user = result.items.find(item => item.skillId === "native:user/eff-user-probe");
		expect(user).toMatchObject({ state: "enabled", effective: true, scope: "user" });
		const project = result.items.find(item => item.skillId === "native:project/eff-project-probe");
		expect(project).toMatchObject({ state: "enabled", effective: true, scope: "project" });
		// The effective view reports exactly what a fresh session would load — never a fabricated row.
		expect(result.items.every(item => item.effective)).toBe(true);
	}, 15_000);

	test("set_skill_enabled toggles skills.ignoredSkills, emits skills_changed and bumps the revision", async () => {
		await using cwdTemp = await TempDir.create("rpc-project-skills-cwd-");
		await using agentTemp = await TempDir.create("rpc-project-skills-agent-");
		const cwd = path.resolve(cwdTemp.path());
		const agentDir = path.resolve(agentTemp.path());
		setAgentDir(agentDir);
		const fx = setupService({ cwd, agentDir });
		await writeSkill(path.join(cwd, CONFIG_DIR_NAME, "skills"), "toggle-probe", "Toggle probe skill.");
		const before = fx.service.revision;

		const disabled = await fx.service.setEnabled({
			skillId: "native:project/toggle-probe",
			enabled: false,
			scope: "project",
		});

		expect(disabled).toMatchObject({
			skillId: "native:project/toggle-probe",
			enabled: false,
			effective: false,
			pendingReason: "ignored",
		});
		expect(cfgSkillsIgnoredSkills.get(fx.settings)).toEqual(["toggle-probe"]);
		expect(disabled.revision).not.toBe(before);
		expect(fx.service.revision).toBe(disabled.revision);
		const skillsChanged = fx.emitted.find(frame => (frame as { type: string }).type === "skills_changed");
		expect(skillsChanged).toMatchObject({ scope: "project", revision: disabled.revision });
		expect(fx.emitted.find(frame => (frame as { type: string }).type === "settings_changed")).toMatchObject({
			scope: "user",
		});

		// The management view still lists the ignored row, classified as ignored.
		const management = await fx.service.list({ view: "management" });
		expect(management.items.find(item => item.skillId === "native:project/toggle-probe")).toMatchObject({
			state: "ignored",
			effective: false,
		});

		const enabled = await fx.service.setEnabled({
			skillId: "native:project/toggle-probe",
			enabled: true,
			scope: "project",
		});
		expect(enabled).toMatchObject({ enabled: true, effective: true });
		expect(enabled.pendingReason).toBeUndefined();
		expect(cfgSkillsIgnoredSkills.get(fx.settings)).toEqual([]);
	}, 15_000);

	test("copy_skill copies the skill directory into the target scope and refuses occupied targets", async () => {
		await using cwdTemp = await TempDir.create("rpc-project-skills-cwd-");
		await using agentTemp = await TempDir.create("rpc-project-skills-agent-");
		const cwd = path.resolve(cwdTemp.path());
		const agentDir = path.resolve(agentTemp.path());
		setAgentDir(agentDir);
		const fx = setupService({ cwd, agentDir });
		const userSkills = path.join(agentDir, "skills");
		await writeSkill(path.join(cwd, CONFIG_DIR_NAME, "skills"), "copy-probe", "Copy probe skill.");
		const before = fx.service.revision;

		const copied = await fx.service.copy({
			skillId: "native:project/copy-probe",
			targetScope: "user",
			targetName: "copy-probe-user",
		});

		expect(copied).toMatchObject({ skillId: "native:user/copy-probe-user", name: "copy-probe-user" });
		expect(path.resolve(copied.location)).toBe(path.join(userSkills, "copy-probe-user"));
		expect(await Bun.file(path.join(copied.location, "SKILL.md")).exists()).toBe(true);
		const copiedBody = await fs.readFile(path.join(copied.location, "SKILL.md"), "utf-8");
		expect(copiedBody).toContain("Skill body for copy-probe.");
		expect(copied.revision).not.toBe(before);
		expect(fx.emitted.find(frame => (frame as { type: string }).type === "skills_changed")).toMatchObject({
			scope: "user",
			revision: copied.revision,
		});

		// The copy is discoverable as a user-scope native skill.
		const listed = await fx.service.list({ view: "management" });
		expect(listed.items.find(item => item.skillId === "native:user/copy-probe-user")).toBeDefined();

		// An occupied target name is rejected.
		const clash = await failure(
			fx.service.copy({
				skillId: "native:project/copy-probe",
				targetScope: "user",
				targetName: "copy-probe-user",
			}),
		);
		expect(clash).toBeInstanceOf(RpcProjectSkillError);
		expect((clash as RpcProjectSkillError).code).toBe("invalid_params");

		// Traversal-shaped target names never reach the filesystem.
		const traversal = await failure(
			fx.service.copy({
				skillId: "native:project/copy-probe",
				targetScope: "user",
				targetName: "../escape",
			}),
		);
		expect(traversal).toBeInstanceOf(RpcProjectSkillError);
		expect((traversal as RpcProjectSkillError).code).toBe("invalid_params");
	}, 15_000);

	test("delete_skill removes user-scope skills and refuses non-managed sources", async () => {
		await using cwdTemp = await TempDir.create("rpc-project-skills-cwd-");
		await using agentTemp = await TempDir.create("rpc-project-skills-agent-");
		const cwd = path.resolve(cwdTemp.path());
		const agentDir = path.resolve(agentTemp.path());
		setAgentDir(agentDir);
		const fx = setupService({ cwd, agentDir });
		const userSkills = path.join(agentDir, "skills");
		await writeSkill(userSkills, "del-probe", "Delete probe skill.");
		await writeSkill(path.join(cwd, ".claude", "skills"), "foreign-probe", "Foreign probe skill.");
		const before = fx.service.revision;

		const deleted = await fx.service.delete({ skillId: "native:user/del-probe" });

		expect(deleted.revision).not.toBe(before);
		expect(await Bun.file(path.join(userSkills, "del-probe", "SKILL.md")).exists()).toBe(false);
		expect(fx.emitted.find(frame => (frame as { type: string }).type === "skills_changed")).toMatchObject({
			scope: "user",
			revision: deleted.revision,
		});

		const listed = await fx.service.list({ view: "management" });
		expect(listed.items.find(item => item.skillId === "native:user/del-probe")).toBeUndefined();

		// A Claude project skill is not in a user/project native skills directory;
		// removal must go through its own package management (§14.6).
		const foreign = listed.items.find(item => item.skillId === "claude:project/foreign-probe");
		expect(foreign).toBeDefined();
		const refused = await failure(fx.service.delete({ skillId: "claude:project/foreign-probe" }));
		expect(refused).toBeInstanceOf(RpcProjectSkillError);
		expect((refused as RpcProjectSkillError).code).toBe("unsupported");
		expect(await Bun.file(path.join(cwd, ".claude", "skills", "foreign-probe", "SKILL.md")).exists()).toBe(true);
	}, 15_000);

	test("reload_skills refreshes external edits, bumps the revision and reports session adoption", async () => {
		await using cwdTemp = await TempDir.create("rpc-project-skills-cwd-");
		await using agentTemp = await TempDir.create("rpc-project-skills-agent-");
		const cwd = path.resolve(cwdTemp.path());
		const agentDir = path.resolve(agentTemp.path());
		setAgentDir(agentDir);
		const fx = setupService({ cwd, agentDir });
		const projectSkills = path.join(cwd, CONFIG_DIR_NAME, "skills");
		const baseDir = await writeSkill(projectSkills, "reload-probe", "Reload probe before edit.");

		const first = await fx.service.list({ view: "management" });
		expect(first.items.find(item => item.skillId === "native:project/reload-probe")?.description).toBe(
			"Reload probe before edit.",
		);

		// External edit to the same SKILL.md: the capability content cache still
		// holds the old body, so only a reload makes the edit visible again.
		await fs.writeFile(
			path.join(baseDir, "SKILL.md"),
			`---\nname: reload-probe\ndescription: Reload probe after edit.\n---\n\nSkill body for reload-probe.\n`,
		);

		const before = fx.service.revision;
		const result = await fx.service.reload("user");

		expect(result.revision).not.toBe(before);
		expect(fx.service.revision).toBe(result.revision);
		expect(result.adoptedSessions).toEqual(["session-adopted"]);
		expect(result.pendingSessions).toEqual(["session-pending"]);
		expect(fx.refreshCalls()).toBe(1);
		expect(Array.isArray(result.warnings)).toBe(true);
		expect(fx.emitted.find(frame => (frame as { type: string }).type === "skills_changed")).toMatchObject({
			scope: "user",
			revision: result.revision,
		});

		const fresh = await fx.service.list({ view: "management" });
		expect(fresh.items.find(item => item.skillId === "native:project/reload-probe")?.description).toBe(
			"Reload probe after edit.",
		);

		const badScope = await failure(fx.service.reload("galaxy" as never));
		expect(badScope).toBeInstanceOf(RpcProjectSkillError);
		expect((badScope as RpcProjectSkillError).code).toBe("invalid_params");
	}, 15_000);
});
