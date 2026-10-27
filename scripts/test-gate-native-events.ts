import { dlopen, FFIType, ptr } from "bun:ffi";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { emitEvent, withCompilerActivity } from "./test-gate-events";
import { GateCommandError } from "./test-gate-failure-events";

/** Consume only nextest's captured libtest-json-plus stdout, never raw test output. */
export async function forwardNextestOutput(
	stream: ReadableStream<Uint8Array>,
	writeOutput: (bytes: Uint8Array) => void | Promise<void>,
	onFailure: (error: GateCommandError) => void,
): Promise<void> {
	const decoder = new TextDecoder();
	let pending = "";
	let reported = false;
	const observe = (line: string) => {
		if (reported || !line.startsWith("{")) return;
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		if (typeof event !== "object" || event === null) return;
		const result = event as Record<string, unknown>;
		if (result.type !== "test" || result.event !== "failed" || typeof result.name !== "string") return;
		reported = true;
		// nextest_metadata::NextestExitCode::TEST_RUN_FAILED, not a guessed test-process exit.
		onFailure(new GateCommandError(`Rust test failed: ${result.name}`, 100));
	};
	const reader = stream.getReader();
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			await writeOutput(value);
			pending += decoder.decode(value, { stream: true });
			let start = 0;
			for (;;) {
				const end = pending.indexOf("\n", start);
				if (end === -1) break;
				observe(pending.slice(start, end));
				start = end + 1;
			}
			pending = pending.slice(start);
		}
		observe(pending + decoder.decode());
	} finally {
		reader.releaseLock();
	}
}

let reportedRustAccountingLimitation = false;
let windowsRustLaunchers: Promise<string> | undefined;
// Repository-local identity cannot vary with a child test's HOME/TEMP/TMPDIR.
const rustLauncherDirectory = path.resolve(
	import.meta.dir,
	"..",
	"node_modules",
	".cache",
	"omp-gate-wrappers",
	`${process.platform}-${process.arch}`,
);

/** Bootstrap-safe version of pi-natives' Windows file-lock object-lifetime lease. */
async function acquireWindowsRustLauncherLease(directory: string): Promise<() => void> {
	// Resolve junctions and case before naming the lease for this actual cache.
	const identity = (await fs.realpath(directory)).toLowerCase();
	const name = `Global\\omp-gate-launchers-${createHash("sha256").update(identity).digest("hex")}`;
	const wideName = Buffer.from(`${name}\0`, "utf16le");
	const kernel = dlopen("kernel32.dll", {
		CreateMutexExW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.u32], returns: FFIType.u64 },
		SetLastError: { args: [FFIType.u32], returns: FFIType.void },
		GetLastError: { args: [], returns: FFIType.u32 },
		CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
	});
	try {
		for (;;) {
			kernel.symbols.SetLastError(0);
			// SYNCHRONIZE only; ownership is the object's existence, not a thread-affine mutex wait.
			const handle = kernel.symbols.CreateMutexExW(null, ptr(wideName), 0, 0x00100000);
			const error = kernel.symbols.GetLastError();
			if (!handle) throw new Error(`Cannot acquire Rust gate launcher lease (Windows error ${error})`);
			if (error !== 183) {
				return () => {
					try {
						if (!kernel.symbols.CloseHandle(handle))
							throw new Error(
								`Cannot release Rust gate launcher lease (Windows error ${kernel.symbols.GetLastError()})`,
							);
					} finally {
						kernel.close();
					}
				};
			}
			if (!kernel.symbols.CloseHandle(handle))
				throw new Error(
					`Cannot close Rust gate launcher contender (Windows error ${kernel.symbols.GetLastError()})`,
				);
			await Bun.sleep(50);
		}
	} catch (error) {
		kernel.close();
		throw error;
	}
}

/** Compile once with the installed host rustc, without Cargo or its cache/profile flags. */
function prepareWindowsRustLaunchers(env: Record<string, string>): Promise<string> {
	windowsRustLaunchers ??= (async () => {
		const source = path.join(import.meta.dir, "test-gate-compiler-launcher.rs");
		const content = await fs.readFile(source);
		const compiler = env.RUSTC || "rustc";
		const compilerEnv = { ...process.env, ...env, RUSTUP_AUTO_INSTALL: "0" };
		const versionProcess = Bun.spawn([compiler, "--version"], {
			env: compilerEnv,
			stdout: "pipe",
			stderr: "inherit",
			windowsHide: true,
		});
		const [versionExit, version] = await Promise.all([
			versionProcess.exited,
			new Response(versionProcess.stdout).text(),
		]);
		if (versionExit !== 0)
			throw new GateCommandError("Native Rust gate launcher compiler discovery failed", versionExit);
		const signature = createHash("sha256").update(content).update(version).digest("hex");
		// Compiler/source updates must not change Cargo's wrapper cache identity.
		const directory = rustLauncherDirectory;
		await fs.mkdir(directory, { recursive: true });
		const release = await acquireWindowsRustLauncherLease(directory);
		try {
			const image = path.join(directory, "test-gate-launcher.exe");
			const stamp = path.join(directory, "launcher.sha256");
			let current: string | undefined;
			try {
				current = await fs.readFile(stamp, "utf8");
				await fs.access(image);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				current = undefined;
			}
			// Recheck under the cross-process lease, then hold it through the final stamp.
			// A stamp reread before rename alone still permits two publishers to race.
			const rebuild = current !== signature;
			if (rebuild) {
				const temporary = path.join(directory, `launcher-${randomUUID()}.exe`);
				try {
					const exitCode = await withCompilerActivity(async () => {
						const child = Bun.spawn(
							[
								compiler,
								"--edition=2021",
								"--crate-name",
								"omp_gate_launcher",
								"-C",
								"debuginfo=0",
								"-C",
								"opt-level=s",
								"-o",
								temporary,
								source,
							],
							{ env: compilerEnv, stdin: "inherit", stdout: "inherit", stderr: "inherit", windowsHide: true },
						);
						return await child.exited;
					});
					if (exitCode !== 0) throw new GateCommandError("Native Rust gate launcher compilation failed", exitCode);
					// Real replacement failures (including an older in-use image) still fail.
					await fs.rename(temporary, image);
				} finally {
					await fs.rm(temporary, { force: true });
				}
			}
			await Promise.all(
				["test-gate-rustc", "test-gate-rustdoc", "test-gate-doctest-compile", "test-gate-doctest-run"].map(
					async name => {
						const destination = path.join(directory, `${name}.exe`);
						if (!rebuild) {
							try {
								await fs.link(image, destination);
							} catch (error) {
								if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
							}
							return;
						}
						const temporary = `${destination}.${randomUUID()}.tmp`;
						try {
							await fs.link(image, temporary);
							await fs.rename(temporary, destination);
						} finally {
							await fs.rm(temporary, { force: true });
						}
					},
				),
			);
			if (rebuild) {
				const temporary = `${stamp}.${randomUUID()}.tmp`;
				try {
					await fs.writeFile(temporary, signature);
					await fs.rename(temporary, stamp);
				} finally {
					await fs.rm(temporary, { force: true });
				}
			}
			return directory;
		} finally {
			release();
		}
	})().catch(error => {
		windowsRustLaunchers = undefined;
		throw error;
	});
	return windowsRustLaunchers;
}

