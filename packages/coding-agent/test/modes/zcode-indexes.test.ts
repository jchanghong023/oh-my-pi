import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Writable } from "node:stream";
import { __resetDirsFromEnvForTests, getAgentDir } from "@oh-my-pi/pi-utils/dirs";
import { ZCodeServer } from "../../src/modes/zcode/server";
import type { DocsBuildResult, DocsSearchResult } from "../../src/docs/types";
import type { RepoStatus } from "../../src/repo/types";
import { SessionManager } from "../../src/session/session-manager";

// 原生服务回归在 .e2e.ts；这里仅补公共 dispatch 的路由、通知与冷读边界。
test("public optional methods preserve workspace routing, native index results and cold Team journals", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-index-dispatch-"));
	const keys = [
		"OMP_CONFIG_ROOT",
		"PI_CODING_AGENT_DIR",
		"OMP_PROFILE",
		"PI_PROFILE",
		"PI_CONFIG_DIR",
		"OMP_OFFLINE",
	] as const;
	const previous = keys.map(key => process.env[key]);
	let server: ZCodeServer | undefined;
	try {
		process.env.OMP_CONFIG_ROOT = path.join(root, "config");
		process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
		delete process.env.OMP_PROFILE;
		delete process.env.PI_PROFILE;
		process.env.PI_CONFIG_DIR = ".omp";
		process.env.OMP_OFFLINE = "0";
		// resolver 会缓存 profile/agent 路径，改环境后必须重建，避免命中真实用户目录。
		__resetDirsFromEnvForTests();
		expect(getAgentDir()).toBe(path.join(root, "agent"));
		const cwd = path.join(root, "workspace");
		const other = path.join(root, "other");
		await fs.mkdir(cwd);
		await fs.mkdir(other);
		const canonical = await fs.realpath(cwd);
		const workspace = {
			workspacePath: canonical,
			workspaceKey: "dispatch:local",
			workspaceIdentity: "dispatch:local",
		};
		const document = path.join(cwd, "guide.md");
		await fs.writeFile(document, "# DispatchSignal\n\nNative dispatch documentation survives source removal.\n");
		await fs.writeFile(path.join(cwd, "entry.ts"), "export function dispatchSignal() { return 42; }\n");
		const frames: Array<{ method?: string; params?: unknown }> = [];
		server = new ZCodeServer({
			cwd,
			output: new Writable({
				write(chunk, _encoding, done) {
					frames.push(JSON.parse(String(chunk)));
					done();
				},
			}),
		});
		await server.initialize();
		const capabilities = await server.dispatch("runtime/capabilities", {});
		expect(capabilities).toMatchObject({ historyFirst: true, ompIndexes: true, ompTeam: true });
		const build = (await server.dispatch("omp/wiki/init", {
			workspace,
			operationId: "wiki-build",
			directory: canonical,
			confirmedDirectory: canonical,
			name: "dispatch-docs",
		})) as DocsBuildResult;
		expect(build.processed).toBeGreaterThan(0);
		await server.writer.flush();
		expect(frames).toContainEqual(
			expect.objectContaining({
				method: "omp/wiki/progress",
				params: expect.objectContaining({ operationId: "wiki-build", workspace }),
			}),
		);
		await fs.rm(document);
		const search = (await server.dispatch("omp/wiki/search", {
			workspace,
			operationId: "wiki-search",
			query: "DispatchSignal",
		})) as DocsSearchResult;
		expect(search.sections.some(section => section.text.includes("Native dispatch documentation"))).toBe(true);
		const status = (await server.dispatch("omp/repo/status", {
			workspace,
			operationId: "repo-status",
		})) as RepoStatus;
		await expect(
			server.dispatch("omp/repo/init", { workspace, operationId: "bad-root", confirmedRoot: other }),
		).rejects.toThrow("Confirm repository root");
		const repo = (await server.dispatch("omp/repo/init", {
			workspace,
			operationId: "repo-build",
			confirmedRoot: status.root,
		})) as RepoStatus;
		expect(repo.fileCount).toBeGreaterThan(0);
		await expect(
			server.dispatch("omp/wiki/list", { workspace, operationId: "bad-shape", action: "list" }),
		).rejects.toThrow();
		await expect(
			server.dispatch("omp/wiki/cancel", {
				workspace: { ...workspace, workspacePath: other },
				operationId: "wiki-build",
			}),
		).rejects.toThrow("registered route");
		await expect(
			server.dispatch("omp/wiki/searchExtra", { workspace, operationId: "unknown", query: "DispatchSignal" }),
		).rejects.toThrow();
		await server.dispatch("omp/wiki/remove", { workspace, operationId: "wiki-remove", name: "dispatch-docs" });
		await server.dispatch("omp/repo/remove", { workspace, operationId: "repo-remove", confirmedRoot: status.root });
		expect(await fs.readFile(path.join(cwd, "entry.ts"), "utf8")).toContain("dispatchSignal");

		// 冷读必须使用真实 journal，不能为了查看 Team 结果激活 Agent 或取得 writer lease。
		const journal = SessionManager.create(cwd, SessionManager.getDefaultSessionDir(cwd, getAgentDir()));
		const sessionId = journal.getSessionId();
		try {
			journal.appendCustomMessageEntry("team-dispatch", "Dispatched historical Team job", true, {
				jobId: "historical-team",
				question: "historical",
			});
			journal.appendCustomMessageEntry("team-result", "Historical report without child observations", true, {
				jobId: "historical-team",
			});
			await journal.ensureOnDisk();
			await journal.flush();
		} finally {
			await journal.close();
		}
		expect(await server.dispatch("omp/team", { action: "read", sessionId, jobId: "historical-team" })).toMatchObject({
			run: {
				source: "native-journal",
				status: "unavailable",
				nodes: [],
				edges: [],
				report: "Historical report without child observations",
			},
		});
		expect(await server.dispatch("omp/team", { action: "stop", sessionId, jobId: "historical-team" })).toMatchObject({
			accepted: false,
		});
		expect(server.manager.get(sessionId)).toBeUndefined();
		await server.dispose();
		await expect(server.dispatch("omp/wiki/list", { workspace, operationId: "closed" })).rejects.toThrow(
			"Storage is not ready",
		);
	} finally {
		try {
			await server?.dispose();
		} finally {
			for (const [index, key] of keys.entries()) {
				const value = previous[index];
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			__resetDirsFromEnvForTests();
			await fs.rm(root, { recursive: true, force: true });
		}
	}
}, 30_000);
