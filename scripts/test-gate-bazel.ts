import { dlopen, FFIType, ptr } from "bun:ffi";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { GateCommand, GateRun } from "./test-gate-runtime";
import { GateCommandError } from "./test-gate-failure-events";
import { gateCommandRisk } from "./test-gate-scheduler";
import { registerBazelInvocation } from "./test-gate-bazel-report";
import { openGateLibc } from "./test-gate-libc";
import { discoverBazelHelperInputs } from "./test-gate-bazel-inputs";
import { bazelShell, bazelToolPath } from "./test-gate-bazel-tools";

function bazelNamespace(commands: readonly GateCommand[]): string {
	if (commands.every(command => command.label.startsWith("compile/Rust native host "))) return "native";
	return commands.every(command => command.label.startsWith("static/"))
		? "static"
		: commands.some(command => command.label.startsWith("test/fork "))
			? "tests"
			: commands.every(command => command.label.startsWith("build/"))
				? "build"
				: "scripts";
}

async function acquireWorkspaceLease(
	gate: GateRun,
	root: string,
	commands: readonly GateCommand[],
): Promise<{ release(): void; fd?: number }> {
	const directory = path.join(root, "node_modules", ".cache", "test-gate-bazel", bazelNamespace(commands));
	await fs.mkdir(directory, { recursive: true });
	const identity = await fs.realpath(directory);
	const started = performance.now();
	if (process.platform === "win32") {
		const name = Buffer.from(
			`Global\\omp-gate-bazel-${createHash("sha256").update(identity.toLowerCase()).digest("hex")}\0`,
			"utf16le",
		);
		const kernel = dlopen("kernel32.dll", {
			CreateMutexExW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32], returns: FFIType.u64 },
			GetLastError: { args: [], returns: FFIType.u32 },
			SetLastError: { args: [FFIType.u32], returns: FFIType.void },
			CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
		});
		try {
			for (;;) {
				gate.signal.throwIfAborted();
				kernel.symbols.SetLastError(0);
				const handle = kernel.symbols.CreateMutexExW(null, ptr(name), 0, 0x100000);
				const error = kernel.symbols.GetLastError();
				if (!handle) throw new Error(`Cannot acquire Bazel declaration lease (${error})`);
				if (error !== 183) {
					console.log(`bazel declaration lease wait_ms=${(performance.now() - started).toFixed(3)}`);
					return {
						release: () => {
							kernel.symbols.CloseHandle(handle);
							kernel.close();
						},
					};
				}
				kernel.symbols.CloseHandle(handle);
				await Bun.sleep(10);
			}
		} catch (error) {
			kernel.close();
			throw error;
		}
	}
	const file = await fs.open(path.join(directory, "declarations.lock"), "a+");
	const libc = openGateLibc({
		flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
	});
	try {
		while (libc.symbols.flock(file.fd, 2 | 4) !== 0) {
			gate.signal.throwIfAborted();
			await Bun.sleep(10);
		}
		console.log(`bazel declaration lease wait_ms=${(performance.now() - started).toFixed(3)}`);
		return {
			fd: file.fd,
			release: () => {
				void file.close();
				libc.close();
			},
		};
	} catch (error) {
		await file.close();
		libc.close();
		throw error;
	}
}

const repository = path.resolve(import.meta.dir, "..");
const runtimeKeys = /^(?:OMP_GATE_|OMP_TEST_(?:RUN|REPORT)|BUN_TEST_REPORT)/;
const isolatedKeys = /^(?:HOME|USERPROFILE|TMP|TEMP|TMPDIR|XDG_.*|OMP_CONFIG_ROOT|PI_CODING_AGENT_DIR|PI_CONFIG_DIR)$/;
const rustEnvironmentKeys =
	/^(?:OMP_NATIVE_|NAPI_|PCRE2_SYS_|CARGO_|RUST|NEXTEST_|CC(?:_|$)|CXX(?:_|$)|AR(?:_|$)|AS(?:_|$)|RC(?:_|$)|CL$|_CL_$|LINK$|VSCMD_|VSINSTALLDIR$|VCINSTALLDIR$|VCTools|WindowsSDK|WindowsSdk|UCRT|UniversalCRT|CFLAGS|CXXFLAGS|CPPFLAGS|LDFLAGS|CMAKE_|PKG_CONFIG|LIBCLANG|CLANG|SDKROOT$|MACOSX_|DEPLOYMENT_TARGET$|GIT_|JJ_|SSH_|LANG$|LC_|TZ$)/;
