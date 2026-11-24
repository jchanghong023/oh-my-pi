import { describe, expect, it } from "bun:test";
import { jsx, signal } from "@oh-my-pi/pi-tui";
import { Vt } from "./driver-output/vt";
import { DisplayContract } from "./helpers/display-contract";
import { mountVt } from "./helpers/vt-surface";

function hasDraft(viewport: readonly string[]): boolean {
	return viewport.some(row => row.includes("> draft"));
}

describe("display contract", () => {
	it("rejects an actually corrupted screen with seed, event, cursor and numbered before/current rows", () => {
		const terminal = new Vt({ columns: 20, rows: 4 });
		const contract = new DisplayContract(721);
		terminal.term.write("\x1b[HReady\r\n> draft");
		contract.observe("before edit", terminal);
		terminal.term.write("\x1b[2J\x1b[Hcorrupted");
		let failure: unknown;
		try {
			contract.observe("after edit", terminal, frame => {
				if (!hasDraft(frame.viewport)) throw new Error("draft missing");
			});
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(Error);
		const message = (failure as Error).message;
		expect(message).toContain("draft missing");
		expect(message).toContain("seed=721");
		expect(message).toContain('prior 1: event="before edit"');
		expect(message).toContain('current: event="after edit"');
		expect(message).toContain('001: "> draft');
		expect(message).toContain('000: "corrupted');
		expect(message).toContain("cursor=");
		expect(() => contract.assertHealthy()).toThrow("draft missing");
	});

	it("retains a transient blank-frame failure after the reactive terminal backend repaints", async () => {
		const rows = signal(["Ready", "> draft"]);
		const { vt, driver, backend, dispose } = mountVt(() => ({ dock: jsx("rows", { lines: rows }) }), {
			columns: 20,
			rows: 4,
		});
		const contract = new DisplayContract(90210);
		try {
			backend.renderNow();
			contract.observe("before transition", vt);
			let event = "blank transition";
			let frames = 0;
			const unsubscribe = contract.watch(
				driver,
				() => event,
				frame => {
					frames++;
					if (!hasDraft(frame.viewport)) throw new Error("draft disappeared");
				},
			);
			rows.set(["", ""]);
			backend.renderNow();
			event = "restored transition";
			rows.set(["Ready", "> draft"]);
			backend.renderNow();
			expect(frames).toBe(2);
			expect(hasDraft(vt.screen())).toBe(true);
			let failure: unknown;
			try {
				contract.assertHealthy();
			} catch (error) {
				failure = error;
			}
			expect(failure).toBeInstanceOf(Error);
			expect((failure as Error).message).toContain("draft disappeared");
			expect((failure as Error).message).toContain("seed=90210");
			expect((failure as Error).message).toContain('current: event="blank transition"');
			expect((failure as Error).message).toContain('prior 1: event="before transition"');
			unsubscribe();
			rows.set(["changed after unsubscribe"]);
			backend.renderNow();
			expect(frames).toBe(2);
		} finally {
			await dispose();
		}
	});

	it("retains a cursor-specific failure after the cursor is repaired", () => {
		const terminal = new Vt({ columns: 12, rows: 3 });
		const contract = new DisplayContract(3);
		terminal.term.write("\x1b[?25h猫x");
		const before = contract.observe("initial cursor", terminal);
		expect(before.viewport[0]).toBe("猫x");
		expect(before.cursor).toEqual({ row: 0, col: 3, visible: true });
		terminal.term.write("\x1b[?25l\x1b[3;8H");
		expect(() =>
			contract.observe("cursor moved", terminal, frame => {
				if (frame.cursor.row !== 0 || frame.cursor.col !== 3) throw new Error("cursor left draft");
			}),
		).toThrow("cursor left draft");
		terminal.term.write("\x1b[?25h\x1b[1;4H");
		expect(contract.observe("cursor repaired", terminal).cursor.visible).toBe(true);
		expect(() => contract.assertHealthy()).toThrow('current: event="cursor moved"');
		expect(() => contract.assertHealthy()).toThrow("visible=false");
	});

	it("bounds evidence while retaining the most recent prior and current frames", () => {
		const terminal = new Vt({ columns: 12, rows: 3 });
		const contract = new DisplayContract(4);
		for (let i = 0; i < 8; i++) {
			terminal.term.write(`\x1b[H${i}`);
			contract.observe(`event ${i}`, terminal);
		}
		const evidence = contract.evidence();
		expect(evidence).not.toContain('event="event 0"');
		expect(evidence).toContain('event="event 6"');
		expect(evidence).toContain('current: event="event 7"');
	});
});
