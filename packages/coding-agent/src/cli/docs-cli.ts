import * as path from "node:path";
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

function commandRejectionReason(error: unknown, input: DocsCommandInput, service: DocsService): string | undefined {
	if (!(error instanceof Error)) return undefined;
	// The service's expected rejections are plain Errors. Match their exact messages,
	// not broad patterns that could downgrade unrelated operational failures.
	if (input.action === "remove") {
		return error.message === `Unknown document index: ${input.target}` ? "not_found" : undefined;
	}
	if (typeof input.name === "string") {
		const name = input.name.trim();
		switch (error.message) {
			case "Document index name must not be empty":
			case "Document index name must contain at most 64 Unicode scalar values":
			case "Document index name must not contain control characters":
			case "Document index name uses reserved prefix: __building__":
				return "invalid_name";
			case `Document index already exists: ${name}`:
				return "duplicate_name";
		}
	}
	if (typeof input.target === "string" && typeof service.cwd === "string") {
		const root = path.resolve(service.cwd, input.target);
		if (error.message === `Markdown root is not a directory: ${root}`) return "source_not_directory";
		if (error.message === `No Markdown files found in: ${root}`) return "no_documents";
	}
	if (error.message === `Another document index build is already running for this profile: ${service.databasePath}`) {
		return "lock_contended";
	}
	return undefined;
}

export async function runDocsCommand(input: DocsCommandInput, dependencies: DocsCliDependencies = {}): Promise<number> {
	return logger.withLogContext(
		{ operation_id: logger.getLogContext().operation_id ?? `docs-cli-${crypto.randomUUID()}` },
		async () => {
			const started = performance.now();
			let stage = "open";
			let resultCode: number | undefined;
			let rejectionReason: string | undefined;
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
							await service.remove(input.target as string, { signal: input.signal });
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
					if (stage === input.action) rejectionReason = commandRejectionReason(error, input, service);
					throw error;
				} finally {
					const operationStage = stage;
					stage = "close";
					await service.close();
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
				const cancelled = error instanceof Error && error.name === "AbortError";
				const reason = stage === input.action ? rejectionReason : undefined;
				const log =
					cancelled || (reason && reason !== "lock_contended")
						? logger.info
						: reason === "lock_contended"
							? logger.warn
							: logger.error;
				log(
					cancelled
						? "docs.cli.command.cancelled"
						: reason
							? "docs.cli.command.rejected"
							: "docs.cli.command.failed",
					{
						...fields,
						stage,
						result: cancelled ? "cancelled" : reason ? "rejected" : "failed",
						reason,
						elapsed_ms: performance.now() - started,
						...logger.diagnosticError(error),
					},
				);
				throw error;
			}
		},
	);
}
