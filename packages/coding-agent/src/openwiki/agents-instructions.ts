import { lstatSync, renameSync } from "node:fs";
import { link, lstat, open, rm } from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import instructions from "./agents-instructions.md" with { type: "text" };

const START = /^<!-- OPENWIKI:START -->(?=\r?$)/gm;
const END = /^<!-- OPENWIKI:END -->(?=\r?$)/gm;

/** Maintain only the OpenWiki-managed section of the repository's AGENTS.md. */
export async function updateOpenWikiAgentInstructions(root: string): Promise<void> {
	const file = path.join(root, "AGENTS.md");
	const snapshot = await lstat(file, { bigint: true }).catch(error => {
		if (!isEnoent(error)) throw error;
		return undefined;
	});
	if (snapshot && !snapshot.isFile()) throw new Error("Cannot update AGENTS.md: expected a regular file.");
	const content = snapshot ? await Bun.file(file).text() : "";
	const [start, extraStart] = content.matchAll(START);
	const [end, extraEnd] = content.matchAll(END);
	const startIndex = start?.index;
	const endIndex = end?.index;
	let updated: string;
	if (startIndex === undefined && endIndex === undefined) {
		const separator =
			content.length === 0 ? "" : content.endsWith("\n\n") ? "" : content.endsWith("\n") ? "\n" : "\n\n";
		updated = content + separator + instructions;
	} else {
		if (startIndex === undefined || endIndex === undefined || !end || endIndex <= startIndex || extraStart || extraEnd) {
			throw new Error("Cannot update AGENTS.md: OpenWiki managed markers are malformed or duplicated.");
		}
		updated = content.slice(0, startIndex) + instructions.trimEnd() + content.slice(endIndex + end[0].length);
	}
	if (updated === content) return;
	const mode = snapshot ? Number(snapshot.mode & 0o777n) : 0o666 & ~process.umask();
	const temporary = `${file}.${crypto.randomUUID()}.tmp`;
	const handle = await open(temporary, "wx", mode);
	try {
		try {
			await handle.writeFile(updated, "utf8");
			await handle.chmod(mode);
			await handle.sync();
		} finally {
			await handle.close();
		}
		if (!snapshot) {
			await link(temporary, file);
			return;
		}
		// Check after staging, immediately before publishing. Do not replace
		// a user save (including an atomic save that changed the inode).
		const latest = lstatSync(file, { bigint: true, throwIfNoEntry: false });
		if (
			!latest?.isFile() ||
			latest.dev !== snapshot.dev ||
			latest.ino !== snapshot.ino ||
			latest.size !== snapshot.size ||
			latest.mtimeNs !== snapshot.mtimeNs ||
			latest.ctimeNs !== snapshot.ctimeNs
		) {
			throw new Error("Cannot update AGENTS.md: the file changed while preparing the OpenWiki instructions.");
		}
		renameSync(temporary, file);
	} finally {
		await rm(temporary, { force: true });
	}
}
