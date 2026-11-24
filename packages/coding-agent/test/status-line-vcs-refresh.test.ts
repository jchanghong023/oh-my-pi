/**
 * The status line's git facts come from background reads: a cold paint shows
 * nothing until the read lands, working-tree counts are re-read once they are
 * older than the status TTL, one HEAD watcher serves a repository however
 * often the bar repaints, and a cwd change retires the old repository's
 * watcher and its facts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, setSystemTime, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { GitStatus, StatusLineSettings } from "@oh-my-pi/pi-coding-agent/modes/view-model/status-line/types";
import type { VcsGitRepo, VcsHeadState, VcsRepo, VcsStatusSummary } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import * as utils from "@oh-my-pi/pi-utils";
import { disposeStatusLines, flushStatus, lineText, statusLine, statusSession } from "./helpers/session-status-line";

const CLEAN: GitStatus = [0, 0, 0, 0, 0, 0, 0, 0];

const gitSegment: StatusLineSettings = {
	preset: "custom",
	leftSegments: ["git"],
	rightSegments: [],
	separator: "powerline-thin",
	sessionAccent: false,
	transparent: false,
};

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, overrides: { "git.enabled": true } });
});

afterAll(() => {
	resetSettingsForTest();
});

afterEach(() => {
	disposeStatusLines();
	setSystemTime();
	vi.restoreAllMocks();
});

/** A git repository on `branch` (read at every HEAD read). */
function fakeRepo(
	root: string,
	branch: string | (() => string),
	statusChangeCounts: () => Promise<GitStatus>,
): VcsRepo {
	const headSync = (): VcsHeadState => {
		const name = typeof branch === "string" ? branch : branch();
		return {
			kind: "ref",
			branch: name,
			refName: `refs/heads/${name}`,
			commit: undefined,
		};
	};
	const git = { headSync, linkedWorktree: () => null, statusChangeCounts } as unknown as VcsGitRepo;
	return {
		kind: () => "git",
		asGit: () => git,
		asJj: () => null,
		root: () => root,
	} as unknown as VcsRepo;
}

/** Repositories by cwd; `watch` records each watcher and whether it was retired. */
function mockRepos(byCwd: Record<string, VcsRepo>) {
	const watchers: { root: string; retired: boolean; fire(): void }[] = [];
	const lookup = (cwd: string) => byCwd[cwd] ?? null;
	vi.spyOn(vcs, "repo").mockImplementation(lookup);
	vi.spyOn(vcs, "repoForDisplay").mockImplementation(lookup);
	vi.spyOn(vcs, "watch").mockImplementation((repo, onChange) => {
		const watcher = {
			root: repo.root(),
			retired: false,
			fire: onChange as () => void,
		};
		watchers.push(watcher);
		return () => {
			watcher.retired = true;
		};
	});
	return watchers;
}

