import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { offlineFromEnv } from "@oh-my-pi/pi-utils/env";

describe("OMP_OFFLINE", () => {
	let originalOfflineEnv: string | undefined;
	beforeEach(() => {
		originalOfflineEnv = process.env.OMP_OFFLINE;
	});

	afterEach(() => {
		if (originalOfflineEnv === undefined) delete process.env.OMP_OFFLINE;
		else process.env.OMP_OFFLINE = originalOfflineEnv;
	});

	it("recognizes the supported truthy spellings with case and whitespace normalization", () => {
		for (const value of ["1", " TrUe ", "YeS", "on"]) {
			process.env.OMP_OFFLINE = value;
			expect(offlineFromEnv(), value).toBe(true);
		}
	});

	it("leaves offline mode disabled for unset, empty, or falsy spellings", () => {
		for (const value of [undefined, "", "0", "false", "off", "garbage"]) {
			if (value === undefined) delete process.env.OMP_OFFLINE;
			else process.env.OMP_OFFLINE = value;
			expect(offlineFromEnv(), String(value)).toBe(false);
		}
	});

	it("keeps the intranet mode independent of upstream --offline", () => {
		process.env.OMP_OFFLINE = "1";
		const envOnly = parseArgs([]);
		expect(envOnly.intranetOffline).toBe(true);
		expect(envOnly.offline).toBeUndefined();

		const result = parseArgs(["--offline", "--model", "opus", "hello"]);
		expect(result.offline).toBe(true);
		expect(result.intranetOffline).toBe(true);
	});

	it("accepts --offline without enabling the intranet mode", () => {
		delete process.env.OMP_OFFLINE;
		const result = parseArgs(["--offline"]);
		expect(result.offline).toBe(true);
		expect(result.intranetOffline).toBeUndefined();
		expect(result.unrecognizedFlags).toEqual([]);
	});
});

it("treats --offline after -- as a positional, not a flag", () => {
	const result = parseArgs(["--", "--offline"]);
	expect(result.offline).toBeUndefined();
	expect(result.messages).toEqual(["--offline"]);
});
