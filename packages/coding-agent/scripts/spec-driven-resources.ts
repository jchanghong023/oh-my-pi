import * as path from "node:path";
import type { BunPlugin } from "bun";
import { collectSpecDrivenResources } from "../src/spec-driven/resource-inventory";

const vendor = path.resolve(import.meta.dir, "../src/spec-driven/vendor");
const resources = path.join(vendor, "resources");

/**
 * Pack the current vendored tree without downloading or installing anything.
 * The tree, including `openspec/node_modules`, is checked-in source: this
 * packer never installs or regenerates dependencies.
 */
export async function buildSpecDrivenArchive(): Promise<Uint8Array> {
	const { manifest, entries } = await collectSpecDrivenResources(resources);
	entries["manifest.json"] = Buffer.from(JSON.stringify(manifest));
	const sorted: Record<string, Uint8Array> = {};
	for (const name of Object.keys(entries).sort()) sorted[name] = entries[name]!;
	const tar = await new Bun.Archive(sorted).bytes();
	// Normalize archive metadata so an unchanged tree has an unchanged cache key.
	for (let offset = 0; offset + 512 <= tar.length;) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every(byte => byte === 0)) break;
		const size = Number.parseInt(Buffer.from(header.subarray(124, 136)).toString("ascii").replace(/\0.*$/, "").trim() || "0", 8);
		for (const [start, width] of [[108, 8], [116, 8], [136, 12]] as const) {
			header.fill(0x30, start, start + width - 1);
			header[start + width - 2] = 0x30;
			header[start + width - 1] = 0;
		}
		header.fill(0x20, 148, 156);
		let checksum = 0;
		for (const byte of header) checksum += byte;
		header.set(Buffer.from(checksum.toString(8).padStart(6, "0")), 148);
		header[154] = 0;
		header[155] = 0x20;
		offset += 512 * (1 + Math.ceil(size / 512));
	}
	return Bun.gzipSync(tar, { level: 9 });
}

/** Bun's file loader emits a real asset for npm bundles and embeds it in executables. */
export function createSpecDrivenArchivePlugin(archive: Uint8Array): BunPlugin {
	return {
		name: "omp-spec-driven-archive",
		target: "bun",
		setup(build) {
			build.onResolve({ filter: /^\.\/resource-archive$/ }, ({ importer }) => {
				if (!importer.replaceAll("\\", "/").endsWith("/spec-driven/resources.ts")) return undefined;
				return { path: "spec-driven-resources.tar.gz", namespace: "omp-spec-driven-archive" };
			});
			build.onLoad({ filter: /.*/, namespace: "omp-spec-driven-archive" }, () => ({
				contents: archive,
				loader: "file",
			}));
		},
	};
}
