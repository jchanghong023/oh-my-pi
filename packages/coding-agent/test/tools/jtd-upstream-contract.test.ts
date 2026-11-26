import { describe, expect, it } from "bun:test";
import { validateJsonSchemaValue } from "@oh-my-pi/pi-ai/utils/schema/json-schema-validator";
import { jtdToJsonSchema } from "../../src/tools/jtd-to-json-schema";

const forms = [
	{
		name: "elements",
		form: { elements: { type: "int32" } },
		accepted: [[1, 2]],
		rejected: [1, "not an integer"],
	},
	{
		name: "type",
		form: { type: "float64" },
		accepted: [1.5],
		rejected: "1.5",
	},
	{
		name: "values",
		form: { values: { type: "boolean" } },
		accepted: [{ first: true, second: false }],
		rejected: { first: "true" },
	},
	{
		name: "properties",
		form: { properties: { name: { type: "string" } }, optionalProperties: { score: { type: "uint32" } } },
		accepted: [{ name: "report" }, { name: "report", score: 3 }],
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
		accepted: [
			{ kind: "text", body: "note" },
			{ kind: "count", value: 2 },
		],
		rejected: { kind: "text", value: 2 },
	},
	{
		name: "ref",
		form: { ref: "entry" },
		accepted: ["linked value"],
		rejected: false,
	},
];

describe("upstream JTD form contracts", () => {
	// Check generated schemas through the same validator used by task output,
	// not merely by comparing a converted object to constants.
	it.each(forms)("preserves the $name form for an output-schema consumer", ({ form, accepted, rejected }) => {
		const converted = jtdToJsonSchema({
			definitions: { entry: { type: "string" } },
			properties: { payload: form },
		});
		for (const payload of accepted) {
			expect(validateJsonSchemaValue(converted, { payload }).success).toBe(true);
		}
		expect(validateJsonSchemaValue(converted, { payload: rejected }).success).toBe(false);
	});

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
