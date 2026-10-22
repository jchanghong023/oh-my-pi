import { fromJsonSchema } from "@oh-my-pi/omptype/from-json-schema";
import { Type } from "@oh-my-pi/omptype/typebox";
import { z } from "zod";
import type { CustomTool } from "../../extensibility/custom-tools/types";
import automationPrompt from "../../prompts/zcode-automation.md" with { type: "text" };
import { LegacyProtocol as P } from "./schema";

export interface ZCodeAutomationToolContext {
	/** The existing reverse-request owner must honor cancellation before dispatch; never replay mutations. */
	request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
	/** Read the actual executing input provenance, not the latest historical user message. */
	execution(): ZCodeAutomationExecution;
}

export interface ZCodeAutomationExecution {
	sessionId: string;
	modelSelection?: P.ZCodeAutomationCreateProtocolParams["modelSelection"];
	mode?: P.ZCodeAutomationCreateProtocolParams["mode"];
	automationTurn: boolean;
}

const text = z.string().trim().min(1);
const intervalFields = {
	intervalUnit: z.enum(["minute", "hourly", "daily", "weekly", "monthly", "yearly"]).optional(),
	interval: z.number().int().min(1).max(200).optional(),
};
const createParameters = z
	.object({
		cron: text
			.optional()
			.describe(
				"Five-field local-time cron; omit for relative delayMinutes. Use a legal compatible cron with intervalUnit/interval, e.g. 49 * * * * for every 31 hours at minute 49.",
			),
		delayMinutes: z
			.number()
			.int()
			.positive()
			.max(525_600)
			.nullable()
			.optional()
			.describe(
				"Relative delay in whole minutes. Host computes from its real clock; omit cron, use recurring=false and omit maxRuns.",
			),
		title: text.describe("Preserve the user's natural-language schedule phrase verbatim."),
		prompt: text.describe(
			"Complete final scheduled work; do not ask it to create or schedule another automation or call CronCreate.",
		),
		recurring: z.boolean().optional(),
		maxRuns: z.number().int().positive().optional(),
		...intervalFields,
	})
	.strict();
const updateParameters = z
	.object({
		id: text,
		title: text.describe("Required synchronized final title, preserving the schedule phrase."),
		cron: text.optional(),
		prompt: text.optional(),
		recurring: z.boolean().optional(),
		maxRuns: z.number().int().positive().nullable().optional(),
		...intervalFields,
	})
	.strict();
const emptyParameters = z.object({}).strict();
const deleteParameters = z.object({ id: text }).strict();

// Derive native declarations from the strict input schemas rather than maintaining
// a second parameter contract. Intersect supplies the native TypeBox compatibility
// surface; execution still applies Zod's normalization and public wire validation.
const nativeCreateParameters = Type.Intersect([fromJsonSchema(z.toJSONSchema(createParameters, { io: "input" }))]);
const nativeUpdateParameters = Type.Intersect([fromJsonSchema(z.toJSONSchema(updateParameters, { io: "input" }))]);
const nativeEmptyParameters = Type.Intersect([fromJsonSchema(z.toJSONSchema(emptyParameters, { io: "input" }))]);
const nativeDeleteParameters = Type.Intersect([fromJsonSchema(z.toJSONSchema(deleteParameters, { io: "input" }))]);

function checkSignal(signal?: AbortSignal): void {
	signal?.throwIfAborted();
}
function assertWritable(context: ZCodeAutomationToolContext, signal?: AbortSignal): ZCodeAutomationExecution {
	checkSignal(signal);
	const execution = context.execution();
	if (execution.automationTurn)
		throw new Error("Schedule mutation is not allowed while running a scheduled automation.");
	return execution;
}
function modelAutomation(value: P.ZCodeAutomationProtocol) {
	// Session/model/permission routing is Host metadata, not model-controlled scheduling state.
	const { modelSelection: _modelSelection, mode: _mode, targetTaskId: _targetTaskId, ...automation } = value;
	return automation;
}
function result<T>(details: T) {
	return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
}

