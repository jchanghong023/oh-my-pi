// Unit coverage for RpcProjectModelRoleService (rpc-project-models.ts, R6):
// the zero-session model-role catalog (O24: zero models never hide roles),
// user-scope persistence with registry validation, revision conflicts, and
// the settings_changed fan-out. The wire-level flow is covered end-to-end by
// rpc-project-protocol.test.ts.

import { beforeAll, describe, expect, test } from "bun:test";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { RpcProjectModelRoleService } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-project-models";

let globalSettingsReady: Promise<unknown> | undefined;

beforeAll(async () => {
	// Role persistence and settings access route through the process-global
	// settings singleton; tests initialize it in memory (never touches the
	// user's real config). Same memoized shape as rpc-fork-config.test.ts.
	globalSettingsReady ??= Settings.init({ inMemory: true });
	await globalSettingsReady;
});

/**
 * Minimal Model-like fixture: role resolution and the service only read
 * provider/id (plus `kind` through the role acceptance predicate, where an
 * omitted kind falls back to "chat").
 */
interface FakeModel {
	provider: string;
	id: string;
	name: string;
	kind?: string;
}

const CHAT_MODEL: FakeModel = { provider: "p", id: "m", name: "Probe Chat Model" };
const IMAGE_MODEL: FakeModel = { provider: "p", id: "img", name: "Probe Image Model", kind: "image" };

/** The 15 built-in role ids every catalog must list (MODEL_ROLES keys). */
const BUILTIN_ROLE_IDS = [
	"default",
	"smol",
	"slow",
	"vision",
	"plan",
	"commit",
	"tiny",
	"memory",
	"task",
	"advisor",
	"image",
	"web",
	"speech",
	"dictation",
	"judge",
];

interface Fixture {
	service: RpcProjectModelRoleService;
	settings: Settings;
	emitted: object[];
}

/** Fresh isolated settings plus a registry-backed service per test. */
function setup(models: FakeModel[] = []): Fixture {
	const settings = Settings.isolated();
	const emitted: object[] = [];
	// The service calls getAvailable("all") for resolution and validation;
	// `find` only reaches the shared formatting helper when a stored value
	// carries an explicit thinking suffix.
	const registry = {
		getAvailable: () => models,
		find: (provider: string, id: string) => models.find(model => model.provider === provider && model.id === id),
	} as unknown as ModelRegistry;
	const service = new RpcProjectModelRoleService({
		getSettings: () => settings,
		getModelRegistry: () => registry,
		emit: frame => emitted.push(frame),
	});
	return { service, settings, emitted };
}

