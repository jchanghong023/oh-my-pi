#!/usr/bin/env bun
// Full current-platform validation. No WSL, remote pipelines, publication,
// desktop input, or quality-definition changes belong in this entry point.
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildChildEnv } from "./ci-test-ts";
import { gateRepoRoot, runFastcheck, runGateCommands } from "./fastcheck";
import { GateCommandError, runGate, type GateCommand, type GateRun } from "./test-gate-runtime";
import { resolveGoCacheEnvironment } from "./test-gate-go";
import { captureSourceIdentity } from "./test-gate-source";

export interface FulltestOptions {
	debug: boolean;
	limitSeconds?: number;
}

export function parseFulltestArgs(args: readonly string[]): FulltestOptions | null {
	let debug = false;
	let limitSeconds: number | undefined;
	for (const arg of args) {
		if (arg === "--debug") debug = true;
		else if (arg.startsWith("--limit-seconds=") && limitSeconds === undefined) {
			limitSeconds = Number(arg.slice("--limit-seconds=".length));
			if (!Number.isFinite(limitSeconds) || limitSeconds <= 0 || limitSeconds > 900) return null;
		} else return null;
	}
	return limitSeconds === undefined ? { debug } : { debug, limitSeconds };
}

/** Runtime tests use local fixtures, never the owner's live model credentials. */
export function localTestEnvironment(home: string): Record<string, string | undefined> {
	return {
		...buildChildEnv(),
		HOME: home,
		USERPROFILE: home,
		OMP_CONFIG_ROOT: path.join(home, ".omp"),
		// Toolchain caches retain their normal per-platform locations despite the
		// isolated application HOME. These are not fresh build/cache variants.
		CARGO_HOME: process.env.CARGO_HOME ?? path.join(os.homedir(), ".cargo"),
		RUSTUP_HOME: process.env.RUSTUP_HOME ?? path.join(os.homedir(), ".rustup"),
		RUSTUP_AUTO_INSTALL: "0",
		E2E: "",
		GITHUB_EVENT_NAME: "",
		OMP_TEST_SHARD: "",
		ROBOMP_INTEGRATION: "",
	};
}

/** Existing test primitives only; safety exclusions are reported explicitly. */
export function fulltestCommands(
	options: FulltestOptions,
	home: string,
	goCacheEnv: Record<string, string> = {},
): GateCommand[] {
	const env = { ...localTestEnvironment(home), ...goCacheEnv };
	const root = gateRepoRoot;
	const python = process.platform === "win32" ? "python" : "python3";
	return [
		{
			label: "test/TS complete isolated local plan",
			argv: ["bun", "scripts/ci-test-ts.ts", "local-ts", "--local-gate"],
			cwd: root,
			env,
		},
		{ label: "test/metaharness", argv: ["bun", "run", "test"], cwd: path.join(root, "packages/metaharness"), env },
		{ label: "test/stats", argv: ["bun", "test"], cwd: path.join(root, "packages/stats"), env },
		{
			label: "test/Rust workspace nextest+doctests",
			argv: ["bun", "run", "test:rs"],
			cwd: root,
			env: { ...env, CI: "1" },
		},
		{ label: "test/repository scripts", argv: ["bun", "run", "test:scripts"], cwd: root, env, kind: "charged" },
		{
			label: "test/Python RPC SDK",
			argv: [python, "-m", "pytest", "-x", "sdk/python/omp-rpc/tests"],
			cwd: root,
			env,
		},
		{ label: "test/Python robomp", argv: [python, "-m", "pytest", "-x", "python/robomp/tests"], cwd: root, env },
		{
			label: "test/Rust RPC SDK",
			argv: ["bun", "scripts/test-gate-cargo.ts", "test", "--manifest-path", "sdk/rust/omp-rpc/Cargo.toml"],
			cwd: root,
			env,
		},
		{
			label: "test/Rust RPC SDK scripted-server E2E",
			argv: [
				"bun",
				"scripts/test-gate-cargo.ts",
				"test",
				"--manifest-path",
				"sdk/rust/omp-rpc/Cargo.toml",
				"--",
				"--ignored",
				"--nocapture",
			],
			cwd: root,
			env,
		},
		{
			label: "test/Go RPC SDK race",
			argv: [process.execPath, path.join(import.meta.dir, "test-gate-go.ts"), "test", "-race", "./..."],
			cwd: path.join(root, "sdk/go/omp-rpc"),
			env,
		},
		{
			label: "test/Go RPC SDK scripted-server E2E",
			argv: [
				process.execPath,
				path.join(import.meta.dir, "test-gate-go.ts"),
				"test",
				"-run",
				"TestSmoke",
				"-v",
				"./...",
			],
			cwd: path.join(root, "sdk/go/omp-rpc"),
			env: { ...env, OMP_RPC_SMOKE: "1" },
		},
		{ label: "smoke/CLI public entry", argv: ["bun", "run", "ci:test:smoke"], cwd: root, env },
		{
			label: "smoke/isolated dev TUI PTY",
			argv: ["bun", "scripts/fulltest-ui-smoke.ts", ...(options.debug ? ["--debug"] : [])],
			cwd: root,
			env,
		},
	];
}

/** Independent builds finish before the CLI consumes native/extension assets.
 * The CLI's gen:stats already runs the stats build; do not race or repeat it. */
