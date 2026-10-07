import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { MODEL_ROLE_IDS } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { RpcModelRoleService } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-fork-models";

beforeAll(() => Settings.init({ inMemory: true }));
const temporaryDirectories: TempDir[] = [];
const isolatedSettings: Settings[] = [];
afterEach(async () => {
	for (const settings of isolatedSettings.splice(0)) settings.cancelPendingSaves();
	AgentStorage.close();
	for (const directory of temporaryDirectories.splice(0)) await directory.remove();
});

interface FakeModel {
	provider: string;
	id: string;
	name: string;
	kind?: string;
}
const CHAT_MODEL: FakeModel = { provider: "p", id: "m", name: "Probe Chat Model" };
const OTHER_CHAT_MODEL: FakeModel = { provider: "p", id: "m2", name: "Other Chat Model" };
const IMAGE_MODEL: FakeModel = { provider: "p", id: "img", name: "Probe Image Model", kind: "image" };

function serviceFor(settings: Settings, models: FakeModel[]) {
	const emitted: object[] = [];
	const registry = {
		getAvailable: () => models,
		find: (provider: string, id: string) => models.find(model => model.provider === provider && model.id === id),
	} as unknown as ModelRegistry;
	const service = new RpcModelRoleService({
		getSettings: () => settings,
		getModelRegistry: () => registry,
		emit: frame => emitted.push(frame),
	});
	return { service, emitted };
}

async function setup(models: FakeModel[] = [], projectValue?: string) {
	const root = await TempDir.create("@rpc-role-disk-");
	temporaryDirectories.push(root);
	const cwd = root.join("project");
	const agentDir = root.join("agent");
	await fs.mkdir(cwd, { recursive: true });
	await fs.mkdir(agentDir, { recursive: true });
	const configFile = path.join(agentDir, "config.yml");
	await fs.writeFile(configFile, "modelRoles: {}\n");
	if (projectValue) {
		await fs.mkdir(path.join(cwd, ".omp"));
		await fs.writeFile(path.join(cwd, ".omp", "config.yml"), `modelRoles:\n  default: ${projectValue}\n`);
	}
	const settings = await Settings.loadIsolated({ cwd, agentDir });
	isolatedSettings.push(settings);
	return { ...serviceFor(settings, models), settings, cwd, agentDir, configFile };
}

async function roleRevision(service: RpcModelRoleService, roleId: string) {
	return (await service.listRoles()).roles.find(role => role.roleId === roleId)!.revision;
}

async function writeInAnotherProcess(cwd: string, agentDir: string, role: string, value: string) {
	const settingsModule = path.resolve(import.meta.dir, "../src/config/settings.ts");
	const script = `import { Settings } from ${JSON.stringify(settingsModule)}; const s = await Settings.loadIsolated(${JSON.stringify({ cwd, agentDir })}); await s.saveUserModelRole(${JSON.stringify(role)}, ${JSON.stringify(value)}, undefined); s.cancelPendingSaves();`;
	const child = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
	const [exitCode, stderr] = await Promise.all([
		child.exited,
		new Response(child.stderr).text(),
		new Response(child.stdout).text(),
	]);
	expect(stderr).not.toContain("error:");
	expect(exitCode).toBe(0);
}

