#!/usr/bin/env bun
// slowtest stage between fulltest and the origin push: run this repo's
// fulltest inside the `Ubuntu-24.04` WSL2 distro, mechanically following the
// jch-wsl-git-test methodology — source reaches the distro only via a Git
// remote, the workspace lives under /root and runs as root, the distro tests
// exactly the pushed commit (EXPECTED_SHA), and the WSL worktree's own
// uncommitted state is never cleaned or moved. Windows-only by contract; on
// any other host the stage skips.

import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");

/** WSL2 distro under test; must match the registered name from `wsl --list`. */
export const WSL_TEST_DISTRIBUTION = "Ubuntu-24.04";

export interface WslDistro {
	name: string;
	state: string;
	version: string;
}

export interface WslRepoCandidate {
	path: string;
	remotes: Array<{ name: string; url: string }>;
}

export type WslRepoPick =
	| { kind: "match"; path: string; remoteName: string }
	| { kind: "none" }
	| { kind: "ambiguous"; paths: string[] };

/** wsl.exe prints management output (e.g. `--list`) as UTF-16LE while command
 * output piped from inside the distro is UTF-8; decode by NUL density. */
export function decodeWslOutput(bytes: Uint8Array): string {
	let nulls = 0;
	const probe = Math.min(bytes.length, 256);
	for (let i = 0; i < probe; i++) if (bytes[i] === 0) nulls++;
	return new TextDecoder(nulls * 4 > probe ? "utf-16le" : "utf-8").decode(bytes);
}

/** Parse `wsl.exe --list --verbose`: NAME STATE VERSION rows under a header;
 * the default distro carries a leading `*` marker column. */
export function parseWslListVerbose(raw: string): WslDistro[] {
	const distros: WslDistro[] = [];
	for (const line of raw.split(/\r?\n/)) {
		const cols = line.trim().split(/\s+/);
		if (cols.length >= 3 && cols[0] === "*") cols.shift();
		if (cols.length < 3 || cols[0] === "NAME" || !/^\d+$/.test(cols[cols.length - 1])) continue;
		distros.push({ name: cols[0], state: cols[1], version: cols[cols.length - 1] });
	}
	return distros;
}

/** Compare remote URLs by repository identity: https/ssh/scp spellings of the
 * same repo normalize to one string. */
