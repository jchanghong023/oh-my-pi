import { plainText } from "@oh-my-pi/pi-tui/native/spans";
import { sanitizeDisplayLines } from "@oh-my-pi/pi-tui/render/render-utils";
import { type BashToolDetails, shellToolCommands, stripBashNotices } from "@oh-my-pi/pi-tui/tools/bash";
import { resultText } from "@oh-my-pi/pi-tui/tools/native-view";
import { type OutputMeta, stripOutputNotice } from "@oh-my-pi/pi-tui/tools/output-meta";
import type { ToolRenderResult } from "@oh-my-pi/pi-tui/tools/renderer";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { LiveToolOutputSnapshot } from "./agent-session-handle";

/** A compact preview row must contain a Unicode letter or number, not just decoration. */
export function isToolOutputRow(row: string): boolean {
	return /[\p{L}\p{N}]/u.test(row);
}

/** A sole command carries the inner tool identity; compound shell calls remain Bash. */
export function toolOutputSource(toolName: string, result?: ToolRenderResult<unknown>, args?: unknown) {
	const details = isRecord(result?.details) ? result.details : undefined;
	const shellDetails = toolName === "bash" ? (details as BashToolDetails | undefined) : undefined;
	const fields = isRecord(args) ? args : undefined;
	const command = typeof fields?.command === "string" ? fields.command : undefined;
	if (shellDetails) {
		const { dispatches, sole } = shellToolCommands(shellDetails, command);
		const dispatch = sole ? dispatches[0] : undefined;
		if (dispatch) {
			return {
				name: dispatch.tool,
				details: isRecord(dispatch.inner) ? dispatch.inner : undefined,
				dispatch,
				shellDetails,
			};
		}
	}
	return { name: toolName, details, shellDetails };
}

/** Successful direct file operations may duplicate the compact file Diff. */
export function mayBeCoveredByFileDiff(call: LiveToolOutputSnapshot): boolean {
	const { toolName, result, args } = call;
	const { name, details, shellDetails } = toolOutputSource(toolName, result, args);
	if (name !== "write" && name !== "edit" && name !== "apply_patch") return false;
	return (
		!result?.isError &&
		(shellDetails ?? details)?.cancelled !== true &&
		(call.terminalAt === undefined || details !== undefined)
	);
}

/** Actual displayable compact Output, using the same output boundaries as the tool renderers. */
export function toolOutputText(toolName: string, result: ToolRenderResult<unknown>, args?: unknown): string {
	const { name, details, shellDetails } = toolOutputSource(toolName, result, args);
	if (name === "todo") return "";
	const raw = resultText(result);
	let output: string;
	if (name === "read" && isRecord(details?.displayContent) && typeof details.displayContent.text === "string") {
		output = details.displayContent.text;
	} else {
		// A retained running body can outlive its job. Keep excluding the startup receipt.
		const job = shellDetails?.async;
		const noticeDetails =
			job && job.state !== "running"
				? { ...shellDetails, async: { ...job, state: "running" as const } }
				: shellDetails;
		const text = toolName === "bash" ? stripBashNotices(raw, noticeDetails).text : raw;
		output = stripOutputNotice(text, details?.meta as OutputMeta | undefined);
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
