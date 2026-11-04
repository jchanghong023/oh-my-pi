import assert from "node:assert/strict";
import * as path from "node:path";
import type archiveMetadata from "../../src/extensibility/plugins/developer-test-agent-archive";

const [, directory] = process.argv.slice(2);
assert.ok(directory, "temporary directory is required for the archive metadata preload");
const loaderDirectory = path.resolve(import.meta.dir, "../../src/extensibility/plugins");
const metadataPath = path.join(loaderDirectory, "developer-test-agent-archive.ts");

export const metadata: NonNullable<typeof archiveMetadata> = {
	path: path.relative(loaderDirectory, path.join(directory, "resources.json.gz")),
	digest: "missing-archive",
};

// --preload installs the hook before the fixture's static imports are evaluated.
// Only metadata is injected; extraction and all resource consumers remain real.
Bun.plugin({
	name: "developer-test-agent-materialization-metadata",
	setup(build) {
		build.onLoad({ filter: /developer-test-agent-archive\.ts$/ }, args => {
			if (path.resolve(args.path) !== metadataPath) return;
			return { loader: "object", exports: { default: metadata } };
		});
	},
});
