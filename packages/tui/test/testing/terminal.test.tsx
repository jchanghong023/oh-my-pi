/** @jsxImportSource @oh-my-pi/pi-tui */
import { describe, expect, it } from "bun:test";
import { signal, type UiNode } from "@oh-my-pi/pi-tui";
import { createTestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";

describe("createTestTerminal", () => {
	it("routes typing through the focused editor and keys up the focus path", () => {
		const text = signal("");
		const caret = signal(0);
		const submitted: string[] = [];
		let editor: UiNode | undefined;
		const term = createTestTerminal(
			() => ({
				dock: (
					<col
						onKey={key => {
							if (key.id !== "enter") return false;
							submitted.push(text());
							return true;
						}}
					>
						{
							(editor = (
								<editor
									text={text}
									cursor={caret}
									onEdit={edit => {
										text.set(text().slice(0, edit.from) + edit.text + text().slice(edit.to));
										caret.set(edit.cursor);
									}}
								/>
							) as UiNode)
						}
					</col>
				),
			}),
			{ columns: 20, rows: 4 },
		);
		term.focus(editor!);
		term.type("hi there");
		expect(text()).toBe("hi there");
		term.press("enter");
		expect(submitted).toEqual(["hi there"]);
		expect(term.screen().join("\n")).toContain("hi there");
		expect(term.cursor()).not.toBeNull();
		term.dispose();
	});

	it("paints clocked kinds from the scripted clock", () => {
		const term = createTestTerminal(() => ({ dock: <spinner /> }), { columns: 10, rows: 2, now: 0 });
		try {
			const first = term.screen()[0];
			term.tick(79);
			expect(term.screen()[0]).toBe(first);
			term.tick(1);
			const second = term.screen()[0];
			expect(second).not.toBe(first);
			term.tick(79);
			expect(term.screen()[0]).toBe(second);
			term.tick(1);
			expect(term.screen()[0]).not.toBe(second);
		} finally {
			term.dispose();
		}
	});
});
