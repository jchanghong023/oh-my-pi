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

	it("preserves literal ref-shaped values and nested property constraints through strict sanitization", () => {
		const literal = {
			$ref: "#/$defs/Text",
			definitions: { keep: "literal" },
			$defs: { keep: "literal" },
		};
		const dereferenced = dereferenceJsonSchema({
			$defs: {
				Obj: { type: "object" },
				Text: { type: "string", enum: ["kept"] },
			},
			type: "object",
			properties: {
				payload: { $ref: "#/$defs/Obj", const: literal, default: literal },
				choice: { $ref: "#/$defs/Obj", enum: [literal], examples: [literal] },
				nested: {
					$ref: "#/$defs/Obj",
					properties: {
						$ref: { $ref: "#/$defs/Text" },
						$defs: {
							$ref: "#/$defs/Obj",
							properties: { definitions: { $ref: "#/$defs/Text" } },
							required: ["definitions"],
						},
						definitions: { $ref: "#/$defs/Text" },
					},
					required: ["$ref", "$defs", "definitions"],
				},
			},
			required: ["payload", "choice", "nested"],
		}) as Record<string, unknown>;
		const sanitized = sanitizeSchemaForStrictMode(dereferenced);
		expect(sanitized).toMatchObject({
			properties: {
				payload: { type: "object", enum: [literal] },
				choice: { type: "object", enum: [literal] },
				nested: {
					properties: {
						$ref: { type: "string", enum: ["kept"] },
						$defs: { properties: { definitions: { type: "string", enum: ["kept"] } } },
						definitions: { type: "string", enum: ["kept"] },
					},
				},
			},
		});
		const value = {
			payload: literal,
			choice: literal,
			nested: { $ref: "kept", $defs: { definitions: "kept" }, definitions: "kept" },
		};
		for (const schema of [dereferenced, sanitized]) {
			expect(validateJsonSchemaValue(schema, value).success).toBe(true);
			expect(validateJsonSchemaValue(schema, { ...value, payload: { type: "string" } }).success).toBe(false);
			expect(validateJsonSchemaValue(schema, { ...value, choice: { type: "string" } }).success).toBe(false);
			expect(
				validateJsonSchemaValue(schema, {
					...value,
					nested: { ...value.nested, $ref: false },
				}).success,
			).toBe(false);
			expect(
				validateJsonSchemaValue(schema, {
					...value,
					nested: { ...value.nested, $defs: { definitions: "rejected" } },
				}).success,
			).toBe(false);
			expect(
				validateJsonSchemaValue(schema, {
					...value,
					nested: { ...value.nested, definitions: false },
				}).success,
			).toBe(false);
		}
	});

	it("reports malformed fragments as unresolved", () => {
		const malformed = { $ref: "#/$defs/bad%", $defs: {} };
		expect(dereferenceJsonSchema(malformed)).toEqual(malformed);
		const result = validateJsonSchemaValue(malformed, "value");
		expect(result.success).toBe(false);
		expect(result.issues.some(issue => issue.keyword === "$ref")).toBe(true);
	});
});
