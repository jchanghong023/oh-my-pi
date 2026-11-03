#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";

const root = path.resolve(import.meta.dir, "..");
const distro = "Ubuntu-24.04";
const wslSource = "/root/oh-my-pi";
const windowsName = "omp-windows-x64.exe";
const linuxName = "omp-linux-x64";

async function captureRaw(command: string[], cwd = root, input?: string, env = process.env): Promise<string> {
	const proc = Bun.spawn(command, { cwd, env, stdin: input === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
	if (input !== undefined) { proc.stdin.write(input); proc.stdin.end(); }
	const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	if (code !== 0) throw new Error(`${path.basename(command[0]!)} failed (${code}): ${err.trim()}`);
	return out;
}

async function capture(command: string[], cwd = root, input?: string, env = process.env): Promise<string> {
	return (await captureRaw(command, cwd, input, env)).trim();
}

async function submodules(dir: string): Promise<string[]> {
	const rows = (await captureRaw(["git", "ls-files", "--stage", "-z"], dir)).split("\0");
	return rows.filter(row => row.startsWith("160000 ")).map(row => row.slice(row.indexOf("\t") + 1)).sort();
}

async function sourceHeads(dir: string): Promise<Record<string, string>> {
	const heads: Record<string, string> = { ".": await capture(["git", "rev-parse", "HEAD"], dir) };
	for (const link of await submodules(dir)) {
		for (const [name, commit] of Object.entries(await sourceHeads(path.join(dir, link)))) {
			heads[name === "." ? link : `${link}/${name}`] = commit;
		}
	}
	return heads;
}

async function sourceManifest(dir: string): Promise<Record<string, string>> {
	const raw = await captureRaw(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], dir);
	const files = [...new Set(raw.split("\0").filter(Boolean))].sort();
	const links = new Set(await submodules(dir));
	const manifest: Record<string, string> = {};
	for (const file of files) {
		const full = path.join(dir, file);
		let stat;
		try { stat = await fs.lstat(full); } catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT" && !links.has(file)) continue;
			throw error;
		}
		if (links.has(file) && stat.isDirectory()) {
			await fs.lstat(path.join(full, ".git"));
			for (const [name, digest] of Object.entries(await sourceManifest(full))) manifest[`${file}/${name}`] = digest;
		} else {
			if (!stat.isFile()) throw new Error(`Unsupported source entry: ${file}`);
			manifest[file] = createHash("sha256").update(await fs.readFile(full)).digest("hex");
		}
	}
	return Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
}

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

async function pullBoth(wsl: string): Promise<void> {
	const inspect = async (linux: boolean) => {
		const branch = await safeGit(wsl, linux, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
		if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)) throw new Error(`${linux ? "WSL" : "Windows"} is not on a supported branch.`);
		const upstream = await safeGit(wsl, linux, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
		if (!upstream.includes("/") || upstream.slice(upstream.indexOf("/") + 1) !== branch) throw new Error(`${linux ? "WSL" : "Windows"} branch does not track the same-named upstream branch.`);
		if (await safeGit(wsl, linux, ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"])) throw new Error(`${linux ? "WSL" : "Windows"} working tree has uncommitted changes; commit or preserve them before pulling.`);
		return branch;
	};
	const windowsBranch = await inspect(false);
	const linuxBranch = await inspect(true);
	if (windowsBranch !== linuxBranch) throw new Error(`Windows branch ${windowsBranch} and WSL branch ${linuxBranch} differ; refusing to pull.`);
	for (const linux of [false, true]) {
		await safeGit(wsl, linux, ["pull", "--ff-only", "--no-recurse-submodules"]);
		console.log(`${linux ? "WSL" : "Windows"} git pull --ff-only completed.`);
	}
	if (await inspect(false) !== windowsBranch || await inspect(true) !== windowsBranch) throw new Error("Branch or worktree changed during pull.");
}
async function run(command: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
	const proc = Bun.spawn(command, { cwd, env, stdout: "inherit", stderr: "inherit", stdin: "ignore" });
	const code = await proc.exited;
	if (code !== 0) throw new Error(`${path.basename(command[0]!)} failed (${code})`);
}

function options(): { repo?: string; tag?: string; overwrite?: boolean } {
	const result: { repo?: string; tag?: string; overwrite?: boolean } = {};
	const args = process.argv.slice(2);
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--help") {
			console.log("Usage: bun run cnb [--repo owner/repository] [--tag tag] [--overwrite]\nRequires clean same-named tracking branches on Windows and Ubuntu-24.04 WSL (/root/oh-my-pi), an existing CNB Release and official @cnbcool/cnb-cli login. Both worktrees are fast-forward pulled; only binaries are uploaded. --overwrite explicitly permits replacing the two named attachments.");
			process.exit(0);
		}
		if (arg === "--overwrite") {
			if (result.overwrite) throw new Error("Duplicate argument: --overwrite");
			result.overwrite = true;
			continue;
		}
		if ((arg !== "--repo" && arg !== "--tag") || !args[i + 1] || args[i + 1]!.startsWith("--")) throw new Error(`Invalid argument: ${arg}`);
		const key = arg === "--repo" ? "repo" : "tag";
		if (result[key]) throw new Error(`Duplicate argument: ${arg}`);
		result[key] = args[++i];
	}
	return result;
}

