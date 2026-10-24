import { validateJsonSchemaValue } from "@oh-my-pi/pi-ai/utils/schema";
import type { SpecPlanDraft, SpecRequirementsDraft, SpecReview } from "./types";

type Schema = Record<string, unknown>;
const text = (minLength = 1): Schema => ({ type: "string", minLength, maxLength: 200000 });
const flag: Schema = { type: "boolean" };
const array = (items: Schema, minItems = 0): Schema => ({ type: "array", items, minItems, maxItems: 1000 });
const object = (properties: Record<string, Schema>): Schema => ({
	type: "object",
	properties,
	required: Object.keys(properties),
	additionalProperties: false,
});
const strings = array(text());
const condition = object({ id: text(), description: text(), command: text(), inputPaths: array(text(), 1) });
const validation = object({ id: text(), command: text(), behavior: text(), inputPaths: array(text(), 1) });
const sourcePatch: Schema = {
	anyOf: [
		object({ operation: { type: "string", enum: ["modify", "remove"] }, sourceId: text(), replacement: text(0) }),
		{
			...object({
				operation: { type: "string", const: "rename" },
				sourceId: text(),
				replacement: text(),
				destinationPath: text(),
			}),
			required: ["operation", "sourceId", "replacement"],
		},
		{
			...object({
				operation: { type: "string", const: "add" },
				path: text(),
				content: text(),
				afterSourceId: text(),
			}),
			required: ["operation", "path", "content"],
		},
	],
};
export const SPEC_REQUIREMENTS_SCHEMA: Schema = {
	...object({
		document: object({ path: { type: "string", const: "requirements.md" }, content: text() }),
		proposal: text(),
		specs: array(object({ path: text(), content: text() }), 1),
		requirements: array(object({ id: text(), text: text() }), 1),
		questions: strings,
		sourceMapVersion: text(),
		sourcePatches: array(sourcePatch),
	}),
	required: ["document", "proposal", "specs", "requirements", "questions"],
};
export const SPEC_TASK_SCHEMA: Schema = object({
	id: { type: "string", pattern: "^T[0-9]{3,}$" },
	title: text(),
	instructions: text(),
	requirementIds: array(text(), 1),
	dependencies: strings,
	conditionIds: strings,
	ownedPaths: strings,
	implementationPaths: strings,
	solutionBinding: text(),
	validation: array(validation, 1),
	tdd: {
		anyOf: [
			object({ mode: { const: "required", type: "string" }, behavior: text() }),
			object({
				mode: { const: "exception", type: "string" },
				reason: text(),
				alternativeCommands: array(text(), 1),
			}),
		],
	},
});
export const SPEC_PLAN_SCHEMA: Schema = object({
	content: text(),
	workspace: object({
		executionPath: text(),
		isolation: { type: "string", enum: ["none", "native"] },
		integration: { type: "string", const: "native" },
	}),
	tasks: array(SPEC_TASK_SCHEMA, 1),
	conditions: array(condition),
	finalValidation: array(
		object({ id: text(), command: text(), behavior: text(), inputPaths: array(text(), 1), realEntry: flag }),
		1,
	),
	closure: object({ sync: flag, archive: flag }),
});
export const SPEC_REVIEW_SCHEMA: Schema = object({
	verdict: { type: "string", enum: ["pass", "revise", "clarify"] },
	summary: text(),
	findings: array(
		object({
			id: text(),
			severity: { type: "string", enum: ["blocking", "important", "minor"] },
			issue: text(),
			evidence: text(),
			taskIds: strings,
		}),
	),
	resolutions: array(object({ findingId: text(), resolved: flag, evidence: text() })),
	questions: strings,
	evidenceChecks: array(object({ recordId: text(), behavior: text(), valid: flag, reason: text() })),
});

function parse<T>(value: unknown, schema: Schema, label: string): T {
	let parsed = value;
	if (typeof parsed === "string") {
		try {
			parsed = JSON.parse(parsed);
		} catch {
			throw new Error(`Invalid ${label}: malformed JSON`);
		}
	}
	if (!validateJsonSchemaValue(schema, parsed).success) throw new Error(`Invalid ${label}: output schema mismatch`);
	return parsed as T;
}
function unique(values: readonly string[], label: string): void {
	if (new Set(values).size !== values.length) throw new Error(`Invalid ${label}: duplicate IDs`);
}
export function parseSpecRequirements(value: unknown): SpecRequirementsDraft {
	const draft = parse<SpecRequirementsDraft>(value, SPEC_REQUIREMENTS_SCHEMA, "requirements");
	unique(
		draft.requirements.map(item => item.id),
		"requirement",
	);
	unique(
		draft.specs.map(item => item.path),
		"spec path",
	);
	if ((draft.sourceMapVersion === undefined) !== (draft.sourcePatches === undefined)) {
		throw new Error("Source mapping and reviewed patches must be supplied together");
	}
	return draft;
}
function relativeSelection(value: string, label: string): void {
	if (
		!value.trim() ||
		/^[\\/]/.test(value) ||
		/[:\0\r\n$`|;&<>*?{}()[\]!]/.test(value) ||
		value.split(/[\\/]/).includes("..")
	)
		throw new Error(`Invalid ${label}: expected a workspace-relative file or directory`);
}
export function parseSpecPlan(value: unknown): SpecPlanDraft {
	const draft = parse<SpecPlanDraft>(value, SPEC_PLAN_SCHEMA, "plan");
	relativeSelection(draft.workspace.executionPath, "workspace");
	for (const item of [
		...draft.conditions,
		...draft.finalValidation,
		...draft.tasks.flatMap(task => task.validation),
	]) {
		for (const input of item.inputPaths) relativeSelection(input, "validation input path");
	}
	unique(
		draft.tasks.map(item => item.id),
		"task",
	);
	unique(
		draft.conditions.map(item => item.id),
		"condition",
	);
	unique(
		draft.finalValidation.map(item => item.id),
		"final validation",
	);
	for (const task of draft.tasks) {
		unique(task.dependencies, "dependency");
		unique(task.requirementIds, "requirement reference");
		unique(task.conditionIds, "condition reference");
		if (
			task.tdd.mode === "exception" &&
			(!task.tdd.reason.trim() || task.tdd.alternativeCommands.some(command => !command.trim()))
		)
			throw new Error(`Invalid TDD exception in ${task.id}`);
		unique(
			task.validation.map(item => item.id),
			"task validation",
		);
		if (task.dependencies.includes(task.id)) throw new Error(`Task ${task.id} depends on itself`);
	}
	return draft;
}
export function parseSpecReview(value: unknown): SpecReview {
	const review = parse<SpecReview>(value, SPEC_REVIEW_SCHEMA, "review");
	unique(
		review.findings.map(item => item.id),
		"finding",
	);
	unique(
		review.resolutions.map(item => item.findingId),
		"resolution",
	);
	if (
		review.verdict === "pass" &&
		(review.questions.length || review.findings.some(item => item.severity !== "minor"))
	) {
		throw new Error("Invalid review: pass with unresolved substantive findings or questions");
	}
	if (review.verdict === "clarify" && !review.questions.length)
		throw new Error("Invalid review: clarification has no question");
	return review;
}
