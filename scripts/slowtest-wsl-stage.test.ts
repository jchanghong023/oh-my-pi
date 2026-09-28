import { describe, expect, test } from "bun:test";
import {
	decodeWslOutput,
	normalizeGitUrl,
	parseWslListVerbose,
	pickWslRepo,
	repoNameFromUrl,
	WSL_STAGE_TIMEOUT_MS,
	WSL_TEST_DISTRIBUTION,
} from "./slowtest-wsl-stage.ts";

describe("decodeWslOutput", () => {
	test("decodes UTF-8 command output and UTF-16LE management output", () => {
		expect(decodeWslOutput(new TextEncoder().encode("/root/repo.git"))).toBe("/root/repo.git");
		const utf16 = new Uint8Array([0xff, 0xfe, 0x2f, 0x00, 0x72, 0x00, 0x6f, 0x00, 0x6f, 0x00, 0x74, 0x00]);
		expect(decodeWslOutput(utf16)).toBe("/root");
	});
});

describe("parseWslListVerbose", () => {
	test("parses distro rows under the header and skips noise", () => {
		const raw = [
			"  NAME            STATE           VERSION",
			"  * Ubuntu-24.04    Running         2",
			"    ubuntu-24.04         Stopped         2",
			"    legacy          Stopped         1",
			"",
		].join("\r\n");
		expect(parseWslListVerbose(raw)).toEqual([
			{ name: "Ubuntu-24.04", state: "Running", version: "2" },
			{ name: "ubuntu-24.04", state: "Stopped", version: "2" },
			{ name: "legacy", state: "Stopped", version: "1" },
		]);
	});
});

describe("normalizeGitUrl", () => {
	test("https, ssh, and scp spellings of one repo normalize identically", () => {
		expect(normalizeGitUrl("https://github.com/jchanghong023/oh-my-pi.git")).toBe(
			normalizeGitUrl("git@github.com:jchanghong023/oh-my-pi.git"),
		);
		expect(normalizeGitUrl("ssh://git@github.com/jchanghong023/oh-my-pi")).toBe(
			normalizeGitUrl("https://GitHub.com/jchanghong023/oh-my-pi.git/"),
		);
	});
});

describe("pickWslRepo", () => {
	const fetchUrl = "https://github.com/jchanghong023/oh-my-pi.git";

	test("matches a clone by any of its remotes, case/name agnostic", () => {
		const pick = pickWslRepo(
			[
				{ path: "/root/other", remotes: [{ name: "origin", url: "https://github.com/someone/else.git" }] },
				{
					path: "/root/OmpCode",
					remotes: [{ name: "github", url: "git@github.com:jchanghong023/oh-my-pi.git" }],
				},
			],
			fetchUrl,
		);
		expect(pick).toEqual({ kind: "match", path: "/root/OmpCode", remoteName: "github" });
	});

	test("reports none and ambiguous instead of guessing", () => {
		expect(
			pickWslRepo([{ path: "/root/x", remotes: [{ name: "origin", url: "https://x/y.git" }] }], fetchUrl),
		).toEqual({
			kind: "none",
		});
		const ambiguous = pickWslRepo(
			[
				{ path: "/root/a", remotes: [{ name: "origin", url: fetchUrl }] },
				{ path: "/root/b", remotes: [{ name: "up", url: `git@github.com:jchanghong023/oh-my-pi.git` }] },
			],
			fetchUrl,
		);
		expect(ambiguous.kind).toBe("ambiguous");
	});
});

describe("stage constants", () => {
	test("the distro under test is Ubuntu-24.04 with a 2-hour budget", () => {
		expect(WSL_TEST_DISTRIBUTION).toBe("Ubuntu-24.04");
		expect(WSL_STAGE_TIMEOUT_MS).toBe(2 * 60 * 60_000);
	});
});

describe("repoNameFromUrl", () => {
	test("derives the clone directory from the url tail", () => {
		expect(repoNameFromUrl("https://github.com/jchanghong023/oh-my-pi.git")).toBe("oh-my-pi");
		expect(repoNameFromUrl("git@github.com:jchanghong023/oh-my-pi.git")).toBe("oh-my-pi");
	});
});
