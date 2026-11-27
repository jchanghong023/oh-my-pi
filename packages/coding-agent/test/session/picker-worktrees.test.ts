import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { closeSessionIndex } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { createSessionWorktree } from "@oh-my-pi/pi-coding-agent/session/session-worktree";
import { sessionDirForCwd, worktreeSessionDirs } from "@oh-my-pi/pi-coding-agent/session/session-paths";
import { getConfigRootDir, hashPath, removeSyncWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import { makeAssistantMessage } from "../session-manager/helpers";

/** Host git config (signing, hooks) must not leak into the fixture repo; worktrees stay under the temp root. */
const TEST_ENV_KEYS = [
	"GIT_CONFIG_GLOBAL",
	"GIT_CONFIG_NOSYSTEM",
	"GIT_AUTHOR_NAME",
	"GIT_AUTHOR_EMAIL",
	"GIT_COMMITTER_NAME",
	"GIT_COMMITTER_EMAIL",
	"OMP_WORKTREE_DIR",
] as const;

/**
 * `/wt` moves a session into a linked worktree's session directory. The
 * resume picker must keep that session reachable from the checkout it left
 * (and the reverse), without widening a subfolder's scope to the repo root,
 * and a session whose worktree was removed must resume from the checkout.
 */
describe("resume picker across git worktrees", () => {
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	const originalEnv = Object.fromEntries(TEST_ENV_KEYS.map(key => [key, process.env[key]]));
	let root: string;
	let repo: string;

	beforeEach(async () => {
		root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-picker-wt-")));
		Object.assign(process.env, {
			GIT_CONFIG_GLOBAL: path.join(root, "empty-gitconfig"),
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_AUTHOR_NAME: "Test",
			GIT_AUTHOR_EMAIL: "test@example.com",
			GIT_COMMITTER_NAME: "Test",
			GIT_COMMITTER_EMAIL: "test@example.com",
			OMP_WORKTREE_DIR: path.join(root, "wt-base"),
		});
		await Bun.write(process.env.GIT_CONFIG_GLOBAL!, "");
		setAgentDir(path.join(root, "agent"));
		repo = path.join(root, "projects", "repo");
		fs.mkdirSync(path.join(repo, "pkg"), { recursive: true });
		await $`git init -q && git commit -q --allow-empty -m init`.cwd(repo).quiet();
	});

	afterEach(() => {
		// Picker scans own a cached history.db connection under the fixture root.
		closeSessionIndex();
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(path.join(getConfigRootDir(), "agent"));
			delete process.env.PI_CODING_AGENT_DIR;
		}
		for (const key of TEST_ENV_KEYS) {
			if (originalEnv[key] === undefined) delete process.env[key];
			else process.env[key] = originalEnv[key];
		}
		removeSyncWithRetries(root);
	});

	async function answeredSession(cwd: string): Promise<SessionManager> {
		const session = SessionManager.create(cwd);
		session.appendMessage({ role: "user", content: `work in ${cwd}`, timestamp: 1 });
		session.appendMessage(makeAssistantMessage());
		await session.flush();
		return session;
	}

	/** The resume picker's full scan for `cwd`. */
	async function pickerSessions(cwd: string, worktreeScope?: "directory" | "repo"): Promise<SessionInfo[]> {
		return (await SessionManager.listForPicker(cwd, undefined, undefined, worktreeScope)).complete;
	}

	/** The all-projects resume picker's full scan. */
	async function allPickerSessions(): Promise<SessionInfo[]> {
		return (await SessionManager.listAllForPicker()).complete;
	}

	/** Runs `/wt`'s worktree creation and session move for a fresh session in `repo`. */
	async function sessionMovedByWt(branch: string): Promise<{ id: string; worktree: string }> {
		const session = await answeredSession(repo);
		const { path: worktree } = await createSessionWorktree(repo, Settings.isolated(), branch);
		await session.moveTo(worktree);
		await session.close();
		return { id: session.getSessionId(), worktree };
	}

	// Preserve the existing platform restriction on session migration/resume.
	// Bucket discovery below still exercises real git worktree removal on Windows.
	it.skipIf(process.platform === "win32")(
		"lists a session moved into a worktree from the original checkout, and vice versa",
		async () => {
			const moved = await sessionMovedByWt("wt/live");
			const stayed = await answeredSession(repo);
			await stayed.close();
			const nested = await answeredSession(path.join(repo, "pkg"));
			await nested.close();

			const ids = async (cwd: string) => (await pickerSessions(cwd)).map(s => s.id).sort();
			const rootIds = [moved.id, stayed.getSessionId()].sort();
			expect(await ids(repo)).toEqual(rootIds);
			expect(await ids(moved.worktree)).toEqual(rootIds);
			expect(await ids(path.join(repo, "pkg"))).toEqual([nested.getSessionId()]);

			// A live worktree is not removed: its session resumes in place.
			const listed = (await pickerSessions(repo)).find(s => s.id === moved.id)!;
			expect(await SessionManager.isStrandedIn(listed, repo)).toBe(false);
		},
	);

	it.skipIf(process.platform === "win32")(
		"can keep the current-folder picker isolated while all-projects still reaches other worktrees",
		async () => {
			const moved = await sessionMovedByWt("wt/scoped");
			const stayed = await answeredSession(repo);
			await stayed.close();

			const directoryIds = async (cwd: string) =>
				(await pickerSessions(cwd, "directory")).map(session => session.id);
			expect(await directoryIds(repo)).toEqual([stayed.getSessionId()]);
			expect(await directoryIds(moved.worktree)).toEqual([moved.id]);
			expect((await allPickerSessions()).map(session => session.id).sort()).toEqual(
				[moved.id, stayed.getSessionId()].sort(),
			);
			// Choosing a narrower listing never changes relocation of a deleted worktree session.
			await $`git worktree remove --force ${moved.worktree} && git worktree prune`.cwd(repo).quiet();
			const listed = (await allPickerSessions()).find(session => session.id === moved.id)!;
			expect(await SessionManager.isStrandedIn(listed, repo)).toBe(true);
		},
	);

	it.skipIf(process.platform === "win32")(
		"keeps a removed worktree's session listed and relocates it into the checkout on resume",
		async () => {
			const moved = await sessionMovedByWt("wt/gone");
			// `omp worktree clear` removes and prunes: git no longer knows the worktree.
			await $`git worktree remove --force ${moved.worktree} && git worktree prune`.cwd(repo).quiet();

			const listed = (await pickerSessions(repo)).find(s => s.id === moved.id);
			expect(listed?.cwd).toBe(moved.worktree);
			expect(await SessionManager.isStrandedIn(listed!, repo)).toBe(true);

			const relocated = await SessionManager.openRelocated(listed!.path, listed!.cwd, repo);
			await relocated.close();
			const own = await SessionManager.list(repo);
			expect(own.map(s => [s.id, s.cwd])).toEqual([[moved.id, repo]]);
			expect(fs.existsSync(listed!.path)).toBe(false);
		},
	);

	it.skipIf(process.platform === "win32")(
		"recovers a session moved from an external linked worktree after both worktrees are pruned",
		async () => {
			const linked = path.join(root, "elsewhere", "current");
			fs.mkdirSync(path.dirname(linked), { recursive: true });
			await $`git worktree add -q -b external ${linked}`.cwd(repo).quiet();
			const session = await answeredSession(linked);
			const id = session.getSessionId();
			const messages = session.buildSessionContext().messages;
			const { path: worktree } = await createSessionWorktree(linked, Settings.isolated(), "wt/next");
			expect(path.dirname(worktree)).toBe(path.dirname(linked));
			await session.moveTo(worktree);
			await session.close();

			await $`git worktree remove --force ${worktree} && git worktree remove --force ${linked} && git worktree prune`
				.cwd(repo)
				.quiet();
			const listed = (await pickerSessions(repo)).find(s => s.id === id);
			expect(listed?.cwd).toBe(worktree);
			expect(await SessionManager.isStrandedIn(listed!, repo)).toBe(true);

			const relocated = await SessionManager.openRelocated(listed!.path, listed!.cwd, repo);
			expect(relocated.buildSessionContext().messages).toEqual(messages);
			await relocated.close();
			expect((await SessionManager.list(repo)).map(s => [s.id, s.cwd])).toEqual([[id, repo]]);
			expect(fs.existsSync(listed!.path)).toBe(false);
		},
	);

	it("discovers pruned external worktree buckets without leaking another repo or subfolder", async () => {
		const linked = path.join(root, "elsewhere", "current");
		fs.mkdirSync(path.dirname(linked), { recursive: true });
		await $`git worktree add -q -b external ${linked}`.cwd(repo).quiet();
		const { path: worktree } = await createSessionWorktree(linked, Settings.isolated(), "wt/next");
		const sessionsRoot = path.join(root, "buckets");
		const own = sessionDirForCwd(repo, sessionsRoot);
		const sibling = sessionDirForCwd(worktree, sessionsRoot);
		const nested = sessionDirForCwd(path.join(worktree, "pkg"), sessionsRoot);
		const wrongPrefix = sessionDirForCwd(path.join(worktree, "pkg-other"), sessionsRoot);
		const otherRepo = sessionDirForCwd(
			path.join(root, "elsewhere", `wt-next-${hashPath(path.join(root, "other-repo"))}`),
			sessionsRoot,
		);
		const oldSibling = sessionDirForCwd(path.join(path.dirname(repo), `wt-old-${hashPath(repo)}`), sessionsRoot);
		const managed = sessionDirForCwd(path.join(root, "wt-base", `pr-1-${hashPath(repo)}-2`), sessionsRoot);
		for (const dir of [own, sibling, nested, wrongPrefix, otherRepo, oldSibling, managed]) {
			fs.mkdirSync(dir, { recursive: true });
		}

		await $`git worktree remove --force ${worktree} && git worktree remove --force ${linked} && git worktree prune`
			.cwd(repo)
			.quiet();
		expect([...(await worktreeSessionDirs(repo, own)).keys()].sort()).toEqual([sibling, oldSibling, managed].sort());
		const nestedCwd = path.join(repo, "pkg");
		expect([...(await worktreeSessionDirs(nestedCwd, sessionDirForCwd(nestedCwd, sessionsRoot))).keys()]).toEqual([
			nested,
		]);
		expect((await worktreeSessionDirs(repo, path.join(sessionsRoot, "custom"))).size).toBe(0);
	});

	it("distinguishes a suffixed worktree from a numeric subfolder sharing its session bucket", async () => {
		const { path: worktree } = await createSessionWorktree(repo, Settings.isolated(), "wt/collision");
		const suffixed = `${worktree}-2`;
		const worktreeSubfolder = path.join(worktree, "2");
		const repoSubfolder = path.join(repo, "2");
		await $`git worktree add -q -b wt/collision-suffix ${suffixed}`.cwd(repo).quiet();
		fs.mkdirSync(worktreeSubfolder);
		fs.mkdirSync(repoSubfolder);

		const records = [];
		for (const [cwd, title] of [
			[suffixed, "Suffixed worktree root"],
			[worktreeSubfolder, "Numeric worktree subfolder"],
		] as const) {
			const session = await answeredSession(cwd);
			await session.setSessionName(title, "user");
			await session.close();
			records.push({ id: session.getSessionId(), cwd, path: session.getSessionFile()! });
		}
		const [rootRecord, subfolderRecord] = records;
		expect(path.dirname(rootRecord.path)).toBe(path.dirname(subfolderRecord.path));

		const checkOwnership = async (stranded: boolean) => {
			const identity = ({ id, cwd, path }: SessionInfo) => ({ id, cwd, path });
			for (const [cwd, own, other] of [
				[repo, rootRecord, subfolderRecord],
				[repoSubfolder, subfolderRecord, rootRecord],
			] as const) {
				const listing = await SessionManager.listForPicker(cwd);
				expect(listing.sessions.map(identity)).toEqual([own]);
				expect((await listing.complete).map(identity)).toEqual([own]);
				expect(await SessionManager.isStrandedIn(own, cwd)).toBe(stranded);
				expect(await SessionManager.isStrandedIn(other, cwd)).toBe(false);
			}
		};

		await checkOwnership(false);
		await $`git worktree remove --force ${suffixed} && git worktree remove --force ${worktree} && git worktree prune`
			.cwd(repo)
			.quiet();
		await checkOwnership(true);
	});

	it("relocates a session filed under this folder whose recorded folder was moved away", async () => {
		const before = path.join(root, "before");
		const after = path.join(root, "after");
		fs.mkdirSync(before);
		const session = await answeredSession(before);
		await session.close();
		// A project moved by hand along with its session bucket: headers keep the old path.
		const bucket = path.dirname(session.getSessionFile()!);
		fs.renameSync(before, after);
		fs.renameSync(bucket, sessionDirForCwd(after, path.dirname(bucket)));

		const listed = (await pickerSessions(after)).find(s => s.id === session.getSessionId());
		expect(listed?.cwd).toBe(before);
		expect(await SessionManager.isStrandedIn(listed!, after)).toBe(true);

		const relocated = await SessionManager.openRelocated(listed!.path, listed!.cwd, after);
		await relocated.close();
		expect((await SessionManager.list(after)).map(s => [s.path, s.cwd])).toEqual([[listed!.path, after]]);
	});
});
