import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { initLoaderContext } from "../native/loader-state.js";
import packageJson from "../package.json" with { type: "json" };

const ENV_KEYS = [
	"HOME",
	"USERPROFILE",
	"OMP_CONFIG_ROOT",
	"PI_NATIVES_DIR",
	"PI_CONFIG_DIR",
	"OMP_PROFILE",
	"PI_PROFILE",
	"PI_CODING_AGENT_DIR",
	"XDG_CACHE_HOME",
	"XDG_STATE_HOME",
	"TEST_SET_PROFILE",
	"XDG_DATA_HOME",
	"PI_NATIVE_VARIANT",
	"__PI_NATIVE_VARIANT_CACHE",
] as const;

describe("native addon directory config root", () => {
	let tempRoot = "";
	let home = "";
	let originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

	beforeEach(async () => {
		originalEnv = {};
		for (const key of ENV_KEYS) {
			originalEnv[key] = process.env[key];
			delete process.env[key];
		}
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-natives-root-"));
		home = path.join(tempRoot, "home");
		await fs.mkdir(home);
		process.env.HOME = home;
		process.env.USERPROFILE = home;
		process.env.PI_NATIVE_VARIANT = "baseline";
		vi.spyOn(os, "homedir").mockReturnValue(home);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const key of ENV_KEYS) {
			const value = originalEnv[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	it("places the versioned cache under OMP_CONFIG_ROOT", () => {
		const root = path.join(tempRoot, "omp-data");
		process.env.OMP_CONFIG_ROOT = root;

		expect(initLoaderContext({ isCompiledBinary: true }).versionedDir).toBe(
			path.join(root, "natives", packageJson.version),
		);
	});

	it("keeps an explicit PI_NATIVES_DIR ahead of OMP_CONFIG_ROOT", () => {
		const root = path.join(tempRoot, "omp-data");
		const shared = path.join(tempRoot, "shared");
		process.env.OMP_CONFIG_ROOT = root;
		process.env.PI_NATIVES_DIR = shared;

		expect(initLoaderContext({ isCompiledBinary: true }).versionedDir).toBe(path.join(shared, packageJson.version));
	});

	it.each([
		["empty", ""],
		["whitespace", " \t "],
		["relative", "relative/root"],
	])("falls back to HOME when OMP_CONFIG_ROOT is %s", (_label, value) => {
		process.env.OMP_CONFIG_ROOT = value;

		expect(initLoaderContext({ isCompiledBinary: true }).versionedDir).toBe(
			path.join(home, ".omp", "natives", packageJson.version),
		);
	});

	it("expands home-relative OMP_CONFIG_ROOT before appending natives", () => {
		process.env.OMP_CONFIG_ROOT = "~/omp-data";

		expect(initLoaderContext({ isCompiledBinary: true }).versionedDir).toBe(
			path.join(home, "omp-data", "natives", packageJson.version),
		);
	});

	it("keeps loader and installer grammar directories aligned in isolated environments", async () => {
		const root = path.join(tempRoot, "root");
		const cache = path.join(tempRoot, "cache");
		const data = path.join(tempRoot, "data");
		const shared = path.join(tempRoot, "shared");
		await fs.mkdir(path.join(cache, "omp"), { recursive: true });
		await fs.mkdir(path.join(data, "omp"), { recursive: true });
		const loaderUrl = pathToFileURL(path.resolve(import.meta.dir, "../native/loader-state.js")).href;
		const dirsUrl = pathToFileURL(path.resolve(import.meta.dir, "../../utils/src/dirs.ts")).href;
		const script = `
			import { initLoaderContext } from ${JSON.stringify(loaderUrl)};
			import { getNativeGrammarsDir, setProfile } from ${JSON.stringify(dirsUrl)};
			const paths = () => [initLoaderContext({ isCompiledBinary: true }).nativesDir, getNativeGrammarsDir()];
			const before = paths();
			if (process.env.TEST_SET_PROFILE) setProfile(process.env.TEST_SET_PROFILE);
			console.log(JSON.stringify([before, paths()]));
		`;
		const xdgEnabled = process.platform === "linux" || process.platform === "darwin";
		const cases: Array<[Record<string, string>, string, string?]> = [
			[
				{ OMP_CONFIG_ROOT: root, OMP_PROFILE: "audit", XDG_CACHE_HOME: cache },
				path.join(root, "profiles", "audit", "natives"),
			],
			[{ OMP_CONFIG_ROOT: root, OMP_PROFILE: "audit", PI_NATIVES_DIR: shared }, shared],
			[
				{ OMP_CONFIG_ROOT: "~/root", OMP_PROFILE: "audit", PI_NATIVES_DIR: "relative" },
				path.join(home, "root", "profiles", "audit", "natives"),
			],
			[
				{ PI_CONFIG_DIR: ".custom", OMP_PROFILE: "audit" },
				path.join(home, ".custom", "profiles", "audit", "natives"),
			],
			[{ OMP_PROFILE: "", PI_PROFILE: "audit" }, path.join(home, ".omp", "natives")],
			[{ PI_PROFILE: "audit" }, path.join(home, ".omp", "profiles", "audit", "natives")],
			[{ OMP_PROFILE: "../invalid" }, path.join(home, ".omp", "natives")],
			[
				{ XDG_DATA_HOME: data, XDG_CACHE_HOME: cache },
				path.join(xdgEnabled ? path.join(cache, "omp") : path.join(home, ".omp"), "natives"),
			],
			[{ XDG_CACHE_HOME: cache, OMP_PROFILE: "audit" }, path.join(home, ".omp", "profiles", "audit", "natives")],
			[{ XDG_DATA_HOME: data }, path.join(home, ".omp", "natives")],
			[{ XDG_CACHE_HOME: cache, PI_CODING_AGENT_DIR: shared }, path.join(home, ".omp", "natives")],
			[
				{ TEST_SET_PROFILE: "audit" },
				path.join(home, ".omp", "natives"),
				path.join(home, ".omp", "profiles", "audit", "natives"),
			],
			[{ PI_NATIVES_DIR: "~/shared" }, path.join(home, "shared")],
		];
		await fs.mkdir(path.join(cache, "omp", "profiles", "migrated"), { recursive: true });
		cases.push([
			{ XDG_CACHE_HOME: cache, OMP_PROFILE: "migrated" },
			path.join(xdgEnabled ? path.join(cache, "omp") : path.join(home, ".omp"), "profiles", "migrated", "natives"),
		]);
		for (const [values, expected, after = expected] of cases) {
			const env = { ...process.env, ...values, HOME: home, USERPROFILE: home, PI_NATIVE_VARIANT: "baseline" };
			const child = Bun.spawnSync([process.execPath, "-e", script], { env, stdout: "pipe", stderr: "pipe" });
			expect(child.exitCode).toBe(0);
			expect(JSON.parse(child.stdout.toString())).toEqual([
				[expected, path.join(expected, "grammars")],
				[after, path.join(after, "grammars")],
			]);
		}
	});
});
