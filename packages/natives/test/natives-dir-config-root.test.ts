import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const ENV_KEYS = new Set([
	"HOME",
	"USERPROFILE",
	"PI_NATIVE_VARIANT",
	"OMP_CONFIG_ROOT",
	"OMP_CACHE_DIR",
	"OMP_OFFLINE",
	"PI_NATIVES_DIR",
	"PI_CONFIG_DIR",
	"OMP_PROFILE",
	"PI_PROFILE",
	"PI_CODING_AGENT_DIR",
	"XDG_CACHE_HOME",
	"XDG_STATE_HOME",
	"TEST_SET_PROFILE",
	"XDG_DATA_HOME",
	"__PI_NATIVE_VARIANT_CACHE",
]);

it("keeps the native loader and grammar installer on the same effective cache root", async () => {
	const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-natives-root-"));
	try {
		const home = path.join(tempRoot, "home");
		await fs.mkdir(home);
		const root = path.join(tempRoot, "root");
		const cache = path.join(tempRoot, "cache");
		const selectedCache = process.platform === "linux" ? path.join(cache, String(process.getuid!())) : cache;
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
			const resolved = [paths()];
			if (process.env.TEST_SET_PROFILE) {
				setProfile(process.env.TEST_SET_PROFILE);
				resolved.push(paths());
			}
			console.log(JSON.stringify(resolved));
		`;
		const xdgEnabled = process.platform === "linux" || process.platform === "darwin";
		const cases: Array<[Record<string, string>, string, string?]> = [
			[{ OMP_CONFIG_ROOT: root }, path.join(root, "natives")],
			[{ OMP_CONFIG_ROOT: "relative/root" }, path.join(home, ".omp", "natives")],
			[
				{ OMP_CONFIG_ROOT: root, OMP_CACHE_DIR: cache, OMP_PROFILE: "audit" },
				path.join(selectedCache, "profiles", "audit", "natives"),
			],
			[
				{ OMP_CACHE_DIR: cache, TEST_SET_PROFILE: "audit" },
				path.join(selectedCache, "natives"),
				path.join(selectedCache, "profiles", "audit", "natives"),
			],
			[
				{ OMP_CONFIG_ROOT: root, OMP_PROFILE: "audit", XDG_CACHE_HOME: cache },
				path.join(root, "profiles", "audit", "natives"),
			],
			[{ OMP_CONFIG_ROOT: root, OMP_CACHE_DIR: cache, OMP_PROFILE: "audit", PI_NATIVES_DIR: shared }, shared],
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
		];
		await fs.mkdir(path.join(cache, "omp", "profiles", "migrated"), { recursive: true });
		cases.push([
			{ XDG_CACHE_HOME: cache, OMP_PROFILE: "migrated" },
			path.join(xdgEnabled ? path.join(cache, "omp") : path.join(home, ".omp"), "profiles", "migrated", "natives"),
		]);
		const baseEnv = { ...process.env };
		for (const key of Object.keys(baseEnv)) {
			if (ENV_KEYS.has(process.platform === "win32" ? key.toUpperCase() : key)) delete baseEnv[key];
		}
		const expectedPaths = (dir: string) => [dir, path.join(dir, "grammars")];
		for (const [values, expected, after] of cases) {
			const child = Bun.spawnSync([process.execPath, "-e", script], {
				env: { ...baseEnv, ...values, HOME: home, USERPROFILE: home, PI_NATIVE_VARIANT: "baseline" },
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(child.exitCode, child.stderr.toString()).toBe(0);
			expect(JSON.parse(child.stdout.toString())).toEqual(
				after === undefined ? [expectedPaths(expected)] : [expectedPaths(expected), expectedPaths(after)],
			);
		}
	} finally {
		await fs.rm(tempRoot, { recursive: true, force: true });
	}
});