const credentialEnvironmentKeys = /(?:TOKEN|PASSWORD|PASSWD|SECRET|CREDENTIAL|AUTHORIZATION|EXTRAHEADER)/i;
const toolEnvironment = [
	"PATH",
	"PATHEXT",
	"SYSTEMROOT",
	"SystemRoot",
	"WINDIR",
	"COMSPEC",
	"ComSpec",
	"ProgramFiles",
	"ProgramFiles(x86)",
	"LOCALAPPDATA",
	"GIT_INSTALL_ROOT",
	"SCOOP",
	"SHELL",
	"BAZEL_SH",
	"TEMP",
	"TMP",
	"HOME",
	"USERPROFILE",
	"CARGO_HOME",
	"RUSTUP_HOME",
	"INCLUDE",
	"LIB",
	"LIBPATH",
	"VCINSTALLDIR",
	"VCToolsInstallDir",
	"WindowsSdkDir",
	"WindowsSDKVersion",
	"PROCESSOR_ARCHITECTURE",
	"RUSTFLAGS",
	"CARGO_ENCODED_RUSTFLAGS",
	"RUSTUP_TOOLCHAIN",
	"CARGO_BUILD_TARGET",
	"CARGO_TARGET_DIR",
	"NODE_OPTIONS",
	"NODE_PATH",
	"BUN_OPTIONS",
	"PYTHONUTF8",
	...Object.keys(process.env).filter(key => rustEnvironmentKeys.test(key) && !credentialEnvironmentKeys.test(key)),
];

export interface BazelPrimitiveSpec {
	label: string;
	root: string;
	workspace: string;
	argv: string[];
	cwd: string;
	env: Record<string, string | null>;
	isolated: boolean;
	charged: boolean;
	artifactFiles?: readonly string[];
}
export interface BazelTargetResult {
	label: string;
	target: string;
	status: "new" | "cached" | "incomplete" | "failed";
	configuration?: string;
	buildEventFile: string;
	executionLogFile: string;
	artifacts?: Record<string, string>;
}
interface BazelEvent {
	id?: {
		targetCompleted?: { label?: string; configuration?: { id?: string } };
		testSummary?: { label?: string };
		actionCompleted?: { primaryOutput?: string };
		namedSet?: { id?: string };
	};
	completed?: {
		success?: boolean;
		outputGroup?: Array<{ fileSets?: Array<{ id?: string }>; inlineFiles?: BazelOutputFile[] }>;
	};
	namedSetOfFiles?: { files?: BazelOutputFile[]; fileSets?: Array<{ id?: string }> };
	testSummary?: { overallStatus?: string; totalNumCached?: number; passed?: Array<{ uri?: string }> };
	finished?: { overallSuccess?: boolean };
}
interface BazelOutputFile {
	name?: string;
	pathPrefix?: string[];
	uri?: string;
}
interface BazelPlan {
	root: string;
	workspace: string;
	bazel: string;
	targets: Map<string, string>;
	shell?: string;
	runTargets: Set<string>;
	uncachedTargets: Set<string>;
}

async function writeIfChanged(filename: string, content: string): Promise<void> {
	const file = Bun.file(filename);
	if ((await file.exists()) && (await file.text()) === content) return;
	await Bun.write(filename, content);
}

/** Bazel 9.2.0's native lockfile (format 28), generated with platforms 1.1.0.
 * Registry hashes let fresh workspaces use the real content-addressed download
 * cache, including bazel_tools' implicit module closure. This is bootstrap
 * metadata, not repository contents or cached extension results: native update
 * still resolves MODULE changes and fetches any missing or changed dependency.
 * Never replace a workspace's own lockfile after Bazel has taken ownership. */
