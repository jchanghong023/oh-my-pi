#!/usr/bin/env bun
// Internal slowtest leg: only a pushed fixed commit, network Git remote, and
// native /root worktree. Never commit/push, transfer source, or trigger CI.
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { GateCommandError, type GateCommand, type GateRun } from "./test-gate-runtime";
import { captureSourceIdentity, type SourceIdentity } from "./test-gate-source";

const repoRoot = path.resolve(import.meta.dir, "..");
export const WSL_TEST_DISTRIBUTION = "Ubuntu-24.04";
const HELPER_HANG_GUARD_SECONDS = 3600;
export interface WslDistro {
	name: string;
	state: string;
	version: string;
}
export type WslSelection =
	| { status: "AVAILABLE"; distro: string }
	| { status: "SKIPPED_NOT_APPLICABLE" | "SKIPPED_WSL_UNAVAILABLE"; reason: string };
export type WslStageResult =
	| { status: "PASS"; distro: string; head: string }
	| { status: "BLOCKED" | "UNVERIFIED" | "FAIL" | "TIMEOUT" | "CANCELLED"; reason: string; exitCode: number }
	| Exclude<WslSelection, { status: "AVAILABLE" }>;
export interface WslOptions {
	debug: boolean;
	needed?: boolean;
	platform?: NodeJS.Platform;
	root?: string;
	which?: (tool: string) => string | null;
	selection?: WslSelection;
	identity?: SourceIdentity;
	/** Deployed helper location; injection supports isolated orchestration tests. */
	workflowPath?: string;
}
export interface WslRemoteSource {
	head: string;
	branch: string;
	fetchUrl: string;
	identity: string;
}
export function decodeWslOutput(bytes: Uint8Array): string {
	let nulls = 0;
	const probe = Math.min(bytes.length, 256);
	for (let i = 0; i < probe; i++) if (bytes[i] === 0) nulls++;
	return new TextDecoder(nulls * 4 > probe ? "utf-16le" : "utf-8").decode(bytes).replaceAll("\uFEFF", "");
}
export function parseWslListVerbose(raw: string): WslDistro[] {
	const distros: WslDistro[] = [];
	for (const line of raw.replaceAll("\0", "").replaceAll("\uFEFF", "").split(/\r?\n/)) {
		const cols = line.trim().split(/\s+/);
		if (cols[0] === "*") cols.shift();
		if (cols.length < 3 || !/^\d+$/.test(cols.at(-1)!)) continue;
		distros.push({ name: cols.slice(0, -2).join(" "), state: cols.at(-2)!, version: cols.at(-1)! });
	}
	return distros;
}
export function selectWslDistribution(distros: readonly WslDistro[]): WslSelection {
	const selected = distros.find(d => d.version === "2" && d.name === WSL_TEST_DISTRIBUTION);
	return selected
		? { status: "AVAILABLE", distro: selected.name }
		: {
				status: "SKIPPED_WSL_UNAVAILABLE",
				reason: `no compatible WSL2 ${WSL_TEST_DISTRIBUTION} distribution (installed: ${distros.map(d => `${d.name}/WSL${d.version}`).join(", ") || "none"}); explicit target is never substituted`,
			};
}
export async function discoverWsl(gate: GateRun, options: WslOptions): Promise<WslSelection> {
	if (options.needed === false)
		return { status: "SKIPPED_NOT_APPLICABLE", reason: "project does not need an additional Linux leg" };
	if ((options.platform ?? process.platform) !== "win32")
		return {
			status: "SKIPPED_NOT_APPLICABLE",
			reason: "WSL extension is Windows-only; current platform supplies applicable fulltest",
		};
	if ((options.which ?? Bun.which)("wsl.exe") === null)
		return { status: "SKIPPED_WSL_UNAVAILABLE", reason: "wsl.exe is not installed" };
	const result = await gate.capture({
		label: "wsl/discovery",
		argv: ["wsl.exe", "--list", "--verbose"],
		cwd: options.root ?? repoRoot,
		decodeOutput: decodeWslOutput,
		allowFailure: true,
		wallTimeoutSeconds: 30,
	});
	if (result.exitCode !== 0) {
		const diagnostic = `${result.stdout}\n${result.stderr}`.trim();
		if (
			/WSL_E_(?:DEFAULT_DISTRO_NOT_FOUND|DISTRO_NOT_FOUND|WSL_OPTIONAL_COMPONENT_REQUIRED|NOT_INSTALLED)|has no installed distributions/i.test(
				diagnostic,
			)
		)
			return { status: "SKIPPED_WSL_UNAVAILABLE", reason: diagnostic };
		throw new GateCommandError(
			`BLOCKED: WSL discovery failed: ${diagnostic || `exit ${result.exitCode}`}`,
			result.exitCode || 1,
		);
	}
	return selectWslDistribution(parseWslListVerbose(result.stdout));
}
function quote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}
function wslArgv(distro: string, timeout: number): string[] {
	return [
		"wsl.exe",
		"--distribution",
		distro,
		"--user",
		"root",
		"--cd",
		"/root",
		"--",
		"timeout",
		"-k",
		"5",
		String(timeout),
		"bash",
		"-ls",
	];
}
/** Network identities only: local paths, file URLs, and credential URLs block. */
export function gitRemoteIdentity(value: string): string {
	const scp = /^(?:[^/@:]+@)?([^/:]+):(.+)$/.exec(value);
	if (scp && !/^[A-Za-z]:/.test(value) && !value.includes("://"))
		return `${scp[1]!.toLowerCase()}/${scp[2]!.replace(/^\/+|\.git$/g, "")}`;
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("BLOCKED: source synchronization requires a network Git remote, not a local workspace");
	}
	if (
		!["https:", "ssh:", "git:"].includes(url.protocol) ||
		url.password ||
		(url.protocol === "https:" && url.username) ||
		!url.hostname
	)
		throw new Error("BLOCKED: source synchronization requires an existing credential-free network Git URL");
	return `${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ""}/${url.pathname.replace(/^\/+|\.git$/g, "")}`;
}
export async function resolveWslRemoteSource(
	gate: GateRun,
	root: string,
	source: SourceIdentity,
): Promise<WslRemoteSource> {
	if (source.dirty)
		throw new Error(
			"BLOCKED: commit and push the intended source before WSL execution; Git writes are not authorized and dirty source cannot be transferred",
		);
	const git = async (label: string, args: string[]) => {
		const result = await gate.capture({ label, argv: ["git", ...args], cwd: root, allowFailure: true });
		if (result.exitCode !== 0) throw new Error(`BLOCKED: ${label} could not resolve the existing pushed source`);
		return result.stdout.trim();
	};
	const admin = await git("wsl/source-admin", ["rev-parse", "--absolute-git-dir"]);
	await gate.charged(async () => {
		for (const marker of [
			"MERGE_HEAD",
			"CHERRY_PICK_HEAD",
			"REVERT_HEAD",
			"rebase-merge",
			"rebase-apply",
			"BISECT_LOG",
		]) {
			let exists = false;
			try {
				await fs.access(path.join(admin, marker));
				exists = true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			if (exists) throw new Error(`BLOCKED: Windows Git operation ${marker} is in progress; no WSL synchronization`);
		}
	});
	const branch = await git("wsl/source-branch", ["symbolic-ref", "--short", "HEAD"]);
	const target = await git("wsl/push-target", [
		"for-each-ref",
		"--format=%(push:remotename)%09%(push:remoteref)",
		`refs/heads/${branch}`,
	]);
	const [remote, ref] = target.split("\t");
	if (!remote || remote === "." || !ref?.startsWith("refs/heads/"))
		throw new Error("BLOCKED: actual configured push remote/branch is ambiguous or unavailable");
	const fetchUrls = (await git("wsl/fetch-url", ["remote", "get-url", "--all", remote])).split(/\r?\n/);
	const pushUrls = (await git("wsl/push-url", ["remote", "get-url", "--push", "--all", remote])).split(/\r?\n/);
	if (fetchUrls.length !== 1 || pushUrls.length !== 1)
		throw new Error("BLOCKED: multiple remote URLs require a resolved push target");
	const fetchUrl = fetchUrls[0]!;
	const identity = gitRemoteIdentity(fetchUrl);
	if (gitRemoteIdentity(pushUrls[0]!) !== identity)
		throw new Error("BLOCKED: fetch and push URLs identify different repositories");
	// Remote tip may have advanced; the helper's fetch/ancestry check proves SHA
	// reachability before testing. No host commit, push, pull, or local bundle.
	await git("wsl/remote-availability", ["ls-remote", "--exit-code", remote, ref]);
	return { head: source.head, branch: ref.slice("refs/heads/".length), fetchUrl, identity };
}
const CANCEL_OWNED_TREE = `import os,pathlib,signal,sys,time
control=pathlib.Path(sys.argv[1]); (control/'canceled').touch()
try: root,born=map(int,(control/'pid').read_text().split())
except (FileNotFoundError,ValueError): raise SystemExit(0)
def identity(pid):
 try:
  fields=pathlib.Path('/proc/'+str(pid)+'/stat').read_text().rsplit(') ',1)[1].split()
  return int(fields[1]),int(fields[19]),fields[0]
 except (FileNotFoundError,ProcessLookupError,ValueError,IndexError): return None
current=identity(root)
if current is None or current[1]!=born: raise SystemExit(0)
processes={}
for entry in pathlib.Path('/proc').iterdir():
 if entry.name.isdigit():
  pid=int(entry.name); value=identity(pid)
  if value is not None: processes[pid]=value
owned={root:born}
while True:
 added={pid:value[1] for pid,value in processes.items() if value[0] in owned and pid not in owned}
 if not added: break
 owned.update(added)
def send(pid,stamp,sig):
 value=identity(pid)
 if value is not None and value[1]==stamp and value[2]!='Z':
  try: os.kill(pid,sig)
  except ProcessLookupError: pass
for pid,stamp in reversed(list(owned.items())): send(pid,stamp,signal.SIGTERM)
time.sleep(0.2)
for pid,stamp in reversed(list(owned.items())): send(pid,stamp,signal.SIGKILL)
`;
export function wslCancelCommand(controlDir: string): string {
	return `if [ -d ${quote(controlDir)} ]; then python3 -c ${quote(CANCEL_OWNED_TREE)} ${quote(controlDir)}; fi`;
}
async function cancelOwnedWsl(distro: string, control: string): Promise<void> {
	const child = Bun.spawn(wslArgv(distro, 25), {
		stdin: new Blob([`mkdir -p -m 700 -- ${quote(control)}; ${wslCancelCommand(control)}\n`]),
		stdout: "inherit",
		stderr: "inherit",
		windowsHide: true,
	});
	const timer = setTimeout(() => child.kill(), 30000);
	try {
		if ((await child.exited) !== 0)
			throw new Error("WSL owned-tree cancellation failed; leftover processes UNVERIFIED");
	} finally {
		clearTimeout(timer);
	}
}
const REPOSITORIES = `import json,os,pathlib,subprocess,sys,urllib.parse
expected=sys.argv[1]; matches=[]
def identity(value):
 if '://' in value:
  u=urllib.parse.urlsplit(value); host=u.hostname or ''; repo=u.path.lstrip('/'); host+=(':'+str(u.port)) if u.port else ''
 else:
  host,repo=value.split(':',1); host=host.rsplit('@',1)[-1]; repo=repo.lstrip('/')
 return host.lower()+'/'+(repo[:-4] if repo.endswith('.git') else repo)
for directory,children,files in os.walk('/root'):
 repository=('.git' in children or '.git' in files)
 children[:]=[n for n in children if n not in ('node_modules','target','.cache','.git','.venv','venv')]
 if not repository: continue
 root=pathlib.Path(directory).resolve()
 if not str(root).startswith('/root/'): continue
 for remote in subprocess.check_output(['git','-C',str(root),'remote'],text=True,timeout=5).splitlines():
  urls=subprocess.check_output(['git','-C',str(root),'remote','get-url','--all',remote],text=True,timeout=5).splitlines()
  for url in urls:
   try: same=identity(url)==expected
   except ValueError: same=False
   if same: matches.append({'linux_repo':str(root),'remote':remote,'fetch_url':url})
print(json.dumps(matches))`;
function stageFailure(
	status: "BLOCKED" | "UNVERIFIED" | "FAIL" | "TIMEOUT" | "CANCELLED",
	reason: string,
	exitCode = 1,
): WslStageResult {
	console.error(`wsl-stage: ${status} — ${reason}`);
	return { status, reason, exitCode: exitCode || 1 };
}
export async function runWslStage(gate: GateRun, options: WslOptions): Promise<WslStageResult> {
	const selection = options.selection ?? (await discoverWsl(gate, options));
	if (selection.status !== "AVAILABLE") return selection;
	const root = options.root ?? repoRoot;
	const source = options.identity ?? (await captureSourceIdentity(gate, root));
	if (source.dirty)
		return stageFailure(
			"BLOCKED",
			"commit and push the intended source first; dirty source is not transferable and gate authorization grants no Git writes",
		);
	const which = options.which ?? Bun.which;
	const python = which("python") ?? which("python3");
	const helper =
		options.workflowPath ??
		path.join(os.homedir(), ".codex", "skills", "jch-fastcheck-fulltest-slowtest-gates", "scripts", "workflow.py");
	if (
		!python ||
		!(await gate.charged(() =>
			fs
				.stat(helper)
				.then(s => s.isFile())
				.catch(() => false),
		))
	)
		return stageFailure("BLOCKED", "deployed workflow.py and a host Python interpreter are required");
	let remote: WslRemoteSource;
	try {
		remote = await resolveWslRemoteSource(gate, root, source);
	} catch (error) {
		return stageFailure("BLOCKED", error instanceof Error ? error.message : String(error));
	}
	const probe = await gate.capture({
		label: "wsl/native-repository-discovery",
		argv: wslArgv(selection.distro, 25),
		cwd: root,
		stdin: `set -eu\n[ "$(id -u)" = 0 ] && [ "$HOME" = /root ]\nfor tool in git python3; do exe=$(command -v "$tool") || exit 127; case "$exe" in /mnt/*|*.exe) exit 127;; esac; done\npython3 -c ${quote(REPOSITORIES)} ${quote(remote.identity)}\n`,
		allowFailure: true,
		wallTimeoutSeconds: 30,
	});
	if (probe.exitCode !== 0)
		return stageFailure("BLOCKED", "chosen distribution native repository discovery failed", probe.exitCode);
	let candidates: Array<{ linux_repo: string; remote: string; fetch_url: string }>;
	try {
		candidates = JSON.parse(probe.stdout.trim());
		if (
			!Array.isArray(candidates) ||
			candidates.some(
				c =>
					typeof c.linux_repo !== "string" ||
					!c.linux_repo.startsWith("/root/") ||
					c.linux_repo.split("/").includes("..") ||
					typeof c.remote !== "string" ||
					typeof c.fetch_url !== "string" ||
					gitRemoteIdentity(c.fetch_url) !== remote.identity,
			)
		)
			throw new Error("invalid native identity");
	} catch {
		return stageFailure(
			"UNVERIFIED",
			"native repository discovery did not return a matching protected /root identity report",
		);
	}
	// No automatic alternate clone may bypass an existing unsafe/ambiguous tree.
	const unique = [...new Set(candidates.map(c => c.linux_repo))];
	if (unique.length > 1) return stageFailure("BLOCKED", `multiple matching native worktrees: ${unique.join(", ")}`);
	let linux = candidates[0];
	if (!linux) {
		const name = remote.identity.split("/").at(-1)!;
		const owner = remote.identity.split("/").at(-2)!;
		if (![name, owner].every(part => /^[A-Za-z0-9._-]+$/.test(part)))
			return stageFailure("BLOCKED", "remote identity cannot determine a safe /root clone destination");
		const preferred = `/root/${name}`;
		const alternate = `/root/${owner}-${name}`;
		const clone = await gate.capture({
			label: "wsl/network-clone",
			argv: wslArgv(selection.distro, 120),
			cwd: root,
			stdin: `set -eu\ndestination=${quote(preferred)}\nif [ -e "$destination" ]; then destination=${quote(alternate)}; fi\n[ ! -e "$destination" ] || { echo 'BLOCKED: native destinations already exist' >&2; exit 1; }\ngit clone --no-checkout --branch ${quote(remote.branch)} -- ${quote(remote.fetchUrl)} "$destination"\ngit -C "$destination" merge-base --is-ancestor ${quote(source.head)} ${quote(`refs/remotes/origin/${remote.branch}`)}\n# Only this freshly created clone is positioned at the frozen SHA.\ngit -C "$destination" update-ref ${quote(`refs/heads/${remote.branch}`)} ${quote(source.head)}\ngit -C "$destination" checkout ${quote(remote.branch)}\nprintf 'CLONED_REPOSITORY=%s\\n' "$destination"\n`,
			allowFailure: true,
			wallTimeoutSeconds: 150,
		});
		if (clone.stdout) console.log(clone.stdout);
		if (clone.stderr) console.error(clone.stderr);
		if (clone.exitCode !== 0)
			return stageFailure(
				"BLOCKED",
				"network clone blocked; existing destinations are never overwritten",
				clone.exitCode,
			);
		const destination = /^CLONED_REPOSITORY=(.*)$/m.exec(clone.stdout)?.[1];
		if (destination !== preferred && destination !== alternate)
			return stageFailure("UNVERIFIED", "network clone did not establish its exact native destination");
		linux = { linux_repo: destination, remote: "origin", fetch_url: remote.fetchUrl };
	}
	const environment = await gate.capture({
		label: "wsl/native-environment",
		argv: wslArgv(selection.distro, 25),
		cwd: root,
		allowFailure: true,
		wallTimeoutSeconds: 30,
		stdin: `set -eu\ncd ${quote(linux.linux_repo)}\n[ "$(pwd -P)" = ${quote(linux.linux_repo)} ]\nfor tool in git python3 bun cargo rustc cargo-nextest ruff go setsid flock timeout; do exe=$(command -v "$tool") || exit 127; case "$exe" in /mnt/*|*.exe) exit 127;; esac; printf '%s=%s\\n' "$tool" "$exe"; done\npython3 -m pytest --version\nRUSTUP_AUTO_INSTALL=0 cargo --version\nRUSTUP_AUTO_INSTALL=0 rustc --version\nGOTOOLCHAIN=local go version\n# Refuse active unrelated writers; no waiting or global process termination.\nfor proc in /proc/[0-9]*; do cwd=$(readlink "$proc/cwd" 2>/dev/null || true); case "$cwd" in ${quote(linux.linux_repo)}|${quote(`${linux.linux_repo}/`)}*) case "$(cat "$proc/comm" 2>/dev/null || true)" in git|cargo|rustc|bun|node|python*|go|ruff) echo 'BLOCKED: active workspace process' >&2; exit 1;; esac;; esac; done\n`,
	});
	if (environment.exitCode !== 0)
		return stageFailure(
			"BLOCKED",
			"native Linux tools/environment or active-writer preflight blocked",
			environment.exitCode,
		);
	console.log(environment.stdout);
	const token = randomUUID();
	const control = `/tmp/omp-slowtest-${randomUUID()}`;
	const request = {
		action: "plan",
		windows_repo: root,
		distribution: selection.distro,
		...linux,
		branch: remote.branch,
		expected_sha: source.head,
		timeout: HELPER_HANG_GUARD_SECONDS,
		env: {
			RUSTUP_AUTO_INSTALL: "0",
			GOTOOLCHAIN: "local",
			OMP_GATE_EVENT_TOKEN: token,
			OMP_GATE_EVENT_FILE: "",
			OMP_GATE_CLOCK_TOKEN: "",
		},
		argv: [
			"bash",
			"-c",
			`set -eu; bun install --frozen-lockfile; bun scripts/fulltest.ts${options.debug ? " --debug" : ""}`,
		],
	};
	const plan = await gate.capture({
		label: "wsl/deployed-workflow-plan",
		argv: [python, "-B", helper],
		cwd: root,
		stdin: JSON.stringify(request),
		allowFailure: true,
		wallTimeoutSeconds: 30,
	});
	if (plan.exitCode !== 0)
		return stageFailure("BLOCKED", `deployed helper preflight rejected source: ${plan.stderr.trim()}`, plan.exitCode);
	let program: string;
	try {
		const resolved = JSON.parse(plan.stdout);
		if (resolved.status !== "PLANNED" || resolved.expected_sha !== source.head || typeof resolved.script !== "string")
			throw new Error("invalid plan");
		program = resolved.script;
	} catch {
		return stageFailure("UNVERIFIED", "deployed helper returned no fixed-commit plan");
	}
	// Preserve the helper's synchronization/protection/post-test checks verbatim.
	// Stream instead of helper.run (which buffers all compiler phase events).
	const inner = `set -eu\nread -r -a stat < /proc/$$/stat\nprintf '%s %s\\n' "$$" "\${stat[21]}" > ${quote(`${control}/pid`)}\n[ ! -f ${quote(`${control}/canceled`)} ] || exit 130\n${program}`;
	const script = `set -eu\nmkdir -p -m 700 -- ${quote(control)}\ntrap ${quote(`status=$?; rm -rf -- ${quote(control)}; exit "$status"`)} EXIT\n[ ! -f ${quote(`${control}/canceled`)} ] || exit 130\nsetsid --wait bash -c ${quote(inner)}\n`;
	console.log(
		`wsl-stage: distro=${selection.distro} root=${linux.linux_repo} expected_sha=${source.head} scope=whole-applicable-local; helper wall hang guard=${HELPER_HANG_GUARD_SECONDS}s (not charged limit); live compiler-phase accounting`,
	);
	const command: GateCommand = {
		label: `wsl/${selection.distro}/fulltest`,
		argv: wslArgv(selection.distro, HELPER_HANG_GUARD_SECONDS + 120),
		cwd: root,
		stdin: script,
		eventToken: token,
		allowFailure: true,
		onAbort: () => gate.charged(() => cancelOwnedWsl(selection.distro, control)),
	};
	const result = await gate.capture(command);
	console.log(result.stdout);
	if (result.stderr) console.error(result.stderr);
	// Nested orchestration selftests may log their own inert marker fixtures.
	// The helper's final records, not the first matching test log, own identity.
	const testCode = [...result.stdout.matchAll(/^TEST_EXIT_CODE=(\d+)$/gm)].at(-1)?.[1];
	const postHead = [...result.stdout.matchAll(/^POST_TEST_SHA=(.*)$/gm)].at(-1)?.[1];
	const postState = [...result.stdout.matchAll(/^POST_TEST_STATE_EXIT_CODE=(\d+)$/gm)].at(-1)?.[1];
	if (result.exitCode === 124 || result.exitCode === 137)
		return stageFailure("TIMEOUT", "WSL execution hang guard expired", result.exitCode);
	if (result.exitCode === 130) return stageFailure("CANCELLED", "WSL execution cancelled", 130);
	if (testCode === undefined)
		return stageFailure("BLOCKED", "fixed-commit synchronization or test startup did not complete", result.exitCode);
	if (postHead !== source.head || postState !== "0" || result.exitCode !== Number(testCode))
		return stageFailure(
			"UNVERIFIED",
			"post-test commit/state inspection did not establish the fixed-commit result",
			result.exitCode,
		);
	if (result.exitCode !== 0) return stageFailure("FAIL", "Linux fulltest failed", result.exitCode);
	const events: Array<{ id?: unknown; kind?: unknown }> = [];
	for (const line of result.stderr.split(/\r?\n/)) {
		if (!line.startsWith(`OMP_GATE_EVENT ${token} `)) continue;
		try {
			events.push(JSON.parse(line.slice(`OMP_GATE_EVENT ${token} `.length)));
		} catch {
			/* Not reliable timing evidence. */
		}
	}
	const closedActivity = events.some(
		(event, index) =>
			typeof event.id === "string" &&
			event.kind === "charged" &&
			events.slice(index + 1).some(end => end.id === event.id && end.kind === "idle"),
	);
	if (!/^fulltest: PASS total=/m.test(result.stdout) || !closedActivity)
		return stageFailure("UNVERIFIED", "Linux fulltest coverage or live compilation accounting was not observed");
	console.log(`wsl-stage: PASS distro=${selection.distro} HEAD=${source.head}`);
	return { status: "PASS", distro: selection.distro, head: source.head };
}
// This internal module deliberately has no independently runnable WSL tier.
if (import.meta.main) {
	console.error("WSL stage is internal to bun run slowtest; standalone execution is prohibited");
	process.exitCode = 2;
}
