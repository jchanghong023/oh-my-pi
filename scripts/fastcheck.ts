#!/usr/bin/env bun
/**
 * Fast local pre-push gate. Serial: TS (changed-only) -> Rust (host-only) -> native host build -> smoke.
 * No UT. See AGENTS.md#Fastcheck.
 */
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $ } from "bun";

const repoRoot = path.join(import.meta.dir, "..");
const BUN = process.execPath;

/**
 * CentOS 7 (glibc 2.17) cannot run the glibc Biome binary (needs 2.28+).
 * The musl static binary works everywhere. Force it via BIOME_BINARY when
 * we detect a Linux host where the glibc binary would fail.
 */
function resolveBiomeEnv(): Record<string, string> {
	if (process.platform !== "linux") return {};
	const muslPath = path.join(repoRoot, "node_modules/@biomejs/cli-linux-x64-musl/biome");
	try {
		if (fs.existsSync(muslPath)) {
			return { BIOME_BINARY: muslPath };
		}
	} catch {}
	return {};
}

function formatLine(index: number, label: string, status: "PASS" | "FAIL" | "SKIP"): string {
	const prefix = `[${index}/4] ${label}`;
	const target = 30;
	const dots = ".".repeat(Math.max(3, target - prefix.length));
	return `${prefix} ${dots} ${status}`;
}

async function runCommand(
	cmd: string[],
	envOverrides: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const baseBiomeEnv = resolveBiomeEnv();
	const env = { ...process.env, ...baseBiomeEnv, ...envOverrides } as Record<string, string>;
	try {
		const home = env.HOME ?? process.env.HOME ?? os.homedir();
		if (home) {
			const cargoBin = path.join(home, ".cargo/bin");
			if (fs.existsSync(cargoBin)) {
				const key = env.PATH !== undefined ? "PATH" : env.Path !== undefined ? "Path" : "PATH";
				const current = (env as Record<string, string>)[key] ?? "";
				if (!current.split(path.delimiter).includes(cargoBin)) {
					(env as Record<string, string>)[key] = current ? `${cargoBin}${path.delimiter}${current}` : cargoBin;
				}
			}
		}
	} catch {}
	try {
		const proc = Bun.spawn(cmd, {
			cwd: repoRoot,
			env,
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout as ReadableStream).text(),
			new Response(proc.stderr as ReadableStream).text(),
			proc.exited,
		]);
		return { exitCode: exitCode ?? 1, stdout, stderr };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { exitCode: 1, stdout: "", stderr: message };
	}
}

// --- Changed TS detection ---

function isTsFile(p: string): boolean {
	return p.endsWith(".ts") || p.endsWith(".tsx");
}

function isExcludedTsPath(p: string): boolean {
	const n = p.replace(/\\/g, "/");
	if (n.includes("node_modules/")) return true;
	if (n.includes("vendor/")) return true;
	if (n.endsWith("test-sessions.ts")) return true;
	if (n.endsWith("agent_pb.ts")) return true;
	if (n.includes("devin-gen/")) return true;
	if (n === "packages/natives/native/index.d.ts") return true;
	if (n === "packages/catalog/src/discovery/cursor-proto.ts") return true;
	if (n === "packages/catalog/src/discovery/devin-proto.ts") return true;
	if (n.startsWith(".worktrees/") || n.startsWith(".wt/")) return true;
	if (n.startsWith(".git/")) return true;
	return false;
}

function parsePorcelain(buffer: Uint8Array): string[] {
	const text = new TextDecoder().decode(buffer);
	const entries = text.split("\0").filter(Boolean);
	const out: string[] = [];
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.length < 4) continue;
		const status = entry.slice(0, 2);
		const p = entry.slice(3);
		if (p) out.push(p);
		if (status.includes("R") || status.includes("C")) {
			const next = entries[i + 1];
			if (next) {
				out.push(next);
				i++;
			}
		}
	}
	return out;
}

async function resolveBaseRef(): Promise<string | null> {
	const candidates = ["origin/main", "origin/master", "main", "master"];
	for (const c of candidates) {
		const r = await $`git rev-parse --verify ${c}`.cwd(repoRoot).quiet().nothrow();
		if (r.exitCode === 0) return c;
	}
	return null;
}

async function getChangedTsFiles(): Promise<string[]> {
	const seen = new Set<string>();
	try {
		const r = await $`git status --porcelain -z`.cwd(repoRoot).quiet().nothrow();
		if (r.exitCode === 0) {
			for (const p of parsePorcelain(r.stdout as Uint8Array)) {
				if (isTsFile(p) && !isExcludedTsPath(p)) seen.add(p);
			}
		}
	} catch {}
	const base = await resolveBaseRef();
	if (base) {
		try {
			const r = await $`git diff --name-only ${base}...HEAD`.cwd(repoRoot).quiet().nothrow();
			if (r.exitCode === 0) {
				for (const line of r.stdout.toString().split("\n")) {
					const p = line.trim();
					if (p && isTsFile(p) && !isExcludedTsPath(p)) seen.add(p);
				}
			}
		} catch {}
	}
	const existing: string[] = [];
	for (const p of seen) {
		const abs = path.join(repoRoot, p);
		try {
			if (fs.existsSync(abs) && fs.statSync(abs).isFile()) existing.push(p);
		} catch {}
	}
	return [...existing].sort();
}