async function seedModuleLockfiles(workspaces: readonly string[]): Promise<void> {
	const seed = path.join(import.meta.dir, "test-gate-bazel-module.lock");
	for (const workspace of workspaces) {
		const destination = path.join(workspace, "MODULE.bazel.lock");
		if (await Bun.file(destination).exists()) continue;
		await fs.mkdir(workspace, { recursive: true });
		try {
			await fs.copyFile(seed, destination, fs.constants.COPYFILE_EXCL);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
}

/** Resolve only the discovery helper's installed runtime closure. Bazel watches
 * these real package trees and every lookup boundary, not a cached digest. */
async function helperInstalledInputs(): Promise<{ packages: string[]; paths: string[] }> {
	const packages = new Set<string>();
	const paths = new Set<string>();
	const pending = [{ name: "@ts-morph/common", importer: import.meta.dir }];
	for (let index = 0; index < pending.length; index++) {
		const { name, importer } = pending[index]!;
		const candidates = (createRequire(path.join(importer, "package.json")).resolve.paths(name) ?? []).map(directory =>
			path.join(directory, name),
		);
		for (const candidate of candidates) {
			paths.add(candidate);
			paths.add(path.join(candidate, "package.json"));
		}
		let directory: string | undefined;
		for (const candidate of candidates) {
			try {
				await fs.lstat(candidate);
			} catch (error) {
				if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
				throw error;
			}
			// The lookup directory is the package boundary, even for npm aliases
			// or symlinks whose manifest name differs from the requested name.
			// Resolve failures after finding it indicate a broken installed package.
			directory = await fs.realpath(candidate);
			break;
		}
		if (!directory || packages.has(directory)) continue;
		const manifest = await Bun.file(path.join(directory, "package.json")).json();
		const exports = manifest.exports;
		const subpathOnly =
			exports !== null &&
			typeof exports === "object" &&
			!Array.isArray(exports) &&
			Object.keys(exports).some(key => key.startsWith(".")) &&
			!Object.hasOwn(exports, ".");
		if (!subpathOnly) {
			const resolved = await fs.realpath(Bun.resolveSync(name, importer));
			paths.add(resolved);
			// Nested type-only manifests are scope inputs, not package roots.
			for (let scope = path.dirname(resolved); ; scope = path.dirname(scope)) {
				const relative = path.relative(directory, scope);
				if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) break;
				paths.add(path.join(scope, "package.json"));
				if (scope === directory) break;
			}
		}
		packages.add(directory);
		for (const dependency of Object.keys({
			...manifest.dependencies,
			...manifest.optionalDependencies,
			...manifest.peerDependencies,
		}))
			pending.push({ name: dependency, importer: directory });
	}
	return { packages: [...packages].sort(), paths: [...paths].sort() };
}

/** Generate declarations only. Bazel owns dependency digests, transitive deps,
 * invalidation, scheduling, action results, test results, and their artifacts. */
async function declareTargets(
	gate: GateRun,
	commands: readonly GateCommand[],
	root: string,
	serverIdleSeconds?: number,
): Promise<BazelPlan> {
	const bazel = Bun.which("bazelisk") ?? Bun.which("bazel");
	if (!bazel) throw new GateCommandError("Bazel 9.2.0 is required", 127, "MISSING_TOOL");
	const namespace = bazelNamespace(commands);
	const workspace = path.join(root, "node_modules", ".cache", "test-gate-bazel", namespace);
	const shell = bazelShell({
		...process.env,
		BAZEL_SH: commands.map(command => command.env?.BAZEL_SH).find(Boolean) ?? process.env.BAZEL_SH,
	});
	const rustEnvironment = (command: GateCommand): Record<string, string> => {
		const canonical = (key: string) => (process.platform === "win32" ? key.toUpperCase() : key);
		const overrides = new Map(Object.entries(command.env ?? {}).map(([key, value]) => [canonical(key), value]));
		if (process.platform === "win32" && shell) overrides.set("BAZEL_SH", shell);
		return Object.fromEntries(
			[...new Set([...toolEnvironment, ...Object.keys(command.env ?? {})])]
				.filter(key => !isolatedKeys.test(key) && !runtimeKeys.test(key) && !credentialEnvironmentKeys.test(key))
				.filter(key => toolEnvironment.includes(key) || rustEnvironmentKeys.test(key))
				.sort()
				.map(
					key => [key, overrides.has(canonical(key)) ? overrides.get(canonical(key)) : process.env[key]] as const,
				)
				.filter((entry): entry is readonly [string, string] => entry[1] !== undefined),
		);
	};
	// Only cache the declared Windows compiler closure with stable Cargo homes;
	// isolated per-test HOME directories are not toolchain inputs.
	const rustCommands =
		process.platform === "win32"
			? commands.filter(command => {
					if (command.resultReuse === "disabled") return false;
					const ciStatic =
						command.label === "static/Rust fmt+clippy" &&
						command.env?.CI === "1" &&
						path.resolve(command.cwd ?? root) === root &&
						JSON.stringify(command.argv) === JSON.stringify(["bun", "run", "check:rs"]);
					if (
						!ciStatic &&
						!/^test\/Rust/.test(command.label) &&
						!command.label.startsWith("compile/Rust native host ")
					)
						return false;
					const env = rustEnvironment(command);
					return Boolean(env.CARGO_HOME && env.RUSTUP_HOME);
				})
			: [];
	const rustInputsEnvironment = rustCommands[0] ? rustEnvironment(rustCommands[0]) : {};
	if (rustCommands.some(command => JSON.stringify(rustEnvironment(command)) !== JSON.stringify(rustInputsEnvironment)))
		throw new GateCommandError("Rust primitives require one consistent toolchain discovery environment", 1);
	const inventory = await gate.capture({
		label: "scope/Bazel source paths",
		argv: ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
		cwd: root,
	});
	const files = [...new Set(inventory.stdout.split("\0").filter(Boolean))].sort();
	const tools: Record<string, string> = { [process.platform === "win32" ? "bun.exe" : "bun"]: process.execPath };
	const toolPath = bazelToolPath(process.env.PATH ?? process.env.Path ?? "");
	for (const name of [
		"git",
		"node",
		"cargo",
		"rustc",
		"bazel",
		"bazelisk",
		"powershell",
		"python",
		"python3",
		"zip",
		"tar",
	]) {
		const executable = Bun.which(name, { PATH: toolPath });
		if (executable && !/[\\/]Microsoft[\\/]WindowsApps[\\/]/i.test(executable))
			tools[process.platform === "win32" ? `${name}.exe` : name] = executable;
	}
	if (process.platform === "win32") {
		const systemTar = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
		if (await Bun.file(systemTar).exists()) tools["tar.exe"] = systemTar;
	}
	if (shell) tools[path.basename(shell)] = shell;
	for await (const binary of new Bun.Glob("node_modules/.bin/{oxlint,oxfmt,tsgo}*").scan({
		cwd: root,
		onlyFiles: true,
	}))
		tools[path.basename(binary)] = path.join(root, binary);
	const manifests = new Map<string, { directory: string; dependencies: string[] }>();
	for (const file of files.filter(file => /^packages\/[^/]+\/package\.json$/.test(file))) {
		const manifest = await Bun.file(path.join(root, file)).json();
		manifests.set(manifest.name, {
			directory: path.posix.dirname(file),
			dependencies: Object.keys({
				...manifest.dependencies,
				...manifest.devDependencies,
				...manifest.peerDependencies,
				...manifest.optionalDependencies,
			}),
		});
	}
	const packageDeps: Record<string, string[]> = {};
	for (const { directory, dependencies } of manifests.values())
		packageDeps[directory] = dependencies.flatMap(name =>
			manifests.has(name) ? [manifests.get(name)!.directory] : [],
		);
	const binaries: string[] = [];
	for await (const binary of new Bun.Glob("packages/**/*.{node,wasm,dll,so,dylib}").scan({
		cwd: root,
		onlyFiles: true,
	}))
		binaries.push(binary);
	files.push(...binaries.filter(binary => !files.includes(binary)));
	const commandSources: Record<string, string> = {};
	for (const command of commands) {
		if (!/^(test|smoke)\//.test(command.label)) continue;
		const owner = path
			.relative(root, command.cwd ?? root)
			.replaceAll("\\", "/")
			.match(/^packages\/([^/]+)/)?.[1];
		commandSources[`command_${Bun.hash(command.label).toString(16)}`] =
			/^test\/Rust/.test(command.label) || !owner ? "all" : `pkg_${owner}`;
	}
	const graphWorkspace = path.join(workspace, "graph-workspace");
	// Both native servers resolve implicit bazel_tools dependencies. The graph's
	// platforms override alone cannot prevent cold registry metadata requests.
	await seedModuleLockfiles([workspace, graphWorkspace]);
	const helperInputs = await helperInstalledInputs();
	const graphRuntimeInputs = await discoverBazelHelperInputs(
		path.join(import.meta.dir, "test-gate-bazel-discovery.ts"),
	);
	await writeIfChanged(
		path.join(workspace, "gate.bzl"),
		await Bun.file(path.join(import.meta.dir, "test-gate-bazel-rules.bzl")).text(),
	);
	await writeIfChanged(
		path.join(workspace, "sources.bzl"),
		await Bun.file(path.join(import.meta.dir, "test-gate-bazel-sources.bzl")).text(),
	);
	await writeIfChanged(
		path.join(workspace, "inputs.bzl"),
		await Bun.file(path.join(import.meta.dir, "test-gate-bazel-inputs.bzl")).text(),
	);
	await writeIfChanged(
		path.join(workspace, "MODULE.bazel"),
		[
			'module(name = "omp_local_gates")',
			'bazel_dep(name = "platforms", version = "1.1.0")',
			'bazel_dep(name = "bazel_skylib", version = "1.8.2")',
			'gate_inputs = use_repo_rule("//:inputs.bzl", "gate_inputs_repository")',
			'gate_sources = use_repo_rule("//:sources.bzl", "gate_sources_repository")',
			'gate_cycles = use_repo_rule("//:sources.bzl", "gate_cycles_repository")',
			`gate_inputs(name = "inputs", root = ${JSON.stringify(root)}, files = ${JSON.stringify(files)}, commands = ${JSON.stringify(JSON.stringify(commands.map(command => ({ label: command.label, argv: command.argv, cwd: command.cwd ?? root }))))}, bun = ${JSON.stringify(process.execPath)}, runner = ${JSON.stringify(path.join(import.meta.dir, "test-gate-bazel-inputs-runner.ts"))}, helper_packages = ${JSON.stringify(helperInputs.packages)}, helper_paths = ${JSON.stringify(helperInputs.paths)})`,
			`gate_cycles(name = "cycles", package_deps = ${JSON.stringify(packageDeps)}, input_graph = "@inputs//:cycles.json", graph_workspace = ${JSON.stringify(graphWorkspace)}, graph_bazel = ${JSON.stringify(bazel)}, graph_bun = ${JSON.stringify(process.execPath)}, graph_runner = ${JSON.stringify(path.join(import.meta.dir, "test-gate-bazel-discovery.ts"))}, graph_runtime_inputs = ${JSON.stringify(graphRuntimeInputs)})`,
			`gate_sources(name = "sources", root = ${JSON.stringify(root)}, files = ${JSON.stringify(files)}, package_deps = ${JSON.stringify(packageDeps)}, input_graph = "@inputs//:graph.json", command_sources = ${JSON.stringify(commandSources)}, cycle_domains = "@cycles//:cyclic-inputs.json")`,
			`gate_sources(name = "launcher", root = ${JSON.stringify(root)}, tools = ${JSON.stringify({ [process.platform === "win32" ? "bun.exe" : "bun"]: process.execPath })})`,
			`gate_sources(name = "installed", root = ${JSON.stringify(root)}, runner = "", installed_roots = ${JSON.stringify([path.join(root, "node_modules"), ...(commands.some(command => command.label.startsWith("compile/Rust native host ")) ? [path.join(root, "packages/natives/node_modules")] : [])])}, tools = ${JSON.stringify(tools)})`,
			...(rustCommands.length
				? [
						`gate_sources(name = "rust_inputs", root = ${JSON.stringify(root)}, runner = "", rust_inputs = True, rust_environment = ${JSON.stringify(rustInputsEnvironment)}, rust_inventory_bun = ${JSON.stringify(process.execPath)}, rust_inventory_runner = ${JSON.stringify(path.join(import.meta.dir, "test-gate-bazel-rust-inventory.ts"))})`,
					]
				: []),
			"",
		].join("\n"),
	);
	await writeIfChanged(path.join(workspace, ".bazelversion"), "9.2.0\n");
	// Fixed private RC path: native normal options update the existing server;
	// do not change its JVM/startup identity or duplicate these in command argv.
	await writeIfChanged(
		path.join(workspace, ".bazelrc"),
		[
			"# Isolate native gates from system/home/root workspace configuration.",
			// Short-lived isolated fixture servers may use native idle expiry.
			...(serverIdleSeconds === undefined ? [] : [`startup --max_idle_secs=${serverIdleSeconds}`]),
			"common --enable_platform_specific_config",
			"common --watchfs",
			"common --cache_computed_file_digests=500000",
			"common:windows --experimental_windows_watchfs",
			"",
		].join("\n"),
	);
	// Only runtime evidence and the independently queried graph workspace are
	// excluded. Real inputs live in external repositories, not these directories.
	await writeIfChanged(path.join(workspace, ".bazelignore"), "runs\ngraph-workspace\ngraph-workspace-output\n");
	const targets = new Map<string, string>();
	const targetNames = new Set<string>();
	const runTargets = new Set<string>();
	const uncachedTargets = new Set<string>();
	const build = ['load(":gate.bzl", "gate_action", "gate_test", "gate_run")'];
	const specifications: Array<{ filename: string; content: string }> = [];
	// Per-command tool precision: runfiles tools are invalidation inputs, not the
	// execution PATH (payloads resolve the host PATH). Declaring every tool on
	// every target multiplies runfiles trees across the whole test graph. Rust
	// toolchains are invalidated by @rust_inputs, not by these few executables.
	const windows = process.platform === "win32";
	const commandToolNames = (command: GateCommand): string[] => {
		const names = new Set<string>([windows ? "bun.exe" : "bun"]);
		if (shell) names.add(path.basename(shell));
		if (windows) names.add("bash.exe");
		else names.add("bash");
		if (/^(test|smoke)\//.test(command.label)) {
			for (const name of ["git", "node", "python", "python3"]) names.add(windows ? `${name}.exe` : name);
			if (windows) names.add("powershell.exe");
		} else if (command.label === "static/TS lint+format") {
			names.add(windows ? "node.exe" : "node");
			for (const name of Object.keys(tools)) if (/^(?:oxlint|oxfmt)(?:\.exe)?$/.test(name)) names.add(name);
		} else if (/^static\/TS types/.test(command.label)) {
			names.add(windows ? "node.exe" : "node");
			for (const name of Object.keys(tools)) if (/^tsgo(?:\.exe)?$/.test(name)) names.add(name);
		} else if (/Rust/.test(command.label)) {
			for (const name of ["cargo", "rustc"]) names.add(windows ? `${name}.exe` : name);
		}
		return [...names].filter(name => name in tools).sort();
	};
	for (const command of commands) {
		if (command.stdin !== undefined || command.decodeOutput || command.allowFailure || command.wallTimeoutSeconds)
			throw new GateCommandError(
				`Bazel primitive does not support discovery/interactive transport: ${command.label}`,
				1,
			);
		if (
			command.artifactFiles?.some(
				filename =>
					!filename ||
					filename.includes("\\") ||
					filename.includes(":") ||
					filename.split("/").some(part => !part || part === "." || part === ".."),
			) ||
			new Set(command.artifactFiles).size !== (command.artifactFiles?.length ?? 0)
		)
			throw new GateCommandError(`Invalid Bazel artifact paths: ${command.label}`, 1);
		const id = `p_${Bun.hash(command.label).toString(16)}`;
		if (targetNames.has(`//:${id}`)) throw new GateCommandError(`Duplicate Bazel primitive: ${command.label}`, 1);
		targets.set(command.label, `//:${id}`);
		targetNames.add(`//:${id}`);
		const isolated = command.env?.HOME !== undefined;
		const env: Record<string, string | null> = {};
		for (const [key, value] of Object.entries(command.env ?? {})) {
			if (runtimeKeys.test(key) || (isolated && isolatedKeys.test(key))) continue;
			// buildChildEnv returns a complete scrubbed environment. Only values
			// changed from the host are command-specific declaration inputs.
			if (value === process.env[key]) continue;
			env[key] = value ?? null;
		}
		// The client, declared shell tool, and nested payload must agree even
		// when a command inherited an unusable WindowsApps shell.
		if (process.platform === "win32" && shell) env.BAZEL_SH = shell;
		const spec: BazelPrimitiveSpec = {
			label: command.label,
			root,
			workspace,
			argv: [...command.argv],
			cwd: command.cwd ?? root,
			env: { ...env, OMP_GATE_BAZEL_PRIMITIVE: "1" },
			isolated,
			charged: command.kind === "charged",
			artifactFiles: command.artifactFiles,
		};
		specifications.push({ filename: path.join(workspace, `${id}.json`), content: JSON.stringify(spec) });
		const owner = path
			.relative(root, command.cwd ?? root)
			.replaceAll("\\", "/")
			.match(/^packages\/([^/]+)/)?.[1];
		const rustTest = /^test\/Rust/.test(command.label);
		const cacheRust = rustCommands.includes(command);
		const nativeBuild = command.label.startsWith("compile/Rust native host ");
		const test = /^(test|smoke)\//.test(command.label);
		const source = nativeBuild
			? "@sources//:native_build"
			: test
				? `@sources//:command_${Bun.hash(command.label).toString(16)}`
				: rustTest || !owner
					? "@sources//:all"
					: `@sources//:pkg_${owner}`;
		const noCache =
			command.resultReuse === "disabled" ||
			command.label.startsWith("build/") ||
			(/Rust/.test(command.label) && !cacheRust);
		if (noCache) uncachedTargets.add(command.label);
		// Always-run commands read the real workspace, not their runfiles.
		// Cache only the launcher closure: declaring command inputs here would
		// analyze the whole source/installed graph without guarding execution.
		// Cached actions/tests must retain their complete semantic input graph.
		const alwaysRun = noCache && !test;
		if (command.artifactFiles?.length && (alwaysRun || test))
			throw new GateCommandError(`Bazel artifacts require a reusable build action: ${command.label}`, 1);
		const runtimeRepository = alwaysRun ? "@launcher" : "@sources";
		const sources = [
			...(!alwaysRun ? [source, ...(!test ? ["@installed//:installed"] : [])] : []),
			`${runtimeRepository}//:scripts/test-gate-events.ts`,
			`${runtimeRepository}//:scripts/test-gate-clock.ts`,
			`${runtimeRepository}//:scripts/test-gate-libc.ts`,
			...(cacheRust ? ["@rust_inputs//:rust_inputs"] : []),
		];
		const attrs = `name = ${JSON.stringify(id)}, srcs = ${JSON.stringify(sources)}, tools = ${JSON.stringify(alwaysRun ? [] : commandToolNames(command).map(name => `@installed//:tools/${name}`))}, bun = ${JSON.stringify(`${alwaysRun ? "@launcher" : "@installed"}//:tools/${process.platform === "win32" ? "bun.exe" : "bun"}`)}, runner = "${runtimeRepository}//:scripts/test-gate-bazel-runner.ts", spec = ${JSON.stringify(`${id}.json`)}`;
		const tags = ["local", "no-remote", "no-sandbox", ...(noCache ? ["external", "no-cache"] : [])];
		if (noCache && !test) runTargets.add(command.label);
		const executableAttrs = `windows = ${process.platform === "win32" ? "True" : "False"}, bun_path = ${JSON.stringify(process.execPath)}, runner_path = ${JSON.stringify(path.join(root, "scripts/test-gate-bazel-runner.ts"))}, spec_path = ${JSON.stringify(path.join(workspace, `${id}.json`))}, command_args = ${JSON.stringify(command.argv.slice(1))}, command_cwd = ${JSON.stringify(command.cwd ?? root)}, tags = ${JSON.stringify(tags)}`;
		build.push(
			test
				? `gate_test(${attrs}, ${executableAttrs}, timeout = "eternal")`
				: noCache
					? `gate_run(${attrs}, ${executableAttrs})`
					: `gate_action(${attrs}, artifact_files = ${JSON.stringify(command.artifactFiles ?? [])})`,
		);
		console.log(
			`bazel required label=${JSON.stringify(command.label)} target=//:${id}${noCache ? " result_reuse=disabled (external/native side effects)" : ""}`,
		);
	}
	await Promise.all(specifications.map(spec => writeIfChanged(spec.filename, spec.content)));
	await writeIfChanged(path.join(workspace, "BUILD.bazel"), `${build.join("\n")}\n`);
	return { root, workspace, bazel, targets, shell, runTargets, uncachedTargets };
}

function bazelArgs(plan: BazelPlan): string[] {
	// Keep external repositories outside the workspace so Bazel records their
	// native repository labels, rather than workspace-relative output paths.
	// The fixed private RC is the only configuration source; its start-up
	// identity stays stable across gate runs and native Bazel defaults apply.
	return [
		plan.bazel,
		`--output_base=${plan.workspace}-output`,
		"--nosystem_rc",
		"--nohome_rc",
		"--noworkspace_rc",
		`--bazelrc=${path.join(plan.workspace, ".bazelrc")}`,
	];
}

async function reportTargets(
	plan: BazelPlan,
	commands: readonly GateCommand[],
	bep: string,
	execution: string,
): Promise<BazelTargetResult[]> {
	const events = (await Bun.file(bep).text())
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as BazelEvent);
	const namedSets = new Map(
		events.flatMap(event =>
			event.id?.namedSet?.id && event.namedSetOfFiles
				? [[event.id.namedSet.id, event.namedSetOfFiles] as const]
				: [],
		),
	);
	const results: BazelTargetResult[] = [];
	for (const command of commands) {
		const target = plan.targets.get(command.label)!;
		const completion = events.find(event => event.id?.targetCompleted?.label === target);
		const summary = events.find(event => event.id?.testSummary?.label === target)?.testSummary;
		const test = /^(test|smoke)\//.test(command.label);
		const successful = completion?.completed?.success === true && (!test || summary?.overallStatus === "PASSED");
		const outputName = `${target.slice(3)}.success.json`;
		const executed = events.some(event => event.id?.actionCompleted?.primaryOutput?.endsWith(outputName));
		const status =
			!completion || (test && !summary)
				? "incomplete"
				: !successful
					? "failed"
					: !plan.runTargets.has(command.label) && (test ? (summary?.totalNumCached ?? 0) > 0 : !executed)
						? "cached"
						: "new";
		const result: BazelTargetResult = {
			label: command.label,
			target,
			status,
			configuration: completion?.id?.targetCompleted?.configuration?.id,
			buildEventFile: bep,
			executionLogFile: execution,
		};
		if (successful && command.artifactFiles?.length) {
			const files: BazelOutputFile[] = [];
			const visited = new Set<string>();
			const collect = (id: string): void => {
				if (visited.has(id)) return;
				visited.add(id);
				const named = namedSets.get(id);
				if (!named) throw new GateCommandError(`Missing Bazel artifact named set: ${target} ${id}`, 1);
				files.push(...(named.files ?? []));
				for (const child of named.fileSets ?? []) if (child.id) collect(child.id);
			};
			for (const group of completion?.completed?.outputGroup ?? []) {
				files.push(...(group.inlineFiles ?? []));
				for (const set of group.fileSets ?? []) if (set.id) collect(set.id);
			}
			result.artifacts = {};
			for (const filename of command.artifactFiles) {
				const suffix = `${target.slice(3)}.artifacts/${filename}`;
				const candidates = new Set(
					files.flatMap(file => {
						const name = [...(file.pathPrefix ?? []), file.name ?? ""].join("/").replaceAll("\\", "/");
						if (name !== suffix && !name.endsWith(`/${suffix}`)) return [];
						if (!file.uri?.startsWith("file:")) return [];
						return [fileURLToPath(file.uri)];
					}),
				);
				if (candidates.size !== 1)
					throw new GateCommandError(`Missing or ambiguous Bazel artifact: ${target} ${filename}`, 1);
				const artifact = [...candidates][0]!;
				const stat = await fs.stat(artifact);
				if (!path.isAbsolute(artifact) || !stat.isFile() || stat.size === 0)
					throw new GateCommandError(`Missing real Bazel artifact: ${target} ${filename}`, 1);
				result.artifacts[filename] = artifact;
			}
		}
		results.push(result);
		console.log(`bazel evidence ${JSON.stringify(result)}`);
		if (test && successful && summary?.passed?.[0]?.uri) {
			// Bazel owns the original artifacts; record references, never maintain
			// another artifact cache or copy cached cases into current execution.
			const log = fileURLToPath(summary.passed[0].uri);
			console.log(
				`bazel test artifacts target=${target} reuse=${status} directory=${JSON.stringify(path.dirname(log))}`,
			);
		}
	}
	await Bun.write(path.join(path.dirname(bep), "targets.json"), JSON.stringify(results, null, 2));
	if (results.some(result => result.status === "incomplete" || result.status === "failed"))
		throw new GateCommandError("Required Bazel results are missing or unsuccessful", 1);
	return results;
}

export async function runBazelCommands(
	gate: GateRun,
	commands: readonly GateCommand[],
	options: { root?: string; concurrency?: number; serverIdleSeconds?: number } = {},
): Promise<BazelTargetResult[]> {
	if (commands.length === 0) return [];
	const root = path.resolve(options.root ?? repository);
	const lease = await gate.charged(() => acquireWorkspaceLease(gate, root, commands));
	try {
		const plan = await gate.charged(() => declareTargets(gate, commands, root, options.serverIdleSeconds));
		const reports: BazelTargetResult[] = [];
		const requests: Array<{
			argv: string[];
			charged: boolean;
			priority: number;
			reason: string;
			bep: string;
			script?: string;
			targets: Array<{ label: string; test: boolean }>;
		}> = [];
		const evidence: Array<{ pending: GateCommand[]; bep: string; execution: string }> = [];
		const hostJobs = Math.max(4, Math.min(16, Math.floor(os.availableParallelism() / 2)));
		const isTestBatch = (pending: readonly GateCommand[]): boolean =>
			!plan.runTargets.has(pending[0]!.label) && pending.some(command => /^(test|smoke)\//.test(command.label));
		const argumentsFor = (pending: readonly GateCommand[], bep: string, execution: string): string[] => [
			...bazelArgs(plan),
			plan.runTargets.has(pending[0]!.label) ? "run" : isTestBatch(pending) ? "test" : "build",
			...(plan.runTargets.has(pending[0]!.label)
				? [`--script_path=${bep}.run.${process.platform === "win32" ? "cmd" : "sh"}`]
				: []),
			...pending.map(command => plan.targets.get(command.label)!),
			"--lockfile_mode=update",
			"--incompatible_autoload_externally=",
			"--spawn_strategy=local",
			"--test_strategy=standalone",
			"--nokeep_going",
			"--notest_keep_going",
			"--test_runner_fail_fast",
			"--test_output=errors",
			"--nozip_undeclared_test_outputs",
			`--test_tmpdir=${path.join(os.tmpdir(), "omp-bazel", Bun.hash(plan.root).toString(16), path.basename(plan.workspace))}`,
			// Keep analysis/cache evaluation wide. Nonzero local_test_jobs bypasses
			// CPU/memory estimates in Bazel 9.2, so enforce the caller's test-tree
			// cap as a native resource alongside the lane's CPU/memory admission.
			// Native local execution spans include resource waits: UI "running"
			// counts are not test-process concurrency. Inspect profile process-wall
			// intervals / Resources acquired, not queued TestRunner actions.
			`--jobs=${isTestBatch(pending) ? hostJobs : (options.concurrency ?? hostJobs)}`,
			...(isTestBatch(pending) ? ["--local_test_jobs=0"] : []),
			...(isTestBatch(pending) && options.concurrency !== undefined
				? [`--local_resources=omp_test_slots=${options.concurrency}`, "--default_test_resources=omp_test_slots=1"]
				: []),
			`--build_event_json_file=${bep}`,
			"--build_event_publish_all_actions",
			`--execution_log_compact_file=${execution}`,
			`--profile=${bep}.profile.gz`,
			`--explain=${bep}.explain.txt`,
			"--verbose_explanations",
			"--noexecution_log_sort",
			"--color=no",
			"--curses=no",
			"--symlink_prefix=/",
			...toolEnvironment
				.filter(key => (key === "BAZEL_SH" ? plan.shell : process.env[key]) !== undefined)
				.map(key => `--action_env=${key}`),
			...toolEnvironment
				.filter(key => (key === "BAZEL_SH" ? plan.shell : process.env[key]) !== undefined)
				.map(key => `--test_env=${key}`),
		];
		// Bazel has no public local engineering-risk priority option. Select risk
		// bands here; native --jobs schedules all independent work within a band.
		// Each extra band costs one full client invocation even fully cached, so
		// dispatch the highest-risk band first and every remaining band together:
		// risk ordering is preserved while the cached steady state stays bounded.
		const bands = [...new Set(commands.map(command => gateCommandRisk(command).priority))].sort((a, b) => b - a);
		const dispatchGroups = bands.length <= 1 ? [bands] : [[bands[0]!], bands.slice(1)];
		for (const group of dispatchGroups) {
			gate.signal.throwIfAborted();
			const band = commands.filter(command => group.includes(gateCommandRisk(command).priority));
			const priority = group[0]!;
			const cached = band.filter(command => !plan.runTargets.has(command.label));
			const batches = [
				...band.filter(command => plan.runTargets.has(command.label)).map(command => [command]),
				...(cached.length ? [cached] : []),
			];
			for (const pending of batches) {
				const directory = path.join(plan.workspace, "runs", randomUUID());
				registerBazelInvocation(gate.runId, path.join(directory, "events.jsonl"));
				await gate.charged(() => fs.mkdir(directory, { recursive: true }));
				const bep = path.join(directory, "events.jsonl");
				const execution = path.join(directory, "execution.compact");
				const risk = gateCommandRisk(pending[0]!);
				requests.push({
					priority,
					reason: risk.reason,
					bep,
					script: plan.runTargets.has(pending[0]!.label)
						? `${bep}.run.${process.platform === "win32" ? "cmd" : "sh"}`
						: undefined,
					charged: pending.every(command => command.kind === "charged"),
					targets: pending.map(command => ({
						label: plan.targets.get(command.label)!,
						test: /^(test|smoke)\//.test(command.label),
					})),
					argv: argumentsFor(pending, bep, execution),
				});
				evidence.push({ pending, bep, execution });
			}
		}
		const requestFile = path.join(plan.workspace, "runs", `${randomUUID()}.batches.json`);
		await gate.charged(() =>
			Bun.write(
				requestFile,
				JSON.stringify({
					batches: requests,
				}),
			),
		);
		await gate.run({
			label: "bazel/risk bands",
			argv: [
				process.execPath,
				path.join(import.meta.dir, "test-gate-bazel-runner.ts"),
				"bazel",
				path.join(plan.workspace, "context.json"),
				requestFile,
			],
			cwd: plan.workspace,
			env: {
				...(plan.shell ? { BAZEL_SH: plan.shell } : {}),
				OMP_GATE_BAZEL_LEASE_FD: lease.fd?.toString(),
				USE_BAZEL_VERSION: "9.2.0",
				BAZELISK_SKIP_WRAPPER: "true",
			},
			persistentBazel: { outputBase: `${plan.workspace}-output` },
		});
		await gate.charged(async () => {
			const nested = (await Bun.file(`${requestFile}.invocation-evidence.json`).json()) as {
				queryProfiles: string[];
				hostedBuildEvents: string[];
			};
			for (const file of new Set([...nested.queryProfiles, ...nested.hostedBuildEvents]))
				registerBazelInvocation(gate.runId, file);
		});
		for (const { pending, bep, execution } of evidence) {
			reports.push(...(await gate.charged(() => reportTargets(plan, pending, bep, execution))));
		}
		return reports;
	} finally {
		lease.release();
	}
}
