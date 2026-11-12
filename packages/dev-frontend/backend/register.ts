import { plugin } from "bun";
import * as fs from "node:fs";
import * as path from "node:path";

// Package aliases are resolved by --tsconfig-override before the static graph is
// linked. Keep only resource loading here; #src uses each package's own imports.
await plugin({
	name: "dev-backend-text-resources",
	setup(build) {
		build.onResolve({ filter: /(?:\.md|\?raw)$/ }, args => ({
			path: path.resolve(path.dirname(args.importer), args.path.replace(/\?raw$/, "")),
			namespace: "dev-backend-text",
		}));
		build.onLoad({ filter: /.*/, namespace: "dev-backend-text" }, args => ({
			exports: { default: fs.readFileSync(args.path, "utf8") },
			loader: "object",
		}));
	},
});
