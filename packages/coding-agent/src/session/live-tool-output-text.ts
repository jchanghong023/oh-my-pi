import { plainText } from "@oh-my-pi/pi-tui/native/spans";
import { sanitizeDisplayLines } from "@oh-my-pi/pi-tui/render/render-utils";
import { type BashToolDetails, stripBashNotices } from "@oh-my-pi/pi-tui/tools/bash";
import { unwrapHashlineHeaderPath } from "@oh-my-pi/pi-tui/tools/hashline-format";
import { resultText } from "@oh-my-pi/pi-tui/tools/native-view";
import { type OutputMeta, stripOutputNotice } from "@oh-my-pi/pi-tui/tools/output-meta";
import type { ToolRenderResult } from "@oh-my-pi/pi-tui/tools/renderer";
import { parseXdUrl } from "@oh-my-pi/pi-tui/tools/xd-url";
import { isRecord } from "@oh-my-pi/pi-utils";

/** A compact preview row must contain a Unicode letter or number, not just decoration. */
export function isToolOutputRow(row: string): boolean {
	return /[\p{L}\p{N}]/u.test(row);
}

/** Tool identity and details after an actual device dispatch, or the direct call's facts. */
export function toolOutputSource(toolName: string, result?: ToolRenderResult<unknown>) {
	const details = isRecord(result?.details) ? result.details : undefined;
	const dispatch = isRecord(details?.xdev) ? details.xdev : undefined;
	if (toolName === "write" && typeof dispatch?.tool === "string" && dispatch.mode !== "help") {
		return { name: dispatch.tool, details: isRecord(dispatch.inner) ? dispatch.inner : undefined, dispatch };
	}
	return { name: toolName, details };
}

/** Actual displayable compact Output, using the same output boundaries as the tool renderers. */
export function toolOutputText(toolName: string, result: ToolRenderResult<unknown>, args?: unknown): string {
	const { name, details, dispatch } = toolOutputSource(toolName, result);
	if (toolName === "todo") return "";
	if (toolName === "write") {
		const fields = isRecord(args) ? args : undefined;
		const device = typeof fields?.path === "string" ? parseXdUrl(unwrapHashlineHeaderPath(fields.path)) : null;
		if (device?.name === "todo" || dispatch?.tool === "todo") return "";
		// Help does not dispatch, but its result can still identify a TODO request.
		if (isRecord(details?.xdev) && details.xdev.tool === "todo") return "";
	}
	const raw = resultText(result);
	let output: string;
	if (name === "bash") {
		const bash = details as BashToolDetails | undefined;
		const job = bash?.async;
		// A retained running body can outlive its job. Keep excluding the job's startup receipt.
		const noticeDetails =
			job && job.state !== "running" ? { ...bash, async: { ...job, state: "running" as const } } : bash;
		output = stripBashNotices(raw, noticeDetails).text;
	} else if (name === "read" && isRecord(details?.displayContent) && typeof details.displayContent.text === "string") {
		output = details.displayContent.text;
	} else {
		output = stripOutputNotice(raw, details?.meta as OutputMeta | undefined);
	}
	const lines = sanitizeDisplayLines(output);
	let size = 0;
	let indent = Number.POSITIVE_INFINITY;
	for (const row of lines) {
		const line = plainText(row);
		if (!isToolOutputRow(line)) continue;
		lines[size++] = line;
		indent = Math.min(indent, line.length - line.trimStart().length);
	}
	lines.length = size;
	if (indent > 0) {
		for (let i = 0; i < size; i++) lines[i] = lines[i]!.slice(indent);
	}
	return lines.join("\n").trimEnd();
}
