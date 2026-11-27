import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { releaseNativeEnvironment } from "./build-release-native";

export const windowsBinary = "omp-windows-x64.exe";
export const linuxBinary = "omp-linux-x64";
export const windowsSdk = "omp-sdk-win32-x64.zip";
export const linuxSdk = "omp-sdk-linux-x64.zip";
export const assetNames = [windowsBinary, linuxBinary, windowsSdk, linuxSdk] as const;
export type AssetName = (typeof assetNames)[number];
export type Source = { commit: string; openwiki: string };

type Digest = { size: number; sha256: string };
type Viewer = Digest & { file: string };
type Entry = { key: string; file: string; marker: string; name: AssetName };
type Build = {
	stage: string;
	cache: string;
	source: Source;
	releaseVersion: string;
	updateRepository: string;
	assets: readonly AssetName[];
};

const root = path.resolve(import.meta.dir, "..");
const viewerManifest = path.join(root, "packages/coding-agent/src/export/html/viewer.generated.json");
const viewerScript = "packages/collab-web/scripts/build-export-viewer.ts";
const linux = process.platform === "linux";
const host = linux ? "Linux" : "Windows";

function cacheKey(input: unknown): string {
	return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export async function artifactDigest(file: string): Promise<Digest> {
	const stat = await fs.stat(file);
	if (!stat.isFile() || !stat.size) throw new Error(`Missing or empty build output: ${file}`);
	const hash = createHash("sha256");
	let size = 0;
	for await (const bytes of Bun.file(file).stream()) {
		hash.update(bytes);
		size += bytes.byteLength;
	}
	if (size !== stat.size) throw new Error(`Build output changed while hashing: ${file}`);
	return { size, sha256: hash.digest("hex") };
}

export function viewerDigest(value: unknown): Viewer {
	const metadata = value as { file?: unknown; integrity?: unknown; size?: unknown } | null;
	const match = typeof metadata?.file === "string" && /^export-viewer-([a-f0-9]{64})\.js$/.exec(metadata.file);
	const size = metadata?.size;
	if (!match || typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0 ||
		metadata?.integrity !== `sha256-${Buffer.from(match[1]!, "hex").toBase64()}`) {
		throw new Error("Invalid committed Export viewer byte metadata.");
	}
	return { file: match[0], size, sha256: match[1]! };
}

export async function cachedArtifact(entry: Entry, viewer: Viewer): Promise<boolean> {
	try {
		const record: unknown = await Bun.file(entry.marker).json();
		const base = { key: entry.key, name: entry.name, viewer };
		if (!record || typeof record !== "object" || !isDeepStrictEqual(base, {
			key: Reflect.get(record, "key"), name: Reflect.get(record, "name"), viewer: Reflect.get(record, "viewer"),
		})) return false;
		return isDeepStrictEqual(record, { ...base, artifact: await artifactDigest(entry.file) });
	} catch {
		// Missing, malformed, unreadable and corrupt entries are all cache misses.
		return false;
	}
}

async function capture(command: string[], env: NodeJS.ProcessEnv, allowFailure = false): Promise<string> {
	const proc = Bun.spawn(command, { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
	if (code !== 0 && !allowFailure) throw new Error(`${host} ${path.basename(command[0]!)} probe failed (${code}).`);
	return (code === 0 ? out || err : "").trim();
}

function executable(name: string, env: NodeJS.ProcessEnv): string {
	const file = Bun.which(name, { PATH: env.PATH, cwd: root });
	if (!file) throw new Error(`${host} release builds require ${name}.`);
	return file;
}

async function fileIdentity(file: string) {
	const real = await fs.realpath(file);
	const { size, mtimeMs } = await fs.stat(real);
	return [file, real, size, mtimeMs];
}

async function tool(name: string, env: NodeJS.ProcessEnv, ...args: string[]) {
	const file = /[\\/]/.test(name) ? path.resolve(root, name) : executable(name, env);
	return [await fileIdentity(file), args.length ? await capture([file, ...args], env) : undefined];
}

async function windowsNativeTools(env: NodeJS.ProcessEnv) {
	// Prefer the active VS toolchain. Otherwise identify the default tools in the
	// same latest x64 Build Tools installation used by Windows build discovery.
	let cl = Bun.which("cl.exe", { PATH: env.PATH, cwd: root });
	if (!cl) {
		const programFiles = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
		const vswhere = path.join(programFiles, "Microsoft Visual Studio/Installer/vswhere.exe");
		const vs = env.VCINSTALLDIR || path.join(await capture([
			vswhere, "-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
			"-property", "installationPath",
		], env), "VC");
		const vc = env.VCToolsInstallDir || path.join(vs, "Tools/MSVC", (
			await fs.readFile(path.join(vs, "Auxiliary/Build/Microsoft.VCToolsVersion.default.txt"), "utf8")
		).trim());
		cl = path.join(vc, "bin/Hostx64/x64/cl.exe");
	}
	const kit = env.WindowsSdkDir || /REG_SZ\s+([^\r\n]+)/.exec(await capture([
		executable("reg.exe", env), "query", "HKLM\\SOFTWARE\\Microsoft\\Windows Kits\\Installed Roots",
		"/v", "KitsRoot10", "/reg:32",
	], env, true))?.[1]?.trim();
	if (!kit) throw new Error("Cannot identify the Windows release SDK.");
	const libraries = path.join(kit, "Lib");
	let sdk = env.WindowsSDKVersion?.replace(/[\\/]+$/, "");
	if (!sdk) {
		const installed = (await fs.readdir(libraries))
			.filter(version => /^10\.\d+\.\d+\.\d+$/.test(version))
			.sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
		for (const version of installed) {
			if (await Bun.file(path.join(libraries, version, "um/x64/kernel32.lib")).exists()) {
				sdk = version;
				break;
			}
		}
	}
	if (!sdk) throw new Error("Cannot identify the Windows release SDK version.");
	const lib = path.dirname(cl);
	return Promise.all([
		fileIdentity(cl), fileIdentity(path.join(lib, "link.exe")), fileIdentity(path.join(lib, "lib.exe")),
		fileIdentity(path.join(libraries, sdk, "um/x64/kernel32.lib")),
		fileIdentity(path.join(libraries, env.UCRTVersion || sdk, "ucrt/x64/ucrt.lib")),
	]);
}

// Hash exact build configuration files, not user directories, the worktree or
// Cargo credentials. Cargo also accepts environment overrides to these settings.
async function cargoConfig(env: NodeJS.ProcessEnv) {
	const home = path.resolve(root, env.CARGO_HOME || path.join(os.homedir(), ".cargo"));
	return Promise.all([home, path.join(root, ".cargo")].map(async dir => {
		for (const name of ["config", "config.toml"]) {
			const file = path.join(dir, name);
			if (await Bun.file(file).exists()) return [file, Bun.SHA256.hash(await fs.readFile(file), "hex")];
		}
		return undefined;
	}));
}

/** Match cargo-zigbuild's explicit override, Python wheel, then PATH selection. */
async function zigInput(env: NodeJS.ProcessEnv) {
	const command = env.CARGO_ZIGBUILD_ZIG_COMMAND;
	if (command && await Bun.file(command).exists()) {
		const args = env.CARGO_ZIGBUILD_ZIG_COMMAND_ARGS?.trim().split(/\s+/).filter(Boolean) ?? [];
		return tool(path.resolve(root, command), env, ...args, "version");
	}
	const python = Bun.which(env.CARGO_ZIGBUILD_PYTHON_PATH || "python3", { PATH: env.PATH, cwd: root });
	if (python) {
		const version = await capture([python, "-m", "ziglang", "version"], env, true);
		if (/^\d+\.\d+\.\d+/.test(version)) {
			const binary = await capture([python, "-c", "import pathlib, ziglang; print(pathlib.Path(ziglang.__file__).with_name('zig'))"], env);
			return [await fileIdentity(python), await fileIdentity(binary), version];
		}
	}
	return tool(env.CARGO_ZIGBUILD_ZIG_PATH || "zig", env, "version");
}

async function nativeInputs(env: NodeJS.ProcessEnv) {
	const prefixes = /^(?:CARGO_(?:BUILD|TARGET|PROFILE|ZIGBUILD)_|CMAKE_|C(?:XX)?FLAGS_|LDFLAGS|BINDGEN_EXTRA_CLANG_ARGS|NK_|PKG_CONFIG|ZIG_|VSCMD_ARG_)/i;
	const names = /^(?:CARGO_HOME|RUSTUP_HOME|RUSTUP_TOOLCHAIN|RUSTC|RUSTDOC|RUSTFLAGS|CARGO_ENCODED_RUSTFLAGS|CMAKE|NINJA|LIBCLANG_PATH|CLANG_PATH|PCRE2_SYS_STATIC|PYTHONPATH|CL|_CL_|LINK|_LINK_|LIB|LIBPATH|INCLUDE|VCINSTALLDIR|VCToolsInstallDir|VCToolsVersion|WindowsSdkDir|WindowsSDKVersion|UCRTVersion)$/i;
	const settings = Object.entries(env)
		.filter(([name]) => prefixes.test(name) || names.test(name))
		.sort(([a], [b]) => a.localeCompare(b));
	const tools = await Promise.all([
		tool("cargo", env, "-Vv"),
		tool(env.RUSTC || env.CARGO_BUILD_RUSTC || "rustc", env, "-vV"),
		tool(env.CMAKE || "cmake", env, "--version"),
		tool("ninja", env, "--version"),
		linux ? Promise.all([
			tool("cargo-zigbuild", env), tool("cargo", env, "zigbuild", "--version"), zigInput(env),
			tool("readelf", env, "--version"), tool("cc", env, "--version"), tool("c++", env, "--version"),
			tool("ld", env, "--version"), tool("ar", env, "--version"),
		]) : windowsNativeTools(env),
		cargoConfig(env),
	]);
	return { settings, tools };
}

async function timed<T>(label: string, action: () => Promise<T>): Promise<T> {
	const started = performance.now();
	try {
		return await action();
	} finally {
		console.log(`${host} ${label} elapsed: ${((performance.now() - started) / 1000).toFixed(1)}s`);
	}
}

async function runBun(env: NodeJS.ProcessEnv, ...args: string[]): Promise<void> {
	const proc = Bun.spawn([process.execPath, ...args], { cwd: root, env, stdout: "inherit", stderr: "inherit", stdin: "ignore" });
	const code = await proc.exited;
	if (code !== 0) throw new Error(`${host} ${args[0]} failed (${code}).`);
}

async function verifySource(env: NodeJS.ProcessEnv, source: Source): Promise<void> {
	const [commit, openwiki] = (await capture(["git", "rev-parse", "HEAD", "HEAD:vendor/openwiki"], env)).split(/\r?\n/);
	const status = await capture(["git", "status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"], env);
	if (commit !== source.commit || openwiki !== source.openwiki || status) {
		throw new Error(`${host} worktree or OpenWiki changed during the build; refusing to publish.`);
	}
}

async function buildCnbHost({ stage, cache, source, releaseVersion, updateRepository, assets }: Build): Promise<void> {
	const binary = linux ? linuxBinary : windowsBinary;
	const sdk = linux ? linuxSdk : windowsSdk;
	if (!assets.length || assets.some(name => name !== binary && name !== sdk)) throw new Error(`Invalid ${host} asset selection.`);
	const target = linux ? "linux-x64-baseline-glibc2.17" : "win32-x64-modern";
	const nativeEnv = releaseNativeEnvironment();
	const env: NodeJS.ProcessEnv = { ...process.env, RELEASE_VERSION: releaseVersion, UPDATE_REPOSITORY: updateRepository };
	delete env.CNB_TOKEN;
	delete nativeEnv.CNB_TOKEN;
	const viewer = viewerDigest(await Bun.file(viewerManifest).json());
	const inputs = await timed("build inputs", () => nativeInputs(nativeEnv));
	const sdkPacker = assets.includes(sdk) ? await tool(
		linux ? "zip" : path.join(env.SystemRoot ?? "C:\\Windows", "System32/tar.exe"),
		nativeEnv, linux ? "-v" : "--version",
	) : undefined;
	const completed = path.join(cache, target, "completed");
	const common = { source, target, bun: Bun.version, bunRevision: Bun.revision, inputs, releaseVersion, updateRepository, viewer };
	const entries = assets.map(name => {
		const key = cacheKey({ common, name, packer: name === sdk ? sdkPacker : undefined });
		const file = path.join(completed, key, name);
		return { key, file, marker: `${file}.json`, name };
	});
	const misses = await timed("cache lookup", async () => {
		const hits = await Promise.all(entries.map(entry => cachedArtifact(entry, viewer)));
		entries.forEach(({ name }, index) => console.log(`${host} ${name}: cache ${hits[index] ? "hit" : "miss"} (${target}).`));
		return entries.filter((_, index) => !hits[index]);
	});

	if (misses.length) {
		await fs.mkdir(completed, { recursive: true });
		const work = await fs.mkdtemp(path.join(completed, "building-"));
		try {
			env.OMP_RELEASE_NATIVE_DIR = path.join(work, "native");
			env.OMP_RELEASE_BINARY_DIR = work;
			env.OMP_BUILD_CACHE_DIR = path.join(cache, target, "build-assets");
			await timed("dependencies", async () => {
				// Bun's workspace bin linker makes the tracked entrypoint executable on Linux.
				const cli = path.join(root, "packages/coding-agent/src/cli.ts");
				const mode = linux ? (await fs.stat(cli)).mode & 0o777 : undefined;
				try {
					await runBun({ ...env, OMP_SKIP_OPENWIKI_POSTINSTALL: "1" }, "install", "--frozen-lockfile");
				} finally {
					if (mode !== undefined) await fs.chmod(cli, mode);
				}
			});
			await timed("native build", () => runBun(env, "scripts/build-release-native.ts"));
			if (misses.some(entry => entry.name === binary)) {
				await timed("binary packaging", () =>
					runBun(env, "scripts/ci-release-build-binaries.ts", "--targets", linux ? "linux-x64" : "win32-x64"),
				);
			} else {
				await timed("Export viewer verification", () => runBun(env, viewerScript, "--check"));
			}
			const { file, ...digest } = viewer;
			const actual = await artifactDigest(path.join(root, "packages/coding-agent/export-assets", file));
			if (!isDeepStrictEqual(actual, digest)) throw new Error(`${host} Export viewer bytes do not match the verified manifest.`);
			if (misses.some(entry => entry.name === sdk)) {
				await timed("SDK ZIP packaging", () => runBun(env, "scripts/pack-sdk.ts", path.join(work, sdk)));
			}
			const digests = await Promise.all(misses.map(entry => artifactDigest(path.join(work, entry.name))));
			await verifySource(env, source);
			for (const [index, entry] of misses.entries()) {
				await fs.mkdir(path.dirname(entry.file), { recursive: true });
				await fs.rm(entry.marker, { force: true });
				const record = path.join(work, `${entry.name}.json`);
				await Bun.write(record, JSON.stringify({ key: entry.key, name: entry.name, viewer, artifact: digests[index] }));
				await fs.rename(path.join(work, entry.name), entry.file);
				await fs.rename(record, entry.marker);
			}
		} finally {
			await fs.rm(work, { recursive: true, force: true });
		}
	}
	await timed("upload staging", () => Promise.all(entries.map(({ file, name }) => {
		const destination = path.join(stage, name);
		return linux ? fs.copyFile(file, destination) : fs.link(file, destination).catch((error: NodeJS.ErrnoException) => {
			if (!["EXDEV", "ENOTSUP", "EPERM"].includes(error.code ?? "")) throw error;
			return fs.copyFile(file, destination);
		});
	})));
}

if (import.meta.main) {
	const [cache, stage, commit, openwiki, bun, revision, releaseVersion, updateRepository, ...names] = process.argv.slice(2);
	if ((!linux && process.platform !== "win32") || process.arch !== "x64" || !cache || !stage || !commit ||
		!openwiki || !releaseVersion || !updateRepository ||
		!names.every((name): name is AssetName => assetNames.some(asset => asset === name))) {
		throw new Error(`Invalid CNB ${host} build parameters.`);
	}
	if (bun !== "-" && (Bun.version !== bun || Bun.revision !== revision)) throw new Error(`${host} Bun changed after preflight.`);
	await buildCnbHost({ cache, stage, source: { commit, openwiki }, releaseVersion, updateRepository, assets: names });
}
