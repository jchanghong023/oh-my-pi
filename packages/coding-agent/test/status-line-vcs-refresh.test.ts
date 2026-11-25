/**
 * The status line's git facts come from background reads: a cold paint shows
 * nothing until the read lands, repaints reuse the facts until a run starts, a
 * turn ends or a user command finishes (reads at most one interval apart; a
 * skipped one runs once the run yields), and a cwd change drops the old
 * repository's facts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { GitStatus, StatusLineSettings } from "@oh-my-pi/pi-coding-agent/modes/view-model/status-line/types";
import type { VcsGitRepo, VcsHeadState, VcsRepo, VcsStatusSummary } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import * as utils from "@oh-my-pi/pi-utils";
import { disposeStatusLines, flushStatus, lineText, statusLine, statusSession } from "./helpers/session-status-line";

const CLEAN: GitStatus = [0, 0, 0, 0, 0, 0, 0, 0];

/** The status line's least time between two git/jj reads (`VCS_READ_INTERVAL_MS`). */
const READ_INTERVAL_MS = 10_000;

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
	vi.restoreAllMocks();
	vi.useRealTimers();
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

function mockRepos(byCwd: Record<string, VcsRepo>): void {
	const lookup = (cwd: string) => byCwd[cwd] ?? null;
	vi.spyOn(vcs, "repo").mockImplementation(lookup);
	vi.spyOn(vcs, "repoForDisplay").mockImplementation(lookup);
}