/**
 * Preserve Rust cache wrappers and compiler events, but keep mixed Cargo work
 * charged: rustc boundaries cannot prove that unwrapped build scripts, native
 * tools or test executables are idle. Process ownership is not lifecycle tracing.
 */
export async function withRustCompilerEvents<T>(
	env: Record<string, string>,
	work: (env: Record<string, string>) => Promise<T>,
): Promise<T> {
	if (!env.OMP_GATE_EVENT_TOKEN) return work(env);
	if (!reportedRustAccountingLimitation) {
		console.warn(
			"UNVERIFIED_COMPILATION_ACCOUNTING: Cargo build-script/native/test process lifecycles are not observable; mixed Cargo work remains charged",
		);
		reportedRustAccountingLimitation = true;
	}
	const extension = process.platform === "win32" ? ".exe" : ".sh";
	let launchDirectory = import.meta.dir;
	if (process.platform === "win32") {
		// .cmd entries truncate Cargo's long argv at cmd.exe's 8191-character limit.
		launchDirectory = await prepareWindowsRustLaunchers(env);
	} else {
		// Repository-local launchers avoid chmod-ing tracked scripts after a
		// Windows checkout and keep one cache identity across isolated temp dirs.
		launchDirectory = rustLauncherDirectory;
		await fs.mkdir(launchDirectory, { recursive: true });
		await Promise.all(
			[
				{ name: "test-gate-rustc", source: new URL("./test-gate-rustc.sh", import.meta.url) },
				{ name: "test-gate-rustdoc", source: new URL("./test-gate-rustdoc.sh", import.meta.url) },
				{ name: "test-gate-doctest-compile", source: new URL("./test-gate-doctest-compile.sh", import.meta.url) },
				{ name: "test-gate-doctest-run", source: new URL("./test-gate-doctest-run.sh", import.meta.url) },
			].map(async ({ name, source }) => {
				const destination = path.join(launchDirectory, `${name}${extension}`);
				const content = await fs.readFile(source);
				let current: Buffer | undefined;
				try {
					current = await fs.readFile(destination);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
				if (!current?.equals(content)) {
					const temporary = `${destination}.${randomUUID()}.tmp`;
					try {
						await fs.writeFile(temporary, content, { mode: 0o755 });
						await fs.rename(temporary, destination);
					} finally {
						await fs.rm(temporary, { force: true });
					}
				}
				await fs.chmod(destination, 0o755);
			}),
		);
	}
	const wrapper = path.join(launchDirectory, `test-gate-rustc${extension}`);
	const rustdoc = path.join(launchDirectory, `test-gate-rustdoc${extension}`);
	const id = randomUUID();
	emitEvent(env.OMP_GATE_EVENT_TOKEN, id, "charged", env);
	try {
		return await work({
			...env,
			RUSTUP_AUTO_INSTALL: "0",
			OMP_GATE_ORIGINAL_RUSTC_WRAPPER:
				env.RUSTC_WRAPPER === wrapper ? (env.OMP_GATE_ORIGINAL_RUSTC_WRAPPER ?? "") : (env.RUSTC_WRAPPER ?? ""),
			OMP_GATE_ORIGINAL_RUSTDOC:
				env.RUSTDOC === rustdoc ? env.OMP_GATE_ORIGINAL_RUSTDOC || "rustdoc" : env.RUSTDOC || "rustdoc",
			OMP_GATE_BUN_BINARY: process.execPath,
			OMP_GATE_COMPILER_SCRIPT: path.join(import.meta.dir, "test-gate-compiler.ts"),
			OMP_GATE_RUSTDOC_SCRIPT: path.join(import.meta.dir, "test-gate-rustdoc.ts"),
			OMP_GATE_DOCTEST_COMPILER: path.join(launchDirectory, `test-gate-doctest-compile${extension}`),
			OMP_GATE_DOCTEST_RUNNER: path.join(launchDirectory, `test-gate-doctest-run${extension}`),
			RUSTC_WRAPPER: wrapper,
			RUSTDOC: rustdoc,
		});
	} finally {
		emitEvent(env.OMP_GATE_EVENT_TOKEN, id, "idle", env);
	}
}
