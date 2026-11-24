import { expect, it } from "bun:test";
import { jsx, signal } from "@oh-my-pi/pi-tui";
import { settle } from "@oh-my-pi/pi-tui/surface";
import { DisplayContract, type DisplayFrame } from "./helpers/display-contract";
import { mountVt } from "./helpers/vt-surface";

const prose = Array.from({ length: 30 }, (_, i) => `PROSE_${String(i).padStart(2, "0")}`);
const cells = Array.from({ length: 14 }, (_, i) => `TABLE_${String(i).padStart(2, "0")}`);
const table = ["| Item | Result |", "| --- | --- |", ...cells.map(cell => `| ${cell} | kept |`)].join("\n");
const draft = "first draft line\nsecond draft line\nDRAFT_END";
const chrome = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => `${prefix}_${i}`);

it.each(["preserve", "append"] as const)(
	"keeps draft, cursor, and ordered transcript through chrome and resize (%s)",
	async resizeScrollback => {
		const reply = signal("");
		const widget = signal<string[]>([]);
		const status = signal<string[]>([]);
		const { vt, surface, backend, driver, dispose } = mountVt(
			() => ({
				main: jsx("md", { key: "reply", text: reply, stream: true }),
				dock: [
					jsx("editor", { text: draft, cursor: draft.length }),
					jsx("rows", { lines: widget }),
					jsx("rows", { lines: status }),
				],
			}),
			{ columns: 54, rows: 18, resizeScrollback },
		);
		const contract = new DisplayContract(90210);
		const check = ({ viewport, cursor }: DisplayFrame) => {
			expect(viewport[cursor.row]).toContain("DRAFT_END");
			expect(cursor.col).toBe(9);
			expect(cursor.visible).toBe(true);
		};
		let event = "initial draft";
		try {
			surface.focus(surface.dock()[0]!);
			backend.renderNow();
			contract.observe(event, vt, check);
			const unwatch = contract.watch(driver, () => event, check);
			for (let count = 1; count <= prose.length; count++) {
				event = `stream paragraph ${count}`;
				widget.set(chrome("WIDGET", count % 5));
				status.set(chrome("STATUS", count % 3));
				reply.set(prose.slice(0, count).join("\n\n"));
				backend.renderNow();
				contract.assertHealthy();
			}
			event = "prose before table with tall chrome";
			reply.set(`${reply()}\n\n${table}\n\nANSWER_END`);
			widget.set(chrome("WIDGET", 3));
			status.set(chrome("STATUS", 3));
			backend.renderNow();
			settle(surface.main()[0]!);
			backend.renderNow();
			const markers = (lines: readonly string[]): string[] =>
				lines.join("\n").match(/PROSE_\d+|TABLE_\d+|ANSWER_END/g) ?? [];
			const reachable = () => markers(vt.transcript());
			const prefix = [...prose, ...cells];
			const expected = [...prefix, "ANSWER_END"];
			expect(reachable()).toEqual(expected);
			contract.assertHealthy();
			unwatch();

			const retained: string[] = [];
			const append = resizeScrollback === "append";
			for (const [columns, rows, height, nativePushesTail] of [
				[32, 12, 3, false],
				[24, 8, 1, true],
				[54, 18, 0, false],
			] as const) {
				driver.resize(columns, rows);
				// Kitty resizes before delivering the event. The 12→8 shrink pushes the old
				// live tail into native history; the new viewport still needs its live answer.
				if (append) retained.push(...(nativePushesTail ? expected : prefix));
				else if (nativePushesTail) retained.push("ANSWER_END");
				expect(markers(vt.scrollback())).toEqual(append ? retained : [...prefix, ...retained]);
				widget.set(chrome("WIDGET", height));
				status.set(chrome("STATUS", height));
				await vt.settle();
				backend.renderNow();
				const frame = contract.observe(`settled resize ${columns}x${rows}`, vt, check);
				expect(frame.viewport).toContain("ANSWER_END");
				expect(frame.viewport.filter(row => row.startsWith("WIDGET_"))).toEqual(chrome("WIDGET", height));
				expect(frame.viewport.filter(row => row.startsWith("STATUS_"))).toEqual(chrome("STATUS", height));
				expect(reachable()).toEqual(append ? [...retained, ...expected] : [...expected, ...retained]);
			}
			const before = vt.screen();
			backend.renderNow();
			expect(vt.screen()).toEqual(before);
			expect(vt.screen()).toContain("ANSWER_END");
			expect(surface.dock()[0]!.props()).toMatchObject({ text: draft, cursor: draft.length });
		} finally {
			await dispose();
		}
	},
);
