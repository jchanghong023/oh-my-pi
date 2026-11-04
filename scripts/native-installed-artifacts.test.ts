import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { detectHostAvx2Support, resolveLocalHostAddon } from "./host-detect";
import { nativesPackageVersion } from "./stamp-native-version";

// Consumes the real host build produced by the normal build:native prerequisite.
// It never compiles, substitutes filesystem calls, or rewrites installation modes.
test("the actual host native installation has a matching build stamp and safe file modes", async () => {
	const nativeDir = path.resolve(import.meta.dir, "../packages/natives/native");
	const addon = path.join(
		nativeDir,
		resolveLocalHostAddon({ platform: process.platform, arch: process.arch, avx2: detectHostAvx2Support() }).filename,
	);
	for (const installed of [addon, path.join(nativeDir, "index.d.ts")]) {
		const metadata = await fs.stat(installed);
		expect(metadata.isFile(), installed).toBe(true);
		expect(metadata.size, installed).toBeGreaterThan(0);
		expect(metadata.mode & 0o200, installed).toBeGreaterThan(0);
		if (process.platform !== "win32") expect(metadata.mode & 0o777, installed).toBe(0o644);
	}
	const loaded: { exports: Record<string, unknown> } = { exports: {} };
	process.dlopen(loaded, addon);
	const buildVersion = loaded.exports.__piNativesBuildVersion;
	expect(typeof buildVersion).toBe("function");
	if (typeof buildVersion !== "function") throw new Error("Installed addon does not expose its build stamp");
	expect(buildVersion()).toBe(await nativesPackageVersion());
});
