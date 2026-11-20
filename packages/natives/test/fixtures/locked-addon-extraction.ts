import * as path from "node:path";
import type { RunTrace } from "../../native";
import { extractEmbeddedAddons, openNativeAddon } from "../../native/loader-state.js";

const [target, zstdPath, size] = process.argv.slice(2);
const bindings = openNativeAddon(target!) as { RunTrace: typeof RunTrace };
if (!zstdPath) {
	const trace = new bindings.RunTrace("echo replacement-loaded");
	process.stdout.write(trace.snapshot());
} else {
	const trace = new bindings.RunTrace("echo still-running");
	const written = extractEmbeddedAddons({
		files: [{ variant: "default", filename: path.basename(target!), size: Number(size), zstdPath }],
		targetDir: path.dirname(target!),
	});
	const replacement = Bun.spawn([process.execPath, import.meta.path, target!], { stdout: "pipe", stderr: "inherit" });
	const replacementOutput = await new Response(replacement.stdout).text();
	if ((await replacement.exited) !== 0) throw new Error("Could not load the replaced addon from a fresh process");
	const snapshot: { script: string } = JSON.parse(trace.snapshot());
	const replacementSnapshot: { script: string } = JSON.parse(replacementOutput);
	process.stdout.write(
		JSON.stringify({ written, script: snapshot.script, replacementScript: replacementSnapshot.script }),
	);
}
