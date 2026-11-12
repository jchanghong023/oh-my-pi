import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import type { BunPlugin } from "bun";

/** Capture the current plugin tree, including binary files, without generated sidecars. */
export async function buildDeveloperTestAgentResources(): Promise<Buffer> {
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
	return gzipSync(JSON.stringify(entries));
}

/** Embed gzip bytes once, with the existing cache digest computed at build time. */
export function createDeveloperTestAgentArchivePlugin(archive: Buffer): BunPlugin {
	const digest = createHash("sha256").update(archive.toString("base64")).digest("hex");
	const namespace = "omp-aireqeloper-test-agent-archive";
	return {
		name: namespace,
		target: "bun",
		setup(build) {
			build.onResolve({ filter: /^\.\/developer-test-agent-archive$/ }, ({ importer }) => {
				if (!importer.replaceAll("\\", "/").endsWith("/plugins/developer-test-agent-resources.ts")) {
					return undefined;
				}
				return { path: "metadata", namespace };
			});
			build.onLoad({ filter: /^metadata$/, namespace }, () => ({
				contents: `import archivePath from "omp-aireqeloper-test-agent-archive";
export default { path: archivePath, digest: ${JSON.stringify(digest)} };`,
				loader: "js",
			}));
			build.onResolve({ filter: /^omp-aireqeloper-test-agent-archive$/ }, () => ({
				path: "developer-test-agent-resources.json.gz",
				namespace,
			}));
			build.onLoad({ filter: /\.gz$/, namespace }, () => ({
				contents: archive,
				loader: "file",
			}));
		},
	};
}
