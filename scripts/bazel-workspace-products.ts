import * as fs from "node:fs/promises";
import * as path from "node:path";

export type WorkspaceProduct = "browser-relay" | "collab-web" | "stats" | "robomp-web" | "coding-agent";
const assets = "packages/coding-agent/src/tools/browser/relay/extension-assets";
const toolViews = "packages/coding-agent/src/export/html/tool-views.generated.js";
const statsPlaceholder = "packages/stats/src/embedded-client.generated.txt";
const metadataName = "__omp_workspace_products.json";

function executable(): string {
	const cross = process.env.CROSS_TARGET;
	const windows = cross ? /^(?:win32|windows)-/.test(cross) : process.platform === "win32";
	return `packages/coding-agent/dist/omp${cross ? `-${cross}` : ""}${windows ? ".exe" : ""}`;
}

function ownership(product: WorkspaceProduct): { trees: string[]; files: string[] } {
	switch (product) {
		case "browser-relay":
			return { trees: ["packages/browser-relay/dist", assets], files: [] };
		case "collab-web":
			return { trees: ["packages/collab-web/dist"], files: [] };
		case "stats":
			return { trees: ["packages/stats/dist/client"], files: [] };
		case "robomp-web":
			return { trees: ["python/robomp/web/dist", "python/robomp/src/static"], files: [] };
		case "coding-agent":
			return { trees: [], files: [executable(), toolViews, statsPlaceholder] };
	}
}

function owned(product: WorkspaceProduct, filename: string): boolean {
	const { trees, files } = ownership(product);
	return (
		filename.split("/").every(part => part !== ".." && part !== "." && part !== "") &&
		!filename.includes("\\") &&
		!filename.includes(":") &&
		(files.includes(filename) || trees.some(tree => filename.startsWith(`${tree}/`)))
	);
}

async function collect(root: string, relative: string): Promise<string[]> {
	const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const filename = `${relative}/${entry.name}`;
		if (entry.isDirectory()) files.push(...(await collect(root, filename)));
		else if (entry.isFile()) files.push(filename);
		else throw new Error(`Workspace product is not a regular file: ${filename}`);
	}
	return files.sort();
}

// Match the embedded stats archive convention: normalized TAR mtimes and checksums.
function normalizeTarMetadata(bytes: Uint8Array): void {
	for (let offset = 0; offset + 512 <= bytes.length;) {
		const header = bytes.subarray(offset, offset + 512);
		if (header.every(byte => byte === 0)) return;
		const size = Number.parseInt(
			Buffer.from(header.subarray(124, 136)).toString("ascii").replace(/\0.*$/, "").trim() || "0",
			8,
		);
		header.fill(0x30, 136, 147);
		header[147] = 0;
		header.fill(0x20, 148, 156);
		let checksum = 0;
		for (const byte of header) checksum += byte;
		header.set(Buffer.from(checksum.toString(8).padStart(6, "0")), 148);
		header[154] = 0;
		header[155] = 0x20;
		offset += 512 * (1 + Math.ceil(size / 512));
		if (offset > bytes.length) throw new Error("Workspace TAR entry extends beyond archive");
	}
}

/** One real archive per producer, including empty files and executable permissions. */
export async function archiveWorkspaceProducts(
	root: string,
	product: WorkspaceProduct,
	destination: string,
): Promise<void> {
	const { trees, files } = ownership(product);
	const filenames = [...files];
	for (const tree of trees) {
		const children = await collect(root, tree);
		if (!children.length) throw new Error(`Workspace product tree is empty: ${tree}`);
		filenames.push(...children);
	}
	const entries: Record<string, Uint8Array> = {};
	const modes: Record<string, number> = {};
	for (const filename of filenames.sort()) {
		if (!owned(product, filename)) throw new Error(`Invalid workspace product path: ${filename}`);
		entries[filename] = await Bun.file(path.join(root, filename)).bytes();
		modes[filename] = (await fs.stat(path.join(root, filename))).mode & 0o777;
	}
	if (product === "coding-agent") {
		if (!entries[executable()]?.length) throw new Error("Coding-agent executable is empty");
		if (entries[statsPlaceholder]?.length !== 0) throw new Error("Stats embedded placeholder was not reset");
	}
	entries[metadataName] = new TextEncoder().encode(JSON.stringify({ version: 1, product, modes }));
	const bytes = await new Bun.Archive(entries).bytes();
	normalizeTarMetadata(bytes);
	await fs.mkdir(path.dirname(destination), { recursive: true });
	await Bun.write(destination, bytes);
}

/** Restore from the actual BEP output on both freshly executed actions and cache hits. */
export async function restoreWorkspaceProducts(
	root: string,
	product: WorkspaceProduct,
	archive: string,
): Promise<void> {
	const entries = await new Bun.Archive(await Bun.file(archive).bytes()).files();
	const metadata = entries.get(metadataName);
	if (!metadata) throw new Error("Workspace archive has no product manifest");
	const manifest = JSON.parse(await metadata.text()) as {
		version: number;
		product: string;
		modes: Record<string, number>;
	};
	if (
		manifest.version !== 1 ||
		manifest.product !== product ||
		!manifest.modes ||
		typeof manifest.modes !== "object"
	) {
		throw new Error("Workspace archive product manifest does not match producer");
	}
	const filenames = Object.keys(manifest.modes);
	for (const filename of entries.keys()) {
		if (filename !== metadataName && (!owned(product, filename) || !filenames.includes(filename))) {
			throw new Error(`Workspace archive contains unowned path: ${filename}`);
		}
	}
	for (const filename of filenames) {
		const mode = manifest.modes[filename];
		if (
			!owned(product, filename) ||
			!entries.has(filename) ||
			!Number.isInteger(mode) ||
			mode! < 0 ||
			mode! > 0o777
		) {
			throw new Error(`Workspace archive has invalid entry: ${filename}`);
		}
	}
	const { trees, files } = ownership(product);
	for (const filename of files)
		if (!entries.has(filename)) throw new Error(`Workspace archive is missing ${filename}`);
	for (const tree of trees) {
		if (!filenames.some(filename => filename.startsWith(`${tree}/`)))
			throw new Error(`Workspace archive is missing ${tree}`);
	}
	if (
		product === "coding-agent" &&
		(entries.get(statsPlaceholder)!.size !== 0 || entries.get(executable())!.size === 0)
	) {
		throw new Error("Workspace archive contains invalid coding-agent products");
	}
	for (const tree of trees) {
		const directory = path.join(root, tree);
		if (tree === "python/robomp/src/static") {
			await fs.mkdir(directory, { recursive: true });
			for (const name of await fs.readdir(directory)) {
				if (name !== ".gitkeep") await fs.rm(path.join(directory, name), { recursive: true, force: true });
			}
		} else await fs.rm(directory, { recursive: true, force: true });
	}
	for (const filename of filenames) {
		const destination = path.join(root, filename);
		// Preserve an existing checkout anchor; recover the archived one after deletion.
		if (filename === "python/robomp/src/static/.gitkeep" && (await Bun.file(destination).exists())) continue;
		await fs.mkdir(path.dirname(destination), { recursive: true });
		await Bun.write(destination, entries.get(filename)!);
		if (process.platform !== "win32") {
			await fs.chmod(
				destination,
				product === "coding-agent" && filename === executable()
					? manifest.modes[filename]! | 0o111
					: manifest.modes[filename]!,
			);
		}
	}
}
