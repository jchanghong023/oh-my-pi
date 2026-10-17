import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type LogEvent, registerLogSink } from "@oh-my-pi/pi-utils/logger";
import {
	decodeWslOutput,
	discoverWsl,
	gitRemoteIdentity,
	parseWslListVerbose,
	resolveWslRemoteSource,
	runWslStage,
	selectWslDistribution,
	wslCancelCommand,
	type WslOptions,
} from "./slowtest-wsl-stage";
import type { GateCapture, GateCommand, GateRun } from "./test-gate-runtime";
import { GateCommandError } from "./test-gate-runtime";
import { captureSourceIdentity, type SourceIdentity } from "./test-gate-source";

/**
 * Git for Windows layouts ship bash.exe beside git.exe (mingw64/bin), in the
 * top-level bin/, or only in usr/bin; resolve whichever one this install has.
 */
function resolveGitBash(): string | null {
	if (process.platform !== "win32") return Bun.which("bash");
	const git = Bun.which("git");
	if (!git) return null;
	return (
		["../bin/bash.exe", "../../bin/bash.exe", "../../usr/bin/bash.exe"]
			.map(relative => path.resolve(path.dirname(git), relative))
			.find(existsSync) ?? null
	);
}

function fakeRuntime(capture: (command: GateCommand) => Promise<string | GateCapture> = async () => "") {
	const commands: GateCommand[] = [];
	const controller = new AbortController();
	const gate = {
		signal: controller.signal,
		fail: (error: unknown) => {
			const failure = error instanceof GateCommandError ? error : new GateCommandError(String(error), 1);
			if (!controller.signal.aborted) {
				controller.abort(failure);
			}
			return controller.signal.reason as GateCommandError;
		},
		charged: async <T>(work: () => Promise<T>) => await work(),
		capture: async (command: GateCommand) => {
			commands.push(command);
			const result = await capture(command);
			return typeof result === "string" ? { exitCode: 0, stdout: result, stderr: "" } : result;
		},
	} as unknown as GateRun;
	return { gate, commands };
}
function source(dirty = false): SourceIdentity {
	return {
		head: "a".repeat(40),
		digest: "local-only-digest",
		dirty,
		status: dirty ? " M source.ts\n?? new.ts\n" : "",
		files: [],
	};
}
let temporary: string;
let helper: string;
beforeAll(async () => {
	temporary = await fs.mkdtemp(path.join(os.tmpdir(), "omp-wsl-orchestration-"));
	helper = path.join(temporary, "workflow-stub.py");
	await fs.writeFile(helper, "# inert deployed-plan fixture; never executed\n");
});
afterAll(async () => {
	await fs.rm(temporary, { recursive: true, force: true });
});
function executionFixture(override?: (command: GateCommand) => Promise<string | GateCapture | undefined>) {
	const f = fakeRuntime(async command => {
		const overridden = await override?.(command);
		if (overridden !== undefined) return overridden;
		switch (command.label) {
			case "wsl/source-admin":
				return temporary;
			case "wsl/source-branch":
				return "feature\n";
			case "wsl/push-target":
				return "company\trefs/heads/tested-feature\trefs/remotes/company/tested-feature\tcompany\trefs/heads/tested-feature\trefs/remotes/company/tested-feature\n";
			case "wsl/fetch-url":
				return "https://github.com/owner/oh-my-pi.git\n";
			case "wsl/push-url":
				return "git@github.com:owner/oh-my-pi.git\n";
			case "wsl/remote-availability":
				return `${source().head}\trefs/heads/tested-feature\n`;
			case "wsl/native-repository-discovery":
				return JSON.stringify([
					{ linux_repo: "/root/oh-my-pi", remote: "fork", fetch_url: "git@github.com:owner/oh-my-pi.git" },
				]);
			case "wsl/network-clone":
				return "CLONED_REPOSITORY=/root/oh-my-pi\n";
			case "wsl/native-environment":
				return "bun=/root/.bun/bin/bun\n";
			case "wsl/deployed-workflow-plan": {
				const request = JSON.parse(String(command.stdin));
				return JSON.stringify({
					status: "PLANNED",
					expected_sha: request.expected_sha,
					script: `# immutable helper plan fixture\ngit fetch -- fork refs/heads/tested-feature\n# helper: fixed SHA / ff-only / quarantine / post-test inspection\nexport OMP_GATE_EVENT_TOKEN='${request.env.OMP_GATE_EVENT_TOKEN}'\nexport OMP_GATE_EVENT_FILE='' OMP_GATE_CLOCK_TOKEN=''\n${request.argv.join(" ")}\n`,
				});
			}
			default:
				if (command.label === "wsl/Ubuntu-24.04/fulltest")
					return {
						exitCode: 0,
						stdout: `fulltest: PASS total=1.0s compile_excluded=0.0s budgeted=1.0s limit=900.0s exit=0\nTEST_EXIT_CODE=0\nPOST_TEST_SHA=${source().head}\nPOST_TEST_STATE_EXIT_CODE=0\n`,
						stderr: `OMP_GATE_EVENT ${command.eventToken} {"id":"nested-fulltest","kind":"charged","clock":""}\nOMP_GATE_EVENT ${command.eventToken} {"id":"nested-fulltest","kind":"idle","clock":""}\n`,
					};
				throw new Error(`unexpected fixture command ${command.label}`);
		}
	});
	const options: WslOptions = {
		debug: true,
		root: temporary,
		identity: source(),
		workflowPath: helper,
		which: () => process.execPath,
		selection: { status: "AVAILABLE", distro: "Ubuntu-24.04" },
	};
	return { ...f, options };
}

