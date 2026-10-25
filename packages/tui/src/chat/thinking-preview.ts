import { sanitizeText } from "@oh-my-pi/pi-utils";
import { theme } from "../theme";

/** Clip already laid-out thinking without changing its Markdown or lifecycle. */
export function clipThinkingRows(rows: readonly string[], active: boolean): readonly string[] {
	if (rows.length === 0) return rows;
	const tail = rows.slice(-2);
	const painted = tail.map((row, index) =>
		theme.fg(active && index === tail.length - 1 ? "thinkingText" : "dim", sanitizeText(row)),
	);
	if (painted.length === 1) painted.push("");
	return painted;
}
