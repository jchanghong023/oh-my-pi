#!/usr/bin/env bun
// Fork-local: PTY smoke test for the interactive TUI started by `bun run dev`.
// Spawns packages/coding-agent/src/cli.ts in a real PTY (ConPTY on Windows,
// openpty on POSIX) through the locally built pi-natives addon, waits for the
// full-screen interface to render, probes that the input loop is live, then
// exits the app cleanly. No network access, no auto-downloaded addons.
// Runs standalone (`bun scripts/fulltest-ui-smoke.ts [--debug]`) and as the
// final phase of `bun run fulltest`.
//
// A second PTY case exercises `/team` end to end: the TUI starts against the
// fixture's `smoke` provider configured with a local Anthropic Messages server
// that answers every stage marker with a schema-valid `yield` tool call, and
// the run must reach the observable final report in the transcript.
// A separate PTY case runs /repo against a temporary Python project and a
// loopback model stub; unlike the model, repository indexing and tools are real.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { IpcConnection, Process, PtySession } from "@oh-my-pi/pi-natives";
import { getOfflineShmState } from "@oh-my-pi/pi-natives/offline-root";
import { isEnoent, postmortem } from "@oh-my-pi/pi-utils";
import { removeWithRetries } from "@oh-my-pi/pi-utils/temp";
import { daemonBrokerEndpoint } from "../packages/coding-agent/src/launch/paths";
import {
	parseDaemonRpcResult,
	parseDaemonWireMessage,
	type DaemonWireRequest,
} from "../packages/coding-agent/src/launch/protocol";
import { runRepoSmoke } from "./repo-ui-smoke";
import { observeGateUnhandledFailures } from "./test-gate-failure-events";
import { GateCommandError, reportGateFailure } from "./test-gate-runtime";
import { beginTestRun, endTestRun, recordTestProducer, testReportPath, writeCommandCase } from "./test-reporting";

const repoRoot = path.resolve(import.meta.dir, "..");
observeGateUnhandledFailures();

interface Outcome {
	exitCode?: number;
	cancelled: boolean;
	timedOut: boolean;
}

const debugDump = process.argv.includes("--debug");
const teamOnly = process.argv.includes("--team-only");

// Both normal teardown and fatal cleanup must await fixture-owned brokers.
const stubServerCleanup: { run?: () => Promise<void> } = {};
const activeTuis = new Set<TuiHandle>();

async function cleanupSmokeFixture(): Promise<void> {
	const cleanup = stubServerCleanup.run;
	stubServerCleanup.run = undefined;
	await cleanup?.();
}

postmortem.register("ui-smoke-fixture", cleanupSmokeFixture);

async function removeFixture(configRoot: string): Promise<void> {
	// PTY completion only reaps the dev command. Detached brokers have their
	// own lease and idle shutdown; deleting first races their final meta writes.
	for (const handle of activeTuis) {
		try {
			handle.session.kill();
		} catch {}
		const exited = await Promise.race([handle.exitPromise, sleep(20_000).then(() => undefined)]);
		if (!exited) throw new Error("Fixture TUI did not exit before cleanup");
	}
	const runtimeRoot = path.join(configRoot, "run", "daemons");
	try {
		await fs.access(runtimeRoot);
	} catch (error) {
		if (!isEnoent(error)) throw error;
		await removeWithRetries(configRoot);
		return;
	}
	// Only authenticated scopes inside this mkdtemp root are ours. Never use
	// daemonClientForGlobal(), which would resolve the user's shared broker.
	for await (const tokenFile of new Bun.Glob("**/broker.token").scan(runtimeRoot)) {
		const runtimeDir = path.dirname(path.join(runtimeRoot, tokenFile));
		let lease: { pid: number };
		try {
			lease = JSON.parse(await fs.readFile(path.join(runtimeDir, "broker.pid"), "utf8")) as { pid: number };
		} catch (error) {
			if (isEnoent(error)) continue; // Already released; never spawn a replacement.
			throw error;
		}
		if (!Number.isInteger(lease.pid) || lease.pid <= 0)
			throw new Error(`Invalid fixture broker lease: ${runtimeDir}`);
		const broker = Process.fromPid(lease.pid);
		if (!broker || broker.status() === "exited") continue;
		let connection: IpcConnection | undefined;
		let timer: NodeJS.Timeout | undefined;
		try {
			const token = (await fs.readFile(path.join(runtimeDir, "broker.token"), "utf8")).trim();
			connection = await IpcConnection.connect(daemonBrokerEndpoint(runtimeDir), {
				framing: "lines",
				timeoutMs: 250,
			});
			const id = crypto.randomUUID();
			const response = Promise.withResolvers<void>();
			timer = setTimeout(() => response.reject(new Error("Fixture broker shutdown response timed out")), 5_000);
			connection.start(
				line => {
					try {
						const message = parseDaemonWireMessage(JSON.parse(line));
						if ("event" in message || message.id !== id) return;
						if (!message.ok) throw new Error(message.error);
						parseDaemonRpcResult({ op: "shutdown" }, message.result);
						response.resolve();
					} catch (error) {
						response.reject(error);
					}
				},
				() => response.reject(new Error("Fixture broker connection closed")),
			);
			console.log(`ui-smoke: releasing fixture broker (${runtimeDir})`);
			connection.send(JSON.stringify({ id, token, operation: { op: "shutdown" } } satisfies DaemonWireRequest));
			await response.promise;
		} catch (error) {
			// The normal idle timer may win the shutdown race. Only a stable
			// process-exit observation makes that an already-released scope.
			if (broker.status() !== "exited") throw error;
		} finally {
			clearTimeout(timer);
			connection?.destroy();
		}
		if (!(await broker.waitForExit({ timeoutMs: 5_000 }))) {
			throw new Error(`Fixture broker did not exit after shutdown: ${runtimeDir}`);
		}
	}
	await removeWithRetries(configRoot);
}

