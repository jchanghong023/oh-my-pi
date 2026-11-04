import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { compileWorkflow } from "../../src/modes/zcode/workflows/compile";

const model = (provider: string, id: string) =>
	buildModel({
		provider,
		id,
		name: `${provider}/${id}`,
		api: "openai-completions",
		baseUrl: "https://example.invalid/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	});

const script = (reference: string) => `agent("reviewer", { model: ${JSON.stringify(reference)} }); return 1;`;

describe("workflow model bindings use the native catalog", () => {
	// A provider-qualified reference must win over a conflicting bare ID, ignoring case.
	test("resolves qualified identities before bare IDs and preserves the native model object", () => {
		const exact = model("provider-a", "shared");
		const other = model("provider-b", "provider-a/shared");
		const result = compileWorkflow(script("PROVIDER-A/SHARED"), [other, exact]);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.message);
		expect([...result.modelBindings.keys()]).toEqual(["PROVIDER-A/SHARED"]);
		expect(result.modelBindings.get("PROVIDER-A/SHARED")).toBe(exact);
	});

	// Unqualified IDs are valid only when exactly one native entry matches.
	test("resolves a unique bare ID case-insensitively", () => {
		const selected = model("provider-a", "Selected");
		const result = compileWorkflow(script("sElEcTeD"), [model("provider-b", "other"), selected]);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.message);
		expect(result.modelBindings.get("sElEcTeD")).toBe(selected);
	});

	// Both no-match and ambiguous references must fail compilation, not fall back to another model.
	test.each([
		{ reference: "missing", catalog: [model("a", "shared")], reason: "no matching model" },
		{ reference: "SHARED", catalog: [model("a", "shared"), model("b", "Shared")], reason: "ambiguous" },
		{
			reference: "a/shared",
			catalog: [model("a", "shared"), model("A", "SHARED")],
			reason: "ambiguous",
		},
	])("rejects $reference with $reason diagnostics", ({ reference, catalog, reason }) => {
		const result = compileWorkflow(script(reference), catalog);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("Expected model resolution rejection");
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({ code: 9011, line: 1, message: expect.stringContaining(reason) }),
		);
		expect(result.message).toContain(reference);
	});
});