async function target(): Promise<{ repo: string; tag: string; overwrite: boolean }> {
	const opts = options();
	if (!opts.repo || !opts.tag) {
		if (!process.stdin.isTTY) throw new Error("Specify --repo and --tag, or run interactively.");
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		try {
			opts.repo ||= (await rl.question("CNB repository (owner/repository): ")).trim();
			opts.tag ||= (await rl.question("Existing release tag: ")).trim();
		} finally { rl.close(); }
	}
	if (!opts.repo || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)+$/.test(opts.repo) || opts.repo.endsWith(".git")) throw new Error("Invalid CNB repository path.");
	if (!opts.tag || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(opts.tag) || opts.tag.includes("..") || opts.tag.endsWith("/") || opts.tag.includes("//")) throw new Error("Invalid release tag.");
	return { repo: opts.repo, tag: opts.tag, overwrite: opts.overwrite ?? false };
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

type Release = { id: string; tag_name?: string; assets: { id?: string; name: string; size?: number }[] };
async function getRelease(repo: string, tag: string): Promise<Release> {
	const value = await cnb(["releases", "get-release-by-tag", "--repo", repo, "--tag", tag, "--verbose"]);
	if (!value || typeof value !== "object") throw new Error("CNB release not found or response invalid; create the release separately first.");
	const release = value as Release;
	if (typeof release.id !== "string" || !release.id || !Array.isArray(release.assets) || release.assets.some(a => !a || typeof a.name !== "string") || (release.tag_name && release.tag_name !== tag)) throw new Error("CNB release response lacks a valid ID, tag or attachment list; refusing to publish.");
	return release;
}

function collisions(release: Release): Map<string, string> {
	const existing = release.assets.filter(a => a.name === windowsName || a.name === linuxName);
	const approved = new Map<string, string>();
	for (const asset of existing) {
		if (!asset.id || approved.has(asset.name)) throw new Error("Cannot safely identify existing attachments.");
		approved.set(asset.name, asset.id);
	}
	return approved;
}

async function checkBinary(file: string, platform: "win32" | "linux"): Promise<number> {
	const stat = await fs.lstat(file);
	if (!stat.isFile() || stat.size < 1024 * 1024) throw new Error(`Invalid ${platform} output: not a regular executable or unexpectedly small.`);
	const fd = await fs.open(file, "r");
	try {
		const h = Buffer.alloc(64);
		if ((await fd.read(h, 0, h.length, 0)).bytesRead !== h.length) throw new Error("Truncated executable.");
		if (platform === "linux") {
			if (h.toString("hex", 0, 4) !== "7f454c46" || h[4] !== 2 || h[5] !== 1 || h.readUInt16LE(18) !== 62) throw new Error("Linux output is not x64 ELF.");
		} else {
			const pe = Buffer.alloc(6);
			if (h.toString("ascii", 0, 2) !== "MZ" || (await fd.read(pe, 0, 6, h.readUInt32LE(60))).bytesRead !== 6 || pe.readUInt32LE(0) !== 0x4550 || pe.readUInt16LE(4) !== 0x8664) throw new Error("Windows output is not x64 PE.");
		}
	} finally { await fd.close(); }
	return stat.size;
}

