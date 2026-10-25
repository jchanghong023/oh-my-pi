import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import { setChatTranscriptDisplayPreferences } from "@oh-my-pi/pi-tui/chat/display-preferences";
import { setTranscriptActionHandler } from "@oh-my-pi/pi-tui/chat/transcript-actions";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

beforeAll(async () => {
	await initTheme(false);
});
afterEach(() => {
	setChatTranscriptDisplayPreferences({ compactToolActivity: false, hideToolActivity: false });
	setTranscriptActionHandler(undefined);
});

describe("ordinary user message display", () => {
	it("keeps the complete dialogue in compact, clean and detailed modes", () => {
		const source = Array.from({ length: 24 }, (_, index) => `row-${index.toString().padStart(2, "0")}`).join("\n");
		setChatTranscriptDisplayPreferences({ compactToolActivity: false, hideToolActivity: false });
		const detailed = new UserMessageComponent(source).render(80);
		expect(detailed.length).toBeGreaterThan(10);
		for (const preferences of [
			{ compactToolActivity: true, hideToolActivity: false },
			{ compactToolActivity: true, hideToolActivity: true },
		]) {
			setChatTranscriptDisplayPreferences(preferences);
			const rows = new UserMessageComponent(source).render(80);
			expect(rows).toEqual(detailed);
			expect(Bun.stripANSI(rows.join("\n"))).toContain("row-23");
		}
	});

	it("keeps the upstream native message toolbar", () => {
		setTranscriptActionHandler(() => {});
		setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity: false });
		const message = new UserMessageComponent("line\n".repeat(24));
		const toolbar = message.describe().c?.find(child => "k" in child && child.p?.role === "omp.user.tools");
		expect(
			toolbar && "k" in toolbar ? toolbar.c?.map(child => ("key" in child ? child.key : undefined)) : [],
		).toEqual(["copy", "rewind"]);
	});
});
