import * as fs from "node:fs/promises";
import * as path from "node:path";
import { gzipSync } from "node:zlib";

/** Capture the current plugin tree, including binary files, without generated sidecars. */
export async function buildDeveloperTestAgentResources(): Promise<string> {
	const root = path.resolve(import.meta.dir, "../src/extensibility/plugins/bundled/developer-test-agent");
	const entries: Array<[string, { data: string; mode: number } | null]> = [];
	async function collect(prefix: string): Promise<void> {
		const children = await fs.readdir(path.join(root, prefix), { withFileTypes: true });
		children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		for (const child of children) {
			const name = prefix ? `${prefix}/${child.name}` : child.name;
			const file = path.join(root, ...name.split("/"));
			if (child.isDirectory()) {
				entries.push([name, null]);
				await collect(name);
			} else if (child.isFile()) {
				entries.push([
					name,
					{ data: (await fs.readFile(file)).toString("base64"), mode: (await fs.stat(file)).mode & 0o777 },
				]);
			} else {
				throw new Error(`Unsupported developer-test-agent resource: ${name}`);
			}
		}
	}
	await collect("");
	return gzipSync(JSON.stringify(entries)).toString("base64");
}
