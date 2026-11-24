import { describe, expect, it } from "bun:test";
import { jsx } from "@oh-my-pi/pi-tui";
import "../src/ui/styles/messages";
import { printRows } from "../src/ui/print-rows";
import { AsyncResult } from "../src/ui/transcript/messages/async-cards";
import type { FrameRenderer } from "../src/ui/transcript/messages/frame";

const BUILT_IN = "Background job completed";
const DIAGNOSTIC = "fixture schema validation failed";

function renderCard(renderer: FrameRenderer, visible = true): string {
	const message = {
		role: "custom",
		customType: "async-result",
		content: "<system-notice>Background job bg_1 has completed.</system-notice>",
		display: true,
		timestamp: 0,
		details: {
			jobId: "bg_1",
			type: "bash",
			label: "npm test",
			durationMs: 1234,
			schema: { status: "invalid", error: DIAGNOSTIC },
		},
	} as Parameters<typeof AsyncResult>[0]["message"];
	return Bun.stripANSI(printRows(() => AsyncResult({ message, expanded: false, visible, renderer }), 120).join("\n"));
}

describe("async-result message renderer (#14131)", () => {
	it("keeps the registered card when transcript tool activity is hidden", () => {
		const rendered = renderCard(() => jsx("text", { spans: [{ t: "EXTENSION CARD" }] }), false);
		expect(rendered).toContain("EXTENSION CARD");
		expect(rendered).not.toContain(BUILT_IN);
		expect(rendered).not.toContain(DIAGNOSTIC);
	});

	it("keeps the built-in card when the renderer throws", () => {
		const rendered = renderCard(() => {
			throw new Error("boom");
		});
		expect(rendered).toContain(BUILT_IN);
		expect(rendered).toContain(DIAGNOSTIC);
		expect(rendered).not.toContain("<system-notice>");
	});
});