async function localCloneFixture(outcome: string) {
	const f = executionFixture(async command =>
		command.label === "wsl/native-repository-discovery" ? "[]" : undefined,
	);
	await runWslStage(f.gate, f.options);
	const command = f.commands.find(c => c.label === "wsl/network-clone")!;
	const directory = await fs.mkdtemp(path.join(temporary, "clone-fixture-"));
	const bin = path.join(directory, "bin");
	const staging = path.join(directory, "staging");
	const control = path.join(directory, "control");
	const writerPid = path.join(directory, "writer-pid");
	await fs.mkdir(bin);
	await fs.writeFile(
		path.join(bin, "git"),
		`#!/bin/bash
set -eu
if [ "$1" = clone ]; then
 destination="\${@: -1}"
 mkdir "$destination"
 printf 'fixed source\\n' > "$destination/fixed-source"
 case "$CLONE_FIXTURE_OUTCOME" in
 failure) exit 17;;
 timeout|hang*)
  (while :; do printf 'writing\\n' >> "$destination/writes"; sleep 0.01; done) &
  printf '%s\\n' "$!" > "$CLONE_FIXTURE_WRITER_PID"
  printf 'CLONE_WRITER_READY\\n'
  wait
  ;;
 esac
fi
`,
		{ mode: 0o755 },
	);
	await fs.writeFile(
		path.join(bin, "rm"),
		`#!/bin/bash
case "$CLONE_FIXTURE_OUTCOME" in
 *cleanup-failure*) [ "\${@: -1}" != "$CLONE_FIXTURE_STAGING" ] || exit 19;;
esac
exec /usr/bin/rm "$@"
`,
		{ mode: 0o755 },
	);
	const emitted = String(command.stdin);
	const remoteControl = emitted.match(/\/tmp\/omp-slowtest-clone-[0-9a-f-]+/)![0];
	const remoteStaging = emitted.match(/\/root\/\.omp-slowtest-clone-[0-9a-f-]+/)![0];
	// Exercise GNU timeout's real child-process signaling; JS fake timers cannot
	// drive the separate shell's platform clock.
	const script = emitted
		.replaceAll(remoteControl, control)
		.replaceAll(remoteStaging, staging)
		.replaceAll("/root/owner-oh-my-pi", path.join(directory, "owner-oh-my-pi"))
		.replaceAll("/root/oh-my-pi", path.join(directory, "oh-my-pi"))
		.replace("timeout -k 5 120", outcome === "timeout" ? "timeout -k 1 0.2" : "timeout -k 5 120");
	const start = (result = outcome) =>
		Bun.spawn(["bash", "-s"], {
			stdin: new Blob([script]),
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				PATH: `${bin}:${process.env.PATH}`,
				CLONE_FIXTURE_OUTCOME: result,
				CLONE_FIXTURE_WRITER_PID: writerPid,
				CLONE_FIXTURE_STAGING: staging,
			},
		});
	return {
		directory,
		staging,
		control,
		writerPid,
		start,
		run: async (result = outcome) => {
			const child = start(result);
			const [exitCode, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			return { exitCode, stdout, stderr };
		},
	};
}

describe("optional WSL selection", () => {
	test("decodes UTF-8 and UTF-16LE management output", () => {
		expect(decodeWslOutput(new TextEncoder().encode("Ubuntu-24.04"))).toBe("Ubuntu-24.04");
		expect(decodeWslOutput(new Uint8Array([0xff, 0xfe, 0x57, 0, 0x53, 0, 0x4c, 0]))).toBe("WSL");
	});
	test.each([
		{ encoding: "utf-8", available: true },
		{ encoding: "utf-16le", available: true },
		{ encoding: "utf-16le-bom", available: true },
		{ encoding: "utf-8", available: false },
		{ encoding: "utf-16le", available: false },
		{ encoding: "utf-16le-bom", available: false },
	])(
		"P2-37 distribution discovery preserves every $encoding byte boundary (available=$available)",
		async ({ encoding, available }) => {
			const name = available ? "Ubuntu-24.04" : "Other";
			const text = `  NAME STATE VERSION\r\n* ${name} 运行中 2\r\n  测试😀发行版 已停止 2\r\n`;
			const bytes =
				encoding === "utf-8"
					? Buffer.from(text, "utf8")
					: Buffer.concat([
							encoding === "utf-16le-bom" ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0),
							Buffer.from(text, "utf16le"),
						]);
			const partitions = [
				...Array.from({ length: bytes.length - 1 }, (_, index) => [
					bytes.subarray(0, index + 1),
					bytes.subarray(index + 1),
				]),
				Array.from(bytes, (_, index) => bytes.subarray(index, index + 1)),
			];
			for (const chunks of partitions) {
				const f = fakeRuntime(async command => {
					// Match GateRun.capture's per-chunk decoder calls, including
					// its lack of an extra decoder-flush call at stream EOF.
					return chunks.map(chunk => command.decodeOutput?.(chunk) ?? new TextDecoder().decode(chunk)).join("");
				});
				const selection = await discoverWsl(f.gate, {
					debug: false,
					platform: "win32",
					which: () => "wsl.exe",
				});
				if (available) expect(selection).toEqual({ status: "AVAILABLE", distro: "Ubuntu-24.04" });
				else {
					expect(selection.status).toBe("SKIPPED_WSL_UNAVAILABLE");
					if (selection.status === "AVAILABLE") throw new Error("Unexpected compatible distribution");
					expect(selection.reason).toContain("Other/WSL2");
					expect(selection.reason).toContain("测试😀发行版/WSL2");
				}
			}
		},
	);
	test.each(["utf-8", "utf-16le", "utf-16le-bom"])(
		"P2-37 decodes complete %s stderr before classifying discovery failure",
		async encoding => {
			const diagnostic = "测试😀发行版: WSL_E_DISTRO_NOT_FOUND";
			const bytes =
				encoding === "utf-8"
					? Buffer.from(diagnostic, "utf8")
					: Buffer.concat([
							encoding === "utf-16le-bom" ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0),
							Buffer.from(diagnostic, "utf16le"),
						]);
			const f = fakeRuntime(async command => ({
				exitCode: 1,
				stdout: "",
				stderr: Array.from(bytes, (_, index) => command.decodeOutput!(bytes.subarray(index, index + 1))).join(""),
			}));
			expect(await discoverWsl(f.gate, { debug: false, platform: "win32", which: () => "wsl.exe" })).toEqual({
				status: "SKIPPED_WSL_UNAVAILABLE",
				reason: diagnostic,
			});
		},
	);
	test("parses default markers, localized state and spaced distro names", () => {
		expect(
			parseWslListVerbose(
				" NAME STATE VERSION\n* Ubuntu-24.04 Running 2\n My Distro Stopped 2\n CentOS-7 Stopped 2\n",
			),
		).toEqual([
			{ name: "Ubuntu-24.04", state: "Running", version: "2" },
			{ name: "My Distro", state: "Stopped", version: "2" },
			{ name: "CentOS-7", state: "Stopped", version: "2" },
		]);
	});
	test("retains exact explicit Ubuntu target without CentOS substitution", () => {
		const distros = parseWslListVerbose("CentOS-7 Running 2\nUbuntu-24.04 Stopped 2\n");
		expect(selectWslDistribution(distros)).toEqual({ status: "AVAILABLE", distro: "Ubuntu-24.04" });
		expect(selectWslDistribution(distros.slice(0, 1)).status).toBe("SKIPPED_WSL_UNAVAILABLE");
		expect(selectWslDistribution([{ name: "Ubuntu-24.04", state: "Stopped", version: "1" }]).status).toBe(
			"SKIPPED_WSL_UNAVAILABLE",
		);
	});
	test("no need, non-Windows and missing WSL start no child", async () => {
		const f = fakeRuntime();
		const options = { debug: false, platform: "win32" as const, which: () => null };
		expect((await discoverWsl(f.gate, { ...options, needed: false })).status).toBe("SKIPPED_NOT_APPLICABLE");
		expect((await discoverWsl(f.gate, { ...options, platform: "linux" })).status).toBe("SKIPPED_NOT_APPLICABLE");
		expect((await discoverWsl(f.gate, options)).status).toBe("SKIPPED_WSL_UNAVAILABLE");
		expect(f.commands).toHaveLength(0);
	});
	test("discovery lists distributions with an explicit finite host guard", async () => {
		const f = fakeRuntime(async () => "* Ubuntu-24.04 Stopped 2\nCentOS-7 Stopped 2\n");
		expect(await discoverWsl(f.gate, { debug: false, platform: "win32", which: () => "wsl.exe" })).toEqual({
			status: "AVAILABLE",
			distro: "Ubuntu-24.04",
		});
		expect(f.commands[0]).toMatchObject({
			argv: ["wsl.exe", "--list", "--verbose"],
			wallTimeoutSeconds: 30,
			allowFailure: true,
		});
	});
	test("known absence skips but unknown or expired discovery remains blocked", async () => {
		const options = { debug: false, platform: "win32" as const, which: () => "wsl.exe" };
		const absent = fakeRuntime(async () => ({
			exitCode: 1,
			stdout: "",
			stderr: "Wsl/WSL_E_WSL_OPTIONAL_COMPONENT_REQUIRED",
		}));
		expect((await discoverWsl(absent.gate, options)).status).toBe("SKIPPED_WSL_UNAVAILABLE");
		for (const exitCode of [1, 124]) {
			const failed = fakeRuntime(async () => ({ exitCode, stdout: "", stderr: "service error" }));
			await expect(discoverWsl(failed.gate, options)).rejects.toThrow("BLOCKED: WSL discovery failed");
		}
	});
});

