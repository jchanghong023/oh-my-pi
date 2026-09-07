import { describe, expect, it } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { extractProfileFlags } from "@oh-my-pi/pi-coding-agent/cli/profile-bootstrap";

describe("parseArgs — --offline flag", () => {
	it("parses --offline as a boolean flag", () => {
		const result = parseArgs(["--offline"]);
		expect(result.offline).toBe(true);
	});

	it("defaults offline to undefined when the flag is not provided", () => {
		const result = parseArgs([]);
		expect(result.offline).toBeUndefined();
	});

	it("does not consume a value after --offline", () => {
		const result = parseArgs(["--offline", "--model", "opus", "hello"]);
		expect(result.offline).toBe(true);
		expect(result.model).toBe("opus");
		expect(result.messages).toEqual(["hello"]);
	});

	it("parses --offline in any position", () => {
		expect(parseArgs(["--offline", "prompt"]).offline).toBe(true);
		expect(parseArgs(["prompt", "--offline"]).offline).toBe(true);
	});

	it("treats --offline after -- as a positional, not a flag", () => {
		expect(parseArgs(["--", "--offline"]).offline).toBeUndefined();
		expect(parseArgs(["--", "--offline"]).messages).toEqual(["--offline"]);
	});

	it("keeps --offline out of unrecognizedFlags", () => {
		const result = parseArgs(["--offline", "hi"]);
		expect(result.unrecognizedFlags).toEqual([]);
	});

	it("is a known valueless flag for profile bootstrap", () => {
		const extracted = extractProfileFlags(["--offline", "--profile", "work", "hello"]);
		expect(extracted.profile).toBe("work");
		const parsed = parseArgs(extracted.argv);
		expect(parsed.offline).toBe(true);
		expect(parsed.messages).toEqual(["hello"]);
	});
});
