import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { buildCrawlArgumentCompletions } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-completions";
import {
	BUILTIN_SLASH_COMMANDS,
	executeBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime, TuiSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import * as crawl from "@oh-my-pi/pi-coding-agent/tools/browser/crawl";

function harness() {
	const messages: string[] = [];
	const disposers: Array<() => void> = [];
	const tasks: Promise<void>[] = [];
	const changes: Array<() => void> = [];
	const session = {
		isDisposed: false,
		addDisposer: (dispose: () => void) => disposers.push(dispose),
		registerSessionChangeCallback: (callback: () => void) => {
			changes.push(callback);
			return () => {};
		},
	};
	const runtime: SlashCommandRuntime = {
		session: session as never,
		sessionManager: { getCwd: () => "/project" } as never,
		settings: Settings.isolated(),
		cwd: "/project",
		output: text => {
			messages.push(text);
		},
		refreshCommands: () => {},
		reloadPlugins: async () => {},
		runCommandInBackground: task => {
			tasks.push(task());
		},
	};
	return {
		runtime,
		session,
		messages,
		tasks,
		dispose: () => {
			session.isDisposed = true;
			disposers.forEach(dispose => dispose());
		},
		changeSession: () => changes.forEach(change => change()),
	};
}

afterEach(() => vi.restoreAllMocks());

describe("/crawl", () => {
	it("consumes invalid input without scheduling crawl or forwarding a prompt", async () => {
		const h = harness();
		const invalid = [
			"/crawl",
			"/crawl not-a-url",
			"/crawl file:///test",
			"/crawl https://example.com --unknown",
			"/crawl https://example.com --recursive --recursive",
			"/crawl https://example.com --output",
			"/crawl https://example.com --output 'unterminated",
			"/crawl https://example.com --concurrency 0",
			"/crawl https://example.com --concurrency 1.5",
			"/crawl https://example.com --max-pages 9007199254740992",
		];
		for (const input of invalid) {
			expect(await executeAcpBuiltinSlashCommand(input, h.runtime)).toEqual({ consumed: true, failed: true });
		}
		expect(h.messages).toHaveLength(invalid.length);
		expect(h.tasks).toHaveLength(0);
	});

	it("returns immediately, isolates sessions, cancels on stop, and waits for cleanup before restarting", async () => {
		const release = Promise.withResolvers<void>();
		const signals: AbortSignal[] = [];
		vi.spyOn(crawl, "runCrawl").mockImplementation(async (_runtime, _options, signal) => {
			signals.push(signal);
			await release.promise;
		});
		const first = harness();
		const second = harness();
		expect(await executeAcpBuiltinSlashCommand("/crawl https://example.com", first.runtime)).toEqual({
			consumed: true,
		});
		expect(await executeAcpBuiltinSlashCommand("/crawl https://example.org", second.runtime)).toEqual({
			consumed: true,
		});
		expect(await executeAcpBuiltinSlashCommand("/crawl https://example.net", first.runtime)).toEqual({
			consumed: true,
			failed: true,
		});
		const stop = executeAcpBuiltinSlashCommand("/crawl stop", first.runtime);
		expect(signals[0]?.aborted).toBe(true);
		expect(signals[1]?.aborted).toBe(false);
		expect(await executeAcpBuiltinSlashCommand("/crawl https://example.net", first.runtime)).toEqual({
			consumed: true,
			failed: true,
		});
		second.dispose();
		expect(signals[1]?.aborted).toBe(true);
		release.resolve();
		await Promise.all([...first.tasks, ...second.tasks]);
		expect(await stop).toEqual({ consumed: true });
		expect(await executeAcpBuiltinSlashCommand("/crawl stop", first.runtime)).toEqual({
			consumed: true,
			failed: true,
		});
		expect(await executeAcpBuiltinSlashCommand("/crawl https://example.net", first.runtime)).toEqual({
			consumed: true,
		});
		await Promise.all(first.tasks);
	});

	it("propagates host request cancellation to background work", async () => {
		const release = Promise.withResolvers<void>();
		let signal: AbortSignal | undefined;
		vi.spyOn(crawl, "runCrawl").mockImplementation(async (_runtime, _options, received) => {
			signal = received;
			await release.promise;
		});
		const h = harness();
		const host = new AbortController();
		h.runtime.signal = host.signal;
		await executeAcpBuiltinSlashCommand("/crawl https://example.com", h.runtime);
		host.abort();
		expect(signal?.aborted).toBe(true);
		release.resolve();
		await Promise.all(h.tasks);
	});

	it("cancels on session change or disposal and suppresses stale output", async () => {
		const release = Promise.withResolvers<void>();
		const signals: AbortSignal[] = [];
		vi.spyOn(crawl, "runCrawl").mockImplementation(async (runtime, _options, signal) => {
			signals.push(signal);
			await release.promise;
			await runtime.output("late crawl output");
		});
		const h = harness();
		await executeAcpBuiltinSlashCommand("/crawl https://example.com", h.runtime);
		h.changeSession();
		expect(signals[0]?.aborted).toBe(true);
		expect(await executeAcpBuiltinSlashCommand("/crawl https://example.org", h.runtime)).toEqual({ consumed: true });
		h.dispose();
		expect(signals[1]?.aborted).toBe(true);
		release.resolve();
		await Promise.all(h.tasks);
		expect(h.messages).not.toContain("late crawl output");
	});

	it("leaves the TUI free to stop a running crawl", async () => {
		const release = Promise.withResolvers<void>();
		let signal: AbortSignal | undefined;
		vi.spyOn(crawl, "runCrawl").mockImplementation(async (_runtime, _options, received) => {
			signal = received;
			await release.promise;
		});
		const h = harness();
		const runtime = {
			ctx: {
				session: h.session,
				sessionManager: h.runtime.sessionManager,
				settings: h.runtime.settings,
				editor: { setText: () => {} },
				showStatus: (text: string) => h.messages.push(text),
			},
		} as unknown as TuiSlashCommandRuntime;
		expect(await executeBuiltinSlashCommand("/crawl https://example.com", runtime)).toBe(true);
		const stop = executeBuiltinSlashCommand("/crawl stop", runtime);
		expect(signal?.aborted).toBe(true);
		release.resolve();
		expect(await stop).toBe(true);
	});

	it("completes flags and output directories without suggesting URLs", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-crawl-completion-"));
		try {
			await fs.mkdir(path.join(dir, "my folder"));
			await fs.writeFile(path.join(dir, "my file"), "");
			const command = BUILTIN_SLASH_COMMANDS.find(entry => entry.name === "crawl");
			expect(command).toBeDefined();
			const complete = buildCrawlArgumentCompletions(dir);
			expect(await complete("https://exa")).toBeNull();
			expect((await complete("https://example.com --ma"))?.map(item => item.label)).toEqual([
				"--max-pages",
				"--max-depth",
			]);
			expect((await complete("https://example.com --output my"))?.map(item => item.value)).toEqual([
				'https://example.com --output "my folder/"',
			]);
			const registered = await command!.getArgumentCompletions!("https://example.com --re");
			expect(registered?.map(item => item.label)).toContain("--recursive");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
