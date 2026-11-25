import { describe, expect, it } from "bun:test";
import { jsx, signal } from "@oh-my-pi/pi-tui";
import { DisplayContract } from "./helpers/display-contract";
import { mountVt } from "./helpers/vt-surface";

function hasDraft(viewport: readonly string[]): boolean {
	return viewport.some(row => row.includes("> draft"));
}

describe("display contract", () => {
	it("retains a transient blank-frame failure after the reactive terminal backend repaints", async () => {
		const rows = signal(["Ready", "> draft"]);
		const { vt, driver, backend, dispose } = mountVt(() => ({ dock: jsx("rows", { lines: rows }) }), {
			columns: 20,
			rows: 4,
		});
		const contract = new DisplayContract(90210);
		try {
			backend.renderNow();
			expect(hasDraft(contract.observe("before transition", vt).viewport)).toBe(true);
			let event = "blank transition";
			contract.watch(
				driver,
				() => event,
				frame => {
					if (!hasDraft(frame.viewport)) throw new Error("draft disappeared");
				},
			);
			rows.set(["", ""]);
			backend.renderNow();
			expect(vt.screen().every(row => row.trim() === "")).toBe(true);
			event = "restored transition";
			rows.set(["Ready", "> draft"]);
			backend.renderNow();
			expect(hasDraft(vt.screen())).toBe(true);
			expect(() => contract.assertHealthy()).toThrow("draft disappeared");
		} finally {
			await dispose();
		}
	});
});