describe("RpcProjectModelRoleService (rpc-project-models, R6)", () => {
	test("listRoles lists every built-in role even with empty settings and zero models (O24)", async () => {
		const { service } = setup();
		const result = await service.listRoles();

		expect(result.roles.map(role => role.roleId).sort()).toEqual([...BUILTIN_ROLE_IDS].sort());
		expect(result.roles).toHaveLength(BUILTIN_ROLE_IDS.length);
		expect(result.revision).toBe(service.revision);

		for (const role of result.roles) {
			expect(role.configurable).toBe(true);
			expect(role.source).toBe("default");
			expect(role.explicitValue).toBeUndefined();
			expect(role.effectiveModel).toBeUndefined();
			expect(role.unresolvedReason).toBe("not_configured");
			expect(role.writableScopes).toEqual(["user"]);
			expect(role.hidden).toBe(false);
			expect(role.revision).toBe(result.revision);
			expect(["chat", "kind"]).toContain(role.section);
		}

		const byId = new Map(result.roles.map(role => [role.roleId, role]));
		expect(byId.get("default")).toMatchObject({ name: "Default", section: "chat" });
		expect(byId.get("image")).toMatchObject({ name: "Image generation", section: "kind" });
	}, 10_000);

	test("setRole persists a registry-backed selection to user scope and emits settings_changed", async () => {
		const { service, settings, emitted } = setup([CHAT_MODEL]);
		const result = await service.setRole({
			roleId: "default",
			scope: "user",
			selection: { kind: "model", model: { provider: "p", modelId: "m" } },
		});

		expect(result.persisted).toBe(true);
		expect(result.revision).toBe(service.revision);
		expect(settings.getModelRole("default")).toContain("p/m");

		const role = result.role;
		expect(role.roleId).toBe("default");
		expect(role.explicitValue).toContain("p/m");
		expect(role.source).toBe("global");
		expect(role.effectiveModel).toEqual({ provider: "p", modelId: "m" });
		expect(result.effectiveNote).toBeUndefined(); // the saved value simply took effect

		expect(emitted.at(-1)).toMatchObject({ type: "settings_changed", scope: "user" });
	}, 10_000);

	test("setRole rejects models missing from the registry or unfitting for the role", async () => {
		const { service, settings } = setup([CHAT_MODEL]);
		await expect(
			service.setRole({
				roleId: "default",
				scope: "user",
				selection: { kind: "model", model: { provider: "p", modelId: "missing" } },
			}),
		).rejects.toMatchObject({ name: "RpcProjectModelRoleError", code: "invalid_params" });

		// Present in the registry but rejected by the role's acceptance
		// predicate: an image-kind model cannot serve the chat "default" role.
		const image = setup([IMAGE_MODEL]);
		await expect(
			image.service.setRole({
				roleId: "default",
				scope: "user",
				selection: { kind: "model", model: { provider: "p", modelId: "img" } },
			}),
		).rejects.toMatchObject({ code: "invalid_params" });

		// Neither rejection persisted anything.
		expect(settings.getModelRole("default")).toBeUndefined();
		expect(image.settings.getModelRole("default")).toBeUndefined();
	}, 10_000);

	test("setRole with a null selection clears the explicit user value", async () => {
		const { service, settings, emitted } = setup([CHAT_MODEL]);
		await service.setRole({
			roleId: "smol",
			scope: "user",
			selection: { kind: "model", model: { provider: "p", modelId: "m" } },
		});
		expect(settings.getModelRole("smol")).toContain("p/m");

		const cleared = await service.setRole({ roleId: "smol", scope: "user", selection: null });
		expect(cleared.persisted).toBe(true);
		expect(settings.getModelRole("smol")).toBeUndefined();
		expect(cleared.role.source).toBe("default");
		expect(cleared.role.explicitValue).toBeUndefined();
		expect(cleared.role.unresolvedReason).toBe("not_configured");
		expect(emitted.filter(frame => (frame as { type: string }).type === "settings_changed")).toHaveLength(2);
	}, 10_000);

	test("expectedRevision guards writes: stale values conflict, the current revision passes", async () => {
		const { service, settings } = setup([CHAT_MODEL]);
		const initial = service.revision;

		// Reads never bump the catalog revision (it is the service's own
		// revision source, not the settings revision).
		const read = await service.listRoles();
		expect(read.revision).toBe(initial);

		await expect(
			service.setRole({
				roleId: "default",
				scope: "user",
				selection: { kind: "model", model: { provider: "p", modelId: "m" } },
				expectedRevision: "stale-revision",
			}),
		).rejects.toMatchObject({ code: "revision_conflict" });
		expect(settings.getModelRole("default")).toBeUndefined(); // the conflict wrote nothing

		const ok = await service.setRole({
			roleId: "default",
			scope: "user",
			selection: { kind: "model", model: { provider: "p", modelId: "m" } },
			expectedRevision: initial,
		});
		expect(ok.persisted).toBe(true);
		expect(ok.revision).not.toBe(initial);

		// The pre-write revision is stale after the successful write.
		await expect(
			service.setRole({ roleId: "default", scope: "user", selection: null, expectedRevision: initial }),
		).rejects.toMatchObject({ code: "revision_conflict" });
		expect(settings.getModelRole("default")).toContain("p/m");
	}, 10_000);

	test("setRole rejects unknown role ids with not_found", async () => {
		const { service, settings } = setup([CHAT_MODEL]);
		await expect(
			service.setRole({
				roleId: "definitely-not-a-role",
				scope: "user",
				selection: { kind: "model", model: { provider: "p", modelId: "m" } },
			}),
		).rejects.toMatchObject({ name: "RpcProjectModelRoleError", code: "not_found" });
		expect(settings.getModelRoles()).toEqual({});
	}, 10_000);

	test("listRoles reflects persisted explicit values with global provenance", async () => {
		const { service } = setup([CHAT_MODEL]);
		await service.setRole({
			roleId: "default",
			scope: "user",
			selection: { kind: "model", model: { provider: "p", modelId: "m" } },
		});

		const result = await service.listRoles();
		const row = result.roles.find(role => role.roleId === "default");
		expect(row).toBeDefined();
		expect(row!.configurable).toBe(true);
		expect(row!.explicitValue).toContain("p/m");
		expect(row!.source).toBe("global");
		expect(row!.effectiveModel).toEqual({ provider: "p", modelId: "m" });
		expect(row!.unresolvedReason).toBeUndefined();

		// Sibling roles stay unconfigured.
		const smol = result.roles.find(role => role.roleId === "smol");
		expect(smol!.explicitValue).toBeUndefined();
		expect(smol!.unresolvedReason).toBe("not_configured");
		expect(smol!.source).toBe("default");
	}, 10_000);
});
