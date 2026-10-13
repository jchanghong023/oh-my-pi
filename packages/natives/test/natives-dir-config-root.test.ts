import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { initLoaderContext } from "../native/loader-state.js";
import packageJson from "../package.json" with { type: "json" };

const ENV_KEYS = [
	"HOME",
	"USERPROFILE",
	"OMP_CONFIG_ROOT",
	"PI_NATIVES_DIR",
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
});