function dumpTail(handle: TuiHandle, bytes = 3500): void {
	const normalizedTail = normalizePtyOutput(handle.output).slice(-bytes);
	console.error(`ui-smoke: --- TUI output tail (normalized) ---\n${normalizedTail}\nui-smoke: --- end tail ---`);
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return true;
		await sleep(200);
	}
	return condition();
}

interface TuiHandle {
	session: PtySession;
	output: string;
	totalBytes: number;
	exitPromise: Promise<Outcome>;
}

function tuiEnvironment(env: Record<string, string | undefined>): Record<string, string> {
	// N-API accepts string values only; empty overrides also suppress
	// inherited flags in the PTY's environment overlay.
	return Object.fromEntries(
		Object.entries({
			...process.env,
			TERM: "xterm-256color",
			// Fixture roots must win over a user's whole-root override.
			OMP_CONFIG_ROOT: env.PI_CONFIG_DIR ? path.join(os.homedir(), env.PI_CONFIG_DIR) : "",
			// Loopback-model cases are online unless the fixture opts in.
			OMP_OFFLINE: "",
			...env,
			// This child is the real interactive CLI, not a headless test child.
			PI_TEST_RUNTIME: "",
		}).map(([key, value]) => [key, value ?? ""]),
	);
}

function startTui(argv: string[], env: Record<string, string | undefined>, projectCwd?: string): TuiHandle {
	const session = new PtySession();
	const handle: TuiHandle = {
		session,
		output: "",
		totalBytes: 0,
		exitPromise: Promise.resolve({ cancelled: false, timedOut: false }),
	};
	let exited: ((outcome: Outcome) => void) | undefined;
	const exitPromise = new Promise<Outcome>(resolve => {
		exited = resolve;
	});
	handle.exitPromise = exitPromise;
	activeTuis.add(handle);
	const result = session.startArgv(
		{
			application: process.execPath,
			args: ["run", "dev", ...(projectCwd ? ["--cwd", projectCwd] : []), ...argv],
			cwd: repoRoot,
			cols: 120,
			rows: 30,
			env: tuiEnvironment(env),
		},
		(error, chunk) => {
			if (error) {
				reportGateFailure(new GateCommandError(`PTY output failed: ${error.message}`, 1));
				return;
			}
			handle.output += chunk;
			handle.totalBytes += chunk.length;
			if (debugDump) process.stdout.write(chunk);
		},
		(error, pid) => {
			if (error) {
				reportGateFailure(new GateCommandError(`PTY child could not start: ${error.message}`, 1));
				console.error(`ui-smoke: failed to start PTY child: ${error.message}`);
			} else console.log(`ui-smoke: child pid ${pid}`);
		},
	);
	result.then(
		outcome => {
			if (outcome.exitCode !== 0 || outcome.cancelled || outcome.timedOut) {
				reportGateFailure(
					new GateCommandError(`PTY child failed: ${JSON.stringify(outcome)}`, outcome.exitCode || 1),
				);
			}
			activeTuis.delete(handle);
			exited?.(outcome as Outcome);
		},
		error => {
			activeTuis.delete(handle);
			exited?.({ exitCode: 1, cancelled: false, timedOut: false });
			fail(`PTY session failed: ${error instanceof Error ? error.message : String(error)}`, session);
		},
	);
	return handle;
}

function fail(message: string, ...sessions: PtySession[]): never {
	reportGateFailure(new GateCommandError(message, 1));
	console.error(`ui-smoke: FAIL — ${message}`);
	// The ConPTY/openpty handle dying with this process does not guarantee the
	// child dies with it; kill the dev TUI so failed runs leave no orphan. The
	// non-zero-exit path gets here after the child already tore the session
	// down, where kill() rejects — nothing left to clean up then.
	for (const session of sessions) {
		try {
			session.kill();
		} catch {}
	}
	// Throw so finally/postmortem can await child and broker teardown before exit.
	throw new Error(message);
}

/** Strip ANSI escape sequences and line wraps so assertions survive TUI repaints. */
function normalizePtyOutput(text: string): string {
	return text
		.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b[=>]/g, "")
		.replace(/[\r\n]+/g, "");
}

const timingRun = await beginTestRun("dev TUI PTY smoke scenarios");
// Fatal paths already await postmortem cleanup. Settle only our own report
// there; an inherited run belongs to the wrapper/gate, not this PTY child.
const cancelFailureReport = postmortem.register("ui-smoke-report", async () => {
	if (!timingRun.owner) return;
	const exitCode = Number(process.exitCode) || 1;
	process.exitCode = exitCode;
	try {
		await endTestRun(timingRun, exitCode);
	} catch (error) {
		reportGateFailure(new GateCommandError(error instanceof Error ? error.message : String(error), 1));
		// Match the reporting lifecycle: never retain running/0 metadata when
		// finalization itself failed.
		await fs.rm(path.join(timingRun.dir, "run.json"), { force: true });
		throw error;
	}
});
let caseStartedAt = new Date().toISOString();
let caseStarted = performance.now();
async function recordUiCase(name: string): Promise<void> {
	const durationSeconds = (performance.now() - caseStarted) / 1000;
	const reportPath = testReportPath(`ui-${name}`);
	await writeCommandCase(reportPath, "dev-tui/pty", name, durationSeconds, "passed");
	await recordTestProducer({
		producer: `dev-tui/${name}`,
		command: ["bun", "scripts/fulltest-ui-smoke.ts", ...process.argv.slice(2)],
		scope: name,
		concurrency: 1,
		startedAt: caseStartedAt,
		durationSeconds,
		exitCode: 0,
		reportPath,
		timingBasis: "one real PTY scenario wall time (seconds), including fixture work",
	});
	caseStartedAt = new Date().toISOString();
	caseStarted = performance.now();
}

