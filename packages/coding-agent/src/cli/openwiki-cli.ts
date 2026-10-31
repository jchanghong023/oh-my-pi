import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { configureOpenWikiHome, getOpenWikiConfigDirectory } from "../openwiki/home";
import { createOpenWikiModel } from "../openwiki/model";
import { materializeOpenWikiSkills } from "../openwiki/resources";
import { getOpenWikiVisualAssets } from "../openwiki/visual-assets";
import { loadOpenWikiVendor } from "../openwiki/vendor-loader";

const HELP = `Usage: omp openwiki <command> [options]

  code --init [message]       Generate a repository wiki
  code --update [message]     Update a repository wiki
  link [directory]            Manage linked repositories interactively
  workspace use <workspace>   Select the active workspace
  workspace current|clear     Show or clear the active workspace
  visualize [path] [--port <port>] [--no-open]
  visualize [path] --export <directory>

Repository options: --language <locale>, --modelId <model> (or --model-id),
  --print, --debug, --telemetry-file <path>. The code word may be omitted.
Page concurrency is controlled by OPENWIKI_PAGE_CONCURRENCY (1–8, default 1).
`;

const UNSUPPORTED = new Set([
	"personal",
	"search",
	"read",
	"ingest",
	"cron",
	"integrations",
	"mcp",
	"auth",
	"ngrok",
	"connector",
	"connectors",
	"install",
	"chat",
]);

/** OpenWiki's parser validates against its own model list. OMP selectors must bypass it. */
function extractModelAndDebug(argv: string[]): { argv: string[]; model?: string; debug: boolean } {
	const result: string[] = [];
	let model: string | undefined;
	let debug = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--debug") {
			debug = true;
		} else if (arg === "--modelId" || arg === "--model-id") {
			const value = argv[++i];
			if (!value || value.startsWith("-")) throw new Error(`${arg} requires a model ID.`);
			model = value;
		} else if (arg.startsWith("--modelId=") || arg.startsWith("--model-id=")) {
			model = arg.slice(arg.indexOf("=") + 1);
			if (!model) throw new Error(`${arg.split("=")[0]} requires a model ID.`);
		} else {
			result.push(arg);
		}
	}
	return { argv: result, model, debug };
}

async function writeDisabledTelemetry(file: string): Promise<void> {
	const target = path.resolve(file);
	const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
	try {
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(temporary, `${JSON.stringify({ disabled: true, sent: false }, null, 2)}\n`, {
			mode: 0o600,
			flag: "wx",
		});
		await rename(temporary, target);
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => {});
		const message = error instanceof Error ? error.message : String(error);
		console.error(`OpenWiki: could not write telemetry file "${file}": ${message}`);
	}
}