describe("RpcModelRoleService", () => {
	test("empty accounts/settings still expose all built-in roles and user-only write capabilities", async () => {
		const { service } = await setup();
		const result = await service.listRoles();
		expect(result.roles.map(role => role.roleId).sort()).toEqual([...MODEL_ROLE_IDS].sort());
		for (const role of result.roles) {
			expect(role.configurable).toBe(true);
			expect(role.source).toBe("default");
			expect(role.userValue).toBeNull();
			expect(role.projectValue).toBeNull();
			expect(role.explicitValue).toBeUndefined();
			expect(role.effectiveModel).toBeUndefined();
			expect(role.candidateModels).toEqual([]);
			expect(role.writableScopes).toEqual(["user"]);
			expect(role.revision).toStartWith("role-");
		}
	});

	test("reports persisted only after an actual user config write", async () => {
		const fx = await setup([CHAT_MODEL]);
		const result = await fx.service.setRole({
			roleId: "default",
			scope: "user",
			selection: { kind: "model", model: { provider: "p", modelId: "m" } },
			expectedRevision: await roleRevision(fx.service, "default"),
		});
		expect(result.persisted).toBe(true);
		expect(await Bun.file(fx.configFile).text()).toContain("p/m");
		const reloaded = await Settings.loadIsolated({ cwd: fx.cwd, agentDir: fx.agentDir });
		isolatedSettings.push(reloaded);
		expect(reloaded.getGlobalModelRole("default")).toBe("p/m");
		expect(result.role).toMatchObject({
			userValue: "p/m",
			source: "global",
			effectiveModel: { provider: "p", modelId: "m" },
		});
		expect(result.effectiveNote).toBeUndefined();
		expect(fx.emitted.at(-1)).toMatchObject({ type: "settings_changed", scope: "user" });
	});

	test("model validation, role acceptance and scope checks write nothing", async () => {
		const fx = await setup([CHAT_MODEL, IMAGE_MODEL]);
		for (const modelId of ["missing", "img"]) {
			await expect(
				fx.service.setRole({
					roleId: "default",
					scope: "user",
					selection: { kind: "model", model: { provider: "p", modelId } },
					expectedRevision: await roleRevision(fx.service, "default"),
				}),
			).rejects.toMatchObject({ code: "invalid_params" });
		}
		const malformedSelections: unknown[] = [
			undefined,
			"model",
			{ kind: "model" },
			{ kind: "model", model: {} },
			{ kind: "model", model: { provider: "p", modelId: "m", thinkingLevel: 1 } },
		];
		for (const selection of malformedSelections) {
			await expect(
				fx.service.setRole({
					roleId: "default",
					scope: "user",
					selection: selection as never,
					expectedRevision: await roleRevision(fx.service, "default"),
				}),
			).rejects.toMatchObject({ code: "invalid_params" });
		}
		await expect(
			fx.service.setRole({
				roleId: "default",
				scope: "project" as never,
				selection: null,
				expectedRevision: await roleRevision(fx.service, "default"),
			}),
		).rejects.toMatchObject({ code: "scope_not_allowed" });
		await expect(
			fx.service.setRole({
				roleId: "missing-role",
				scope: "user",
				selection: null,
				expectedRevision: await roleRevision(fx.service, "default"),
			}),
		).rejects.toMatchObject({ code: "not_found" });
		expect(fx.settings.getGlobalModelRole("default")).toBeUndefined();
		expect((await fx.service.listRoles()).roles.find(role => role.roleId === "image")!.candidateModels).toEqual([
			{ provider: "p", modelId: "img" },
		]);
	});

	test("null clears only the user role and preserves higher-precedence project/runtime values", async () => {
		const fx = await setup([CHAT_MODEL, OTHER_CHAT_MODEL], "p/m2");
		fx.settings.overrideModelRoles({ default: "p/m" });
		const saved = await fx.service.setRole({
			roleId: "default",
			scope: "user",
			selection: { kind: "model", model: { provider: "p", modelId: "m2" } },
			expectedRevision: await roleRevision(fx.service, "default"),
		});
		expect(saved.role).toMatchObject({
			userValue: "p/m2",
			projectValue: "p/m2",
			explicitValue: "p/m",
			source: "runtime",
		});
		expect(saved.effectiveNote).toContain("runtime");
		const cleared = await fx.service.setRole({
			roleId: "default",
			scope: "user",
			selection: null,
			expectedRevision: saved.role.revision,
		});
		expect(cleared.persisted).toBe(true);
		expect(cleared.role).toMatchObject({
			userValue: null,
			projectValue: "p/m2",
			explicitValue: "p/m",
			source: "runtime",
		});
		expect(fx.settings.getModelRole("default")).toBe("p/m");
		expect(fx.settings.getProjectModelRole("default")).toBe("p/m2");
	});

	test("revisions are per role and same-role requests serialize their CAS", async () => {
		const fx = await setup([CHAT_MODEL]);
		const defaultRevision = await roleRevision(fx.service, "default");
		const smolRevision = await roleRevision(fx.service, "smol");
		const results = await Promise.allSettled([
			fx.service.setRole({
				roleId: "default",
				scope: "user",
				selection: { kind: "model", model: { provider: "p", modelId: "m" } },
				expectedRevision: defaultRevision,
			}),
			fx.service.setRole({ roleId: "default", scope: "user", selection: null, expectedRevision: defaultRevision }),
			fx.service.setRole({
				roleId: "smol",
				scope: "user",
				selection: { kind: "model", model: { provider: "p", modelId: "m" } },
				expectedRevision: smolRevision,
			}),
		]);
		expect(results[0]!.status).toBe("fulfilled");
		expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "revision_conflict" } });
		expect(results[2]!.status).toBe("fulfilled");
		expect(fx.settings.getGlobalModelRole("default")).toBe("p/m");
		expect(fx.settings.getGlobalModelRole("smol")).toBe("p/m");
	});

	test("cross-process same-role stale writes fail, rather than claiming a skipped save persisted", async () => {
		const fx = await setup([CHAT_MODEL, OTHER_CHAT_MODEL]);
		const revision = await roleRevision(fx.service, "default");
		await writeInAnotherProcess(fx.cwd, fx.agentDir, "default", "p/m2");
		await expect(
			fx.service.setRole({
				roleId: "default",
				scope: "user",
				selection: { kind: "model", model: { provider: "p", modelId: "m" } },
				expectedRevision: revision,
			}),
		).rejects.toMatchObject({ code: "revision_conflict" });
		expect(fx.settings.getGlobalModelRole("default")).toBe("p/m2");
		expect(fx.emitted).toEqual([]);
		expect(await Bun.file(fx.configFile).text()).toContain("p/m2");
	});

	test("a cross-process different-role write is preserved", async () => {
		const fx = await setup([CHAT_MODEL]);
		const revision = await roleRevision(fx.service, "default");
		await writeInAnotherProcess(fx.cwd, fx.agentDir, "smol", "p/m");
		await fx.service.setRole({
			roleId: "default",
			scope: "user",
			selection: { kind: "model", model: { provider: "p", modelId: "m" } },
			expectedRevision: revision,
		});
		expect(fx.settings.getGlobalModelRole("smol")).toBe("p/m");
		expect(fx.settings.getGlobalModelRole("default")).toBe("p/m");
	});

	test("real disk errors do not stage a role or emit a saved notification", async () => {
		const fx = await setup([CHAT_MODEL]);
		const revision = await roleRevision(fx.service, "default");
		await fs.unlink(fx.configFile);
		await fs.mkdir(fx.configFile);
		await expect(
			fx.service.setRole({
				roleId: "default",
				scope: "user",
				selection: { kind: "model", model: { provider: "p", modelId: "m" } },
				expectedRevision: revision,
			}),
		).rejects.toMatchObject({ code: "persistence_failed" });
		expect(fx.settings.getGlobalModelRole("default")).toBeUndefined();
		expect(fx.emitted).toEqual([]);
		expect((await fs.stat(fx.configFile)).isDirectory()).toBe(true);
	});

	test("in-memory settings cannot falsely claim a persisted write", async () => {
		const settings = Settings.isolated();
		const { service, emitted } = serviceFor(settings, [CHAT_MODEL]);
		await expect(
			service.setRole({
				roleId: "default",
				scope: "user",
				selection: { kind: "model", model: { provider: "p", modelId: "m" } },
				expectedRevision: await roleRevision(service, "default"),
			}),
		).rejects.toMatchObject({ code: "persistence_failed" });
		expect(settings.getGlobalModelRole("default")).toBeUndefined();
		expect(emitted).toEqual([]);
	});
});
