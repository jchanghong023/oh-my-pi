import { isRecord, parseStreamingJson } from "@oh-my-pi/pi-utils";
import { type EditMode, getEditInputPaths } from "./edit";
import { unwrapHashlineHeaderPath } from "./hashline-format";
import { internalUrlSchemeSpec, internalUrlSchemeSpecs, splitUrlScheme } from "./url-scheme-host";
import { isXdHelpContent, parseXdUrl } from "./xd-url";

type FileTarget = "file" | "other" | "unknown";
const WRAPPED_EDIT_TOOLS = ["write", "edit", "apply_patch"];
const NO_FILE_TARGETS: readonly string[] = [];

/** Classify the destination, never the result of attempting the operation. */
function classifyFilePath(path: unknown, complete: boolean): FileTarget {
	if (typeof path !== "string" || !path.trim()) return complete ? "other" : "unknown";
	const target = unwrapHashlineHeaderPath(path);
	const url = splitUrlScheme(target);
	if (!url) {
		if (!complete) {
			// A streamed prefix such as `agent:` is not yet a filesystem path.
			const prefix = target.toLowerCase();
			if ("file://".startsWith(prefix) || "xd://".startsWith(prefix)) return "unknown";
			for (const scheme of internalUrlSchemeSpecs().keys()) {
				if (`${scheme}://`.startsWith(prefix)) return "unknown";
			}
		}
		return "file";
	}
	if (url.scheme === "file") return "file";
	const write = internalUrlSchemeSpec(url.scheme)?.write;
	return write?.via === "file" || write?.fileOperation === true ? "file" : "other";
}

function* editPaths(args: Record<string, unknown>, editMode?: EditMode): Iterable<unknown> {
	yield args.path;
	yield args.file_path;
	yield args.rename;
	yield args.move;
	if (Array.isArray(args.edits)) {
		for (const entry of args.edits) {
			if (!isRecord(entry)) continue;
			yield entry.path;
			yield entry.rename;
			yield entry.move;
		}
	}
	const input = args.input ?? args._input;
	if (typeof input === "string") yield* getEditInputPaths(input, editMode);
}

/** Transcript policy for an edit/write, including raw tool-device transports. */
export function compactFileTarget(toolName: string, args: unknown, complete: boolean, editMode?: EditMode): FileTarget {
	if (toolName !== "write" && toolName !== "edit" && toolName !== "apply_patch") return "other";
	if (!isRecord(args)) return complete ? "other" : "unknown";
	if (toolName === "write") {
		const path = args.path ?? args.file_path;
		const device = typeof path === "string" ? parseXdUrl(unwrapHashlineHeaderPath(path)) : null;
		if (!device) return classifyFilePath(path, complete);
		if (typeof args.content === "string" && isXdHelpContent(args.content)) return complete ? "other" : "unknown";
		if (!device.name) return complete ? "other" : "unknown";
		if (!WRAPPED_EDIT_TOOLS.includes(device.name)) {
			return !complete && WRAPPED_EDIT_TOOLS.some(name => name.startsWith(device.name!)) ? "unknown" : "other";
		}
		if (typeof args.content !== "string") return complete ? "other" : "unknown";
		if (!complete) {
			// A complete inner path or patch header can arrive before the rest of the payload.
			const inner = parseStreamingJson<Record<string, unknown>>(args.content);
			return compactFileTarget(device.name, inner, false, device.name === "apply_patch" ? "apply_patch" : undefined);
		}
		try {
			const inner: unknown = JSON.parse(args.content);
			return compactFileTarget(device.name, inner, true, device.name === "apply_patch" ? "apply_patch" : undefined);
		} catch {
			return complete ? "other" : "unknown";
		}
	}
	for (const path of editPaths(args, editMode)) {
		if (classifyFilePath(path, complete) === "file") return "file";
	}
	return complete ? "other" : "unknown";
}

/** Actual file-type request targets, in request order; unwrap tool transports before calling. */
export function toolFileTargets(toolName: string, args: Record<string, unknown>): readonly string[] {
	let candidates: Iterable<unknown>;
	switch (toolName) {
		case "read":
		case "write":
			candidates = [args.path ?? args.file_path];
			break;
		case "edit":
		case "apply_patch":
			candidates = editPaths(args, toolName === "apply_patch" ? "apply_patch" : undefined);
			break;
		case "ast_edit":
			candidates = Array.isArray(args.paths) ? args.paths : NO_FILE_TARGETS;
			break;
		default:
			return NO_FILE_TARGETS;
	}
	const paths: string[] = [];
	for (const path of candidates) {
		if (typeof path !== "string" || classifyFilePath(path, true) !== "file") continue;
		const target = unwrapHashlineHeaderPath(path);
		if (!paths.includes(target)) paths.push(target);
	}
	return paths;
}
