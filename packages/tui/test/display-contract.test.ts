import { describe, expect, it } from "bun:test";
import { type Component, TUI } from "@oh-my-pi/pi-tui";
import { DisplayContract } from "./helpers/display-contract";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

class EditableScreen implements Component {
	rows = ["Ready", "> draft"];

	invalidate(): void {}

	render(): readonly string[] {
		return this.rows;
	}
}

function hasDraft(viewport: readonly string[]): boolean {
	return viewport.some(row => row.includes("> draft"));
}

describe("display contract", () => {
	it("rejects an actually corrupted screen with seed, event, cursor and numbered before/current rows", () => {
		const terminal = new VirtualTerminal(20, 4);
		const contract = new DisplayContract(721);
		terminal.write("\x1b[HReady\r\n> draft");
		contract.observe("before edit", terminal);
		terminal.write("\x1b[2J\x1b[Hcorrupted");
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

	it("retains a transient blank-frame failure after a real TUI repaints a good frame", () => {
		const terminal = new VirtualTerminal(20, 4);
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		const screen = new EditableScreen();
		const contract = new DisplayContract(90210);
		tui.addChild(screen);
		try {
			tui.start();
			tui.renderNow();
			contract.observe("before transition", terminal);
			let event = "blank transition";
			let frames = 0;
			const unsubscribe = contract.watch(
				tui,
				terminal,
				() => event,
				frame => {
					frames++;
					if (!hasDraft(frame.viewport)) throw new Error("draft disappeared");
				},
			);
			screen.rows = ["", ""];
			tui.renderNow();
			event = "restored transition";
			screen.rows = ["Ready", "> draft"];
			tui.renderNow();
			expect(frames).toBe(2);
			expect(hasDraft(terminal.getViewport())).toBe(true);
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
			screen.rows = ["changed after unsubscribe"];
			tui.renderNow();
			expect(frames).toBe(2);
		} finally {
			tui.stop();
		}
	});

	it("retains a cursor-specific failure after the cursor is repaired", () => {
		const terminal = new VirtualTerminal(12, 3);
		const contract = new DisplayContract(3);
		terminal.write("\x1b[?25h猫x");
		const before = contract.observe("initial cursor", terminal);
		expect(before.viewport[0]).toBe("猫x");
		expect(before.cursor).toEqual({ row: 0, col: 3, visible: true });
		terminal.write("\x1b[?25l\x1b[3;8H");
		expect(() =>
			contract.observe("cursor moved", terminal, frame => {
				if (frame.cursor.row !== 0 || frame.cursor.col !== 3) throw new Error("cursor left draft");
			}),
		).toThrow("cursor left draft");
		terminal.write("\x1b[?25h\x1b[1;4H");
		expect(contract.observe("cursor repaired", terminal).cursor.visible).toBe(true);
		expect(() => contract.assertHealthy()).toThrow('current: event="cursor moved"');
		expect(() => contract.assertHealthy()).toThrow("visible=false");
	});

	it("bounds evidence while retaining the most recent prior and current frames", () => {
		const terminal = new VirtualTerminal(12, 3);
		const contract = new DisplayContract(4);
		for (let i = 0; i < 8; i++) {
			terminal.write(`\x1b[H${i}`);
			contract.observe(`event ${i}`, terminal);
		}
		const evidence = contract.evidence();
		expect(evidence).not.toContain('event="event 0"');
		expect(evidence).toContain('event="event 6"');
		expect(evidence).toContain('current: event="event 7"');
	});
});
