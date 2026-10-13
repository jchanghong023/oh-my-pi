import { describe, expect, test } from "bun:test";
import { YAML } from "bun";
import { setYamlConfigValue } from "../src/yaml-config";

// Custom role IDs reach the editor as strings, but settings written by hand or
// by external tools may key them with unquoted YAML scalars (`123:`, `true:`).
// The editor must resolve the actual key nodes so updates and deletions land
// in place instead of appending duplicate string keys or missing the entry.
describe("setYamlConfigValue scalar keys", () => {
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
});
