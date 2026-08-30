import { getAgentDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { DocsService } from "../docs/service";
import type { DocsBuildResult, DocsIndexMode, DocsProgress } from "../docs/types";
import { discoverAuthStorage, loadCliExtensionProviders } from "../sdk";

export type DocsAction = "init" | "reinit" | "list" | "status" | "remove";

export interface DocsCommandInput {
	action: DocsAction;
	target?: string;
	name?: string;
	schema?: string;
	mode?: DocsIndexMode;
	json?: boolean;
	force?: boolean;
	cwd?: string;
	signal?: AbortSignal;
}

export interface DocsCliDependencies {
	createService?: (cwd: string, needsModel: boolean) => Promise<DocsService>;
	stdout?: (text: string) => void;
	stderr?: (text: string) => void;
}

async function createDefaultService(cwd: string, needsModel: boolean): Promise<DocsService> {
	if (!needsModel) return new DocsService({ agentDir: getAgentDir(), cwd });
	const settings = await Settings.init({ cwd });
	const authStorage = await discoverAuthStorage();
	const modelRegistry = new ModelRegistry(authStorage);
	await loadCliExtensionProviders(modelRegistry, settings, cwd);
	return new DocsService({
		agentDir: settings.getAgentDir(),
		cwd,
		settings,
		modelRegistry,
		maxConcurrency: settings.get("task.maxConcurrency"),
	});
}

function progressLine(progress: DocsProgress): string {
	const path = progress.currentPath ? ` ${progress.currentPath}` : "";
	const message = progress.message ? ` — ${progress.message}` : "";
	return `${progress.phase} ${progress.completed}/${progress.total} failed=${progress.failed}${path}${message}\n`;
}

function buildExitCode(result: DocsBuildResult): number {
	return result.index.state === "ready" ? 0 : 1;
}

export async function runDocsCommand(input: DocsCommandInput, dependencies: DocsCliDependencies = {}): Promise<number> {
	const cwd = input.cwd ?? process.cwd();
	const stdout = dependencies.stdout ?? (text => process.stdout.write(text));
	const stderr = dependencies.stderr ?? (text => process.stderr.write(text));
	const service = await (dependencies.createService ?? createDefaultService)(
		cwd,
		input.action === "reinit" || input.mode === "structured",
	);
	const onProgress = input.json ? undefined : (progress: DocsProgress) => stderr(progressLine(progress));
	try {
		let value: unknown;
		let exitCode = 0;
		switch (input.action) {
			case "init": {
				const result = await service.init(input.target as string, input.name as string, input.schema, {
					signal: input.signal,
					mode: input.mode,
					onProgress,
				});
				value = result;
				exitCode = buildExitCode(result);
				break;
			}
			case "reinit": {
				const result = await service.reinit(input.target as string, {
					schema: input.schema,
					mode: input.mode,
					signal: input.signal,
					onProgress,
				});
				value = result;
				exitCode = buildExitCode(result);
				break;
			}
			case "list":
				value = service.list();
				break;
			case "status":
				value = service.status(input.target);
				break;
			case "remove":
				service.remove(input.target as string);
				value = { removed: input.target };
				break;
		}
		if (input.json) stdout(`${JSON.stringify(value)}\n`);
		else if (Array.isArray(value)) {
			for (const item of value) stdout(`${JSON.stringify(item)}\n`);
		} else stdout(`${JSON.stringify(value)}\n`);
		return exitCode;
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			if (input.json) stdout(`${JSON.stringify({ state: "cancelled", error: error.message })}\n`);
			else stderr(`${error.message}\n`);
			return 130;
		}
		throw error;
	} finally {
		service.close();
	}
}
