import { describe, expect, test } from "bun:test";
import { relayStartupCloseError } from "@oh-my-pi/pi-coding-agent/collab/host";
import { RELAY_CLOSE_REASONS } from "@oh-my-pi/pi-coding-agent/collab/relay-client";

// The 4009 duplicate-host message is the fork contract text (docs-zh-CN/requirements/fork.md
// 「Collab 长期链接与网页端命令」): with one persistent identity per config
// root, a second omp session hosting the same room must be told where the
// winner is listed. Assert the exact string so code and contract cannot drift.

describe("relay startup close error", () => {
	test("names the competing session and the list command for the 4009 close", () => {
		expect(relayStartupCloseError(RELAY_CLOSE_REASONS[4009]).message).toBe(
			"relay connection closed during startup: a host is already connected for this room" +
				" (another omp session hosts this room; /collab list shows it)",
		);
	});

	test("passes other close reasons through without the duplicate-host hint", () => {
		for (const code of [4001, 4004, 4029] as const) {
			expect(relayStartupCloseError(RELAY_CLOSE_REASONS[code]).message).toBe(
				`relay connection closed during startup: ${RELAY_CLOSE_REASONS[code]}`,
			);
		}
	});

	test("stays generic when the relay closed without a reason", () => {
		expect(relayStartupCloseError(undefined).message).toBe("relay connection closed during startup");
	});
});
