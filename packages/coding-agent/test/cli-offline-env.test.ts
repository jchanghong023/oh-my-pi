import { afterEach, describe, expect, it } from "bun:test";
import { offlineFromEnv, parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { extractProfileFlags } from "@oh-my-pi/pi-coding-agent/cli/profile-bootstrap";

const originalOfflineEnv = process.env.OMP_OFFLINE;

afterEach(() => {
	if (originalOfflineEnv === undefined) delete process.env.OMP_OFFLINE;
	else process.env.OMP_OFFLINE = originalOfflineEnv;
});

describe("parseArgs — OMP_OFFLINE environment variable", () => {
	it("activates offline mode for every truthy spelling", () => {
		for (const value of ["1", "true", "TRUE", "Yes", "on"]) {
			process.env.OMP_OFFLINE = value;
			const parsed = parseArgs([]);
			expect(parsed.intranetOffline, value).toBe(true);
			expect(parsed.offline, value).toBeUndefined();
		}
	});

	it("keeps the launch online for unset, empty, or falsy spellings", () => {
		for (const value of [undefined, "", "0", "false", "off", "garbage"]) {
			if (value === undefined) delete process.env.OMP_OFFLINE;
			else process.env.OMP_OFFLINE = value;
			expect(parseArgs([]).intranetOffline, String(value)).toBeUndefined();
		}
	});

	it("exposes the helper behind the parse result", () => {
		process.env.OMP_OFFLINE = "1";
		expect(offlineFromEnv()).toBe(true);
		delete process.env.OMP_OFFLINE;
		expect(offlineFromEnv()).toBe(false);
	});

	it("allows the intranet mode and upstream --offline together", () => {
		process.env.OMP_OFFLINE = "1";
		const result = parseArgs(["--offline", "--model", "opus", "hello"]);
		expect(result.offline).toBe(true);
		expect(result.intranetOffline).toBe(true);
		expect(result.model).toBe("opus");
		expect(result.messages).toEqual(["hello"]);
	});

	it("accepts --offline without enabling the intranet mode", () => {
		delete process.env.OMP_OFFLINE;
		const result = parseArgs(["--offline"]);
		expect(result.offline).toBe(true);
		expect(result.intranetOffline).toBeUndefined();
		expect(result.unrecognizedFlags).toEqual([]);
	});

	it("treats --offline after -- as a positional, not a flag", () => {
		delete process.env.OMP_OFFLINE;
		const result = parseArgs(["--", "--offline"]);
		expect(result.offline).toBeUndefined();
		expect(result.messages).toEqual(["--offline"]);
	});

	it("does not disturb profile bootstrap extraction", () => {
		delete process.env.OMP_OFFLINE;
		const extracted = extractProfileFlags(["--profile", "work", "hello"]);
		expect(extracted.profile).toBe("work");
		const parsed = parseArgs(extracted.argv);
		expect(parsed.intranetOffline).toBeUndefined();
		expect(parsed.messages).toEqual(["hello"]);
	});
});
