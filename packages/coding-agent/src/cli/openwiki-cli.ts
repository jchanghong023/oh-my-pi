import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { updateOpenWikiAgentInstructions } from "../openwiki/agents-instructions";
import { configureOpenWikiHome, getOpenWikiConfigDirectory } from "../openwiki/home";
import { createOpenWikiModel, previewOpenWikiModel } from "../openwiki/model";
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
  --dry-run, --print, --debug, --telemetry-file <path>. The code word may be omitted.
  --dry-run previews the model and candidate paths without model calls or Wiki writes.
  The model determines the actual Wiki pages during generation.
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
function extractModelAndDebug(argv: string[]): { argv: string[]; model?: string; debug: boolean; dryRun: boolean } {
	const result: string[] = [];
	let model: string | undefined;
	let debug = false;
	let dryRun = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--dry-run") {
			dryRun = true;
		} else if (arg === "--debug") {
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
	return { argv: result, model, debug, dryRun };
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
			previewRepositoryFiles,
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
		if (management && argv.includes("--dry-run")) throw new Error("--dry-run requires --init or --update.");
		const parsed = management ? { argv, model: undefined, debug: false, dryRun: false } : extractModelAndDebug(argv);
		debug = parsed.debug;
		const command = parseCommand(parsed.argv);
		if (command.kind === "help") {
			process.stdout.write(HELP);
			return 0;
		}
		if (command.kind === "error") throw new Error(command.message);
		if (parsed.dryRun && (command.kind !== "run" || command.command === "chat")) {
			throw new Error("--dry-run requires --init or --update.");
		}
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
		if (parsed.dryRun) {
			const root = await resolveRepositoryRoot(process.cwd());
			const [model, files] = await Promise.all([
				previewOpenWikiModel(parsed.model),
				previewRepositoryFiles(root, command.command),
			]);
			const printPaths = (paths: string[]) => {
				for (const item of paths) process.stdout.write(`  ${JSON.stringify(item)}\n`);
				if (paths.length === 0) process.stdout.write("  (none)\n");
			};
			process.stdout.write(`OpenWiki dry run: ${command.command}\nRepository: ${root}\n`);
			process.stdout.write(
				`Model selection (${model.source}): ${model.modelId ?? model.selector ?? "(automatic)"}\n${model.reason}\n`,
			);
			process.stdout.write(`Source snapshot candidates (${files.sourcePaths.length}):\n`);
			printPaths(files.sourcePaths);
			process.stdout.write("Snapshot candidates are not a complete list of files the model may read.\n");
			if (files.update) {
				if (files.update.changedPaths) {
					process.stdout.write(`Changed paths since completed run ${files.update.baselineGitHead}:\n`);
					printPaths(files.update.changedPaths);
				} else {
					process.stdout.write("Changed paths since completed run: unavailable (no comparable baseline).\n");
				}
				const pages = files.update.pageBaselines;
				if (pages.length > 0) {
					const changes = [...new Set(pages.flatMap(page => page.changedPaths ?? []))].sort();
					const unknown = pages.filter(page => !page.changedPaths).length;
					process.stdout.write(
						`Changed paths across page baselines${unknown ? ` (${unknown} unavailable)` : ""}:\n`,
					);
					printPaths(changes);
				}
			}
			process.stdout.write(`Wiki output scope: ${path.join(root, "openwiki")}\n`);
			if (command.command === "init") {
				process.stdout.write("A real init replaces an existing Wiki except openwiki/INSTRUCTIONS.md.\n");
			}
			process.stdout.write(`Existing factual Wiki pages (${files.existingWikiPages.length}):\n`);
			printPaths(files.existingWikiPages);
			process.stdout.write(
				"Actual pages are determined by the model during generation. No model calls, Wiki or telemetry writes.\n",
			);
			return 0;
		}
		if (command.telemetryFile) await writeDisabledTelemetry(command.telemetryFile);
		const pageConcurrency = resolvePageConcurrency();
		const root = await resolveRepositoryRoot(process.cwd());
		const skillsDir = await materializeOpenWikiSkills(getAgentDir());
		const selected = await createOpenWikiModel(parsed.model);
		try {
			if (controller.signal.aborted) return 130;
			await updateOpenWikiAgentInstructions(root);
			const wikiDir = path.join(root, "openwiki");
			await mkdir(wikiDir, { recursive: true });
			try {
				await writeFile(path.join(wikiDir, "INSTRUCTIONS.md"), "", { flag: "wx" });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
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
