#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const distro = "Ubuntu-24.04";
const wslSource = "/root/oh-my-pi";
const windowsName = "omp-windows-x64.exe";
const linuxName = "omp-linux-x64";

async function safeGit(wsl: string, linux: boolean, args: string[]): Promise<string> {
	const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
	delete env.CNB_TOKEN;
	const command = linux
		? [wsl, "-d", distro, "--exec", "env", "GIT_TERMINAL_PROMPT=0", "git", "-C", wslSource, ...args]
		: ["git", ...args];
	const proc = Bun.spawn(command, { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const [out, , code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	if (code !== 0) throw new Error(`${linux ? "WSL" : "Windows"} git ${args[0]} failed (${code}); check branch, upstream, credentials and fast-forward status. Diagnostic output withheld.`);
	return out.trim();
}

async function pullBoth(wsl: string): Promise<string> {
	const ensureClean = async (linux: boolean): Promise<void> => {
		if (await safeGit(wsl, linux, ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"])) throw new Error(`${linux ? "WSL" : "Windows"} working tree has uncommitted changes; commit or preserve them before pulling.`);
	};
	await Promise.all([ensureClean(false), ensureClean(true)]);
	const update = async (linux: boolean): Promise<string> => {
		await safeGit(wsl, linux, ["pull", "--ff-only", "--no-recurse-submodules"]);
		await ensureClean(linux);
		console.log(`${linux ? "WSL" : "Windows"} git pull --ff-only completed.`);
		return safeGit(wsl, linux, ["rev-parse", "HEAD"]);
	};
	const [windows, linux] = await Promise.allSettled([update(false), update(true)]);
	if (windows.status === "rejected") throw windows.reason;
	if (linux.status === "rejected") throw linux.reason;
	if (windows.value !== linux.value) throw new Error("Windows and WSL source commits differ; synchronize them through Git before publishing.");
	return windows.value;
}
async function run(command: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
	const proc = Bun.spawn(command, { cwd, env, stdout: "inherit", stderr: "inherit", stdin: "ignore" });
	const code = await proc.exited;
	if (code !== 0) throw new Error(`${path.basename(command[0]!)} failed (${code})`);
}

function options(): { repo?: string; tag?: string } {
	const result: { repo?: string; tag?: string } = {};
	const args = process.argv.slice(2);
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--help") {
			console.log("Usage: bun run cnb [--repo owner/repository] [--tag tag]\nDefaults to CNB repository jchanghong/bin and existing release tag omp. Requires clean tracking branches on Windows and Ubuntu-24.04 WSL (/root/oh-my-pi) and official @cnbcool/cnb-cli login. Both worktrees are fast-forward pulled and must have the same commit. Builds and uploads only the two binaries, without tests or source archives; matching attachments are always overwritten.");
			process.exit(0);
		}
		if ((arg !== "--repo" && arg !== "--tag") || !args[i + 1] || args[i + 1]!.startsWith("--")) throw new Error(`Invalid argument: ${arg}`);
		const key = arg === "--repo" ? "repo" : "tag";
		if (result[key]) throw new Error(`Duplicate argument: ${arg}`);
		result[key] = args[++i];
	}
	return result;
}

function target(): { repo: string; tag: string } {
	const { repo = "jchanghong/bin", tag = "omp" } = options();
	if (!repo || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)+$/.test(repo) || repo.endsWith(".git")) throw new Error("Invalid CNB repository path.");
	if (!tag || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(tag) || tag.includes("..") || tag.endsWith("/") || tag.includes("//")) throw new Error("Invalid release tag.");
	return { repo, tag };
}

// Invoke the official npm CLI through Node, supplying arguments over stdin. This
// keeps the upload confirmation token out of the OS command line and logs.
async function cnb(args: string[]): Promise<unknown> {
	const wrapper = Bun.which("cnb.cmd") ?? Bun.which("cnb");
	const node = Bun.which("node.exe") ?? Bun.which("node");
	if (!wrapper || !node) throw new Error("Install Node.js and the official @cnbcool/cnb-cli globally, then run cnb login.");
	const entry = path.join(path.dirname(wrapper), "node_modules", "@cnbcool", "cnb-cli", "bin", "cnb.js");
	try { await fs.access(entry); } catch { throw new Error("Cannot locate the official @cnbcool/cnb-cli npm entry next to cnb.cmd."); }
	const bootstrap = "const fs=require('fs');const a=JSON.parse(fs.readFileSync(0,'utf8'));process.argv=[process.execPath,a.entry,...a.args];require(a.entry)";
	const proc = Bun.spawn([node, "-e", bootstrap], { cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	proc.stdin.write(JSON.stringify({ entry, args })); proc.stdin.end();
	const [out, , code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	if (code !== 0) throw new Error(`CNB ${args[1] ?? "command"} failed (${code}); check login, permissions, repository and release. Response withheld to protect credentials.`);
	if (!out.trim()) return null;
	try {
		const response: unknown = JSON.parse(out);
		if (response && typeof response === "object" && "data" in response && "status" in response) {
			const wrapped = response as { status: unknown; data: unknown };
			if (typeof wrapped.status === "number" && (wrapped.status < 200 || wrapped.status >= 300)) throw new Error("CNB API returned an error status.");
			return wrapped.data;
		}
		return response;
	} catch { throw new Error(`CNB ${args[1] ?? "command"} returned an unrecognized response (withheld).`); }
}

type Release = { id: string; tag_name?: string };
async function getRelease(repo: string, tag: string): Promise<Release> {
	const value = await cnb(["releases", "get-release-by-tag", "--repo", repo, "--tag", tag, "--verbose"]);
	if (!value || typeof value !== "object") throw new Error("CNB release not found or response invalid; create the release separately first.");
	const release = value as Release;
	if (typeof release.id !== "string" || !release.id || (release.tag_name && release.tag_name !== tag)) throw new Error("CNB release response lacks a valid ID or tag; refusing to publish.");
	return release;
}

async function upload(repo: string, release: Release, file: string, name: string, size: number): Promise<void> {
	const result = await cnb(["releases", "post-release-asset-upload-url", "--repo", repo, "--release-id", release.id, "--asset-name", name, "--size", String(size), "--overwrite", "--verbose"]);
	if (!result || typeof result !== "object") throw new Error(`CNB upload initialization failed for ${name}.`);
	const { upload_url: uploadUrl, verify_url: verifyUrl } = result as { upload_url?: unknown; verify_url?: unknown };
	if (typeof uploadUrl !== "string" || typeof verifyUrl !== "string") throw new Error(`CNB upload response incomplete for ${name}.`);
	let url: URL, verify: URL;
	try { url = new URL(uploadUrl); verify = new URL(verifyUrl, "https://api.cnb.cool"); } catch { throw new Error("CNB returned invalid upload URLs."); }
	if (url.protocol !== "https:" || verify.protocol !== "https:" || verify.hostname !== "api.cnb.cool") throw new Error("CNB returned unsafe upload URLs.");
	const prefix = `/${repo}/-/releases/${release.id}/asset-upload-confirmation/`;
	if (!verify.pathname.startsWith(prefix)) throw new Error("CNB returned an unexpected confirmation path.");
	const remainder = verify.pathname.slice(prefix.length);
	const split = remainder.indexOf("/");
	if (split <= 0 || split === remainder.length - 1) throw new Error("CNB returned an incomplete confirmation path.");
	const token = decodeURIComponent(remainder.slice(0, split));
	const assetPath = remainder.slice(split + 1).split("/").map(decodeURIComponent).join("/");
	// curl reads its configuration over stdin; signed URLs never appear in argv.
	const escape = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
	const curl = Bun.which("curl.exe");
	if (!curl) throw new Error("curl.exe is required.");
	const proc = Bun.spawn([curl, "--config", "-"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	proc.stdin.write(`silent\nshow-error\nfail\nproto = "=https"\nurl = ${escape(url.href)}\nupload-file = ${escape(file)}\n`); proc.stdin.end();
	const [, , code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).arrayBuffer(), proc.exited]);
	if (code !== 0) throw new Error(`curl upload failed for ${name} (${code}); response withheld.`);
	await cnb(["releases", "post-release-asset-upload-confirmation", "--repo", repo, "--release-id", release.id, "--upload-token", token, "--asset-path", assetPath, "--verbose"]);
	console.log(`Confirmed ${name}`);
}

async function main(): Promise<void> {
	const started = performance.now();
	const { repo, tag } = target();
	if (process.platform !== "win32" || process.arch !== "x64") throw new Error("CNB distribution requires a Windows x64 host.");
	const wsl = Bun.which("wsl.exe");
	if (!wsl) throw new Error("WSL is required.");
	const commit = await pullBoth(wsl);
	const release = await getRelease(repo, tag);
	const temp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cnb-"));
	const cache = path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), "omp-cnb", createHash("sha256").update(root.toLowerCase()).digest("hex").slice(0, 16));
	await fs.mkdir(cache, { recursive: true });
	const lock = path.join(cache, "lock");
	try { await fs.mkdir(lock); } catch { throw new Error("Windows CNB build cache is locked."); }
	const saved: { original: string; backup: string }[] = [];
	try {
		const linuxOut = path.join(temp, "linux-output");
		const cleanEnv = { ...process.env, CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR ?? path.join(root, "target") };
		delete cleanEnv.ZCODE_ARTIFACT_ROOT; delete cleanEnv.CNB_TOKEN;
		const runLinux = async () => {
			const proc = Bun.spawn([wsl, "-d", distro, "--exec", "bash", "-l", `${wslSource}/scripts/cnb-wsl.sh`, linuxOut, wslSource, Bun.version], { stdin: "ignore", stdout: "inherit", stderr: "inherit", env: cleanEnv });
			const code = await proc.exited;
			if (code !== 0) throw new Error(`WSL build failed (${code}).`);
		};
		console.log(`Using existing Windows and WSL worktrees; CNB receives binaries only, never Git pushes.`);
		const win = root;
		for (const relative of ["packages/coding-agent/binaries/omp-windows-x64.exe", "packages/natives/native/pi_natives.win32-x64-baseline.node", "packages/natives/native/pi_natives.win32-x64-modern.node", "packages/stats/src/embedded-client.generated.txt"]) {
			const original = path.join(win, relative);
			try {
				if (!(await fs.lstat(original)).isFile()) throw new Error(`Existing output is not a regular file: ${relative}`);
				const backup = path.join(temp, `saved-${saved.length}`);
				await fs.copyFile(original, backup, constants.COPYFILE_EXCL);
				await fs.unlink(original);
				saved.push({ original, backup });
			} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		}
		const windowsBuild = (async () => {
			const started = performance.now();
			try {
				await run([process.execPath, "install", "--frozen-lockfile"], win, cleanEnv);
				await run([process.execPath, "scripts/bazel-natives.ts", "host", "--dest", "packages/natives/native", "--skip-load-probe"], win, cleanEnv);
				const native = path.join(win, "packages/natives/native");
				const addons = await fs.readdir(native);
				const built = addons.filter(name => /^pi_natives\.win32-x64-(baseline|modern)\.node$/.test(name));
				if (built.length !== 1) throw new Error("Windows native build did not produce exactly one host variant.");
				console.log(`Windows native variant: ${built[0]}`);
				if (built[0]!.includes("-modern.")) console.warn("The Windows executable contains a modern x64 addon and requires a compatible CPU; it is not a baseline build.");
				await run([process.execPath, "run", "ci:release:build-binaries", "--targets", "win32-x64"], win, cleanEnv);
			} finally { console.log(`Windows build elapsed: ${((performance.now() - started) / 1000).toFixed(1)}s`); }
		})();
		const linuxBuild = (async () => {
			const started = performance.now();
			try {
				await runLinux();
			} finally { console.log(`Linux build elapsed: ${((performance.now() - started) / 1000).toFixed(1)}s`); }
		})();
		const outcomes = await Promise.allSettled([windowsBuild, linuxBuild]);
		const failure = outcomes.find((result): result is PromiseRejectedResult => result.status === "rejected");
		if (failure) throw failure.reason;
		const winOut = path.join(win, "packages/coding-agent/binaries", "omp-windows-x64.exe");
		const [winStat, linuxStat] = await Promise.all([fs.stat(winOut), fs.stat(linuxOut)]);
		if (!winStat.isFile() || !linuxStat.isFile() || winStat.size === 0 || linuxStat.size === 0) throw new Error("Build outputs must be non-empty executable files.");
		console.log(`Publishing ${repo} tag ${tag}, source commit ${commit}; overwriting matching binary attachments.`);
		const uploads = await Promise.allSettled([
			upload(repo, release, winOut, windowsName, winStat.size),
			upload(repo, release, linuxOut, linuxName, linuxStat.size),
		]);
		const uploadFailure = uploads.find((result): result is PromiseRejectedResult => result.status === "rejected");
		if (uploadFailure) throw uploadFailure.reason;
		console.log("Both CNB binaries uploaded.");
	} finally {
		console.log(`CNB total elapsed: ${((performance.now() - started) / 1000).toFixed(1)}s`);
		try {
			for (const { original, backup } of saved) {
				await fs.rm(original, { force: true });
				await fs.copyFile(backup, original, constants.COPYFILE_EXCL);
				await fs.unlink(backup);
			}
			await fs.rm(temp, { recursive: true, force: true });
		} finally { await fs.rmdir(lock); }
	}
}

main().catch(error => { console.error(error instanceof Error ? error.message : "CNB distribution failed."); process.exitCode = 1; });
