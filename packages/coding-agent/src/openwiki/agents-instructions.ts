import { lstat } from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { writeFileAtomically } from "../utils/atomic-file";
import instructions from "./agents-instructions.md" with { type: "text" };

const START = "<!-- OPENWIKI:START -->";
const END = "<!-- OPENWIKI:END -->";

/** Maintain only the OpenWiki-managed section of the repository's AGENTS.md. */
export async function updateOpenWikiAgentInstructions(root: string): Promise<void> {
	const file = path.join(root, "AGENTS.md");
	let mode = 0o666 & ~process.umask();
	let isLink = false;
	let content: string;
	try {
		const stat = await lstat(file);
		isLink = stat.isSymbolicLink();
		mode = stat.mode & 0o777;
		content = await Bun.file(file).text();
	} catch (error) {
		if (!isEnoent(error)) throw error;
		content = "";
	}
	const start = content.indexOf(START);
	const end = content.indexOf(END);
	let updated: string;
	if (start === -1 && end === -1) {
		const separator =
			content.length === 0 ? "" : content.endsWith("\n\n") ? "" : content.endsWith("\n") ? "\n" : "\n\n";
		updated = content + separator + instructions;
	} else {
		if (start === -1 || end <= start || start !== content.lastIndexOf(START) || end !== content.lastIndexOf(END)) {
			throw new Error("Cannot update AGENTS.md: OpenWiki managed markers are malformed or duplicated.");
		}
		updated = content.slice(0, start) + instructions.trimEnd() + content.slice(end + END.length);
	}
	if (updated === content) return;
	if (isLink) throw new Error("Cannot update AGENTS.md: symbolic links are not supported.");
	await writeFileAtomically(file, updated, mode);
}
