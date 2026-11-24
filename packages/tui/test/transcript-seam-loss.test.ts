import { expect, it } from "bun:test";
import { jsx, signal } from "@oh-my-pi/pi-tui";
import { settle } from "@oh-my-pi/pi-tui/surface";
import { mountVt } from "./helpers/vt-surface";

const reply = Array.from({ length: 150 }, (_, i) => `ANSWER_${String(i).padStart(3, "0")} alpha bravo`);
const shell = Array.from({ length: 12 }, (_, i) => `SHELL_${i}`);
const chrome = (count: number) => Array.from({ length: count }, (_, i) => `HUD_${i}`);

it.each([24, 45])("preserves every streamed paragraph while tall turn chrome stays up (%i rows)", async rows => {
	const answer = signal("");
	const hud = signal<string[]>([]);
	const { vt, surface, backend, dispose } = mountVt(
		() => ({
			main: jsx("md", { key: "reply", text: answer, stream: true }),
			dock: jsx("rows", { lines: () => [...hud(), "EDITOR"] }),
		}),
		{ columns: 120, rows },
	);
	try {
		backend.renderNow();
		hud.set(chrome(7));
		for (let i = 1; i <= reply.length; i++) {
			answer.set(reply.slice(0, i).join("\n\n"));
			backend.renderNow();
		}
		settle(surface.main()[0]!);
		backend.renderNow();
		expect(vt.transcript().filter(row => row.startsWith("ANSWER_"))).toEqual(reply);
		expect(vt.screen().filter(row => row.startsWith("HUD_"))).toEqual(chrome(7));
		expect(vt.screen().at(-1)).toBe("EDITOR");
	} finally {
		await dispose();
	}
});

it.each(["initial mount", "runtime remount", "append resize"] as const)(
	"keeps restored transcript and shell history through chrome changes after %s",
	async event => {
		const rows = 30;
		const hud = signal<string[]>([]);
		const dockGeneration = signal(0);
		const { vt, surface, backend, driver, dispose } = mountVt(
			() => ({
				main: jsx("rows", { lines: reply }),
				dock: () => jsx("rows", { lines: () => [...hud(), "EDITOR"] }, `dock-${dockGeneration()}`),
			}),
			{ columns: 120, rows, shell, resizeScrollback: "append" },
		);
		try {
			settle(surface.main()[0]!);
			backend.renderNow();
			const history = () => vt.transcript().filter(row => /^(SHELL_|ANSWER_)/.test(row));
			expect(history()).toEqual([...shell, ...reply]);
			let retained: readonly string[] = [];
			if (event === "runtime remount") {
				const oldDock = surface.dock()[0];
				dockGeneration.set(1);
				expect(surface.dock()[0]).not.toBe(oldDock);
				backend.renderNow();
			} else if (event === "append resize") {
				// The old viewport had room for `rows - 1` live answer rows above EDITOR.
				// Only the retired prefix survives below the shell, followed by one new-width copy.
				retained = reply.slice(0, reply.length - (rows - 1));
				driver.resize(96, rows);
				await vt.settle();
				backend.renderNow();
			}
			for (const height of [0, 7, 4, 0]) {
				hud.set(chrome(height));
				backend.renderNow();
				expect(history()).toEqual([...shell, ...retained, ...reply]);
				expect(vt.screen().filter(row => row.startsWith("HUD_"))).toEqual(chrome(height));
				expect(vt.screen().at(-1)).toBe("EDITOR");
			}
		} finally {
			await dispose();
		}
	},
);
