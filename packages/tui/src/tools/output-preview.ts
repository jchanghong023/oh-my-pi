import { isRecord } from "@oh-my-pi/pi-utils";
import { plainText } from "../native/spans";
import { sanitizeDisplayLines } from "../render/render-utils";
import { type BashToolDetails, stripBashNotices } from "./bash";
import { unwrapHashlineHeaderPath } from "./hashline-format";
import { resultText } from "./native-view";
import { type OutputMeta, stripOutputNotice } from "./output-meta";
import type { ToolRenderResult } from "./renderer";
import { parseXdUrl } from "./xd-url";

/** Only existing result text, using the same output boundaries as the tool renderers. */
export function toolOutputText(toolName: string, result: ToolRenderResult<unknown>, args?: unknown): string {
	let details = isRecord(result.details) ? result.details : undefined;
	const dispatch = isRecord(details?.xdev) ? details.xdev : undefined;
	if (toolName === "todo") return "";
	if (toolName === "write") {
		const fields = isRecord(args) ? args : undefined;
		const device = typeof fields?.path === "string" ? parseXdUrl(unwrapHashlineHeaderPath(fields.path)) : null;
		if ((device?.name ?? dispatch?.tool) === "todo") return "";
	}
	if (toolName === "write" && typeof dispatch?.tool === "string" && dispatch.mode !== "help") {
		toolName = dispatch.tool;
		details = isRecord(dispatch.inner) ? dispatch.inner : undefined;
	}
	const raw = resultText(result);
	let output: string;
	if (toolName === "bash") {
		output = stripBashNotices(raw, details as BashToolDetails | undefined).text;
	} else if (
		toolName === "read" &&
		isRecord(details?.displayContent) &&
		typeof details.displayContent.text === "string"
	) {
		output = details.displayContent.text;
	} else {
		output = stripOutputNotice(raw, details?.meta as OutputMeta | undefined);
	}
	return sanitizeDisplayLines(output)
		.map(line => plainText(line))
		.join("\n")
		.trimEnd();
}