describe("fixed network-remote source", () => {
	test("normalizes network identities but rejects mounted/local/credential remotes", () => {
		expect(gitRemoteIdentity("git@github.com:owner/repo.git")).toBe(
			gitRemoteIdentity("https://github.com/owner/repo.git"),
		);
		for (const value of [
			"D:/workspace/repo",
			"/root/repo",
			"file:///D:/repo",
			"https://user:secret@github.com/owner/repo.git",
		])
			expect(() => gitRemoteIdentity(value)).toThrow("BLOCKED");
	});
	test("dirty input is blocked before helper, remote or WSL operations", async () => {
		const f = executionFixture();
		expect((await runWslStage(f.gate, { ...f.options, identity: source(true) })).status).toBe("BLOCKED");
		expect(f.commands).toHaveLength(0);
	});
	test("in-progress Windows operation blocks before any WSL command", async () => {
		const admin = await fs.mkdtemp(path.join(temporary, "git-admin-"));
		await fs.writeFile(path.join(admin, "MERGE_HEAD"), "inert merge marker\n");
		const f = executionFixture(async command => (command.label === "wsl/source-admin" ? admin : undefined));
		expect((await runWslStage(f.gate, f.options)).status).toBe("BLOCKED");
		expect(f.commands.some(c => c.argv[0] === "wsl.exe")).toBe(false);
	});
	test("uses actual push/fetch target and allows advanced remote tip for helper reachability proof", async () => {
		const f = executionFixture(async command =>
			command.label === "wsl/remote-availability" ? `${"b".repeat(40)}\trefs/heads/tested-feature\n` : undefined,
		);
		expect(await resolveWslRemoteSource(f.gate, temporary, source())).toEqual({
			head: source().head,
			branch: "tested-feature",
			fetchUrl: "https://github.com/owner/oh-my-pi.git",
			identity: "github.com/owner/oh-my-pi",
		});
		expect(f.commands.find(c => c.label === "wsl/remote-availability")!.argv).toEqual([
			"git",
			"ls-remote",
			"--exit-code",
			"company",
			"refs/heads/tested-feature",
		]);
	});
	test("resolves Git's implicit push ref only when the exact upstream mapping agrees", async () => {
		const tracking = "refs/remotes/company/feature";
		const target = `company\t\t${tracking}\tcompany\trefs/heads/feature\t${tracking}\n`;
		const f = executionFixture(async command => (command.label === "wsl/push-target" ? target : undefined));
		expect((await resolveWslRemoteSource(f.gate, temporary, source())).branch).toBe("feature");
		for (const incompatible of [
			target.replace("refs/heads/feature", "refs/heads/different"),
			target.replace(`${tracking}\n`, "refs/remotes/company/different\n"),
			target.replace("\tcompany\trefs/heads/feature", "\tother\trefs/heads/feature"),
		]) {
			const blocked = executionFixture(async command =>
				command.label === "wsl/push-target" ? incompatible : undefined,
			);
			await expect(resolveWslRemoteSource(blocked.gate, temporary, source())).rejects.toThrow("ambiguous");
		}
	});
	test("unresolved or split repository targets block without Git writes", async () => {
		for (const [label, value] of [
			["wsl/push-target", "\t"],
			["wsl/push-url", "git@github.com:other/oh-my-pi.git"],
			["wsl/fetch-url", "D:/local/source"],
		]) {
			const f = executionFixture(async command => (command.label === label ? value : undefined));
			expect((await runWslStage(f.gate, f.options)).status).toBe("BLOCKED");
			expect(f.commands.every(c => c.argv[0] === "git")).toBe(true);
		}
	});
	test("local identity records dirty additions/deletions without copying or Git writes", async () => {
		const root = await fs.mkdtemp(path.join(temporary, "identity-"));
		await fs.writeFile(path.join(root, "tracked.ts"), "dirty edit\n");
		await fs.writeFile(path.join(root, "new.ts"), "addition\n");
		await fs.mkdir(path.join(root, "target"));
		await fs.writeFile(path.join(root, "target", "cache"), "preserved\n");
		const f = fakeRuntime(async command => {
			if (command.argv[1] === "rev-parse") return source().head;
			if (command.argv[1] === "status") return " M tracked.ts\n D deleted.ts\n?? new.ts\n";
			if (command.argv.includes("--stage")) return `100644 ${"b".repeat(40)} 0\ttracked.ts\0`;
			return "tracked.ts\0deleted.ts\0new.ts\0target/cache\0";
		});
		const before = await captureSourceIdentity(f.gate, root);
		expect(before.dirty).toBe(true);
		expect(before.files.map(f => f.path)).toEqual(["new.ts", "tracked.ts"]);
		await fs.writeFile(path.join(root, "new.ts"), "changed addition\n");
		expect((await captureSourceIdentity(f.gate, root)).digest).not.toBe(before.digest);
		expect(await fs.readFile(path.join(root, "target", "cache"), "utf8")).toBe("preserved\n");
		for (const command of f.commands) expect(["rev-parse", "status", "ls-files"]).toContain(command.argv[1]);
	});
});

