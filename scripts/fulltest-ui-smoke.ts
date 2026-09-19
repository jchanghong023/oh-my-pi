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
// fork's `zcode-api` lane pointed at a local stub Anthropic Messages server
// that answers every stage marker with a schema-valid `yield` tool call, and
// the run must reach the observable final report in the transcript.

import * as fs from "node:fs/promises";
import { rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PtySession } from "@oh-my-pi/pi-natives";

const repoRoot = path.resolve(import.meta.dir, "..");

interface Outcome {
	exitCode?: number;
	cancelled: boolean;
	timedOut: boolean;
}

const debugDump = process.argv.includes("--debug");
const teamOnly = process.argv.includes("--team-only");

// Filled once the /team stub server exists. fail() exits the process, which
// bypasses the try/finally that normally stops the server and removes the team
// config root — this cleanup gives the failure path the same teardown. Declared
// before any fail() call site can run: base-case failures happen before the
// server (and teamConfigRoot below) even exist, and `.run?.()` must stay a
// no-op there rather than hit a temporal dead zone.
const stubServerCleanup: { run?: () => void } = {};

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

function startTui(argv: string[], env: Record<string, string>): TuiHandle {
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
	const result = session.startArgv(
		{
			application: process.execPath,
			args: ["--cwd=packages/coding-agent", "src/cli.ts", ...argv],
			cwd: repoRoot,
			cols: 120,
			rows: 30,
			env: {
				...process.env,
				TERM: "xterm-256color",
				...env,
			} as Record<string, string>,
		},
		(error, chunk) => {
			if (error) return;
			handle.output += chunk;
			handle.totalBytes += chunk.length;
			if (debugDump) process.stdout.write(chunk);
		},
		(error, pid) => {
			if (error) console.error(`ui-smoke: failed to start PTY child: ${error.message}`);
			else console.log(`ui-smoke: child pid ${pid}`);
		},
	);
	result.then(
		outcome => exited?.(outcome as Outcome),
		error => fail(`PTY session failed: ${error instanceof Error ? error.message : String(error)}`, session),
	);
	return handle;
}

function fail(message: string, ...sessions: PtySession[]): never {
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
	// process.exit() below skips the try/finally cleanup, so run it here too.
	stubServerCleanup.run?.();
	process.exit(1);
}

/** Strip ANSI escape sequences and line wraps so assertions survive TUI repaints. */
function normalizePtyOutput(text: string): string {
	return text
		.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b[=>]/g, "")
		.replace(/[\r\n]+/g, "");
}

