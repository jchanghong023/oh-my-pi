import { describe, expect, it } from "bun:test";
import { dereferenceJsonSchema } from "@oh-my-pi/pi-ai/utils/schema";

describe("dereferenceJsonSchema", () => {
	for (const referenced of [false, true]) {
		it(`preserves literal JSON in ${referenced ? "reference siblings" : "ordinary schemas"}`, () => {
			const literal = {
				$ref: "#/$defs/Text",
				$defs: { keep: "literal" },
				definitions: { keep: "literal" },
				properties: { nested: { $ref: "#/$defs/Text" } },
			};
			const annotations = {
				const: literal,
				enum: [literal],
				default: literal,
				examples: [literal],
				"x-payload": literal,
			};
			const schema = {
				$defs: { Text: { type: "string" }, Value: { type: "object" } },
				properties: { value: { ...(referenced ? { $ref: "#/$defs/Value" } : { type: "object" }), ...annotations } },
			};
			expect(dereferenceJsonSchema(schema)).toEqual({
				properties: { value: { type: "object", ...annotations } },
			});
		});

		it(`dereferences schema-valued keywords in ${referenced ? "reference siblings" : "ordinary schemas"}`, () => {
			const ref = { $ref: "#/$defs/Text" };
			const text = { type: "string" };
			const schema = {
				$defs: { Text: text, Value: { type: "object" } },
				...(referenced ? { $ref: "#/$defs/Value" } : { type: "object" }),
			};
			const namedRefs = { $ref: ref, $defs: ref, definitions: ref, const: ref };
			const namedSchemas = { $ref: text, $defs: text, definitions: text, const: text };

			for (const keyword of ["properties", "patternProperties", "dependencies", "dependentSchemas"]) {
				expect(dereferenceJsonSchema({ ...schema, [keyword]: namedRefs })).toEqual({
					type: "object",
					[keyword]: namedSchemas,
				});
			}
			for (const keyword of ["anyOf", "oneOf", "allOf", "prefixItems", "items"]) {
				expect(dereferenceJsonSchema({ ...schema, [keyword]: [ref, false] })).toEqual({
					type: "object",
					[keyword]: [text, false],
				});
			}
			for (const keyword of [
				"items",
				"additionalItems",
				"contains",
				"contentSchema",
				"propertyNames",
				"if",
				"then",
				"else",
				"not",
				"additionalProperties",
				"unevaluatedItems",
				"unevaluatedProperties",
			]) {
				expect(dereferenceJsonSchema({ ...schema, [keyword]: ref })).toEqual({
					type: "object",
					[keyword]: text,
				});
			}
			expect(dereferenceJsonSchema({ ...schema, dependencies: { field: ["$ref", "$defs"] } })).toEqual({
				type: "object",
				dependencies: { field: ["$ref", "$defs"] },
			});
		});
	}

	it("returns schema without $defs unchanged", () => {
		const schema = {
			type: "object",
			properties: { name: { type: "string" } },
			required: ["name"],
		};
		expect(dereferenceJsonSchema(schema)).toBe(schema);
	});

	it("inlines a simple $ref from $defs", () => {
		const schema = {
			type: "object",
			properties: {
				anchor: { $ref: "#/$defs/Anchor" },
			},
			$defs: {
				Anchor: {
					type: "object",
					properties: {
						path: { type: "string" },
						line: { type: "integer", minimum: 0 },
					},
				},
			},
		};
		const result = dereferenceJsonSchema(schema) as any;
		expect(result.$defs).toBeUndefined();
		expect(result.properties.anchor).toEqual({
			type: "object",
			properties: {
				path: { type: "string" },
				line: { type: "integer", minimum: 0 },
			},
		});
	});

	it("inlines escaped and empty definition names before stripping definitions", () => {
		for (const keyword of ["$defs", "definitions"]) {
			const schema = {
				type: "object",
				properties: {
					escaped: { $ref: `#/${keyword}/foo~1bar~0baz~01` },
					empty: { $ref: `#/${keyword}/` },
				},
				[keyword]: {
					"foo/bar~baz~1": { type: "string" },
					"": { type: "integer" },
				},
			};

			expect(dereferenceJsonSchema(schema)).toEqual({
				type: "object",
				properties: {
					escaped: { type: "string" },
					empty: { type: "integer" },
				},
			});
		}
	});

	it("inlines $ref from definitions (legacy keyword)", () => {
		const schema = {
			type: "object",
			properties: {
				item: { $ref: "#/definitions/Item" },
			},
			definitions: {
				Item: { type: "string", enum: ["a", "b"] },
			},
		};
		const result = dereferenceJsonSchema(schema) as any;
		expect(result.definitions).toBeUndefined();
		expect(result.properties.item).toEqual({ type: "string", enum: ["a", "b"] });
	});

	it("inlines nested $ref inside arrays (items, anyOf, oneOf)", () => {
		const schema = {
			type: "object",
			properties: {
				anchors: {
					type: "array",
					items: { $ref: "#/$defs/SourceAnchorInput" },
				},
				value: {
					anyOf: [{ $ref: "#/$defs/Str" }, { type: "null" }],
				},
			},
			$defs: {
				SourceAnchorInput: {
					type: "object",
					properties: {
						anchor_type: { type: "string", enum: ["file", "symbol", "pattern"] },
						path: { type: "string" },
					},
					required: ["anchor_type", "path"],
				},
				Str: { type: "string" },
			},
		};
		const result = dereferenceJsonSchema(schema) as any;
		expect(result.$defs).toBeUndefined();
		expect(result.properties.anchors.items).toEqual({
			type: "object",
			properties: {
				anchor_type: { type: "string", enum: ["file", "symbol", "pattern"] },
				path: { type: "string" },
			},
			required: ["anchor_type", "path"],
		});
		expect(result.properties.value.anyOf[0]).toEqual({ type: "string" });
		expect(result.properties.value.anyOf[1]).toEqual({ type: "null" });
	});

	it("handles $ref inside a definition pointing to another definition", () => {
		const schema = {
			type: "object",
			properties: {
				wrapper: { $ref: "#/$defs/Wrapper" },
			},
			$defs: {
				Inner: { type: "integer", minimum: 0 },
				Wrapper: {
					type: "object",
					properties: {
						value: { $ref: "#/$defs/Inner" },
					},
				},
			},
		};
		const result = dereferenceJsonSchema(schema) as any;
		expect(result.$defs).toBeUndefined();
		expect(result.properties.wrapper).toEqual({
			type: "object",
			properties: {
				value: { type: "integer", minimum: 0 },
			},
		});
	});

	it("breaks circular $ref with empty object", () => {
		const schema = {
			type: "object",
			properties: {
				node: { $ref: "#/$defs/TreeNode" },
			},
			$defs: {
				TreeNode: {
					type: "object",
					properties: {
						name: { type: "string" },
						children: {
							type: "array",
							items: { $ref: "#/$defs/TreeNode" },
						},
					},
				},
			},
		};
		const result = dereferenceJsonSchema(schema) as any;
		expect(result.$defs).toBeUndefined();
		const node = result.properties.node;
		expect(node.properties.name).toEqual({ type: "string" });
		// Circular ref breaks to {}
		expect(node.properties.children.items).toEqual({});
	});

	it("leaves external $ref untouched", () => {
		const schema = {
			type: "object",
			properties: {
				ext: { $ref: "https://example.com/schema.json#/Foo" },
			},
			$defs: {},
		};
		const result = dereferenceJsonSchema(schema) as any;
		expect(result.properties.ext).toEqual({ $ref: "https://example.com/schema.json#/Foo" });
	});

	it("preserves sibling keywords alongside $ref", () => {
		const schema = {
			type: "object",
			properties: {
				anchor_type: {
					$ref: "#/$defs/AnchorType",
					description: "Field-level description",
					default: "file",
				},
			},
			$defs: {
				AnchorType: {
					type: "string",
					enum: ["file", "symbol", "pattern"],
					description: "Type-level description",
				},
			},
		};
		const result = dereferenceJsonSchema(schema) as any;
		expect(result.$defs).toBeUndefined();
		// Sibling description overrides the definition's description
		expect(result.properties.anchor_type).toEqual({
			type: "string",
			enum: ["file", "symbol", "pattern"],
			description: "Field-level description",
			default: "file",
		});
	});

	it("handles multiple properties referencing the same $def", () => {
		const schema = {
			type: "object",
			properties: {
				a: { $ref: "#/$defs/Shared" },
				b: { $ref: "#/$defs/Shared" },
			},
			$defs: {
				Shared: { type: "string", maxLength: 100 },
			},
		};
		const result = dereferenceJsonSchema(schema) as any;
		expect(result.$defs).toBeUndefined();
		expect(result.properties.a).toEqual({ type: "string", maxLength: 100 });
		expect(result.properties.b).toEqual({ type: "string", maxLength: 100 });
	});

	for (const referenced of [false, true]) {
		it(`preserves literal JSON inside ${referenced ? "$ref siblings" : "ordinary schemas"}`, () => {
			const literal = {
				$ref: "#/$defs/Text",
				$defs: { keep: "literal" },
				definitions: { keep: "literal" },
				properties: { nested: { $ref: "#/$defs/Text" } },
			};
			const annotations = {
				const: literal,
				enum: [literal, { nested: [literal] }],
				default: literal,
				examples: [literal, { nested: [literal] }],
				"x-payload": { nested: literal },
			};
			const schema = {
				$defs: {
					Text: { type: "string", minLength: 2 },
					Obj: { type: "object" },
				},
				type: "object",
				properties: {
					value: {
						...(referenced ? { $ref: "#/$defs/Obj" } : { type: "object" }),
						...annotations,
						properties: { actual: { $ref: "#/$defs/Text" } },
					},
				},
			};
			expect(dereferenceJsonSchema(schema)).toEqual({
				type: "object",
				properties: {
					value: {
						type: "object",
						...annotations,
						properties: { actual: { type: "string", minLength: 2 } },
					},
				},
			});
			expect(JSON.stringify(schema.properties.value.const)).toBe(JSON.stringify(literal));
		});
	}

	it("preserves reserved property names while dereferencing their nested schemas", () => {
		const namedSchemas = {
			$ref: { $ref: "#/$defs/Text" },
			$defs: {
				type: "object",
				properties: { definitions: { $ref: "#/$defs/Text" } },
			},
			definitions: { $ref: "#/$defs/Text" },
			allowed: true,
			forbidden: false,
		};
		const expanded = {
			$ref: { type: "string", minLength: 2 },
			$defs: {
				type: "object",
				properties: { definitions: { type: "string", minLength: 2 } },
			},
			definitions: { type: "string", minLength: 2 },
			allowed: true,
			forbidden: false,
		};
		for (const keyword of ["properties", "patternProperties", "dependentSchemas", "dependencies"]) {
			expect(
				dereferenceJsonSchema({
					$defs: { Text: { type: "string", minLength: 2 } },
					[keyword]: namedSchemas,
				}),
			).toEqual({ [keyword]: expanded });
		}
	});

	it("preserves boolean schemas in schema-valued keywords", () => {
		const definitions = { Text: { type: "string", minLength: 2 } };
		for (const keyword of [
			"items",
			"additionalItems",
			"contains",
			"contentSchema",
			"propertyNames",
			"if",
			"then",
			"else",
			"not",
			"additionalProperties",
			"unevaluatedItems",
			"unevaluatedProperties",
		]) {
			expect(dereferenceJsonSchema({ $defs: definitions, [keyword]: false })).toEqual({ [keyword]: false });
		}
		for (const keyword of ["items", "prefixItems", "anyOf", "oneOf", "allOf"]) {
			expect(dereferenceJsonSchema({ $defs: definitions, [keyword]: [{ $ref: "#/$defs/Text" }, true] })).toEqual({
				[keyword]: [{ type: "string", minLength: 2 }, true],
			});
		}
	});
});
