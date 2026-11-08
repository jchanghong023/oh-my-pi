import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { Skill } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { bindSpecSkillPolicy } from "@oh-my-pi/pi-coding-agent/spec-driven/skill-policy";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { SkillsListResult } from "../../../../vendor/zcode-frontend/packages/shared/src/skills-types";
import { createNativeSkillMethods } from "../../src/webgui/native-skills";
import { acquireBrowserProject } from "../../src/webgui/project-registry";
import type { WebGuiServiceContext } from "../../src/webgui/rpc-contract";
import { createWebGuiService } from "../../src/webgui/service-channel";
import { readWebGuiSessionInfo } from "../../src/webgui/session-source";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { getTestModel } from "../helpers/model-fixtures";

async function writeSkill(filePath: string, name: string): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, `---\nname: ${name}\ndescription: ${name} instructions\n---\n${name} body\n`);
}

async function fixture(temp: TempDir, skills: Skill[]) {
	const cwd = temp.join("project");
	await fs.mkdir(cwd, { recursive: true });
	const agentDir = temp.join("profile");
	const authStorage = createInMemoryAuthStorage();
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		sessionManager: SessionManager.inMemory(cwd),
		authStorage,
		modelRegistry: new ModelRegistry(authStorage, temp.join("models.yml")),
		settings: await Settings.loadIsolated({
			cwd,
			agentDir,
			overrides: {
				"compaction.enabled": false,
				"memory.backend": "off",
				"async.enabled": false,
			},
		}),
		model: getTestModel("ascend"),
		disableExtensionDiscovery: true,
		bindProcessState: false,
		skills,
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		rules: [],
		preloadedCustomToolPaths: [],
		toolNames: [],
		enableMCP: false,
		enableLsp: false,
		taskDepth: 1,
		agentId: "SubAgent",
	});
	const lease = await acquireBrowserProject(cwd, "webgui");
	await lease.activate(() => readWebGuiSessionInfo(session), { allowLan: false, nativeSession: session });
	const context: WebGuiServiceContext = {
		connectionId: crypto.randomUUID(),
		projectId: lease.projectId,
		// The protocol hint is deliberately not the native manager's directory.
		workspacePath: temp.join("stale-workspace"),
		nativeSession: session,
		signal: new AbortController().signal,
	};
	const channel = createWebGuiService("skills", createNativeSkillMethods(context));
	return {
		session,
		list: () => channel.call<SkillsListResult>(context, "list"),
		async close() {
			channel.dispose();
			try {
				await lease.close();
			} finally {
				try {
					await session.dispose();
				} finally {
					authStorage.close();
				}
			}
		},
	};
}

test("Skills.list projects only the owner's loaded catalog, retaining manual skills and native source scopes", async () => {
	using temp = TempDir.createSync("@pi-native-skills-");
	const projectPath = temp.join("project", "skills", "manual", "SKILL.md");
	const userPath = temp.join("profile", "skills", "personal", "SKILL.md");
	const disabledPath = temp.join("project", "skills", "disabled-provider", "SKILL.md");
	await Promise.all([
		writeSkill(projectPath, "manual"),
		writeSkill(userPath, "personal"),
		writeSkill(disabledPath, "disabled-provider"),
	]);
	const f = await fixture(temp, [
		{
			name: "manual",
			description: "Manual instructions",
			filePath: projectPath,
			baseDir: path.dirname(projectPath),
			source: "explicit",
			hide: true,
		},
		{
			name: "personal",
			description: "Personal instructions",
			filePath: userPath,
			baseDir: path.dirname(userPath),
			source: "omp:user",
			_source: { provider: "omp", providerName: "OMP", path: userPath, level: "user" },
		},
	]);
	try {
		const result = await f.list();
		expect(
			result.skills.map(skill => ({
				name: skill.name,
				scope: skill.scope,
				enabled: skill.enabled,
				body: skill.body,
			})),
		).toEqual([
			{ name: "manual", scope: "workspace", enabled: true, body: "manual body" },
			{ name: "personal", scope: "user", enabled: true, body: "personal body" },
		]);
		expect(result.skills[1]?.sourcePath).toBe(userPath);
		expect(result.diagnostics).toEqual([]);
	} finally {
		await f.close();
	}
});

test("Skills.list preserves native phase restrictions and reports unreadable loaded resources without exposing their bodies", async () => {
	using temp = TempDir.createSync("@pi-native-skills-policy-");
	const restrictedPath = temp.join("plugin", "SKILL.md");
	const missingPath = temp.join("project", "missing", "SKILL.md");
	await writeSkill(restrictedPath, "restricted");
	const f = await fixture(temp, [
		{
			name: "restricted",
			description: "Restricted instructions",
			filePath: restrictedPath,
			baseDir: path.dirname(restrictedPath),
			containRoot: temp.join("plugin"),
			source: "bundled-superpowers",
			hide: true,
			_source: {
				provider: "spec-driven",
				providerName: "Spec driven",
				path: restrictedPath,
				level: "native",
				pluginName: "superpowers",
			},
		},
		{
			name: "missing",
			description: "Unavailable instructions",
			filePath: missingPath,
			baseDir: path.dirname(missingPath),
			source: "omp:project",
		},
	]);
	const release = bindSpecSkillPolicy(f.session.sessionManager, {
		phase: "review",
		allowedSkills: ["restricted", "missing"],
	});
	try {
		const result = await f.list();
		expect(result.skills[0]).toMatchObject({
			name: "restricted",
			scope: "plugin",
			pluginName: "superpowers",
			path: restrictedPath,
			enabled: false,
			body: "",
		});
		expect(result.diagnostics).toEqual([
			expect.objectContaining({
				code: "skill_read_failed",
				severity: "warning",
				path: restrictedPath,
				message: expect.stringContaining("exact resource grant required"),
			}),
			expect.objectContaining({ code: "skill_read_failed", severity: "error", path: missingPath }),
		]);
		expect(result.skills[1]?.body).toBe("");
	} finally {
		release();
		await f.close();
	}
});