/** Adapter-only tools: native SDK approval/loop, strict public reverse protocol, single Host schedule owner. */
export function createZCodeAutomationTools(context: ZCodeAutomationToolContext): CustomTool[] {
	const request = async (method: string, params: unknown, signal?: AbortSignal) => {
		checkSignal(signal);
		const value = await context.request(method, params, signal);
		checkSignal(signal);
		return value;
	};
	return [
		{
			name: "CronCreate",
			label: "Create scheduled automation",
			loadMode: "essential",
			approval: "write",
			strict: false,
			description: automationPrompt,
			parameters: nativeCreateParameters,
			execute: async (_id, raw, _onUpdate, _ctx, signal) => {
				const execution = assertWritable(context, signal);
				const input = createParameters.parse(raw);
				const relative = typeof input.delayMinutes === "number";
				if (relative && (input.cron !== undefined || input.recurring === true || input.maxRuns !== undefined))
					throw new Error("A relative delay must omit cron/maxRuns and cannot use recurring=true.");
				if (!relative && !input.cron) throw new Error("cron is required unless delayMinutes is set.");
				if (input.recurring === true && input.maxRuns !== undefined)
					throw new Error("recurring=true cannot combine with maxRuns.");
				const params = P.zcodeAutomationCreateParamsSchema.parse({
					cronExpr: input.cron ?? "* * * * *",
					...(relative ? { relativeDelayMinutes: input.delayMinutes } : {}),
					title: input.title,
					prompt: input.prompt,
					recurring: relative ? false : input.intervalUnit !== undefined ? true : (input.recurring ?? true),
					...(input.maxRuns === undefined ? {} : { maxRuns: input.maxRuns }),
					...(input.intervalUnit === undefined ? {} : { intervalUnit: input.intervalUnit }),
					...(input.interval === undefined ? {} : { interval: input.interval }),
					...(execution.modelSelection ? { modelSelection: execution.modelSelection } : {}),
					...(execution.mode ? { mode: execution.mode } : {}),
					targetTaskId: execution.sessionId,
				});
				if (input.intervalUnit !== undefined && input.recurring === false)
					throw new Error("intervalUnit requires recurring=true.");
				// Fail closed on a bound session, as well as an explicitly scheduled input turn.
				const bindingParams = P.zcodeAutomationCheckTaskBindingParamsSchema.parse({
					targetTaskId: execution.sessionId,
				});
				const binding = P.zcodeAutomationCheckTaskBindingResultSchema.parse(
					await request(P.zcodeProtocolMethods.automationCheckTaskBinding, bindingParams, signal),
				);
				if (binding.bound)
					throw new Error(
						"Cannot create another automation from a session already bound to scheduled automation.",
					);
				assertWritable(context, signal);
				const response = P.zcodeAutomationCreateResultSchema.parse(
					await request(P.zcodeProtocolMethods.automationCreate, params, signal),
				);
				return result({
					automation: modelAutomation(response.automation),
					message: `Created automation ${response.automation.automationId}.`,
				});
			},
		},
		{
			name: "CronList",
			label: "List scheduled automations",
			loadMode: "essential",
			approval: "read",
			parameters: nativeEmptyParameters,
			description:
				"List persistent scheduled automations in the current workspace, including actual ids and authoritative scheduleRule intervals.",
			execute: async (_id, raw, _onUpdate, _ctx, signal) => {
				const params = P.zcodeAutomationListParamsSchema.parse(emptyParameters.parse(raw));
				const response = P.zcodeAutomationListResultSchema.parse(
					await request(P.zcodeProtocolMethods.automationList, params, signal),
				);
				return result({ automations: response.automations.map(modelAutomation) });
			},
		},
		{
			name: "CronUpdate",
			label: "Update scheduled automation",
			loadMode: "essential",
			approval: "write",
			strict: false,
			parameters: nativeUpdateParameters,
			description: `Update a current-workspace automation by actual id. Supply the synchronized final title. ${automationPrompt}`,
			execute: async (_id, raw, _onUpdate, _ctx, signal) => {
				assertWritable(context, signal);
				const { id, cron, ...input } = updateParameters.parse(raw);
				if (input.maxRuns === null && input.recurring !== true)
					throw new Error("Clearing maxRuns requires recurring=true in the same update.");
				if (input.intervalUnit !== undefined && (input.recurring === false || typeof input.maxRuns === "number"))
					throw new Error("An interval carrier cannot use finite recurrence/maxRuns.");
				const params = P.zcodeAutomationUpdateParamsSchema.parse({
					automationId: id,
					...input,
					...(cron === undefined ? {} : { cronExpr: cron }),
					...(input.intervalUnit === undefined ? {} : { recurring: true, maxRuns: null }),
				});
				const response = P.zcodeAutomationUpdateResultSchema.parse(
					await request(P.zcodeProtocolMethods.automationUpdate, params, signal),
				);
				return result({
					automation: modelAutomation(response.automation),
					message: `Updated automation ${response.automation.automationId}.`,
				});
			},
		},
		{
			name: "CronDelete",
			label: "Delete scheduled automation",
			loadMode: "essential",
			approval: "write",
			parameters: nativeDeleteParameters,
			description:
				"Delete a current-workspace scheduled automation by actual id. Not allowed during scheduled automation execution. Never retry a failed or cancelled mutation automatically.",
			execute: async (_id, raw, _onUpdate, _ctx, signal) => {
				assertWritable(context, signal);
				const input = deleteParameters.parse(raw);
				const params = P.zcodeAutomationDeleteParamsSchema.parse({ automationId: input.id });
				const response = P.zcodeAutomationDeleteResultSchema.parse(
					await request(P.zcodeProtocolMethods.automationDelete, params, signal),
				);
				return result({
					deleted: response.deleted,
					id: input.id,
					message: response.deleted
						? `Deleted automation ${input.id}.`
						: `Automation ${input.id} was not found in the current workspace.`,
				});
			},
		},
	];
}
