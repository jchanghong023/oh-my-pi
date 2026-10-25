import { UserMessageComponent } from "../chat/user-message";
import type { TUI } from "../tui";
import { ReportPanel } from "./report-panel";

/** Full original message, independently scrollable even while the main transcript is compact. */
export function createUserMessageDetails(
	text: string,
	onClose: () => void,
	maxRows: () => number | undefined,
): ReportPanel {
	return new ReportPanel({
		title: "用户消息全文",
		body: new UserMessageComponent(text, { compactPreview: false }),
		closeKey: "Esc",
		onClose,
		maxRows,
	});
}

/** Borrow the existing focused report overlay; hiding it restores the untouched editor and draft. */
export function showUserMessageDetails(ui: TUI, text: string): void {
	const panel = createUserMessageDetails(
		text,
		() => handle.hide(),
		() => Math.max(1, ui.terminal.rows),
	);
	panel.holdFocus();
	const handle = ui.showOverlay(panel, { fullscreen: true, width: "100%", maxHeight: "100%" });
	ui.requestRender();
}
