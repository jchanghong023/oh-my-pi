import { expect, it } from "bun:test";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { readUrl } from "@oh-my-pi/pi-coding-agent/web/read";
import { mockFetch } from "../helpers/fetch-mock";

it("rejects a cancelled URL read even when the transport returns a usable page", async () => {
	const controller = new AbortController();
	const fetch = mockFetch(() => {
		controller.abort();
		const text = "Substantive reader content received as the caller cancelled. ".repeat(8);
		return new Response(`<html><body><article><p>${text}</p></article></body></html>`, {
			headers: { "content-type": "text/html" },
		});
	});

	await expect(readUrl("https://example.com/article", { fetch, signal: controller.signal })).rejects.toThrow(
		ToolAbortError,
	);
});
