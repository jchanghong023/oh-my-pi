import { beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getOfflineShmState } from "@oh-my-pi/pi-natives/offline-root";
import { isRecord, readJsonl, TempDir } from "@oh-my-pi/pi-utils";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { AuthStorage } from "../src/session/auth-storage";
import { RpcTeamConfigAdapter } from "../src/modes/rpc/rpc-team-config";
import { RpcFrameDecoder } from "../src/modes/rpc/rpc-frame";

beforeAll(() => Settings.init({ inMemory: true }));

describe("Team configuration RPC", () => {
	test("real rpc-ui v3 negotiation, lossless preview, save receipts, conflicts and structured invalid config", async () => {
		await using root = await TempDir.create("@rpc-team-wire-");
		const cwd = root.join("project");
		const home = root.join("home");
		const configRoot = root.join("config");
		const offline = getOfflineShmState({
			HOME: home,
			USERPROFILE: home,
			OMP_CONFIG_ROOT: configRoot,
			PI_CONFIG_DIR: ".omp",
			OMP_OFFLINE: "1",
		});
		const agentDir = path.join(offline?.runtimeRoot ?? configRoot, "agent");
		await using _runtimeCleanup = {
			[Symbol.asyncDispose]: async () => {
				if (offline) await fs.rm(path.dirname(offline.runtimeRoot), { recursive: true, force: true });
			},
		};
		for (const dir of [cwd, home, agentDir, path.join(configRoot, "agent")]) await fs.mkdir(dir, { recursive: true });
		let networkRequests = 0;
		const endpoint = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch() {
				networkRequests++;
				return new Response("Unexpected model/catalog request", { status: 500 });
			},
		});
		await using _endpointCleanup = {
			[Symbol.asyncDispose]: async () => {
				endpoint.stop(true);
			},
		};
		const modelsYaml = [
			"providers:",
			"  rpc-team:",
			`    baseUrl: http://127.0.0.1:${endpoint.port}/v1`,
			"    auth: none",
			"    api: openai-completions",
			"    models:",
			"      - id: chat-a",
			"        reasoning: false",
			"  rpc-team-alt:",
			`    baseUrl: http://127.0.0.1:${endpoint.port}/v1`,
			"    auth: none",
			"    api: openai-completions",
			"    models:",
			"      - id: chat-b",
			"        reasoning: false",
			"",
		].join("\n");
		await fs.writeFile(path.join(agentDir, "models.yml"), modelsYaml);
		const configPath = path.join(agentDir, "config.yml");
		const original = "team:\n  members:\n    - rpc-team/chat-a\n    - stale-provider/removed-model\n";
		await fs.writeFile(configPath, original);
		if (offline) await fs.writeFile(path.join(configRoot, "agent", "config.yml"), original);
		const child = Bun.spawn(
			[
				process.execPath,
				path.resolve(import.meta.dir, "../src/cli.ts"),
				"--mode",
				"rpc-ui",
				"--no-extensions",
				"--no-ui",
				"--no-rules",
				"--no-skills",
				"--no-tools",
				"--no-session",
				"--provider",
				"rpc-team",
				"--model",
				"chat-a",
			],
			{
				cwd,
				env: {
					PATH: Bun.env.PATH,
					SystemRoot: Bun.env.SystemRoot,
					WINDIR: Bun.env.WINDIR,
					TEMP: Bun.env.TEMP,
					TMP: Bun.env.TMP,
					HOME: home,
					USERPROFILE: home,
					OMP_CONFIG_ROOT: configRoot,
					PI_CONFIG_DIR: ".omp",
					OMP_PROFILE: undefined,
					PI_PROFILE: undefined,
					PI_CONFIG_FILES: undefined,
					PI_CODING_AGENT_DIR: agentDir,
					OMP_OFFLINE: "1",
					PI_NO_TITLE: "1",
				},
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const stderr = new Response(child.stderr).text();
		const queue: Record<string, unknown>[] = [];
		const seen: Record<string, unknown>[] = [];
		let ended = false;
		let changed = Promise.withResolvers<void>();
		const decoder = new RpcFrameDecoder();
		const pump = (async () => {
			try {
				for await (const line of readJsonl<unknown>(child.stdout)) {
					const frame = decoder.push(line);
					if (isRecord(frame)) {
						queue.push(frame);
						seen.push(frame);
						const wake = changed;
						changed = Promise.withResolvers<void>();
						wake.resolve();
					}
				}
			} finally {
				ended = true;
				changed.resolve();
			}
		})();
		const next = async (predicate: (frame: Record<string, unknown>) => boolean) => {
			for (;;) {
				const index = queue.findIndex(predicate);
				if (index >= 0) return queue.splice(index, 1)[0]!;
				if (ended) throw new Error(`RPC ended: ${await stderr}`);
				await changed.promise;
			}
		};
		const request = async (frame: { id: string; type: string; [key: string]: unknown }) => {
			child.stdin.write(`${JSON.stringify(frame)}\n`);
			return next(item => item.type === "response" && item.id === frame.id);
		};
		try {
			await next(frame => frame.type === "ready");
			for (const type of ["get_team_config", "get_team_models", "set_team_config"]) {
				expect(await request({ id: `old-${type}`, type })).toMatchObject({ success: false, code: "unsupported" });
			}
			expect(await request({ id: "v2", type: "negotiate_protocol", protocolVersion: 2 })).toMatchObject({
				success: true,
			});
			expect(await request({ id: "still-old", type: "get_team_config" })).toMatchObject({
				success: false,
				code: "unsupported",
			});
			expect(await request({ id: "v3", type: "negotiate_protocol", protocolVersion: 3 })).toMatchObject({
				success: true,
				data: { protocolVersion: 3, capabilities: { teamConfig: true } },
			});
			const loaded = await request({ id: "read", type: "get_team_config" });
			expect(loaded.success).toBe(true);
			if (!isRecord(loaded.data) || typeof loaded.data.revision !== "string")
				throw new Error("Missing Team revision");
			expect(loaded.data.userMembers).toMatchObject([
				{ index: 0, rawSelector: "rpc-team/chat-a" },
				{ index: 1, rawSelector: "stale-provider/removed-model", status: "unresolved" },
			]);
			const revision = loaded.data.revision;
			const preview = await request({
				id: "preview",
				type: "get_team_config",
				preview: {
					clientRevision: "draft-9",
					members: [{ rawSelector: "stale-provider/removed-model" }],
				},
			});
			expect(preview).toMatchObject({
				success: true,
				data: {
					preview: {
						clientRevision: "draft-9",
						userMembers: [{ index: 0, rawSelector: "stale-provider/removed-model" }],
						participants: [],
					},
				},
			});
			for (const members of [[], null]) {
				const clientRevision = members === null ? "draft-clear" : "draft-default";
				expect(
					await request({ id: clientRevision, type: "get_team_config", preview: { clientRevision, members } }),
				).toMatchObject({
					success: true,
					data: { revision, preview: { clientRevision, userMembers: members } },
				});
			}
			expect(
				await request({
					id: "bad-preview",
					type: "get_team_config",
					preview: { clientRevision: "missing-members" },
				}),
			).toMatchObject({ success: false, code: "invalid_params" });
			expect(await fs.readFile(configPath, "utf8")).toBe(original);
			const models = await request({ id: "models", type: "get_team_models" });
			expect(models.success).toBe(true);
			if (!isRecord(models.data) || !Array.isArray(models.data.models)) throw new Error("Missing candidate catalog");
			expect(models.data.models).toContainEqual(
				expect.objectContaining({
					model: { provider: "rpc-team", modelId: "chat-a" },
					selectable: true,
				}),
			);
			expect(models.data.models).toContainEqual(
				expect.objectContaining({
					model: { provider: "rpc-team-alt", modelId: "chat-b" },
					selectable: true,
				}),
			);
			expect(
				await request({ id: "search", type: "get_team_models", query: "no-such-team-candidate-unique" }),
			).toMatchObject({ success: true, data: { models: [] } });
			expect(
				await request({ id: "cross-provider-search", type: "get_team_models", query: "rpc-team-alt" }),
			).toMatchObject({
				success: true,
				data: { models: [{ model: { provider: "rpc-team-alt", modelId: "chat-b" }, selectable: true }] },
			});
			expect(await request({ id: "bad-query", type: "get_team_models", query: 42 })).toMatchObject({
				success: false,
				code: "invalid_params",
			});
			for (const members of [undefined, [{ provider: "missing-provider", modelId: "missing-id" }]]) {
				expect(
					await request({
						id: `invalid-${String(members)}`,
						type: "set_team_config",
						scope: "user",
						expectedRevision: revision,
						...(members === undefined ? {} : { members }),
					}),
				).toMatchObject({ success: false, code: "invalid_params" });
				expect(await fs.readFile(configPath, "utf8")).toBe(original);
			}
			const concreteMembers = [
				{ provider: "rpc-team-alt", modelId: "chat-b" },
				{ provider: "rpc-team", modelId: "chat-a" },
				{ provider: "rpc-team-alt", modelId: "chat-b" },
			];
			const concrete = await request({
				id: "concrete",
				type: "set_team_config",
				scope: "user",
				expectedRevision: revision,
				members: concreteMembers,
			});
			expect(concrete).toMatchObject({
				success: true,
				data: {
					saveState: "complete",
					config: {
						userMembers: concreteMembers.map((model, index) => ({ index, model })),
					},
				},
			});
			if (!isRecord(concrete.data) || !isRecord(concrete.data.config)) throw new Error("Missing saved config");
			const saved = await request({
				id: "save",
				type: "set_team_config",
				scope: "user",
				expectedRevision: concrete.data.config.revision,
				members: [],
			});
			expect(saved).toMatchObject({
				success: true,
				data: {
					saveState: "complete",
					writes: { active: { status: "saved" }, persistent: { status: offline ? "saved" : "not_applicable" } },
					config: { userMembers: [] },
				},
			});
			await next(frame => frame.type === "settings_changed" && frame.scope === "user");
			expect(
				await request({
					id: "conflict",
					type: "set_team_config",
					scope: "user",
					expectedRevision: revision,
					members: null,
				}),
			).toMatchObject({
				success: false,
				code: "revision_conflict",
				data: {
					saveState: "failed",
					writes: { active: { status: "not_attempted" }, persistent: { status: "not_attempted" } },
				},
			});
			const readback = await request({ id: "readback", type: "get_team_config" });
			expect(readback).toMatchObject({ success: true, data: { userMembers: [] } });
			if (!isRecord(readback.data)) throw new Error("Missing readback");
			expect(
				await request({
					id: "clear",
					type: "set_team_config",
					scope: "user",
					expectedRevision: readback.data.revision,
					members: null,
				}),
			).toMatchObject({ success: true, data: { saveState: "complete", config: { userMembers: null } } });
			await fs.writeFile(configPath, "team:\n  members: []\n  members: []\n");
			expect(
				await request({
					id: "broken",
					type: "set_team_config",
					scope: "user",
					expectedRevision: "irrelevant",
					members: [],
				}),
			).toMatchObject({
				success: false,
				code: "invalid_config",
				data: {
					saveState: "failed",
					writes: { active: { status: "not_attempted" }, persistent: { status: "not_attempted" } },
				},
			});
			// Hold the real cross-process config lock: saving must not occupy the
			// stop/session channel, and its eventual reply belongs to the old session.
			await fs.writeFile(configPath, "team:\n  members: []\n");
			const beforeSwitch = await request({ id: "before-switch", type: "get_team_config" });
			if (!isRecord(beforeSwitch.data)) throw new Error("Missing pre-switch config");
			const switchRevision = beforeSwitch.data.revision;
			const notificationsBeforeSwitch = seen.filter(frame => frame.type === "settings_changed").length;
			await withFileLock(configPath, async () => {
				child.stdin.write(
					`${JSON.stringify({
						id: "old-session-save",
						type: "set_team_config",
						scope: "user",
						expectedRevision: switchRevision,
						members: null,
					})}\n`,
				);
				expect(await request({ id: "stop-during-save", type: "abort" })).toMatchObject({ success: true });
				expect(await request({ id: "switch-during-save", type: "new_session" })).toMatchObject({
					success: true,
					data: { cancelled: false },
				});
			});
			child.stdin.end();
			await child.exited;
			await pump;
			expect(await fs.readFile(configPath, "utf8")).not.toContain("members");
			expect(seen.some(frame => frame.id === "old-session-save")).toBe(false);
			expect(seen.filter(frame => frame.type === "settings_changed")).toHaveLength(notificationsBeforeSwitch);
			expect(seen.some(frame => frame.type === "agent_start")).toBe(false);
			expect(networkRequests).toBe(0);
		} finally {
			if (child.exitCode === null) child.stdin.end();
			await child.exited;
			await pump;
		}
	}, 180_000);

	test("real service keeps commit receipts when its initiating context expires and suppresses stale notifications", async () => {
		await using root = await TempDir.create("@rpc-team-context-");
		const cwd = root.join("project");
		const agentDir = root.join("agent");
		await fs.mkdir(cwd);
		await fs.mkdir(agentDir);
		await fs.writeFile(path.join(agentDir, "config.yml"), "team:\n  members: []\n");
		const settings = await Settings.loadIsolated({ cwd, agentDir });
		const auth = await AuthStorage.create(":memory:");
		const registry = new ModelRegistry(auth, path.join(agentDir, "models.yml"), { settings });
		let current = true;
		const notifications: object[] = [];
		const adapter = new RpcTeamConfigAdapter({
			settings,
			modelRegistry: registry,
			sessionModel: undefined,
			isCurrent: () => current,
			emit: frame => notifications.push(frame),
		});
		try {
			const loaded = await adapter.handle({ type: "get_team_config" }, true);
			if (!loaded.success || loaded.command !== "get_team_config" || !loaded.data.revision)
				throw new Error("Missing revision");
			const saving = adapter.handle(
				{ type: "set_team_config", scope: "user", expectedRevision: loaded.data.revision, members: null },
				true,
			);
			current = false;
			const result = await saving;
			expect(result).toMatchObject({
				success: true,
				data: { saveState: "complete", writes: { active: { status: "saved" } } },
			});
			expect(notifications).toEqual([]);
			expect(await fs.readFile(path.join(agentDir, "config.yml"), "utf8")).not.toContain("members");
		} finally {
			settings.cancelPendingSaves();
			auth.close();
		}
	});
});