async function runTsChangedCheck(): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const files = await getChangedTsFiles();
	if (files.length === 0) {
		return { exitCode: 0, stdout: "No changed TS files, skipping.", stderr: "" };
	}
	const biomeEnv = resolveBiomeEnv();
	// biome via `bun x biome` respects BIOME_BINARY
	const biomeResult = await runCommand(["bun", "x", "biome", "check", "--no-errors-on-unmatched", ...files], biomeEnv);
	if (biomeResult.exitCode !== 0) return biomeResult;

	const affectedWorkspaces = new Set<string>();
	for (const f of files) {
		const m = f.match(/^packages\/([^/]+)\//);
		if (m) affectedWorkspaces.add(`packages/${m[1]}`);
	}
	if (affectedWorkspaces.size === 0) {
		return { exitCode: 0, stdout: biomeResult.stdout, stderr: biomeResult.stderr };
	}
	let combinedStdout = biomeResult.stdout;
	let combinedStderr = biomeResult.stderr;
	for (const ws of [...affectedWorkspaces].sort()) {
		const tsconfig = path.join(repoRoot, ws, "tsconfig.json");
		if (!fs.existsSync(tsconfig)) continue;
		const r = await runCommand([BUN, "x", "tsgo", "-p", `${ws}/tsconfig.json`, "--noEmit"]);
		combinedStdout += `\n${r.stdout}`;
		combinedStderr += `\n${r.stderr}`;
		if (r.exitCode !== 0) return { exitCode: r.exitCode, stdout: combinedStdout, stderr: combinedStderr };
		try {
			const pkgPath = path.join(repoRoot, ws, "package.json");
			const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
			const checkTypes: string | undefined = pkg.scripts?.["check:types"];
			if (checkTypes && checkTypes.includes("tsgo") && checkTypes.split("tsgo").length > 2) {
				const r2 = await runCommand(["bun", `--cwd=${ws}`, "run", "check:types"]);
				combinedStdout += `\n${r2.stdout}`;
				combinedStderr += `\n${r2.stderr}`;
				if (r2.exitCode !== 0) return { exitCode: r2.exitCode, stdout: combinedStdout, stderr: combinedStderr };
			}
		} catch {}
	}
	return { exitCode: 0, stdout: combinedStdout, stderr: combinedStderr };
}

async function runRustHostCheck(): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	// Only the host package (pi-natives) is compiled for the current machine.
	// This is the crate that produces the .node addon; other crates (pi-voice etc.)
	// are not needed to prove the host can build and load the addon.
	// We keep `cargo fmt` to the host crate as well for speed; fallback to --all if -p not supported.
	const fmtResult = await runCommand(["cargo", "fmt", "-p", "pi-natives", "--", "--check"]);
	if (fmtResult.exitCode !== 0) {
		// Fallback: older cargo fmt without -p support
		if (fmtResult.stderr.includes("unexpected argument") || fmtResult.stderr.includes("unknown")) {
			const fallback = await runCommand(["cargo", "fmt", "--all", "--", "--check"]);
			if (fallback.exitCode !== 0) return fallback;
		} else {
			return fmtResult;
		}
	}
	const clippyResult = await runCommand(["cargo", "clippy", "-p", "pi-natives", "--no-deps", "--", "-D", "warnings"]);
	return clippyResult;
}

async function main(): Promise<void> {
	console.log("OMP FASTCHECK");
	console.log("");

	let tmpDir: string | null = null;

	const tsResult = await runTsChangedCheck();
	if (tsResult.exitCode === 0) {
		const skipped = tsResult.stdout.includes("No changed TS files");
		console.log(formatLine(1, "TypeScript check", skipped ? "SKIP" : "PASS"));
		if (skipped) {
			// Show reason in verbose mode if needed
		}
	} else {
		console.log(formatLine(1, "TypeScript check", "FAIL"));
		const combined = [tsResult.stdout.trimEnd(), tsResult.stderr.trimEnd()].filter(Boolean).join("\n");
		if (combined) {
			console.log("");
			console.log(combined);
		}
		console.log("");
		console.log("FASTCHECK FAILED");
		process.exit(tsResult.exitCode || 1);
	}

	const rustResult = await runRustHostCheck();
	if (rustResult.exitCode === 0) {
		console.log(formatLine(2, "Rust check", "PASS"));
	} else {
		console.log(formatLine(2, "Rust check", "FAIL"));
		const combined = [rustResult.stdout.trimEnd(), rustResult.stderr.trimEnd()].filter(Boolean).join("\n");
		if (combined) {
			console.log("");
			console.log(combined);
		}
		console.log("");
		console.log("FASTCHECK FAILED");
		process.exit(rustResult.exitCode || 1);
	}

	const nativeResult = await runCommand([BUN, "run", "build:native"]);
	if (nativeResult.exitCode === 0) {
		console.log(formatLine(3, "Native host build", "PASS"));
	} else {
		console.log(formatLine(3, "Native host build", "FAIL"));
		const combined = [nativeResult.stdout.trimEnd(), nativeResult.stderr.trimEnd()].filter(Boolean).join("\n");
		if (combined) {
			console.log("");
			console.log(combined);
		}
		console.log("");
		console.log("FASTCHECK FAILED");
		process.exit(nativeResult.exitCode || 1);
	}

	tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "omp-fastcheck-"));
	const smokeResult = await runCommand([BUN, "packages/coding-agent/src/cli.ts", "--smoke-test"], {
		PI_CODING_AGENT_DIR: tmpDir,
	});
	if (smokeResult.exitCode === 0) {
		console.log(formatLine(4, "OMP process smoke", "PASS"));
	} else {
		console.log(formatLine(4, "OMP process smoke", "FAIL"));
		const combined = [smokeResult.stdout.trimEnd(), smokeResult.stderr.trimEnd()].filter(Boolean).join("\n");
		if (combined) {
			console.log("");
			console.log(combined);
		}
		console.log("");
		console.log("FASTCHECK FAILED");
		await fsPromises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
		process.exit(smokeResult.exitCode || 1);
	}

	console.log("");
	console.log("FASTCHECK PASSED");
	await fsPromises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
}

await main();
