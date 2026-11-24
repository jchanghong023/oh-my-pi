/**
 * The status line in a composer's top chrome (`omp.status.top`, see
 * `createStatusLine`), one row at the cells the chrome offers:
 *
 * - `top-border` (box): the left and right groups on the status background,
 *   their segments joined by the configured separator and closed by powerline
 *   caps (none on a transparent bar), the context gauge between them.
 * - `top-band` (band): the same, opened flush left by the soft band cap and
 *   without the session title (the working row carries it).
 * - `top-rule-chip` (claude, rule): the right group alone as a chip on the
 *   status background, joined by the status separator, no caps.
 *
 * The usage rule uses the session accent. In `embedded` mode, context
 * segments leave the groups and a fixed label follows the rule. Only
 * `annotated` marks the compaction thresholds.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, EMPTY_BLOCK, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { fitStatus, type StatusFit } from "@oh-my-pi/pi-tui/term/painters/status";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { fgSgr } from "@oh-my-pi/pi-tui/theme/color";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { TOP_RULE_CHIP_RESERVE } from "../composer/shapes";
import { adjustHsv, formatNumber } from "@oh-my-pi/pi-utils";
import type { StatusLineSeparatorStyle } from "../../../config/status-line-schema";
import { sessionAccentHex } from "../../status/accent";
import type { StatusTopLook } from "../../status/status-line";

const RESET = "\x1b[0m";
const BG_DEFAULT = "\x1b[49m";

interface Separator {
	readonly left: string;
	readonly right: string;
	/** Powerline caps closing the groups (drawn with the bar's fill as their color). */
	readonly caps?: { readonly left: string; readonly right: string };
}

function separatorOf(style: StatusLineSeparatorStyle, theme: Theme): Separator {
	const sym = (key: string) => theme.symbols.symbol(key);
	const caps = { left: sym("sep.powerlineRight"), right: sym("sep.powerlineLeft") };
	switch (style) {
		case "powerline":
			return { left: sym("sep.powerlineLeft"), right: sym("sep.powerlineRight"), caps };
		case "slash":
			return { left: sym("sep.slash").trim(), right: sym("sep.slash").trim() };
		case "pipe":
			return { left: sym("sep.pipe").trim(), right: sym("sep.pipe").trim() };
		case "block":
			return { left: sym("sep.block"), right: sym("sep.block") };
		case "none":
			return { left: sym("sep.space"), right: sym("sep.space") };
		case "ascii":
			return { left: sym("sep.asciiLeft"), right: sym("sep.asciiRight") };
		default:
			return { left: sym("sep.powerlineThinLeft"), right: sym("sep.powerlineThinRight"), caps };
	}
}

/** The SGR `styled` opens before its text. */
function bgSgr(theme: Theme, key: string): string {
	const styled = theme.bg(key, "\u0000");
	return styled.slice(0, styled.indexOf("\u0000"));
}

/** Live-work badges the bar adds in front of the configured right segments. */
const BADGES = new Set(["jobs"]);

const isContext = (node: UiNode) => node.key() === "context_pct" || node.key() === "context_total";

function embeddedPercent(percent: number): string {
	return `${percent > 0 && percent < 1 ? percent.toFixed(1) : Math.round(percent)}%`;
}

/** Form the fixed, right-aligned unit; keep two cells after it. */
function embeddedInfo(percent: number | null, window: number): string {
	const capacity = formatNumber(window);
	return percent === null ? `${capacity}  ` : `ctx ${embeddedPercent(percent)} · ${capacity}  `;
}

