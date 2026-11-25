/**
 * The composer in the terminal (`col` nodes with role `omp.editor` and
 * `omp.editor.<state>`): its text field inside the chrome of the composer's
 * shape, the completion popup under it.
 *
 * The field (`line` row → `editor`) is painted at the wrap width the shape
 * leaves, plus the padding cell an end-of-row caret may take; each of its
 * rows goes through the shape's row renderer with its padding and gutter.
 * The status bar facts, mode chip and send/stop controls are native-only: the
 * terminal shows them in the status line. `term.faint` dims every cell (the
 * keys are away at an ask above).
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, type Cell, defineRolePainter, EMPTY_BLOCK, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { caretOf, type EditorProps, setTerminalCompletionLayout } from "@oh-my-pi/pi-tui/term/painters/editor";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { fgSgr } from "@oh-my-pi/pi-tui/theme/color";
import { type ComposerChromeContext, type ComposerStatus, caretOverflow, composerShape } from "./shapes";

/** Terminal-only facts of the composer node (its `term` prop). */
export type ComposerTerm = {
	/** Registered shape id (`box` when unknown). */
	readonly shape?: string;
	/** Padding inside the side chrome (the shape's default otherwise). */
	readonly paddingX?: number;
	/** Status content for shapes that show one in their top chrome. */
	readonly status?: ComposerStatus;
	/** The border's color: a theme color key or a `#rrggbb` hex (a session accent). */
	readonly border?: string;
	/** Dim the border (the view is proxied at a focused subagent). */
	readonly borderFaint?: boolean;
	/** Dim every cell. */
	readonly faint?: boolean;
	/** Keep terminal chrome out of the hardware cursor's IME preedit space. */
	readonly imeSafeCursor?: boolean;
};

const MARK = "\u0000";

/** The escapes `styled` wraps around its text. */
function sgrPair(styled: string): [string, string] {
	const at = styled.indexOf(MARK);
	return at === -1 ? ["", ""] : [styled.slice(0, at), styled.slice(at + 1)];
}

