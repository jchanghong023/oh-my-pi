import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";
import {
	LegacyProtocol,
	workspaceConfigTopicWireFrameSchema,
	zcodeSessionConfigureResultSchema,
} from "../../src/modes/zcode/schema";
import { command, create, fixture, ProcessPeer, workspace } from "./zcode-process-harness";

async function roles(peer: ProcessPeer, sessionId: string, roleId?: string) {
	const result = zcodeSessionConfigureResultSchema.parse(
		await peer.request("session/configure", {
			sessionId,
			operation: "get_model_roles",
			...(roleId ? { roleId } : {}),
		}),
	);
	if (result.operation !== "get_model_roles") throw new Error("Expected role catalog");
	return result.data;
}

describe("native model role configuration protocol", () => {
	test("an empty native workspace catalog stays empty without creating sessions or requesting Host providers", async () => {
		await using root = await TempDir.create("@zcode-empty-model-catalog-");
		await using config = await fixture(root);
		await fs.writeFile(
			path.join(config.agentDir, "config.yml"),
			JSON.stringify({
				disabledProviders: ["company", "codeagent", "ascend", "opencode-go", "deepseek", "openai-codex"],
				tools: { xdev: false },
				skills: { enabled: false },
			}),
		);
		await using peer = new ProcessPeer(config.cwdA, config.env);
		await peer.ready();
		const topic = `workspace-config/${config.cwdA}`;
		await peer.request("v4/conversation/subscribe", {
			topic,
			connectionId: "empty-native-models",
			clientMode: "desktop-continuous",
			workspace: workspace(config.cwdA),
		});
		const notification = await peer.next(
			frame => frame.method === "v4/conversation/frame" && isRecord(frame.params) && frame.params.topic === topic,
		);
		const wire = workspaceConfigTopicWireFrameSchema.parse(notification.params);
		if (wire.kind !== "complete" || wire.frame.payload.kind !== "snapshot")
			throw new Error("Expected native workspace snapshot");
		const model = wire.frame.payload.snapshot.config.configOptions.find(option => option.id === "model");
		expect(model?.options ?? []).toEqual([]);
		expect(
			LegacyProtocol.zcodeSessionListResultSchema.parse(await peer.request("session/list", {})).sessions,
		).toEqual([]);
		expect(config.requests).toEqual([]);
		expect(peer.seen.some(frame => frame.method === "interaction/requestProviderRuntimeHeaders")).toBe(false);
	}, 120_000);

	// Invalid routing and Team operations must reject before creating or writing any session/config.
	test("requires a nonempty session and exposes only role operations", async () => {
		await using root = await TempDir.create("@zcode-role-boundary-");
		await using config = await fixture(root);
		await using peer = new ProcessPeer(config.cwdA, config.env);
		await peer.ready();
		const before = await fs.readFile(path.join(config.agentDir, "config.yml"), "utf8");
		const sessions = await peer.request("session/list", {});
		for (const params of [
			{ operation: "get_model_roles" },
			{ operation: "get_model_roles", sessionId: "" },
			{
				operation: "set_model_role",
				roleId: "default",
				scope: "user",
				expectedRevision: "untrusted",
				selection: null,
			},
		]) {
			expect((await peer.requestFrame("session/configure", params)).error).toMatchObject({ code: -32602 });
		}
		expect(await peer.request("session/list", {})).toEqual(sessions);
		const sessionId = await create(peer, config.cwdA);
		const residentSessions = await peer.request("session/list", {});
		const catalog = await roles(peer, sessionId, "unconfigured_custom");
		expect(catalog.roles.find(role => role.roleId === "unconfigured_custom")).toMatchObject({
			userValue: null,
			writableScopes: ["user"],
			revision: expect.stringMatching(/^role-/),
		});
		expect(catalog.sessionModel).toMatchObject({ model: { provider: "deepseek", modelId: "chat-a" } });
		for (const request of [
			{ operation: "get_team_config" },
			{ operation: "get_team_models" },
			{ operation: "set_team_config", scope: "user", expectedRevision: "untrusted", members: [] },
		]) {
			expect((await peer.requestFrame("session/configure", { sessionId, ...request })).error).toMatchObject({
				code: -32602,
			});
		}
		expect(await peer.request("session/list", {})).toEqual(residentSessions);
		expect(await fs.readFile(path.join(config.agentDir, "config.yml"), "utf8")).toBe(before);
		expect(config.requests).toEqual([]);
	}, 120_000);

	// The semantic scope error is part of the public wire contract, not just the private service.
	test("rejects a non-user role write with scope_not_allowed and leaves all settings untouched", async () => {
		await using root = await TempDir.create("@zcode-role-scope-");
		await using config = await fixture(root);
		await using peer = new ProcessPeer(config.cwdA, config.env);
		await peer.ready();
		const sessionId = await create(peer, config.cwdA);
		const catalog = await roles(peer, sessionId);
		const role = catalog.roles.find(candidate => candidate.roleId === "default");
		if (!role) throw new Error("Default role is absent");
		const before = await fs.readFile(path.join(config.agentDir, "config.yml"), "utf8");
		const notifications = peer.seen.filter(frame => frame.method === "settings_changed").length;
		for (const scope of ["project", "overlay", "runtime"]) {
			const result = await peer.requestFrame("session/configure", {
				sessionId,
				operation: "set_model_role",
				roleId: "default",
				scope,
				expectedRevision: role.revision,
				selection: { kind: "model", model: { provider: "deepseek", modelId: "chat-b" } },
			});
			expect(result.error).toMatchObject({ code: expect.any(Number), data: { code: "scope_not_allowed" } });
		}
		expect(await fs.readFile(path.join(config.agentDir, "config.yml"), "utf8")).toBe(before);
		expect((await roles(peer, sessionId)).roles).toEqual(catalog.roles);
		expect(peer.seen.filter(frame => frame.method === "settings_changed")).toHaveLength(notifications);
		expect(config.requests).toEqual([]);
	}, 120_000);

	// A successful save must invalidate other resident clones before its reply, not after a watcher tick.
	test("a saved role is immediately visible in every resident session without switching its temporary model", async () => {
		await using root = await TempDir.create("@zcode-resident-role-reload-");
		await using config = await fixture(root);
		await using peer = new ProcessPeer(config.cwdA, config.env);
		await peer.ready();
		const a = await create(peer, config.cwdA);
		const b = await create(peer, config.cwdB);
		const beforeA = await roles(peer, a);
		const beforeB = await roles(peer, b);
		const plan = beforeA.roles.find(role => role.roleId === "plan");
		if (!plan) throw new Error("Plan role is absent");
		const result = await peer.request("session/configure", {
			sessionId: a,
			operation: "set_model_role",
			roleId: "plan",
			scope: "user",
			expectedRevision: plan.revision,
			selection: { kind: "model", model: { provider: "deepseek", modelId: "chat-b" } },
		});
		expect(result).toMatchObject({ operation: "set_model_role", data: { persisted: true } });
		const afterA = await roles(peer, a);
		const afterB = await roles(peer, b);
		for (const current of [afterA, afterB]) {
			expect(current.roles.find(role => role.roleId === "plan")).toMatchObject({
				userValue: "deepseek/chat-b",
				effectiveModel: { provider: "deepseek", modelId: "chat-b" },
				source: "global",
			});
		}
		expect(afterA.sessionModel).toEqual(beforeA.sessionModel);
		expect(afterB.sessionModel).toEqual(beforeB.sessionModel);
		expect(config.requests).toEqual([]);
	}, 120_000);

	test("saving the plan role immediately re-resolves the active plan model", async () => {
		await using root = await TempDir.create("@zcode-active-plan-role-");
		await using config = await fixture(root);
		await using peer = new ProcessPeer(config.cwdA, config.env);
		await peer.ready();
		const sessionId = await create(peer, config.cwdA);
		expect(await command(peer, sessionId, "switchCollaborationMode", { mode: "plan" })).toMatchObject({
			status: "accepted",
		});
		const read = async () =>
			LegacyProtocol.zcodeSessionStateSnapshotSchema.parse(await peer.request("session/read", { sessionId }));
		expect((await read()).settings.model.current).toMatchObject({ providerId: "deepseek", modelId: "chat-a" });
		expect((await read()).settings.mode.current).toBe("plan");
		const plan = (await roles(peer, sessionId)).roles.find(role => role.roleId === "plan");
		if (!plan) throw new Error("Plan role is absent");
		const saved = await peer.request("session/configure", {
			sessionId,
			operation: "set_model_role",
			roleId: "plan",
			scope: "user",
			expectedRevision: plan.revision,
			selection: { kind: "model", model: { provider: "deepseek", modelId: "chat-b" } },
		});
		expect(saved).toMatchObject({ operation: "set_model_role", data: { persisted: true } });
		expect((await read()).settings.model.current).toMatchObject({ providerId: "deepseek", modelId: "chat-b" });
		expect(config.requests).toEqual([]);
	}, 120_000);
});