/** The gauge rule of `width` cells between the groups. */
function gauge(look: StatusTopLook, width: number, embedded: boolean, cx: PaintContext): string {
	const { theme } = cx;
	const accentHex = look.accent ? sessionAccentHex(theme, look.accent) : undefined;
	const lit = accentHex ? fgSgr(accentHex, theme.depth) : theme.fgSgr("borderAccent");
	const rule = theme.symbols.box.horizontal;
	const mode = look.contextLine ?? "embedded";
	const { percent, window } = look.context;
	if (mode === "off" || (percent === null && window <= 0)) return `${BG_DEFAULT}${lit}${rule.repeat(width)}\x1b[39m`;

	const clamped = percent === null ? 0 : Math.min(100, Math.max(0, percent));
	const overflow = percent !== null && percent > 100;
	const info = embedded ? embeddedInfo(percent, window) : "";
	const showInfo = info !== "" && info.length <= width;
	const scale = width - (showInfo ? info.length : 0);
	const used = Math.min(scale, Math.max(1, Math.round((clamped / 100) * scale)));

	let speculationAt = -1;
	let thresholdAt = -1;
	if (mode === "annotated" && look.autoCompact && look.compaction && scale >= 8) {
		const cell = (at: number) => Math.min(scale - 1, Math.max(0, Math.round((at / 100) * scale)));
		thresholdAt = cell(look.compaction.thresholdPercent);
		if (look.compaction.speculationPercent !== null) speculationAt = cell(look.compaction.speculationPercent);
		if (speculationAt === thresholdAt) speculationAt = -1;
	}

	const dimmed = fgSgr(adjustHsv(accentHex ?? theme.hex("borderAccent"), { s: 0.7, v: 0.75 }), theme.depth);
	const unused = theme.fgSgr("border");
	let out = BG_DEFAULT;
	let active = "";
	let i = 0;
	while (i < scale) {
		let color: string;
		let text: string;
		if (i === thresholdAt) {
			color = dimmed;
			text = theme.symbols.symbol("context.compaction");
			i++;
		} else if (i === speculationAt) {
			color = theme.fgSgr("muted");
			text = theme.symbols.symbol("context.speculation");
			i++;
		} else {
			let end = i < used ? used : scale;
			if (thresholdAt > i && thresholdAt < end) end = thresholdAt;
			if (speculationAt > i && speculationAt < end) end = speculationAt;
			color = i < used ? lit : unused;
			text = rule.repeat(end - i);
			i = end;
		}
		if (color !== active) {
			out += color;
			active = color;
		}
		out += text;
	}
	if (showInfo) {
		if (percent === null) out += `${dimmed}${info}`;
		else
			out += `${dimmed}ctx ${overflow ? theme.fgSgr("error") : lit}${embeddedPercent(percent)}${dimmed} · ${formatNumber(window)}  `;
	}
	return `${out}\x1b[39m`;
}

/** Fit the right status group to a composer rule with room for the edge glyphs. */
export function fitRuleChip(cx: PaintContext, segs: readonly UiNode[]): StatusFit {
	return fitStatus(cx, segs, {
		separatorWidth: 1,
		groups: "right",
		maxWidth: Math.max(0, cx.width - TOP_RULE_CHIP_RESERVE),
	});
}

/** Wrap unused segments at their natural width, truncating only when a segment fills a row on its own. */
export function statusOverflow(cx: PaintContext, segs: readonly UiNode[], fit: StatusFit): string[] {
	const { theme, width } = cx;
	if (width < 1 || fit.left.length + fit.right.length === segs.length) return [];
	const shown = new Set<UiNode>();
	for (const { node } of fit.left) shown.add(node);
	for (const { node } of fit.right) shown.add(node);
	const fg = theme.fgSgr("text");
	const sep = theme.symbols.symbol("sep.dot").trim() || "·";
	const separator = ` ${theme.fg("statusLineSep", sep)}${fg} `;
	const separatorWidth = visibleWidth(sep) + 2;
	const rows: string[] = [];
	let row = "";
	let used = 0;
	for (const seg of segs) {
		if (shown.has(seg)) continue;
		const text = cx.paint(seg, width).rows[0] ?? "";
		if (!text) continue;
		const cells = visibleWidth(text);
		if (row && used + separatorWidth + cells <= width) {
			row += separator + text;
			used += separatorWidth + cells;
		} else {
			if (row) rows.push(`${row}\x1b[39m`);
			row = fg + text;
			used = cells;
		}
	}
	if (row) rows.push(`${row}\x1b[39m`);
	return rows;
}

