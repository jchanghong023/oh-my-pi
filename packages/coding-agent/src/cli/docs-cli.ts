import { getAgentDir, sanitizeText } from "@oh-my-pi/pi-utils";
import { DocsService } from "../docs/service";
import type { DocsProgress } from "../docs/types";

export type DocsAction = "init" | "list" | "status" | "remove";

export interface DocsCommandInput {
	action: DocsAction;
	target?: string;
	name?: string;
	json?: boolean;
	force?: boolean;
	cwd?: string;
	signal?: AbortSignal;
}

export interface DocsCliDependencies {
	createService?: (cwd: string) => Promise<DocsService>;
	stdout?: (text: string) => void;
	stderr?: (text: string) => void;
}

function sanitizeTerminalLine(text: string): string {
	return sanitizeText(text).replace(/[\n\t]+/g, " ");
}

function progressLine(progress: DocsProgress): string {
	const path = progress.currentPath ? ` ${sanitizeTerminalLine(progress.currentPath)}` : "";
	const message = progress.message ? ` — ${sanitizeTerminalLine(progress.message)}` : "";
	return `${progress.phase} ${progress.completed}/${progress.total} failed=${progress.failed}${path}${message}\n`;
}

export async function runDocsCommand(input: DocsCommandInput, dependencies: DocsCliDependencies = {}): Promise<number> {
	const cwd = input.cwd ?? process.cwd();
	const stdoutSink = dependencies.stdout ?? (text => process.stdout.write(text));
	const stderrSink = dependencies.stderr ?? (text => process.stderr.write(text));
	const stdout = (text: string): void => stdoutSink(sanitizeText(text));
	const stderr = (text: string): void => stderrSink(sanitizeText(text));
	const service = dependencies.createService
		? await dependencies.createService(cwd)
		: new DocsService({ agentDir: getAgentDir(), cwd });
	const onProgress = input.json ? undefined : (progress: DocsProgress) => stderr(progressLine(progress));
	try {
		let value: unknown;
		let exitCode = 0;
		switch (input.action) {
			case "init": {
				const result = await service.init(input.target as string, input.name as string, {
					signal: input.signal,
					onProgress,
				});
				value = result;
				exitCode = result.index.state === "ready" ? 0 : 1;
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
