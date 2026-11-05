#!/usr/bin/env bun
/**
 * Publishing-only Cargo builder. Linux ships x64 baseline against glibc 2.17;
 * Windows ships x64 modern with the static MSVC CRT. Cargo owns freshness and
 * reuses CARGO_TARGET_DIR; only the installed copy is version-stamped.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ensureWindowsBuildTools, installBinary } from "../packages/natives/scripts/build-bindings";
import { nativesPackageVersion, stampNativeVersion } from "./stamp-native-version";

const repoRoot = path.resolve(import.meta.dir, "..");

/** Reject accidental host-glibc or C++ runtime dependencies without loading the addon. */
async function inspectLinuxAbi(addon: string, env: NodeJS.ProcessEnv): Promise<void> {
	const result = Bun.spawn(["readelf", "--version-info", "--dynamic", addon], {
		env,
		stdout: "pipe",
		stderr: "inherit",
	});
	const [metadata, exitCode] = await Promise.all([new Response(result.stdout).text(), result.exited]);
	if (exitCode !== 0) throw new Error(`readelf failed for the release addon (exit ${exitCode})`);
	const versions = [...metadata.matchAll(/\bGLIBC_(\d+)\.(\d+)(?:\.(\d+))?\b/g)];
	if (versions.length === 0) throw new Error("Release addon has no inspectable GLIBC version requirements");
	for (const [, major, minor, patch] of versions) {
		if (
			Number(major) > 2 ||
			(Number(major) === 2 && (Number(minor) > 17 || (Number(minor) === 17 && Number(patch ?? 0) > 0)))
		) {
			throw new Error(`Release addon requires GLIBC_${major}.${minor}${patch ? `.${patch}` : ""}, above GLIBC_2.17`);
		}
	}
	// Zig supplies the C++ runtime statically. Do not ship dependencies on an
	// Ubuntu libstdc++/libc++, or another unbundled host library.
	const systemLibraries = new Set([
		"libc.so.6",
		"libm.so.6",
		"libdl.so.2",
		"libpthread.so.0",
		"librt.so.1",
		"libutil.so.1",
		"libresolv.so.2",
		"libgcc_s.so.1",
		"ld-linux-x86-64.so.2",
	]);
	for (const [, library] of metadata.matchAll(/\(NEEDED\)[^\n]*\[([^\]]+)\]/g)) {
		if (!systemLibraries.has(library)) throw new Error(`Release addon requires unbundled host library ${library}`);
	}
	if (/\b(?:GLIBCXX_|CXXABI_|GLIBC_PRIVATE\b)/.test(metadata)) {
		throw new Error("Release addon retains a nonportable C++ or private glibc ABI requirement");
	}
	console.log("Native ABI: GLIBC <= 2.17; no dynamic C++ runtime dependency");
}

