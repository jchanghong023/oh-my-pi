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
import type { SpecRunContext, SpecTask, SpecToolRecord } from "./types";

const verifySchema = type({ validationId: "string", stage: "'red' | 'green'" });
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
}): Promise<SpecToolRecord> {
	input.context.signal.throwIfAborted();
	const startedAt = Date.now();
	const command = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh";
	const args = process.platform === "win32" ? ["/d", "/s", "/c", input.command] : ["-c", input.command];
	const result = await execCommand(command, args, input.cwd, { signal: input.context.signal });
	const finishedAt = Date.now();
	const id = `verify-${crypto.randomUUID()}`;
	const content = JSON.stringify({ command: input.command, cwd: input.cwd, startedAt, finishedAt, ...result });
	await fs.mkdir(input.artifactDir, { recursive: true });
	const artifactPath = path.join(input.artifactDir, `${id}.json`);
	await fs.writeFile(artifactPath, content, { flag: "wx" });
	input.context.signal.throwIfAborted();
	return {
		id,
		runId: input.context.runId,
		generation: input.context.generation,
		toolCallId: input.toolCallId,
		tool: "spec_verify",
		args: { command: input.command, cwd: input.cwd },
		startedAt,
		finishedAt,
		result: { exitCode: result.code, stdout: result.stdout, stderr: result.stderr, isError: result.killed },
		artifact: { path: artifactPath, version: artifactVersion(content) },
	};
}

export function createSpecExecutionTools(input: {
	session: ToolSession;
	task: SpecTask;
	context: SpecRunContext;
	artifactDir: string;
	onRecord(record: SpecToolRecord, validationId: string, stage: "red" | "green"): void;
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
			const result = await write.execute(
				id,
				params,
				AbortSignal.any([input.context.signal, ...(signal ? [signal] : [])]),
			);
			await capture(mutation);
			return result;
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
			const result = await edit.execute(
				id,
				params,
				AbortSignal.any([input.context.signal, ...(signal ? [signal] : [])]),
			);
			await capture(mutation);
			return result;
		},
	};
	const verify: CustomTool<typeof verifySchema> = {
		name: "spec_verify",
		label: "Approved verification",
		description: verifyDescription.trim(),
		parameters: verifySchema,
		strict: true,
		async execute(toolCallId, params, _update, _ctx, signal) {
			const validation = input.task.validation.find(item => item.id === params.validationId);
			if (!validation) throw new Error(`Unapproved validation ID: ${params.validationId}`);
			const context = {
				...input.context,
				signal: AbortSignal.any([input.context.signal, ...(signal ? [signal] : [])]),
			};
			const record = await recordSpecCommand({
				cwd: input.session.cwd,
				command: validation.command,
				toolCallId,
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
