import { describe, expect, it } from "bun:test";
import { fromJsonSchema, OmpErrors } from "../src";

describe("JSON Schema definition key imports", () => {
	it("imports encoded and pointer-escaped names without resolving a similarly named definition", () => {
		const imported = fromJsonSchema({
			$defs: {
				"a%2Fb /~1 空\n": { type: "string" },
				"a/b /~1 空\n": { type: "boolean" },
			},
			$ref: "#/$defs/a%252Fb%20~1~01%20%E7%A9%BA%0A",
		});
		expect(imported("valid")).toBe("valid");
		expect(imported(false)).toBeInstanceOf(OmpErrors);
	});

	it("imports an empty definition name in the legacy definitions map", () => {
		const imported = fromJsonSchema({
			definitions: { "": { type: "integer" } },
			$ref: "#/definitions/",
		});
		expect(imported(2)).toBe(2);
		expect(imported(2.5)).toBeInstanceOf(OmpErrors);
	});
});