describe("status line VCS refresh", () => {
	it("shows git facts once the cold paint's background read lands", async () => {
		vi.spyOn(utils, "getProjectDir").mockReturnValue("/repo/cold");
		const status = Promise.withResolvers<GitStatus>();
		mockRepos({
			"/repo/cold": fakeRepo("/repo/cold", "cold-branch", () => status.promise),
		});
		const line = statusLine(statusSession(), gitSegment);

		expect(lineText(line)).not.toContain("cold-branch");
		// MM tracked, one unstaged, three untracked: staged and unstaged overlap.
		status.resolve([0, 1, 2, 2, 3, 4, 5, 5]);
		await flushStatus();

		const text = lineText(line);
		expect(text).toContain("cold-branch");
		expect(text).toContain("改动5");
		expect(text).not.toContain("改动6");

		line.previewSettings({ ...gitSegment, segmentOptions: { git: { showUntracked: false } } });
		expect(lineText(line)).toContain("改动2");
		line.previewSettings({ ...gitSegment, segmentOptions: { git: { showStaged: false, showUnstaged: false } } });
		expect(lineText(line)).toContain("改动3");
	});

	it("shows the jj status fallback once its cold read resolves", async () => {
		const root = "/repo/jj";
		vi.spyOn(utils, "getProjectDir").mockReturnValue(root);
		const status = Promise.withResolvers<VcsStatusSummary>();
		mockRepos({
			[root]: {
				kind: () => "jj",
				asGit: () => null,
				root: () => root,
				label: async () => "jj-bookmark",
				statusSummary: () => status.promise,
			} as unknown as VcsRepo,
		});
		const line = statusLine(statusSession(), gitSegment);
		expect(lineText(line)).not.toContain("改动");
		status.resolve({ staged: 0, unstaged: 2, untracked: 3 });
		await flushStatus();
		expect(lineText(line)).toContain("jj-bookmark");
		expect(lineText(line)).toContain("改动5");
	});

	it.each([
		["linux", "1", 60_000],
		["linux", " TRUE ", 60_000],
		["linux", "yes", 60_000],
		["linux", "On", 60_000],
		["linux", "false", 10_000],
		["linux", "", 10_000],
		["win32", "1", 10_000],
		["darwin", "on", 10_000],
	] as const)(
		"refreshes counts and honors explicit invalidation with %s offline=%s",
		async (platform, offline, ttl) => {
			const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
			const originalOffline = process.env.OMP_OFFLINE;
			Object.defineProperty(process, "platform", { ...originalPlatform, value: platform });
			process.env.OMP_OFFLINE = offline;
			try {
				const start = Date.now();
				setSystemTime(start);
				vi.spyOn(utils, "getProjectDir").mockReturnValue("/repo/ttl");
				const counts = vi
					.fn<() => Promise<GitStatus>>()
					.mockResolvedValueOnce([0, 0, 1, 1, 1, 1, 2, 2])
					.mockResolvedValueOnce([0, 0, 7, 7, 0, 0, 7, 7])
					.mockResolvedValueOnce([0, 0, 1, 1, 0, 0, 1, 1]);
				const watchers = mockRepos({ "/repo/ttl": fakeRepo("/repo/ttl", "main", counts) });
				const line = statusLine(statusSession(), gitSegment);
				lineText(line);
				await flushStatus();
				expect(lineText(line)).toContain("改动2");
				expect(counts).toHaveBeenCalledTimes(1);

				setSystemTime(start + ttl - 1);
				line.refresh();
				expect(lineText(line)).toContain("改动2");
				await flushStatus();
				expect(counts).toHaveBeenCalledTimes(1);

				setSystemTime(start + ttl);
				line.refresh();
				lineText(line);
				await flushStatus();
				expect(counts).toHaveBeenCalledTimes(2);
				expect(lineText(line)).toContain("改动7");

				watchers[0]!.fire();
				lineText(line);
				await flushStatus();
				expect(counts).toHaveBeenCalledTimes(3);
				expect(lineText(line)).toContain("改动1");
				expect(watchers).toHaveLength(1);
			} finally {
				disposeStatusLines();
				Object.defineProperty(process, "platform", originalPlatform);
				if (originalOffline === undefined) delete process.env.OMP_OFFLINE;
				else process.env.OMP_OFFLINE = originalOffline;
			}
		},
	);

	it("re-reads git facts at once when the HEAD watcher fires", async () => {
		vi.spyOn(utils, "getProjectDir").mockReturnValue("/repo/head");
		let branch = "before";
		const repo = fakeRepo(
			"/repo/head",
			() => branch,
			async () => CLEAN,
		);
		const watchers = mockRepos({ "/repo/head": repo });
		const line = statusLine(statusSession(), gitSegment);
		lineText(line);
		await flushStatus();
		expect(lineText(line)).toContain("before");

		branch = "after";
		watchers[0]!.fire();
		lineText(line);
		await flushStatus();
		expect(lineText(line)).toContain("after");
	});

	it("retires the old repository's watcher and facts when the cwd moves", async () => {
		let cwd = "/repo/a";
		vi.spyOn(utils, "getProjectDir").mockImplementation(() => cwd);
		const clean = async () => CLEAN;
		const watchers = mockRepos({
			"/repo/a": fakeRepo("/repo/a", "branch-a", clean),
			"/repo/b": fakeRepo("/repo/b", "branch-b", clean),
		});
		const line = statusLine(statusSession(), gitSegment);
		lineText(line);
		await flushStatus();
		expect(lineText(line)).toContain("branch-a");

		cwd = "/repo/b";
		line.applyCwdChange();
		expect(watchers[0]).toMatchObject({ root: "/repo/a", retired: true });
		expect(lineText(line)).not.toContain("branch-a");
		await flushStatus();
		expect(lineText(line)).toContain("branch-b");
		expect(watchers[1]).toMatchObject({ root: "/repo/b", retired: false });

		// A cwd without a repository shows no git facts and watches nothing.
		cwd = "/no/repo";
		line.applyCwdChange();
		lineText(line);
		await flushStatus();
		expect(lineText(line)).not.toContain("branch-");
		expect(watchers).toHaveLength(2);
		expect(watchers[1]!.retired).toBe(true);
	});
});
