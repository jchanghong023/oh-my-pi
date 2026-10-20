import * as fs from "node:fs";
import * as path from "node:path";

interface InventoryRequest {
	roots: string[];
	output: string;
}

interface DirectoryInventory {
	files: string[];
	directories: Record<string, string[]>;
	boundaries: string[];
	links: string[];
}

// Names and entry kinds only: repository_ctx watches the real directories and
// absent candidates; stock Bazel source inputs own file contents and digests.
function inventory(root: string): DirectoryInventory {
	const result: DirectoryInventory = {
		files: [],
		directories: Object.create(null) as Record<string, string[]>,
		boundaries: [],
		links: [],
	};
	let pending = [""];
	for (let depth = 0; depth < 128 && pending.length; depth++) {
		const following: string[] = [];
		for (const relative of pending) {
			const entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true });
			// Repository watches must observe this same membership snapshot,
			// rather than accepting a BUILD added between discovery and watch.
			result.directories[relative] = entries.map(entry => entry.name).sort();
			for (const entry of entries) {
				const name = relative ? `${relative}/${entry.name}` : entry.name;
				let directory = entry.isDirectory();
				if (entry.isSymbolicLink()) {
					result.links.push(name);
					try {
						directory = fs.statSync(path.join(root, name)).isDirectory();
					} catch (error) {
						if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
						throw error;
					}
				}
				if (directory) {
					if (entry.name !== ".git") following.push(name);
				} else {
					result.files.push(name);
					if (entry.name === "BUILD" || entry.name === "BUILD.bazel") result.boundaries.push(relative);
				}
			}
		}
		pending = following;
	}
	// Follow directory links just like repository_ctx, but never silently omit
	// an over-deep tree or a link cycle from the declared source closure.
	if (pending.length) throw new Error(`Rust input tree exceeds 128 directories: ${root}`);
	result.files.sort();
	result.boundaries.sort();
	result.links.sort();
	return result;
}

try {
	const request = JSON.parse(fs.readFileSync(process.argv[2]!, "utf8")) as InventoryRequest;
	fs.writeFileSync(request.output, JSON.stringify(request.roots.map(inventory)));
} catch (error) {
	console.error(error);
	process.exitCode = 1;
}
