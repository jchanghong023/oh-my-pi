import { describe, expect, it } from "bun:test";
import { dereferenceJsonSchema, sanitizeSchemaForStrictMode } from "@oh-my-pi/pi-ai/utils/schema";
import { validateJsonSchemaValue } from "@oh-my-pi/pi-ai/utils/schema/json-schema-validator";

describe("URI-fragment schema references", () => {
	it("decodes percent escapes exactly once before JSON Pointer token unescaping", () => {
		const schema = {
			$defs: {
				"a%2Fb /~1 空\n": { type: "string" },
			},
			$ref: "#/$defs/a%252Fb%20~1~01%20%E7%A9%BA%0A",
		};
		expect(dereferenceJsonSchema(schema)).toEqual({ type: "string" });
		expect(validateJsonSchemaValue(schema, "valid").success).toBe(true);
		expect(validateJsonSchemaValue(schema, false).success).toBe(false);
	});

	it("inlines encoded refs with siblings before sending strict-mode schemas", () => {
		const sanitized = sanitizeSchemaForStrictMode({
			$defs: { "a%2Fb": { type: "string" }, "a/b": { type: "boolean" } },
			$ref: "#/$defs/a%252Fb",
			description: "referenced value",
		});
		expect(sanitized.$ref).toBeUndefined();
		expect(validateJsonSchemaValue(sanitized, "valid").success).toBe(true);
		expect(validateJsonSchemaValue(sanitized, false).success).toBe(false);
	});

	it("reports malformed fragments as unresolved", () => {
		const malformed = { $ref: "#/$defs/bad%", $defs: {} };
		expect(dereferenceJsonSchema(malformed)).toEqual(malformed);
		const result = validateJsonSchemaValue(malformed, "value");
		expect(result.success).toBe(false);
		expect(result.issues.some(issue => issue.keyword === "$ref")).toBe(true);
	});
});