/** Run the in-process repository-only OpenWiki CLI. */
export async function runOpenWikiCommand(argv: string[]): Promise<number> {
	const controller = new AbortController();
	let interrupted = false;
	const abort = () => {
		interrupted = true;
		controller.abort();
	};
	process.once("SIGINT", abort);
	process.once("SIGTERM", abort);
	let debug = false;
	try {
		await configureOpenWikiHome();
		const {
			parseCommand,
			runLinkCommand,
			runWorkspaceCommand,
			resolvePageConcurrency,
			resolveRepositoryRoot,
			startEmbeddedVisualizeServer,
			exportStaticVisualizer,
			runNativeRepositoryGeneration,
		} = await loadOpenWikiVendor();
		if (argv.length === 0) {
			process.stdout.write(HELP);
			return 0;
		}
		if (UNSUPPORTED.has(argv[0])) throw new Error(`OpenWiki ${argv[0]} is not supported by OMP.`);
		const management = argv[0] === "link" || argv[0] === "workspace" || argv[0] === "visualize";
		const parsed = management ? { argv, model: undefined, debug: false } : extractModelAndDebug(argv);
		debug = parsed.debug;
		const command = parseCommand(parsed.argv);
		if (command.kind === "help") {
			process.stdout.write(HELP);
			return 0;
		}
		if (command.kind === "error") throw new Error(command.message);
		if (command.kind === "link" || command.kind === "workspace") {
			const options = { configDirectory: getOpenWikiConfigDirectory() };
			if (command.kind === "link") await runLinkCommand(command, options);
			else await runWorkspaceCommand(command, options);
			return Number(process.exitCode ?? 0);
		}
		if (command.kind === "visualize") {
			const assets = await getOpenWikiVisualAssets();
			const wikiRoot = path.resolve(command.wikiDir);
			if (command.exportDir) {
				const result = await exportStaticVisualizer({
					wikiRoot,
					outputDir: path.resolve(command.exportDir),
					assets,
				});
				process.stdout.write(
					`Exported static visualizer to ${result.outputDir} (${result.graph.nodes.length} pages, ${result.graph.edges.length} links).\n`,
				);
				return 0;
			}
			const server = await startEmbeddedVisualizeServer({
				wikiRoot,
				port: command.port,
				open: command.open,
				assets,
			});
			try {
				process.stdout.write(`OpenWiki visualizer: ${server.url}\nPress Ctrl-C to stop.\n`);
				if (!controller.signal.aborted) {
					const stopped = Promise.withResolvers<void>();
					controller.signal.addEventListener("abort", () => stopped.resolve(), { once: true });
					await stopped.promise;
				}
			} finally {
				await server.close();
			}
			return 0;
		}
		if (command.kind !== "run" || command.mode !== "code") {
			throw new Error("This OpenWiki operation is not supported by OMP.");
		}
		if (command.command === "chat") {
			if (!command.userMessage && !command.print) {
				process.stdout.write(HELP);
				return 0;
			}
			throw new Error("OpenWiki chat is not supported by OMP; specify --init or --update.");
		}
		if (command.telemetryFile) await writeDisabledTelemetry(command.telemetryFile);
		const pageConcurrency = resolvePageConcurrency();
		const root = await resolveRepositoryRoot(process.cwd());
		const skillsDir = await materializeOpenWikiSkills(getAgentDir());
		const selected = await createOpenWikiModel(parsed.model);
		try {
			if (controller.signal.aborted) return 130;
			if (debug)
				process.stderr.write(`OpenWiki debug: model=${selected.modelId} pageConcurrency=${pageConcurrency}\n`);
			const result = await runNativeRepositoryGeneration({
				root,
				mode: command.command,
				language: command.language,
				force: Boolean(command.userMessage?.trim()),
				planningContext: command.userMessage,
				modelId: selected.modelId,
				model: selected.model,
				pageConcurrency,
				embedded: true,
				skillsDir,
				signal: controller.signal,
				onEvent: event => {
					if (event.type === "text") process.stdout.write(event.text);
					else if (event.type === "repository_progress") {
						process.stderr.write(
							`OpenWiki: ${event.stage}${event.resumed ? " (resumed)" : ""}${event.page ? ` ${event.page}` : ""}\n`,
						);
					} else if (debug && event.type === "debug") process.stderr.write(`OpenWiki debug: ${event.message}\n`);
					else if (debug && event.type === "tool_start")
						process.stderr.write(
							`OpenWiki debug: tool ${event.name} started${event.page ? ` (${event.page})` : ""}\n`,
						);
					else if (debug && event.type === "tool_end")
						process.stderr.write(
							`OpenWiki debug: tool ${event.name} ${event.status}${event.page ? ` (${event.page})` : ""}\n`,
						);
				},
			});
			if (controller.signal.aborted) return 130;
			if (result.partialFailure) {
				process.stderr.write("OpenWiki generation did not complete all pages; run update to retry.\n");
				return 1;
			}
			if (result.sourceChanged)
				process.stderr.write(
					"Warning: repository source changed during generation; run omp openwiki --update to cover the latest changes.\n",
				);
			if (result.skipped) process.stdout.write("OpenWiki is up to date.\n");
			return 0;
		} finally {
			selected.dispose();
		}
	} catch (error) {
		if (interrupted) {
			process.stderr.write("OpenWiki cancelled.\n");
			return 130;
		}
		const message =
			debug && error instanceof Error
				? (error.stack ?? error.message)
				: error instanceof Error
					? error.message
					: String(error);
		process.stderr.write(`${message}\n`);
		return 1;
	} finally {
		process.off("SIGINT", abort);
		process.off("SIGTERM", abort);
	}
}
