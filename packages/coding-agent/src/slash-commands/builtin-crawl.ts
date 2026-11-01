import { runCrawl, type CrawlOptions } from "../tools/browser/crawl";
import { parseCommandArgs } from "../utils/command-args";
import { commandConsumed, errorMessage, usage } from "./helpers/parse";
import type { SlashCommandRuntime, SlashCommandSpec } from "./types";

const CRAWL_USAGE =
	"Usage: /crawl <URL> [--recursive] [--output <directory>] [--concurrency <number>] [--max-pages <number>] [--max-depth <depth>] | /crawl stop";

function parseCrawlOptions(args: string): CrawlOptions | "stop" {
	// Windows paths commonly contain literal backslashes rather than shell escapes.
	const input = process.platform === "win32" ? args.replace(/\\(?=[^\\\s"'$`]|$)/g, "\\\\") : args;
	const tokens = parseCommandArgs(input, { strict: true });
	if (tokens.length === 1 && tokens[0] === "stop") return "stop";
	const url = tokens[0];
	if (!url || url.startsWith("-")) throw new Error(CRAWL_USAGE);
	let parsedUrl: URL;
	try {
		parsedUrl = new URL(url);
	} catch {
		throw new Error("Invalid crawl URL: expected an absolute HTTP or HTTPS URL.");
	}
	if ((parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") || !parsedUrl.hostname) {
		throw new Error("Invalid crawl URL: expected an absolute HTTP or HTTPS URL.");
	}

	const options: CrawlOptions = { url, recursive: false, output: "tmp", concurrency: 2 };
	const seen = new Set<string>();
	for (let i = 1; i < tokens.length; i++) {
		const flag = tokens[i]!;
		if (!["--recursive", "--output", "--concurrency", "--max-pages", "--max-depth"].includes(flag)) {
			throw new Error(`Unknown crawl argument: ${flag}. ${CRAWL_USAGE}`);
		}
		if (seen.has(flag)) throw new Error(`Duplicate crawl argument: ${flag}.`);
		seen.add(flag);
		if (flag === "--recursive") {
			options.recursive = true;
			continue;
		}
		const value = tokens[++i];
		if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}.`);
		if (flag === "--output") {
			options.output = value;
			continue;
		}
		const number = Number(value);
		if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < (flag === "--max-depth" ? 0 : 1)) {
			throw new Error(`Invalid value for ${flag}: ${value}.`);
		}
		if (flag === "--concurrency") options.concurrency = number;
		else if (flag === "--max-pages") options.maxPages = number;
		else options.maxDepth = number;
	}
	return options;
}

interface CrawlJob {
	controller: AbortController;
	completion: Promise<void>;
	visible: boolean;
}

interface CrawlSessionState {
	current?: CrawlJob;
	closed: boolean;
}

const sessions = new WeakMap<SlashCommandRuntime["session"], CrawlSessionState>();

function sessionState(runtime: SlashCommandRuntime): CrawlSessionState {
	let state = sessions.get(runtime.session);
	if (!state) {
		state = { closed: false };
		sessions.set(runtime.session, state);
		const owned = state;
		const unregister = runtime.session.registerSessionChangeCallback(() => {
			if (owned.current) {
				owned.current.visible = false;
				owned.current.controller.abort();
				owned.current = undefined;
			}
		});
		runtime.session.addDisposer(() => {
			owned.closed = true;
			if (owned.current) {
				owned.current.visible = false;
				owned.current.controller.abort();
			}
			unregister();
		});
	}
	return state;
}

export const BUILTIN_CRAWL_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "crawl",
		description: "Save a webpage or recursively save same-origin pages via Browser Relay",
		allowArgs: true,
		inlineHint:
			"<URL> [--recursive] [--output <directory>] [--concurrency <number>] [--max-pages <number>] [--max-depth <depth>] | stop",
		handle: async (command, runtime) => {
			let options: CrawlOptions | "stop";
			try {
				options = parseCrawlOptions(command.args);
			} catch (error) {
				return usage(errorMessage(error), runtime);
			}
			const state = sessionState(runtime);
			if (options === "stop") {
				const job = state.current;
				if (!job) return usage("No crawl is running in this session.", runtime);
				job.controller.abort();
				await runtime.output("Stopping crawl; already saved files will be retained.");
				await job.completion;
				return commandConsumed();
			}
			if (state.current) return usage("A crawl is already running in this session. Use /crawl stop first.", runtime);
			if (state.closed || runtime.session.isDisposed || runtime.signal?.aborted)
				return usage("Cannot start crawl: session or request is closed.", runtime);

			const controller = new AbortController();
			const completion = Promise.withResolvers<void>();
			const job: CrawlJob = { controller, completion: completion.promise, visible: true };
			state.current = job;
			const onAbort = () => controller.abort(runtime.signal?.reason);
			runtime.signal?.addEventListener("abort", onAbort, { once: true });
			const output = (text: string) => {
				if (job.visible && !state.closed && !runtime.session.isDisposed) return runtime.output(text);
			};
			const task = async () => {
				try {
					await runCrawl({ ...runtime, output }, options, controller.signal);
				} catch (error) {
					await output(controller.signal.aborted ? "Crawl cancelled." : `Crawl failed: ${errorMessage(error)}`);
				} finally {
					runtime.signal?.removeEventListener("abort", onAbort);
					if (state.current === job) state.current = undefined;
					completion.resolve();
				}
			};
			if (runtime.runCommandInBackground) runtime.runCommandInBackground(task);
			else void task();
			return commandConsumed();
		},
	},
];
