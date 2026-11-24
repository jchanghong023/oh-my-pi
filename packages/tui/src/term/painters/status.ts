/**
 * `status`: a one-row bar of `seg` children in a left and a right group.
 *
 * Each group is padded by a space on both ends and its segments are joined
 * by a dim `·`; the groups sit at the row's edges with at least one space
 * between them (a lone group starts at the left edge).
 *
 * When the bar is wider than the row, the lowest-priority segment yields
 * (ties: the one nearer the middle). Before a segment drops, the elastic
 * segments on its side (those with `min.w`) give up cells down to their
 * minimum, so a path or a title truncates before its neighbours vanish.
 */
import type { TspExtent, TspSegProps } from "@oh-my-pi/pi-wire";
import type { UiNode } from "../../node";
import { spaces, visibleWidth } from "../../text/width";
import { type Block, definePainter, EMPTY_BLOCK, type Hit, type PaintContext } from "../paint";

/** Which groups a bar shows. */
export type StatusGroups = "both" | "left" | "right";

/** How {@link statusRow} draws a bar. */
export interface StatusRowOptions {
	/** Styled separator glyph between segments of a group (default a dim `·`). */
	readonly separator?: string;
	/** Groups to draw (default both). */
	readonly groups?: StatusGroups;
	/** A layout that already fit the same rows can paint them without fitting again. */
	readonly fit?: StatusFit;
}

/** A painted row and the segments' hit regions in it. */
export interface StatusRow {
	readonly row: string;
	readonly hits: readonly Hit[];
}

interface Slot {
	readonly node: UiNode;
	readonly side: "left" | "right";
	readonly priority: number;
	/** Order within its side. */
	readonly index: number;
	/** Narrowest it may be cut to; undefined: it never shrinks. */
	min: number | undefined;
	readonly naturalWidth: number;
	text: string;
	width: number;
}

function extentCells(extent: TspExtent | undefined, width: number): number | undefined {
	if (extent === undefined) return undefined;
	if (typeof extent === "number") return Math.floor(extent * width);
	return extent.endsWith("ch") ? Number.parseInt(extent, 10) : undefined;
}

function groupWidth(slots: readonly FittedSeg[], sepWidth: number): number {
	if (slots.length === 0) return 0;
	let width = 2 + (slots.length - 1) * (sepWidth + 2);
	for (const slot of slots) width += slot.width;
	return width;
}

/** Whether `a` yields before `b`: lower priority, then the one nearer the middle, right side first. */
function yieldsBefore(a: Slot, b: Slot): boolean {
	if (a.priority !== b.priority) return a.priority < b.priority;
	if (a.side !== b.side) return a.side === "right";
	return a.side === "left" ? a.index > b.index : a.index < b.index;
}

/** A segment as it fits the bar. */
export interface FittedSeg {
	readonly node: UiNode;
	readonly text: string;
	readonly width: number;
}

/** How {@link fitStatus} measures a bar. */
export interface StatusFitOptions {
	/** Cells of the separator between segments of a group. */
	readonly separatorWidth: number;
	/** A chrome attachment can reserve cells outside the fitted bar. */
	readonly maxWidth?: number;
	/** Groups to keep (default both). */
	readonly groups?: StatusGroups;
	/** Cells a non-empty group takes besides its segments, separators and edge spaces (end caps). */
	readonly groupExtra?: { readonly left: number; readonly right: number };
	/** Give cells freed by dropped segments back to truncated survivors. */
	readonly reclaim?: boolean;
	/**
	 * Fewest cells between the groups for what remains (default one while
	 * both groups show, else none).
	 */
	readonly minGap?: (fit: {
		readonly segs: number;
		readonly leftWidth: number;
		readonly rightWidth: number;
	}) => number;
}

/** The segments that fit `cx.width`, per group, and each group's cells (0 when empty). */
export interface StatusFit {
	readonly left: readonly FittedSeg[];
	readonly right: readonly FittedSeg[];
	readonly leftWidth: number;
	readonly rightWidth: number;
}

/**
 * Fit `segs` into `cx.width` cells (see the module docs): a group is its
 * segments, a separator with a space either side between them, a space at
 * each end, plus `groupExtra`. Segments paint through `cx.paint`, so a role
 * look of `seg` applies, and shrink by being painted narrower.
 */
