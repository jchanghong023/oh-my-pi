import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fromJsonSchema } from "@oh-my-pi/omptype/from-json-schema";
import { Type } from "@oh-my-pi/omptype/typebox";
import { z } from "zod";
import type { CustomTool } from "../../../extensibility/custom-tools/types";
import workflowPrompt from "../../../prompts/zcode-workflow.md" with { type: "text" };
import type { ZCodeSessionRecord } from "../sessions";
import { parseSavedWorkflow, validateWorkflowArgs } from "./definitions";
import type { ZCodeWorkflowService, WorkflowPreparation } from "./service";

export interface ZCodeWorkflowToolContext {
	record(): ZCodeSessionRecord;
	service: ZCodeWorkflowService;
}

// Model-facing fields from the pinned original CreateWorkflow contract. Resolved
// runtime facts are deliberately not accepted as model-controlled parameters.
const createParameters = z
	.object({
		name: z.string().min(1).optional(),
		script: z.string().optional(),
		saved: z
			.object({
				name: z.string().min(1).max(64),
				args: z.record(z.string(), z.unknown()).optional(),
				path: z.string().min(1).optional(),
				scope: z.enum(["project", "global"]).optional(),
			})
			.strict()
			.optional(),
		path: z.string().min(1).optional(),
		args: z.record(z.string(), z.unknown()).optional(),
		max_concurrency: z.number().int().positive().optional(),
		subagent_model: z.string().trim().min(1).optional(),
	})
	.strict();
const resumeParameters = z.object({ run_id: z.string().min(1) }).strict();
const createSchema = Type.Intersect([fromJsonSchema(z.toJSONSchema(createParameters, { io: "input" }))]);
const resumeSchema = Type.Intersect([fromJsonSchema(z.toJSONSchema(resumeParameters, { io: "input" }))]);

function inputIdentity(record: ZCodeSessionRecord): string {
	// Native state contains delivered inputs only, never accepted-but-queued ones.
	for (let index = record.session.state.messages.length - 1; index >= 0; index--) {
		const message = record.session.state.messages[index];
		if (
			message &&
			(message.role === "user" || message.role === "custom") &&
			"inputId" in message &&
			typeof message.inputId === "string" &&
			message.inputId
		)
			return message.inputId;
	}
	throw new Error("Workflow execution requires a delivered native input identity");
}
function result(value: unknown, details: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details };
}
function preparedResult(preparation: WorkflowPreparation) {
	if (preparation.ok) throw new Error("Expected workflow preparation failure");
	if (preparation.reason !== "compile_failed") throw new Error(preparation.message);
	const diagnostics = preparation.diagnostics ?? [];
	return result(
		{
			ok: false,
			diagnostics,
			response: `${preparation.message}\nThe workflow was NOT executed. Fix the errors and resubmit.`,
		},
		{
			kind: "create_workflow",
			ok: false,
			errorCount: diagnostics.length,
			diagnostics: diagnostics.slice(0, 100).map(item => ({ ...item, message: item.message.slice(0, 2048) })),
			...(diagnostics.length > 100 ? { truncated: true } : {}),
		},
	);
}