if (process.argv.includes("--repo-only")) {
	await runRepoSmoke({ startTui, waitFor, normalizePtyOutput, sleep });
	await recordUiCase("repo-only");
	await endTestRun(timingRun, 0);
	cancelFailureReport();
	process.exit(0);
}

// ── 1. Startup render ────────────────────────────────────────────────────────
console.log("ui-smoke: waiting for the full-screen interface to render…");
const baseConfigRoot = await fs.mkdtemp(path.join(os.homedir(), ".omp-fulltest-base-smoke-"));
let baseRuntimeRoot = baseConfigRoot;
let baseShmDomain: string | undefined;
stubServerCleanup.run = async () => {
	await removeFixture(baseRuntimeRoot);
	if (baseShmDomain) {
		await removeWithRetries(baseShmDomain);
		await removeFixture(baseConfigRoot);
	}
};
// Startup/input/exit never submits a model request; keep any accidental target on loopback.
const baseClaudeDir = path.join(baseConfigRoot, "claude");
await Bun.write(
	path.join(baseClaudeDir, "settings.json"),
	JSON.stringify({
		env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:1", ANTHROPIC_AUTH_TOKEN: "ui-smoke-fixture" },
	}),
);
const baseEnv = tuiEnvironment({
	PI_CONFIG_DIR: path.basename(baseConfigRoot),
	OMP_CONFIG_ROOT: baseConfigRoot,
	OMP_PROFILE: "localci-ui",
	PI_PROFILE: "",
	OMP_OFFLINE: "1",
	CLAUDE_CONFIG_DIR: baseClaudeDir,
});
const baseShm = getOfflineShmState(baseEnv);
if (baseShm) {
	baseRuntimeRoot = baseShm.runtimeRoot;
	baseShmDomain = path.dirname(baseShm.runtimeRoot);
}
const baseAgentDir = path.join(baseRuntimeRoot, "profiles", "localci-ui", "agent");
await fs.mkdir(baseAgentDir, { recursive: true, mode: 0o700 });
await fs.writeFile(
	path.join(baseAgentDir, "config.yml"),
	"composer:\n  shape: pi\nstartup:\n  setupWizard: false\n  checkUpdate: false\n",
);
const main = startTui(["--profile", "localci-ui"], baseEnv);
const rendered = await waitFor(() => {
	// The TUI repaints in place: hides the cursor, positions it absolutely,
	// and paints the status line (whose "π" brand segment is present under
	// the fork-default `composer.shape=pi`). It does not use the alternate screen.
	const cursorControl =
		main.output.includes("\x1b[?25l") || main.output.includes("\x1b[H") || /\x1b\[\d+;\d+H/.test(main.output);
	return cursorControl && main.output.includes("π") && normalizePtyOutput(main.output).includes("Ctrl+T");
}, 120_000);
if (!rendered) {
	fail(
		`interface did not render within 120 s (bytes=${main.totalBytes}, cursorControl=${/\x1b\[\d+;\d+H/.test(main.output)}, mainMarker=${main.output.includes("π")})`,
		main.session,
	);
}
console.log(`ui-smoke: interface rendered (${main.totalBytes} bytes captured)`);

// ── 2. Liveness probe: a keypress must trigger a repaint ────────────────────
if (!teamOnly) {
	const bytesBefore = main.totalBytes;
	main.session.write("\x1b[Z"); // Shift-Tab (plan mode toggle): always handled by the composer
	await sleep(1_500);
	main.session.write("\x1b[Z"); // toggle back
	await sleep(1_500);
	if (main.totalBytes <= bytesBefore) {
		fail("no repaint after keypress; the input loop looks dead", main.session);
	}
	console.log(`ui-smoke: input loop alive (+${main.totalBytes - bytesBefore} bytes after keypress)`);
}

// ── 3. Clean exit ───────────────────────────────────────────────────────────
// Ctrl+D is the `app.exit` keybinding in both the startup composer and the
// main session: one press runs the graceful shutdown path (exit code 0).
// Ctrl+C needs a <500 ms double-press and exits 130 mid-teardown, so it is
// deliberately not used here.
console.log("ui-smoke: sending Ctrl+D to exit…");
main.session.write("\x04");
{
	const outcome = await Promise.race([main.exitPromise, sleep(20_000).then(() => undefined)]);
	if (!outcome) {
		fail("TUI did not exit within 20 s after Ctrl+D", main.session);
	}
	if (outcome.exitCode !== 0) {
		fail(`TUI exited with code ${outcome.exitCode} (expected 0)`);
	}
}
// Read the actual runtime artifact, not the original persistent fixture root.
await fs.access(path.join(baseAgentDir, "agent.db"));
if (baseShm) {
	try {
		await fs.access(path.join(baseConfigRoot, "profiles", "localci-ui", "agent", "agent.db"));
		fail("offline TUI wrote its active settings database under the persistent fixture root");
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
}
console.log("ui-smoke: base case PASS — dev TUI renders, reacts, and exits cleanly");
await cleanupSmokeFixture();
await recordUiCase("startup-render-liveness-and-exit");

// ── 4. /team end-to-end against a local stub Anthropic server ────────────────
// The `/team` case runs a real TUI whose session model and team.members use a
// fixture-only provider registered through the profile's models.yml. Every
// model call reaches the stub below. Each child subagent asks exactly one
// question; the stub answers with a `yield` tool_use carrying schema-valid
// stage data, so the full five-stage orchestrator runs for real and the final
// report must land in the transcript.
const TEAM_PROFILE = "localci-ui-team";
const teamConfigRoot = await fs.mkdtemp(path.join(os.homedir(), ".omp-fulltest-team-smoke-"));
stubServerCleanup.run = () => removeFixture(teamConfigRoot);
const TEAM_CONFIG_DIR_NAME = path.basename(teamConfigRoot);

interface StubRequestLog {
	model: string;
	stage: string;
	recheck?: boolean;
	target?: string;
	round?: number;
}

/** Plain-text SSE frames for main-session turns (no stage marker). */
function stubPlainTextBody(requestModel: string, text: string): string {
	stubMessageCounter += 1;
	const frames: string[] = [];
	frames.push(
		`event: message_start\ndata: ${JSON.stringify({
			type: "message_start",
			message: {
				id: `msg_stub_${stubMessageCounter}`,
				type: "message",
				role: "assistant",
				model: requestModel,
				content: [],
				stop_reason: null,
				usage: { input_tokens: 16, output_tokens: 8 },
			},
		})}\n\n`,
	);
	frames.push(
		`event: content_block_start\ndata: ${JSON.stringify({
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		})}\n\n`,
	);
	frames.push(
		`event: content_block_delta\ndata: ${JSON.stringify({
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text },
		})}\n\n`,
	);
	frames.push(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`);
	frames.push(
		`event: message_delta\ndata: ${JSON.stringify({
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { output_tokens: 24 },
		})}\n\n`,
	);
	frames.push(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
	return frames.join("");
}

const STUB_BLOCKING_ISSUE = "新增必填 options 参数会破坏不传该参数的旧调用。";
const STUB_DEFAULT_BLOCKING_ISSUE = "提案未定义 options 缺省时的行为，无法保证旧调用语义不变。";

function reviewPayload(target: string, round: number, recheck: boolean): Record<string, unknown> {
	if (!recheck) {
		return {
			noSubstantiveIssues: false,
			reviewSummary: "新增必填参数和缺省行为缺失分别阻断旧调用兼容性。",
			findings: [
				{
					severity: "blocking",
					issue: STUB_BLOCKING_ISSUE,
					impact: "既有调用缺少新参数，无法保持原接口行为。",
					evidence: "原始提案要求 options 必填；验收要求旧调用无需补传参数。",
					targetAspect: "接口兼容性",
				},
				{
					severity: "blocking",
					issue: STUB_DEFAULT_BLOCKING_ISSUE,
					impact: "即使参数可选，旧调用仍可能启用不同逻辑。",
					evidence: "原始提案未描述缺省分支；验收要求旧接口行为不变。",
					targetAspect: "缺省行为",
				},
			],
			blockingResolutions: [],
		};
	}
	return {
		noSubstantiveIssues: true,
		reviewSummary:
			round === 1
				? "参数已改为可选；只关闭参数必填阻断，缺省行为仍未明确。"
				: "缺省分支已明确保留原有逻辑，剩余阻断已解决。",
		findings: [],
		blockingResolutions:
			round === 1
				? [
						{
							findingId: `${target}-F1`,
							status: "resolved",
							basis: "第一轮修订明确将 options 改为可选，旧调用无需补传参数。",
						},
						{
							findingId: `${target}-F2`,
							status: "unresolved",
							basis: "第一轮只改变可选性，尚未定义未传 options 时的执行分支。",
						},
					]
				: [
						{
							findingId: `${target}-F2`,
							status: "resolved",
							basis: "第二轮修订明确未传 options 时完整执行原有逻辑。",
						},
					],
	};
}

function revisionPayload(target: string, round: number): Record<string, unknown> {
	return {
		revisedProposal:
			round === 1
				? "将 options 改为可选参数；缺省分支的行为仍待明确。"
				: "options 为可选参数；未传时完整执行原有逻辑，显式传入时启用新功能。",
		revisionSummary:
			round === 1 ? "取消必填要求，保留缺省行为待解决项。" : "明确缺省分支保留原有行为，关闭剩余兼容问题。",
		responses:
			round === 1
				? [
						{
							findingId: `${target}-F1`,
							disposition: "accepted-and-revised",
							explanation: "移除新增参数的必填要求，旧调用无需补传参数。",
						},
						{
							findingId: `${target}-F2`,
							disposition: "unresolved",
							explanation: "缺省分支尚未明确，不能宣称旧调用行为已保留。",
						},
					]
				: [
						{
							findingId: `${target}-F2`,
							disposition: "accepted-and-revised",
							explanation: "明确未传 options 时完整执行原有逻辑，仅显式传入才启用新功能。",
						},
					],
		reviewFlags: {
			changedCoreDesign: true,
			claimsResolvedBlocking: true,
			newEvidenceChangesAssumptions: false,
			disputesBlockingFinding: false,
		},
	};
}

function stagePayload(
	stage: string,
	recheck: boolean,
	target: string | undefined,
	round: number | undefined,
): Record<string, unknown> {
	switch (stage) {
		case "proposal":
			return {
				proposal: "在现有模块的导出接口上新增必填 options 参数，以配置新功能。",
				noViableProposal: false,
				investigationBlockedReason: "",
				keyAssumptions: [
					{
						content: "旧调用不传 options",
						basis: "保持旧接口的验收要求",
						status: "unverified",
						impactIfWrong: "兼容策略需要调整",
					},
				],
				risks: ["新增必填参数可能破坏旧调用"],
				unknowns: [],
				acceptanceCriteria: ["现有测试全绿", "旧接口行为不变"],
				ambiguityInterpretations: [{ ambiguity: "并发要求", interpretation: "单线程即可", impact: "吞吐上限" }],
				evidence: [{ claim: "新功能通过必填 options 参数配置", source: "本次 smoke 的原始提案正文" }],
			};
		case "alignment":
			return {
				unifiedUnderstanding: "统一理解：增加可配置的新功能，同时保持旧调用不传 options 时的原有行为。",
				acceptanceCriteria: ["功能可用", "旧调用无需补传参数且行为不变"],
				factDifferences: [],
				interpretationDifferences: [
					{
						ambiguity: "是否需要并发",
						interpretations: [{ view: "不需要", impact: "实现简单" }],
						affectsChoice: false,
					},
				],
			};
		case "review":
			if (!target || !round) throw new Error("stub: review marker requires target and round");
			return { ...reviewPayload(target, round, recheck) };
		case "revision":
			if (!target || !round) throw new Error("stub: revision marker requires target and round");
			return { ...revisionPayload(target, round) };
		case "synthesis":
			return {
				reportMarkdown:
					"### 需求与验收标准\n增加新功能，旧调用无需修改。\n\n### 核心方案\n方案 A：可选 options 参数，未传时保留旧行为。\n\n### 关键依据\n原始提案、修订记录与新审查者确认的阻断已解决结论。",
				recommendedProposal: "A",
				recommendationReason: "满足全部验收标准且改动最小",
				recommendationPreconditions: "旧调用保留缺省路径，修订后的接口必须经过兼容性验证",
				hardConstraintViolations: [],
			};
		default:
			throw new Error(`stub: unhandled stage ${stage}`);
	}
}

const stubRequests: StubRequestLog[] = [];
let stubMessageCounter = 0;
/** When > 0, team-stage requests sleep this long first (cancellation case). */
let slowTeamStagesMs = 0;

function stubSseBody(
	requestModel: string,
	input: Record<string, unknown>,
	withThinking: boolean,
	toolName = "yield",
): string {
	stubMessageCounter += 1;
	const frames: string[] = [];
	frames.push(
		`event: message_start\ndata: ${JSON.stringify({
			type: "message_start",
			message: {
				id: `msg_stub_${stubMessageCounter}`,
				type: "message",
				role: "assistant",
				model: requestModel,
				content: [],
				stop_reason: null,
				usage: { input_tokens: 16, output_tokens: 8 },
			},
		})}\n\n`,
	);
	let index = 0;
	if (withThinking) {
		frames.push(
			`event: content_block_start\ndata: ${JSON.stringify({
				type: "content_block_start",
				index,
				content_block: { type: "thinking", thinking: "", signature: "c3R1Yi1zaWduYXR1cmU=" },
			})}\n\n`,
		);
		frames.push(
			`event: content_block_delta\ndata: ${JSON.stringify({
				type: "content_block_delta",
				index,
				delta: { type: "thinking_delta", thinking: "ok" },
			})}\n\n`,
		);
		frames.push(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index })}\n\n`);
		index += 1;
	}
	frames.push(
		`event: content_block_start\ndata: ${JSON.stringify({
			type: "content_block_start",
			index,
			content_block: { type: "tool_use", id: `toolu_stub_${stubMessageCounter}`, name: toolName, input: {} },
		})}\n\n`,
	);
	frames.push(
		`event: content_block_delta\ndata: ${JSON.stringify({
			type: "content_block_delta",
			index,
			delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
		})}\n\n`,
	);
	frames.push(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index })}\n\n`);
	frames.push(
		`event: message_delta\ndata: ${JSON.stringify({
			type: "message_delta",
			delta: { stop_reason: "tool_use" },
			usage: { output_tokens: 64 },
		})}\n\n`,
	);
	frames.push(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
	return frames.join("");
}

function messageTexts(message: unknown): { texts: string[]; hasToolResult: boolean; toolResultFailed: boolean } {
	const content = (message as { content?: unknown }).content;
	const texts: string[] = [];
	let hasToolResult = false;
	let toolResultFailed = false;
	if (typeof content === "string") {
		texts.push(content);
	} else if (Array.isArray(content)) {
		for (const block of content) {
			if (typeof block !== "object" || block === null) continue;
			const type = (block as { type?: string }).type;
			if (type === "text") texts.push((block as { text?: string }).text ?? "");
			if (type === "tool_result") {
				hasToolResult = true;
				toolResultFailed ||= !("is_error" in block) || block.is_error !== false;
			}
		}
	}
	return { texts, hasToolResult, toolResultFailed };
}

const stubServer = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch: async request => {
		const url = new URL(request.url);
		if (request.method !== "POST" || !url.pathname.includes("/v1/messages")) {
			return new Response("not found", { status: 404 });
		}
		const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
		const requestModel = typeof body.model === "string" ? body.model : "stub-model";
		const messages = Array.isArray(body.messages) ? body.messages : [];
		let stage: string | undefined;
		let dispatchJobId: string | undefined;
		let recheck = false;
		let target: string | undefined;
		let round: number | undefined;
		for (const message of messages) {
			for (const text of messageTexts(message).texts) {
				const match = /\[team-stage:([a-z]+)([^\]]*)\]/.exec(text);
				if (match) {
					stage = match[1]!;
					recheck = /\brecheck\b/.test(match[2]!);
					target = /\btarget=([A-Z]+)\b/.exec(match[2]!)?.[1];
					const roundMatch = /\bround=(\d+)\b/.exec(match[2]!);
					round = roundMatch ? Number(roundMatch[1]) : undefined;
				}
				const dispatchMatch = /\[team-dispatch (bg_\w+)\]/.exec(text);
				if (dispatchMatch) dispatchJobId = dispatchMatch[1];
			}
		}
		if (!stage) {
			// Plain main-session turn. The LAST message decides the scripted reply:
			// - a CANCELTEAM text request → `write proc://<id>/kill` tool_use (the
			//   real user-facing cancellation path for /team background jobs);
			// - the tool-result follow-up of that write call → closing text;
			// - anything else → warm-up chatter.
			const last = messages.at(-1);
			const lastInfo = last ? messageTexts(last) : { texts: [], hasToolResult: false, toolResultFailed: false };
			const wantsCancel = lastInfo.texts.some(text => text.includes("CANCELTEAM"));
			if (wantsCancel && dispatchJobId) {
				stubRequests.push({ model: requestModel, stage: "proc-cancel" });
				return new Response(
					stubSseBody(requestModel, { path: `proc://${dispatchJobId}/kill`, content: "" }, false, "write"),
					{
						status: 200,
						headers: {
							"content-type": "text/event-stream",
							"request-id": `req_stub_${stubRequests.length}`,
						},
					},
				);
			}
			if (lastInfo.toolResultFailed) {
				return new Response("Cancellation tool returned an error", { status: 500 });
			}
			const closing = lastInfo.hasToolResult;
			stubRequests.push({ model: requestModel, stage: closing ? "main-close" : "main-chat" });
			return new Response(
				stubPlainTextBody(
					requestModel,
					closing ? "CANCELDONE 已取消该后台任务。" : "MAINOK 已了解上下文，请继续。",
				),
				{
					status: 200,
					headers: { "content-type": "text/event-stream", "request-id": `req_stub_${stubRequests.length}` },
				},
			);
		}
		stubRequests.push({ model: requestModel, stage, recheck, target, round });
		if (slowTeamStagesMs > 0) await sleep(slowTeamStagesMs);
		const withThinking = Boolean(body.thinking);
		return new Response(
			stubSseBody(requestModel, { data: stagePayload(stage, recheck, target, round) }, withThinking),
			{
				status: 200,
				headers: { "content-type": "text/event-stream", "request-id": `req_stub_${stubRequests.length}` },
			},
		);
	},
});
console.log(`ui-smoke: /team stub Anthropic server on 127.0.0.1:${stubServer.port}`);
stubServerCleanup.run = async () => {
	stubServer.stop(true);
	await removeFixture(teamConfigRoot);
};