async function upload(repo: string, release: Release, file: string, name: string, size: number, overwrite: boolean): Promise<void> {
	const result = await cnb(["releases", "post-release-asset-upload-url", "--repo", repo, "--release-id", release.id, "--asset-name", name, "--size", String(size), ...(overwrite ? ["--overwrite"] : []), "--verbose"]);
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

const pythonInventory = `def gitlinks(base):
    raw = subprocess.check_output(["git", "-C", base, "ls-files", "--stage", "-z"])
    return sorted(os.fsdecode(row.split(b"\\t", 1)[1]) for row in raw.split(b"\\0") if row.startswith(b"160000 "))
`;

const linuxScript = `set -eu
heads=$(wslpath -u "$1")
out=$(wslpath -u "$2")
repo=$3
mode=$4
cd "$repo"
python3 - "$heads" <<'PY'
import json, os, subprocess, sys
with open(sys.argv[1], encoding="utf-8") as f:
    expected_heads = json.load(f)
${pythonInventory}
def source_heads(base, prefix=""):
    key = prefix[:-1] if prefix else "."
    result = {key: subprocess.check_output(["git", "-C", base, "rev-parse", "HEAD"], text=True).strip()}
    for link in gitlinks(base):
        result.update(source_heads(os.path.join(base, link), prefix + link + "/"))
    return result
if subprocess.check_output(["git", "status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"]):
    raise SystemExit("WSL working tree has uncommitted changes; refusing to build or overwrite them")
if source_heads(".") != expected_heads:
    raise SystemExit("Windows and WSL source or submodule commits differ; synchronize them explicitly before publishing")
PY
[ "$mode" = build ] || exit 0
cache="$HOME/.cache/omp-cnb"
mkdir -p "$cache"
if ! mkdir "$cache/direct-lock" 2>/dev/null; then echo 'CNB WSL worktree is locked' >&2; exit 1; fi
backup=$(mktemp -d "$cache/direct-backup.XXXXXXXX")
cleanup() {
  for name in omp-linux-x64 pi_natives.linux-x64-baseline.node pi_natives.linux-x64-modern.node embedded-client.generated.txt; do
    case "$name" in
      omp-linux-x64) destination="$repo/packages/coding-agent/binaries/$name" ;;
      embedded-client.generated.txt) destination="$repo/packages/stats/src/$name" ;;
      *) destination="$repo/packages/natives/native/$name" ;;
    esac
    if [ -f "$backup/$name" ]; then
      rm -f -- "$destination"
      mv -- "$backup/$name" "$destination"
    fi
  done
  rm -rf -- "$backup/smoke-home"
  rmdir "$backup"
  rmdir "$cache/direct-lock"
}
trap cleanup EXIT
for name in pi_natives.linux-x64-baseline.node pi_natives.linux-x64-modern.node; do
  file="$repo/packages/natives/native/$name"
  if [ -e "$file" ] || [ -L "$file" ]; then
    [ -f "$file" ] && [ ! -L "$file" ] || { echo 'Existing native output is not a regular file' >&2; exit 1; }
    mv -- "$file" "$backup/$name"
  fi
done
unset RUSTFLAGS CARGO_ENCODED_RUSTFLAGS OMP_NATIVE_BUILD_BACKEND CARGO_TARGET_DIR
if [ -d "$HOME/omp-cargo-target" ]; then export CARGO_TARGET_DIR="$HOME/omp-cargo-target"; fi
bun install --frozen-lockfile
bun scripts/bazel-natives.ts linux-x64-baseline linux-x64-modern --dest packages/natives/native
for file in "$repo/packages/coding-agent/binaries/omp-linux-x64" "$repo/packages/stats/src/embedded-client.generated.txt"; do
  if [ -e "$file" ] || [ -L "$file" ]; then
    [ -f "$file" ] && [ ! -L "$file" ] || { echo 'Existing build output is not a regular file' >&2; exit 1; }
    mv -- "$file" "$backup/$(basename "$file")"
  fi
done
bun run ci:release:build-binaries --targets linux-x64
[ -s packages/coding-agent/binaries/omp-linux-x64 ] || exit 1
mkdir "$backup/smoke-home"
version=$(env HOME="$backup/smoke-home" XDG_CONFIG_HOME="$backup/smoke-home/config" XDG_DATA_HOME="$backup/smoke-home/data" XDG_CACHE_HOME="$backup/smoke-home/cache" OMP_CONFIG_ROOT="$backup/smoke-home/omp" OMP_CACHE_DIR="$backup/smoke-home/omp-cache" OMP_PROFILE= PI_PROFILE= PI_CONFIG_DIR= "$repo/packages/coding-agent/binaries/omp-linux-x64" --version)
case "$version" in omp/*) ;; *) echo 'Linux binary --version returned an unexpected result' >&2; exit 1;; esac
echo "Linux --version: $version"
smoke=$(env HOME="$backup/smoke-home" XDG_CONFIG_HOME="$backup/smoke-home/config" XDG_DATA_HOME="$backup/smoke-home/data" XDG_CACHE_HOME="$backup/smoke-home/cache" OMP_CONFIG_ROOT="$backup/smoke-home/omp" OMP_CACHE_DIR="$backup/smoke-home/omp-cache" OMP_PROFILE= PI_PROFILE= PI_CONFIG_DIR= "$repo/packages/coding-agent/binaries/omp-linux-x64" --smoke-test)
case "$smoke" in *'smoke-test: ok'*) ;; *) echo 'Linux binary smoke test did not report success' >&2; exit 1;; esac
echo 'Linux smoke-test: ok'
cp packages/coding-agent/binaries/omp-linux-x64 "$out"
`;

async function main(): Promise<void> {
	const started = performance.now();
	const { repo, tag, overwrite } = await target();
	if (process.platform !== "win32" || process.arch !== "x64") throw new Error("CNB distribution requires a Windows x64 host.");
	const wsl = Bun.which("wsl.exe");
	if (!wsl) throw new Error("WSL is required.");
	const listProc = Bun.spawn([wsl, "--list", "--verbose"], { stdout: "pipe", stderr: "pipe" });
	const [listBytes, , listCode] = await Promise.all([new Response(listProc.stdout).arrayBuffer(), new Response(listProc.stderr).arrayBuffer(), listProc.exited]);
	const list = new TextDecoder("utf-16le").decode(listBytes).replaceAll("\0", "");
	if (listCode !== 0 || !list.split(/\r?\n/).some(line => new RegExp(`(?:^|\\s)${distro}\\s+\\S+\\s+2\\s*$`).test(line))) throw new Error(`WSL2 ${distro} is required.`);
	await pullBoth(wsl);
	const release = await getRelease(repo, tag);
	const approved = collisions(release);
	if (approved.size && !overwrite && !process.stdin.isTTY) throw new Error(`Release already contains ${[...approved.keys()].join(", ")}; interactive confirmation or --overwrite is required.`);
	if (approved.size) console.log(`Existing attachments in ${repo} tag ${tag}: ${[...approved.keys()].join(", ")}`);
	const commit = await capture(["git", "rev-parse", "HEAD"]);
	if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Invalid Git HEAD.");
	const temp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cnb-"));
	const cache = path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), "omp-cnb", createHash("sha256").update(root.toLowerCase()).digest("hex").slice(0, 16));
	await fs.mkdir(cache, { recursive: true });
	const lock = path.join(cache, "lock");
	try { await fs.mkdir(lock); } catch { throw new Error("Windows CNB build cache is locked."); }
	const saved: { original: string; backup: string }[] = [];
	try {
		const snapshot = await sourceManifest(root);
		const heads = await sourceHeads(root);
		if (heads["."] !== commit) throw new Error("Windows source commit changed during capture.");
		const manifestText = JSON.stringify(snapshot);
		const identity = createHash("sha256").update(JSON.stringify(heads)).update(manifestText).digest("hex");
		const headsFile = path.join(temp, "heads.json");
		const linuxOut = path.join(temp, "linux-output");
		await fs.writeFile(headsFile, JSON.stringify(heads));
		const cleanEnv = { ...process.env, CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR ?? path.join(root, "target") };
		delete cleanEnv.ZCODE_ARTIFACT_ROOT; delete cleanEnv.CNB_TOKEN;
		const runLinux = async (mode: "preflight" | "build") => {
			const proc = Bun.spawn([wsl, "-d", distro, "--exec", "bash", "-l", "-s", "--", headsFile, linuxOut, wslSource, mode], { stdin: "pipe", stdout: "inherit", stderr: "inherit", env: cleanEnv });
			proc.stdin.write(linuxScript); proc.stdin.end();
			const code = await proc.exited;
			if (code !== 0) throw new Error(`WSL ${mode} failed (${code}); existing worktree was not synchronized.`);
		};
		console.log(`Using existing Windows and WSL worktrees; CNB receives binaries only, never Git pushes.`);
		await runLinux("preflight");
		if (JSON.stringify(await sourceManifest(root)) !== manifestText || JSON.stringify(await sourceHeads(root)) !== JSON.stringify(heads)) throw new Error("Windows source changed during preflight.");
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
				await run([process.execPath, "run", "build:native"], win, cleanEnv);
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
				await runLinux("build");
			} finally { console.log(`Linux build elapsed: ${((performance.now() - started) / 1000).toFixed(1)}s`); }
		})();
		const outcomes = await Promise.allSettled([windowsBuild, linuxBuild]);
		const failure = outcomes.find((result): result is PromiseRejectedResult => result.status === "rejected");
		if (failure) throw failure.reason;
		const statsPath = path.join(root, "packages/stats/src/embedded-client.generated.txt");
		const statsIndex = saved.findIndex(item => item.original === statsPath);
		if (statsIndex >= 0) {
			const item = saved[statsIndex]!;
			await fs.rm(item.original, { force: true });
			await fs.copyFile(item.backup, item.original, constants.COPYFILE_EXCL);
			await fs.unlink(item.backup);
			saved.splice(statsIndex, 1);
		}
		if (JSON.stringify(await sourceManifest(root)) !== manifestText || JSON.stringify(await sourceHeads(root)) !== JSON.stringify(heads)) throw new Error("Windows source changed during builds; refusing to publish.");
		await runLinux("preflight");
		const winOut = path.join(win, "packages/coding-agent/binaries", "omp-windows-x64.exe");
		const [winSize, linuxSize] = await Promise.all([checkBinary(winOut, "win32"), checkBinary(linuxOut, "linux")]);
		const smokeRoot = path.join(temp, "windows-smoke");
		await fs.mkdir(smokeRoot);
		const smokeEnv = { ...cleanEnv, HOME: smokeRoot, USERPROFILE: smokeRoot, LOCALAPPDATA: path.join(smokeRoot, "local"), APPDATA: path.join(smokeRoot, "roaming"), XDG_DATA_HOME: path.join(smokeRoot, "data"), XDG_CACHE_HOME: path.join(smokeRoot, "cache"), OMP_CONFIG_ROOT: path.join(smokeRoot, "config"), OMP_CACHE_DIR: path.join(smokeRoot, "omp-cache"), OMP_PROFILE: "", PI_PROFILE: "", PI_CONFIG_DIR: "" };
		const version = await capture([winOut, "--version"], root, undefined, smokeEnv);
		if (!/^omp\/\S+/m.test(version)) throw new Error("Windows binary --version returned an unexpected result.");
		console.log(`Windows --version: ${version}`);
		const smoke = await capture([winOut, "--smoke-test"], root, undefined, smokeEnv);
		if (!smoke.includes("smoke-test: ok")) throw new Error("Windows binary smoke test did not report success.");
		console.log("Windows smoke-test: ok");
		const current = await getRelease(repo, tag);
		if (current.id !== release.id) throw new Error("Release changed during build; refusing to publish.");
		const latest = collisions(current);
		if (latest.size !== approved.size || [...latest].some(([name, id]) => approved.get(name) !== id)) throw new Error("Release attachments changed during build; refusing to overwrite.");
		if (approved.size && !overwrite) {
			const rl = createInterface({ input: process.stdin, output: process.stdout });
			let answer: string;
			try {
				answer = await rl.question(`Overwrite ${[...approved.keys()].join(", ")} in CNB ${repo} release ${tag}? Type yes to confirm: `);
			} finally { rl.close(); }
			if (answer.trim().toLowerCase() !== "yes") throw new Error("Attachment overwrite was not confirmed.");
			const afterConfirmation = await getRelease(repo, tag);
			const afterAssets = collisions(afterConfirmation);
			if (afterConfirmation.id !== current.id || afterAssets.size !== approved.size || [...afterAssets].some(([name, id]) => approved.get(name) !== id)) {
				throw new Error("Release attachments changed during confirmation; refusing to overwrite.");
			}
		}
		console.log(`Publishing ${repo} tag ${tag}, source commit ${commit}, snapshot ${identity}`);
		await upload(repo, current, winOut, windowsName, winSize, approved.has(windowsName));
		await upload(repo, current, linuxOut, linuxName, linuxSize, approved.has(linuxName));
		const confirmed = await getRelease(repo, tag);
		for (const [name, size] of [[windowsName, winSize], [linuxName, linuxSize]] as const) {
			if (!confirmed.assets.some(asset => asset.name === name && asset.size === size)) throw new Error(`CNB did not report the expected confirmed attachment ${name}.`);
		}
		console.log("Both CNB attachments verified by name and size.");
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
