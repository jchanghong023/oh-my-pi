import { describe, expect, test } from "bun:test";
import { YAML } from "bun";
import { setYamlConfigValue } from "../src/yaml-config";

// Custom role IDs reach the editor as strings, but settings written by hand or
// by external tools may key them with unquoted YAML scalars (`123:`, `true:`).
// The editor must resolve the actual key nodes so updates and deletions land
// in place instead of appending duplicate string keys or missing the entry.
describe("setYamlConfigValue scalar keys", () => {
	test.each(["", "# empty\n", "{}", "startup: null\n", "startup: {}\n"])(
		"leaves missing nested reset paths byte-for-byte unchanged: %j",
		source => {
			expect(setYamlConfigValue(source, ["startup", "changelogMode"], undefined)).toBe(source);
		},
	);

	test.each(["startup: false\n", "startup: []\n"])("rejects a non-mapping reset parent: %j", source => {
		expect(() => setYamlConfigValue(source, ["startup", "changelogMode"], undefined)).toThrow(
			"Setting parent must be a mapping.",
		);
	});

	test("updates a numeric scalar key in place without duplicating it", () => {
		const source = "modelRoles:\n  default: keep/default\n  123: openai/old\n";
		const updated = setYamlConfigValue(source, ["modelRoles", "123"], "openai/new");

		expect(updated).toContain("123: openai/new");
		expect(updated).not.toContain("openai/old");
		const parsed = YAML.parse(updated) as { modelRoles: Record<string, string> };
		expect(Object.keys(parsed.modelRoles).sort()).toEqual(["123", "default"]);
		expect(parsed.modelRoles["123"]).toBe("openai/new");
	});

	test("deletes a numeric scalar key and retains its comment", () => {
		const source = "modelRoles:\n  default: keep/default\n  # custom role note\n  123: openai/old\n";
		const updated = setYamlConfigValue(source, ["modelRoles", "123"], undefined);

		expect(updated).not.toContain("openai/old");
		expect(updated).toContain("custom role note");
		const parsed = YAML.parse(updated) as { modelRoles: Record<string, string> };
		expect(Object.keys(parsed.modelRoles)).toEqual(["default"]);
	});

	test("updates a boolean scalar key in place", () => {
		const source = "modelRoles:\n  true: openai/old\n";
		const updated = setYamlConfigValue(source, ["modelRoles", "true"], "openai/new");

		expect(updated).not.toContain("openai/old");
		const parsed = YAML.parse(updated) as { modelRoles: Record<string, string> };
		expect(Object.keys(parsed.modelRoles)).toEqual(["true"]);
		expect(parsed.modelRoles["true"]).toBe("openai/new");
	});

	test("still updates string keys while preserving comments and siblings", () => {
		const source = "modelRoles:\n  # keep this note\n  smol: keep/old\n  wide: keep/wide\n";
		const updated = setYamlConfigValue(source, ["modelRoles", "smol"], "keep/new");

		expect(updated).toContain("# keep this note");
		expect(updated).toContain("smol: keep/new");
		expect(updated).toContain("wide: keep/wide");
	});

	test.each(["modelRoles:\n", "modelRoles: null\n"])("writes a nested role into unset config %j", source => {
		const updated = setYamlConfigValue(source, ["modelRoles", "smol"], "openai/new");
		expect(YAML.parse(updated)).toEqual({ modelRoles: { smol: "openai/new" } });
		const roundTripped = setYamlConfigValue(updated, ["modelRoles", "smol"], "openai/next");
		expect(YAML.parse(roundTripped)).toEqual({ modelRoles: { smol: "openai/next" } });
	});

	test("preserves comments and aliases of a null parent while replacing it with a mapping", () => {
		const source = "# role note\nmodelRoles: &roles null # unset note\nprevious: *roles\n";
		const updated = setYamlConfigValue(source, ["modelRoles", "smol"], "openai/new");
		expect(updated).toContain("# role note");
		expect(updated).toContain("# unset note");
		expect(YAML.parse(updated)).toEqual({ modelRoles: { smol: "openai/new" }, previous: null });
	});
});