let teamFailed = false;
try {
	const profileAgentDir = path.join(teamConfigRoot, "profiles", TEAM_PROFILE, "agent");
	await fs.mkdir(profileAgentDir, { recursive: true });
	await fs.writeFile(
		path.join(profileAgentDir, "config.yml"),
		[
			"team:",
			"  members:",
			"    - smoke/glm-5.2",
			"    - smoke/glm-4.6",
			"tools:",
			"  approval:",
			"    write: allow",
			"marketplace:",
			'  autoUpdate: "off"',
			"startup:",
			"  setupWizard: false",
			"  checkUpdate: false",
			"",
		].join("\n"),
		"utf8",
	);
	await fs.writeFile(
		path.join(profileAgentDir, "models.yml"),
		Bun.YAML.stringify({
			providers: {
				smoke: {
					api: "anthropic-messages",
					baseUrl: `http://127.0.0.1:${stubServer.port}`,
					apiKey: "smoke-fixture-key",
					auth: "apiKey",
					compat: { requiresToolResultId: true },
					models: ["glm-5.2", "glm-4.6"].map(id => ({
						id,
						reasoning: true,
						thinking: {
							mode: id === "glm-5.2" ? "anthropic-budget-effort" : "budget",
							efforts: id === "glm-5.2" ? ["high", "max"] : ["minimal", "low", "medium", "high"],
						},
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 200000,
						maxTokens: 32768,
					})),
				},
			},
		}),
		"utf8",
	);

	console.log("ui-smoke: starting /team TUI case…");
	const team = startTui(["--profile", TEAM_PROFILE, "--model", "smoke/glm-5.2"], {
		PI_CONFIG_DIR: TEAM_CONFIG_DIR_NAME,
		// Keep host offline defaults and Linux shm remapping out of this fixture.
		OMP_OFFLINE: "",
		OMP_PROFILE: TEAM_PROFILE,
		PI_PROFILE: "",
		PI_CODING_AGENT_DIR: "",
	});
	const teamRendered = await waitFor(() => {
		const cursorControl =
			team.output.includes("\x1b[?25l") || team.output.includes("\x1b[H") || /\x1b\[\d+;\d+H/.test(team.output);
		return cursorControl && team.output.includes("π") && normalizePtyOutput(team.output).includes("Ctrl+T");
	}, 120_000);
	if (!teamRendered) {
		dumpTail(team);
		fail("/team TUI did not render within 120 s", team.session);
	}
	// Warm the session with one plain chat turn first — the realistic /team
	// usage pattern (the report lands in an ongoing conversation) and it gives
	// the main-agent view a settled chat region before the command runs.
	// The greeting can land while the welcome animation still owns the input
	// path and get dropped, so re-send until the stub round-trip is confirmed.
	console.log("ui-smoke: /team TUI rendered; warming up with a plain chat turn…");
	let warmed = false;
	for (let attempt = 1; attempt <= 3 && !warmed; attempt++) {
		if (attempt > 1) console.log(`ui-smoke: warm-up not confirmed; re-sending greeting (attempt ${attempt})…`);
		team.session.write("简单打个招呼\r");
		warmed = await waitFor(() => normalizePtyOutput(team.output).includes("MAINOK"), 20_000);
	}
	if (!warmed) {
		dumpTail(team);
		fail("main-session warm-up turn did not complete within the retry budget", team.session);
	}
	// MAINOK matches mid-stream; let the warm-up turn settle before dispatch.
	// The final report itself waits for idle and is durably appended without
	// starting another model turn or entering a volatile next-turn queue.
	let settledBytes = team.totalBytes;
	let settled = false;
	for (let attempt = 0; attempt < 40; attempt++) {
		await sleep(500);
		if (team.totalBytes === settledBytes) {
			settled = true;
			break;
		}
		settledBytes = team.totalBytes;
	}
	if (!settled) console.log("ui-smoke: note — output still growing after warm-up; continuing anyway");
	console.log("ui-smoke: warm-up reply rendered; submitting /team command…");

	team.session.write("/team 如何在不破坏旧接口的前提下扩展模块？\r");

	// ASCII anchors: PTY chunks can split multibyte UTF-8, so the waits match
	// ASCII markers emitted by the controller/report, not Chinese prose.
	const dispatched = await waitFor(() => normalizePtyOutput(team.output).includes("[team-dispatch "), 60_000);
	if (!dispatched) {
		dumpTail(team);
		fail(
			`/team dispatch notice did not appear within 60 s (stub requests: ${stubRequests.map(r => r.stage).join(",") || "none"})`,
			team.session,
		);
	}
	console.log("ui-smoke: /team dispatched; waiting for the final report…");

	// Server-side ground truth first (the synthesis stage ran), then the
	// report's type marker in the transcript render. The dispatch breadcrumb
	// uses a distinct customType, so "team-result" can only come from the
	// final report frame.
	const synthesisArrived = await waitFor(() => stubRequests.some(request => request.stage === "synthesis"), 120_000);
	if (!synthesisArrived) {
		dumpTail(team);
		fail(
			`/team never reached the synthesis stage (stub requests: ${stubRequests.map(r => r.stage).join(",") || "none"})`,
			team.session,
		);
	}
	const completed = await waitFor(() => normalizePtyOutput(team.output).includes("team-result"), 60_000);
	if (!completed) {
		dumpTail(team);
		fail(
			`/team final report did not appear after synthesis (stub requests: ${stubRequests.map(r => r.stage).join(",")})`,
			team.session,
		);
	}
	// The failure message carries the distinct ASCII marker team-incomplete.
	if (normalizePtyOutput(team.output).includes("team-incomplete")) {
		dumpTail(team);
		fail("/team run finished with the incomplete marker instead of a report", team.session);
	}
	const stageCounts = new Map<string, number>();
	for (const request of stubRequests) {
		stageCounts.set(request.stage, (stageCounts.get(request.stage) ?? 0) + 1);
	}
	console.log(`ui-smoke: /team report rendered; stub stages: ${JSON.stringify([...stageCounts])}`);
	const initialReviewCount = stubRequests.filter(request => request.stage === "review" && !request.recheck).length;
	const recheckCount = stubRequests.filter(request => request.stage === "review" && request.recheck).length;
	if (
		(stageCounts.get("proposal") ?? 0) < 2 ||
		(stageCounts.get("alignment") ?? 0) < 1 ||
		initialReviewCount < 2 ||
		(stageCounts.get("revision") ?? 0) < 2 ||
		recheckCount < 2 ||
		(stageCounts.get("synthesis") ?? 0) < 1
	) {
		fail(`/team did not exercise the expected stages: ${JSON.stringify([...stageCounts])}`, team.session);
	}
	const reviewedTargets = new Set(
		stubRequests.filter(request => request.stage === "review" && !request.recheck).map(request => request.target),
	);
	for (const target of reviewedTargets) {
		for (const round of [1, 2]) {
			const revised = stubRequests.some(
				request => request.stage === "revision" && request.target === target && request.round === round,
			);
			const rechecked = stubRequests.some(
				request =>
					request.stage === "review" && request.recheck && request.target === target && request.round === round,
			);
			if (!target || !revised || !rechecked) {
				fail(`/team did not exercise partial closure for ${target}, round ${round}`, team.session);
			}
		}
	}

	team.session.write("\x04");
	const teamOutcome = await Promise.race([team.exitPromise, sleep(20_000).then(() => undefined)]);
	if (!teamOutcome) {
		fail("/team TUI did not exit within 20 s after Ctrl+D", team.session);
	}
	if (teamOutcome.exitCode !== 0) {
		fail(`/team TUI exited with code ${teamOutcome.exitCode} (expected 0)`);
	}
	let reportPersisted = false;
	for await (const file of new Bun.Glob("*/*.jsonl").scan(path.join(profileAgentDir, "sessions"))) {
		const entries = Bun.JSONL.parse(await Bun.file(path.join(profileAgentDir, "sessions", file)).text()) as {
			type?: string;
			customType?: string;
		}[];
		if (entries.some(entry => entry.type === "custom_message" && entry.customType === "team-result")) {
			reportPersisted = true;
			break;
		}
	}
	if (!reportPersisted) fail("/team report rendered but was not durably saved in the session");
	console.log("ui-smoke: /team case PASS — real TUI run rendered and persisted the final /team report");
	await recordUiCase("team-report-persisted");

	// ── 5. /team cancellation propagation against a slow stub ──────────────────
	// team.md §7 requires cancellation across concurrent subagents to be
	// verified in the UI smoke. Drives the real user-facing path: a chat turn
	// whose scripted reply issues `write proc://<id>/kill` (job cancel),
	// which aborts the job's signal; the propagation must reach every in-flight
	// subagent so no later stage (alignment/synthesis) is ever requested.
	console.log("ui-smoke: starting /team cancellation case…");
	slowTeamStagesMs = 6_000;
	const requestsBeforeCancel = stubRequests.length;
	const cancelTui = startTui(["--profile", TEAM_PROFILE, "--model", "smoke/glm-5.2"], {
		PI_CONFIG_DIR: TEAM_CONFIG_DIR_NAME,
		OMP_OFFLINE: "",
		OMP_PROFILE: TEAM_PROFILE,
		PI_PROFILE: "",
		PI_CODING_AGENT_DIR: "",
	});
	const cancelRendered = await waitFor(() => {
		const cursorControl =
			cancelTui.output.includes("\x1b[?25l") ||
			cancelTui.output.includes("\x1b[H") ||
			/\x1b\[\d+;\d+H/.test(cancelTui.output);
		return cursorControl && cancelTui.output.includes("π") && normalizePtyOutput(cancelTui.output).includes("Ctrl+T");
	}, 120_000);
	if (!cancelRendered) {
		dumpTail(cancelTui);
		fail("/team cancel TUI did not render within 120 s", cancelTui.session);
	}
	// Warm up like the success case: on a fresh session the dispatch
	// breadcrumb's first render can lag by seconds, and this case must issue
	// the cancel long before the slow proposals settle. Re-send on the same
	// dropped-greeting race the success case guards against.
	let cancelWarmed = false;
	for (let attempt = 1; attempt <= 3 && !cancelWarmed; attempt++) {
		if (attempt > 1) console.log(`ui-smoke: cancel warm-up not confirmed; re-sending greeting (attempt ${attempt})…`);
		cancelTui.session.write("简单打个招呼\r");
		cancelWarmed = await waitFor(() => normalizePtyOutput(cancelTui.output).includes("MAINOK"), 20_000);
	}
	if (!cancelWarmed) {
		dumpTail(cancelTui);
		fail("/team cancel case: warm-up turn did not complete", cancelTui.session);
	}
	{
		let settledBytes = cancelTui.totalBytes;
		let settled = false;
		for (let attempt = 0; attempt < 40; attempt++) {
			await sleep(500);
			if (cancelTui.totalBytes === settledBytes) {
				settled = true;
				break;
			}
			settledBytes = cancelTui.totalBytes;
		}
		if (!settled) console.log("ui-smoke: note — cancel case output still settling; continuing");
	}
	cancelTui.session.write("/team 再分析一个慢速问题\r");
	// Wait on the stub, not the TUI render: the slow proposals are in flight
	// the moment the first request lands, and the cancel must beat their 6 s
	// delay regardless of how fast the breadcrumb paints.
	const proposalInFlight = await waitFor(
		() => stubRequests.slice(requestsBeforeCancel).some(request => request.stage === "proposal"),
		30_000,
	);
	if (!proposalInFlight) {
		dumpTail(cancelTui);
		fail("/team cancel case: no proposal request reached the stub", cancelTui.session);
	}
	console.log("ui-smoke: proposals in flight; issuing proc:// cancel via a chat turn…");
	cancelTui.session.write("CANCELTEAM 请取消刚才的 /team 后台任务\r");
	const cancelConfirmed = await waitFor(() => normalizePtyOutput(cancelTui.output).includes("CANCELDONE"), 60_000);
	if (!cancelConfirmed) {
		dumpTail(cancelTui);
		fail(
			`/team cancel case: proc:// cancel round-trip did not complete (stub: ${stubRequests
				.slice(requestsBeforeCancel)
				.map(r => r.stage)
				.join(",")})`,
			cancelTui.session,
		);
	}
	// The slow stage delay gives uncancelled runs plenty of time to advance;
	// none of the post-fan-out stages may appear after the cancel turn.
	await sleep(12_000);
	const lateStages = stubRequests
		.slice(requestsBeforeCancel)
		.filter(
			request =>
				request.stage === "alignment" ||
				request.stage === "review" ||
				request.stage === "revision" ||
				request.stage === "synthesis",
		);
	if (lateStages.length > 0) {
		fail(
			`/team cancel case: stages ran after cancellation (${lateStages.map(r => r.stage).join(",")})`,
			cancelTui.session,
		);
	}
	cancelTui.session.write("\x04");
	const cancelOutcome = await Promise.race([cancelTui.exitPromise, sleep(20_000).then(() => undefined)]);
	if (!cancelOutcome) {
		fail("/team cancel TUI did not exit within 20 s after Ctrl+D", cancelTui.session);
	}
	if (cancelOutcome.exitCode !== 0) {
		fail(`/team cancel TUI exited with code ${cancelOutcome.exitCode} (expected 0)`);
	}
	console.log("ui-smoke: /team cancellation case PASS — cancel reached the orchestrator before any later stage");
} catch (error) {
	reportGateFailure(new GateCommandError(error instanceof Error ? error.message : String(error), 1));
	teamFailed = true;
	throw error;
} finally {
	await cleanupSmokeFixture().catch(error => {
		reportGateFailure(new GateCommandError(error instanceof Error ? error.message : String(error), 1));
		console.error(`ui-smoke: team fixture cleanup failed: ${String(error)}`);
		if (!teamFailed) throw error;
	});
}

await recordUiCase("team-cancel-propagation");
await runRepoSmoke({ startTui, waitFor, normalizePtyOutput, sleep });
await recordUiCase("repo-index-e2e");

await endTestRun(timingRun, 0);
cancelFailureReport();
console.log("ui-smoke: PASS — dev TUI renders/exits, /team runs/cancels, and /repo operates end to end");
