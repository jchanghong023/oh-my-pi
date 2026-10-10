import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
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
import { captureSourceIdentity, type SourceIdentity } from "./test-gate-source";

function fakeRuntime(capture: (command: GateCommand) => Promise<string | GateCapture> = async () => "") {
	const commands: GateCommand[] = [];
	const gate = {
		signal: new AbortController().signal,
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
				return "company\trefs/heads/tested-feature\n";
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

describe("optional WSL selection", () => {
	test("decodes UTF-8 and UTF-16LE management output", () => {
		expect(decodeWslOutput(new TextEncoder().encode("Ubuntu-24.04"))).toBe("Ubuntu-24.04");
		expect(decodeWslOutput(new Uint8Array([0xff, 0xfe, 0x57, 0, 0x53, 0, 0x4c, 0]))).toBe("WSL");
	});
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
		await expect(resolveWslRemoteSource(f.gate, temporary, source(true))).rejects.toThrow(
			"Git writes are not authorized",
		);
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
	test("clones only absent network repository and freezes a fresh clone before helper execution", async () => {
		const f = executionFixture(async command =>
			command.label === "wsl/native-repository-discovery" ? "[]" : undefined,
		);
		expect((await runWslStage(f.gate, f.options)).status).toBe("PASS");
		const clone = String(f.commands.find(c => c.label === "wsl/network-clone")!.stdin);
		expect(clone).toContain("git clone --no-checkout --branch 'tested-feature'");
		expect(clone).toContain("merge-base --is-ancestor");
		expect(clone).toContain(`update-ref 'refs/heads/tested-feature' '${source().head}'`);
		expect(clone).toContain("destination='/root/oh-my-pi'");
		expect(clone).toContain("destination='/root/owner-oh-my-pi'");
		expect(clone).toContain('[ ! -e "$destination" ]');
	});
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
	test("cancellation records a stopped run even when its process never started", async () => {
		const directory = await fs.mkdtemp(path.join(temporary, "cancel-"));
		const control = path.join(directory, "owned ' control").replaceAll("\\", "/");
		await fs.mkdir(control);
		const python = Bun.which(process.platform === "win32" ? "python" : "python3");
		if (!python) throw new Error("Cancellation selftest requires the existing Python interpreter");
		const bash =
			process.platform === "win32"
				? path.resolve(path.dirname(Bun.which("git")!), "../bin/bash.exe")
				: Bun.which("bash");
		if (!bash) throw new Error("Cancellation selftest requires the existing shell");
		const bin = path.join(directory, "bin");
		await fs.mkdir(bin);
		await fs.writeFile(path.join(bin, "python3"), `#!/bin/sh\nexec "${python.replaceAll("\\", "/")}" "$@"\n`, {
			mode: 0o755,
		});
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
		expect((await fs.stat(path.join(control, "canceled"))).isFile()).toBe(true);
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