// ── 1. Startup render ────────────────────────────────────────────────────────
console.log("ui-smoke: waiting for the full-screen interface to render…");
const main = startTui(["--offline", "--profile", "localci-ui"], {});
const rendered = await waitFor(() => {
	// The TUI repaints in place: hides the cursor, positions it absolutely,
	// and paints the status line (whose "π" brand segment is present under
	// the fork-default `composer.shape=pi`). It does not use the alternate screen.
	const cursorControl =
		main.output.includes("\x1b[?25l") || main.output.includes("\x1b[H") || /\x1b\[\d+;\d+H/.test(main.output);
	return cursorControl && main.output.includes("π") && main.totalBytes > 4_000;
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
		main.session.kill();
		fail("TUI did not exit within 20 s after Ctrl+D");
	}
	if (outcome.exitCode !== 0) {
		fail(`TUI exited with code ${outcome.exitCode} (expected 0)`);
	}
}
console.log("ui-smoke: base case PASS — dev TUI renders, reacts, and exits cleanly");

// ── 4. /team end-to-end against a local stub Anthropic server ────────────────
// The `/team` case runs a real TUI (no --offline) whose session model and
// team.members point at the fork's zcode-api lane; ZCODE_API_BASE_URL routes
// every model call to the stub below. Each child subagent asks exactly one
// question; the stub answers with a `yield` tool_use carrying schema-valid
// stage data, so the full five-stage orchestrator runs for real and the final
// report must land in the transcript.
const TEAM_PROFILE = "localci-ui-team";
const TEAM_CONFIG_DIR_NAME = ".omp-fulltest-team-smoke";
const teamConfigRoot = path.join(os.homedir(), TEAM_CONFIG_DIR_NAME);

interface StubRequestLog {
	model: string;
	stage: string;
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

function stagePayload(stage: string): Record<string, unknown> {
	switch (stage) {
		case "proposal":
			return {
				proposal: "方案：扩展现有模块并保持旧接口不变；改动集中在单一模块内。",
				noViableProposal: false,
				keyAssumptions: [
					{ content: "旧接口稳定", basis: "src/module.ts", status: "unverified", impactIfWrong: "需要适配层" },
				],
				risks: ["回归风险"],
				unknowns: [],
				acceptanceCriteria: ["现有测试全绿", "旧接口行为不变"],
				ambiguityInterpretations: [{ ambiguity: "并发要求", interpretation: "单线程即可", impact: "吞吐上限" }],
				evidence: [{ claim: "模块存在", source: "src/module.ts" }],
			};
		case "alignment":
			return {
				unifiedUnderstanding: "统一理解：扩展模块且不破坏旧接口。",
				acceptanceCriteria: ["功能可用", "旧接口不破坏"],
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
			return {
				noSubstantiveIssues: true,
				reviewSummary: "未发现实质问题。",
				findings: [],
				priorBlockingStatus: "not-applicable",
			};
		case "synthesis":
			return {
				reportMarkdown:
					"### 需求与验收标准\n扩展模块，旧接口不破坏。\n\n### 核心方案\n方案 A：模块内扩展。\n\n### 关键依据\nsrc/module.ts。",
				recommendedProposal: "A",
				recommendationReason: "满足全部验收标准且改动最小",
				recommendationPreconditions: "旧接口稳定",
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

function messageTexts(message: unknown): { texts: string[]; hasToolResult: boolean } {
	const content = (message as { content?: unknown }).content;
	const texts: string[] = [];
	let hasToolResult = false;
	if (typeof content === "string") {
		texts.push(content);
	} else if (Array.isArray(content)) {
		for (const block of content) {
			if (typeof block !== "object" || block === null) continue;
			const type = (block as { type?: string }).type;
			if (type === "text") texts.push((block as { text?: string }).text ?? "");
			if (type === "tool_result") hasToolResult = true;
		}
	}
	return { texts, hasToolResult };
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
		for (const message of messages) {
			for (const text of messageTexts(message).texts) {
				const match = /\[team-stage:([a-z]+)/.exec(text);
				if (match) stage = match[1]!;
				const dispatchMatch = /\[team-dispatch (bg_\w+)\]/.exec(text);
				if (dispatchMatch) dispatchJobId = dispatchMatch[1];
			}
		}
		if (!stage) {
			// Plain main-session turn. The LAST message decides the scripted reply:
			// - a CANCELTEAM text request → hub cancel tool_use (the real
			//   user-facing cancellation path for /team background jobs);
			// - the tool-result follow-up of that hub call → closing text;
			// - anything else → warm-up chatter.
			const last = messages.at(-1);
			const lastInfo = last ? messageTexts(last) : { texts: [], hasToolResult: false };
			const wantsCancel = lastInfo.texts.some(text => text.includes("CANCELTEAM"));
			if (wantsCancel && dispatchJobId) {
				stubRequests.push({ model: requestModel, stage: "hub-cancel" });
				return new Response(stubSseBody(requestModel, { op: "cancel", ids: [dispatchJobId] }, false, "hub"), {
					status: 200,
					headers: {
						"content-type": "text/event-stream",
						"request-id": `req_stub_${stubRequests.length}`,
					},
				});
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
		stubRequests.push({ model: requestModel, stage });
		if (slowTeamStagesMs > 0) await sleep(slowTeamStagesMs);
		const withThinking = Boolean(body.thinking);
		return new Response(stubSseBody(requestModel, { data: stagePayload(stage) }, withThinking), {
			status: 200,
			headers: { "content-type": "text/event-stream", "request-id": `req_stub_${stubRequests.length}` },
		});
	},
});
console.log(`ui-smoke: /team stub Anthropic server on 127.0.0.1:${stubServer.port}`);
stubServerCleanup.run = () => {
	try {
		stubServer.stop(true);
	} catch {}
	try {
		rmSync(teamConfigRoot, { recursive: true, force: true });
	} catch {}
};

try {
	const profileAgentDir = path.join(teamConfigRoot, "profiles", TEAM_PROFILE, "agent");
	await fs.mkdir(profileAgentDir, { recursive: true });
	await fs.writeFile(
		path.join(profileAgentDir, "config.yml"),
		[
			"team:",
			"  members:",
			"    - zcode-api/glm-5.2",
			"    - zcode-api/glm-4.6",
			"marketplace:",
			'  autoUpdate: "off"',
			"startup:",
			"  setupWizard: false",
			"  checkUpdate: false",
			"",
		].join("\n"),
		"utf8",
	);

	console.log("ui-smoke: starting /team TUI case…");
	const team = startTui(["--profile", TEAM_PROFILE, "--model", "zcode-api/glm-5.2"], {
		ZCODE_API_BASE_URL: `http://127.0.0.1:${stubServer.port}`,
		PI_CONFIG_DIR: TEAM_CONFIG_DIR_NAME,
	});
	const teamRendered = await waitFor(() => {
		const cursorControl =
			team.output.includes("\x1b[?25l") || team.output.includes("\x1b[H") || /\x1b\[\d+;\d+H/.test(team.output);
		return cursorControl && team.output.includes("π") && team.totalBytes > 4_000;
	}, 120_000);
	if (!teamRendered) {
		dumpTail(team);
		fail("/team TUI did not render within 120 s", team.session);
	}
	// Warm the session with one plain chat turn first — the realistic /team
	// usage pattern (the report lands in an ongoing conversation) and it gives
	// the main-agent view a settled chat region before the command runs.
	console.log("ui-smoke: /team TUI rendered; warming up with a plain chat turn…");
	team.session.write("简单打个招呼\r");
	const warmed = await waitFor(() => normalizePtyOutput(team.output).includes("MAINOK"), 60_000);
	if (!warmed) {
		dumpTail(team);
		fail("main-session warm-up turn did not complete within 60 s", team.session);
	}
	// MAINOK matches mid-stream; wait for the turn to settle so /team is
	// dispatched against an idle session (otherwise the report custom message
	// queues as a hidden next-turn message instead of appending immediately).
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
	if (
		(stageCounts.get("proposal") ?? 0) < 2 ||
		(stageCounts.get("alignment") ?? 0) < 1 ||
		(stageCounts.get("review") ?? 0) < 2 ||
		(stageCounts.get("synthesis") ?? 0) < 1
	) {
		fail(`/team did not exercise the expected stages: ${JSON.stringify([...stageCounts])}`, team.session);
	}

	team.session.write("\x04");
	const teamOutcome = await Promise.race([team.exitPromise, sleep(20_000).then(() => undefined)]);
	if (!teamOutcome) {
		team.session.kill();
		fail("/team TUI did not exit within 20 s after Ctrl+D");
	}
	if (teamOutcome.exitCode !== 0) {
		fail(`/team TUI exited with code ${teamOutcome.exitCode} (expected 0)`);
	}
	console.log("ui-smoke: /team case PASS — real TUI run reached the final /team report");

	// ── 5. /team cancellation propagation against a slow stub ──────────────────
	// team.md §7 requires cancellation across concurrent subagents to be
	// verified in the UI smoke. Drives the real user-facing path: a chat turn
	// whose scripted reply calls the `hub` tool with op=cancel, which aborts
	// the job's signal; the propagation must reach every in-flight subagent so
	// no later stage (alignment/synthesis) is ever requested.
	console.log("ui-smoke: starting /team cancellation case…");
	slowTeamStagesMs = 6_000;
	const requestsBeforeCancel = stubRequests.length;
	const cancelTui = startTui(["--profile", TEAM_PROFILE, "--model", "zcode-api/glm-5.2"], {
		ZCODE_API_BASE_URL: `http://127.0.0.1:${stubServer.port}`,
		PI_CONFIG_DIR: TEAM_CONFIG_DIR_NAME,
	});
	const cancelRendered = await waitFor(() => {
		const cursorControl =
			cancelTui.output.includes("\x1b[?25l") ||
			cancelTui.output.includes("\x1b[H") ||
			/\x1b\[\d+;\d+H/.test(cancelTui.output);
		return cursorControl && cancelTui.output.includes("π") && cancelTui.totalBytes > 4_000;
	}, 120_000);
	if (!cancelRendered) {
		dumpTail(cancelTui);
		fail("/team cancel TUI did not render within 120 s", cancelTui.session);
	}
	// Warm up like the success case: on a fresh session the dispatch
	// breadcrumb's first render can lag by seconds, and this case must issue
	// the cancel long before the slow proposals settle.
	cancelTui.session.write("简单打个招呼\r");
	const cancelWarmed = await waitFor(() => normalizePtyOutput(cancelTui.output).includes("MAINOK"), 60_000);
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
	console.log("ui-smoke: proposals in flight; issuing hub cancel via a chat turn…");
	cancelTui.session.write("CANCELTEAM 请取消刚才的 /team 后台任务\r");
	const cancelConfirmed = await waitFor(() => normalizePtyOutput(cancelTui.output).includes("CANCELDONE"), 60_000);
	if (!cancelConfirmed) {
		dumpTail(cancelTui);
		fail(
			`/team cancel case: hub cancel round-trip did not complete (stub: ${stubRequests
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
		.filter(request => request.stage === "alignment" || request.stage === "review" || request.stage === "synthesis");
	if (lateStages.length > 0) {
		fail(
			`/team cancel case: stages ran after cancellation (${lateStages.map(r => r.stage).join(",")})`,
			cancelTui.session,
		);
	}
	cancelTui.session.write("\x04");
	const cancelOutcome = await Promise.race([cancelTui.exitPromise, sleep(20_000).then(() => undefined)]);
	if (!cancelOutcome) {
		cancelTui.session.kill();
		fail("/team cancel TUI did not exit within 20 s after Ctrl+D");
	}
	if (cancelOutcome.exitCode !== 0) {
		fail(`/team cancel TUI exited with code ${cancelOutcome.exitCode} (expected 0)`);
	}
	console.log("ui-smoke: /team cancellation case PASS — cancel reached the orchestrator before any later stage");
} finally {
	stubServer.stop(true);
	await fs.rm(teamConfigRoot, { recursive: true, force: true }).catch(() => {});
}

console.log("ui-smoke: PASS — dev TUI renders, reacts, exits cleanly, /team runs end to end, and cancels cleanly");
