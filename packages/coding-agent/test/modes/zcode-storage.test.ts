import { describe, expect, test } from "bun:test";
import { LegacyProtocol } from "../../src/modes/zcode/schema";
import { ZCodeStorageStartup } from "../../src/modes/zcode/storage";

describe("ZCode storage startup faults", () => {
	for (const [cause, errorCode] of [
		[{ code: "ENOSPC" }, "storage_full"],
		[{ code: "EACCES" }, "permission_denied"],
		[{ code: "ENOMEM" }, "out_of_memory"],
		[{ code: "EIO" }, "io_error"],
		[{ kind: "transport_closed" }, "transport_closed"],
		[{ kind: "startup_status_timeout" }, "startup_status_timeout"],
		[{ code: "UNKNOWN" }, "open_failed"],
	] as const) {
		test(`reports ${errorCode} without exposing the storage failure details`, async () => {
			const frames: unknown[] = [];
			const startup = new ZCodeStorageStartup(async frame => {
				frames.push(frame);
			});
			await startup.report("checking");
			await startup.report("failed", Object.assign(new Error("private storage path and credentials"), cause));
			// A failure observed by both open() and its owner produces only one terminal status.
			await startup.report("failed", new Error("secondary cleanup failure"));
			const states = frames.map(
				frame => LegacyProtocol.zcodeStoragePreparationFrameSchema.options[2].parse(frame).params,
			);
			expect(states).toHaveLength(2);
			expect(states[1]).toMatchObject({
				phase: "failed",
				errorCode,
				attemptId: states[0]!.attemptId,
				databaseId: states[0]!.databaseId,
			});
			expect(states[1]!.sequence).toBeGreaterThan(states[0]!.sequence);
			expect(JSON.stringify(frames)).not.toContain("private storage path and credentials");
		});
	}
});