/** A session whose events the test emits. */
function emittingSession() {
	let emit: (event: { type: string }) => void = () => {};
	const session = statusSession({
		subscribe: (listener: (event: { type: string }) => void) => {
			emit = listener;
			return () => {};
		},
	});
	return { session, emit: (type: string) => emit({ type }) };
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

	it("reads nothing while the terminal shows the checkout itself", async () => {
		vi.spyOn(utils, "getProjectDir").mockReturnValue("/repo/homed");
		const counts = vi.fn<() => Promise<GitStatus>>().mockResolvedValue([0, 1, 0, 1, 0, 1, 0, 1]);
		mockRepos({ "/repo/homed": fakeRepo("/repo/homed", "homed-branch", counts) });
		const line = statusLine(statusSession(), gitSegment);

		line.setCheckoutHomed(true);
		lineText(line);
		await flushStatus();
		expect(counts).not.toHaveBeenCalled();
		expect(lineText(line)).not.toContain("homed-branch");

		// Turning it off reads the checkout here again.
		line.setCheckoutHomed(false);
		lineText(line);
		await flushStatus();
		expect(counts).toHaveBeenCalledTimes(1);
		expect(lineText(line)).toContain("homed-branch");
	});

	it("re-reads working-tree counts when a run starts and when a turn ends, not on repaints", async () => {
		vi.useFakeTimers();
		vi.spyOn(utils, "getProjectDir").mockReturnValue("/repo/turns");
		const counts = vi
			.fn<() => Promise<GitStatus>>()
			.mockResolvedValueOnce([0, 1, 0, 1, 0, 1, 0, 1])
			.mockResolvedValueOnce([0, 0, 7, 7, 0, 0, 7, 7])
			.mockResolvedValueOnce([0, 0, 0, 0, 3, 3, 3, 3]);
		mockRepos({ "/repo/turns": fakeRepo("/repo/turns", "main", counts) });
		const { session, emit } = emittingSession();
		const line = statusLine(session, gitSegment);

		lineText(line);
		await flushStatus();
		expect(lineText(line)).toContain("改动1");

		// Repaints and other session events reuse the facts.
		line.refresh();
		emit("message_end");
		await flushStatus();
		lineText(line);
		await flushStatus();
		expect(counts).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(READ_INTERVAL_MS);
		emit("turn_end");
		await flushStatus();
		lineText(line);
		await flushStatus();
		expect(counts).toHaveBeenCalledTimes(2);
		expect(lineText(line)).toContain("改动7");

		vi.advanceTimersByTime(READ_INTERVAL_MS);
		emit("agent_start");
		await flushStatus();
		lineText(line);
		await flushStatus();
		expect(counts).toHaveBeenCalledTimes(3);
		expect(lineText(line)).toContain("改动3");
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
	] as const)("limits event-driven reads with %s offline=%s", async (platform, offline, interval) => {
		const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
		const originalOffline = process.env.OMP_OFFLINE;
		Object.defineProperty(process, "platform", { ...originalPlatform, value: platform });
		process.env.OMP_OFFLINE = offline;
		try {
			vi.useFakeTimers();
			vi.spyOn(utils, "getProjectDir").mockReturnValue("/repo/ttl");
			const counts = vi
				.fn<() => Promise<GitStatus>>()
				.mockResolvedValueOnce([0, 0, 1, 1, 1, 1, 2, 2])
				.mockResolvedValueOnce([0, 0, 7, 7, 0, 0, 7, 7]);
			mockRepos({ "/repo/ttl": fakeRepo("/repo/ttl", "main", counts) });
			const { session, emit } = emittingSession();
			const line = statusLine(session, gitSegment);
			lineText(line);
			await flushStatus();
			expect(lineText(line)).toContain("改动2");
			expect(counts).toHaveBeenCalledTimes(1);

			vi.advanceTimersByTime(interval - 1);
			emit("turn_end");
			emit("agent_end");
			await flushStatus();
			expect(lineText(line)).toContain("改动2");
			await flushStatus();
			expect(counts).toHaveBeenCalledTimes(1);

			vi.advanceTimersByTime(1);
			lineText(line);
			await flushStatus();
			expect(counts).toHaveBeenCalledTimes(2);
			expect(lineText(line)).toContain("改动7");
		} finally {
			disposeStatusLines();
			Object.defineProperty(process, "platform", originalPlatform);
			if (originalOffline === undefined) delete process.env.OMP_OFFLINE;
			else process.env.OMP_OFFLINE = originalOffline;
		}
	});

	it("reads at most once per interval and runs a skipped read once the run yields", async () => {
		vi.useFakeTimers();
		vi.spyOn(utils, "getProjectDir").mockReturnValue("/repo/busy");
		const counts = vi
			.fn<() => Promise<GitStatus>>()
			.mockResolvedValueOnce([0, 1, 0, 1, 0, 1, 0, 1])
			.mockResolvedValueOnce([0, 0, 4, 4, 0, 0, 4, 4]);
		mockRepos({ "/repo/busy": fakeRepo("/repo/busy", "main", counts) });
		const { session, emit } = emittingSession();
		const line = statusLine(session, gitSegment);
		lineText(line);
		await flushStatus();

		// A turn ending right after the last read does not read again.
		emit("turn_end");
		await flushStatus();
		lineText(line);
		await flushStatus();
		expect(counts).toHaveBeenCalledTimes(1);

		// The run yields: the skipped read runs once the interval is up.
		emit("agent_end");
		vi.advanceTimersByTime(READ_INTERVAL_MS);
		lineText(line);
		await flushStatus();
		expect(counts).toHaveBeenCalledTimes(2);
		expect(lineText(line)).toContain("改动4");
	});

	it("re-reads git facts after a user command", async () => {
		vi.useFakeTimers();
		vi.spyOn(utils, "getProjectDir").mockReturnValue("/repo/head");
		let branch = "before";
		const repo = fakeRepo(
			"/repo/head",
			() => branch,
			async () => CLEAN,
		);
		mockRepos({ "/repo/head": repo });
		const line = statusLine(statusSession(), gitSegment);
		lineText(line);
		await flushStatus();
		expect(lineText(line)).toContain("before");

		branch = "after";
		line.refreshVcs();
		// Right after the last read: the command's read waits out the interval.
		vi.advanceTimersByTime(READ_INTERVAL_MS);
		lineText(line);
		await flushStatus();
		expect(lineText(line)).toContain("after");
	});

	it("drops the old repository's facts when the cwd moves", async () => {
		let cwd = "/repo/a";
		vi.spyOn(utils, "getProjectDir").mockImplementation(() => cwd);
		const clean = async () => CLEAN;
		mockRepos({
			"/repo/a": fakeRepo("/repo/a", "branch-a", clean),
			"/repo/b": fakeRepo("/repo/b", "branch-b", clean),
		});
		const line = statusLine(statusSession(), gitSegment);
		lineText(line);
		await flushStatus();
		expect(lineText(line)).toContain("branch-a");

		cwd = "/repo/b";
		line.applyCwdChange();
		expect(lineText(line)).not.toContain("branch-a");
		await flushStatus();
		expect(lineText(line)).toContain("branch-b");

		// A cwd without a repository shows no git facts.
		cwd = "/no/repo";
		line.applyCwdChange();
		lineText(line);
		await flushStatus();
		expect(lineText(line)).not.toContain("branch-");
	});
});
