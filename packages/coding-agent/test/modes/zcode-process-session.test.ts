import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { fingerprintStaticModels } from "@oh-my-pi/pi-catalog/model-manager";
import { getBundledModel, getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { cursorModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models";
import { getModelDbPath, isRecord, TempDir } from "@oh-my-pi/pi-utils";
import {
	LegacyProtocol,
	conversationTopicWireFrameSchema,
	v4ConversationRowsRangeResultSchema,
	zcodeSessionConfigureResultSchema,
} from "../../src/modes/zcode/schema";
import { SessionManager } from "../../src/session/session-manager";
import { discoverAuthStorage } from "../../src/sdk";
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
	findInteraction,
	finishedOutput,
} from "./zcode-process-harness";

describe("ZCode actual public app-server process", () => {
	test("forks first and later assistant turns at their inherited boundary and resolves native path linkage on cold reopen", async () => {
		await using root = await TempDir.create("@zcode-fork-boundary-");
		await using config = await fixture(root);
		let parentId = "";
		let nativeId = "";
		const children: string[] = [];
		const rows = async (peer: ProcessPeer, sessionId: string) =>
			v4ConversationRowsRangeResultSchema.parse(
				await peer.request("v4/conversation/rowsRange", { sessionId, limit: 100 }),
			).rows;
		const assertBoundary = async (peer: ProcessPeer, sessionId: string, inheritedTurns: number) => {
			const history = await rows(peer, sessionId);
			const markerIndex = history.findIndex(
				row => row.kind === "timelineMarker" && row.marker.type === "forkNotice",
			);
			expect(markerIndex).toBeGreaterThan(0);
			expect(history[markerIndex]).toMatchObject({
				lane: "turnTailBoundary",
				marker: { type: "forkNotice", parentSessionId: parentId, parentRowId: 0 },
			});
			expect(history.slice(0, markerIndex).filter(row => row.kind === "userInput")).toHaveLength(inheritedTurns);
			expect(history.slice(markerIndex + 1).filter(row => row.kind === "userInput")).toHaveLength(1);
			expect(history[markerIndex - 1].kind).toBe("assistantText");
			expect(history[markerIndex + 1].kind).toBe("turnHeader");
			expect(history.map(row => row.rowId)).toEqual(history.map(row => row.rowId).sort((a, b) => a - b));
		};
		{
			await using peer = new ProcessPeer(config.cwdA, config.env);
			await peer.ready();
			parentId = await create(peer, config.cwdA);
			await subscribe(peer, parentId);
			for (const turn of [1, 2]) {
				await command(peer, parentId, "sendText", { text: `ZCODE_TEST_FORK_PARENT_${turn}` });
				await finishedOutput(peer, parentId, `ZCODE_TEST_FORK_PARENT_${turn}_DONE`);
			}
			const targets = (await rows(peer, parentId)).filter(
				row => row.kind === "assistantText" && row.actions?.canFork,
			);
			expect(targets).toHaveLength(2);
			for (const [index, target] of targets.entries()) {
				const ack = await command(peer, parentId, "forkAssistant", {
					target: { rowId: target.rowId, entityId: target.entityId },
				});
				if (!isRecord(ack) || !isRecord(ack.result) || typeof ack.result.sessionId !== "string")
					throw new Error("Missing fork session result");
				const child = ack.result.sessionId;
				children.push(child);
				await subscribe(peer, child);
				await command(peer, child, "sendText", { text: `ZCODE_TEST_FORK_CHILD_${index}` });
				await finishedOutput(peer, child, `ZCODE_TEST_FORK_CHILD_${index}_DONE`);
				await assertBoundary(peer, child, index + 1);
			}
			expect(await peer.eof()).toBe(0);
		}
		// Exercise native createBranchedSession, whose header stores the parent's path, not ID.
		const files = (await fs.readdir(config.configRoot, { recursive: true })).filter(file => file.endsWith(".jsonl"));
		const parentFile = files.find(file => file.includes(parentId));
		if (!parentFile) throw new Error("Missing parent journal");
		const manager = await SessionManager.open(path.join(config.configRoot, parentFile));
		try {
			const target = manager
				.getBranch()
				.findLast(entry => entry.type === "message" && entry.message.role === "assistant");
			if (!target) throw new Error("Missing native branch target");
			manager.createBranchedSession(target.id);
			nativeId = manager.getSessionId();
			await manager.ensureOnDisk();
			await manager.flush();
		} finally {
			await manager.close();
		}
		await using cold = new ProcessPeer(config.cwdA, config.env);
		await cold.ready();
		for (const [index, child] of children.entries()) {
			await assertBoundary(cold, child, index + 1);
			await cold.request("session/resume", { sessionId: child });
			await assertBoundary(cold, child, index + 1);
		}
		const nativeHistory = await rows(cold, nativeId);
		expect(nativeHistory.at(-1)).toMatchObject({
			kind: "timelineMarker",
			marker: { type: "forkNotice", parentSessionId: parentId, parentRowId: 0 },
		});
		await cold.request("session/resume", { sessionId: nativeId });
		await subscribe(cold, nativeId);
		await command(cold, nativeId, "sendText", { text: "ZCODE_TEST_NATIVE_FORK_CHILD" });
		await finishedOutput(cold, nativeId, "ZCODE_TEST_NATIVE_FORK_CHILD_DONE");
		await assertBoundary(cold, nativeId, 2);
		await cold.request("session/close", { sessionId: nativeId });
		await assertBoundary(cold, nativeId, 2);
	}, 120_000);

	test("selected yolo mode authorizes actual writes while build awaits denial and sibling permissions stay unchanged", async () => {
		await using root = await TempDir.create("@zcode-mode-write-");
		await using config = await fixture(root);
		await using peer = new ProcessPeer(config.cwdA, config.env);
		await peer.ready();
		const [a, b] = await Promise.all([create(peer, config.cwdA), create(peer, config.cwdB)]);
		await Promise.all([subscribe(peer, a), subscribe(peer, b)]);
		expect(await command(peer, a, "switchCollaborationMode", { mode: "build" })).toMatchObject({
			status: "accepted",
		});
		expect(await command(peer, b, "switchCollaborationMode", { mode: "build" })).toMatchObject({
			status: "accepted",
		});
		const denyBuildWrite = async (sessionId: string, cwd: string, marker: string) => {
			await command(peer, sessionId, "sendText", { text: marker });
			// build 现在走原生审批；必须拒绝真实交互，不能等待旧版 unsupported 错误或自动授权。
			const isWritePermission = (payload: Frame) => payload.kind === "permission" && payload.toolName === "write";
			const waiting = await peer.next(
				frame =>
					frame.method === "v4/conversation/frame" &&
					isRecord(frame.params) &&
					frame.params.topic === `conversation/${sessionId}` &&
					findInteraction(frame.params, isWritePermission) !== undefined,
			);
			const interaction = findInteraction(waiting.params, isWritePermission)!;
			expect(interaction.payload).toMatchObject({
				kind: "permission",
				toolName: "write",
				detail: { path: "proof.txt", content: marker },
				options: expect.arrayContaining([expect.objectContaining({ optionId: "deny", kind: "deny" })]),
			});
			expect(await Bun.file(path.join(cwd, "proof.txt")).exists()).toBe(false);
			expect(
				await command(peer, sessionId, "resolveInteraction", {
					interactionId: interaction.interactionId,
					answer: { optionId: "deny" },
				}),
			).toMatchObject({ status: "accepted" });
			await finishedOutput(peer, sessionId, `${marker}_DONE`);
			expect(await Bun.file(path.join(cwd, "proof.txt")).exists()).toBe(false);
		};
		await denyBuildWrite(a, config.cwdA, "ZCODE_TEST_TOOL_BUILD_A");
		expect(await command(peer, a, "switchCollaborationMode", { mode: "yolo" })).toMatchObject({
			status: "accepted",
		});
		await command(peer, a, "sendText", { text: "ZCODE_TEST_TOOL_YOLO_A" });
		await finishedOutput(peer, a, "ZCODE_TEST_TOOL_YOLO_A_DONE");
		expect(await fs.readFile(path.join(config.cwdA, "proof.txt"), "utf8")).toBe("ZCODE_TEST_TOOL_YOLO_A");
		await denyBuildWrite(b, config.cwdB, "ZCODE_TEST_TOOL_BUILD_B");
		expect(await peer.eof()).toBe(0);
	}, 120_000);

	test("native move and worktree relocate only their session tools and resources", async () => {
		await using root = await TempDir.create("@zcode-native-relocation-");
		await using config = await fixture(root, true);
		const moved = root.join("moved-existing");
		const probe = root.join("native-process-cwd.txt");
		// 进程探针属于测试 profile 的用户级扩展，不应随离开的 project root 失效。
		await fs.mkdir(path.join(config.agentDir, "extensions"), { recursive: true });
		await fs.writeFile(
			path.join(config.agentDir, "extensions", "process-cwd.ts"),
			`import * as fs from "node:fs/promises";\nexport default function(pi) { pi.registerCommand("native-process-cwd", { description: "Read actual host process cwd", handler: async () => { await fs.writeFile(${JSON.stringify(probe)}, process.cwd()); } }); }\n`,
		);
		// 显式配置测试自有可信模块，不依赖 ambient extension 扫描或改变宿主权限边界。
		await fs.appendFile(
			path.join(config.agentDir, "config.yml"),
			`extensions:\n  - ${JSON.stringify(path.join(config.agentDir, "extensions", "process-cwd.ts"))}\n`,
		);
		await fs.mkdir(path.join(moved, ".omp", "skills", "relocated-resource"), { recursive: true });
		await fs.writeFile(
			path.join(moved, ".omp", "skills", "relocated-resource", "SKILL.md"),
			"---\nname: relocated-resource\ndescription: Destination-only native resource\n---\nZCODE_TEST_RELOCATED_RESOURCE\n",
		);
		await fs.writeFile(path.join(moved, ".omp", "config.yml"), "worktree:\n  clone: false\n");
		const git = async (...args: string[]) => {
			const child = Bun.spawn(["git", "-C", moved, ...args], { stdout: "pipe", stderr: "pipe" });
			const stderr = new Response(child.stderr).text();
			expect(await child.exited, await stderr).toBe(0);
		};
		await git("init");
		await git("add", ".omp");
		await git(
			"-c",
			"user.name=Native relocation test",
			"-c",
			"user.email=native@example.invalid",
			"commit",
			"--allow-empty",
			"-m",
			"fixture",
		);
		await using peer = new ProcessPeer(config.cwdA, config.env);
		await peer.ready();
		const [a, b] = await Promise.all([create(peer, config.cwdA), create(peer, config.cwdB)]);
		await Promise.all([subscribe(peer, a), subscribe(peer, b)]);
		const readProcessCwd = async () => {
			const controller = new AbortController();
			// 订阅真实子进程文件 IO 的完成信号，不依赖 UI notify 的投影来判定 handler 完成。
			const events = fs.watch(root.path(), { signal: controller.signal });
			const observed = deadline(
				(async () => {
					for await (const event of events) {
						if (event.filename !== path.basename(probe)) continue;
						try {
							const value = await fs.readFile(probe, "utf8");
							if (value) return value;
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
						}
					}
					throw new Error("Native process cwd watcher ended without a probe file");
				})(),
			);
			void observed.catch(() => {});
			let receipt: unknown;
			try {
				receipt = await command(peer, a, "sendText", { text: "/native-process-cwd" });
				expect(receipt).toMatchObject({ status: "accepted" });
				return await observed;
			} catch (error) {
				const history = await peer.request("session/messages", { sessionId: a });
				console.error("Native process cwd file was not produced", {
					receipt,
					probe: await fs.readFile(probe, "utf8").catch(() => "not-created"),
					historyTail: JSON.stringify(history).slice(-2400),
				});
				throw error;
			} finally {
				controller.abort();
			}
		};
		const initialCatalog = LegacyProtocol.zcodeWorkspacePresentationSchema.parse(
			await peer.request("workspace/readPresentation", { workspace: workspace(config.cwdA) }),
		);
		expect(initialCatalog.slashCommands).toContainEqual(expect.objectContaining({ name: "native-process-cwd" }));
		expect(await readProcessCwd()).toBe(config.cwdA);
		await fs.unlink(probe);
		for (const id of [a, b]) await command(peer, id, "switchCollaborationMode", { mode: "yolo" });
		expect(await command(peer, a, "sendText", { text: `/move ${moved}` })).toMatchObject({ status: "accepted" });
		// 目的地 skill 的原生描述压缩允许辅助请求；带工具的主会话不得执行 /move 文本。
		expect(config.requests.filter(request => (request.tools?.length ?? 0) > 0)).toHaveLength(0);
		const encodedMove = JSON.stringify(`/move ${moved}`).slice(1, -1);
		expect(config.requests.some(request => JSON.stringify(request.messages).includes(encodedMove))).toBe(false);
		await command(peer, a, "sendText", { text: "ZCODE_TEST_TOOL_MOVED_A" });
		await finishedOutput(peer, a, "ZCODE_TEST_TOOL_MOVED_A_DONE");
		expect(await fs.readFile(path.join(moved, "proof.txt"), "utf8")).toBe("ZCODE_TEST_TOOL_MOVED_A");
		expect(await Bun.file(path.join(config.cwdA, "proof.txt")).exists()).toBe(false);
		const useRelocatedReference = async (cwd: string) => {
			const catalog = LegacyProtocol.zcodeSkillsReferenceCatalogResultSchema.parse(
				await peer.request("skills/referenceCatalog", { workspace: workspace(cwd), sessionId: a }),
			);
			expect(catalog.authority).toBe("session");
			const skill = catalog.skills.find(item => item.name === "relocated-resource");
			expect(skill).toMatchObject({
				enabled: true,
				path: path.join(cwd, ".omp", "skills", "relocated-resource", "SKILL.md"),
			});
			if (!skill) throw new Error("Destination skill missing from resident reference catalog");
			// 使用目录返回的真实资源路径，必须经过 prepareReferences，不能绕到 /skill 直呼。
			expect(
				await command(peer, a, "sendText", { text: `[$${skill.name}](${skill.path.replace(/\\/g, "\\\\")})` }),
			).toMatchObject({ status: "accepted" });
		};
		await useRelocatedReference(moved);
		await finishedOutput(peer, a, "ZCODE_TEST_RELOCATED_RESOURCE_DONE");
		expect(await command(peer, a, "sendText", { text: `/move ${root.join("missing-target")}` })).toMatchObject({
			status: "failed",
		});
		expect(await command(peer, a, "sendText", { text: "/move" })).toMatchObject({ status: "failed" });
		await command(peer, a, "sendText", { text: "ZCODE_TEST_TOOL_AFTER_FAILED_MOVE" });
		await finishedOutput(peer, a, "ZCODE_TEST_TOOL_AFTER_FAILED_MOVE_DONE");
		expect(await fs.readFile(path.join(moved, "proof.txt"), "utf8")).toBe("ZCODE_TEST_TOOL_AFTER_FAILED_MOVE");
		expect(await command(peer, a, "sendText", { text: "/wt isolated-native-branch" })).toMatchObject({
			status: "accepted",
		});
		const listed = Bun.spawn(["git", "-C", moved, "worktree", "list", "--porcelain"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const worktrees = await new Response(listed.stdout).text();
		expect(await listed.exited).toBe(0);
		const worktree = worktrees
			.split("\n\n")
			.find(block => block.includes("branch refs/heads/isolated-native-branch"))
			?.split("\n")
			.find(line => line.startsWith("worktree "))
			?.slice("worktree ".length);
		if (!worktree) throw new Error(`Native worktree was not created: ${worktrees}`);
		expect(path.relative(root.path(), worktree).startsWith("..")).toBe(false);
		await command(peer, a, "sendText", { text: "ZCODE_TEST_TOOL_WORKTREE_A" });
		await finishedOutput(peer, a, "ZCODE_TEST_TOOL_WORKTREE_A_DONE");
		expect(await fs.readFile(path.join(worktree, "proof.txt"), "utf8")).toBe("ZCODE_TEST_TOOL_WORKTREE_A");
		await useRelocatedReference(worktree);
		await finishedOutput(peer, a, "ZCODE_TEST_RELOCATED_RESOURCE_DONE");
		await command(peer, b, "sendText", { text: "ZCODE_TEST_TOOL_UNMOVED_B" });
		await finishedOutput(peer, b, "ZCODE_TEST_TOOL_UNMOVED_B_DONE");
		expect(await fs.readFile(path.join(config.cwdB, "proof.txt"), "utf8")).toBe("ZCODE_TEST_TOOL_UNMOVED_B");
		const relocatedCatalog = LegacyProtocol.zcodeWorkspacePresentationSchema.parse(
			await peer.request("workspace/readPresentation", { workspace: workspace(worktree) }),
		);
		expect(relocatedCatalog.slashCommands).toContainEqual(expect.objectContaining({ name: "native-process-cwd" }));
		expect(await readProcessCwd()).toBe(config.cwdA);
		expect(await peer.eof()).toBe(0);
	}, 120_000);

	test("one process streams two sessions, runs real cwd-bound tools, deduplicates command identity and stops only target", async () => {
		await using root = await TempDir.create("@zcode-concurrent-");
		await using config = await fixture(root);
		await using peer = new ProcessPeer(config.cwdA, config.env);
		await peer.ready();
		const [a, b] = await Promise.all([create(peer, config.cwdA), create(peer, config.cwdB)]);
		expect(a).not.toBe(b);
		await Promise.all([subscribe(peer, a), subscribe(peer, b)]);
		await command(peer, a, "sendText", { text: "ZCODE_TEST_STOP_A" });
		await output(peer, a, "ZCODE_TEST_STOP_A_STREAMING");
		const commandId = crypto.randomUUID();
		const first = await command(peer, b, "sendText", { text: "ZCODE_TEST_TOOL_B" }, commandId);
		const duplicate = await command(peer, b, "sendText", { text: "ZCODE_TEST_TOOL_B" }, commandId);
		if (!isRecord(first)) throw new Error("Missing original command ACK");
		expect(duplicate).toEqual({ ...first, status: "duplicate" });
		await output(peer, b, "ZCODE_TEST_TOOL_B_DONE");
		expect(await fs.readFile(path.join(config.cwdB, "proof.txt"), "utf8")).toBe("ZCODE_TEST_TOOL_B");
		expect(await Bun.file(path.join(config.cwdA, "proof.txt")).exists()).toBe(false);
		await command(peer, a, "stop", {});
		await command(peer, b, "sendText", { text: "ZCODE_TEST_STREAM_B" });
		const streamed = await output(peer, b, "ZCODE_TEST_STREAM_B_STREAMING");
		expect(conversationTopicWireFrameSchema.safeParse(streamed.params).success).toBe(true);
		await output(peer, b, "ZCODE_TEST_STREAM_B_DONE");
		const history = await peer.request("session/messages", { sessionId: b });
		expect(JSON.stringify(history)).not.toContain("ZCODE_TEST_STOP_A");
		expect(
			config.requests.filter(
				request =>
					request.messages.at(-1)?.role === "user" &&
					JSON.stringify(request.messages.at(-1)).includes("ZCODE_TEST_TOOL_B"),
			),
		).toHaveLength(1);
		expect(await peer.eof()).toBe(0);
	}, 120_000);

	test("global Team configuration reads, previews and saves without creating a session", async () => {
		await using root = await TempDir.create("@zcode-global-team-");
		await using config = await fixture(root);
		await using peer = new ProcessPeer(config.cwdA, config.env);
		await peer.ready();
		const target = { workspace: workspace(config.cwdA) };
		const sessions = await peer.request("session/list", {});
		const team = zcodeSessionConfigureResultSchema.parse(
			await peer.request("omp/team/configure", { ...target, request: { operation: "get_team_config" } }),
		);
		if (team.operation !== "get_team_config") throw new Error("Expected Team configuration");
		expect(team.data.sessionModel).toBeNull();
		const models = zcodeSessionConfigureResultSchema.parse(
			await peer.request("omp/team/configure", { ...target, request: { operation: "get_team_models" } }),
		);
		if (models.operation !== "get_team_models") throw new Error("Expected Team models");
		expect(models.data.models.filter(item => item.model.provider === model.providerId)).toEqual(
			["chat-a", "chat-b"].map(modelId => ({
				model: { provider: model.providerId, modelId },
				name: modelId,
				selectable: true,
			})),
		);
		const before = await fs.readFile(path.join(config.agentDir, "config.yml"), "utf8");
		expect(
			await peer.request("omp/team/configure", {
				...target,
				request: { operation: "get_team_config", preview: { clientRevision: "global-draft", members: [] } },
			}),
		).toMatchObject({ data: { preview: { clientRevision: "global-draft", userMembers: [] } } });
		expect(await fs.readFile(path.join(config.agentDir, "config.yml"), "utf8")).toBe(before);
		const members = [
			{ provider: model.providerId, modelId: "chat-b" },
			{ provider: model.providerId, modelId: "chat-b" },
		];
		const saved = await peer.request("omp/team/configure", {
			...target,
			request: { operation: "set_team_config", scope: "user", expectedRevision: team.data.revision, members },
		});
		expect(saved).toMatchObject({
			data: {
				saveState: "complete",
				config: {
					userMembers: [
						{ index: 0, model: members[0] },
						{ index: 1, model: members[1] },
					],
				},
			},
		});
		const persisted = await fs.readFile(path.join(config.agentDir, "config.yml"), "utf8");
		const stale = await peer.requestFrame("omp/team/configure", {
			...target,
			request: { operation: "set_team_config", scope: "user", expectedRevision: team.data.revision, members: [] },
		});
		expect(stale.error).toMatchObject({
			data: {
				code: "revision_conflict",
				writes: {
					active: { status: "not_attempted" },
					persistent: { status: "not_attempted" },
				},
			},
		});
		expect(await fs.readFile(path.join(config.agentDir, "config.yml"), "utf8")).toBe(persisted);
		const foreign = await peer.requestFrame("omp/team/configure", {
			workspace: workspace(config.cwdB),
			request: { operation: "get_team_config" },
		});
		expect(foreign.error).toMatchObject({ code: -32602 });
		expect(await peer.request("session/list", {})).toEqual(sessions);
		expect(config.requests).toHaveLength(0);
		const [a, b] = await Promise.all([create(peer, config.cwdA), create(peer, config.cwdB)]);
		for (const sessionId of [a, b]) {
			expect(await peer.request("session/configure", { sessionId, operation: "get_team_config" })).toMatchObject({
				data: { userMembers: [{ model: members[0] }, { model: members[1] }] },
			});
		}
		expect(await peer.eof()).toBe(0);
	}, 120_000);

	test("cold global Team restores authenticated credential-scoped cached models without a session or inference", async () => {
		await using root = await TempDir.create("@zcode-global-team-cache-");
		await using config = await fixture(root);
		const bundled = getBundledModel("cursor", "claude-opus-5-5");
		if (!bundled) throw new Error("Expected bundled Cursor model for credential-scoped cache fixture");
		const cached = buildModel({
			...bundled,
			id: "claude-opus-5-5-1m",
			name: "Team cached Cursor model",
			contextWindow: 1_000_000,
		});
		const token = `${Buffer.from('{"alg":"HS256"}').toString("base64url")}.${Buffer.from(
			JSON.stringify({ sub: "auth0|team-cache-fixture", iat: 1_800_000_000, exp: 4_000_000_000 }),
		).toString("base64url")}.sig`;
		const auth = await discoverAuthStorage(config.agentDir, { cwd: config.cwdA });
		try {
			await auth.credentials.set("cursor", {
				type: "oauth",
				access: token,
				refresh: "isolated-team-cache-refresh",
				expires: 4_000_000_000_000,
			});
		} finally {
			auth.close();
		}
		const cacheProviderId = cursorModelManagerOptions({ apiKey: token }).cacheProviderId;
		if (!cacheProviderId) throw new Error("Expected credential-scoped Cursor cache namespace");
		writeModelCache(
			cacheProviderId,
			Date.now(),
			[cached],
			true,
			fingerprintStaticModels(getBundledModels("cursor"), true),
			getModelDbPath(config.agentDir),
		);
		// 冷入口必须像 SDK 一样离线恢复账号缓存；读取模型不能靠创建会话或联网刷新补齐。
		await using peer = new ProcessPeer(config.cwdA, { ...config.env, OMP_OFFLINE: "1" });
		await peer.ready();
		const before = await fs.readFile(path.join(config.agentDir, "config.yml"), "utf8");
		expect(
			LegacyProtocol.zcodeSessionListResultSchema.parse(await peer.request("session/list", {})).sessions,
		).toEqual([]);
		const models = zcodeSessionConfigureResultSchema.parse(
			await peer.request("omp/team/configure", {
				workspace: workspace(config.cwdA),
				request: { operation: "get_team_models", query: cached.id },
			}),
		);
		if (models.operation !== "get_team_models") throw new Error("Expected Team models");
		expect(models.data.models).toContainEqual({
			model: { provider: "cursor", modelId: cached.id },
			name: cached.name,
			selectable: true,
		});
		expect(
			LegacyProtocol.zcodeSessionListResultSchema.parse(await peer.request("session/list", {})).sessions,
		).toEqual([]);
		expect(await fs.readFile(path.join(config.agentDir, "config.yml"), "utf8")).toBe(before);
		expect(config.requests).toHaveLength(0);
		expect(await peer.eof()).toBe(0);
	}, 120_000);

	test("question and config waits remain session-affine; temporary model and saved defaults do not switch peers", async () => {
		await using root = await TempDir.create("@zcode-question-config-");
		await using config = await fixture(root);
		await using peer = new ProcessPeer(config.cwdA, config.env);
		await peer.ready();
		const [a, b] = await Promise.all([create(peer, config.cwdA), create(peer, config.cwdB)]);
		await Promise.all([subscribe(peer, a), subscribe(peer, b)]);
		await command(peer, a, "sendText", { text: "ZCODE_TEST_QUESTION_A" });
		const waiting = await peer.next(
			frame => frame.method === "v4/conversation/frame" && findInteraction(frame.params) !== undefined,
		);
		const interaction = findInteraction(waiting.params)!;
		await command(peer, b, "sendText", { text: "ZCODE_TEST_WHILE_WAITING_B" });
		await output(peer, b, "ZCODE_TEST_WHILE_WAITING_B_DONE");
		await command(peer, a, "resolveInteraction", {
			interactionId: interaction.interactionId,
			answer: { optionId: "Continue" },
		});
		await finishedOutput(peer, a, "ZCODE_TEST_QUESTION_A_DONE");
		await command(peer, a, "switchModelConfig", { provider: model.providerId, model: "chat-b", thought: "off" });
		const roles = zcodeSessionConfigureResultSchema.parse(
			await peer.request("session/configure", { sessionId: a, operation: "get_model_roles" }),
		);
		if (roles.operation !== "get_model_roles") throw new Error("Unexpected configuration operation");
		const role = roles.data.roles.find(item => item.roleId === "default");
		if (!role) throw new Error("Default role not listed");
		const saved = await peer.request("session/configure", {
			sessionId: a,
			operation: "set_model_role",
			roleId: "default",
			scope: "user",
			expectedRevision: role.revision,
			selection: { kind: "model", model: { provider: model.providerId, modelId: "chat-b" } },
		});
		expect(saved).toMatchObject({ operation: "set_model_role", data: { persisted: true } });
		const team = zcodeSessionConfigureResultSchema.parse(
			await peer.request("session/configure", { sessionId: a, operation: "get_team_config" }),
		);
		if (team.operation !== "get_team_config") throw new Error("Unexpected Team operation");
		expect(team.data.userMembers).toContainEqual(
			expect.objectContaining({ rawSelector: "stale-provider/removed-model", status: "unresolved" }),
		);
		const before = await fs.readFile(path.join(config.agentDir, "config.yml"), "utf8");
		const preview = await peer.request("session/configure", {
			sessionId: a,
			operation: "get_team_config",
			preview: { clientRevision: "draft-1", members: [] },
		});
		expect(preview).toMatchObject({ data: { preview: { clientRevision: "draft-1", userMembers: [] } } });
		expect(await fs.readFile(path.join(config.agentDir, "config.yml"), "utf8")).toBe(before);
		const save = await peer.request("omp/team/configure", {
			workspace: workspace(config.cwdA),
			request: {
				operation: "set_team_config",
				scope: "user",
				expectedRevision: team.data.revision,
				members: [
					{ provider: model.providerId, modelId: "chat-b" },
					{ provider: model.providerId, modelId: "chat-b" },
				],
			},
		});
		expect(save).toMatchObject({ data: { saveState: "complete" } });
		for (const sessionId of [a, b]) {
			expect(await peer.request("session/configure", { sessionId, operation: "get_team_config" })).toMatchObject({
				data: {
					effectiveMembers: [
						{ index: 0, model: { provider: model.providerId, modelId: "chat-b" } },
						{ index: 1, model: { provider: model.providerId, modelId: "chat-b" } },
					],
				},
			});
		}
		const stale = await peer.requestFrame("session/configure", {
			sessionId: a,
			operation: "set_team_config",
			scope: "user",
			expectedRevision: team.data.revision,
			members: [],
		});
		expect(stale.error).toMatchObject({ code: expect.any(Number) });
		await Promise.all([
			command(peer, a, "sendText", { text: "ZCODE_TEST_MODEL_A" }),
			command(peer, b, "sendText", { text: "ZCODE_TEST_MODEL_B" }),
		]);
		await Promise.all([output(peer, a, "ZCODE_TEST_MODEL_A_DONE"), output(peer, b, "ZCODE_TEST_MODEL_B_DONE")]);
		// 标题 sidecar 同样携带用户 marker，且固定用 smol；本场景须等带工具面的主请求，
		// 不能按首次包含 marker 的辅助请求误判会话模型隔离。
		const mainRequest = (marker: string) =>
			config.waitForRequest(request => {
				const tools = Reflect.get(request, "tools");
				return Array.isArray(tools) && tools.length > 0 && JSON.stringify(request.messages.at(-1)).includes(marker);
			});
		const [requestA, requestB] = await Promise.all([
			mainRequest("ZCODE_TEST_MODEL_A"),
			mainRequest("ZCODE_TEST_MODEL_B"),
		]);
		expect(requestA.model).toBe("chat-b");
		expect(requestB.model).toBe("chat-a");
	}, 120_000);
});