export async function buildReleaseNative(): Promise<string> {
	if (process.arch !== "x64" || (process.platform !== "linux" && process.platform !== "win32")) {
		throw new Error("Release native build supports only linux-x64 and win32-x64 hosts");
	}
	ensureWindowsBuildTools();
	const linux = process.platform === "linux";
	const target = linux ? "x86_64-unknown-linux-gnu" : "x86_64-pc-windows-msvc";
	const variant = linux ? "baseline" : "modern";
	const filename = `pi_natives.${process.platform}-x64-${variant}.node`;
	const outputDir = path.resolve(
		process.env.OMP_RELEASE_NATIVE_DIR?.trim() || path.join(repoRoot, "packages/natives/native"),
	);
	const targetDir = path.resolve(process.env.CARGO_TARGET_DIR?.trim() || path.join(repoRoot, "target"));
	const env: NodeJS.ProcessEnv = { ...process.env };
	// Publishing settings are fixed, not inherited from a developer's host ISA,
	// profile, native compiler, or a previous cargo-zigbuild invocation.
	for (const key of Object.keys(env)) {
		if (
			/^(?:RUSTFLAGS|CARGO_ENCODED_RUSTFLAGS|RUSTC_LINKER|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER|CARGO_BUILD_RUSTFLAGS|CARGO_BUILD_RUSTC_WRAPPER|CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER)$/.test(
				key,
			) ||
			key.startsWith("CARGO_PROFILE_") ||
			/^CARGO_TARGET_.*_(?:RUSTFLAGS|LINKER|RUNNER)$/.test(key) ||
			/^(?:(?:HOST_|TARGET_)?(?:CC|CXX|AR|RANLIB|CFLAGS|CXXFLAGS|CPPFLAGS|CXXSTDLIB))(?:_|$)/.test(key) ||
			/^(?:CMAKE_TOOLCHAIN_FILE|TARGET_CMAKE_TOOLCHAIN_FILE|CMAKE_ARGS|CMAKE_C_FLAGS|CMAKE_CXX_FLAGS)(?:_|$)/.test(
				key,
			) ||
			/^(?:(?:HOST_|TARGET_)?PKG_CONFIG)(?:_|$)/.test(key) ||
			/^NK_(?:TARGET_|MARCH_NATIVE)/.test(key)
		)
			delete env[key];
	}
	env.CARGO_TARGET_DIR = targetDir;
	env.CARGO_INCREMENTAL = "1";
	env.CARGO_PROFILE_LOCAL_STRIP = "symbols";
	env.CMAKE_GENERATOR = "Ninja";
	env.PCRE2_SYS_STATIC = "1";
	env.NK_MARCH_NATIVE = "0";
	env.RUSTFLAGS = linux ? "-C target-cpu=x86-64-v2" : "-C target-feature=+crt-static -C target-cpu=x86-64-v3";
	if (linux) {
		// NumKong's per-function dispatch needs EVEX-512 intrinsic support in
		// Zig's Clang, not AVX2/AVX512F in baseline TUs. POPCNT is part of v2.
		env.CFLAGS_x86_64_unknown_linux_gnu = "-march=x86-64-v2 -mevex512 -mpopcnt";
		env.CXXFLAGS_x86_64_unknown_linux_gnu = "-march=x86-64-v2 -mevex512 -mpopcnt -stdlib=libc++";
		env.CXXSTDLIB_x86_64_unknown_linux_gnu = "c++";
		// No host pkg-config discoveries may inject Ubuntu libraries into the
		// glibc 2.17 target. Optional system-library features are not enabled.
		env.PKG_CONFIG = "/bin/false";
		env.PKG_CONFIG_x86_64_unknown_linux_gnu = "/bin/false";
	} else {
		// Match .cargo/config.toml's UTF-8 and static wasmtime declarations.
		env.CFLAGS_x86_64_pc_windows_msvc = "-DLIBWASM_STATIC /utf-8 /arch:AVX2";
		env.CXXFLAGS_x86_64_pc_windows_msvc = "/utf-8 /arch:AVX2";
	}
	const args = [
		"cargo",
		linux ? "zigbuild" : "build",
		"--manifest-path",
		path.join(repoRoot, "Cargo.toml"),
		"--locked",
		"--package",
		"pi-natives",
		"--lib",
		"--profile",
		"local",
		"--target",
		linux ? `${target}.2.17` : target,
		"--target-dir",
		targetDir,
	];
	console.log(
		`Building release native: ${process.platform}-x64-${variant} (local, stripped${linux ? ", glibc 2.17" : ", static CRT"})`,
	);
	const start = performance.now();
	const build = Bun.spawn(args, { cwd: repoRoot, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
	const exitCode = await build.exited;
	if (exitCode !== 0) throw new Error(`Release native Cargo build failed (exit ${exitCode})`);

	// Read only Cargo's exact target/profile output after a successful build,
	// never an installed addon left by an earlier build. Do not stamp Cargo's
	// original: changing its bytes would corrupt Cargo's reusable build output.
	const compiled = path.join(targetDir, target, "local", linux ? "libpi_natives.so" : "pi_natives.dll");
	await fs.mkdir(outputDir, { recursive: true });
	const stagingDir = await fs.mkdtemp(path.join(outputDir, ".release-native-"));
	const staged = path.join(stagingDir, filename);
	const destination = path.join(outputDir, filename);
	try {
		await fs.copyFile(compiled, staged);
		if (linux) await inspectLinuxAbi(staged, env);
		await stampNativeVersion(staged, await nativesPackageVersion());
		await installBinary(staged, destination);
	} finally {
		await fs.rm(stagingDir, { recursive: true, force: true });
	}
	console.log(`Native release complete: ${destination} (${((performance.now() - start) / 1000).toFixed(1)}s)`);
	return destination;
}

if (import.meta.main) {
	if (process.argv.length !== 2) throw new Error("Usage: bun scripts/build-release-native.ts");
	await buildReleaseNative();
}