async function runWorkspaceBuilds(gate: GateRun): Promise<void> {
	const manifests = await gate.charged(async () => {
		const files = await Array.fromAsync(
			new Bun.Glob("packages/*/package.json").scan({ cwd: gateRepoRoot, onlyFiles: true }),
		);
		files.push("python/robomp/web/package.json");
		return Promise.all(
			files.sort().map(async file => ({
				cwd: path.dirname(path.join(gateRepoRoot, file)),
				manifest: (await Bun.file(path.join(gateRepoRoot, file)).json()) as { scripts?: Record<string, string> },
			})),
		);
	});
	const commands = manifests
		.filter(
			({ manifest, cwd }) =>
				manifest.scripts?.build &&
				!["packages/coding-agent", "packages/stats"].includes(
					path.relative(gateRepoRoot, cwd).replaceAll("\\", "/"),
				),
		)
		.map(({ cwd }) => ({
			label: `build/${path.relative(gateRepoRoot, cwd)}`,
			argv: ["bun", "run", "build"],
			cwd,
			env: { RUSTUP_AUTO_INSTALL: "0", CROSS_TARGET: "" },
		}));
	await runGateCommands(gate, commands);
	await gate.run({
		label: "build/coding-agent (includes stats and tool views)",
		argv: ["bun", "run", "build"],
		cwd: path.join(gateRepoRoot, "packages/coding-agent"),
		env: { RUSTUP_AUTO_INSTALL: "0", CROSS_TARGET: "" },
	});
}

export async function runFulltest(gate: GateRun, options: FulltestOptions): Promise<void> {
	if (!((process.platform === "win32" || process.platform === "linux") && process.arch === "x64")) {
		throw new GateCommandError(
			`UNVERIFIED: supported local platform is Windows/Linux x64, found ${process.platform}-${process.arch}`,
			1,
		);
	}
	const before = await captureSourceIdentity(gate, gateRepoRoot);
	console.log(`source: HEAD=${before.head} dirty=${before.dirty} digest=${before.digest}`);
	if (before.dirty) console.log(`source: uncommitted summary\n${before.status.trimEnd()}`);
	console.log(`platform=${process.platform}-${process.arch} bun=${Bun.version}; scope=whole-applicable-local`);
	console.log("coverage outside gates: real desktop input; live credential-backed model/gateway integration");
	if (process.platform === "win32")
		console.log("NOT_APPLICABLE: POSIX install-methods shell and Linux/root permission E2E");
	await runGateCommands(gate, [
		{ label: "version/Git", argv: ["git", "--version"], cwd: gateRepoRoot },
		{
			label: "version/Python",
			argv: [process.platform === "win32" ? "python" : "python3", "--version"],
			cwd: gateRepoRoot,
		},
		{ label: "version/ruff", argv: ["ruff", "--version"], cwd: gateRepoRoot },
		{ label: "version/Rust", argv: ["cargo", "--version"], cwd: gateRepoRoot, env: { RUSTUP_AUTO_INSTALL: "0" } },
	]);
	const goCacheEnv = Bun.which("go") ? await resolveGoCacheEnvironment(gate) : {};
	if (!Bun.which("go"))
		console.error("UNVERIFIED_MISSING_ENV: Go unavailable; required SDK checks/tests will fail, not be skipped");
	const home = await gate.charged(() => fs.mkdtemp(path.join(os.tmpdir(), "omp-fulltest-home-")));
	try {
		// Builders may regenerate shared bindings/dashboard/tool-view sources.
		// Finish source-writing builds before their static/test readers; the
		// existing build scripts remain authoritative and use normal caches.
		console.warn(
			"UNVERIFIED_COMPILATION_ACCOUNTING: robomp-web Vite mixes private compiler/plugin/asset-copy phases; its existing build remains charged conservatively, without a fabricated whole-command exemption",
		);
		await runWorkspaceBuilds(gate);
		if (process.platform === "linux") {
			// Installer packing temporarily rewrites shared manifests. It cannot
			// overlap compiler/type/test readers, and the native build is already
			// covered by the complete workspace build immediately above.
			await gate.run({
				label: "test/POSIX local installer E2E",
				argv: ["bun", "run", "ci:test:install-methods"],
				cwd: gateRepoRoot,
				env: { ...localTestEnvironment(home), OMP_INSTALL_TEST_SKIP_NATIVE_BUILD: "1" },
			});
		}
		const afterBuild = await captureSourceIdentity(gate, gateRepoRoot);
		console.log(
			`source tested after builds: HEAD=${afterBuild.head} dirty=${afterBuild.dirty} digest=${afterBuild.digest}`,
		);
		const results = await Promise.allSettled([
			gate.childGate("fastcheck", runFastcheck),
			runGateCommands(gate, fulltestCommands(options, home, goCacheEnv)),
		]);
		for (const result of results) if (result.status === "rejected") throw result.reason;
		const after = await captureSourceIdentity(gate, gateRepoRoot);
		if (after.digest !== afterBuild.digest || after.head !== afterBuild.head) {
			throw new GateCommandError(
				"Source changed while tests were running; result does not verify one source snapshot",
				1,
			);
		}
	} finally {
		await gate.charged(() => fs.rm(home, { recursive: true, force: true }));
	}
}

if (import.meta.main) {
	const options = parseFulltestArgs(process.argv.slice(2));
	const result = await runGate(
		"fulltest",
		async gate => {
			if (!options)
				throw new GateCommandError("Usage: bun run fulltest [--debug] [--limit-seconds=<seconds <= 900>]", 2);
			await runFulltest(gate, options);
		},
		options ? { limitSeconds: options.limitSeconds } : {},
	);
	process.exitCode = result.exitCode;
}
