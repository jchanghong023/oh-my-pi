import { expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { truncate } from "@oh-my-pi/pi-tui/text/width";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";
import "../../src/tools"; // Runtime input of the spawned CLI for Bun --changed.
import {
	contentText,
	createProviderFixture,
	MARKER,
	type ModelRequest,
	type ProviderFixture,
	type Reply,
} from "./provider-fixture";

const tuiTest = Bun.which("tui-test");
const repo = path.resolve(import.meta.dir, "../../../..");
type Scenario = {
	reply: (request: ModelRequest) => Reply | Response | Promise<Reply | Response>;
	configuration?: Record<string, unknown>;
};
/** The default box composer paints its last input row on the bottom border. */
export function composerBounds(screen: string) {
	const lines = screen.split("\n");
	const start = lines.findLastIndex(line => line.startsWith("╭── "));
	const end = lines.findIndex((line, index) => index > start && line.startsWith("╰─"));
	return { lines, start, end };
}

async function eventually<T>(read: () => Promise<T>, predicate: (value: T) => boolean, timeout = 60_000): Promise<T> {
	const deadline = Date.now() + timeout;
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

function nativeDraftMatches(screen: string, expected: string, cursor: { x: number; y: number }): boolean {
	const { lines, start, end } = composerBounds(screen);
	if (start < 0 || cursor.y <= start || cursor.y > end) return false;
	// On narrow terminals the box puts unbordered status overflow between
	// its top border and the first input row. It is not part of the draft.
	let first = start + 1;
	while (first < end && lines[first]!.startsWith("   ")) first++;
	if (cursor.y < first) return false;
	if (!expected) return cursor.y === first && cursor.x === 3;
	// A short draft may be followed by the reserved blank input row and a separate IME-safe bottom rule.
	const closing = lines[end]!;
	if (cursor.y < end) {
		if (!/^╰─[ ─]*╯\s*$/u.test(closing)) return false;
		if (lines.slice(cursor.y + 1, end).some(row => !/^│ +[│█]\s*$/u.test(row))) return false;
	}
	const boxWidth = Bun.stringWidth(closing.trimEnd());
	const rows = lines.slice(first, cursor.y + 1);
	let remaining = expected;
	for (const [index, row] of rows.entries()) {
		const last = index === rows.length - 1;
		const bottom = first + index === end;
		const limit = row.search(bottom ? /─?╯\s*$/u : /[│█]\s*$/u);
		const open = last && !bottom && Bun.stringWidth(row.trimEnd()) < boxWidth;
		if (!row.startsWith(bottom ? "╰─ " : "│  ") || (!open && limit < 3)) return false;
		const content = row.slice(3, open ? undefined : limit);
		let input = content.trimEnd();
		if (last) {
			// PTY cursor coordinates count cells, not UTF-16 code units.
			const cells = cursor.x - 3;
			if (cells < 0 || cells > Bun.stringWidth(content)) return false;
			input = truncate(content, cells, "");
			if (Bun.stringWidth(input) !== cells) return false;
			input = input.trimEnd();
		}
		// Submitted control commands are one logical line. Extra blank rows
		// mean another draft/keypress was merged into it, not exact restoration.
		if (!input || !remaining.startsWith(input)) return false;
		remaining = remaining.slice(input.length);
		// Word wrapping omits the boundary space from the painted row.
		if (!last && remaining.startsWith(" ")) remaining = remaining.slice(1);
	}
	return remaining.length === 0;
}

const lastDraftClear = new WeakMap<(...args: string[]) => Promise<string>, number>();
async function clearNativeDraft(tui: (...args: string[]) => Promise<string>): Promise<void> {
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

// tui-test owns the PTY and terminal decoding. The provider only returns SSE/native tool requests.
async function withTui(
	scenario: Scenario,
	size: [number, number],
	run: (h: {
		cwd: string;
		agentDir: string;
		provider: ProviderFixture;
		tui: (...args: string[]) => Promise<string>;
	}) => Promise<void>,
): Promise<void> {
	await using root = await TempDir.create("@omp-native-tui-");
	await using provider = createProviderFixture(scenario);
	const cwd = root.join("project");
	const home = root.join("home");
	const profile = "acceptance";
	const profileDir = root.join("config", "profiles", profile);
	const agentDir = path.join(profileDir, "agent");
	const temp = root.join("tmp");
	const appData = root.join("home", "AppData", "Roaming");
	const localData = root.join("home", "AppData", "Local");
	const cache = root.join("cache");
	for (const directory of [cwd, home, agentDir, temp, appData, localData, cache])
		await fs.mkdir(directory, { recursive: true });
	// tui-test's persistent PTY server may predate this fixture, and --env
	// overrides KEY=VALUE rather than unsetting KEY. Clear inherited application
	// settings, but preserve Bun's experimental engine options verbatim: an empty
	// BUN_JSC_* value is an invalid option, not a reset to its default.
	const inherited = new Set([
		"PATH",
		"Path",
		"PATHEXT",
		"SystemRoot",
		"SYSTEMROOT",
		"WINDIR",
		"COMSPEC",
		"LANG",
		"LC_ALL",
		"TERM",
		"NUMBER_OF_PROCESSORS",
		"PROCESSOR_ARCHITECTURE",
		"BUN_RUNTIME_TRANSPILER_CACHE_PATH",
	]);
	const env = {
		...Object.fromEntries(
			Object.entries(process.env).map(([key, value]) => [
				key,
				inherited.has(key) || key.startsWith("BUN_JSC_") ? value : "",
			]),
		),
		TZ: "UTC",
		OMP_CONFIG_ROOT: root.join("config"),
		OMP_PROFILE: profile,
		PI_CODING_AGENT_DIR: agentDir,
		PI_CONFIG_DIR: ".omp",
		PI_PROFILE: "",
		HOME: home,
		USERPROFILE: home,
		APPDATA: appData,
		LOCALAPPDATA: localData,
		XDG_CONFIG_HOME: root.join("config"),
		XDG_DATA_HOME: localData,
		XDG_CACHE_HOME: cache,
		TMPDIR: temp,
		TEMP: temp,
		TMP: temp,
		OMP_OFFLINE: "0",
		PI_NO_TITLE: "1",
		PI_TEST_RUNTIME: "",
		NO_PROXY: "127.0.0.1,localhost",
		DO_NOT_TRACK: "1",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: root.join("gitconfig"),
		GIT_CONFIG_COUNT: "0",
		GIT_TERMINAL_PROMPT: "0",
		PUPPETEER_SKIP_DOWNLOAD: "true",
		PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
	};
	await Bun.write(
		path.join(agentDir, "models.yml"),
		`providers:\n  deepseek:\n    baseUrl: ${provider.baseUrl}\n    auth: none\n    api: openai-completions\n    models:\n      - id: chat-a\n        reasoning: false\n        input: [text, image]\n        contextWindow: 200000\n`,
	);
	await Bun.write(
		path.join(agentDir, "config.yml"),
		JSON.stringify({
			enabledProviders: ["deepseek"],
			enabledModels: ["deepseek/chat-a"],
			retry: { modelFallback: false },
			composer: { predictions: false },
			startup: { setupWizard: false },
			async: { enabled: false },
			...scenario.configuration,
			modelRoles: {
				default: "deepseek/chat-a",
				smol: "deepseek/chat-a",
				...(isRecord(scenario.configuration?.modelRoles) ? scenario.configuration.modelRoles : {}),
			},
		}),
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
		if (code !== 0) {
			throw new Error(`tui-test ${args.join(" ")} exited ${code}:\n${stdout}\n${stderr}`);
		}
		return stdout;
	}
	const tui = (...args: string[]) => invoke(session, ...args);
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
			"deepseek/chat-a",
			"--",
			"ordinary-root-beacon",
		);
		// The scenario's actual ordinary reply must render before input resumes;
		// an empty composer or startup boilerplate alone cannot prove readiness.
		await invoke(target, "expect", "text", `${MARKER}_CHAT_READY`, "--timeout", "30000");
		await invoke(target, "wait", "idle", "--timeout", "30000");
	}
	try {
		await start(session, cwd);
		expect(
			provider.requests.filter(request => userTexts(request).at(-1)?.endsWith("ordinary-root-beacon")),
		).toHaveLength(1);
		expect(provider.requests.at(-1)?.model).toBe("chat-a");
		await Promise.race([
			run({
				cwd,
				agentDir,
				provider,
				tui,
			}),
			provider.failure,
		]);
		expect(provider.failures).toEqual([]);
	} catch (error) {
		// Preserve existing out-of-band program logs before TempDir cleanup.
		try {
			const logsDir = path.join(profileDir, "logs");
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
		await tui("close");
	}
}

function userTexts(request: ModelRequest): string[] {
	return request.messages.filter(message => message.role === "user").map(message => contentText(message.content));
}

export { tuiTest, repo, eventually, withTui, nativeDraftMatches, nativeDraftSnapshot, clearNativeDraft };
