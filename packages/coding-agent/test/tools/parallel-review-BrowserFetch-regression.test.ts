import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { renderHtmlToText } from "@oh-my-pi/pi-coding-agent/tools/fetch";
import * as utils from "@oh-my-pi/pi-utils";

const { ptree } = utils;

afterEach(() => {
	vi.restoreAllMocks();
});

describe("reader-mode cancellation", () => {
	it("rejects user cancellation even when an exited reader returns substantial partial stdout", async () => {
		const controller = new AbortController();
		const reason = new DOMException("Reader cancelled", "AbortError");
		vi.spyOn(utils, "$which").mockReturnValue("lynx");
		const exec = vi.spyOn(ptree, "exec").mockImplementation(async () => {
			// A wrapper may exit successfully while its orphan still owns stdout.
			// Cancelling the tracked read returns the captured prefix and exit 0.
			controller.abort(reason);
			return {
				ok: true,
				stdout: "# Article\n\n" + "Substantive reader content before cancellation. ".repeat(8),
				stderr: "",
				exitCode: 0,
				exitError: new ptree.AbortError(reason, ""),
			};
		});

		await expect(
			renderHtmlToText(
				"https://example.com/article",
				"<html><body>short</body></html>",
				30,
				Settings.isolated({ "providers.fetch": "lynx" }),
				controller.signal,
				null,
			),
		).rejects.toBe(reason);
		expect(exec).toHaveBeenCalledTimes(1);
	});
});