/** Adapter-only registration; execution, replay and cancellation belong to the real service. */
export function createZCodeWorkflowTools(context: ZCodeWorkflowToolContext): CustomTool[] {
	return [
		{
			name: "CreateWorkflow",
			label: "Create workflow",
			loadMode: "essential",
			approval: "write",
			strict: false,
			parameters: createSchema,
			description: workflowPrompt,
			execute: async (toolCallId, raw, _onUpdate, _context, signal) => {
				signal?.throwIfAborted();
				const input = createParameters.parse(raw);
				if ([input.script, input.saved, input.path].filter(value => value !== undefined).length !== 1)
					throw new Error("Provide exactly one workflow source: script, saved, or path.");
				if (input.args !== undefined && input.path === undefined)
					throw new Error(
						"args belongs to the path source; saved workflows use saved.args and inline scripts take no args.",
					);
				const record = context.record();
				const inputId = inputIdentity(record);
				let preparation: WorkflowPreparation;
				if (input.saved) {
					const saved = input.saved;
					preparation = await context.service.prepareSaved({
						cwd: record.cwd,
						name: saved.name,
						scope: saved.scope,
						args: saved.args,
					});
					if (!preparation.ok && preparation.reason === "not_found" && saved.scope === undefined)
						preparation = await context.service.prepareSaved({
							cwd: record.cwd,
							name: saved.name,
							scope: "global",
							args: saved.args,
						});
					if (preparation.ok && input.name) preparation.prepared.name = input.name;
				} else if (input.path !== undefined) {
					const path = resolve(record.cwd, input.path);
					const source = await readFile(path, "utf8");
					const hasMeta = source.trimStart().startsWith("/* zcode-workflow");
					const parsed = hasMeta ? parseSavedWorkflow(source) : undefined;
					if (parsed && !parsed.ok) throw new Error(parsed.detail);
					const args = validateWorkflowArgs(parsed?.ok ? parsed.meta.args : undefined, input.args);
					if (!args.ok) throw new Error(args.errors.join("\n"));
					preparation = await context.service.prepareScript({
						cwd: record.cwd,
						script: parsed?.ok ? parsed.script : source,
						name: input.name,
						args: args.args,
					});
					if (preparation.ok) {
						preparation.prepared.path = path;
						if (parsed?.ok) preparation.prepared.meta = parsed.meta;
					}
				} else {
					preparation = await context.service.prepareScript({
						cwd: record.cwd,
						script: input.script!,
						name: input.name,
					});
				}
				signal?.throwIfAborted();
				if (!preparation.ok) return preparedResult(preparation);
				const launched = await context.service.submit(record, preparation.prepared, {
					toolCallId,
					inputId,
					signal,
					maxConcurrency: input.max_concurrency,
					subagentModel: input.subagent_model,
				});
				return result(
					{
						ok: true,
						diagnostics: [],
						status: "backgrounded",
						backgroundTaskId: launched.runId,
						response: `Workflow ${launched.runId} is running in the background. Follow its workflow run state; do not submit it again or poll repeatedly.`,
					},
					preparation.prepared.compiled.display,
				);
			},
		},
		{
			name: "ResumeWorkflowRun",
			label: "Resume workflow run",
			loadMode: "essential",
			approval: "write",
			parameters: resumeSchema,
			description: `Resume an existing stopped workflow run by run_id using its durable journal. ${workflowPrompt}`,
			execute: async (_toolCallId, raw, _onUpdate, _context, signal) => {
				signal?.throwIfAborted();
				const input = resumeParameters.parse(raw);
				const record = context.record();
				const resumed = await context.service.resume(record, input.run_id, signal);
				return result(
					{
						ok: true,
						runId: resumed.runId,
						status: "backgrounded",
						backgroundTaskId: resumed.runId,
						response: `Workflow ${resumed.runId} resumed in the background. Finished steps replay from its journal; do not submit a duplicate run.`,
					},
					{ kind: "resume_workflow_run", runId: resumed.runId },
				);
			},
		},
		{
			name: "ResolveWorkflowQuestion",
			label: "Answer workflow question",
			loadMode: "essential",
			approval: "read",
			parameters: Type.Object({ question_id: Type.String({ minLength: 1 }), answer: Type.String() }),
			description: "Answer a pending escalation from a workflow actor owned by this parent session.",
			execute: async (_toolCallId, raw, _onUpdate, _context, signal) => {
				signal?.throwIfAborted();
				const input = z
					.object({ question_id: z.string().min(1), answer: z.string() })
					.strict()
					.parse(raw);
				const answered = context.service.resolveQuestion(context.record().id, input.question_id, input.answer);
				return result({ ok: true, ...answered }, { kind: "resolve_workflow_question", ...answered });
			},
		},
	];
}
