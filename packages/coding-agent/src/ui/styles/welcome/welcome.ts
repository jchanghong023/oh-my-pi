/**
 * Terminal look of the welcome card (`omp.welcome`, `src/ui/welcome/welcome.tsx`).
 *
 * Content keeps a column clear on each side and centers in the full width:
 * - the gradient logo with the bold `omp` wordmark beside it and the dim
 *   version under the wordmark — the logo alone when the lockup does not fit,
 *   nothing below four columns; centered as one block;
 * - from 50 columns, a blank row and the tip, `提示：` in the label color and
 *   the body muted, italic, wrapped to at most 72 columns, each row centered.
 *
 * While the intro runs the logo follows the terminal clock.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, EMPTY_BLOCK, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { replaceTabs, spaces, visibleWidth, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { ColorDepth } from "@oh-my-pi/pi-tui/theme/color";
import type { TspText } from "@oh-my-pi/pi-wire";
import { INTRO_MS, introLogo, LOGO_WIDTH, WORDMARK, WORDMARK_WIDTH } from "../../welcome/logo";
import type { WelcomeLook } from "../../welcome/welcome";

/** Columns between the logo and the wordmark. */
const LOCKUP_GAP = 4;
/** Widest a tip wraps. */
const TIP_MEASURE = 72;
/** Narrowest terminal that shows the tip. */
const TIP_MIN_COLUMNS = 50;
const TIP_LABEL = "提示：";
/** Text of the `[NEW]` tag and one hue turn of its rainbow. */
const NEW_TAG = "新功能";
const NEW_GLOW_MS = 1500;

/** `lines` indented as one block whose widest line centers in `width`. */
function centered(lines: readonly string[], width: number): string[] {
	const widest = lines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
	const indent = spaces(Math.floor((width - widest) / 2));
	return lines.map(line => indent + line);
}

/** The rainbow tag at hue offset `phase`. */
function newTag(phase: number, depth: ColorDepth): string {
	const chars = [...NEW_TAG];
	let out = "\x1b[1m";
	chars.forEach((ch, i) => {
		const hue = Math.round(((i / chars.length + (((phase % 1) + 1) % 1)) % 1) * 360);
		out += `${Bun.color(`hsl(${hue}, 95%, 60%)`, depth === "truecolor" ? "ansi-16m" : "ansi-256") ?? ""}${ch}`;
	});
	return `${out}\x1b[0m`;
}

/** The tip body as terminal text: links underlined and linked, or `label (url)` where the terminal cannot link. */
function tipBody(tip: TspText, cx: PaintContext): string {
	if (typeof tip === "string") return tip;
	let out = "";
	for (const span of tip) {
		if (!span.href) out += span.t;
		else if (cx.hyperlinks) out += `\x1b]8;;${span.href}\x07${cx.theme.style("underline", span.t)}\x1b]8;;\x07`;
		else out += `${span.t} (${span.href})`;
	}
	return out;
}

/** The tip rows at `width` (at most), before centering; none when the width leaves no useful line. */
function tipRows(look: WelcomeLook, width: number, cx: PaintContext, phase: number): string[] {
	if (look.tip === undefined || width - visibleWidth(TIP_LABEL) < 8) return [];
	const { theme } = cx;
	const lines = wrap(replaceTabs(`${TIP_LABEL}${tipBody(look.tip, cx)}`), width).map(line => line.trimEnd());
	const rows = lines.map((line, index) =>
		theme.style(
			"em",
			index === 0 && line.startsWith(TIP_LABEL)
				? `${theme.style("customMessageLabel", TIP_LABEL)}${theme.style("muted", line.slice(TIP_LABEL.length))}`
				: theme.style("muted", line),
		),
	);
	if (look.isNew && rows.length > 0) {
		const tag = newTag(phase, theme.depth);
		const last = rows[rows.length - 1]!;
		if (visibleWidth(last) + 1 + visibleWidth(NEW_TAG) <= width) rows[rows.length - 1] = `${last} ${tag}`;
		else rows.push(tag);
	}
	return rows;
}

function paintWelcome(node: UiNode, cx: PaintContext): Block {
	const props = node.props() as { term?: WelcomeLook };
	const look = props.term;
	const { theme, width } = cx;
	const room = width - 2;
	if (!look || room < 4) return EMPTY_BLOCK;
	const depth = theme.depth;
	// Reading the clock only while the intro runs keeps the resting card still.
	const elapsed = look.introStart === null ? INTRO_MS : cx.reduceMotion ? INTRO_MS : cx.now(true) - look.introStart;
	const logo = introLogo(Math.max(0, elapsed) / INTRO_MS, depth);
	const version = theme.style("dim", `v${look.version}`);
	const hasLockup = room >= LOGO_WIDTH + LOCKUP_GAP + Math.max(WORDMARK_WIDTH, visibleWidth(version));
	let art: readonly string[] = [];
	if (hasLockup) {
		const beside = ["", ...WORDMARK.map(row => theme.style("text strong", row)), version];
		art = logo.map((row, index) => `${row}${spaces(LOCKUP_GAP)}${beside[index] ?? ""}`);
	} else if (room >= LOGO_WIDTH) art = logo;
	const rows = centered(art, width);
	if (width >= TIP_MIN_COLUMNS) {
		const phase = look.isNew && look.introStart !== null ? cx.now() / NEW_GLOW_MS : 0;
		const tip = tipRows(look, Math.min(room, TIP_MEASURE), cx, phase);
		if (tip.length > 0) rows.push("", ...tip.flatMap(line => centered([line], width)));
	}
	return rows.length > 0 ? { rows } : EMPTY_BLOCK;
}

defineRolePainter("card", "omp.welcome", paintWelcome);
