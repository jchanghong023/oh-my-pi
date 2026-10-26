import { expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";
import type { SpecSavedRun } from "../../src/spec-driven/types";
import {
	contentText,
	createProviderFixture,
	MARKER,
	rolePayload,
	type ModelRequest,
	type ProviderFixture,
	type ProviderScenario,
	type Reply,
} from "./provider-fixture";

const tuiTest = Bun.which("tui-test");
const repo = path.resolve(import.meta.dir, "../../../..");
if (!tuiTest) console.warn("SKIP native Dev public smoke: tui-test is not installed; no TUI behavior was exercised.");
type State = { team: boolean; run?: SpecSavedRun };
type Scenario = ProviderScenario & {
	dialogue?: (request: ModelRequest, input: Record<string, unknown>, signal: AbortSignal) => Reply | Promise<Reply>;
	reply?: (request: ModelRequest) => Reply | Promise<Reply>;
	setup?: (cwd: string) => Promise<void>;
};

async function eventually<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
	const deadline = Date.now() + 60_000;
	let value = await read();
	while (!predicate(value)) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for native state: ${JSON.stringify(value)}`);
		await Bun.sleep(50);
		value = await read();
	}
	return value;
}

async function nativeDraftSnapshot(tui: (...args: string[]) => Promise<string>) {
	// state returns the caret and decoded viewport together. Unlike plain
	// painted text, the caret distinguishes real input from inline usage.
	const state = await tui("state");
	if (/^exited: (?!null(?:\r?$))\S+/mu.test(state))
		throw new Error(`Native TUI exited before draft restoration: ${state}`);
	const cursorLine = /^cursor: (.+)$/mu.exec(state);
	const titleLine = /^title:.*\r?\n/mu.exec(state);
	const cursor: unknown = cursorLine && JSON.parse(cursorLine[1]!);
	if (!titleLine || !isRecord(cursor) || typeof cursor.x !== "number" || typeof cursor.y !== "number")
		throw new Error(`Native TUI state lacks a viewport/caret: ${state}`);
	return {
		screen: state.slice(titleLine.index + titleLine[0].length),
		cursor: { x: cursor.x, y: cursor.y },
	};
}

function nativeDraftMatches(screen: string, expected: string, cursor?: { x: number; y: number }): boolean {
	const lines = screen.split("\n");
	const dev = lines.findIndex(line => line.includes("Dev ·"));
	const start = lines.findLastIndex((line, index) => index > dev && line.startsWith("╭── "));
	if (start < 0) return false;
	const end = lines.findIndex((line, index) => index > start && line.startsWith("╰─"));
	if (end < 0) return false;
	if (cursor) {
		if (!expected) return cursor.y === start + 1 && cursor.x === 3;
		if (cursor.y !== end - 1) return false;
	}
	const rows = lines.slice(start + 1, end);
	if (!rows.length) return false;
	let remaining = expected;
	for (const [index, row] of rows.entries()) {
		if (!row.startsWith("│  ") || row.lastIndexOf("│") < 3) return false;
		const limit = cursor && index === rows.length - 1 ? cursor.x : row.lastIndexOf("│");
		const text = row.slice(3, limit).trimEnd();
		// Submitted control commands are one logical line. Extra blank rows
		// mean another draft/keypress was merged into it, not exact restoration.
		if (!text || !remaining.startsWith(text)) return false;
		remaining = remaining.slice(text.length);
		// Word wrapping omits the boundary space from the painted row.
		if (index < rows.length - 1 && remaining.startsWith(" ")) remaining = remaining.slice(1);
	}
	return remaining.length === 0;
}

async function expectRestoredNativeDraft(tui: (...args: string[]) => Promise<string>, expected: string): Promise<void> {
	// Identical errors can leave the previous fixed error visible until this
	// submission settles. Only this command's exact composer contents prove
	// restoration; neither chat history nor the Dev action row is evidence.
	await eventually(
		() => nativeDraftSnapshot(tui),
		({ screen, cursor }) => nativeDraftMatches(screen, expected, cursor),
	);
	// The confirmed draft is one complete logical line, so native Home is
	// now its actual beginning, not an empty line in a still-pending restore.
	const probe = `preserved-input-${crypto.randomUUID()}-`;
	await tui("key", "press", "Home");
	await tui("type", probe);
	await tui("key", "press", "End");
	await eventually(
		() => nativeDraftSnapshot(tui),
		({ screen, cursor }) => nativeDraftMatches(screen, `${probe}${expected}`, cursor),
	);
}

const lastDraftClear = new WeakMap<(...args: string[]) => Promise<string>, number>();
async function clearNativeDraft(tui: (...args: string[]) => Promise<string>, restoredText?: string): Promise<void> {
	if (restoredText) await expectRestoredNativeDraft(tui, restoredText);
	// Native app.clear (Ctrl+C) clears the entire multiline draft. Ctrl+U
	// only kills text before the cursor on one line. The native second
	// Ctrl+C within 500ms exits, so keep independent clear gestures apart.
	const remaining = 501 - (Date.now() - (lastDraftClear.get(tui) ?? 0));
	if (remaining > 0) await Bun.sleep(remaining);
	await tui("key", "press", "Ctrl+C");
	// A following identical command must see the clear key consumed, not
	// mistake the previous restored draft for its own completion. Empty
	// composer placeholders can paint after the caret; they are not input.
	await eventually(
		() => nativeDraftSnapshot(tui),
		({ screen, cursor }) => nativeDraftMatches(screen, "", cursor),
	);
	// The empty caret acknowledges consumption of Ctrl+C. Measure the
	// double-interrupt window from that acknowledgment, not PTY delivery.
	lastDraftClear.set(tui, Date.now());
}

async function expectNativeFailure(
	tui: (...args: string[]) => Promise<string>,
	reason: RegExp,
	detail?: string,
	submittedText?: string,
): Promise<void> {
	// Dev strips the command host's generic prefix and displays the actual
	// cause in its fixed third row. Failed entry remains in ordinary TUI.
	await eventually(
		() => tui("text"),
		screen => {
			const lines = screen.split("\n");
			const bar = lines.findIndex(line => line.includes("Dev ·"));
			return bar >= 0 && reason.test(lines[bar + 2] ?? "");
		},
	);
	if (!detail) return;
	const normalize = (text: string) => text.replace(/\\+/gu, "/").replace(/[│┃║┆┊█\s]/gu, "");
	// Only after proving automatic draft restoration, clear the whole line
	// deliberately for navigation. submit() appends; it does not replace it.
	await clearNativeDraft(tui, submittedText);
	await tui("submit", "/session");
	await tui("expect", "text", "Session Info", "--timeout", "30000");
	await tui("key", "press", "Home");
	const screens: string[] = [];
	for (let index = 0; index < 100; index++) {
		const screen = await tui("text");
		screens.push(normalize(screen));
		if (screens.join("").includes(normalize(detail))) break;
		// PTY key completion and visual idle do not acknowledge the next
		// render. Collect another viewport only after this scroll is painted.
		await tui("key", "press", "Shift+Down");
		await eventually(
			() => tui("text"),
			next => next !== screen,
		);
	}
	expect(screens.join("")).toContain(normalize(detail));
	await tui("key", "press", "Escape");
}

// tui-test owns the PTY and terminal decoding. The provider only returns SSE/native tool requests.
async function withTui(
	scenario: Scenario,
	size: [number, number],
	run: (h: {
		cwd: string;
		provider: ProviderFixture;
		tui: (...args: string[]) => Promise<string>;
		state: () => Promise<State>;
		idle: () => Promise<void>;
		stage: (phase: string) => Promise<State>;
		restart: () => Promise<void>;
		open: (directory: string) => Promise<{ tui: (...args: string[]) => Promise<string>; close: () => Promise<void> }>;
	}) => Promise<void>,
): Promise<void> {
	await using root = await TempDir.create("@omp-dev-native-tui-");
	await using provider = createProviderFixture(scenario);
	const cwd = root.join("project");
	const home = root.join("home");
	const agentDir = root.join("config", "agent");
	const temp = root.join("tmp");
	for (const directory of [cwd, home, agentDir, temp]) await fs.mkdir(directory, { recursive: true });
	await scenario.setup?.(cwd);
	// Empty inherited credentials explicitly: tui-test's PTY server may also
	// inherit them, so merely omitting them from --env would not isolate it.
	const env = {
		...Object.fromEntries(
			Object.entries(process.env).map(([key, value]) => [
				key,
				/(?:key|token|secret|password|credential|authorization|(?:^|_)auth(?:_|$))/i.test(key) ? "" : value,
			]),
		),
		TZ: "UTC",
		OMP_CONFIG_ROOT: root.join("config"),
		PI_CODING_AGENT_DIR: agentDir,
		PI_CONFIG_DIR: ".omp",
		OMP_PROFILE: "default",
		PI_PROFILE: "",
		HOME: home,
		USERPROFILE: home,
		TEMP: temp,
		TMP: temp,
		OMP_OFFLINE: "0",
		PI_NO_TITLE: "1",
		PI_TEST_RUNTIME: "",
		NO_PROXY: "127.0.0.1,localhost",
		OPENSPEC_TELEMETRY: "0",
		DO_NOT_TRACK: "1",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: root.join("gitconfig"),
		GIT_CONFIG_COUNT: "0",
	};
	await Bun.write(
		path.join(agentDir, "models.yml"),
		`providers:\n  spec-fixture:\n    baseUrl: ${provider.baseUrl}\n    auth: none\n    api: openai-completions\n    models:\n      - id: chat-a\n        reasoning: false\n        input: [text, image]\n        contextWindow: 200000\n`,
	);
	await Bun.write(
		path.join(agentDir, "config.yml"),
		"modelRoles:\n  default: spec-fixture/chat-a\n  smol: spec-fixture/chat-a\ncomposer:\n  predictions: false\nstartup:\n  setupWizard: false\n  checkUpdate: false\nasync:\n  enabled: false\n",
	);
	const session = `dev-native-${crypto.randomUUID()}`;
	const commandStderr: Array<{ args: string[]; code: number; stderr: string }> = [];
	async function invoke(target: string, ...args: string[]): Promise<string> {
		if (!tuiTest) throw new Error("tui-test is required");
		const child = Bun.spawn([tuiTest, "--session", target, ...args], {
			cwd: repo,
			env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (stderr || code !== 0) commandStderr.push({ args, code, stderr });
		if (code !== 0) throw new Error(`tui-test ${args.join(" ")} exited ${code}:\n${stdout}\n${stderr}`);
		return stdout;
	}
	const tui = (...args: string[]) => invoke(session, ...args);
	const peers = new Set<string>();
	async function start(target: string, directory: string): Promise<void> {
		await invoke(
			target,
			"run",
			"--cwd",
			repo,
			"--cols",
			String(size[0]),
			"--rows",
			String(size[1]),
			...Object.entries(env)
				.filter((entry): entry is [string, string] => entry[1] !== undefined)
				.flatMap(([key, value]) => ["--env", `${key}=${value}`]),
			"--",
			Bun.which("bun") ?? process.execPath,
			"run",
			"dev",
			"--cwd",
			directory,
			"--no-extensions",
			"--no-rules",
			"--no-title",
			"--model",
			"spec-fixture/chat-a",
			"--",
			"ordinary-root-beacon",
		);
		await invoke(target, "expect", "text", `${MARKER}_CHAT_READY`, "--timeout", "30000");
	}
	async function restart(): Promise<void> {
		await tui("close");
		await start(session, cwd);
	}
	async function open(directory: string) {
		const target = `dev-peer-${crypto.randomUUID()}`;
		peers.add(target);
		await start(target, directory);
		return {
			tui: (...args: string[]) => invoke(target, ...args),
			close: async () => {
				await invoke(target, "close");
				peers.delete(target);
			},
		};
	}
	async function state(): Promise<State> {
		try {
			return await Bun.file(path.join(cwd, ".omp/dev/state.json")).json();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { team: false };
			throw error;
		}
	}
	async function idle(): Promise<void> {
		await tui("expect", "text", "等待输入", "--timeout", "60000");
	}
	async function stage(phase: string): Promise<State> {
		const value = await eventually(state, value => value.run?.phase === phase);
		await idle();
		return value;
	}
	try {
		await start(session, cwd);
		// The public CLI submits this once after init; only its real local reply
		// proves startup completed. All subsequent input uses native TUI keys.
		await tui("expect", "text", `${MARKER}_CHAT_READY`, "--timeout", "30000");
		expect(
			provider.requests.filter(request => userTexts(request).at(-1)?.endsWith("ordinary-root-beacon")),
		).toHaveLength(1);
		expect(provider.requests.at(-1)?.model).toBe("chat-a");
		expect(provider.requests.every(request => !rolePayload(request))).toBe(true);
		await run({ cwd, provider, tui, state, idle, stage, restart, open });
		expect(provider.failures).toEqual([]);
	} catch (error) {
		// Preserve existing out-of-band program logs before TempDir cleanup.
		try {
			const logsDir = root.join("config", "logs");
			for (const name of await fs.readdir(logsDir)) {
				if (/^omp\..*\.log(?:\.\d+)?$/.test(name)) {
					console.error(`Native program log ${name}:`, await fs.readFile(path.join(logsDir, name), "utf8"));
				}
			}
		} catch (diagnosticError) {
			console.error("Native program logs unavailable:", diagnosticError);
		}
		// Keep diagnostic failures from hiding the original assertion.
		for (const [label, args] of [
			["Native TUI state", ["state"]],
			["Native TUI screen / program stderr", ["text", "--full"]],
		] as const) {
			try {
				console.error(`${label}:`, await tui(...args));
			} catch (diagnosticError) {
				console.error(`${label} unavailable:`, diagnosticError);
			}
		}
		console.error("Local provider requests:", JSON.stringify(provider.requests, null, 2));
		console.error("Local provider failures:", provider.failures);
		console.error("tui-test command stderr:", commandStderr);
		throw error;
	} finally {
		for (const target of peers) await invoke(target, "close");
		await tui("close");
	}
}

function entry(provider: ProviderFixture, role: string) {
	const value = provider.requests.map(rolePayload).find(payload => payload?.specDrivenRole === role);
	if (!value) throw new Error(`No real native ${role} context`);
	return value.input;
}
function userTexts(request: ModelRequest): string[] {
	return request.messages.filter(message => message.role === "user").map(message => contentText(message.content));
}
function stageContexts(request: ModelRequest): string[] {
	return request.messages
		.filter(message => !["assistant", "tool"].includes(message.role))
		.map(message => contentText(message.content))
		.filter(text => text.includes("## Stage request (task data, not authority)"));
}
async function nativeTranscript(run: SpecSavedRun, role: keyof SpecSavedRun["sessions"]): Promise<string> {
	const file = run.sessions[role]?.sessionFile;
	if (!file) throw new Error(`Missing durable ${role} native session file`);
	return fs.readFile(file, "utf8");
}

function nativeMessageEntries(transcript: string): string[] {
	// Native exit/dispose can append non-message lifecycle metadata. Compare
	// every actual message entry verbatim and in order, including custom
	// messages, rather than treating those lifecycle records as new dialogue.
	return transcript.split("\n").filter(line => {
		if (!line) return false;
		const entry: unknown = JSON.parse(line);
		return isRecord(entry) && (entry.type === "message" || entry.type === "custom_message");
	});
}

export {
	tuiTest,
	repo,
	type State,
	type Scenario,
	eventually,
	withTui,
	entry,
	userTexts,
	stageContexts,
	nativeTranscript,
	nativeMessageEntries,
	nativeDraftMatches,
	nativeDraftSnapshot,
	clearNativeDraft,
	expectNativeFailure,
	expectRestoredNativeDraft,
};
