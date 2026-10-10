import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	decodeWslOutput,
	normalizeGitUrl,
	parseWslListVerbose,
	pickWslRepo,
	repoNameFromUrl,
	syncWslRepo,
	wslCancelCommand,
	wslFulltestCommand,
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
	test("fast-forwards the target branch without advancing the previously active branch", () => {
		let current = "feature";
		const tips: Record<string, string> = { main: "old", feature: "old" };
		syncWslRepo(
			"Ubuntu-24.04",
			{ path: "/root/repo", remoteName: "origin" },
			"expected",
			"main",
			(_distro, _repo, args) => {
				let stdout = "";
				if (args[0] === "rev-parse")
					stdout = tips[args[1] === "HEAD" ? current : args[1]!.replace("refs/heads/", "")]!;
				if (args[0] === "checkout") current = args[1]!;
				if (args[0] === "merge") tips[current] = args[2]!;
				return { exitCode: 0, stdout, stderr: "" };
			},
		);
		expect(current).toBe("main");
		expect(tips).toEqual({ main: "expected", feature: "old" });
	});
	test("the distro under test is Ubuntu-24.04", () => {
		expect(WSL_TEST_DISTRIBUTION).toBe("Ubuntu-24.04");
	});
});

describe("repoNameFromUrl", () => {
	test("derives the clone directory from the url tail", () => {
		expect(repoNameFromUrl("https://github.com/jchanghong023/oh-my-pi.git")).toBe("oh-my-pi");
		expect(repoNameFromUrl("git@github.com:jchanghong023/oh-my-pi.git")).toBe("oh-my-pi");
	});
	test("uses the repository name for SCP remotes without an owner directory", () => {
		expect(repoNameFromUrl("git@example.com:oh-my-pi.git")).toBe("oh-my-pi");
	});
});

describe.skipIf(process.platform !== "linux")("WSL Linux process ownership", () => {
	test("cancellation kills the test process group and removes only its markers", async () => {
		const temp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-wsl-cancel-"));
		const controlDir = path.join(temp, "control");
		const bun = path.join(temp, "bun");
		await fs.mkdir(controlDir);
		const fifo = path.join(temp, "pending-input");
		const createFifo = Bun.spawn(["mkfifo", fifo], { stdout: "ignore", stderr: "ignore" });
		expect(await createFifo.exited).toBe(0);
		await Bun.write(
			bun,
			'#!/bin/sh\n[ "$1" = install ] && exit 0\ncat "$OMP_TEST_FIFO" &\nprintf \'ready\\n\'\nwait\n',
		);
		await fs.chmod(bun, 0o755);
		const child = Bun.spawn(["bash", "-c", wslFulltestCommand(temp, controlDir)], {
			env: { ...process.env, PATH: `${temp}:${process.env.PATH}`, OMP_TEST_FIFO: fifo },
			stdout: "pipe",
			stderr: "pipe",
		});
		try {
			const reader = child.stdout.getReader();
			const ready = await reader.read();
			expect(new TextDecoder().decode(ready.value)).toBe("ready\n");
			const cancel = Bun.spawn(["bash", "-c", wslCancelCommand(controlDir)], {
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(await cancel.exited).toBe(0);
			expect(await child.exited).not.toBe(0);
			// A surviving descendant would keep this inherited pipe open.
			expect(await reader.read()).toEqual({ done: true, value: undefined });
			reader.releaseLock();
			await expect(fs.stat(controlDir)).rejects.toMatchObject({ code: "ENOENT" });
			expect(await Bun.file(bun).exists()).toBe(true);
		} finally {
			const cancel = Bun.spawn(["bash", "-c", wslCancelCommand(controlDir)], {
				stdout: "ignore",
				stderr: "ignore",
			});
			await cancel.exited;
			child.kill();
			await child.exited;
			await fs.rm(temp, { recursive: true, force: true });
		}
	}, 10_000);

	test("a cancellation arriving before the PID marker prevents tests from starting", async () => {
		const temp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-wsl-pre-cancel-"));
		const controlDir = path.join(temp, "control");
		try {
			await fs.mkdir(controlDir);
			const cancel = Bun.spawn(["bash", "-c", wslCancelCommand(controlDir)], {
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(await cancel.exited).toBe(0);
			const child = Bun.spawn(["bash", "-c", wslFulltestCommand("/nonexistent-repo", controlDir)], {
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(await child.exited).toBe(130);
			await expect(fs.stat(controlDir)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await fs.rm(temp, { recursive: true, force: true });
		}
	});
});
