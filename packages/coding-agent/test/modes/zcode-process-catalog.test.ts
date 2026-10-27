import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { fingerprintStaticModels } from "@oh-my-pi/pi-catalog/model-manager";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { getModelDbPath, isRecord, TempDir } from "@oh-my-pi/pi-utils";
import {
	LegacyProtocol,
	conversationTopicWireFrameSchema,
	subscribeAckSchema,
	v4ConversationRowsRangeResultSchema,
	workspaceConfigTopicWireFrameSchema,
	zcodeSessionConfigureResultSchema,
} from "../../src/modes/zcode/schema";
import {
	type Frame,
	model,
	deadline,
	ProcessPeer,
	fixture,
	workspace,
	create,
	command,
	subscribe,
	output,
	finishedOutput,
	retainedModelIo,
} from "./zcode-process-harness";

describe("ZCode actual public app-server process", () => {
	test("workspace catalog stays native before and after resident session initialization without changing its default", async () => {
		await using root = await TempDir.create("@zcode-workspace-catalog-");
		await using config = await fixture(root, true);
		const env = { ...config.env, OMP_OFFLINE: "1" };
		await fs.appendFile(path.join(config.agentDir, "models.yml"), "  azure:\n    apiKey: isolated-catalog-key\n");
		const bundled = getBundledModels("azure");
		expect(bundled.length).toBeGreaterThan(0);
		const staleModels = bundled.map(candidate => buildModel({ ...candidate, name: `Stale cache: ${candidate.id}` }));
		writeModelCache(
			"azure",
			1,
			staleModels,
			false,
			fingerprintStaticModels(bundled),
			getModelDbPath(config.agentDir),
			bundled,
		);
		// 旧构造快路径保留同一批 id 的过期名称；完整离线解析必须应用原生 additive 缓存规则。
		// 用相同隔离配置下的真实 registry 作基准，不能靠行数相等证明 GUI/CLI 元数据一致。
		const reference = Bun.spawn(
			[
				process.execPath,
				"--eval",
				`
					import { ModelRegistry } from ${JSON.stringify(import.meta.resolve("../../src/config/model-registry.ts"))};
					import { discoverAuthStorage } from ${JSON.stringify(import.meta.resolve("../../src/sdk.ts"))};
					const auth = await discoverAuthStorage(${JSON.stringify(config.agentDir)}, {
						cwd: ${JSON.stringify(config.cwdA)}, offline: true,
					});
					try {
						const registry = new ModelRegistry(auth, ${JSON.stringify(path.join(config.agentDir, "models.yml"))}, {
							cacheDbPath: ${JSON.stringify(getModelDbPath(config.agentDir))},
						});
						const constructorRows = registry.getAvailableForProviders(new Set(["azure"]))
							.map(model => ({ value: model.provider + "/" + model.id, name: model.name }))
							.sort((a, b) => a.value.localeCompare(b.value));
						await registry.refresh("offline");
						const offlineRows = registry.getAvailableForProviders(new Set(["azure"]))
							.map(model => ({ value: model.provider + "/" + model.id, name: model.name }))
							.sort((a, b) => a.value.localeCompare(b.value));
						process.stdout.write(JSON.stringify({ constructorRows, offlineRows }));
					} finally {
						auth.close();
					}
				`,
			],
			{ cwd: config.cwdA, env, stdout: "pipe", stderr: "pipe" },
		);
		const [referenceStdout, referenceStderr, referenceExit] = await deadline(
			Promise.all([new Response(reference.stdout).text(), new Response(reference.stderr).text(), reference.exited]),
		);
		expect({ exit: referenceExit, stderr: referenceExit === 0 ? "" : referenceStderr }).toEqual({
			exit: 0,
			stderr: "",
		});
		const { constructorRows, offlineRows } = JSON.parse(referenceStdout) as {
			constructorRows: Array<{ value: string; name: string }>;
			offlineRows: Array<{ value: string; name: string }>;
		};
		expect(constructorRows.map(row => row.value)).toEqual(offlineRows.map(row => row.value));
		expect(offlineRows.length).toBeGreaterThan(0);
		expect(constructorRows).not.toEqual(offlineRows);
		const skillDir = path.join(config.cwdA, ".omp", "skills", "zcode-process-fixture");
		await fs.mkdir(skillDir, { recursive: true });
		await fs.writeFile(
			path.join(skillDir, "SKILL.md"),
			"---\nname: zcode-process-fixture\ndescription: Isolated public process catalog fixture\n---\nReturn the isolated fixture marker.\n",
		);
		await using peer = new ProcessPeer(config.cwdA, env);
		await peer.ready();
		const before = await peer.request("session/list", { workspace: workspace(config.cwdA) });
		const journalFilesBefore = (await fs.readdir(config.configRoot, { recursive: true }))
			.filter(file => file.endsWith(".jsonl"))
			.sort();
		const topic = `workspace-config/${config.cwdA}`;
		expect(
			await peer.request("v4/conversation/subscribe", {
				topic,
				connectionId: "pre-session-catalog",
				clientMode: "desktop-continuous",
				workspace: workspace(config.cwdA),
			}),
		).toMatchObject({ ack: { mode: "snapshot" } });
		const notification = await peer.next(
			frame => frame.method === "v4/conversation/frame" && isRecord(frame.params) && frame.params.topic === topic,
		);
		const physical = workspaceConfigTopicWireFrameSchema.parse(notification.params);
		if (physical.kind !== "complete" || physical.frame.payload.kind !== "snapshot") {
			throw new Error("Isolated workspace catalog did not produce a complete initial snapshot");
		}
		const modelOption = physical.frame.payload.snapshot.config.configOptions.find(option => option.id === "model");
		expect(modelOption?.currentValue).toBe("zcode-fixture/chat-a");
		expect(modelOption?.options).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					value: "zcode-fixture/chat-a",
					modelProviderId: "zcode-fixture",
					modelProviderName: "zcode-fixture",
					origin: "native",
					modelThoughtLevels: ["disabled"],
				}),
				expect.objectContaining({ value: "zcode-fixture/chat-b" }),
			]),
		);
		const workspaceRows = (modelOption?.options ?? [])
			.filter(option => option.modelProviderId === "azure")
			.map(option => ({ value: option.value, name: option.name }))
			.sort((a, b) => a.value.localeCompare(b.value));
		expect(workspaceRows).toEqual(offlineRows);
		const names = physical.frame.payload.snapshot.config.slashCommands.map(item => item.name.replace(/^\//, ""));
		for (const name of [
			"wiki",
			"repo",
			"team",
			"goal-autopilot",
			"jch-workflowzbatch",
			"skill:zcode-process-fixture",
		]) {
			expect(names).toContain(name);
		}
		const catalogParams = { workspace: workspace(config.cwdA) };
		expect(
			await peer.request("workspace/hooks/trustGrant", {
				...catalogParams,
				bundleDigest: "a".repeat(64),
				hookDeclarationDigest: "b".repeat(64),
			}),
		).toEqual({ accepted: false, reasonCode: "workspace_hooks_policy_requires_pretrust" });
		const skills = LegacyProtocol.zcodeSkillsReferenceCatalogResultSchema.parse(
			await peer.request("skills/referenceCatalog", catalogParams),
		);
		expect(skills.authority).toBe("workspace");
		expect(skills.skills).toContainEqual(
			expect.objectContaining({
				name: "zcode-process-fixture",
				enabled: true,
				path: path.join(skillDir, "SKILL.md"),
			}),
		);
		LegacyProtocol.zcodePluginsListResultSchema.parse(await peer.request("plugins/list", catalogParams));
		LegacyProtocol.zcodePluginsOverviewResultSchema.parse(await peer.request("plugins/overview", catalogParams));
		expect(
			LegacyProtocol.zcodePluginsReferenceCatalogResultSchema.parse(
				await peer.request("plugins/referenceCatalog", catalogParams),
			).authority,
		).toBe("workspace");
		for (const method of ["skills/referenceCatalog", "plugins/referenceCatalog"]) {
			const missing = await peer.requestFrame(method, { ...catalogParams, sessionId: "missing-session" });
			expect(missing.error).toMatchObject({ code: -32004 });
		}
		expect(await peer.request("session/list", { workspace: workspace(config.cwdA) })).toEqual(before);
		expect(
			(await fs.readdir(config.configRoot, { recursive: true })).filter(file => file.endsWith(".jsonl")).sort(),
		).toEqual(journalFilesBefore);
		expect(config.requests).toHaveLength(0);
		// resident registry 优先于 workspace-only registry；预热后的 SDK 目录不能退回构造器缓存。
		// 会话临时选 B，workspace default 和完整模型元数据仍应与创建会话前一致。
		const sessionId = await create(peer, config.cwdA, { providerId: model.providerId, modelId: "chat-b" });
		expect(
			await peer.request("v4/conversation/subscribe", {
				topic,
				connectionId: "resident-session-catalog",
				clientMode: "desktop-continuous",
				workspace: workspace(config.cwdA),
			}),
		).toMatchObject({ ack: { mode: "snapshot" } });
		const residentNotification = await peer.next(frame => {
			if (frame.method !== "v4/conversation/frame" || !isRecord(frame.params) || frame.params.topic !== topic)
				return false;
			const wire = workspaceConfigTopicWireFrameSchema.parse(frame.params);
			return wire.kind === "complete" && wire.frame.payload.kind === "snapshot";
		});
		const resident = workspaceConfigTopicWireFrameSchema.parse(residentNotification.params);
		if (resident.kind !== "complete" || resident.frame.payload.kind !== "snapshot") {
			throw new Error("Resident workspace catalog did not produce a complete snapshot");
		}
		const residentModelOption = resident.frame.payload.snapshot.config.configOptions.find(
			option => option.id === "model",
		);
		expect(residentModelOption?.currentValue).toBe("zcode-fixture/chat-a");
		expect(residentModelOption?.options).toEqual(modelOption?.options);
		const residentRows = (residentModelOption?.options ?? [])
			.filter(option => option.modelProviderId === "azure")
			.map(option => ({ value: option.value, name: option.name }))
			.sort((a, b) => a.value.localeCompare(b.value));
		expect(residentRows).toEqual(offlineRows);
		const session = LegacyProtocol.zcodeSessionStateSnapshotSchema.parse(
			await peer.request("session/read", { sessionId }),
		);
		expect(session.settings.model.current).toMatchObject({ providerId: model.providerId, modelId: "chat-b" });
	}, 90_000);

	test("public model IO preference reaches live and future matching sessions without capturing other workspaces", async () => {
		await using root = await TempDir.create("@zcode-model-io-process-");
		await using config = await fixture(root);
		await using peer = new ProcessPeer(config.cwdA, config.env);
		await peer.ready();
		const a = await create(peer, config.cwdA);
		const b = await create(peer, config.cwdB);
		await Promise.all([subscribe(peer, a), subscribe(peer, b)]);
		expect(
			await peer.request("workspace/updateModelIoPreferences", {
				workspace: workspace(config.cwdA),
				preferences: { fullRetentionEnabled: true },
			}),
		).toMatchObject({ fullRetentionEnabled: true, updatedSessionCount: 1 });
		await Promise.all([
			command(peer, a, "sendText", { text: "ZCODE_TEST_CAPTURE_LIVE_A" }),
			command(peer, b, "sendText", { text: "ZCODE_TEST_NO_CAPTURE_B" }),
		]);
		await Promise.all([
			finishedOutput(peer, a, "ZCODE_TEST_CAPTURE_LIVE_A_DONE"),
			finishedOutput(peer, b, "ZCODE_TEST_NO_CAPTURE_B_DONE"),
		]);
		const a2 = await create(peer, config.cwdA);
		await subscribe(peer, a2);
		await command(peer, a2, "sendText", { text: "ZCODE_TEST_CAPTURE_FUTURE_A" });
		await finishedOutput(peer, a2, "ZCODE_TEST_CAPTURE_FUTURE_A_DONE");
		// Public close drains the artifact owner's pending IO; no timing sleeps or private flush seam.
		await Promise.all([
			peer.request("session/close", { sessionId: a }),
			peer.request("session/close", { sessionId: a2 }),
		]);
		const retained = await retainedModelIo(config.configRoot);
		expect(retained.size).toBe(2);
		const records = [...retained.values()].flatMap(contents =>
			contents
				.trim()
				.split("\n")
				.map(line => JSON.parse(line) as Frame),
		);
		for (const [id, marker] of [
			[a, "ZCODE_TEST_CAPTURE_LIVE_A"],
			[a2, "ZCODE_TEST_CAPTURE_FUTURE_A"],
		] as const) {
			const owned = records.filter(record => record.sessionId === id);
			expect(
				owned.some(record => record.type === "provider_payload" && JSON.stringify(record.payload).includes(marker)),
			).toBe(true);
			expect(
				owned.some(
					record => record.type === "model_response" && JSON.stringify(record.message).includes(`${marker}_DONE`),
				),
			).toBe(true);
		}
		expect(
			records.some(record => record.sessionId === b || JSON.stringify(record).includes("ZCODE_TEST_NO_CAPTURE_B")),
		).toBe(false);
		await peer.request("session/resume", { sessionId: a });
		await subscribe(peer, a);
		expect(
			await peer.request("workspace/updateModelIoPreferences", {
				workspace: workspace(config.cwdA),
				preferences: { fullRetentionEnabled: false },
			}),
		).toMatchObject({ fullRetentionEnabled: false, updatedSessionCount: 1 });
		const a3 = await create(peer, config.cwdA);
		await subscribe(peer, a3);
		await Promise.all([
			command(peer, a, "sendText", { text: "ZCODE_TEST_CAPTURE_DISABLED_A" }),
			command(peer, a3, "sendText", { text: "ZCODE_TEST_CAPTURE_DISABLED_FUTURE" }),
		]);
		await Promise.all([
			finishedOutput(peer, a, "ZCODE_TEST_CAPTURE_DISABLED_A_DONE"),
			finishedOutput(peer, a3, "ZCODE_TEST_CAPTURE_DISABLED_FUTURE_DONE"),
		]);
		await Promise.all([a, a3, b].map(sessionId => peer.request("session/close", { sessionId })));
		expect(await retainedModelIo(config.configRoot)).toEqual(retained);
		expect(
			config.requests.some(request =>
				JSON.stringify(request.messages.at(-1)).includes("ZCODE_TEST_CAPTURE_DISABLED_A"),
			),
		).toBe(true);
		expect(
			config.requests.some(request =>
				JSON.stringify(request.messages.at(-1)).includes("ZCODE_TEST_CAPTURE_DISABLED_FUTURE"),
			),
		).toBe(true);
	}, 120_000);
	test("header-only account credentials cross the actual Host reverse-request boundary without persistence or fallback", async () => {
		await using root = await TempDir.create("@zcode-header-auth-");
		await using config = await fixture(root);
		const builtinPath = root.join("builtin-provider.json");
		const personalPath = root.join("personal-provider.json");
		const accountModel = { providerId: "account:test", modelId: "chat-a" };
		await fs.writeFile(
			builtinPath,
			JSON.stringify({
				schemaVersion: 1,
				revision: 1,
				config: {
					providerConfigRules: {
						templateRules: [],
						providerRules: [
							{
								providerId: accountModel.providerId,
								config: {
									group: "zai-family",
									access: {
										type: "zhipu-account",
										accountType: "zai",
										mode: "individual-coding-plan",
										entitled: true,
									},
									api: { type: "openai-chat-completions", baseUrl: config.providerBaseUrl },
									builtinModelIds: [accountModel.modelId, "chat-b"],
								},
							},
						],
					},
					modelConfigRules: {
						modelRules: [],
						modelApiRules: [],
						providerSiteRules: [],
						templateModelRules: [],
						builtinProviderModelRules: [
							{
								providerId: accountModel.providerId,
								config: {
									properties: {
										contextWindow: 8192,
										inputFormat: { supportsText: true, supportsImage: false },
										supportsToolCall: true,
									},
									optionSpecs: { maxOutputTokens: { max: 1024 }, reasoningLevel: { values: ["off"] } },
								},
							},
						],
					},
				},
			}),
		);
		await fs.writeFile(
			personalPath,
			JSON.stringify({
				schemaVersion: 1,
				config: {
					providerConfigRules: { providerRules: [] },
					modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
				},
			}),
		);
		config.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = builtinPath;
		config.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = personalPath;
		const secret = `fixture-request-only-${crypto.randomUUID()}`;
		let authMode: "allow" | "deny" | "hold" = "allow";
		await using peer = new ProcessPeer(config.cwdA, config.env);
		peer.reverseReply = frame => {
			if (frame.method !== "interaction/requestProviderRuntimeHeaders") return undefined;
			const params = LegacyProtocol.zcodeProviderRuntimeHeadersRequestParamsSchema.parse(frame.params);
			expect(params.providerId).toBe(accountModel.providerId);
			expect(params.workspace).toEqual(workspace(config.cwdA));
			if (authMode === "hold") return undefined;
			if (authMode === "deny") return { headersApplied: false, errorMessage: "Fixture authorization denied" };
			return {
				headersApplied: true,
				requestAuth: { headers: { authorization: `Bearer ${secret}`, "x-fixture-auth": secret } },
			};
		};
		await peer.ready();
		const basedOnZCodeBuiltinRevision = `zcode-builtin:1:${createHash("sha256").update(path.resolve(builtinPath)).digest("hex")}`;
		const providers = { [accountModel.providerId]: { access: { type: "zhipu-account", entitled: true } } };
		const states = { [accountModel.providerId]: { availability: "available", entitled: true, current: true } };
		const account = {
			revision: `account:${JSON.stringify([basedOnZCodeBuiltinRevision, [{ providerId: accountModel.providerId, config: providers[accountModel.providerId] }], states])}`,
			basedOnZCodeBuiltinRevision,
			providers,
			states,
		};
		expect(await peer.request("provider/updateAccountConfig", account)).toMatchObject({ status: "received" });
		const allowed = await create(peer, config.cwdA, accountModel);
		const [roles, models] = await Promise.all(
			["get_model_roles", "get_team_models"].map(async operation =>
				zcodeSessionConfigureResultSchema.parse(
					await peer.request("session/configure", { sessionId: allowed, operation }),
				),
			),
		);
		if (roles?.operation !== "get_model_roles" || models?.operation !== "get_team_models")
			throw new Error("Expected complete public role and Team catalogs");
		const expectedModels = ["chat-a", "chat-b"].map(modelId => ({
			provider: accountModel.providerId,
			modelId,
		}));
		expect(
			roles.data.roles
				.find(role => role.roleId === "default")
				?.candidateModels.filter(candidate => candidate.provider === accountModel.providerId),
		).toEqual(expectedModels);
		expect(roles.data.sessionModel?.model).toEqual(expectedModels[0]);
		expect(models.data.models.filter(candidate => candidate.model.provider === accountModel.providerId)).toEqual(
			expectedModels.map(candidate => ({ model: candidate, name: candidate.modelId, selectable: true })),
		);
		expect(models.data.models).toContainEqual({
			model: { provider: model.providerId, modelId: "chat-b" },
			name: "chat-b",
			selectable: true,
		});
		expect(
			models.data.models.some(candidate => !candidate.selectable && !!candidate.reasonCode && !!candidate.reason),
		).toBe(true);
		expect(peer.seen.some(frame => frame.method === "interaction/requestProviderRuntimeHeaders")).toBe(false);
		expect(config.requests).toHaveLength(0);
		await subscribe(peer, allowed);
		await peer.request("workspace/updateModelIoPreferences", {
			workspace: workspace(config.cwdA),
			preferences: { fullRetentionEnabled: true },
		});
		expect(await command(peer, allowed, "sendText", { text: "ZCODE_TEST_ACCOUNT_ALLOWED" })).toMatchObject({
			status: "accepted",
		});
		await finishedOutput(peer, allowed, "ZCODE_TEST_ACCOUNT_ALLOWED_DONE");
		expect(config.requests).toHaveLength(1);
		expect(config.requestHeaders[0]!.get("authorization")).toBe(`Bearer ${secret}`);
		expect(config.requestHeaders[0]!.get("x-fixture-auth")).toBe(secret);
		await peer.request("session/close", { sessionId: allowed });
		const retained = await retainedModelIo(config.configRoot);
		expect(retained.size).toBe(1);
		expect([...retained.values()].join("\n")).toContain("ZCODE_TEST_ACCOUNT_ALLOWED_DONE");
		expect([...retained.values()].join("\n")).not.toContain(secret);

		authMode = "deny";
		const denied = await create(peer, config.cwdA, accountModel);
		await subscribe(peer, denied);
		expect(await command(peer, denied, "sendText", { text: "ZCODE_TEST_ACCOUNT_DENIED" })).toMatchObject({
			status: "failed",
		});
		expect(config.requests).toHaveLength(1);

		authMode = "hold";
		const cancelled = await create(peer, config.cwdA, accountModel);
		await subscribe(peer, cancelled);
		const pending = command(peer, cancelled, "sendText", { text: "ZCODE_TEST_ACCOUNT_CANCELLED" });
		const reverse = await peer.next(
			frame =>
				frame.method === "interaction/requestProviderRuntimeHeaders" &&
				isRecord(frame.params) &&
				frame.params.sessionId === cancelled,
		);
		const params = LegacyProtocol.zcodeProviderRuntimeHeadersRequestParamsSchema.parse(reverse.params);
		await command(peer, cancelled, "stop", {});
		await peer.next(
			frame =>
				frame.method === "interaction/providerRuntimeHeadersCancelled" &&
				isRecord(frame.params) &&
				frame.params.requestId === params.requestId,
		);
		expect(await pending).toMatchObject({ status: "failed" });
		// A late Host answer cannot revive cancelled work or fall back to an available local model.
		peer.write({
			id: reverse.id,
			result: { headersApplied: true, requestAuth: { headers: { "x-fixture-auth": secret } } },
		});
		await Promise.all([denied, cancelled].map(sessionId => peer.request("session/close", { sessionId })));
		expect(await peer.eof()).toBe(0);
		expect(config.requests).toHaveLength(1);
		expect(JSON.stringify(peer.seen)).not.toContain(secret);
		expect(await peer.stderr).not.toContain(secret);
		for (const relative of await fs.readdir(root.path(), { recursive: true })) {
			const actualPath = path.join(root.path(), relative);
			if ((await fs.stat(actualPath)).isFile())
				expect((await fs.readFile(actualPath)).includes(Buffer.from(secret))).toBe(false);
		}
	}, 120_000);
	test("legacy Goal set and replace preserve reserved objectives through native execution and canonical cold recovery", async () => {
		await using root = await TempDir.create("@zcode-goal-boundary-");
		await using config = await fixture(root);
		let sessionId: string;
		let targetId: string;
		const commandId = crypto.randomUUID();
		const canonicalObjective = "resume ZCODE_TEST_GOAL_CANONICAL";
		const readGoal = async (peer: ProcessPeer) => {
			const subscription = await subscribe(peer, sessionId);
			if (!isRecord(subscription)) throw new Error("Missing Goal subscription");
			const ack = subscribeAckSchema.parse(subscription.ack);
			const frame = await peer.next(
				frame =>
					frame.method === "v4/conversation/frame" &&
					isRecord(frame.params) &&
					frame.params.subscriptionId === ack.subscriptionId,
			);
			const wire = conversationTopicWireFrameSchema.parse(frame.params);
			if (wire.kind !== "complete" || wire.frame.payload.kind !== "snapshot")
				throw new Error("Expected complete initial Goal snapshot");
			const goal = wire.frame.payload.snapshot.goal;
			if (!goal) throw new Error("Missing native Goal in conversation snapshot");
			return goal;
		};
		{
			await using peer = new ProcessPeer(config.cwdA, config.env);
			await peer.ready();
			sessionId = await create(peer, config.cwdA);
			await subscribe(peer, sessionId);
			for (const [action, objective, marker] of [
				["set", "pause ZCODE_TEST_GOAL_CREATE", "ZCODE_TEST_GOAL_CREATE"],
				["replace", "replacement ZCODE_TEST_GOAL_REPLACE", "ZCODE_TEST_GOAL_REPLACE"],
			] as const) {
				const result = LegacyProtocol.zcodeSessionGoalResultSchema.parse(
					await peer.request("session/goal", {
						sessionId,
						action,
						objective,
						inputId: `input-${marker}`,
					}),
				);
				expect(result.snapshot.session.sessionId).toBe(sessionId);
				await finishedOutput(peer, sessionId, `${marker}_DONE`);
				expect(await readGoal(peer)).toMatchObject({ objective, status: "active" });
				const modelRequest = config.requests.find(request =>
					JSON.stringify(request.messages.at(-1)).includes(marker),
				);
				expect(modelRequest?.model).toBe("chat-a");
				expect(JSON.stringify(modelRequest?.messages.at(-1)?.content)).toContain(objective);
			}
			expect(
				await command(peer, sessionId, "sendGoalCommand", { text: canonicalObjective }, commandId),
			).toMatchObject({ status: "accepted" });
			await finishedOutput(peer, sessionId, "ZCODE_TEST_GOAL_CANONICAL_DONE");
			const goal = await readGoal(peer);
			expect(goal).toMatchObject({ objective: canonicalObjective, status: "active" });
			targetId = goal.targetId;
			const rows = v4ConversationRowsRangeResultSchema.parse(
				await peer.request("v4/conversation/rowsRange", { sessionId, limit: 100 }),
			);
			expect(rows.rows.filter(row => row.kind === "userInput" && row.sourceCommandId === commandId)).toEqual([
				expect.objectContaining({ text: canonicalObjective, sourceCommandId: commandId }),
			]);
			expect(
				config.requests.some(request =>
					JSON.stringify(request.messages.at(-1)?.content).includes(canonicalObjective),
				),
			).toBe(true);
			expect(await peer.eof()).toBe(0);
		}
		const requestCount = config.requests.length;
		await using cold = new ProcessPeer(config.cwdA, config.env);
		await cold.ready();
		const restored = LegacyProtocol.zcodeSessionStateSnapshotSchema.parse(
			await cold.request("session/read", { sessionId }),
		);
		expect(restored.session.sessionId).toBe(sessionId);
		expect(await readGoal(cold)).toMatchObject({ targetId, objective: canonicalObjective });
		const rows = v4ConversationRowsRangeResultSchema.parse(
			await cold.request("v4/conversation/rowsRange", { sessionId, limit: 100 }),
		);
		expect(rows.rows.filter(row => row.kind === "userInput" && row.sourceCommandId === commandId)).toEqual([
			expect.objectContaining({ text: canonicalObjective, sourceCommandId: commandId }),
		]);
		expect(config.requests).toHaveLength(requestCount);
	}, 120_000);
	test("reset loops keep the public session and journal identity while replacing projection epoch only for that session", async () => {
		await using root = await TempDir.create("@zcode-loop-reset-process-");
		await using config = await fixture(root);
		await fs.mkdir(path.join(config.cwdA, ".omp"), { recursive: true });
		await fs.writeFile(path.join(config.cwdA, ".omp", "config.yml"), "loop:\n  mode: reset\n");
		await using peer = new ProcessPeer(config.cwdA, config.env);
		await peer.ready();
		const a = await create(peer, config.cwdA);
		const b = await create(peer, config.cwdB);
		const subscription = await subscribe(peer, a);
		if (!isRecord(subscription)) throw new Error("Missing initial loop subscription");
		const initialEpoch = subscribeAckSchema.parse(subscription.ack).logEpoch;
		await subscribe(peer, b);
		await Promise.all([
			command(peer, a, "sendText", { text: "ZCODE_TEST_LOOP_WARM_A" }),
			command(peer, b, "sendText", { text: "ZCODE_TEST_LOOP_WARM_B" }),
		]);
		await Promise.all([
			finishedOutput(peer, a, "ZCODE_TEST_LOOP_WARM_A_DONE"),
			finishedOutput(peer, b, "ZCODE_TEST_LOOP_WARM_B_DONE"),
		]);
		const journals = (await fs.readdir(config.configRoot, { recursive: true }))
			.filter(file => file.endsWith(".jsonl"))
			.sort();
		expect(journals).toHaveLength(2);
		await command(peer, b, "sendText", { text: "ZCODE_TEST_STOP_PEER_B" });
		await output(peer, b, "ZCODE_TEST_STOP_PEER_B_STREAMING");
		expect(await command(peer, a, "sendText", { text: "/loop 1 ZCODE_TEST_LOOP_RESET" })).toMatchObject({
			status: "accepted",
		});
		await config.waitForRequests("ZCODE_TEST_LOOP_RESET", 2);
		await finishedOutput(peer, a, "ZCODE_TEST_LOOP_RESET_DONE");
		await command(peer, a, "stop", {});
		const reread = LegacyProtocol.zcodeSessionStateSnapshotSchema.parse(
			await peer.request("session/read", { sessionId: a }),
		);
		expect(reread.session.sessionId).toBe(a);
		expect(
			(await fs.readdir(config.configRoot, { recursive: true })).filter(file => file.endsWith(".jsonl")).sort(),
		).toEqual(journals);
		const listed = LegacyProtocol.zcodeSessionListResultSchema.parse(await peer.request("session/list", {}));
		expect(listed.sessions.map(item => item.sessionId).sort()).toEqual([a, b].sort());
		const recovery = await subscribe(peer, a);
		if (!isRecord(recovery)) throw new Error("Missing reset-loop subscription");
		expect(subscribeAckSchema.parse(recovery.ack).logEpoch).not.toBe(initialEpoch);
		const peerState = LegacyProtocol.zcodeSessionStateSnapshotSchema.parse(
			await peer.request("session/read", { sessionId: b }),
		);
		expect(peerState.projection.status).toBe("running");
		await command(peer, b, "stop", {});
		await command(peer, b, "sendText", { text: "ZCODE_TEST_TOOL_AFTER_LOOP_B" });
		await finishedOutput(peer, b, "ZCODE_TEST_TOOL_AFTER_LOOP_B_DONE");
		expect(await fs.readFile(path.join(config.cwdB, "proof.txt"), "utf8")).toBe("ZCODE_TEST_TOOL_AFTER_LOOP_B");
		expect(
			config.requests.filter(request => JSON.stringify(request.messages.at(-1)).includes("ZCODE_TEST_LOOP_RESET")),
		).toHaveLength(2);
	}, 120_000);
});
