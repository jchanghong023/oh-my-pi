import { describe, expect, test } from "bun:test";
import {
	canReuseCachedPr,
	createPrCacheContext,
	isSamePrCacheContext,
	parseDefaultBranch,
	parseGitStatus,
	parseGitHubRepo,
} from "../src/status-line/git-utils";
import { describeSegment, type SegmentContext } from "../src/status-line/segments";

describe("parseGitHubRepo", () => {
	test("parses HTTPS URL", () => {
		expect(parseGitHubRepo("https://github.com/can1357/oh-my-pi.git")).toBe("can1357/oh-my-pi");
	});

	test("parses HTTPS URL without .git suffix", () => {
		expect(parseGitHubRepo("https://github.com/can1357/oh-my-pi")).toBe("can1357/oh-my-pi");
	});

	test("parses SSH scp-style URL", () => {
		expect(parseGitHubRepo("git@github.com:loftiskg/oh-my-pi.git")).toBe("loftiskg/oh-my-pi");
	});

	test("parses ssh:// protocol URL", () => {
		expect(parseGitHubRepo("ssh://git@github.com/user/repo.git")).toBe("user/repo");
	});

	test("returns null for non-GitHub URL", () => {
		expect(parseGitHubRepo("https://gitlab.com/user/repo.git")).toBeNull();
	});

	test("handles GitHub Enterprise-style URLs (no match)", () => {
		expect(parseGitHubRepo("https://github.corp.com/org/repo.git")).toBeNull();
	});

	test("parses HTTPS URL with dots in repo name", () => {
		expect(parseGitHubRepo("https://github.com/org/my.repo.name.git")).toBe("org/my.repo.name");
	});

	test("parses URL with dots in repo name and no .git suffix", () => {
		expect(parseGitHubRepo("https://github.com/org/my.repo")).toBe("org/my.repo");
	});
});

describe("parseDefaultBranch", () => {
	test("strips origin/ prefix from origin/main", () => {
		expect(parseDefaultBranch("origin/main")).toBe("main");
	});

	test("strips upstream/ prefix", () => {
		expect(parseDefaultBranch("upstream/main")).toBe("main");
	});

	test("returns bare branch name unchanged", () => {
		expect(parseDefaultBranch("main")).toBe("main");
	});

	test("handles empty string", () => {
		expect(parseDefaultBranch("")).toBe("");
	});
});

describe("isSamePrCacheContext", () => {
	test("returns true when branch and repo match", () => {
		expect(
			isSamePrCacheContext(
				createPrCacheContext("feature/one", "/repo/.git/HEAD"),
				createPrCacheContext("feature/one", "/repo/.git/HEAD"),
			),
		).toBe(true);
	});

	test("returns false when repo changes but branch stays the same", () => {
		expect(
			isSamePrCacheContext(
				createPrCacheContext("feature/one", "/repo-a/.git/HEAD"),
				createPrCacheContext("feature/one", "/repo-b/.git/HEAD"),
			),
		).toBe(false);
	});
});

describe("canReuseCachedPr", () => {
	test("allows negative-cache reuse when context is unchanged", () => {
		expect(
			canReuseCachedPr(
				null,
				createPrCacheContext("feature/one", "/repo/.git/HEAD"),
				createPrCacheContext("feature/one", "/repo/.git/HEAD"),
			),
		).toBe(true);
	});

	test("rejects cached PR when branch changes", () => {
		expect(
			canReuseCachedPr(
				{ number: 12, url: "https://example.test/pr/12" },
				createPrCacheContext("feature/one", "/repo/.git/HEAD"),
				createPrCacheContext("feature/two", "/repo/.git/HEAD"),
			),
		).toBe(false);
	});

	test("rejects cached PR when repo context is unavailable", () => {
		expect(
			canReuseCachedPr(
				{ number: 12, url: "https://example.test/pr/12" },
				createPrCacheContext("feature/one", "/repo/.git/HEAD"),
				null,
			),
		).toBe(false);
	});
});

describe("parseGitStatus", () => {
	test("counts index/worktree overlap once and includes every untracked file but not ignored entries", () => {
		expect(
			parseGitStatus("MM both.txt\0A  staged.txt\0 D removed.txt\0?? new/a.txt\0?? new/b.txt\0!! ignored.txt\0"),
		).toEqual({
			staged: 2,
			unstaged: 2,
			untracked: 2,
			changed: 5,
			paths: {
				staged: ["both.txt", "staged.txt"],
				unstaged: ["both.txt", "removed.txt"],
				untracked: ["new/a.txt", "new/b.txt"],
			},
		});
	});

	test("skips rename/copy source paths and preserves filenames containing spaces and newlines", () => {
		expect(
			parseGitStatus("RM renamed file.txt\0?? old-name\0 C copied.txt\0MM source-name\0?? new\nname.txt\0"),
		).toEqual({
			staged: 1,
			unstaged: 2,
			untracked: 1,
			changed: 3,
			paths: {
				staged: ["renamed file.txt"],
				unstaged: ["renamed file.txt", "copied.txt"],
				untracked: ["new\nname.txt"],
			},
		});
	});

	test("counts a cached deletion with the same untracked path once", () => {
		const status = parseGitStatus("D  a.txt\0?? a.txt\0");
		expect(status).toEqual({
			staged: 1,
			unstaged: 0,
			untracked: 1,
			changed: 1,
			paths: { staged: ["a.txt"], unstaged: [], untracked: ["a.txt"] },
		});
		const ctx = { git: { branch: "master", status, pr: null }, options: {} } as SegmentContext;
		expect(
			describeSegment("git", ctx)
				?.spans.map(span => span.t)
				.join(""),
		).toBe("git master · 改动1");
	});

	test.each([
		{ options: {}, changed: 5 },
		{ options: { showStaged: false }, changed: 4 },
		{ options: { showUnstaged: false }, changed: 4 },
		{ options: { showUntracked: false }, changed: 4 },
		{ options: { showStaged: false, showUnstaged: false }, changed: 2 },
		{ options: { showStaged: false, showUntracked: false }, changed: 2 },
		{ options: { showUnstaged: false, showUntracked: false }, changed: 3 },
		{ options: { showStaged: false, showUnstaged: false, showUntracked: false }, changed: 0 },
	])(
		"counts the enabled category union for cached deletions and index/worktree overlap: $options",
		({ options, changed }) => {
			const status = parseGitStatus("D  a.txt\0?? a.txt\0MM both.txt\0A  staged.txt\0 D unstaged.txt\0?? new.txt\0");
			const ctx = { git: { branch: "master", status, pr: null }, options: { git: options } } as SegmentContext;
			expect(
				describeSegment("git", ctx)
					?.spans.map(span => span.t)
					.join(""),
			).toBe(`git master${changed > 0 ? ` · 改动${changed}` : ""}`);
		},
	);

	test.each([
		{ options: {}, changed: 5 },
		{ options: { showStaged: false }, changed: 5 },
		{ options: { showUnstaged: false }, changed: 2 },
		{ options: { showUntracked: false }, changed: 3 },
		{ options: { showUnstaged: false, showUntracked: false }, changed: 0 },
	])("preserves JJ's disjoint numeric categories: $options", ({ options, changed }) => {
		const ctx = {
			git: {
				branch: "jj-change",
				status: { staged: 0, unstaged: 3, untracked: 2, changed: 5, paths: null },
				pr: null,
			},
			options: { git: options },
		} as SegmentContext;
		expect(
			describeSegment("git", ctx)
				?.spans.map(span => span.t)
				.join(""),
		).toBe(`git jj-change${changed > 0 ? ` · 改动${changed}` : ""}`);
	});
});
