import { describe, expect, it } from "bun:test";
import { validateJsonSchemaValue } from "@oh-my-pi/pi-ai/utils/schema/json-schema-validator";
import { jtdToJsonSchema } from "../src/tools/jtd-to-json-schema";

describe("JTD document constraint regressions", () => {
	it("does not discard a JSON Schema additionalProperties constraint beside definitions", () => {
		const input = {
			definitions: { text: { type: "string" } },
			additionalProperties: false,
		};
		const converted = jtdToJsonSchema(input);
		expect(validateJsonSchemaValue(converted, {}).success).toBe(true);
		expect(validateJsonSchemaValue(converted, { extra: "forbidden" }).success).toBe(false);
	});

	it("converts JTD property forms to closed JSON Schema objects", () => {
		const closed = jtdToJsonSchema({ optionalProperties: { name: { type: "string" } } });
		const open = jtdToJsonSchema({
			optionalProperties: { name: { type: "string" } },
			additionalProperties: true,
		});
		expect(validateJsonSchemaValue(closed, { extra: 1 }).success).toBe(false);
		expect(validateJsonSchemaValue(open, { extra: 1 }).success).toBe(false);
		expect(validateJsonSchemaValue(open, { name: 1 }).success).toBe(false);
	});
});
