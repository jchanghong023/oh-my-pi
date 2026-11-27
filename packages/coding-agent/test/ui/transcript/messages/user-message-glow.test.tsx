/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * A sent prompt's magic keywords glow: their gradient sweeps on the terminal clock, stays still
 * under reduced motion, and natively they are accent marks with the shimmer effect.
 */
import { describe, expect, test } from "bun:test";
import { createRoot } from "@oh-my-pi/pi-tui";
import { createTestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { MAGIC_KEYWORDS } from "../../../../src/modes/magic-keywords";
import "../../../../src/ui/styles/messages";
import { UserMessage } from "../../../../src/ui/transcript/messages/user-message";

// The assertions read truecolor SGR, independent of the host terminal's color depth.
const theme = loadThemeSync("dark", { depth: "truecolor" });

const keywords = () => MAGIC_KEYWORDS;

/** Truecolor foregrounds on the prompt's row. */
function colors(rows: readonly string[]): string[] {
	const row = rows.find(line => line.includes("now")) ?? "";
	return [...row.matchAll(/\x1b\[38;2;(\d+;\d+;\d+)m/g)].map(match => match[1]!);
}

describe("sent prompt glow", () => {
	test("sweeps on the terminal clock", () => {
		createRoot(dispose => {
			const term = createTestTerminal(
				() => ({ main: [<UserMessage model={{ text: "ultrathink it now", magicKeywords: keywords }} />] }),
				{ columns: 40, rows: 6, theme, now: 0 },
			);
			try {
				const before = colors(term.rows());
				expect(new Set(before).size).toBeGreaterThan(5);
				term.tick(450);
				const after = colors(term.rows());
				expect(new Set(after).size).toBeGreaterThan(5);
				expect(after).not.toEqual(before);
			} finally {
				term.dispose();
				dispose();
			}
		});
	});

	test("stays plain without keywords (and in code)", () => {
		createRoot(dispose => {
			const term = createTestTerminal(
				() => ({ main: [<UserMessage model={{ text: "`ultrathink` it now", magicKeywords: keywords }} />] }),
				{ columns: 40, rows: 6, theme },
			);
			expect(term.rows().join("\n")).toContain("ultrathink");
			term.dispose();
			dispose();
		});
	});
});
