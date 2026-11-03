import * as path from "node:path";
import { getAgentDir, logger, sanitizeText } from "@oh-my-pi/pi-utils";
import { KnowledgeService } from "../knowledge/service";
import type { KnowledgeProgress } from "../knowledge/types";

export type KnowledgeAction = "init" | "remove";

export interface KnowledgeCommandInput {
	action: KnowledgeAction;
	target?: string;
	name?: string;
	json?: boolean;
	cwd?: string;
	signal?: AbortSignal;
}

export interface KnowledgeCliDependencies {
	createService?: (cwd: string) => Promise<KnowledgeService>;
	stdout?: (text: string) => void;
	stderr?: (text: string) => void;
}

function sanitizeTerminalLine(text: string): string {
	return sanitizeText(text).replace(/[\n\t]+/g, " ");
}

function progressLine(progress: KnowledgeProgress): string {
	const path = progress.currentPath ? ` ${sanitizeTerminalLine(progress.currentPath)}` : "";
	const message = progress.message ? ` — ${sanitizeTerminalLine(progress.message)}` : "";
	return `${progress.phase} ${progress.completed}/${progress.total} failed=${progress.failed}${path}${message}\n`;
}

function commandRejectionReason(
	error: unknown,
	input: KnowledgeCommandInput,
	service: KnowledgeService,
): string | undefined {
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

export async function runKnowledgeCommand(
	input: KnowledgeCommandInput,
	dependencies: KnowledgeCliDependencies = {},
): Promise<number> {
	return logger.withLogContext(
		{ operation_id: logger.getLogContext().operation_id ?? `knowledge-cli-${crypto.randomUUID()}` },
		async () => {
			const started = performance.now();
			let stage = "open";
			let resultCode: number | undefined;
			let rejectionReason: string | undefined;
			const fields = { component: "knowledge.cli", event: "knowledge.cli.command", action: input.action };
			logger.info("knowledge.cli.command.started", { ...fields, stage, result: "started" });
			try {
				const cwd = input.cwd ?? process.cwd();
				const stdoutSink = dependencies.stdout ?? (text => process.stdout.write(text));
				const stderrSink = dependencies.stderr ?? (text => process.stderr.write(text));
				const stdout = (text: string): void => stdoutSink(sanitizeText(text));
				const stderr = (text: string): void => stderrSink(sanitizeText(text));
				const service = dependencies.createService
					? await dependencies.createService(cwd)
					: new KnowledgeService({ agentDir: getAgentDir(), cwd });
				const onProgress = input.json ? undefined : (progress: KnowledgeProgress) => stderr(progressLine(progress));
				try {
					let value: unknown;
					stage = input.action;
					const exitCode = 0;
					switch (input.action) {
						case "init": {
							const result = await service.init(input.target as string, input.name as string, {
								signal: input.signal,
								onProgress,
							});
							value = result;
							if (result.vectorStatus === "failed") {
								stderr(
									"Warning: Full-text index saved, but vector generation failed; search will use full-text retrieval.\n",
								);
							}
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
						logger.info(
							resultCode === 130 ? "knowledge.cli.command.cancelled" : "knowledge.cli.command.completed",
							{
								...fields,
								stage,
								result: resultCode === 130 ? "cancelled" : "completed",
								exit_code: resultCode,
								elapsed_ms: performance.now() - started,
							},
						);
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
						? "knowledge.cli.command.cancelled"
						: reason
							? "knowledge.cli.command.rejected"
							: "knowledge.cli.command.failed",
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