function paintTop(node: UiNode, cx: PaintContext): Block {
	const props = node.props() as { term?: StatusTopLook };
	const look = props.term;
	if (!look) return EMPTY_BLOCK;
	const { theme, width } = cx;
	const chip = look.attachment === "top-rule-chip";
	const band = look.attachment === "top-band";
	const sep: Separator = chip ? { left: "·", right: "·" } : separatorOf(look.separator, theme);
	const bg = look.transparent ? BG_DEFAULT : bgSgr(theme, "statusLineBg");
	const caps = sep.caps && !look.transparent ? sep.caps : undefined;
	const bandCap = band && caps ? theme.symbols.symbol("sep.powerlineCapLeft") : "";

	let segs = look.segs;
	if (band) segs = segs.filter(seg => seg.key() !== "session_name");
	const { percent, window } = look.context;
	const embedded =
		!chip &&
		look.contextLine === "embedded" &&
		window > 0 &&
		segs.some(isContext) &&
		segs.some(seg => !isContext(seg) && !BADGES.has(seg.key() ?? ""));
	if (embedded) segs = segs.filter(seg => !isContext(seg));
	const gaugeWidth = embedded ? embeddedInfo(percent, window).length : 0;

	const fit = chip
		? fitRuleChip(cx, segs)
		: fitStatus(cx, segs, {
				separatorWidth: visibleWidth(sep.left),
				reclaim: look.attachment === "top-border",
				groupExtra: {
					left: (caps ? visibleWidth(caps.right) : 0) + visibleWidth(bandCap),
					right: caps ? visibleWidth(caps.left) : 0,
				},
				minGap: ({ segs: count, leftWidth, rightWidth }) => {
					if (!gaugeWidth) return leftWidth > 0 && rightWidth > 0 ? 1 : 0;
					if (count === 1 && leftWidth + rightWidth + gaugeWidth > width) return 1;
					return gaugeWidth <= width ? gaugeWidth : count > 1 ? 1 : 0;
				},
			});
	if (fit.left.length === 0 && fit.right.length === 0 && look.attachment !== "top-border") return EMPTY_BLOCK;

	const fg = theme.fgSgr("text");
	const sepSgr = theme.fgSgr("statusLineSep");
	const capSgr = bg.replace("\x1b[48;", "\x1b[38;");
	const unfaint = look.faint ? "\x1b[22m" : "";
	const group = (texts: readonly string[], separator: string): string =>
		texts.length === 0 ? "" : `${bg}${fg} ${texts.join(` ${sepSgr}${separator}${fg} `)} ${RESET}`;
	const left = group(
		fit.left.map(seg => seg.text),
		sep.left,
	);
	const right = group(
		fit.right.map(seg => seg.text),
		sep.right,
	);
	const leftRow = left
		? (bandCap ? `${capSgr}${unfaint}${bandCap}${RESET}` : "") +
			left +
			(caps ? `${capSgr}${unfaint}${caps.right}${RESET}` : "")
		: "";
	const rightRow = right ? (caps ? `${capSgr}${unfaint}${caps.left}${RESET}` : "") + right : "";
	const gap = Math.max(0, width - fit.leftWidth - fit.rightWidth);
	const row = chip || width === 0 ? rightRow : leftRow + gauge(look, gap, embedded, cx) + rightRow;
	const rows = [row];
	if (look.attachment === "top-border") {
		const overflow = embedded && gap < gaugeWidth ? look.segs : segs;
		rows.push(...statusOverflow(cx, overflow, fit));
	}
	return {
		rows: look.faint ? rows.map(line => `\x1b[2m${line.replaceAll(RESET, `${RESET}\x1b[2m`)}\x1b[22m`) : rows,
	};
}

defineRolePainter("status", "omp.status.top", paintTop);
