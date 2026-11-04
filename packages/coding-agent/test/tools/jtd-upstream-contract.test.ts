import { describe, expect, it } from "bun:test";
import { validateJsonSchemaValue } from "@oh-my-pi/pi-ai/utils/schema/json-schema-validator";
import { jtdToJsonSchema } from "../../src/tools/jtd-to-json-schema";

const forms = [
	{
		name: "enum",
		form: { enum: ["pending", "done"] },
		expected: { enum: ["pending", "done"] },
		accepted: "done",
		rejected: "unknown",
	},
	{
		name: "elements",
		form: { elements: { type: "int32" } },
		expected: { type: "array", items: { type: "integer" } },
		accepted: [1, 2],
		rejected: [1, "not an integer"],
	},
	{
		name: "type",
		form: { type: "float64" },
		expected: { type: "number" },
		accepted: 1.5,
		rejected: "1.5",
	},
	{
		name: "values",
		form: { values: { type: "boolean" } },
		expected: { type: "object", additionalProperties: { type: "boolean" } },
		accepted: { first: true, second: false },
		rejected: { first: "true" },
	},
	{
		name: "properties",
		form: { properties: { name: { type: "string" } }, optionalProperties: { score: { type: "uint32" } } },
		expected: {
			type: "object",
			properties: { name: { type: "string" }, score: { type: "integer" } },
			required: ["name"],
			additionalProperties: false,
		},
		accepted: { name: "report", score: 3 },
		rejected: { score: 3 },
	},
	{
		name: "discriminator",
		form: {
			discriminator: "kind",
			mapping: {
				text: { properties: { body: { type: "string" } } },
				count: { properties: { value: { type: "int32" } } },
			},
		},
		expected: {
			oneOf: [
				{
					type: "object",
					properties: { body: { type: "string" }, kind: { const: "text" } },
					required: ["body", "kind"],
					additionalProperties: false,
				},
				{
					type: "object",
					properties: { value: { type: "integer" }, kind: { const: "count" } },
					required: ["value", "kind"],
					additionalProperties: false,
				},
			],
		},
		accepted: { kind: "count", value: 2 },
		rejected: { kind: "text", value: 2 },
	},
	{
		name: "ref",
		form: { ref: "entry" },
		expected: { $ref: "#/$defs/entry" },
		accepted: "linked value",
		rejected: false,
	},
];

describe("upstream JTD form contracts", () => {
	// Check generated schemas through the same validator used by task output,
	// not merely by comparing a converted object to constants.
	it.each(forms)(
		"preserves the $name form for an output-schema consumer",
		({ form, expected, accepted, rejected }) => {
			const converted = jtdToJsonSchema({
				definitions: { entry: { type: "string" } },
				properties: { payload: form },
			});
			expect(converted).toEqual({
				type: "object",
				properties: { payload: expected },
				required: ["payload"],
				additionalProperties: false,
				$defs: { entry: { type: "string" } },
			});
			expect(validateJsonSchemaValue(converted, { payload: accepted }).success).toBe(true);
			expect(validateJsonSchemaValue(converted, { payload: rejected }).success).toBe(false);
			expect(validateJsonSchemaValue(converted, {}).success).toBe(false);
			expect(validateJsonSchemaValue(converted, { payload: accepted, extra: true }).success).toBe(false);
		},
	);

	// The empty form accepts arbitrary values but must not open its parent.
	it("keeps an empty form unconstrained without dropping the enclosing required property", () => {
		const converted = jtdToJsonSchema({ properties: { payload: {} } });
		for (const payload of [null, false, 3, "text", [1], { arbitrary: "data" }]) {
			expect(validateJsonSchemaValue(converted, { payload }).success).toBe(true);
		}
		expect(validateJsonSchemaValue(converted, {}).success).toBe(false);
		expect(validateJsonSchemaValue(converted, { payload: null, extra: true }).success).toBe(false);
	});
});
