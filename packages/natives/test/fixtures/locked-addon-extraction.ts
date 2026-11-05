import * as path from "node:path";
import { createRequire } from "node:module";
import type { RunTrace } from "../../native";
import { extractEmbeddedAddons } from "../../native/loader-state.js";

const [target, zstdPath, size] = process.argv.slice(2);
const bindings: { RunTrace: typeof RunTrace } = createRequire(import.meta.url)(target!);
const trace = new bindings.RunTrace("echo still-running");
const written = extractEmbeddedAddons({
	files: [{ variant: "default", filename: path.basename(target!), size: Number(size), zstdPath: zstdPath! }],
	targetDir: path.dirname(target!),
});
const snapshot: { script: string } = JSON.parse(trace.snapshot());
process.stdout.write(JSON.stringify({ written, script: snapshot.script }));