describe("streamed deployed fixed-commit execution", () => {
	test("runs helper plan verbatim through root native WSL with live events and cumulative accounting", async () => {
		const f = executionFixture();
		expect(await runWslStage(f.gate, f.options)).toEqual({
			status: "PASS",
			distro: "Ubuntu-24.04",
			head: source().head,
		});
		const planning = f.commands.find(c => c.label === "wsl/deployed-workflow-plan")!;
		const request = JSON.parse(String(planning.stdin));
		expect(request).toMatchObject({
			action: "plan",
			linux_repo: "/root/oh-my-pi",
			remote: "fork",
			branch: "tested-feature",
			expected_sha: source().head,
			timeout: 3600,
		});
		expect(request.argv.join(" ")).toContain("bun scripts/fulltest.ts --debug");
		expect(request.env.OMP_GATE_EVENT_FILE).toBe("");
		expect(request.env.OMP_GATE_CLOCK_TOKEN).toBe("");
		const execution = f.commands.find(c => c.label === "wsl/Ubuntu-24.04/fulltest")!;
		expect(execution.argv.slice(0, 8)).toEqual([
			"wsl.exe",
			"--distribution",
			"Ubuntu-24.04",
			"--user",
			"root",
			"--cd",
			"/root",
			"--",
		]);
		expect(execution.kind).toBeUndefined();
		expect(execution.wallTimeoutSeconds).toBeUndefined();
		expect(execution.eventToken).toBe(request.env.OMP_GATE_EVENT_TOKEN);
		expect(String(execution.stdin)).toContain(
			"# immutable helper plan fixture\ngit fetch -- fork refs/heads/tested-feature",
		);
		expect(String(execution.stdin)).toContain("setsid --wait");
		expect(execution.onAbort).toBeDefined();
		for (const command of f.commands) {
			const content = `${command.argv.join(" ")}\n${command.stdin ?? ""}`;
			expect(content).not.toMatch(
				/rsync|bundle|\/mnt\/[a-z]\/|git (?:commit|push|stash|clean|reset)|workflow_dispatch|publish_release|--terminate|--shutdown/,
			);
			if (command.argv[0] === "wsl.exe" && command.label !== "wsl/Ubuntu-24.04/fulltest")
				expect(command.wallTimeoutSeconds).toBeGreaterThan(0);
		}
	});
	test.each([
		{ scenario: "clean fixed source", mutation: "none", fulltestCode: 0, gitCode: 0, expected: 0 },
		{ scenario: "regenerated tracked binding", mutation: "tracked", fulltestCode: 0, gitCode: 0, expected: 1 },
		{ scenario: "new generated source", mutation: "added", fulltestCode: 0, gitCode: 0, expected: 1 },
		{ scenario: "original fulltest failure", mutation: "tracked", fulltestCode: 17, gitCode: 0, expected: 17 },
		{ scenario: "unavailable Git inspection", mutation: "none", fulltestCode: 0, gitCode: 127, expected: 127 },
		{ scenario: "unknown Git inspection error", mutation: "none", fulltestCode: 0, gitCode: 128, expected: 128 },
	])("emitted fixed-source certification preserves $scenario", async row => {
		const f = executionFixture();
		await runWslStage(f.gate, f.options);
		const request = JSON.parse(String(f.commands.find(c => c.label === "wsl/deployed-workflow-plan")!.stdin));
		const directory = await fs.mkdtemp(path.join(temporary, "source-stability-"));
		const root = path.join(directory, "fixed source");
		const bin = path.join(directory, "stub binaries");
		await fs.mkdir(root);
		await fs.mkdir(bin);
		await fs.writeFile(path.join(root, "native-binding.ts"), "fixed binding\n");
		const git = Bun.which("git");
		if (process.platform === "win32" && !git)
			throw new Error("Source stability selftest requires the existing Git Bash installation");
		const bash = resolveGitBash();
		if (!bash) throw new Error("Source stability selftest requires the existing shell");
		await fs.access(bash);
		// The read-only Git stub models a fixed tracked binding and an initially
		// absent source file. Fulltest must actually mutate those files; no status
		// strings are injected into the emitted command, and no Git writes occur.
		await fs.writeFile(
			path.join(bin, "bun"),
			[
				"#!/bin/sh",
				'case "$1" in',
				"install) exit 0;;",
				"scripts/fulltest.ts)",
				...(row.mutation === "tracked" ? ["printf 'regenerated binding\\n' > native-binding.ts"] : []),
				...(row.mutation === "added" ? ["printf 'new source\\n' > generated.ts"] : []),
				`exit ${row.fulltestCode};;`,
				"*) exit 64;;",
				"esac",
				"",
			].join("\n"),
			{ mode: 0o755 },
		);
		await fs.writeFile(
			path.join(bin, "git"),
			[
				"#!/bin/sh",
				'[ "$1" = status ] || exit 64',
				"printf inspected > ../git-inspected",
				...(row.gitCode ? [`echo 'fixture Git inspection failed' >&2; exit ${row.gitCode}`] : []),
				"IFS= read -r binding < native-binding.ts",
				'[ "$binding" = "fixed binding" ] || printf " M native-binding.ts\\n"',
				'[ ! -e generated.ts ] || printf "?? generated.ts\\n"',
				"exit 0",
				"",
			].join("\n"),
			{ mode: 0o755 },
		);
		const shellBin = bin
			.replaceAll("\\", "/")
			.replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);
		const child = Bun.spawn(
			[
				bash,
				"-c",
				`export PATH='${shellBin.replaceAll("'", "'\\''")}':"$PATH"\nexec "$@"`,
				"source-stability",
				...request.argv,
			],
			{
				cwd: root,
				env: { ...process.env, MSYS_NO_PATHCONV: "1" },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [exitCode, stderr] = await Promise.all([
			child.exited,
			new Response(child.stderr).text(),
			new Response(child.stdout).text(),
		]);
		expect(exitCode).toBe(row.expected);
		if (row.expected === 1) expect(stderr).toContain("UNVERIFIED: Linux source changed from the fixed commit");
		else expect(stderr).not.toContain("UNVERIFIED:");
		expect(await fs.readFile(path.join(root, "native-binding.ts"), "utf8")).toBe(
			row.mutation === "tracked" ? "regenerated binding\n" : "fixed binding\n",
		);
		if (row.mutation === "added")
			expect(await fs.readFile(path.join(root, "generated.ts"), "utf8")).toBe("new source\n");
		if (row.fulltestCode !== 0)
			await expect(fs.stat(path.join(directory, "git-inspected"))).rejects.toMatchObject({ code: "ENOENT" });
		else expect(await fs.readFile(path.join(directory, "git-inspected"), "utf8")).toBe("inspected");
	});
	test("ambiguous native worktrees block rather than cloning around user state", async () => {
		const f = executionFixture(async command =>
			command.label === "wsl/native-repository-discovery"
				? JSON.stringify([
						{ linux_repo: "/root/one", remote: "fork", fetch_url: "https://github.com/owner/oh-my-pi.git" },
						{ linux_repo: "/root/two", remote: "fork", fetch_url: "https://github.com/owner/oh-my-pi.git" },
					])
				: undefined,
		);
		expect((await runWslStage(f.gate, f.options)).status).toBe("BLOCKED");
		expect(f.commands.some(c => c.label === "wsl/network-clone")).toBe(false);
	});
	test.skipIf(process.platform !== "linux").each([
		{ nested: "target", ambiguous: false },
		{ nested: ".cache", ambiguous: false },
		{ nested: "venv", ambiguous: false },
		{ nested: "node_modules", ambiguous: false },
		{ nested: ".venv", ambiguous: false },
		{ nested: "target/.cache/venv", ambiguous: false },
		{ nested: "target", ambiguous: true },
		{ nested: ".cache", ambiguous: true },
		{ nested: "venv", ambiguous: true },
		{ nested: "node_modules", ambiguous: true },
		{ nested: ".venv", ambiguous: true },
	])("P2-38 discovers $nested repositories (ambiguous=$ambiguous)", async row => {
		const directory = await fs.mkdtemp(path.join(temporary, "native-discovery-"));
		const nativeRoot = path.join(directory, "root");
		const bin = path.join(directory, "bin");
		await fs.mkdir(bin);
		await fs.writeFile(path.join(bin, "id"), "#!/bin/sh\nprintf '0\\n'\n", { mode: 0o755 });
		const roots = [`${row.nested}/oh-my-pi`, ...(row.ambiguous ? ["oh-my-pi"] : [])];
		for (const relative of roots) {
			const repository = path.join(nativeRoot, relative);
			await fs.mkdir(repository, { recursive: true });
			for (const args of [
				["init", "--quiet", repository],
				["-C", repository, "remote", "add", "fork", "https://github.com/owner/oh-my-pi.git"],
			]) {
				const child = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
				const [code, stderr] = await Promise.all([
					child.exited,
					new Response(child.stderr).text(),
					new Response(child.stdout).text(),
				]);
				expect(stderr).toBe("");
				expect(code).toBe(0);
			}
		}
		const f = executionFixture(async command => {
			if (command.label !== "wsl/native-repository-discovery") return undefined;
			// Execute the generated discovery, not a precomputed candidate list.
			// Only relocate its /root filesystem boundary into this private fixture.
			const child = Bun.spawn(["bash", "-s"], {
				stdin: new Blob([String(command.stdin).replaceAll("/root", nativeRoot)]),
				env: { ...process.env, HOME: nativeRoot, PATH: `${bin}:${process.env.PATH}` },
				stdout: "pipe",
				stderr: "pipe",
			});
			const [exitCode, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect(stderr).toBe("");
			expect(exitCode).toBe(0);
			const candidates = JSON.parse(stdout) as Array<{ linux_repo: string }>;
			expect(candidates.map(candidate => candidate.linux_repo).sort()).toEqual(
				roots.map(relative => path.join(nativeRoot, relative)).sort(),
			);
			return { exitCode, stdout: stdout.replaceAll(nativeRoot, "/root"), stderr };
		});
		expect((await runWslStage(f.gate, f.options)).status).toBe(row.ambiguous ? "BLOCKED" : "PASS");
		expect(f.commands.some(command => command.label === "wsl/network-clone")).toBe(false);
		const planning = f.commands.find(command => command.label === "wsl/deployed-workflow-plan");
		if (row.ambiguous) expect(planning).toBeUndefined();
		else expect(JSON.parse(String(planning!.stdin)).linux_repo).toBe(`/root/${row.nested}/oh-my-pi`);
	});
	test.each(["wsl/native-repository-discovery", "wsl/native-environment"])(
		"P2-39 registers independent cancellation for %s",
		async label => {
			const f = executionFixture();
			await runWslStage(f.gate, f.options);
			const command = f.commands.find(command => command.label === label)!;
			expect(command.onAbort).toBeFunction();
			expect(command.abortCommand).toBeDefined();
			expect(command.abortCommand!.argv.slice(0, 8)).toEqual([
				"wsl.exe",
				"--distribution",
				"Ubuntu-24.04",
				"--user",
				"root",
				"--cd",
				"/root",
				"--",
			]);
		},
	);
	test.skipIf(process.platform !== "linux").each([
		{ label: "wsl/native-repository-discovery", outcome: "cancel", cleanupFailure: false, expected: 143 },
		{ label: "wsl/native-environment", outcome: "cancel", cleanupFailure: false, expected: 143 },
		{ label: "wsl/native-environment", outcome: "timeout", cleanupFailure: false, expected: 124 },
		{ label: "wsl/native-environment", outcome: "timeout", cleanupFailure: true, expected: 124 },
		{ label: "wsl/native-environment", outcome: "success", cleanupFailure: false, expected: 0 },
		{ label: "wsl/native-environment", outcome: "failure", cleanupFailure: true, expected: 17 },
	])("P2-39 $label lifecycle $outcome preserves ownership (cleanup failure=$cleanupFailure)", async row => {
		const f = executionFixture();
		await runWslStage(f.gate, f.options);
		const command = f.commands.find(command => command.label === row.label)!;
		const directory = await fs.mkdtemp(path.join(temporary, "native-owner-"));
		const nativeRoot = path.join(directory, "root");
		const control = path.join(directory, "control");
		const writerPid = path.join(directory, "writer-pid");
		const ownerPid = path.join(directory, "owner-pid");
		const descendantPid = path.join(directory, "descendant-pid");
		const bin = path.join(directory, "bin");
		await fs.mkdir(path.join(nativeRoot, "oh-my-pi", ".git"), { recursive: true });
		await fs.mkdir(bin);
		await fs.writeFile(path.join(bin, "id"), "#!/bin/sh\nprintf '0\\n'\n", { mode: 0o755 });
		const probe = `#!/bin/bash
set -eu
read -r -a stat < /proc/$$/stat
printf '%s %s\\n' "$$" "\${stat[21]}" > "$NATIVE_WRITER_PID"
cat "$NATIVE_CONTROL/pid" > "$NATIVE_OWNER_PID"
case "$NATIVE_OUTCOME" in
 success|failure) ;;
 *)
  sleep 30 &
  descendant=$!
  read -r -a stat < /proc/$descendant/stat
  printf '%s %s\\n' "$descendant" "\${stat[21]}" > "$NATIVE_DESCENDANT_PID"
  ;;
esac
printf 'NATIVE_WRITER_READY\\n' >&2
case "$NATIVE_OUTCOME" in
 success) exit 0;;
 failure) exit 17;;
 *) wait;;
esac
`;
		for (const tool of ["git", "bun", "cargo", "rustc", "cargo-nextest"]) {
			await fs.writeFile(
				path.join(bin, tool),
				tool === (row.label === "wsl/native-environment" ? "cargo" : "git") ? probe : "#!/bin/sh\nexit 0\n",
				{ mode: 0o755 },
			);
		}
		if (row.cleanupFailure) {
			const python = Bun.which("python3")!;
			// Leave the real native owner alive on timeout, but fail only the
			// wrapper's cleanup attempt. The later independent cancel uses PATH
			// outside this fixture and must still find the retained birth receipt.
			await fs.writeFile(
				path.join(bin, "python3"),
				`#!/bin/bash\nif [ "$1" = --version ]; then exec '${python.replaceAll("'", "'\\''")}' "$@"; fi\nexit 29\n`,
				{ mode: 0o755 },
			);
		}
		const argv = command.argv.slice(8);
		// Preserve the production outer timeout/process-group boundary, only
		// shortening its duration and avoiding a login shell resetting PATH.
		if (row.outcome === "timeout") argv[3] = "0.5";
		argv[5] = "-s";
		const unrelated = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
		const running = Bun.spawn(argv, {
			stdin: new Blob([
				String(command.stdin)
					.replaceAll("/root", nativeRoot)
					.replace(/\/tmp\/omp-slowtest-[\w-]+/g, control),
			]),
			env: {
				...process.env,
				HOME: nativeRoot,
				PATH: `${bin}:${process.env.PATH}`,
				NATIVE_WRITER_PID: writerPid,
				NATIVE_OWNER_PID: ownerPid,
				NATIVE_DESCENDANT_PID: descendantPid,
				NATIVE_CONTROL: control,
				NATIVE_OUTCOME: row.outcome,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const output = new Response(running.stdout).text();
		const [monitor, captured] = running.stderr.tee();
		const errors = new Response(captured).text();
		const cancel = async () => {
			const child = Bun.spawn(
				[
					"bash",
					"-c",
					command
						.abortCommand!.argv.at(-1)!
						.replaceAll("/root", nativeRoot)
						.replace(/\/tmp\/omp-slowtest-[\w-]+/g, control),
				],
				{ stdout: "pipe", stderr: "pipe" },
			);
			const [code, stderr] = await Promise.all([
				child.exited,
				new Response(child.stderr).text(),
				new Response(child.stdout).text(),
			]);
			expect(stderr).toBe("");
			expect(code).toBe(0);
		};
		try {
			const reader = monitor.getReader();
			let startup = "";
			while (!startup.includes("NATIVE_WRITER_READY")) {
				const chunk = await reader.read();
				if (chunk.done) throw new Error(`Native fixture exited before startup: ${startup}`);
				startup += new TextDecoder().decode(chunk.value);
			}
			void reader.cancel();
			const receipt = (await fs.readFile(ownerPid, "utf8")).trim().split(/\s+/);
			expect(Number(receipt[0])).toBeGreaterThan(0);
			expect(receipt[1]).toMatch(/^\d+$/);
			if (row.outcome === "cancel") await cancel();
			expect(await running.exited).toBe(row.expected);
			if (row.cleanupFailure) {
				expect((await fs.readFile(path.join(control, "pid"), "utf8")).trim().split(/\s+/)).toEqual(receipt);
				if (row.outcome === "timeout") {
					const fields = (await fs.readFile(`/proc/${receipt[0]}/stat`, "utf8")).split(") ")[1]!.split(" ");
					expect(fields[19]).toBe(receipt[1]);
					expect(fields[0]).not.toBe("Z");
				}
				await cancel();
			}
			expect(existsSync(control)).toBe(false);
			for (const file of [ownerPid, writerPid, descendantPid]) {
				const [pid, born] = (await fs.readFile(file, "utf8").catch(() => "")).trim().split(/\s+/);
				if (!pid) continue;
				const fields = (await fs.readFile(`/proc/${pid}/stat`, "utf8").catch(() => "")).split(") ")[1]?.split(" ");
				expect(!fields || fields[19] !== born || fields[0] === "Z").toBe(true);
			}
			expect(unrelated.exitCode).toBeNull();
		} finally {
			// Independently recorded birth identities survive even a regression
			// that deletes control prematurely; never target recycled PIDs.
			for (const file of [descendantPid, writerPid, ownerPid]) {
				const [pidText, birth] = (await fs.readFile(file, "utf8").catch(() => "")).trim().split(/\s+/);
				const pid = Number(pidText);
				if (!pid || pid === process.pid || !birth) continue;
				const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
				if (stat.split(") ")[1]?.split(" ")[19] === birth) {
					try {
						process.kill(pid, "SIGKILL");
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
					}
				}
			}
			running.kill();
			unrelated.kill();
			await Promise.all([running.exited, unrelated.exited, output, errors]);
		}
	});
	test.each([
		{
			code: "source_sha_mismatch",
			stdout: JSON.stringify({ status: "BLOCKED", error: "Windows HEAD differs from expected_sha." }),
			stderr: "",
		},
		{
			code: "workspace_dirty",
			stdout: JSON.stringify({
				status: "BLOCKED",
				error: "Commit and push the intended source before WSL execution.",
			}),
			stderr: "",
		},
		{
			code: "git_operation_in_progress",
			stdout: JSON.stringify({ status: "BLOCKED", error: "Windows repository has an in-progress Git operation." }),
			stderr: "",
		},
		{
			code: "helper_unavailable",
			stdout: "",
			stderr: "No Python >= 3.11 was found; workflow helpers are unavailable.",
		},
		{
			code: "preflight_rejected",
			stdout: JSON.stringify({ status: "BLOCKED", error: "PRIVATE_PREFLIGHT_BODY" }),
			stderr: "PRIVATE_PREFLIGHT_STDERR",
		},
	])("records safe $code for rejected helper plans without executing WSL", async row => {
		const f = executionFixture(async command =>
			command.label === "wsl/deployed-workflow-plan"
				? { exitCode: 3, stdout: row.stdout, stderr: row.stderr }
				: undefined,
		);
		const events: LogEvent[] = [];
		const dispose = registerLogSink(event => events.push(event));
		try {
			expect(await runWslStage(f.gate, f.options)).toMatchObject({ status: "BLOCKED", exitCode: 3 });
			expect(f.commands.some(command => command.label === "wsl/Ubuntu-24.04/fulltest")).toBe(false);
			const start = events.find(event => event.context?.event === "wsl_stage_started");
			const rejected = events.find(event => event.context?.event === "wsl_result_rejected");
			expect(rejected).toMatchObject({
				level: "error",
				context: { stage: "workflow-plan", failure_code: row.code, exit_code: 3 },
			});
			expect(typeof rejected?.context?.elapsed_ms).toBe("number");
			expect(rejected?.context?.wsl_call_id).toBe(start?.context?.wsl_call_id);
			expect(JSON.stringify(events)).not.toContain("PRIVATE_PREFLIGHT");
		} finally {
			dispose();
		}
	});
	test.skipIf(process.platform !== "linux").each([
		{ outcome: "failure", previous: "none", expected: 17 },
		{ outcome: "timeout", previous: "preferred", expected: 124 },
		{ outcome: "success", previous: "both", expected: 1 },
		{ outcome: "success", previous: "symlink", expected: 0 },
		{ outcome: "cleanup-failure", previous: "none", expected: 1 },
	])("fresh clone $outcome preserves $previous destinations and permits retry", async row => {
		const fixture = await localCloneFixture(row.outcome);
		const preferred = path.join(fixture.directory, "oh-my-pi");
		const alternate = path.join(fixture.directory, "owner-oh-my-pi");
		if (row.previous === "preferred" || row.previous === "both") {
			await fs.mkdir(preferred);
			await fs.writeFile(path.join(preferred, "user-source"), "uncommitted source");
		}
		if (row.previous === "both") {
			await fs.mkdir(alternate);
			await fs.writeFile(path.join(alternate, "cache"), "existing cache");
		}
		if (row.previous === "symlink") await fs.symlink("missing-user-target", preferred);
		const result = await fixture.run();
		expect(result.exitCode).toBe(row.expected);
		if (row.previous === "preferred" || row.previous === "both")
			expect(await fs.readFile(path.join(preferred, "user-source"), "utf8")).toBe("uncommitted source");
		if (row.previous === "both")
			expect(await fs.readFile(path.join(alternate, "cache"), "utf8")).toBe("existing cache");
		if (row.previous === "symlink") expect(await fs.readlink(preferred)).toBe("missing-user-target");
		if (row.outcome === "cleanup-failure") {
			expect(result.stderr).toContain("clone staging cleanup failed");
			expect((await fs.stat(fixture.staging)).isDirectory()).toBe(true);
		} else {
			expect(existsSync(fixture.staging)).toBe(false);
		}
		if (row.outcome === "failure" || row.outcome === "timeout") {
			expect(existsSync(row.previous === "preferred" ? alternate : preferred)).toBe(false);
			const retry = await fixture.run("success");
			expect(retry.exitCode).toBe(0);
			const destination = row.previous === "preferred" ? alternate : preferred;
			expect(await fs.readFile(path.join(destination, "fixed-source"), "utf8")).toBe("fixed source\n");
			expect(retry.stdout).toContain(`CLONED_REPOSITORY=${destination}`);
		}
	});
	test.skipIf(process.platform !== "linux").each(["hang", "hang-cleanup-failure"])(
		"cancel stops clone writers before cleanup and reports %s accurately",
		async outcome => {
			const fixture = await localCloneFixture(outcome);
			const running = fixture.start();
			const [monitor, captured] = running.stdout.tee();
			const output = new Response(captured).text();
			const errors = new Response(running.stderr).text();
			try {
				const reader = monitor.getReader();
				let startup = "";
				while (!startup.includes("CLONE_WRITER_READY")) {
					const chunk = await reader.read();
					if (chunk.done) throw new Error("Clone fixture exited before its writer started");
					startup += new TextDecoder().decode(chunk.value);
				}
				// Do not await tee cancellation: its promise waits for the other
				// branch's EOF, which the cancellation below is about to produce.
				void reader.cancel();
				const cancelled = Bun.spawn(["bash", "-c", wslCancelCommand(fixture.control)], {
					stdout: "pipe",
					stderr: "pipe",
				});
				const [code, stderr] = await Promise.all([
					cancelled.exited,
					new Response(cancelled.stderr).text(),
					new Response(cancelled.stdout).text(),
				]);
				if (outcome === "hang-cleanup-failure") {
					expect(code).not.toBe(0);
					expect(stderr).toContain("cleanup UNVERIFIED");
					expect(existsSync(fixture.staging)).toBe(true);
				} else {
					expect(stderr).toBe("");
					expect(code).toBe(0);
					expect(existsSync(fixture.staging)).toBe(false);
				}
				expect(await running.exited).not.toBe(0);
				expect(existsSync(path.join(fixture.directory, "oh-my-pi"))).toBe(false);
				const pid = (await fs.readFile(fixture.writerPid, "utf8")).trim();
				const state = await fs.readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
				expect(state === "" || state.split(") ")[1]?.startsWith("Z ")).toBe(true);
				if (outcome === "hang") {
					// The real host consumes state after checking the cleanup receipt.
					await fs.rm(fixture.control, { recursive: true });
					expect((await fixture.run("success")).exitCode).toBe(0);
				}
			} finally {
				if (running.exitCode === null) {
					const cleanup = Bun.spawn(["bash", "-c", wslCancelCommand(fixture.control)], {
						stdout: "ignore",
						stderr: "ignore",
					});
					await cleanup.exited;
				}
				running.kill();
				await Promise.all([running.exited, output, errors]);
			}
		},
	);
	test("absent repository clone reports nonconflicting owner destination exactly", async () => {
		const f = executionFixture(async command => {
			if (command.label === "wsl/native-repository-discovery") return "[]";
			if (command.label === "wsl/network-clone") return "CLONED_REPOSITORY=/root/owner-oh-my-pi\n";
		});
		expect((await runWslStage(f.gate, f.options)).status).toBe("PASS");
		const planning = f.commands.find(c => c.label === "wsl/deployed-workflow-plan")!;
		expect(JSON.parse(String(planning.stdin)).linux_repo).toBe("/root/owner-oh-my-pi");
	});
	test.each([
		{ code: 17, test: "17", sha: "a".repeat(40), state: "0", expected: "FAIL" },
		{ code: 124, test: "124", sha: "a".repeat(40), state: "0", expected: "TIMEOUT" },
		{ code: 137, test: "137", sha: "a".repeat(40), state: "0", expected: "TIMEOUT" },
		{ code: 130, test: "130", sha: "a".repeat(40), state: "0", expected: "CANCELLED" },
		{ code: 24, test: "", sha: "", state: "", expected: "BLOCKED" },
		{ code: 26, test: "26", sha: "b".repeat(40), state: "0", expected: "UNVERIFIED" },
		{ code: 0, test: "0", sha: "a".repeat(40), state: "1", expected: "UNVERIFIED" },
	])("classifies execution and post-test evidence as $expected", async row => {
		const f = executionFixture(async command =>
			command.label === "wsl/Ubuntu-24.04/fulltest"
				? {
						exitCode: row.code,
						stdout: row.test
							? `TEST_EXIT_CODE=${row.test}\nPOST_TEST_SHA=${row.sha}\nPOST_TEST_STATE_EXIT_CODE=${row.state}\n`
							: "sync blocked\n",
						stderr: "",
					}
				: undefined,
		);
		expect((await runWslStage(f.gate, f.options)).status).toBe(row.expected);
	});
	test("missing live event evidence cannot grant PASS or blanket compilation exclusion", async () => {
		const f = executionFixture(async command =>
			command.label === "wsl/Ubuntu-24.04/fulltest"
				? {
						exitCode: 0,
						stdout: `fulltest: PASS total=1.0s\nTEST_EXIT_CODE=0\nPOST_TEST_SHA=${source().head}\nPOST_TEST_STATE_EXIT_CODE=0\n`,
						stderr: "",
					}
				: undefined,
		);
		expect((await runWslStage(f.gate, f.options)).status).toBe("UNVERIFIED");
	});
	test("final helper records override nested selftest fixture marker logs", async () => {
		const f = executionFixture(async command =>
			command.label === "wsl/Ubuntu-24.04/fulltest"
				? {
						exitCode: 0,
						stdout: `TEST_EXIT_CODE=17\nPOST_TEST_SHA=${"b".repeat(40)}\nPOST_TEST_STATE_EXIT_CODE=1\nfulltest: PASS total=1.0s\nTEST_EXIT_CODE=0\nPOST_TEST_SHA=${source().head}\nPOST_TEST_STATE_EXIT_CODE=0\n`,
						stderr: `OMP_GATE_EVENT ${command.eventToken} {"id":"real-fulltest","kind":"charged"}\nOMP_GATE_EVENT ${command.eventToken} {"id":"real-fulltest","kind":"idle"}\n`,
					}
				: undefined,
		);
		expect((await runWslStage(f.gate, f.options)).status).toBe("PASS");
	});
	test("native missing-tool or helper preflight rejection remains blocked", async () => {
		for (const label of ["wsl/native-environment", "wsl/deployed-workflow-plan"]) {
			const f = executionFixture(async command =>
				command.label === label ? { exitCode: 127, stdout: "", stderr: "missing tool fixture" } : undefined,
			);
			expect((await runWslStage(f.gate, f.options)).status).toBe("BLOCKED");
			expect(f.commands.some(c => c.label === "wsl/Ubuntu-24.04/fulltest")).toBe(false);
		}
	});
	test.each([false, true])("cancellation handles a stopped owner (already cleaned=%s)", async alreadyCleaned => {
		const directory = await fs.mkdtemp(path.join(temporary, "cancel-"));
		const control = path.join(directory, "owned ' control").replaceAll("\\", "/");
		await fs.mkdir(control);
		const python = Bun.which(process.platform === "win32" ? "python" : "python3");
		if (!python) throw new Error("Cancellation selftest requires the existing Python interpreter");
		const bash = resolveGitBash();
		if (!bash) throw new Error("Cancellation selftest requires the existing shell");
		const bin = path.join(directory, "bin");
		await fs.mkdir(bin);
		await fs.writeFile(
			path.join(bin, "python3"),
			`#!/bin/sh\n${alreadyCleaned ? 'rmdir -- "$3"\n' : ""}exec "${python.replaceAll("\\", "/")}" "$@"\n`,
			{ mode: 0o755 },
		);
		const shellBin = bin
			.replaceAll("\\", "/")
			.replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);
		const child = Bun.spawn(
			[bash, "-c", `export PATH='${shellBin.replaceAll("'", "'\\''")}':"$PATH"\n${wslCancelCommand(control)}`],
			{
				env: { ...process.env, MSYS_NO_PATHCONV: "1", PYTHON_MANAGER_AUTOMATIC_INSTALL: "false" },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [exitCode, stderr] = await Promise.all([
			child.exited,
			new Response(child.stderr).text(),
			new Response(child.stdout).text(),
		]);
		expect(stderr).toBe("");
		expect(exitCode).toBe(0);
		if (alreadyCleaned) {
			await expect(fs.stat(control)).rejects.toMatchObject({ code: "ENOENT" });
		} else {
			expect((await fs.stat(path.join(control, "canceled"))).isFile()).toBe(true);
		}
		await expect(fs.stat(path.join(control, "pid"))).rejects.toMatchObject({ code: "ENOENT" });
	});
});

test("standalone WSL stage is rejected without any WSL execution", async () => {
	const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "slowtest-wsl-stage.ts")], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stderr] = await Promise.all([
		child.exited,
		new Response(child.stderr).text(),
		new Response(child.stdout).text(),
	]);
	expect(exitCode).toBe(2);
	expect(stderr).toContain("standalone execution is prohibited");
});
