import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";
import { type LogEvent, registerLogSink } from "@oh-my-pi/pi-utils/logger";
import { MODEL_ROLE_IDS } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resolveModelRoleValue } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { RpcModelRoleService, type RpcModelRoleServiceDeps } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-fork-models";

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

function serviceFor(
	settings: Settings,
	models: FakeModel[],
	reloadSessionSettings?: RpcModelRoleServiceDeps["reloadSessionSettings"],
) {
	const emitted: object[] = [];
	const registry = {
		getAvailable: () => models,
		find: (provider: string, id: string) => models.find(model => model.provider === provider && model.id === id),
	} as unknown as ModelRegistry;
	const service = new RpcModelRoleService({
		getSettings: () => settings,
		getModelRegistry: () => registry,
		emit: frame => emitted.push(frame),
		reloadSessionSettings,
	});
	return { service, emitted };
}

async function setup(
	models: FakeModel[] = [],
	projectValue?: string,
	reloadSessionSettings?: RpcModelRoleServiceDeps["reloadSessionSettings"],
) {
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
	return { ...serviceFor(settings, models, reloadSessionSettings), settings, cwd, agentDir, configFile };
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

function captureRoleWriteLogs() {
	const events: LogEvent[] = [];
	const dispose = registerLogSink(event => {
		if (event.context?.component === "rpc_model_roles" && event.context.event === "model_role_set") {
			events.push(event);
		}
	});
	return { events, dispose };
}

function expectRoleWriteLogs(
	events: LogEvent[],
	reloadResult: "completed" | "degraded" | "skipped",
	failedStage?: "settings_reload" | "plan_refresh",
) {
	const operationId = events[0]?.context?.operation_id;
	expect(operationId).toEqual(expect.stringMatching(/^rpc-role-/));
	for (const event of events) {
		expect(event.context?.operation_id).toBe(operationId);
		expect(event.context?.elapsed_ms).toEqual(expect.any(Number));
		expect(event.context?.elapsed_ms as number).toBeGreaterThanOrEqual(0);
	}
	expect(events[0]?.context).toMatchObject({
		stage: "queue",
		result: "started",
		persisted: false,
	});
	expect(events.filter(event => event.context?.stage === "save").map(event => event.context?.result)).toEqual([
		"started",
		"completed",
	]);
	const reloadEvents = events.filter(event => event.context?.stage === "reload");
	expect(reloadEvents).toHaveLength(2);
	expect(reloadEvents[0]?.context).toMatchObject({
		result: "started",
		persisted: true,
		reload_available: reloadResult !== "skipped",
	});
	expect(reloadEvents[1]).toMatchObject({
		level: reloadResult === "degraded" ? "warn" : "info",
		context: {
			result: reloadResult,
			persisted: true,
			reload_available: reloadResult !== "skipped",
			...(failedStage ? { failed_stage: failedStage } : {}),
		},
	});
	expect(events.filter(event => event.context?.stage === "emit").map(event => event.context?.result)).toEqual([
		"started",
		"completed",
	]);
	expect(events.at(-1)).toMatchObject({
		level: "info",
		context: {
			stage: "read",
			result: "completed",
			persisted: true,
			committed: true,
			commit_status: "committed",
			reload_result: reloadResult,
		},
	});
	expect(events.some(event => event.level === "error")).toBe(false);
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
		const { events, dispose } = captureRoleWriteLogs();
		try {
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
			expectRoleWriteLogs(events, "skipped");
			expect(JSON.stringify(events)).not.toContain(fx.configFile);
		} finally {
			dispose();
		}
	});

	test.each(["settings_reload", "plan_refresh"] as const)(
		"a degraded %s reload preserves the committed role and settings notification",
		async failedStage => {
			const inputCanary = "ROLE_RELOAD_INPUT_CANARY";
			const bodyCanary = "ROLE_RELOAD_BODY_CANARY";
			const model = { ...CHAT_MODEL, id: inputCanary, name: bodyCanary };
			let reloadCalls = 0;
			const fx = await setup([model], undefined, async () => {
				reloadCalls++;
				return { result: "degraded", failed_stage: failedStage };
			});
			const revision = await roleRevision(fx.service, "default");
			const { events, dispose } = captureRoleWriteLogs();
			try {
				const result = await fx.service.setRole({
					roleId: "default",
					scope: "user",
					selection: { kind: "model", model: { provider: model.provider, modelId: model.id } },
					expectedRevision: revision,
				});
				expect(reloadCalls).toBe(1);
				expect(result.persisted).toBe(true);
				expect(result.effectiveNote).toBeUndefined();
				expect(result.role).toMatchObject({
					userValue: `p/${inputCanary}`,
					source: "global",
					effectiveModel: { provider: "p", modelId: inputCanary },
				});
				expect(result.role.revision).not.toBe(revision);
				expect(fx.settings.getGlobalModelRole("default")).toBe(`p/${inputCanary}`);
				expect(await Bun.file(fx.configFile).text()).toContain(`p/${inputCanary}`);
				const reloaded = await Settings.loadIsolated({ cwd: fx.cwd, agentDir: fx.agentDir });
				isolatedSettings.push(reloaded);
				expect(reloaded.getGlobalModelRole("default")).toBe(`p/${inputCanary}`);
				expect(fx.emitted).toEqual([{ type: "settings_changed", scope: "user" }]);
				expectRoleWriteLogs(events, "degraded", failedStage);
				const serialized = JSON.stringify(events);
				for (const sensitive of [inputCanary, bodyCanary, fx.configFile, fx.cwd, fx.agentDir]) {
					expect(serialized).not.toContain(sensitive);
				}
			} finally {
				dispose();
			}
		},
	);

	test("model validation, role acceptance and scope checks write nothing", async () => {
		const fx = await setup([CHAT_MODEL, IMAGE_MODEL]);
		const errorCanary = "ROLE_VALIDATION_ERROR_INPUT_CANARY";
		const { events, dispose } = captureRoleWriteLogs();
		try {
			for (const modelId of [errorCanary, "img"]) {
				await expect(
					fx.service.setRole({
						roleId: "default",
						scope: "user",
						selection: { kind: "model", model: { provider: "p", modelId } },
						expectedRevision: await roleRevision(fx.service, "default"),
					}),
				).rejects.toMatchObject({ code: "invalid_params" });
			}
			const refused = events.filter(event => event.context?.result === "refused");
			expect(refused).toHaveLength(2);
			for (const event of refused) {
				expect(event).toMatchObject({
					level: "info",
					context: {
						stage: "validate",
						persisted: false,
						rpc_error_code: "invalid_params",
						error_type: "RpcModelRoleError",
					},
				});
			}
			expect(JSON.stringify(events)).not.toContain(errorCanary);
			expect(JSON.stringify(events)).not.toContain("Model not available:");
		} finally {
			dispose();
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
				roleId: "invalid/role",
				scope: "user",
				selection: null,
				expectedRevision: await roleRevision(fx.service, "default"),
			}),
		).rejects.toMatchObject({ code: "invalid_params" });
		expect(fx.settings.getGlobalModelRole("default")).toBeUndefined();
		expect((await fx.service.listRoles()).roles.find(role => role.roleId === "image")!.candidateModels).toEqual([
			{ provider: "p", modelId: "img" },
		]);
	});

	test("unconfigured custom role exposes a server revision and persists through the shared CAS writer", async () => {
		const fx = await setup([CHAT_MODEL]);
		const before = await fs.readFile(fx.configFile, "utf8");
		const draft = (await fx.service.listRoles({ roleId: "custom_reviewer" })).roles.find(
			role => role.roleId === "custom_reviewer",
		)!;
		expect(draft.userValue).toBeNull();
		expect(draft.revision).toBeTruthy();
		expect(await fs.readFile(fx.configFile, "utf8")).toBe(before);
		await fx.service.setRole({
			roleId: draft.roleId,
			scope: "user",
			expectedRevision: draft.revision,
			selection: { kind: "model", model: { provider: "p", modelId: "m" } },
		});
		expect(fx.settings.getGlobalModelRole("custom_reviewer")).toBe("p/m");
		await expect(
			fx.service.setRole({ roleId: draft.roleId, scope: "user", expectedRevision: draft.revision, selection: null }),
		).rejects.toMatchObject({ code: "revision_conflict" });
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

	test("automatic advisor selection clears its assignment and preserves the upstream slow-role fallback", async () => {
		const fx = await setup([CHAT_MODEL, OTHER_CHAT_MODEL]);
		for (const [roleId, modelId] of [
			["default", "m"],
			["slow", "m2"],
			["advisor", "m"],
		] as const) {
			await fx.service.setRole({
				roleId,
				scope: "user",
				selection: { kind: "model", model: { provider: "p", modelId } },
				expectedRevision: await roleRevision(fx.service, roleId),
			});
		}
		const revision = await roleRevision(fx.service, "advisor");
		const automatic = await fx.service.setRole({
			roleId: "advisor",
			scope: "user",
			selection: { kind: "auto" },
			expectedRevision: revision,
		});

		expect(automatic.persisted).toBe(true);
		expect(automatic.role.userValue).toBeNull();
		expect(automatic.role.source).toBe("default");
		expect(automatic.role.revision).not.toBe(revision);
		expect(automatic.role.explicitValue).toBeUndefined();
		const reloaded = await Settings.loadIsolated({ cwd: fx.cwd, agentDir: fx.agentDir });
		isolatedSettings.push(reloaded);
		expect(reloaded.getGlobalModelRole("advisor")).toBeUndefined();
		const resolved = resolveModelRoleValue("@advisor", [CHAT_MODEL, OTHER_CHAT_MODEL] as unknown as Model[], {
			settings: reloaded,
		});
		expect(resolved.model?.id).toBe("m2");
		expect(reloaded.getGlobalModelRole("default")).toBe("p/m");
	});

	test("lists a persisted default-role alias as automatic rather than an unmatched model", async () => {
		const fx = await setup([CHAT_MODEL]);
		await fx.settings.saveUserModelRole("default", "*", undefined);
		const reloaded = await Settings.loadIsolated({ cwd: fx.cwd, agentDir: fx.agentDir });
		isolatedSettings.push(reloaded);
		const { service } = serviceFor(reloaded, [CHAT_MODEL]);
		const role = (await service.listRoles()).roles.find(candidate => candidate.roleId === "default")!;
		expect(role.userValue).toBe("*");
		expect(role.effectiveModel).toBeUndefined();
		expect(role.unresolvedReason).toBe("auto");
	});

	test("a configured image role cannot report a chat model as its effective model", async () => {
		const settings = Settings.isolated();
		settings.overrideModelRoles({ image: "p/chat-only" });
		const { service } = serviceFor(settings, [{ ...CHAT_MODEL, id: "chat-only" }, IMAGE_MODEL]);
		const role = (await service.listRoles()).roles.find(candidate => candidate.roleId === "image")!;

		expect(role.candidateModels).toEqual([{ provider: "p", modelId: "img" }]);
		expect(role.effectiveModel).toBeUndefined();
		expect(role.unresolvedReason).toBe("no_matching_model");
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
		let reloadCalls = 0;
		const fx = await setup([CHAT_MODEL], undefined, async () => {
			reloadCalls++;
		});
		const revision = await roleRevision(fx.service, "default");
		await writeInAnotherProcess(fx.cwd, fx.agentDir, "smol", "p/m");
		const { events, dispose } = captureRoleWriteLogs();
		try {
			const result = await fx.service.setRole({
				roleId: "default",
				scope: "user",
				selection: { kind: "model", model: { provider: "p", modelId: "m" } },
				expectedRevision: revision,
			});
			expect(result.persisted).toBe(true);
			expect(fx.settings.getGlobalModelRole("smol")).toBe("p/m");
			expect(fx.settings.getGlobalModelRole("default")).toBe("p/m");
			expect(fx.emitted).toEqual([{ type: "settings_changed", scope: "user" }]);
			expect(reloadCalls).toBe(1);
			expectRoleWriteLogs(events, "completed");
		} finally {
			dispose();
		}
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