export function fitStatus(cx: PaintContext, segs: readonly UiNode[], options: StatusFitOptions): StatusFit {
	const width = Math.min(cx.width, options.maxWidth ?? cx.width);
	const groups = options.groups ?? "both";
	const sepWidth = options.separatorWidth;
	const extra = options.groupExtra ?? { left: 0, right: 0 };
	const left: Slot[] = [];
	const right: Slot[] = [];
	for (const node of segs) {
		const props = node.props() as TspSegProps;
		const side = props.side === "right" ? "right" : "left";
		if (groups !== "both" && side !== groups) continue;
		const text = cx.paint(node, width).rows[0] ?? "";
		if (!text) continue;
		const list = side === "left" ? left : right;
		const cells = visibleWidth(text);
		list.push({
			node,
			side,
			priority: props.priority ?? 0,
			index: list.length,
			min: extentCells(props.min?.w, width),
			text,
			width: cells,
			naturalWidth: cells,
		});
	}
	const leftWidth = () => (left.length > 0 ? groupWidth(left, sepWidth) + extra.left : 0);
	const rightWidth = () => (right.length > 0 ? groupWidth(right, sepWidth) + extra.right : 0);
	const total = (): number => {
		const fit = { segs: left.length + right.length, leftWidth: leftWidth(), rightWidth: rightWidth() };
		const gap = options.minGap ? options.minGap(fit) : left.length > 0 && right.length > 0 ? 1 : 0;
		return fit.leftWidth + fit.rightWidth + gap;
	};

	while (total() > width) {
		let victim: Slot | undefined;
		for (const slot of [...left, ...right]) if (!victim || yieldsBefore(slot, victim)) victim = slot;
		if (!victim) break;
		const side = victim.side === "left" ? left : right;
		let elastic: Slot | undefined;
		for (const slot of side) {
			if (slot.min === undefined || slot.width <= slot.min) continue;
			if (!elastic || yieldsBefore(slot, elastic)) elastic = slot;
		}
		if (elastic?.min !== undefined) {
			const target = elastic.width - Math.min(elastic.width - elastic.min, total() - width);
			const text = cx.paint(elastic.node, target).rows[0] ?? "";
			const cut = visibleWidth(text);
			// A look that cannot get narrower is treated as rigid from here on.
			if (cut >= elastic.width) elastic.min = undefined;
			else {
				elastic.text = text;
				elastic.width = cut;
			}
			continue;
		}
		side.splice(side.indexOf(victim), 1);
	}
	if (options.reclaim) {
		const survivors = [...left, ...right].filter(slot => slot.width < slot.naturalWidth);
		survivors.sort((a, b) => b.priority - a.priority);
		for (const slot of survivors) {
			const target = slot.width + Math.min(slot.naturalWidth - slot.width, Math.max(0, width - total()));
			if (target <= slot.width) continue;
			const text = cx.paint(slot.node, target).rows[0] ?? "";
			const cells = visibleWidth(text);
			if (cells > slot.width && cells <= target) {
				slot.text = text;
				slot.width = cells;
			}
		}
	}
	return { left, right, leftWidth: leftWidth(), rightWidth: rightWidth() };
}

/**
 * Lay out a bar of `segs` in `cx.width` cells (see the module docs) with no
 * background: a lone group starts at the left edge.
 */
export function statusRow(cx: PaintContext, segs: readonly UiNode[], options: StatusRowOptions = {}): StatusRow {
	const width = cx.width;
	const separator = options.separator ?? cx.theme.style("dim", "·");
	const sepWidth = visibleWidth(separator);
	const { left, right, leftWidth, rightWidth } =
		options.fit ??
		fitStatus(cx, segs, {
			separatorWidth: sepWidth,
			...(options.groups ? { groups: options.groups } : {}),
		});
	if (left.length === 0 && right.length === 0) return { row: "", hits: [] };

	const hits: Hit[] = [];
	const group = (slots: readonly FittedSeg[], at: number): string => {
		if (slots.length === 0) return "";
		let col = at + 1;
		const parts: string[] = [];
		for (const slot of slots) {
			if ("actions" in slot.node.props()) hits.push({ row: 0, col, width: slot.width, height: 1, node: slot.node });
			parts.push(slot.text);
			col += slot.width + sepWidth + 2;
		}
		return ` ${parts.join(` ${separator} `)} \x1b[0m`;
	};
	const leftGroup = group(left, 0);
	if (left.length === 0 || right.length === 0) return { row: leftGroup + group(right, leftWidth), hits };
	const gap = Math.max(1, width - leftWidth - rightWidth);
	return { row: leftGroup + spaces(gap) + group(right, leftWidth + gap), hits };
}

function paintStatus(node: UiNode, cx: PaintContext): Block {
	const segs = node.children().filter(child => child.kind === "seg");
	const { row, hits } = statusRow(cx, segs);
	if (!row) return EMPTY_BLOCK;
	return hits.length > 0 ? { rows: [row], hits } : { rows: [row] };
}

definePainter("status", paintStatus);
