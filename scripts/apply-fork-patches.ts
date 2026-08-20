#!/usr/bin/env bun

import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");
const hubPath = path.join(repoRoot, "packages/coding-agent/src/tools/hub/index.ts");
const jobsPath = path.join(repoRoot, "packages/coding-agent/src/tools/hub/jobs.ts");
const promptPath = path.join(repoRoot, "packages/coding-agent/src/prompts/tools/hub.md");

function replaceOnce(
	source: string,
	search: string,
	replacement: string,
	label: string,
): string {
	const first = source.indexOf(search);
	if (first < 0) throw new Error(`Fork patch failed: ${label} anchor was not found.`);
	if (source.indexOf(search, first + search.length) >= 0) {
		throw new Error(`Fork patch failed: ${label} anchor is not unique.`);
	}
	return `${source.slice(0, first)}${replacement}${source.slice(first + search.length)}`;
}

function replaceRange(
	source: string,
	startMarker: string,
	endMarker: string,
	replacement: string,
	label: string,
): string {
	const start = source.indexOf(startMarker);
	if (start < 0) throw new Error(`Fork patch failed: ${label} start anchor was not found.`);
	const end = source.indexOf(endMarker, start + startMarker.length);
	if (end < 0) throw new Error(`Fork patch failed: ${label} end anchor was not found.`);
	return `${source.slice(0, start)}${replacement}${source.slice(end)}`;
}

const minimalSchema = String.raw`const minimalHubSchema = type({
	op: type(
		"'send' | 'wait' | 'jobs' | 'cancel' | 'start' | 'ps' | 'logs' | 'stop' | 'restart' | 'describe'",
	).describe("hub operation"),
	"ids?": type("string[]").describe("wait: job ids to watch (omit = all running jobs); cancel: job ids to kill"),
	"timeoutMs?": type("number").describe("wait: timeout in milliseconds (0 waits indefinitely)"),
	"name?": type("string <= 48").describe("process ops: stable project-scoped launch name"),
	"application?": type("string > 0").describe("start: executable or application path"),
	"args?": type("string[]").describe("start: argv passed directly to the application"),
	"env?": type({ "[string]": "string" }).describe("start: extra environment variables"),
	"cwd?": type("string").describe("start: working directory; defaults to the session directory"),
	"pty?": type("boolean").describe("start: allocate an interactive PTY; default true"),
	"ready?": type({
		"log?": type("string > 0").describe("regex matched against output"),
		"port?": type("number").describe("TCP port that must accept connections"),
		"host?": type("string > 0").describe("TCP readiness host; default 127.0.0.1"),
		"timeout?": type("number > 0").describe("seconds to wait; default 30"),
	}).describe("start: readiness conditions; all supplied conditions must pass"),
	"restart?": type("'no' | 'on-failure' | 'always'").describe("start: restart policy; default no"),
	"persist?": type("boolean").describe("start: survive the last omp client exiting; default false"),
	"detached?": type("boolean").describe(
		"start: survive every omp and broker exit; implies persist and disables PTY input",
	),
	"lines?": type("number > 0").describe("logs: output lines; default 100, max 1000"),
	"head?": type("boolean").describe("logs: read from the beginning instead of the tail"),
	"grep?": type("string > 0").describe("logs: regex filter"),
	"follow?": type("boolean").describe("logs: wait for output newer than cursor"),
	"cursor?": type("number >= 0").describe("logs: output cursor returned by an earlier call"),
	"for?": type("'ready' | 'exit'").describe("wait with name: lifecycle condition; default exit"),
	"pattern?": type("string > 0").describe("wait with name: output regex; takes precedence over for"),
	"text?": type("string > 0").describe("send with name: stdin text"),
	"enter?": type("boolean").describe("send with name: append Enter after text; default true"),
	"keys?": type("string[]").describe("send with name: terminal keys after text"),
	"signal?": type("'SIGINT' | 'SIGTERM' | 'SIGHUP' | 'SIGQUIT' | 'SIGKILL'").describe(
		"send with name: process-tree signal",
	),
	"timeout?": type("number > 0").describe("logs/stop/wait with name: max seconds; default 30 (stop: 5)"),
});`;

const minimalExamples = String.raw`	readonly examples: readonly ToolExample<typeof hubSchema.infer>[] = [
		{
			caption: "Wait for the first background job to settle",
			call: { op: "wait" },
		},
		{
			caption: "Cancel a hung background job",
			call: { op: "cancel", ids: ["task_a1b2c3"] },
		},
		{
			caption: "Snapshot every background job without waiting",
			call: { op: "jobs" },
		},
		{
			caption: "Start a dev server and wait for its log banner and port",
			call: {
				op: "start",
				name: "web",
				application: "bun",
				args: ["run", "dev"],
				ready: { log: "Local:.*http", port: 5173, timeout: 30 },
			},
		},
		{
			caption: "Follow process output after a cursor",
			call: { op: "logs", name: "web", follow: true, cursor: 1842, timeout: 30 },
		},
		{
			caption: "Drive a REPL or debugger over stdin",
			call: { op: "send", name: "debugger", text: "breakpoint set --name main" },
		},
		{
			caption: "Block until a process is ready",
			call: { op: "wait", name: "web", for: "ready", timeout: 30 },
		},
	];
`;

