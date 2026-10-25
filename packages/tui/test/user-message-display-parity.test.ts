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
	setChatTranscriptDisplayPreferences({ compactToolActivity: false, hideToolActivity: false });
	setTranscriptActionHandler(undefined);
});

describe("ordinary user message display", () => {
	it("folds long messages only in compact mode and restores the complete message on switching modes", () => {
		const source = Array.from({ length: 24 }, (_, index) => `row-${index.toString().padStart(2, "0")}`).join("\n");
		setChatTranscriptDisplayPreferences({ compactToolActivity: false, hideToolActivity: false });
		const detailed = new UserMessageComponent(source).render(80);
		expect(detailed.length).toBeGreaterThan(10);
		const message = new UserMessageComponent(source);
		setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity: false });
		const compact = message.render(80).map(Bun.stripANSI).join("\n");
		expect(compact).toContain("row-04");
		expect(compact).not.toContain("row-05");
		expect(compact).toContain("已折叠 19 行，切换全量模式查看");
		for (const preferences of [
			{ compactToolActivity: false },
			{ compactToolActivity: true, hideToolActivity: true },
		]) {
			setChatTranscriptDisplayPreferences(preferences);
			const rows = message.render(80);
			expect(rows).toEqual(detailed);
			expect(Bun.stripANSI(rows.join("\n"))).toContain("row-23");
		}
	});

	it("uses screen lines at the current width and leaves six lines unfolded", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity: false });
		const six = new UserMessageComponent(Array.from({ length: 6 }, (_, i) => `line-${i}`).join("\n"));
		expect(Bun.stripANSI(six.render(80).join("\n"))).not.toContain("已折叠");
		const seven = new UserMessageComponent(Array.from({ length: 7 }, (_, i) => `line-${i}`).join("\n"));
		expect(Bun.stripANSI(seven.render(80).join("\n"))).toContain("已折叠 2 行");
		const wrapped = new UserMessageComponent("word ".repeat(100));
		expect(Bun.stripANSI(wrapped.render(80).join("\n"))).toContain("已折叠");
		expect(Bun.stripANSI(wrapped.render(160).join("\n"))).not.toContain("已折叠");
	});

	it("keeps native copy complete and invalidates native projection on mode and width changes", () => {
		const actions: TranscriptAction[] = [];
		setTranscriptActionHandler(action => actions.push(action));
		setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity: false });
		const source = Array.from({ length: 18 }, (_, i) => `message-${i}`).join("\n");
		const message = new UserMessageComponent(source);
		const cx: DescribeContext = {
			cols: 80,
			dark: true,
			reduceMotion: false,
			supports: () => false,
			feature: () => false,
		};
		const compact = JSON.stringify(message.describe(cx));
		expect(compact).toContain("已折叠 13 行");
		expect(compact).not.toContain("message-17");
		message.handleNativeEvent({ type: "action", key: "copy", act: "copy-message", mods: [] });
		expect(actions).toEqual([{ act: "copy", text: source }]);
		setChatTranscriptDisplayPreferences({ compactToolActivity: false });
		expect(JSON.stringify(message.describe(cx))).toContain("message-17");
		setChatTranscriptDisplayPreferences({ compactToolActivity: true });
		const wrapped = new UserMessageComponent("word ".repeat(100));
		expect(JSON.stringify(wrapped.describe(cx))).toContain("已折叠");
		expect(JSON.stringify(wrapped.describe({ ...cx, cols: 160 }))).not.toContain("已折叠");
	});

	it("keeps explicit detailed history viewers independent of the main compact preference", () => {
		setChatTranscriptDisplayPreferences({ compactToolActivity: true, hideToolActivity: false });
		const message = new UserMessageComponent("history\n".repeat(20), { compactToolActivity: false });
		expect(Bun.stripANSI(message.render(80).join("\n"))).not.toContain("已折叠");
		expect(JSON.stringify(message.describe())).not.toContain("已折叠");
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