export function normalizeGitUrl(url: string): string {
	let u = url.trim().toLowerCase();
	u = u.replace(/^(?:https?|ssh|git|git\+ssh)?:\/\//, "");
	const scp = /^([^@/]+)@([^:]+):(.+)$/.exec(u);
	if (scp !== null) u = `${scp[2]}/${scp[3]}`;
	else u = u.replace(/^[^@/]+@/, "");
	return u.replace(/\/+$/, "").replace(/\.git$/, "");
}

/** Pick the /root clone of THIS repo among the candidates by remote identity. */
export function pickWslRepo(candidates: readonly WslRepoCandidate[], fetchUrl: string): WslRepoPick {
	const target = normalizeGitUrl(fetchUrl);
	const matches = [];
	for (const candidate of candidates) {
		const remote = candidate.remotes.find(entry => normalizeGitUrl(entry.url) === target);
		if (remote !== undefined) matches.push({ candidate, remote });
	}
	if (matches.length === 0) return { kind: "none" };
	if (matches.length > 1) return { kind: "ambiguous", paths: matches.map(match => match.candidate.path) };
	return { kind: "match", path: matches[0].candidate.path, remoteName: matches[0].remote.name };
}

/** Clone directory name under /root derived from the remote URL. */
export function repoNameFromUrl(url: string): string {
	const cleaned = url
		.trim()
		.replace(/\/+$/, "")
		.replace(/\.git$/, "");
	const remotePath = /^[^/]+:(?!\/\/)(.+)$/.exec(cleaned)?.[1] ?? cleaned;
	const segment = remotePath.split("/").pop() ?? "";
	return segment === "" ? "repo" : segment;
}

function fail(message: string): never {
	console.error(`wsl-stage: FAIL — ${message}`);
	process.exit(1);
}

function quote(value: string): string {
	if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

interface WslResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

function wslRun(distro: string, command: string): WslResult {
	const result = Bun.spawnSync(
		["wsl.exe", "--distribution", distro, "--user", "root", "--cd", "/root", "--", "bash", "-lc", command],
		{ cwd: repoRoot, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
	);
	return {
		exitCode: result.exitCode,
		stdout: decodeWslOutput(result.stdout ?? Buffer.alloc(0)),
		stderr: decodeWslOutput(result.stderr ?? Buffer.alloc(0)),
	};
}

function wslGit(distro: string, repoPath: string, args: readonly string[]): WslResult {
	return wslRun(distro, `git -C ${quote(repoPath)} ${args.map(quote).join(" ")}`);
}

function runGit(args: readonly string[]): WslResult {
	const result = Bun.spawnSync(["git", ...args], { cwd: repoRoot, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	return {
		exitCode: result.exitCode,
		stdout: result.stdout?.toString("utf-8") ?? "",
		stderr: result.stderr?.toString("utf-8") ?? "",
	};
}

function resolveDistro(wanted: string): string {
	const result = Bun.spawnSync(["wsl.exe", "--list", "--verbose"], {
		cwd: repoRoot,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) {
		fail(`wsl --list --verbose failed: ${decodeWslOutput(result.stderr ?? Buffer.alloc(0)).trim()}`);
	}
	const distros = parseWslListVerbose(decodeWslOutput(result.stdout ?? Buffer.alloc(0)));
	const hit = distros.find(distro => distro.name.toLowerCase() === wanted.toLowerCase());
	if (hit === undefined) {
		fail(`WSL distro '${wanted}' is not registered (found: ${distros.map(d => d.name).join(", ") || "none"})`);
	}
	if (hit.version !== "2") fail(`WSL distro '${hit.name}' is version ${hit.version}, not WSL2`);
	return hit.name;
}

interface WindowsPushTarget {
	branch: string;
	remote: string;
	remoteBranch: string;
	fetchUrl: string;
	expectedSha: string;
}

/** Clean tree → resolve the configured push target → push HEAD → confirm the
 * remote actually serves EXPECTED_SHA. */
function prepareWindowsPush(): WindowsPushTarget {
	const status = runGit(["status", "--porcelain"]);
	if (status.exitCode !== 0) fail(`git status failed: ${status.stderr.trim()}`);
	if (status.stdout.trim() !== "") {
		fail("Windows working tree is dirty — commit or stash first; the stage tests only git-shared state");
	}
	const branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
	if (branch === "" || branch === "HEAD") fail("detached HEAD — refusing to guess the branch to push");

	let remote = "";
	let remoteBranch = "";
	const upstream = runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
	const upstreamName = upstream.stdout.trim();
	if (upstream.exitCode === 0 && upstreamName.includes("/")) {
		remote = upstreamName.split("/")[0];
		remoteBranch = upstreamName.split("/").slice(1).join("/");
	} else {
		const remotes = runGit(["remote"])
			.stdout.split("\n")
			.map(entry => entry.trim())
			.filter(entry => entry !== "");
		if (remotes.length !== 1) {
			fail(
				`no upstream for '${branch}' and ${remotes.length} remotes configured — cannot determine the push target`,
			);
		}
		remote = remotes[0];
		remoteBranch = branch;
	}
	const fetchUrl = runGit(["remote", "get-url", remote]).stdout.trim();
	const expectedSha = runGit(["rev-parse", "HEAD"]).stdout.trim();

	console.log(`wsl-stage: pushing ${branch} -> ${remote}/${remoteBranch} (${expectedSha.slice(0, 12)})`);
	const push = runGit(["push", remote, `HEAD:refs/heads/${remoteBranch}`]);
	if (push.exitCode !== 0) fail(`git push ${remote} HEAD:${remoteBranch} failed: ${push.stderr.trim()}`);
	const remoteSha = runGit(["ls-remote", remote, `refs/heads/${remoteBranch}`])
		.stdout.trim()
		.split("\t")[0];
	if (remoteSha !== expectedSha)
		fail(`remote ${remote}/${remoteBranch} serves ${remoteSha.slice(0, 12)}, expected ${expectedSha.slice(0, 12)}`);
	return { branch, remote, remoteBranch, fetchUrl, expectedSha };
}

function assertRootIdentity(distro: string): void {
	const result = wslRun(distro, `printf '%s %s' "$(id -u)" "$HOME"`);
	if (result.exitCode !== 0) fail(`could not run bash inside '${distro}': ${result.stderr.trim()}`);
	if (result.stdout.trim() !== "0 /root") {
		fail(`expected root with HOME=/root inside '${distro}', got '${result.stdout.trim()}'`);
	}
}

/** Locate the /root clone of this repo by remote identity; clone only when
 * none exists. Never deletes or overwrites existing directories. */
function locateWslRepo(distro: string, fetchUrl: string): { path: string; remoteName: string } {
	const found = wslRun(distro, "find /root -maxdepth 3 -name .git -print 2>/dev/null");
	if (found.exitCode !== 0) fail(`find under /root failed: ${found.stderr.trim()}`);
	const candidates: WslRepoCandidate[] = [];
	const seen = new Set<string>();
	for (const dotGit of found.stdout
		.split("\n")
		.map(entry => entry.trim())
		.filter(entry => entry !== "")) {
		const repoPath = path.posix.dirname(dotGit);
		if (seen.has(repoPath)) continue;
		seen.add(repoPath);
		const remotesResult = wslRun(distro, `git -C ${quote(repoPath)} remote -v`);
		if (remotesResult.exitCode !== 0) continue;
		const remotes = remotesResult.stdout
			.split("\n")
			.map(line => line.trim())
			.filter(line => line !== "")
			.map(line => {
				const cols = line.split(/\s+/);
				return cols.length >= 3 && cols[2] === "(fetch)" ? { name: cols[0], url: cols[1] } : null;
			})
			.filter((entry): entry is { name: string; url: string } => entry !== null);
		if (remotes.length > 0) candidates.push({ path: repoPath, remotes });
	}
	const pick = pickWslRepo(candidates, fetchUrl);
	if (pick.kind === "ambiguous") {
		fail(`multiple /root clones of this repo — refusing to pick: ${pick.paths.join(", ")}`);
	}
	if (pick.kind === "match") {
		console.log(`wsl-stage: using existing clone ${pick.path} (remote '${pick.remoteName}')`);
		return { path: pick.path, remoteName: pick.remoteName };
	}
	const clonePath = `/root/${repoNameFromUrl(fetchUrl)}`;
	console.log(`wsl-stage: cloning ${fetchUrl} -> ${clonePath}`);
	const clone = wslRun(distro, `cd /root && git clone ${quote(fetchUrl)}`);
	if (clone.exitCode !== 0) fail(`git clone failed: ${clone.stderr.trim()}`);
	return { path: clonePath, remoteName: "origin" };
}

/** Fast-forward the WSL clone to EXPECTED_SHA without ever discarding local
 * state: dirty tree → stop, ahead/diverged branch → stop. */
export function syncWslRepo(
	distro: string,
	repo: { path: string; remoteName: string },
	expectedSha: string,
	branch: string,
	runGit: typeof wslGit = wslGit,
): void {
	const porcelain = runGit(distro, repo.path, ["status", "--porcelain"]);
	if (porcelain.exitCode !== 0) fail(`git status in ${repo.path} failed: ${porcelain.stderr.trim()}`);
	if (porcelain.stdout.trim() !== "") {
		fail(`WSL repo ${repo.path} has uncommitted changes — not touching them; resolve manually and re-run`);
	}
	const fetch = runGit(distro, repo.path, ["fetch", repo.remoteName]);
	if (fetch.exitCode !== 0) fail(`git fetch ${repo.remoteName} in ${repo.path} failed: ${fetch.stderr.trim()}`);
	const objectExists = runGit(distro, repo.path, ["cat-file", "-e", expectedSha]);
	if (objectExists.exitCode !== 0) {
		fail(`commit ${expectedSha.slice(0, 12)} is not reachable in ${repo.path} after fetch`);
	}
	const branchSha = runGit(distro, repo.path, ["rev-parse", `refs/heads/${branch}`]);
	const branchExists = branchSha.exitCode === 0;
	const branchTip = branchSha.stdout.trim();
	if (!branchExists) {
		const create = runGit(distro, repo.path, ["checkout", "-b", branch, expectedSha]);
		if (create.exitCode !== 0)
			fail(`creating branch '${branch}' at ${expectedSha.slice(0, 12)} failed: ${create.stderr.trim()}`);
	} else {
		if (branchTip !== expectedSha) {
			const ancestor = runGit(distro, repo.path, [
				"merge-base",
				"--is-ancestor",
				`refs/heads/${branch}`,
				expectedSha,
			]);
			if (ancestor.exitCode !== 0) {
				fail(
					`WSL branch '${branch}' is ahead of or diverged from ${expectedSha.slice(0, 12)} — refusing to move it`,
				);
			}
		}
		const checkout = runGit(distro, repo.path, ["checkout", branch]);
		if (checkout.exitCode !== 0) fail(`checking out '${branch}' failed: ${checkout.stderr.trim()}`);
		if (branchTip !== expectedSha) {
			const ff = runGit(distro, repo.path, ["merge", "--ff-only", expectedSha]);
			if (ff.exitCode !== 0) fail(`fast-forwarding '${branch}' failed: ${ff.stderr.trim()}`);
		}
	}
	const head = runGit(distro, repo.path, ["rev-parse", "HEAD"]).stdout.trim();
	if (head !== expectedSha) fail(`WSL HEAD ${head.slice(0, 12)} != expected ${expectedSha.slice(0, 12)}`);
	console.log(`wsl-stage: ${repo.path} synced to ${expectedSha.slice(0, 12)} (branch '${branch}')`);
}

/** The distro must run its own Linux toolchain — bun/git resolving to a
 * Windows mount (/mnt/…) would test the wrong binaries. */
function checkWslToolchain(distro: string): void {
	for (const tool of ["git", "bun"]) {
		const result = wslRun(distro, `command -v ${tool}`);
		const resolved = result.stdout.trim();
		if (result.exitCode !== 0 || resolved === "") fail(`'${tool}' not found inside '${distro}' (login shell PATH)`);
		if (resolved.startsWith("/mnt/"))
			fail(`'${tool}' resolves to the Windows mount ${resolved} — the distro needs its own Linux ${tool}`);
	}
}

/** Isolate only this invocation's Linux children; never terminate the distro. */
export function wslFulltestCommand(repoPath: string, controlDir: string): string {
	const pidFile = quote(`${controlDir}/pid`);
	const canceledFile = quote(`${controlDir}/canceled`);
	const inner = `printf '%s\\n' "$$" > ${pidFile}; [ ! -f ${canceledFile} ] || exit 130; cd ${quote(repoPath)} && bun install --frozen-lockfile && bun run fulltest`;
	const cleanup = `${wslCancelCommand(controlDir)}; rm -f -- ${pidFile} ${canceledFile}; rmdir -- ${quote(controlDir)}`;
	return `trap ${quote(cleanup)} EXIT; setsid --wait bash -c ${quote(inner)}`;
}

export function wslCancelCommand(controlDir: string): string {
	const dir = quote(controlDir);
	const pidFile = quote(`${controlDir}/pid`);
	return `if [ -d ${dir} ]; then touch -- ${quote(`${controlDir}/canceled`)}; if read -r pid < ${pidFile} 2>/dev/null; then case "$pid" in ''|*[!0-9]*) exit 1;; esac; kill -KILL -- "-$pid" 2>/dev/null || true; fi; fi`;
}

async function runWslFulltest(distro: string, repoPath: string): Promise<number> {
	// A fresh clone has no node_modules, so the install runs in the same
	// invocation: the workspace-local binaries (oxlint, tsgo, nextest glue, …)
	// must exist before fulltest. No fork-side time budget: the nested run owns
	// its own failure reporting and a hung run is stopped by the operator, never
	// silently by a timer here.
	const controlDir = `/tmp/omp-slowtest-${crypto.randomUUID()}`;
	const setup = wslRun(distro, `mkdir -m 700 -- ${quote(controlDir)}`);
	if (setup.exitCode !== 0) fail(`could not create WSL cancellation marker: ${setup.stderr.trim()}`);
	const command = wslFulltestCommand(repoPath, controlDir);
	let canceled = false;
	const cancel = () => {
		canceled = true;
		const result = wslRun(distro, wslCancelCommand(controlDir));
		if (result.exitCode !== 0) {
			console.error(`wsl-stage: cancellation cleanup failed: ${result.stderr.trim()}`);
		}
	};
	process.on("SIGINT", cancel);
	process.on("SIGTERM", cancel);
	try {
		console.log(`\n==> wsl/fulltest`);
		console.log(`$ wsl --distribution ${distro} --user root -- bash -lc ${command}`);
		const child = Bun.spawn(
			["wsl.exe", "--distribution", distro, "--user", "root", "--cd", "/root", "--", "bash", "-lc", command],
			{ cwd: repoRoot, stdin: "ignore", stdout: "inherit", stderr: "inherit" },
		);
		const exitCode = await child.exited;
		if (canceled || exitCode !== 0) {
			console.error(`wsl-stage: FAIL — bun run fulltest ${canceled ? "canceled" : `exited with code ${exitCode}`}`);
			return 1;
		}
		console.log("wsl-stage: PASS (Ubuntu-24.04 fulltest)");
		return 0;
	} finally {
		process.off("SIGINT", cancel);
		process.off("SIGTERM", cancel);
		// Also handles spawn failure before the Linux wrapper could install its trap.
		wslRun(
			distro,
			`rm -f -- ${quote(`${controlDir}/pid`)} ${quote(`${controlDir}/canceled`)}; rmdir -- ${quote(controlDir)} 2>/dev/null || true`,
		);
	}
}

export async function runWslStage(): Promise<number> {
	if (process.platform !== "win32") {
		console.log(`wsl-stage: skipped — Windows-only stage (already on ${process.platform})`);
		return 0;
	}
	const distro = resolveDistro(WSL_TEST_DISTRIBUTION);
	assertRootIdentity(distro);
	checkWslToolchain(distro);
	const target = prepareWindowsPush();
	const repo = locateWslRepo(distro, target.fetchUrl);
	syncWslRepo(distro, repo, target.expectedSha, target.branch);
	return await runWslFulltest(distro, repo.path);
}

if (import.meta.main) {
	runWslStage().then(exitCode => {
		process.exitCode = exitCode;
	});
}
