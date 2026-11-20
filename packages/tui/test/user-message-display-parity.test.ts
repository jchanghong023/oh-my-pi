import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import { setChatTranscriptDisplayPreferences } from "@oh-my-pi/pi-tui/chat/display-preferences";
import { type TranscriptAction, setTranscriptActionHandler } from "@oh-my-pi/pi-tui/chat/transcript-actions";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { DescribeContext } from "@oh-my-pi/pi-tui/native/node";

beforeAll(async () => {
	await initTheme(false);
});
afterEach(() => {
	setChatTranscriptDisplayPreferences({ hideToolActivity: false });
	setTranscriptActionHandler(undefined);
});

describe("ordinary user message display", () => {
	it("shows the complete long message and preserves native copy with tool activity visible or hidden", () => {
		const source = Array.from({ length: 24 }, (_, index) => `row-${index.toString().padStart(2, "0")}`).join("\n");
		const actions: TranscriptAction[] = [];
		setTranscriptActionHandler(action => actions.push(action));
		const message = new UserMessageComponent(source);
		const cx: DescribeContext = {
			cols: 80,
			dark: true,
			reduceMotion: false,
			supports: () => false,
			feature: () => false,
		};
		let visible: readonly string[] | undefined;
		for (const hideToolActivity of [false, true]) {
			setChatTranscriptDisplayPreferences({ hideToolActivity });
			const rows = message.render(80);
			visible ??= rows;
			expect(rows).toEqual(visible);
			expect(Bun.stripANSI(rows.join("\n"))).toContain("row-23");
			expect(JSON.stringify(message.describe(cx))).toContain("row-23");
			message.handleNativeEvent({ type: "action", key: "copy", act: "copy-message", mods: [] });
		}
		expect(actions).toEqual([
			{ act: "copy", text: source },
			{ act: "copy", text: source },
		]);
	});

	it("keeps the upstream native message toolbar", () => {
		setTranscriptActionHandler(() => {});
		setChatTranscriptDisplayPreferences({ hideToolActivity: true });
		const message = new UserMessageComponent("line\n".repeat(24));
		const toolbar = message.describe().c?.find(child => "k" in child && child.p?.role === "omp.user.tools");
		expect(
			toolbar && "k" in toolbar ? toolbar.c?.map(child => ("key" in child ? child.key : undefined)) : [],
		).toEqual(["copy", "rewind"]);
	});
});
