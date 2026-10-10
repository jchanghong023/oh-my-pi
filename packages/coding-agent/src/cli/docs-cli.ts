import { getAgentDir, logger, sanitizeText } from "@oh-my-pi/pi-utils";
import { DocsService } from "../docs/service";
import type { DocsProgress } from "../docs/types";

export type DocsAction = "init" | "remove";

export interface DocsCommandInput {
	action: DocsAction;
	target?: string;
	name?: string;
	json?: boolean;
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
	return logger.withLogContext(
		{ operation_id: logger.getLogContext().operation_id ?? `docs-cli-${crypto.randomUUID()}` },
		async () => {
			const started = performance.now();
			let stage = "open";
			let resultCode: number | undefined;
			const fields = { component: "docs.cli", event: "docs.cli.command", action: input.action };
			logger.info("docs.cli.command.started", { ...fields, stage, result: "started" });
			try {
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
					stage = input.action;
					const exitCode = 0;
					switch (input.action) {
						case "init": {
							value = await service.init(input.target as string, input.name as string, {
								signal: input.signal,
								onProgress,
							});
							break;
						}
						case "remove":
							service.remove(input.target as string);
							value = { removed: input.target };
							break;
					}
					stage = "output";
					stdout(`${JSON.stringify(value)}\n`);
					resultCode = exitCode;
					return exitCode;
				} catch (error) {
					if (error instanceof Error && error.name === "AbortError") {
						if (input.json) stdout(`${JSON.stringify({ state: "cancelled", error: error.message })}\n`);
						else stderr(`${error.message}\n`);
						resultCode = 130;
						return 130;
					}
					throw error;
				} finally {
					const operationStage = stage;
					stage = "close";
					service.close();
					stage = operationStage;
					if (resultCode !== undefined) {
						logger.info(resultCode === 130 ? "docs.cli.command.cancelled" : "docs.cli.command.completed", {
							...fields,
							stage,
							result: resultCode === 130 ? "cancelled" : "completed",
							exit_code: resultCode,
							elapsed_ms: performance.now() - started,
						});
					}
				}
			} catch (error) {
				logger.warn("docs.cli.command.failed", {
					...fields,
					stage,
					result: "failed",
					elapsed_ms: performance.now() - started,
					...logger.diagnosticError(error),
				});
				throw error;
			}
		},
	);
}
