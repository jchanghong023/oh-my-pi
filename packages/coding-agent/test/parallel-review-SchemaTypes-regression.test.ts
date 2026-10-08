import { describe, expect, it } from "bun:test";
import { validateJsonSchemaValue } from "@oh-my-pi/pi-ai/utils/schema/json-schema-validator";
import { isJTDSchema, jtdToJsonSchema } from "../src/tools/jtd-to-json-schema";

describe("JTD document constraint regressions", () => {
	it("does not discard a JSON Schema additionalProperties constraint beside definitions", () => {
		const input = {
			definitions: { text: { type: "string" } },
			additionalProperties: false,
		};
		const converted = jtdToJsonSchema(input);
		expect(isJTDSchema(input)).toBe(false);
		expect(converted).toBe(input);
		expect(validateJsonSchemaValue(converted, {}).success).toBe(true);
		expect(validateJsonSchemaValue(converted, { extra: "forbidden" }).success).toBe(false);
	});

	it("allows additional properties in a referenced open JTD object while checking declared properties", () => {
		const converted = jtdToJsonSchema({
			definitions: {
				entry: {
					properties: { name: { type: "string" } },
					additionalProperties: true,
				},
			},
			ref: "entry",
		});
		expect(validateJsonSchemaValue(converted, { name: "valid", extra: 1 }).success).toBe(true);
		expect(validateJsonSchemaValue(converted, { name: 1, extra: 1 }).success).toBe(false);
		expect(validateJsonSchemaValue(converted, { extra: 1 }).success).toBe(false);
	});

	it("emits URI-fragment refs without confusing literal percent escapes with pointer separators", () => {
		const converted = jtdToJsonSchema({
			definitions: {
				"a%2Fb /~1 空\n": { type: "string" },
			},
			ref: "a%2Fb /~1 空\n",
		}) as Record<string, unknown>;
		expect(converted.$ref).toBe("#/$defs/a%252Fb%20~1~01%20%E7%A9%BA%0A");
		expect(validateJsonSchemaValue(converted, "valid").success).toBe(true);
		expect(validateJsonSchemaValue(converted, false).success).toBe(false);
	});
});