const minimalPrompt = [
	"Background-job control and supervised long-running processes. Subagents are created through the task tool; Hub intentionally exposes no agent-to-agent messaging.",
	"",
	"# Jobs",
	"",
	"Background jobs auto-deliver when they finish. You do not need to poll while other useful work remains.",
	"",
	"- **`wait`**: use only when completely blocked. A bare wait watches every running job; `ids` narrows it to specific jobs. It returns when the first job settles or the wait window expires.",
	"- **`cancel`**: kill background jobs by `ids` when they have hung, stalled, or are no longer needed.",
	"- **`jobs`**: read a status snapshot of every background job and any running subagent that no longer has a job row.",
	"- Job rows are process-local and expire after settlement. Use `agent://<id>` or `history://<id>` for retained task output.",
	"- `completed` means the job exited successfully, not that its claimed changes are correct. Verify results.",
	"",
	"# Processes",
	"",
	"Project-scoped long-running processes are shared by every omp instance in the same directory. A service, watcher, debugger, REPL, or process needing later input must use `op:\"start\"`, not `bash`.",
	"",
	"- **`start`** launches `application` plus `args` directly. `cwd` defaults to the session directory; `pty` defaults true.",
	"  - `ready.log` is a regex and `ready.port` is a TCP port. When both are supplied, both must pass.",
	"  - Names are unique per project directory. Stop or restart an existing live name before reusing it.",
	"  - `restart` defaults to `no`; `on-failure` and `always` use bounded backoff.",
	"  - `persist: true` survives the last omp client; `detached: true` also survives broker shutdown and disables PTY input.",
	"- **`ps`**, **`logs`**, **`wait`** with `name`, **`send`** with `name`, **`stop`**, **`restart`**, and **`describe`** address the stable process name.",
	"- **`logs`** defaults to the last 100 lines. `head`, `grep`, `follow`, and `cursor` refine output.",
	"- **`wait`** with `name` blocks until readiness, exit, a matching `pattern`, or timeout.",
	"- **`send`** with `name` writes process stdin or terminal keys, or sends a process-tree signal.",
	"- **`stop`** performs graceful process-tree termination before hard kill. Never kill an unverified PID through bash.",
].join("\n");

let hub = await Bun.file(hubPath).text();
if (!hub.includes("const minimalHubSchema = type({")) {
	hub = replaceOnce(
		hub,
		"type HubParams = typeof hubSchema.infer;",
		`${minimalSchema}\n\ntype HubParams = typeof hubSchema.infer;`,
		"minimal schema insertion",
	);
	hub = replaceOnce(
		hub,
		'\treadonly summary = "Message peer agents, control background jobs, and supervise long-running processes";',
		'\treadonly summary = "Control background jobs and supervise long-running processes";',
		"Hub summary",
	);
	hub = replaceOnce(
		hub,
		"\treadonly parameters = hubSchema;",
		"\treadonly parameters = minimalHubSchema as unknown as typeof hubSchema;",
		"Hub parameter schema",
	);
	hub = replaceRange(
		hub,
		"\treadonly examples: readonly ToolExample<typeof hubSchema.infer>[] = [",
		"\n\tconstructor(private readonly session: ToolSession) {",
		minimalExamples,
		"Hub examples",
	);
	hub = replaceRange(
		hub,
		"\t#messaging(): MessagingDeps | null {",
		"\n\tasync execute(",
		"\t#messaging(): MessagingDeps | null {\n\t\t// Downstream fork policy: peer communication is not part of the exposed Hub.\n\t\treturn null;\n\t}\n",
		"Hub messaging gate",
	);
}

let jobs = await Bun.file(jobsPath).text();
const joblessAgentGuidance =
	"These agents have no job entry; message them via `hub` send, transcripts at `history://<id>`.";
if (jobs.includes(joblessAgentGuidance)) {
	jobs = replaceOnce(
		jobs,
		joblessAgentGuidance,
		"These agents have no job entry; inspect transcripts at `history://<id>` or cancel an owned child with `hub` cancel.",
		"jobless-agent guidance",
	);
	jobs = replaceOnce(
		jobs,
		"message it via \\`hub\\` send; transcript at history://${id}",
		"inspect its transcript at history://${id}",
		"no-matching-job guidance",
	);
}

if (!hub.includes("readonly parameters = minimalHubSchema as unknown as typeof hubSchema;")) {
	throw new Error("Fork patch verification failed: minimal Hub schema is not active.");
}
if (!hub.includes("Downstream fork policy: peer communication is not part of the exposed Hub.")) {
	throw new Error("Fork patch verification failed: peer messaging gate is not active.");
}
if (minimalPrompt.includes("op: \"list\"") || minimalPrompt.includes("with `to`")) {
	throw new Error("Fork patch verification failed: peer messaging leaked into the minimal prompt.");
}
if (jobs.includes(joblessAgentGuidance) || jobs.includes("message it via \\`hub\\` send")) {
	throw new Error("Fork patch verification failed: job output still recommends peer messaging.");
}

await Bun.write(hubPath, hub);
await Bun.write(jobsPath, jobs);
await Bun.write(promptPath, `${minimalPrompt}\n`);

console.log("Applied fork patches:");
console.log(`- ${path.relative(repoRoot, hubPath)}: minimal Hub schema and disabled peer messaging`);
console.log(`- ${path.relative(repoRoot, jobsPath)}: removed peer-messaging guidance`);
console.log(`- ${path.relative(repoRoot, promptPath)}: job/process-only Hub guidance`);
