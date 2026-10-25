import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { CustomTool } from "../extensibility/custom-tools/types";
import { EditTool } from "../edit";
import { replaceEditSchema } from "../edit/schemas";
import { execCommand } from "../exec/exec";
import type { ToolSession } from "../sdk";
import { WriteTool } from "../tools/write";
import { artifactVersion, containedSpecPath } from "./artifacts";
import verifyDescription from "../prompts/tools/spec-verify.md" with { type: "text" };
import type { SpecEvidenceBinding, SpecInputIdentity, SpecRunContext, SpecTask, SpecToolRecord } from "./types";
import type { SpecEvidenceService } from "./evidence";

const verifySchema = type({
	validationId: "string",
	stage: "'red' | 'green'",
	"+": "reject",
});
export interface SpecExecutionTools {
	tools: CustomTool[];
	records: SpecToolRecord[];
	implementationStartedAt: number | null;
}
interface MutationCapture {
	absolute: string;
	relative: string;
	before: string | null;
	startedAt: number;
}

/** Exact files only: URI devices, selectors, archives and alternate streams never reach native mutation. */
export async function assertSpecOwnedPath(
	cwd: string,
	requested: string,
	ownedPaths: readonly string[],
): Promise<string> {
	if (!requested || requested.includes("://") || requested.includes("\0") || /[\[\]?#]/.test(requested))
		throw new Error("Task writes require an exact owned filesystem path");
	const relative = path.isAbsolute(requested) ? path.relative(cwd, requested) : requested;
	const normalized = relative.replaceAll("\\", "/");
	if (
		!ownedPaths.includes(normalized) ||
		normalized === ".git" ||
		normalized.startsWith(".git/") ||
		normalized.includes(":")
	)
		throw new Error(`Unowned task write: ${requested}`);
	return containedSpecPath(cwd, normalized);
}

export async function recordSpecCommand(input: {
	cwd: string;
	command: string;
	toolCallId: string;
	artifactDir: string;
	context: SpecRunContext;
	evidence?: {
		binding: SpecEvidenceBinding;
		capture(): Promise<SpecInputIdentity>;
	};
	obligation?: SpecToolRecord["obligation"];
}): Promise<SpecToolRecord> {
	input.context.signal.throwIfAborted();
	if (input.evidence && path.resolve(input.evidence.binding.workspace) !== path.resolve(input.cwd))
		throw new Error("Command evidence ownership does not match the actual cwd");
	const inputsBefore = (await input.evidence?.capture()) ?? null;
	const startedAt = Date.now();
	const command = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh";
	// cmd.exe consumes shell syntax, not CRT argv: keep inner quotes and supply its outer /s quote pair.
	const args = process.platform === "win32" ? ["/d", "/s", "/c", `"${input.command}"`] : ["-c", input.command];
	let result;
	try {
		result = await execCommand(command, args, input.cwd, {
			signal: input.context.signal,
			...(process.platform === "win32" ? { windowsVerbatimArguments: true } : {}),
		});
	} catch (error) {
		result = {
			code: -1,
			killed: input.context.signal.aborted,
			stdout: "",
			stderr: error instanceof Error ? error.message : String(error),
		};
	}
	const finishedAt = Date.now();
	let inputsAfter: SpecInputIdentity | null = null;
	let inputCaptureError: string | undefined;
	try {
		inputsAfter = (await input.evidence?.capture()) ?? null;
	} catch (error) {
		inputCaptureError = error instanceof Error ? error.message : String(error);
	}
	const id = `verify-${crypto.randomUUID()}`;
	const record: SpecToolRecord = {
		id,
		runId: input.context.runId,
		generation: input.context.generation,
		toolCallId: input.toolCallId,
		tool: "spec_verify",
		args: { command: input.command, cwd: input.cwd },
		startedAt,
		finishedAt,
		binding: input.evidence?.binding ?? null,
		inputsBefore,
		inputsAfter,
		conditions: {
			platform: process.platform,
			shell: command,
			runtime: process.execPath,
			runtimeVersion: process.versions.bun ?? process.version,
			...(inputCaptureError ? { inputCaptureError } : {}),
		},
		obligation: input.obligation ?? null,
		result: {
			status: result.killed ? "cancelled" : result.code === -1 || inputCaptureError ? "unknown" : "completed",
			exitCode: result.killed || result.code === -1 ? null : result.code,
			stdout: result.stdout,
			stderr: result.stderr,
			isError: result.killed || result.code === -1 || inputCaptureError !== undefined,
		},
		artifact: { path: path.join(input.artifactDir, `${id}.json`), version: "" },
	};
	// The raw envelope contains identity and observed output, including cancellation. Saving must precede return.
	const { artifact: _artifact, ...raw } = record;
	const content = JSON.stringify(raw);
	await fs.mkdir(input.artifactDir, { recursive: true });
	await fs.writeFile(record.artifact.path, content, { flag: "wx" });
	record.artifact.version = artifactVersion(content);
	return record;
}

export function createSpecExecutionTools(input: {
	session: ToolSession;
	task: SpecTask;
	context: SpecRunContext;
	artifactDir: string;
	onRecord(record: SpecToolRecord, validationId: string, stage: "red" | "green"): void;
	evidence?: SpecEvidenceService;
}): SpecExecutionTools {
	const state: SpecExecutionTools = { tools: [], records: [], implementationStartedAt: null };
	const write = new WriteTool(input.session);
	// Replace mode has a single explicit target and no rename/embedded device operations.
	const edit = new EditTool(input.session, "replace");
	const guard = async (requested: string, signal?: AbortSignal): Promise<MutationCapture> => {
		AbortSignal.any([input.context.signal, ...(signal ? [signal] : [])]).throwIfAborted();
		const absolute = await assertSpecOwnedPath(input.session.cwd, requested, input.task.ownedPaths);
		const relative = path.relative(input.session.cwd, absolute).replaceAll("\\", "/");
		let before: string | null = null;
		try {
			before = artifactVersion(await fs.readFile(absolute, "utf8"));
		} catch (error) {
			if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
		}
		return { absolute, relative, before, startedAt: Date.now() };
	};
	const capture = async (mutation: MutationCapture): Promise<void> => {
		let after: string | null = null;
		try {
			after = artifactVersion(await fs.readFile(mutation.absolute, "utf8"));
		} catch (error) {
			if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
		}
		if (
			after !== mutation.before &&
			input.task.implementationPaths.includes(mutation.relative) &&
			state.implementationStartedAt === null
		)
			state.implementationStartedAt = mutation.startedAt;
	};
	const writeAdapter: CustomTool<typeof write.parameters> = {
		name: "write",
		label: write.label,
		description: write.description,
		parameters: write.parameters,
		strict: true,
		async execute(id, params, _update, _ctx, signal) {
			const mutation = await guard(params.path, signal);
			try {
				return await write.execute(
					id,
					params,
					AbortSignal.any([input.context.signal, ...(signal ? [signal] : [])]),
				);
			} finally {
				await capture(mutation);
			}
		},
	};
	const editAdapter: CustomTool<typeof replaceEditSchema> = {
		name: "edit",
		label: edit.label,
		description: edit.description,
		parameters: replaceEditSchema,
		strict: true,
		async execute(id, params, _update, _ctx, signal) {
			const mutation = await guard(params.path, signal);
			try {
				return await edit.execute(id, params, AbortSignal.any([input.context.signal, ...(signal ? [signal] : [])]));
			} finally {
				await capture(mutation);
			}
		},
	};
	const verify: CustomTool<typeof verifySchema> = {
		name: "spec_verify",
		label: "Approved verification",
		description: verifyDescription.trim(),
		parameters: verifySchema,
		strict: true,
		lenientArgValidation: true,
		async execute(toolCallId, params, _update, _ctx, signal) {
			verifySchema.assert(params);
			const validation = input.task.validation.find(item => item.id === params.validationId);
			if (!validation) throw new Error(`Unapproved validation ID: ${params.validationId}`);
			const context = {
				...input.context,
				signal: AbortSignal.any([input.context.signal, ...(signal ? [signal] : [])]),
			};
			const commandInput = {
				command: validation.command,
				toolCallId,
				obligation: {
					validationId: validation.id,
					approvedCommand: validation.command,
					stage: params.stage,
				},
			};
			const record = input.evidence
				? await input.evidence.recordCommand(
						{ ...commandInput, inputPaths: [...new Set([...validation.inputPaths, ...input.task.ownedPaths])] },
						context,
					)
				: await recordSpecCommand({
						...commandInput,
						cwd: input.session.cwd,
						artifactDir: input.artifactDir,
						context,
					});
			state.records.push(record);
			input.onRecord(record, validation.id, params.stage);
			return { content: [{ type: "text", text: JSON.stringify(record) }], details: {} };
		},
	};
	state.tools.push(writeAdapter, editAdapter, verify);
	return state;
}