/** Background and text color over `text`, reopened after the resets inside it. */
function surface(cx: PaintContext, text: string): string {
	const [bg] = sgrPair(cx.theme.bg("userMessageBg", MARK));
	const [fg] = sgrPair(cx.theme.fgResolved("text", MARK));
	const body = text.replace(/\x1b\[(0|39|49)?m/g, reset =>
		reset === "\x1b[39m" ? `${reset}${fg}` : reset === "\x1b[49m" ? `${reset}${bg}` : `${reset}${bg}${fg}`,
	);
	return `${bg}${fg}${body}\x1b[39m\x1b[49m`;
}

/** Dim a row, reopening faint after every reset that ends it. */
function faint(row: string): string {
	return `\x1b[2m${row.replace(/\x1b\[(?:0|22)?m/g, reset => `${reset}\x1b[2m`)}\x1b[22m`;
}

/** The composer's field node (`line` row → `editor`). */
export function composerField(node: UiNode): UiNode | undefined {
	const line = node.children().find(child => child.key() === "line");
	return line?.children().find(child => child.kind === "editor" || child.kind === "input");
}

function paintComposer(node: UiNode, cx: PaintContext): Block {
	const term = ((node.props() as { term?: ComposerTerm }).term ?? {}) as ComposerTerm;
	const theme = cx.theme;
	const shape = composerShape(term.shape);
	const paddingX = term.paddingX ?? shape.paddingX;
	const side = shape.sideWidth(paddingX);
	const innerWidth = Math.max(0, cx.width - 2 * side);
	const gutterWidth = shape.gutter ? Math.min(visibleWidth(shape.gutter), innerWidth) : 0;
	const contentWidth = innerWidth - gutterWidth;
	// A side-bordered shape without padding keeps a column for the end-of-row caret.
	const reserve = shape.sideBorders && paddingX === 0 ? 1 : 0;
	const wrapWidth = Math.max(1, contentWidth - reserve);
	const field = composerField(node);
	const block = field ? cx.paint(field, wrapWidth + caretOverflow(shape, paddingX)) : EMPTY_BLOCK;

	const imeSafeCursor = term.imeSafeCursor === true && shape.sideBorders;
	// A status source draws for the shape's attachment at the cells inside its side chrome.
	const status =
		typeof term.status === "function"
			? shape.statusAttachment && term.status(cx, shape.statusAttachment, innerWidth)
			: term.status;
	const chrome: ComposerChromeContext = {
		width: cx.width,
		paddingX,
		theme,
		border: text => {
			const color = term.border ?? "borderMuted";
			const drawn = color.startsWith("#") ? `${fgSgr(color, theme.depth)}${text}\x1b[39m` : theme.fg(color, text);
			return term.borderFaint ? `\x1b[2m${drawn}\x1b[22m` : drawn;
		},
		accent: text => theme.fg("accent", text),
		surface: text => surface(cx, text),
		box: theme.symbols.box,
		...(status ? { status } : {}),
		...(imeSafeCursor ? { imeSafeCursor } : {}),
	};
	const gutter = shape.gutter ? shape.gutter.slice(0, gutterWidth) : "";
	const rows: string[] = [];
	const top = shape.top?.(chrome);
	if (top !== undefined) rows.push(top);
	for (const row of status?.overflow ?? []) rows.push(" ".repeat(side) + row);
	let cursor: Cell | undefined;
	const fieldRows = block.rows;
	const fieldProps = field?.props() as EditorProps | undefined;
	const contentRows = Math.max(fieldRows.length, Math.min(2, fieldProps?.maxLines ?? 2));
	const lastFieldRow = Math.max(0, fieldRows.length - 1);
	for (let i = 0; i < contentRows; i++) {
		const text = fieldRows[i] ?? "";
		const width = visibleWidth(text);
		const fieldCursor = block.cursor?.row === i ? block.cursor : undefined;
		// Keep the last text row open throughout IME mode. Earlier rows only open at a focused, unselected line end.
		const imeSafeCursorTail =
			imeSafeCursor &&
			(i === lastFieldRow ||
				(fieldCursor?.col === width &&
					fieldProps !== undefined &&
					!fieldProps.term?.selection &&
					!field?.fieldSelection?.range(caretOf(fieldProps))));
		const rendered = shape.row({
			...chrome,
			text,
			pad: " ".repeat(Math.max(0, contentWidth - width)),
			gutter: i === 0 ? gutter : " ".repeat(gutterWidth),
			first: i === 0,
			last: i === contentRows - 1,
			imeSafeCursorTail,
			overflow: Math.max(0, width - contentWidth),
		});
		const textFirst = Array.isArray(rendered);
		if (fieldCursor) {
			cursor = {
				row: rows.length + (textFirst ? 0 : rendered.textRow),
				col: side + gutterWidth + fieldCursor.col,
			};
		}
		rows.push(...(textFirst ? rendered : rendered.rows));
	}
	const bottom = shape.bottom?.(chrome);
	if (bottom !== undefined) rows.push(bottom);

	const rowsFromCaret = rows.length - (cursor?.row ?? 0);
	if (field && cursor) setTerminalCompletionLayout(field, cx, rowsFromCaret);

	// The popup covers the transcript above the composer rather than taking room from it.
	const popup = node.children().find(child => child.kind === "overlay");
	const viewportHeight = popup && cursor ? cx.viewportHeight : undefined;
	const popupRows = viewportHeight === undefined ? undefined : Math.max(0, viewportHeight - rowsFromCaret);
	const covering = popup ? cx.paint(popup, cx.width, popupRows).rows : [];
	rows.push(...covering);
	return {
		rows: term.faint ? rows.map(faint) : rows,
		...(covering.length > 0 ? { covering: covering.length } : {}),
		...(cursor ? { cursor } : {}),
	};
}

defineRolePainter("col", "omp.editor", paintComposer);
defineRolePainter("col", "omp.editor", paintComposer, { prefix: true });
