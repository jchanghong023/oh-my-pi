import { expect, it } from "bun:test";
import { jsx, signal } from "@oh-my-pi/pi-tui";
import { settle } from "@oh-my-pi/pi-tui/surface";
import { mountVt } from "./helpers/vt-surface";

it("retires an oversized startup changelog when its intro settles, without input", async () => {
	const entries = Array.from({ length: 60 }, (_, i) => `Changelog entry ${i}`);
	const { vt, surface, backend, dispose } = mountVt(
		() => ({
			main: jsx("rows", { key: "changelog", lines: entries }),
			dock: jsx("text", { children: "EDITOR" }),
		}),
		{ columns: 100, rows: 30 },
	);
	try {
		backend.renderNow();
		expect(vt.scrollback()).toEqual([]);
		settle(surface.main()[0]!);
		backend.renderNow();
		expect(vt.scrollback().some(row => row.startsWith("Changelog entry "))).toBe(true);
		expect(vt.transcript().filter(row => row.startsWith("Changelog entry "))).toEqual(entries);
		expect(vt.screen().at(-1)).toBe("EDITOR");
	} finally {
		await dispose();
	}
});

it("retires the welcome before growing chrome displaces a live reply", async () => {
	const hud = signal<string[]>([]);
	const welcome = Array.from({ length: 5 }, (_, i) => `WELCOME_${i}`);
	const { vt, surface, backend, dispose } = mountVt(
		() => ({
			main: [
				jsx("rows", { key: "welcome", lines: welcome }),
				jsx("text", { key: "reply", children: "ACTIVE_CONTENT" }),
			],
			dock: jsx("rows", { lines: () => [...hud(), "EDITOR"] }),
		}),
		{ columns: 100, rows: 28 },
	);
	try {
		settle(surface.main()[0]!);
		backend.renderNow();
		expect(vt.screen()).toContain("WELCOME_0");
		hud.set(Array.from({ length: 24 }, (_, i) => `HUD_${i}`));
		backend.renderNow();
		expect(vt.screen()).toContain("ACTIVE_CONTENT");
		expect(vt.screen().at(-1)).toBe("EDITOR");
		expect(vt.transcript().filter(row => row.startsWith("WELCOME_"))).toEqual(welcome);
	} finally {
		await dispose();
	}
});
