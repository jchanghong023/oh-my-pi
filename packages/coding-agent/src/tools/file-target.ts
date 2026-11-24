import { isRecord } from "@oh-my-pi/pi-utils";
import { InternalUrlRouter } from "../internal-urls/router";
import { splitUrlScheme } from "../internal-urls/url-scheme";
import { type EditMode, getEditInputPaths } from "./details/edit";
import { unwrapHashlineHeaderPath } from "./hashline-format";

const NO_FILE_TARGETS: readonly string[] = [];

function isFilePath(path: string): boolean {
	const url = splitUrlScheme(path);
	if (!url || url.scheme === "file") return true;
	const write = InternalUrlRouter.instance().spec(url.scheme)?.write;
	return write?.via === "file" || write?.fileOperation === true;
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
		if (typeof path !== "string" || !path.trim()) continue;
		const target = unwrapHashlineHeaderPath(path);
		if (isFilePath(target) && !paths.includes(target)) paths.push(target);
	}
	return paths;
}
