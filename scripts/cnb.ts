#!/usr/bin/env bun
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	assetNames,
	type AssetName,
	linuxBinary,
	linuxSdk,
	type Source,
	windowsBinary,
	windowsSdk,
} from "./cnb-build";
import { publicationTitle, releaseVersionFrom } from "./cnb-version";

const root = path.resolve(import.meta.dir, "..");
const distro = "Ubuntu-24.04";
const wslSource = "/root/oh-my-pi";

type Host = "Windows" | "Linux";
type BunIdentity = { version: string; revision: string };

function withoutToken(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env.CNB_TOKEN;
	return env;
}

function wslCommand(wsl: string, ...args: string[]): string[] {
	return [wsl, "-d", distro, "--exec", ...args];
}

async function safeGit(wsl: string | undefined, host: Host, args: string[]): Promise<string> {
	const env = { ...withoutToken(), GIT_TERMINAL_PROMPT: "0" };
	const git = ["git", "-c", "core.hooksPath=/dev/null"];
	const command = host === "Linux"
		? wslCommand(wsl!, "env", "-u", "CNB_TOKEN", "GIT_TERMINAL_PROMPT=0", ...git, "-C", wslSource, ...args)
		: [...git, ...args];
	const proc = Bun.spawn(command, { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const [out, , code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0)
		throw new Error(
			`${host} git ${args[0]} failed (${code}); check branch, upstream, credentials and fast-forward status. Diagnostic output withheld.`,
		);
	return out.trim();
}

async function pullHost(wsl: string | undefined, host: Host): Promise<Source> {
	const git = (...args: string[]) => safeGit(wsl, host, args);
	const status = () => git("status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none");
	if (await status())
		throw new Error(`${host} working tree or OpenWiki submodule is dirty; preserve local changes before publishing.`);
	await git("pull", "--ff-only", "--no-recurse-submodules");
	await git("submodule", "update", "--init", "--checkout", "--", "vendor/openwiki");
	if (await status()) throw new Error(`${host} source or OpenWiki submodule is not clean after Git synchronization.`);
	const [commit, openwiki] = (await git("rev-parse", "HEAD", "HEAD:vendor/openwiki")).split(/\r?\n/);
	if (!commit || !openwiki) throw new Error(`${host} Git source identity is incomplete.`);
	console.log(`${host} git pull --ff-only completed.`);
	return { commit, openwiki };
}

async function linuxBun(wsl: string): Promise<BunIdentity> {
	const proc = Bun.spawn(wslCommand(wsl, "bash", "-l", `${wslSource}/scripts/cnb-wsl.sh`, "--bun-identity"), {
		env: withoutToken(), stdin: "ignore", stdout: "pipe", stderr: "inherit",
	});
	const [output, code] = await Promise.all([proc.stdout.text(), proc.exited]);
	if (code !== 0) throw new Error(`WSL Bun identity probe failed (${code}).`);
	const { version, revision } = JSON.parse(output) as BunIdentity;
	if (typeof version !== "string" || !version || typeof revision !== "string" || !revision)
		throw new Error("WSL Bun version or revision is missing.");
	return { version, revision };
}
async function run(command: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
	const proc = Bun.spawn(command, { cwd, env, stdout: "inherit", stderr: "inherit", stdin: "ignore" });
	const code = await proc.exited;
	if (code !== 0) throw new Error(`${path.basename(command[0]!)} failed (${code})`);
}

async function timed<T>(label: string, action: () => Promise<T>): Promise<T> {
	const started = performance.now();
	try {
		return await action();
	} finally {
		console.log(`${label} elapsed: ${((performance.now() - started) / 1000).toFixed(1)}s`);
	}
}

function target(): { repo: string; tag: string; assets: AssetName[] } {
	let repo: string | undefined;
	let tag: string | undefined;
	const assets = new Set<AssetName>();
	const args = process.argv.slice(2);
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--help") {
			console.log(
				`Usage: bun run cnb [--repo owner/repository] [--tag tag] [--asset exact-name]...\n` +
				`Defaults: jchanghong/bin, existing tag omp, and these four assets:\n  ${assetNames.join("\n  ")}\n` +
				"Only selected hosts are synchronized and built. Linux builds in Ubuntu-24.04 WSL (/root/oh-my-pi). " +
				"Selecting both hosts requires identical Git and Bun identities. Only selected attachments are overwritten. " +
				"Changing a shared rolling version requires both existing platform binaries to remain compatible.",
			);
			process.exit(0);
		}
		const value = args[++i];
		if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}.`);
		switch (arg) {
			case "--repo":
				if (repo !== undefined) throw new Error(`Duplicate argument: ${arg}`);
				repo = value;
				break;
			case "--tag":
				if (tag !== undefined) throw new Error(`Duplicate argument: ${arg}`);
				tag = value;
				break;
			case "--asset": {
				const asset = assetNames.find(name => name === value);
				if (!asset) throw new Error(`Unsupported CNB asset: ${value}`);
				assets.add(asset);
				break;
			}
			default:
				throw new Error(`Invalid argument: ${arg}`);
		}
	}
	repo ??= "jchanghong/bin";
	tag ??= "omp";
	if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)+$/.test(repo) || repo.endsWith(".git"))
		throw new Error("Invalid CNB repository path.");
	if (
		!/^[A-Za-z0-9][A-Za-z0-9._+/-]*$/.test(tag) ||
		tag.includes("..") ||
		tag.endsWith("/") ||
		tag.includes("//")
	)
		throw new Error("Invalid release tag.");
	return { repo, tag, assets: assets.size ? [...assets] : [...assetNames] };
}

// Invoke the official npm CLI through Node, supplying arguments over stdin. This
// keeps the upload confirmation token out of the OS command line and logs.
async function cnb(args: string[]): Promise<unknown> {
	const wrapper = Bun.which("cnb.cmd") ?? Bun.which("cnb");
	const node = Bun.which("node.exe") ?? Bun.which("node");
	if (!wrapper || !node)
		throw new Error("Install Node.js and the official @cnbcool/cnb-cli globally, then run cnb login.");
	const entry = path.join(path.dirname(wrapper), "node_modules", "@cnbcool", "cnb-cli", "bin", "cnb.js");
	try {
		await fs.access(entry);
	} catch {
		throw new Error("Cannot locate the official @cnbcool/cnb-cli npm entry next to cnb.cmd.");
	}
	const bootstrap =
		"const fs=require('fs');const a=JSON.parse(fs.readFileSync(0,'utf8'));process.argv=[process.execPath,a.entry,...a.args];require(a.entry)";
	const proc = Bun.spawn([node, "-e", bootstrap], { cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	proc.stdin.write(JSON.stringify({ entry, args }));
	proc.stdin.end();
	const [out, , code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0)
		throw new Error(
			`CNB ${args[1] ?? "command"} failed (${code}); check login, permissions, repository and release. Response withheld to protect credentials.`,
		);
	if (!out.trim()) return null;
	try {
		const response: unknown = JSON.parse(out);
		if (response && typeof response === "object" && "data" in response && "status" in response) {
			const wrapped = response as { status: unknown; data: unknown };
			if (typeof wrapped.status === "number" && (wrapped.status < 200 || wrapped.status >= 300))
				throw new Error("CNB API returned an error status.");
			return wrapped.data;
		}
		return response;
	} catch {
		throw new Error(`CNB ${args[1] ?? "command"} returned an unrecognized response (withheld).`);
	}
}

type Release = { id: string; name: string; tag_name?: string; assets?: unknown };
async function getRelease(repo: string, tag: string): Promise<Release> {
	const value = await cnb(["releases", "get-release-by-tag", "--repo", repo, "--tag", tag, "--verbose"]);
	if (!value || typeof value !== "object")
		throw new Error("CNB release not found or response invalid; create the release separately first.");
	const release = value as Release;
	if (
		typeof release.id !== "string" ||
		!release.id ||
		typeof release.name !== "string" ||
		(release.tag_name && release.tag_name !== tag)
	)
		throw new Error("CNB release response lacks a valid ID, title or tag; refusing to publish.");
	return release;
}

async function upload(repo: string, release: Release, file: string, name: string, size: number): Promise<void> {
	const started = performance.now();
	const result = await cnb([
		"releases",
		"post-release-asset-upload-url",
		"--repo",
		repo,
		"--release-id",
		release.id,
		"--asset-name",
		name,
		"--size",
		String(size),
		"--overwrite",
		"--verbose",
	]);
	if (!result || typeof result !== "object") throw new Error(`CNB upload initialization failed for ${name}.`);
	const { upload_url: uploadUrl, verify_url: verifyUrl } = result as { upload_url?: unknown; verify_url?: unknown };
	if (typeof uploadUrl !== "string" || typeof verifyUrl !== "string")
		throw new Error(`CNB upload response incomplete for ${name}.`);
	let url: URL, verify: URL;
	try {
		url = new URL(uploadUrl);
		verify = new URL(verifyUrl, "https://api.cnb.cool");
	} catch {
		throw new Error("CNB returned invalid upload URLs.");
	}
	if (url.protocol !== "https:" || verify.protocol !== "https:" || verify.hostname !== "api.cnb.cool")
		throw new Error("CNB returned unsafe upload URLs.");
	const prefix = `/${repo}/-/releases/${release.id}/asset-upload-confirmation/`;
	if (!verify.pathname.startsWith(prefix)) throw new Error("CNB returned an unexpected confirmation path.");
	const remainder = verify.pathname.slice(prefix.length);
	const split = remainder.indexOf("/");
	if (split <= 0 || split === remainder.length - 1) throw new Error("CNB returned an incomplete confirmation path.");
	const token = decodeURIComponent(remainder.slice(0, split));
	const assetPath = remainder
		.slice(split + 1)
		.split("/")
		.map(decodeURIComponent)
		.join("/");
	// curl reads its configuration over stdin; signed URLs never appear in argv.
	const escape = (value: string) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
	const curl = Bun.which("curl.exe");
	if (!curl) throw new Error("curl.exe is required.");
	const proc = Bun.spawn([curl, "--config", "-"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	proc.stdin.write(
		`silent\nshow-error\nfail\nproto = "=https"\nurl = ${escape(url.href)}\nupload-file = ${escape(file)}\n`,
	);
	proc.stdin.end();
	const [, , code] = await Promise.all([
		new Response(proc.stdout).arrayBuffer(),
		new Response(proc.stderr).arrayBuffer(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`curl upload failed for ${name} (${code}); response withheld.`);
	await cnb([
		"releases",
		"post-release-asset-upload-confirmation",
		"--repo",
		repo,
		"--release-id",
		release.id,
		"--upload-token",
		token,
		"--asset-path",
		assetPath,
		"--verbose",
	]);
	console.log(`Confirmed ${name}; upload elapsed: ${((performance.now() - started) / 1000).toFixed(1)}s`);
}

async function main(): Promise<void> {
	const started = performance.now();
	const { repo, tag, assets } = target();
	if (process.platform !== "win32" || process.arch !== "x64")
		throw new Error("CNB distribution requires a Windows x64 coordinator.");
	const windowsAssets = assets.filter(name => name === windowsBinary || name === windowsSdk);
	const linuxAssets = assets.filter(name => name === linuxBinary || name === linuxSdk);
	const wsl = linuxAssets.length ? Bun.which("wsl.exe") : undefined;
	if (linuxAssets.length && !wsl) throw new Error("WSL is required for the Linux assets.");
	const cache = path.join(
		process.env.LOCALAPPDATA ?? os.tmpdir(),
		"omp-cnb",
		createHash("sha256").update(root.toLowerCase()).digest("hex").slice(0, 16),
	);
	await fs.mkdir(cache, { recursive: true });
	const lock = path.join(cache, "lock");
	try {
		await fs.mkdir(lock);
	} catch {
		throw new Error("CNB publication is already running for this worktree.");
	}
	let temp: string | undefined;
	try {
		const [windows, linux] = await timed("Git synchronization", () => Promise.allSettled([
			windowsAssets.length ? pullHost(wsl, "Windows") : undefined,
			wsl ? pullHost(wsl, "Linux") : undefined,
		]));
		if (windows.status === "rejected") throw windows.reason;
		if (linux.status === "rejected") throw linux.reason;
		const source = (windows.value ?? linux.value)!;
		const remoteBun = windows.value && wsl ? await linuxBun(wsl) : undefined;
		if (windows.value && linux.value) {
			if (windows.value.commit !== linux.value.commit || windows.value.openwiki !== linux.value.openwiki)
				throw new Error("Windows and WSL Git identities differ; synchronize them through Git before publishing.");
			if (Bun.version !== remoteBun!.version || Bun.revision !== remoteBun!.revision)
				throw new Error("Windows and WSL Bun version and revision must match before building both hosts.");
		}
		const packageVersion = async () => JSON.parse(await safeGit(wsl, windows.value ? "Windows" : "Linux", [
			"show", `${source.commit}:packages/utils/package.json`,
		])).version as unknown;
		const releaseVersion = releaseVersionFrom(process.env.RELEASE_VERSION || await packageVersion());
		const updateRepository = `${repo}@${tag}`;
		const release = await getRelease(repo, tag);
		const nextTitle = publicationTitle(release, tag, releaseVersion, assets);
		temp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cnb-"));
		const stage = temp;
		const builds: Promise<void>[] = [];
		if (windows.value) {
			builds.push(run([
				process.execPath, "scripts/cnb-build.ts", cache, stage, source.commit, source.openwiki, Bun.version,
				Bun.revision, releaseVersion, updateRepository, ...windowsAssets,
			], root, withoutToken()));
		}
		if (wsl) {
			builds.push(run(wslCommand(
				wsl, "bash", "-l", `${wslSource}/scripts/cnb-wsl.sh`, stage, source.commit, source.openwiki,
				remoteBun?.version ?? "-", remoteBun?.revision ?? "-", releaseVersion, updateRepository, ...linuxAssets,
			), root, withoutToken()));
		}
		const outcomes = await Promise.allSettled(builds);
		const failure = outcomes.find((result): result is PromiseRejectedResult => result.status === "rejected");
		if (failure) throw failure.reason;
		const artifacts = await Promise.all(assets.map(async name => {
			const file = path.join(stage, name);
			const stat = await fs.stat(file);
			if (!stat.isFile() || stat.size === 0) throw new Error(`Missing or empty upload staging file: ${name}`);
			return { file, name, size: stat.size };
		}));
		console.log(`Publishing ${repo} tag ${tag}, source commit ${source.commit}; overwriting selected attachments.`);
		const uploads = await Promise.allSettled(
			artifacts.map(({ file, name, size }) => upload(repo, release, file, name, size)),
		);
		const confirmed = assets.filter((_, index) => uploads[index]!.status === "fulfilled");
		const unconfirmed = assets.filter((_, index) => uploads[index]!.status === "rejected");
		console.log(`Confirmed CNB assets: ${confirmed.join(", ") || "none"}.`);
		if (unconfirmed.length) console.error(`Unconfirmed CNB assets: ${unconfirmed.join(", ")}.`);
		if (nextTitle && [windowsBinary, linuxBinary].every(name => !assets.includes(name) || confirmed.includes(name))) {
			await cnb([
				"releases", "patch-release", "--repo", repo, "--release-id", release.id, "--name", nextTitle, "--verbose",
			]);
			console.log(`Updated CNB release title for ${tag} (v${releaseVersion}).`);
		}
		const uploadFailure = uploads.find((result): result is PromiseRejectedResult => result.status === "rejected");
		if (uploadFailure) throw uploadFailure.reason;
	} finally {
		console.log(`CNB total elapsed: ${((performance.now() - started) / 1000).toFixed(1)}s`);
		try {
			if (temp) await fs.rm(temp, { recursive: true, force: true });
		} finally {
			await fs.rmdir(lock);
		}
	}
}

main().catch(error => {
	console.error(error instanceof Error ? error.message : "CNB distribution failed.");
	process.exitCode = 1;
});
