import * as path from "node:path";

const sourceLoader = path.resolve(import.meta.dir, "../src/openwiki/vendor-loader.ts");
const embeddedLoader = path.resolve(import.meta.dir, "openwiki-embedded-loader.js");

/** Embed the fork in OMP's own CLI builds while SDK consumers load the installed bundle. */
export function createOpenWikiVendorLoaderPlugin(): Bun.BunPlugin {
	return {
		name: "omp-openwiki-embedded-loader",
		setup(build) {
			build.onResolve({ filter: /(?:^|[/\\])vendor-loader(?:\.ts)?$/ }, args => {
				const specifier = args.path.endsWith(".ts") ? args.path : `${args.path}.ts`;
				if (path.resolve(path.dirname(args.importer), specifier) === sourceLoader) return { path: embeddedLoader };
			});
		},
	};
}
