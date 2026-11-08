import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createNativeGitMethods } from "../../src/webgui/native-git";
import { acquireBrowserProject } from "../../src/webgui/project-registry";
import type { WebGuiServiceContext } from "../../src/webgui/rpc-contract";
import { readWebGuiSessionInfo } from "../../src/webgui/session-source";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { getTestModel } from "../helpers/model-fixtures";

async function nativeFixture(temp: TempDir, cwd: string) {
	const authStorage = createInMemoryAuthStorage();
	const { session } = await createAgentSession({
		cwd,
		agentDir: temp.join("agent"),
		sessionManager: SessionManager.inMemory(cwd),
		authStorage,
		modelRegistry: new ModelRegistry(authStorage, temp.join("models.yml")),
		settings: Settings.isolated({ "compaction.enabled": false, "memory.backend": "off", "async.enabled": false }),
		model: getTestModel("ascend"),
		disableExtensionDiscovery: true,
		bindProcessState: false,
		skills: [],
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
	const controller = new AbortController();
	const context: WebGuiServiceContext = {
		connectionId: crypto.randomUUID(),
		projectId: lease.projectId,
		workspacePath: lease.root,
		nativeSession: session,
		signal: controller.signal,
	};
	return {
		methods: createNativeGitMethods(context),
		context,
		controller,
		async close() {
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

async function repository(cwd: string) {
	// Same ordinary-repository layout as the existing native VCS/workbench fixtures.
	// Native VCS creates every object, index and commit; no Git subprocess or ambient identity.
	const git = path.join(cwd, ".git");
	for (const child of ["objects", "refs/heads", "refs/tags"])
		await fs.mkdir(path.join(git, child), { recursive: true });
	await fs.writeFile(path.join(git, "HEAD"), "ref: refs/heads/main\n");
	await fs.writeFile(
		path.join(git, "config"),
		"[core]\nrepositoryformatversion=0\nbare=false\nautocrlf=false\nhooksPath=disabled-hooks\n[user]\nname=Git Read Fixture\nemail=git-read@example.invalid\n[commit]\ngpgsign=false\n",
	);
	const repo = vcs.requireGit(cwd);
	await fs.writeFile(path.join(cwd, "tracked.txt"), "first\nbase\n");
	await fs.writeFile(path.join(cwd, "deleted.txt"), "removed\n");
	await repo.stageFiles(["tracked.txt", "deleted.txt"]);
	const initial = await repo.commitCreate("baseline", {
		author: { name: "Git Read Fixture", email: "git-read@example.invalid", date: "2026-11-01T00:00:00Z" },
	});
	await repo.createBranch("feature", initial, false);
	await repo.checkout("feature");
	await repo.configSet("branch.feature.remote", ".");
	await repo.configSet("branch.feature.merge", "refs/heads/main");
	await fs.writeFile(path.join(cwd, "tracked.txt"), "first\nfeature\n");
	await repo.stageFiles(["tracked.txt"]);
	const feature = await repo.commitCreate("feature history", {
		author: { name: "Git Read Fixture", email: "git-read@example.invalid", date: "2026-11-02T00:00:00Z" },
	});
	await fs.writeFile(path.join(cwd, "tracked.txt"), "first\nstaged\n");
	await repo.stageFiles(["tracked.txt"]);
	await fs.writeFile(path.join(cwd, "tracked.txt"), "first\nunstaged\n");
	await fs.writeFile(path.join(cwd, "new.txt"), "new\n");
	await fs.unlink(path.join(cwd, "deleted.txt"));
	return { repo, initial, feature };
}

test("native Git reads preserve real index/worktree differences, tracking counts and branch history", async () => {
	using temp = TempDir.createSync("@pi-native-git-");
	const cwd = temp.join("checkout");
	const { repo, initial, feature } = await repository(cwd);
	const fixture = await nativeFixture(temp, cwd);
	const params = { workspacePath: cwd };
	const indexBefore = await fs.readFile(path.join(cwd, ".git", "index"));
	try {
		expect(await fixture.methods.getRepositorySummary(params)).toMatchObject({
			isGitAvailable: true,
			isRepository: true,
			isDirty: true,
			branchName: "feature",
			headRefType: "branch",
			trackingBranchName: "main",
			ahead: 1,
			behind: 0,
		});
		expect(await fixture.methods.getChanges({ ...params, sourceId: "staged" })).toEqual([
			expect.objectContaining({
				repoRelativePath: "tracked.txt",
				section: "staged",
				added: 1,
				removed: 1,
				isStaged: true,
			}),
		]);
		expect(await fixture.methods.getChanges({ ...params, sourceId: "unstaged" })).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ repoRelativePath: "tracked.txt", section: "unstaged", added: 1, removed: 1 }),
				expect.objectContaining({ repoRelativePath: "deleted.txt", kind: "deleted", removed: 1 }),
				expect.objectContaining({ repoRelativePath: "new.txt", section: "untracked", kind: "added", added: 1 }),
			]),
		);
		expect(
			await fixture.methods.getDiff({ ...params, path: path.join(cwd, "tracked.txt"), sourceId: "staged" }),
		).toMatchObject({
			availability: "patch",
			beforeContent: "first\nfeature\n",
			afterContent: "first\nstaged\n",
			patch: expect.stringContaining("+staged"),
		});
		expect(await fixture.methods.getDiff({ ...params, path: "tracked.txt", sourceId: "unstaged" })).toMatchObject({
			availability: "patch",
			beforeContent: "first\nstaged\n",
			afterContent: "first\nunstaged\n",
			patch: expect.stringContaining("+unstaged"),
		});
		expect(await fixture.methods.getDiff({ ...params, path: "deleted.txt" })).toMatchObject({
			availability: "patch",
			beforeContent: "removed\n",
			afterContent: "",
		});
		expect(await fixture.methods.getDiff({ ...params, path: "new.txt" })).toMatchObject({
			availability: "patch",
			beforeContent: "",
			afterContent: "new\n",
			patch: expect.stringContaining("+new"),
		});
		expect(await fixture.methods.getLocalBranches(params)).toMatchObject({
			currentBranchName: "feature",
			branches: expect.arrayContaining([
				expect.objectContaining({ name: "main", commitHash: initial, isCurrent: false }),
				expect.objectContaining({ name: "feature", commitHash: feature, isCurrent: true, upstreamName: "main" }),
			]),
		});
		expect(await fixture.methods.getCommitGraph({ ...params, maxCount: 10 })).toMatchObject({
			hasMore: false,
			commits: expect.arrayContaining([
				expect.objectContaining({ hash: initial, parents: [], subject: "baseline" }),
				expect.objectContaining({
					hash: feature,
					parents: [initial],
					subject: "feature history",
					authorName: "Git Read Fixture",
				}),
			]),
		});
		expect(await fixture.methods.getCommitGraph({ ...params, maxCount: 1, skip: 1 })).toMatchObject({
			hasMore: false,
			commits: [expect.objectContaining({ hash: initial })],
		});
		expect(await fixture.methods.refresh(params)).toMatchObject({
			summary: { isDirty: true, ahead: 1, behind: 0 },
			stagedChanges: [expect.objectContaining({ repoRelativePath: "tracked.txt" })],
			unstagedChanges: expect.arrayContaining([expect.objectContaining({ repoRelativePath: "new.txt" })]),
		});
		await expect(fixture.methods.getDiff({ ...params, path: temp.join("outside.txt") })).rejects.toThrow();
		expect(await fs.readFile(path.join(cwd, ".git", "index"))).toEqual(indexBefore);
		expect(await repo.headSha()).toBe(feature);
	} finally {
		await fixture.close();
	}
});

test("native Git distinguishes a nonrepository and refuses another workspace or an aborted owner", async () => {
	using temp = TempDir.createSync("@pi-native-git-boundary-");
	const cwd = temp.join("not-a-repository");
	const other = temp.join("other");
	await fs.mkdir(cwd);
	await fs.mkdir(other);
	const fixture = await nativeFixture(temp, cwd);
	try {
		expect(await fixture.methods.getRepositorySummary({ workspacePath: cwd })).toMatchObject({
			isGitAvailable: true,
			isRepository: false,
			repoRoot: "",
			branchName: null,
		});
		await expect(fixture.methods.getChanges({ workspacePath: cwd, sourceId: "unstaged" })).rejects.toThrow(
			/not a Git repository/,
		);
		await expect(fixture.methods.getRepositorySummary({ workspacePath: other })).rejects.toThrow(/does not match/);
		fixture.controller.abort(new Error("Fixture connection closed"));
		await expect(fixture.methods.getRepositorySummary({ workspacePath: cwd })).rejects.toThrow(
			/Fixture connection closed/,
		);
	} finally {
		await fixture.close();
	}
});
